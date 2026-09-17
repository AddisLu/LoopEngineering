import path from 'node:path';
import type Database from 'better-sqlite3';
import { chatLocal } from '../local/chat.js';
import { listSources } from '../knowledge/ingest/sources.js';
import type { ChatMessage } from './store.js';

/**
 * What should 轉成任務 make out of an answer? Before this existed the button dumped the whole
 * answer into a draft task with no repo, no plan and no verification — a note nobody could act
 * on. Now the local model (or a keyword fallback) proposes one of four intents and the page asks
 * the operator to confirm; each intent has its own exit (PRD wizard draft, spike repo, todo).
 */

export type TaskIntent = 'fix' | 'feature' | 'perf' | 'spike' | 'todo';
export type PrdKind = 'algo' | 'bugfix' | 'feature' | 'perf';

export interface IntentSuggestion {
  intent: TaskIntent;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
  title: string;
  fix?: { kind: PrdKind; symptom: string; expected: string; module: string | null };
  spike?: { name: string; goal: string; urls: string[] };
  /** uri of a registered git source whose name appears in the text (or the only one there is) */
  repo_hint: string | null;
  sources: Array<{ title: string; url: string }>;
  /** false = the model was not available; everything above is heuristics */
  model_ready: boolean;
}

export interface IntentDeps {
  localChat?: typeof chatLocal;
  sources?: (db: Database.Database) => Array<{ kind: string; uri: string; enabled: number }>;
}

export const INTENT_SYSTEM = [
  '你是 CF-AOI 維運團隊的任務分類器。使用者在對話裡問了問題、模型回答了；現在使用者按下「轉成任務」，你要判斷這段對話該變成哪一種工作，並準備好預填內容。',
  '五種 intent：',
  '- fix：機台／檢測結果不對、誤判、漏檢、掉幀、crash、參數要調——要改現有軟體。kind 用 algo（影像處理／判定規則）或 bugfix（程式錯誤）。',
  '- feature：現有軟體要多一個功能或畫面。',
  '- perf：要更快、更省資源，結果不能變。',
  '- spike：對話介紹了某個 GitHub 專案、套件、論文或新方法，使用者想知道能不能用——要另開一個實驗 repo 裝起來驗證。',
  '- todo：新聞彙整、報告、對比表、純資訊——只需要留一張待辦。',
  '只輸出一個 JSON 物件，不要其他文字：',
  '{"intent":"fix|feature|perf|spike|todo","confidence":"high|medium|low","reason":"一句話（繁體中文，≤40 字）","title":"任務標題（≤40 字）",',
  ' "fix":{"kind":"algo|bugfix|feature|perf","symptom":"現況／症狀一句話","expected":"期望行為一句話","module":"ip|control|grab|tools|scripts|null"},',
  ' "spike":{"name":"英文短名（小寫、連字號）","goal":"要驗證什麼、怎樣算成功（一兩句）","urls":["來源網址"]}}',
  'fix 只在 intent 為 fix/feature/perf 時填；spike 只在 intent 為 spike 時填。症狀與期望要具體、可以直接寫進需求文件；找不到就用對話裡的原句。',
].join('\n');

const clamp = (v: unknown, max: number): string => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const INTENTS: TaskIntent[] = ['fix', 'feature', 'perf', 'spike', 'todo'];
const KINDS: PrdKind[] = ['algo', 'bugfix', 'feature', 'perf'];
const URL_RE = /https?:\/\/[^\s<>()\]"'）」]+/g;

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/[一-鿿]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (s || 'spike').slice(0, 40).replace(/-$/, '');
}

/** Tool-call sources plus any URL in the text, first-seen order, ≤ max. */
export function collectSources(msg: Pick<ChatMessage, 'content' | 'tools'>, max = 10): Array<{ title: string; url: string }> {
  const out: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  const add = (title: string, url: string) => {
    const u = url.replace(/[.,;:!?]+$/, '');
    if (!/^https?:\/\//.test(u) || seen.has(u) || out.length >= max) return;
    seen.add(u);
    out.push({ title: title || u, url: u });
  };
  for (const r of (msg.tools ?? []) as Array<{ calls?: Array<{ sources?: Array<{ title?: string; url?: string }> }> }>) {
    for (const c of r.calls ?? []) for (const s of c.sources ?? []) if (s.url) add(String(s.title ?? ''), String(s.url));
  }
  for (const m of msg.content.match(URL_RE) ?? []) add('', m);
  return out;
}

/** The registered git repo the conversation is about, if its folder name is mentioned. */
export function guessRepo(text: string, repos: string[]): string | null {
  if (repos.length === 1) return repos[0]!;
  const low = text.toLowerCase();
  const hit = repos.filter((r) => {
    const base = path.basename(r).toLowerCase();
    return base.length >= 3 && low.includes(base);
  });
  return hit[0] ?? null;
}

const FIX_WORDS = /誤判|漏檢|掉幀|判錯|判成|crash|當機|閃退|異常|錯誤|失敗|參數|門檻|threshold|bug|例外|exception|timeout|逾時|不穩|噪點|ROI|瑕疵|缺陷/i;
const PERF_WORDS = /效能|太慢|延遲|latency|throughput|加速|ms|fps|記憶體不足|OOM/i;
const FEATURE_WORDS = /新增|多一個|要能|支援|加一個|功能/;
const SPIKE_WORDS = /github\.com|pip install|npm i|npm install|開源|套件|library|framework|論文|paper|能不能用|評估|試用|導入|POC|PoC/i;

/** Keyword fallback when the model is unavailable or answers with something unparsable. */
export function heuristicIntent(question: string, answer: string): Pick<IntentSuggestion, 'intent' | 'reason' | 'fix' | 'spike'> {
  const q = question;
  const both = `${question}\n${answer}`;
  if (SPIKE_WORDS.test(q) || (/github\.com/i.test(both) && /能不能|可以用|評估|適不適合/.test(q))) {
    return { intent: 'spike', reason: '看起來是在評估一個外部專案或套件', spike: { name: slugify(question.slice(0, 40)), goal: question.slice(0, 200), urls: [] } };
  }
  if (FIX_WORDS.test(q)) {
    return { intent: 'fix', reason: '問題描述的是檢測或程式行為不對', fix: { kind: /crash|當機|閃退|例外|exception|timeout|逾時/i.test(q) ? 'bugfix' : 'algo', symptom: question.slice(0, 200), expected: '', module: null } };
  }
  if (PERF_WORDS.test(q)) return { intent: 'perf', reason: '問題在速度或資源', fix: { kind: 'perf', symptom: question.slice(0, 200), expected: '', module: null } };
  if (FEATURE_WORDS.test(q)) return { intent: 'feature', reason: '問題是要多一個功能', fix: { kind: 'feature', symptom: question.slice(0, 200), expected: '', module: null } };
  return { intent: 'todo', reason: '看起來是資訊彙整，留一張待辦即可' };
}

function parseModel(text: string): Partial<IntentSuggestion> | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const intent = INTENTS.includes(j.intent as TaskIntent) ? (j.intent as TaskIntent) : null;
  if (!intent) return null;
  const conf = ['high', 'medium', 'low'].includes(String(j.confidence)) ? (j.confidence as IntentSuggestion['confidence']) : 'medium';
  const out: Partial<IntentSuggestion> = { intent, confidence: conf, reason: clamp(j.reason, 80), title: clamp(j.title, 60) };
  const fx = j.fix as Record<string, unknown> | undefined;
  if ((intent === 'fix' || intent === 'feature' || intent === 'perf') && fx && typeof fx === 'object') {
    const kind = KINDS.includes(fx.kind as PrdKind) ? (fx.kind as PrdKind) : intent === 'fix' ? 'algo' : intent;
    const mod = clamp(fx.module, 20);
    out.fix = { kind, symptom: clamp(fx.symptom, 300), expected: clamp(fx.expected, 300), module: mod && mod !== 'null' ? mod : null };
  }
  const sp = j.spike as Record<string, unknown> | undefined;
  if (intent === 'spike' && sp && typeof sp === 'object') {
    const urls = Array.isArray(sp.urls) ? sp.urls.map((u) => clamp(u, 500)).filter((u) => /^https?:\/\//.test(u)).slice(0, 6) : [];
    out.spike = { name: slugify(clamp(sp.name, 60)), goal: clamp(sp.goal, 400), urls };
  }
  return out;
}

export async function suggestIntent(
  db: Database.Database,
  msg: Pick<ChatMessage, 'content' | 'tools'>,
  questions: string[],
  conversationTitle: string,
  deps: IntentDeps = {},
): Promise<IntentSuggestion> {
  const question = questions.slice(-2).join('\n').trim();
  const answer = msg.content.slice(0, 6000);
  const sources = collectSources(msg);
  const repos = (deps.sources ?? listSources)(db)
    .filter((s) => s.kind === 'git' && s.enabled)
    .map((s) => s.uri);
  const repo_hint = guessRepo(`${question}\n${answer}`, repos);
  const fallbackTitle = clamp(conversationTitle || question, 60) || '對話任務';

  const base = heuristicIntent(question, answer);
  const local = deps.localChat ?? chatLocal;
  const user = [
    `使用者的問題：\n${question || '（沒有）'}`,
    `模型的回答（節錄）：\n${answer}`,
    sources.length ? `回答引用的來源：\n${sources.map((s) => `- ${s.title} ${s.url}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const r = await local(db, { system: INTENT_SYSTEM, user, maxTokens: 700, thinking: false });
  if (!r.ok) {
    return { ...base, confidence: 'low', title: fallbackTitle, repo_hint, sources, model_ready: false };
  }
  const parsed = parseModel(r.content);
  if (!parsed || !parsed.intent) {
    return { ...base, confidence: 'low', reason: `${base.reason}（模型回覆無法解析）`, title: fallbackTitle, repo_hint, sources, model_ready: true };
  }
  const out: IntentSuggestion = {
    intent: parsed.intent,
    confidence: parsed.confidence ?? 'medium',
    reason: parsed.reason || base.reason,
    title: parsed.title || fallbackTitle,
    repo_hint,
    sources,
    model_ready: true,
  };
  if (parsed.intent === 'fix' || parsed.intent === 'feature' || parsed.intent === 'perf') {
    out.fix = parsed.fix ?? base.fix ?? { kind: parsed.intent === 'fix' ? 'algo' : parsed.intent, symptom: question.slice(0, 200), expected: '', module: null };
    if (!out.fix.symptom) out.fix.symptom = question.slice(0, 200);
  }
  if (parsed.intent === 'spike') {
    out.spike = parsed.spike ?? base.spike ?? { name: slugify(question.slice(0, 40)), goal: question.slice(0, 200), urls: [] };
    if (!out.spike.urls.length) out.spike.urls = sources.slice(0, 4).map((s) => s.url);
  }
  return out;
}
