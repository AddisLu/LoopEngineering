import fs from 'node:fs';
import path from 'node:path';
import type { Task } from '../types.js';
import { parseSteps, parseVerifyMode } from '../types.js';
import { parseAcceptance, parseProtected } from './acceptance.js';

/** Resolve the plan content to inline into LOOP_TASK.md (best effort). */
function planContent(task: Task): string {
  const ref = task.plan_ref?.trim();
  if (!ref) return '(no plan attached)';
  if (/^https?:\/\//i.test(ref)) return `See plan at: ${ref}`;
  try {
    return fs.readFileSync(ref, 'utf8');
  } catch {
    return `(could not read plan file: ${ref})`;
  }
}

/**
 * Compact `## 執行紀律` block distilled from test-driven-development/systematic-debugging/
 * verification-before-completion (prompt-only — no plugin, no subagents, no clarifying
 * questions: those parts of Superpowers are net-negative for Loop's headless runs). Kept
 * short (<~600 chars) since it's added to every dispatch when the setting is on.
 */
const DISCIPLINE_BLOCK = `
## 執行紀律
- TDD：先寫會失敗的測試 → 最小實作到綠 → 重構；每步小 commit。
- 系統化除錯：復現 → 二分定位根因 → 修根因不修表象 → 加回歸測試。
- 完成前驗證：交付前自行跑完所有 verification steps 並修到全綠；列出你實際驗證了什麼。
- 這是無人值守執行，遇不確定一律自主決策後繼續，絕不停下反問。
`;

/** The sandbox hosts a run may pick, with their read-only data — only when there is a choice or data. */
function execHostsBlock(hosts?: Array<{ name: string; description: string; data: Array<{ source: string; target: string }>; default: boolean }>): string {
  if (!hosts || !hosts.length || (hosts.length === 1 && !hosts[0]!.data.length)) return '';
  const rows = hosts.map((h) => {
    const data = h.data.length ? `；唯讀資料：${h.data.map((d) => `\`${d.target}\``).join('、')}` : '';
    return `  - \`${h.name}\`${h.default ? '（預設）' : ''}：${h.description}${data}`;
  });
  return `- 可用的沙盒主機（run 的 \`host\` 參數；不帶就是預設）：\n${rows.join('\n')}\n` +
    `- 在遠端主機跑時，worktree 會先同步過去（.gitignore 的檔案不同步也不刪，增量編譯保留）；遠端產生的檔案不會同步回來，要看就在指令裡 \`cat\`。資料目錄是唯讀的，不要嘗試寫入或複製整個圖庫。\n`;
}

/**
 * Write LOOP_TASK.md into the worktree. The dispatch prompt only tells the agent to
 * read this file, so all task context lives here (goal, plan, verification, rules).
 * `extras.knowledge` (when non-null) is inserted as a `## Knowledge / Environment`
 * section between Goal and Plan; omitted entirely when null/absent, so an empty
 * knowledge base produces byte-identical output to before this option existed.
 * `extras.rag` (when non-null) is inserted as its own `## 相關語料 (RAG)` section right
 * after Knowledge — kept separate because it's uncurated corpus material (see
 * knowledge/context.ts's ragTaskContext), not the small human-approved knowledge graph;
 * omitted entirely when null/absent (the `rag_inject_task_context` setting's default), so
 * default-off output is byte-identical to before this option existed.
 * `extras.discipline` (when true) appends the `## 執行紀律` block after Rules; omitted
 * entirely when false/absent (the `prompt_discipline` setting's default), so default-off
 * output is byte-identical to before this option existed.
 */
export function writeTaskFile(
  cwd: string,
  task: Task,
  extras?: {
    knowledge?: string | null;
    rag?: string | null;
    discipline?: boolean;
    mcpServers?: string[];
    /** GPU 執行沙盒 details when the run has the loop-exec server (null/absent = no section) */
    exec?: {
      image: string;
      timeoutSec: number;
      maxTimeoutSec: number;
      /** where `run` can go (src/exec/hosts.ts describeExecHosts); absent/local-only = no list */
      hosts?: Array<{ name: string; description: string; data: Array<{ source: string; target: string }>; default: boolean }>;
    } | null;
    /** 問題單 flow — each null/absent = no section, so every other task's LOOP_TASK.md is unchanged */
    attachments?: Array<{ path: string; text: string }> | null;
    repoMap?: string | null;
    similarFixes?: string | null;
    reproBefore?: string | null;
    /** human lines for the repo's checks (src/checks/render.ts describeChecks) */
    checks?: string[] | null;
    /** 機台與環境: where the agent works and each box the checks run on, with its 規格 (src/intake/context.ts machineLinesFor) */
    machines?: string[] | null;
    /** 這個 repo 的規範與經驗: pitfalls, style, playbooks, params, requirements (src/repo/profileContext.ts) */
    repoKnowledge?: string | null;
  },
): string {
  const steps = parseSteps(task);
  const modes = parseVerifyMode(task);
  const file = path.join(cwd, 'LOOP_TASK.md');
  const knowledgeBlock = extras?.knowledge
    ? `\n## Knowledge / Environment\n（以下為使用者的長期環境／偏好／限制知識，執行本任務時必須遵守；若與 Plan 衝突，以 Plan 為準）\n${extras.knowledge}\n`
    : '';
  const ragBlock = extras?.rag
    ? `\n## 相關語料 (RAG)\n（以下為本地語料庫混合檢索到的相關片段，僅供參考排序，不代表已核可的知識，若與 Plan/Knowledge 衝突以其他為準）\n${extras.rag}\n`
    : '';
  const acceptanceBlock = task.verify_rubric?.trim()
    ? `\n## 驗收標準 (Acceptance)\n${task.verify_rubric.trim()}\n`
    : '';
  // 驗收指標 / 保護路徑: the engine checks these itself — the agent has to know the target and the
  // one line to print, and that the yardstick is off limits
  let metricSpecs: ReturnType<typeof parseAcceptance> = [];
  try {
    metricSpecs = parseAcceptance(task.acceptance_metrics);
  } catch {
    metricSpecs = [];
  }
  const metricsBlock = metricSpecs.length
    ? `\n## 驗收指標（引擎自動檢查，門檻不在 repo 裡）\n` +
      metricSpecs.map((m) => `- \`${m.name} ${m.op} ${m.target}\``).join('\n') +
      (extras?.checks?.length
        ? `\n這些指標由驗收檢查回報（圖資回歸由引擎比對答案產生），你不用自己印；未達標時引擎會把對照表交回給你繼續改。\n`
        : `\n驗證步驟（通常是圖庫評估）必須印出一行 \`LOOP_METRICS {"${metricSpecs[0]!.name}": 數值, …}\`（JSON，放在輸出最後）；引擎據此判定，未達標會把對照表交回給你繼續改。\n`)
    : '';
  const protectedList = parseProtected(task.protected_paths);
  const protectedBlock = protectedList.length
    ? `\n## 保護路徑（不得修改）\n${protectedList.map((g) => `- \`${g}\``).join('\n')}\n這些是量尺（評估程式、標準答案、設定）：改到任何一個，驗證直接失敗。要改的是演算法，不是量尺。\n`
    : '';
  const artifactList = (task.artifacts ?? '').split(',').map((g) => g.trim()).filter(Boolean);
  const artifactsBlock = artifactList.length
    ? `\n## 產出物（不要 commit）\n${artifactList.map((g) => `- \`${g}\``).join('\n')}\n驗證通過後，引擎會把符合這些路徑的檔案（執行檔、報告）收走並附上 sha256，交給人下載或發佈。讓驗證步驟產生它們即可；不要把它們 commit 進 git（commit 時引擎也會自動排除）。\n`
    : '';
  const manualRule = modes.has('manual')
    ? '\n- 你可能無法在此環境完整驗證（缺硬體/非目標 OS）。盡量自動驗證能驗的部分，並在 repo 根目錄寫一份 `VERIFY.md`：列出你做了什麼、還有哪些必須在目標環境（硬體/公司 Windows）手動驗證的具體步驟與預期結果。'
    : '';
  // The injected knowledge above is a packed excerpt chosen at dispatch time. When the task
  // also has the MCP tools, say so and say WHEN — an agent that does not know a tool exists
  // never calls it, and "look it up if you feel like it" is not a trigger anyone acts on.
  const askBlock = extras?.mcpServers?.some((s) => s !== 'loop-exec')
    ? `\n## 查知識庫（執行中隨時可用）\n` +
      `上面的 Knowledge 只是派工當下挑出來的摘要，不是全部。遇到下列情況請先查再動手：\n` +
      `- 要改設定檔、機台參數、網路或硬體相關的東西 → \`loop_recall\`（查已核可的限制與環境知識）\n` +
      `- 需要背景脈絡、歷史決策、別處的做法 → \`loop_search\`（查語料庫，會回傳檔案路徑與行號）\n` +
      `- 要讀本 repo 以外、但已登錄的專案檔案 → \`list_dir\` / \`read_file\` / \`search_text\`（唯讀）\n` +
      `查到的限制與 Knowledge 段落同等有效；若與 Plan 衝突，以 Plan 為準，並在 HANDOFF.md 註明衝突。\n`
    : '';
  // The GPU 沙盒 is the only way a Claude run can compile or execute anything (its Bash is limited
  // to git/npm/node/ls/cat) — without this section the agent does not know the tool exists.
  const execBlock = extras?.exec
    ? `\n## GPU 沙盒（執行中可用）\n` +
      `可以用 \`loop-exec\` 的 \`run\` 工具（Claude 下名稱為 \`mcp__loop-exec__run\`）在 Docker 沙盒裡執行 bash 指令：這個 worktree 掛在 /work 並是工作目錄，有 GPU、沒有網路，映像 ${extras.exec.image}，預設 ${extras.exec.timeoutSec} 秒逾時（最多 ${extras.exec.maxTimeoutSec} 秒）。\n` +
      `- 寫完程式就自己編譯、執行、跑測試或量測，以實際輸出為準，不要只憑閱讀判斷。\n` +
      `- 驗證要能自動判斷：讓程式自己檢查結果，以 exit code 表示成敗（例如和 CPU 參考值比對，不符就 exit 1）。\n` +
      `- 編譯產物放在 \`build/\` 之類的目錄並加進 .gitignore，不要 commit 執行檔或量測報告。\n` +
      `- Verification steps 裡以 \`sandbox:\` 開頭的步驟，引擎會在同一個沙盒裡執行；你自己跑時，去掉這個前綴交給 run 工具即可。` +
      `\`sandbox@<主機>:\` 的步驟要在那台主機上跑：呼叫 run 時帶 \`host: "<主機>"\`。\n` +
      execHostsBlock(extras.exec.hosts)
    : '';
  const disciplineBlock = extras?.discipline ? DISCIPLINE_BLOCK : '';
  const attachmentsBlock = extras?.attachments?.length
    ? `\n## 附件（截圖）\n回報問題的人附了這些截圖（可以用讀檔工具打開）；下面是引擎辨識出的畫面文字：\n` +
      extras.attachments.map((a, i) => `- 圖 ${i + 1}：\`${a.path}\`${a.text ? `\n  ${a.text.trim().split('\n').slice(0, 12).join('\n  ')}` : '（沒有辨識出文字）'}`).join('\n') +
      '\n'
    : '';
  const repoMapBlock = extras?.repoMap
    ? `\n## Repo 地圖（引擎產生，先看這個再決定讀哪些檔案）\n${extras.repoMap.replace(/^# .*\n/, '').trim()}\n`
    : '';
  const repoKnowledgeBlock = extras?.repoKnowledge
    ? `\n## 這個 repo 的規範與經驗（Loop 從這個 repo 與過去的任務整理，已由人核可）\n${extras.repoKnowledge.trim()}\n`
    : '';
  const fixesBlock = extras?.similarFixes
    ? `\n## 這個 repo 過去類似的修法（參考，不一定適用）\n${extras.similarFixes}\n`
    : '';
  const reproBlock = extras?.reproBefore
    ? `\n## 重現輸出（修改前，引擎在乾淨的分支上跑的）\n這個問題目前確實會發生；修好之後同一個指令必須通過。\n\`\`\`\n${extras.reproBefore.trim().slice(-3000)}\n\`\`\`\n`
    : '';
  const checkLines = extras?.checks?.length ? extras.checks : null;
  const stepsList = checkLines
    ? [...checkLines, ...steps.filter((s) => !s.startsWith('check:')).map((s) => `- \`${s}\``)].join('\n')
    : steps.map((s) => `- \`${s}\``).join('\n') || '- (none)';
  const machinesBlock = extras?.machines?.length
    ? `\n## 機台與環境（驗收檢查在這些地方跑）\n${extras.machines.join('\n')}\n` +
      `- 指令、路徑與建置要符合跑它的那一台：Windows 用 PowerShell／cmd 語法和反斜線路徑，Linux 用 bash；aarch64 和 x86_64 的執行檔不能互用；上面沒列出的軟體、函式庫或 CUDA 版本不要假設那台有。\n` +
      `- 你自己只能在「你現在所在的環境」裡跑；標了其他機台的檢查由引擎代跑，沒過時結果會交回給你。\n`
    : '';
  const checksRule = checkLines
    ? '\n- 驗收檢查由引擎執行（標明機台的在那台機台上跑）；你在本地能跑的（建置、測試、重現）自己先跑到綠再結束。'
    : '';
  const body = `# Loop task: ${task.title}

## Goal
${task.goal}
${attachmentsBlock}${knowledgeBlock}${ragBlock}${repoKnowledgeBlock}${repoMapBlock}${fixesBlock}${askBlock}${execBlock}
## Plan
${planContent(task)}
${reproBlock}
## Verification steps (must all pass before you finish)
${stepsList}
${machinesBlock}${acceptanceBlock}${metricsBlock}${protectedBlock}${artifactsBlock}
## Rules
- Only modify files needed for this task; do not touch anything outside its scope.
- Commit your work in small, conventional commits.
- Maintain a \`HANDOFF.md\` at the repo root with sections: Done / TODO / Key decisions / How to resume. Update AND commit it before any long or risky step, so a resumed run can pick up exactly where you left off if you are interrupted near the usage limit.
- If a \`LOOP_RESUME_CONTEXT.md\` is present, a previous attempt was interrupted or its verification failed — read it FIRST and continue from there instead of starting over.
- Before finishing, run the verification steps yourself and fix until they pass.
- If you cannot complete the task, clearly explain the blocker and stop — do not force a workaround.${manualRule}${checksRule}
${disciplineBlock}`;
  fs.writeFileSync(file, body);
  return file;
}

/**
 * Persist the failing verification step + captured output tail as LOOP_RESUME_CONTEXT.md
 * in the worktree, so a resumed run inherits the failure context and fixes it in place
 * rather than re-deriving what broke. Returns the file path.
 */
export function writeResumeContext(
  cwd: string,
  failedStep: string,
  outputTail: string,
  extra: { history?: string[]; handover?: string; seen?: string[] } = {},
): string {
  const file = path.join(cwd, 'LOOP_RESUME_CONTEXT.md');
  // with no extras the file is byte-identical to before (the fix budget / ladder / learned pitfalls add them)
  const handover = extra.handover ? `\n## 交接\n${extra.handover}\n` : '';
  const seen = extra.seen?.length ? `\n## 這個錯誤以前見過（這個 repo 學到的陷阱）\n${extra.seen.join('\n')}\n先對照這些再動手；不適用就忽略。\n` : '';
  const history = extra.history?.length ? `\n## 之前的嘗試\n${extra.history.map((h) => `- ${h}`).join('\n')}\n` : '';
  const body = `# Resume context (auto-generated by Loop Engineering)

The previous attempt finished its coding phase but a **verification step FAILED**.
You have been resumed in the same session and worktree to FIX it — do not start over.
Inspect the failure below, fix the root cause, then re-run ALL verification steps until
they pass.

## Failed step
\`${failedStep}\`

## Captured output (tail)
\`\`\`
${outputTail.trim() || '(no output captured)'}
\`\`\`
${seen}${handover}${history}`;
  fs.writeFileSync(file, body);
  return file;
}

/**
 * Gather the state a resumed run should be primed with: the verify-failure context and
 * the agent-maintained HANDOFF.md (either may be absent). Returned as a bounded excerpt
 * to inline into the resume prompt; null when there is nothing to hand off.
 */
export function collectResumeContext(cwd: string): string | null {
  const parts: string[] = [];
  for (const name of ['LOOP_RESUME_CONTEXT.md', 'HANDOFF.md']) {
    try {
      const txt = fs.readFileSync(path.join(cwd, name), 'utf8').trim();
      if (txt) parts.push(`## ${name}\n${txt}`);
    } catch {
      /* absent — fine */
    }
  }
  if (parts.length === 0) return null;
  return parts.join('\n\n').slice(0, 4000);
}
