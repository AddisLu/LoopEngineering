import type Database from 'better-sqlite3';
import { getBool, getNum, getSetting } from '../db/index.js';
import { BENCH_JUDGE_MODELS } from '../settings.js';
import { claudePromptExec, hasClaudeCli, type BenchJudgeExec } from '../benchmark/judge.js';
import { readUsage } from '../token/usage.js';
import { appendMessage, getMessage, messagesFor, type ChatMessage } from './store.js';

/**
 * 請雲端複核 — ask a cloud model to review one local answer.
 *
 * This is the only action on the chat page that leaves the machine and spends subscription
 * usage, so it is off by default and guarded exactly like the benchmark judge: the usage hard
 * limit first, then the CLI. The review lands as a normal message tagged `cloud:<alias>` with
 * `escalated_from` pointing at the answer it reviewed; the page keeps it out of later turns, so
 * escalating never silently upgrades the rest of the conversation.
 *
 * Never throws: every failure comes back as { ok: false, error } for the route to surface.
 */

export type EscalateResult = { ok: true; message: ChatMessage } | { ok: false; error: string; status?: number };

export interface EscalateOptions {
  messageId: string;
  userKey: string;
  model?: string;
  exec?: BenchJudgeExec;
}

const PREAMBLE = [
  '你是資深工程師，正在複核一個「本地小模型」對 CF-AOI 專案問題的回答。',
  '請用繁體中文，依序給出：',
  '1. 這個回答有沒有錯（指出具體哪一句、為什麼錯）；',
  '2. 漏掉什麼重要的點；',
  '3. 你的最終建議（可直接照做的具體步驟）。',
  '本地模型看得到專案知識庫、你看不到，所以不要質疑檔名或參數是否存在；只針對推理、做法與風險判斷。',
  '沒有把握的地方就說沒有把握，不要臆測專案細節。',
].join('\n');

const TRANSCRIPT_CAP = 60_000;
const SNIPPET_CAP = 800;

/** The reviewed answer, its question, and whatever the knowledge base contributed to it. */
export function buildEscalatePrompt(target: ChatMessage, context: ChatMessage[]): string {
  const turns = context
    .filter((m) => m.id !== target.id && !String(m.model_id ?? '').startsWith('cloud:'))
    .map((m) => `【${m.role === 'user' ? '使用者' : '本地模型'}】\n${m.content}`)
    .join('\n\n');
  const sources = (target.sources as { n?: number; source?: string; path?: string; snippet?: string }[])
    .slice(0, 8)
    .map((s) => `[${s.n ?? '?'}] ${s.source ?? ''}/${s.path ?? ''}\n${String(s.snippet ?? '').slice(0, SNIPPET_CAP)}`)
    .join('\n\n');
  return [
    PREAMBLE,
    '',
    '## 先前對話',
    '',
    turns.slice(-TRANSCRIPT_CAP) || '（無）',
    '',
    '## 要複核的回答',
    '',
    target.content,
    ...(sources ? ['', '## 本地模型引用的知識庫片段', '', sources] : []),
  ].join('\n');
}

export async function escalateMessage(db: Database.Database, opts: EscalateOptions): Promise<EscalateResult> {
  if (!getBool(db, 'chat_escalate_enabled', false)) {
    return { ok: false, error: '雲端複核未啟用（loop config set chat_escalate_enabled true）', status: 404 };
  }
  const model = (opts.model || getSetting(db, 'chat_escalate_model') || 'opus').trim();
  if (!BENCH_JUDGE_MODELS.has(model)) {
    return { ok: false, error: `model must be one of: ${[...BENCH_JUDGE_MODELS].join(', ')}`, status: 400 };
  }

  const found = getMessage(db, opts.messageId, opts.userKey);
  if (!found) return { ok: false, error: 'message not found', status: 404 };
  if (found.message.role !== 'assistant' || !found.message.content.trim()) {
    return { ok: false, error: '只能複核本地模型的回答', status: 400 };
  }
  if (String(found.message.model_id ?? '').startsWith('cloud:')) {
    return { ok: false, error: '這則已經是雲端複核的結果', status: 400 };
  }

  // same budget gate as the benchmark judge — the chat page must not be a way around it
  const hardLimit = getNum(db, 'hard_limit_pct', 95);
  const usage = readUsage().session.percent;
  if (usage >= hardLimit) {
    return { ok: false, error: `usage ${usage}% >= hard limit ${hardLimit}% — 雲端複核延後`, status: 409 };
  }
  if (!opts.exec && !hasClaudeCli()) return { ok: false, error: 'claude CLI not found on PATH', status: 503 };

  const turns = getNum(db, 'chat_context_turns', 12);
  const context = messagesFor(db, found.conversation.id).slice(-Math.max(2, turns * 2));
  const run = opts.exec ?? claudePromptExec(getNum(db, 'chat_escalate_timeout_ms', 120_000));

  let content: string;
  try {
    content = (await run(buildEscalatePrompt(found.message, context), model)).trim();
  } catch (err) {
    return { ok: false, error: `雲端複核失敗：${String(err).slice(-300)}`, status: 502 };
  }
  if (!content) return { ok: false, error: '雲端模型沒有回應內容', status: 502 };

  const message = appendMessage(db, found.conversation.id, opts.userKey, {
    role: 'assistant',
    content,
    model_id: `cloud:${model}`,
    escalated_from: found.message.id,
    finish_reason: 'stop',
  });
  return { ok: true, message };
}
