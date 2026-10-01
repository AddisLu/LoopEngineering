import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { paths, type Complexity } from '../config.js';
import { getBool, getSetting, logEvent } from '../db/index.js';
import { getTask } from '../tasks.js';
import type { Task } from '../types.js';
import { chatLocal, type LocalChatResult } from '../local/chat.js';
import { getLocalModel, isLocalModel, localId } from '../local/models.js';
import { cloudAllowed, isCloudModel, localFallbackModel } from '../local/backend.js';
import { getRepo, updateRepo, type Repo } from '../repo/store.js';
import { buildRepoMap, renderRepoMap, saveRepoMap, type GitExec, type RepoSymbol } from '../repo/map.js';
import { extractClues, locateIssue, type Candidate, type Clues } from '../repo/locate.js';
import { renderSimilarFixes, similarFixes, type FixEntry } from '../repo/ledger.js';
import { readImages, type VisionExec } from './vision.js';
import { readTaskImages, type TaskImage } from './context.js';
import { heuristicIntent } from '../chat/intent.js';
import { buildWorkForm, composeWork } from '../chatops/compose.js';
import { WORK_TEMPLATES, type WorkFacts } from '../chatops/templates.js';
import type { Verification } from '../chatops/verify.js';
import { commandSaidByUser } from '../chatops/provenance.js';
import { lintPrd, type LintDeps } from '../prd/lint.js';
import { applyPrdToTask, checkPrd, taskFieldsFromPrd, writePlanFile, type PrdCheck, type PrdTaskFields } from '../prd/intake.js';
import type { PrdReviewExec } from '../prd/review.js';
import { domainPick } from '../orchestrator/run.js';
import { benchmarkRecommendations } from '../benchmark/store.js';
import { timeoutMinFor } from '../scheduler/timeout.js';
import { getMachine } from '../exec/machines.js';
import { resolveInside } from '../git/worktree.js';
import { repoTicketChecks } from './checks.js';
import { reportIssue } from '../integrations/giteaIssues.js';

/**
 * 分析 — what turns a 問題單 (a draft task carrying intake_json) into its 分析卡 (analysis_json)
 * and a runnable task. One async job per ticket, never more than one in flight; every step writes
 * its progress to analysis_json.steps[] as it goes (the page polls every 3 s) and nothing ever
 * throws out of it — a failure is analysis_status 'failed' with the reason.
 *
 *   map      refresh the repo map when repos.map_sha is not HEAD (src/repo/map.ts)
 *   vision   read the screenshots (src/intake/vision.ts) and keep the text on images_json
 *   locate   clues from the description + screenshot text → candidate files (src/repo/locate.ts)
 *   propose  the served local model proposes kind / title / causes / repro / size / questions;
 *            without a model, rules do (heuristicIntent, the top candidates, no repro)
 *   repro    failing_first: dry-run the repro command through deps.runRepro (wired by a later link)
 *   checks   what will prove the fix (deps.checks, else the repo's detected build / test + repro)
 *   review   compose the PRD (buildWorkForm/composeWork), lint it, the local review's questions
 *            become 「Loop 還不確定」, write the plan file and apply it to the draft task
 *
 * Only local models are ever asked: company code never leaves the machine from here.
 */

export type TicketKind = 'bugfix' | 'feature' | 'perf' | 'algo';
export const TICKET_KINDS: readonly TicketKind[] = ['bugfix', 'feature', 'perf', 'algo'];

export type AnalysisStatus = 'pending' | 'running' | 'ready' | 'failed';

export interface Evidence {
  line: number;
  text: string;
}

/** 可能原因與位置: one row of the card */
export interface Cause {
  file: string;
  symbol: string | null;
  why: string;
  evidence: Evidence[];
  /** `git log -3` of the file: 「abc123 fix(control): … (2 weeks ago)」 */
  recent: string[];
}

/** a dry run of the repro command on the base (failing_first): a correct repro is NOT ok before the fix */
export interface ReproRun {
  /** the command exited 0 */
  ok: boolean;
  exit_code: number | null;
  ms: number;
  tail: string;
}

/** 重現方式: an existing command that fails today, or a failing test Loop writes first */
export interface Repro {
  mode: 'command' | 'new_test';
  command: string | null;
  test_file: string | null;
  description: string;
  before: ReproRun | null;
}

/** 驗收清單: one check as the card shows it */
export interface CheckRow {
  id: string;
  name: string;
  kind: string;
  machine: string | null;
  command: string | null;
  required: boolean;
  on: boolean;
  /** 「exit 0」「正確率不低於 98.7%」… */
  rule: string;
}

export type StepKey = 'map' | 'vision' | 'locate' | 'propose' | 'repro' | 'checks' | 'review';
export type StepState = 'todo' | 'running' | 'done' | 'failed' | 'skipped';

export interface AnalysisStep {
  key: StepKey;
  label: string;
  state: StepState;
  detail?: string;
}

/** 執行條件 */
export interface Conditions {
  /** null = the engine host */
  machine: { name: string; os: string; ok: boolean | null; last_check_at: string | null } | null;
  model: { id: string | null; label: string; reason: string };
  estimate: { complexity: Complexity; minutes: number; window: string | null };
  ladder: { attempts: number | null; next: string[] };
}

/** TicketView.analysis — the 分析卡 exactly as the page reads it (ticket-api.md). */
export interface TicketAnalysis {
  steps: AnalysisStep[];
  causes: Cause[];
  repro: Repro | null;
  checks: CheckRow[];
  conditions: Conditions;
  /** 「Loop 還不確定」 */
  questions: string[];
  error: string | null;
  /** which local model analysed (null = rules only) */
  model_used: string | null;
  took_ms: number | null;
}

/** What analysis_json stores: the card plus the bookkeeping behind it. */
export interface AnalysisState {
  steps: AnalysisStep[];
  causes: Cause[];
  repro: Repro | null;
  /** who wrote the repro command: 'person' (typed it in the ticket, or edited it on the card) or the model */
  repro_by: 'person' | 'model' | null;
  checks: CheckRow[];
  /** optional checks the person unticked */
  checks_off: string[];
  /** the effective kind (the person's kind_hint wins over the proposal) */
  kind: TicketKind | null;
  complexity: Complexity;
  symptom: string | null;
  expected: string | null;
  /** the proposal's questions, the PRD lint's gaps and the local review's questions, merged */
  questions: string[];
  model_questions: string[];
  review_questions: string[];
  /** a manager's 退回 (shown first among the questions while approval_state is 'rejected') */
  rejection: { by: string; reason: string; at: string } | null;
  error: string | null;
  model_used: string | null;
  took_ms: number | null;
  started_at: string | null;
  finished_at: string | null;
  /** last progress write: a running analysis that stopped writing (engine restart) reads as failed */
  heartbeat_at: string | null;
}

/** intake_json: what the person gave (the ticket's source of truth for the description). */
export interface TicketIntake {
  description: string;
  kind_hint: TicketKind | null;
  issue?: { owner: string; repo: string; number: number; url: string } | null;
  from: 'ui' | 'chat' | 'issue';
  conversation_id?: string | null;
  message_id?: string | null;
  /** the title the person typed; null = Loop names the ticket */
  title?: string | null;
  /** display name of who opened it (created_by / owner hold the user key) */
  created_label?: string | null;
  /** manager mode: who pressed 開始修 (送出核可) */
  start_requested_by?: { key: string; label: string; at: string } | null;
}

/** The fields a check selection renders into the task (src/checks/render.ts renderChecks). */
export interface TicketCheckFields {
  verification_steps: string[];
  acceptance_metrics: string | null;
  protected_paths: string | null;
  artifacts: string | null;
  manual_checks: string[];
  verify_mode: string;
  requires: string | null;
}

/**
 * The checks engine as the analysis sees it — injected, so this link runs before src/checks exists.
 * `select` returns the frozen snapshot (→ tasks.checks_json), the task fields it renders into and
 * the card's rows; null = the repo has no checks (the analysis falls back to its detected commands).
 */
export interface TicketChecks {
  select(
    db: Database.Database,
    repo: Repo,
    o: { kind: string; repro: Repro | null; off: string[] },
  ): { snapshot: unknown[]; fields: TicketCheckFields; view: CheckRow[] } | null;
}

export interface AnalyseDeps {
  localChat?: typeof chatLocal;
  visionExec?: VisionExec;
  /** the PRD review (default: the same local model through localChat) */
  prdReviewExec?: PrdReviewExec;
  lintDeps?: LintDeps;
  /** git for the map / locate / log reads (default: execFileSync with a timeout) */
  git?: GitExec;
  /** the check selection (default: the repo's 檢查, src/intake/checks.ts); null = detected commands only */
  checks?: TicketChecks | null;
  /** failing_first dry run on the base; absent = the step is skipped */
  runRepro?: (db: Database.Database, task: Task, repo: Repo, repro: Repro) => Promise<ReproRun>;
  /** called once the card is ready (Gitea comment-back hooks in here) */
  onTicketReady?: (db: Database.Database, task: Task) => void;
  /** the 「Loop 的分析」 comment on an issue-sourced ticket (default: giteaIssues.reportIssue) */
  reportIssue?: (db: Database.Database, taskId: string, kind: 'analysis') => void;
}

const STEP_LABELS: Record<StepKey, string> = {
  map: '讀取 repo 地圖',
  vision: '讀取截圖',
  locate: '比對錯誤字串與符號',
  propose: '提出可能原因與重現方式',
  repro: '試跑重現指令',
  checks: '挑選必過檢查',
  review: '本地模型複核',
};
const STEP_KEYS: StepKey[] = ['map', 'vision', 'locate', 'propose', 'repro', 'checks', 'review'];

/** a running analysis that has not written anything for this long is dead (engine restart) */
const STALE_MS = 10 * 60 * 1000;
/** the saved map keeps (nearly) the whole symbol index; LOOP_TASK.md trims it (repo_map_budget_chars) */
const MAP_SAVE_BUDGET = 200_000;
const MAP_EXCERPT_CHARS = 4000;
const MAX_CAUSES = 6;

const nowIso = () => new Date().toISOString();
/** the format SQLite's datetime('now') writes (UTC) */
const sqlNow = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const oneLine = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();
const clamp = (s: unknown, max: number): string => oneLine(s).slice(0, max);
const errText = (err: unknown): string => String((err as Error)?.message ?? err).slice(0, 300);

/** 'YYYY-MM-DD HH:MM:SS' (SQLite, UTC) or ISO → ms; NaN when neither */
export function parseTime(s: string | null | undefined): number {
  if (!s) return NaN;
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? `${s.replace(' ', 'T')}Z` : s);
}

function defaultGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

// ---- the stored state ----------------------------------------------------------------------

const isKind = (v: unknown): v is TicketKind => typeof v === 'string' && (TICKET_KINDS as readonly string[]).includes(v);
const isCx = (v: unknown): v is Complexity => v === 'S' || v === 'M' || v === 'L';
const strList = (v: unknown, max: number, each = 300): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim().slice(0, each)).slice(0, max) : [];

export function readIntake(task: Pick<Task, 'intake_json' | 'goal'>): TicketIntake | null {
  if (!task.intake_json) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(task.intake_json) as Record<string, unknown>;
  } catch {
    return { description: task.goal, kind_hint: null, from: 'ui' };
  }
  const issue = raw.issue as TicketIntake['issue'];
  const from = raw.from === 'chat' || raw.from === 'issue' ? raw.from : 'ui';
  return {
    ...(raw as Partial<TicketIntake>),
    description: typeof raw.description === 'string' ? raw.description : task.goal,
    kind_hint: isKind(raw.kind_hint) ? raw.kind_hint : null,
    issue: issue && typeof issue === 'object' && typeof issue.number === 'number' ? issue : null,
    from,
  };
}

export function freshAnalysis(prev: AnalysisState | null = null): AnalysisState {
  return {
    steps: STEP_KEYS.map((key) => ({ key, label: STEP_LABELS[key], state: 'todo' as StepState })),
    causes: [],
    repro: null,
    repro_by: null,
    checks: [],
    checks_off: prev?.checks_off ?? [],
    kind: null,
    complexity: 'M',
    symptom: null,
    expected: null,
    questions: [],
    model_questions: [],
    review_questions: [],
    rejection: prev?.rejection ?? null,
    error: null,
    model_used: null,
    took_ms: null,
    started_at: null,
    finished_at: null,
    heartbeat_at: null,
  };
}

export function readAnalysis(task: Pick<Task, 'analysis_json'>): AnalysisState | null {
  if (!task.analysis_json) return null;
  let raw: Partial<AnalysisState>;
  try {
    raw = JSON.parse(task.analysis_json) as Partial<AnalysisState>;
  } catch {
    return null;
  }
  const base = freshAnalysis();
  const steps = STEP_KEYS.map((key) => {
    const got = Array.isArray(raw.steps) ? raw.steps.find((s) => s && s.key === key) : undefined;
    return got ? { key, label: STEP_LABELS[key], state: got.state, ...(got.detail ? { detail: String(got.detail) } : {}) } : { key, label: STEP_LABELS[key], state: 'todo' as StepState };
  });
  return {
    ...base,
    ...raw,
    steps,
    causes: Array.isArray(raw.causes) ? raw.causes : [],
    checks: Array.isArray(raw.checks) ? raw.checks : [],
    checks_off: strList(raw.checks_off, 50, 64),
    questions: strList(raw.questions, 12),
    model_questions: strList(raw.model_questions, 5),
    review_questions: strList(raw.review_questions, 10),
    kind: isKind(raw.kind) ? raw.kind : null,
    complexity: isCx(raw.complexity) ? raw.complexity : 'M',
    repro: raw.repro && typeof raw.repro === 'object' ? raw.repro : null,
  };
}

function save(db: Database.Database, taskId: string, state: AnalysisState, status?: AnalysisStatus): void {
  state.heartbeat_at = nowIso();
  if (status) {
    db.prepare("UPDATE tasks SET analysis_json = ?, analysis_status = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(state), status, taskId);
  } else {
    db.prepare('UPDATE tasks SET analysis_json = ? WHERE id = ?').run(JSON.stringify(state), taskId);
  }
}

// ---- one analysis in flight per ticket -----------------------------------------------------

const inflight = new Map<string, Promise<void>>();
const again = new Set<string>();

export function analysisInFlight(taskId: string): boolean {
  return inflight.has(taskId);
}

/** Resolves once the ticket's analysis (and any re-run asked for meanwhile) has finished. */
export async function awaitAnalysis(taskId: string): Promise<void> {
  await inflight.get(taskId);
}

/** let the event loop serve what is waiting (the map and the grep are synchronous work) */
const breathe = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Start (or re-run) the analysis. Never rejects. A call while one is running asks for one more
 * run after it (the description changed) and returns the same promise. The ticket reads as
 * 'pending' at once; the work starts after the caller's response has gone out.
 */
export function analyseTicket(db: Database.Database, taskId: string, deps: AnalyseDeps = {}): Promise<void> {
  const cur = inflight.get(taskId);
  if (cur) {
    again.add(taskId);
    return cur;
  }
  try {
    db.prepare("UPDATE tasks SET analysis_status = 'pending' WHERE id = ? AND status = 'draft' AND intake_json IS NOT NULL").run(taskId);
  } catch {
    /* the DB is gone: runAnalysis finds nothing to do */
  }
  const job = (async () => {
    await breathe();
    try {
      do {
        again.delete(taskId);
        try {
          await runAnalysis(db, taskId, deps);
        } catch {
          /* runAnalysis records its own failures; this only guards the loop */
        }
      } while (again.has(taskId));
    } finally {
      inflight.delete(taskId);
      again.delete(taskId);
    }
  })();
  inflight.set(taskId, job);
  return job;
}

/**
 * What the page should show for the status: a pending / running analysis that is not running in
 * this process and has stopped writing progress died with the engine — it reads as failed.
 */
export function effectiveStatus(task: Pick<Task, 'id' | 'analysis_status' | 'updated_at'>, state: AnalysisState | null, now = Date.now()): { status: AnalysisStatus | null; stale: boolean } {
  const s = (task.analysis_status ?? null) as AnalysisStatus | null;
  if ((s === 'pending' || s === 'running') && !analysisInFlight(task.id)) {
    const last = parseTime(state?.heartbeat_at ?? task.updated_at);
    if (Number.isFinite(last) && now - last > STALE_MS) return { status: 'failed', stale: true };
  }
  return { status: s, stale: false };
}
export const STALE_ERROR = '分析中斷了（引擎可能重新啟動過）：請按「重試」';

class Cancelled extends Error {}
/** a ticket the analysis cannot work on (its repo is gone): the reason is the card's error */
export class AnalysisError extends Error {}

// ---- the map ---------------------------------------------------------------------------------

export interface MapInfo {
  markdown: string;
  symbols: RepoSymbol[];
  sha: string | null;
  rebuilt: boolean;
}

/** The symbol index back out of a rendered map (`- file: name():12, Cls{}:3`). */
export function symbolsFromMap(markdown: string): RepoSymbol[] {
  const at = markdown.indexOf('## 符號索引');
  if (at < 0) return [];
  const out: RepoSymbol[] = [];
  for (const line of markdown.slice(at).split('\n').slice(1)) {
    const m = /^- (.+?): (.+)$/.exec(line);
    if (!m) continue;
    for (const part of m[2]!.split(', ')) {
      const s = /^(~?[A-Za-z_][A-Za-z0-9_]*)(\{\}|\(\)):(\d+)$/.exec(part.trim());
      if (s) out.push({ file: m[1]!, name: s[1]!, line: Number(s[3]), kind: s[2] === '{}' ? 'class' : 'function' });
    }
  }
  return out;
}

/**
 * The repo's map, rebuilt (and repos.map_path / map_sha / map_at updated) when map_sha is not the
 * clone's HEAD; otherwise the saved one.
 */
export function refreshRepoMap(db: Database.Database, repo: Repo, git?: GitExec): MapInfo {
  const run = git ?? defaultGit;
  let head: string | null = null;
  try {
    head = run(['rev-parse', 'HEAD'], repo.local_path).trim() || null;
  } catch {
    head = null;
  }
  if (repo.map_sha && repo.map_path && head && head.startsWith(repo.map_sha)) {
    try {
      const markdown = fs.readFileSync(repo.map_path, 'utf8');
      return { markdown, symbols: symbolsFromMap(markdown), sha: repo.map_sha, rebuilt: false };
    } catch {
      /* the file is gone: rebuild */
    }
  }
  const map = buildRepoMap(repo.local_path, git ? { git } : {});
  const markdown = renderRepoMap(repo.name, map, MAP_SAVE_BUDGET);
  const file = saveRepoMap(repo.id, markdown);
  updateRepo(db, repo.id, { map_path: file, map_sha: map.sha, map_at: sqlNow() });
  return { markdown, symbols: map.symbols, sha: map.sha, rebuilt: true };
}

// ---- the proposal ----------------------------------------------------------------------------

export interface Proposal {
  kind: TicketKind | null;
  title: string | null;
  symptom: string | null;
  expected: string | null;
  causes: Cause[];
  repro: Repro | null;
  complexity: Complexity | null;
  questions: string[];
}

export const PROPOSE_SYSTEM = [
  '你是軟體團隊的問題分析員。工程師描述了一個問題（可能附截圖上的文字）；引擎已經用關鍵字在 repo 裡找到候選檔案與證據行。',
  '你的工作：判斷工作類型、指出最可能的原因與位置、提出重現方式、估計規模，並列出你無法從資料確定、需要工程師回答的事。',
  '規則：',
  '- causes 最多 6 個，依可能性排序；file 只能用「候選檔案」或「Repo 地圖」裡真的出現的 repo 相對路徑，不要編造。',
  '- repo 已有能重現問題的測試或指令時才用 mode=command（command 寫完整的一行指令）；否則用 mode=new_test，test_file 寫要新增的測試檔（放在 repo 既有的測試目錄）。',
  '- kind：bugfix＝程式錯誤；algo＝影像處理或判定規則的結果不對；feature＝要多一個功能；perf＝要更快或更省、結果不變。',
  '- complexity：S＝一兩個檔案的小修正；M＝一般；L＝跨模組或需要重新設計。',
  '- questions 只放真的需要工程師回答的事（最多 3 個），沒有就給空陣列。',
  '- 文字用繁體中文；title 不超過 40 字；why、symptom、expected 各一句話。',
  '只輸出一個 JSON 物件，不要其他文字：',
  '{"kind":"bugfix|algo|feature|perf","title":"…","symptom":"現況一句話","expected":"期望行為一句話","causes":[{"file":"src/…","symbol":"函式或類別名稱或 null","why":"…"}],"repro":{"mode":"command|new_test","command":"一行指令或 null","test_file":"測試檔或 null","description":"怎麼重現，一句話"},"complexity":"S|M|L","questions":["…"]}',
].join('\n');

function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  return `${text.slice(0, cut > 0 ? cut : max)}\n- …（其餘省略）`;
}

export function buildProposePrompt(o: {
  description: string;
  imageTexts: string[];
  clues: Clues;
  candidates: Candidate[];
  mapMarkdown: string;
  similar: FixEntry[];
  repo: Pick<Repo, 'name' | 'build_cmd' | 'test_cmd'>;
  kindHint: TicketKind | null;
}): string {
  const list = (label: string, xs: string[]) => (xs.length ? [`- ${label}：${xs.join('、')}`] : []);
  const parts: string[] = [`## 問題描述\n${o.description.trim()}`];
  if (o.kindHint) parts.push(`## 工程師指定的類型\n${o.kindHint}（kind 照填）`);
  const shots = o.imageTexts.map((t, i) => (t.trim() ? `- 圖 ${i + 1}：${t.trim().split('\n').slice(0, 15).join(' / ')}` : '')).filter(Boolean);
  if (shots.length) parts.push(`## 截圖上的文字\n${shots.join('\n')}`);
  const clueLines = [...list('錯誤訊息', o.clues.errors), ...list('識別字', o.clues.identifiers), ...list('路徑', o.clues.paths), ...list('介面文字', o.clues.labels)];
  parts.push(`## 引擎抽出的線索\n${clueLines.length ? clueLines.join('\n') : '（沒有）'}`);
  parts.push(
    `## 候選檔案（git grep 計分，分數高的在前）\n${
      o.candidates.length
        ? o.candidates
            .map((c, i) =>
              [
                `${i + 1}. \`${c.file}\`（分數 ${c.score}；線索：${c.clues.slice(0, 5).join('、')}）`,
                ...c.evidence.map((e) => `   - 第 ${e.line} 行：\`${e.text.slice(0, 160)}\``),
                ...(c.recent[0] ? [`   - 最近修改：${c.recent[0]}`] : []),
              ].join('\n'),
            )
            .join('\n')
        : '（沒有找到候選檔案）'
    }`,
  );
  if (o.mapMarkdown.trim()) parts.push(`## Repo 地圖（節錄）\n${excerpt(o.mapMarkdown.replace(/^# .*\n/, '').trim(), MAP_EXCERPT_CHARS)}`);
  const fixes = renderSimilarFixes(o.similar);
  if (fixes) parts.push(`## 這個 repo 過去類似的修法\n${fixes}`);
  const cmds = [...(o.repo.build_cmd ? [`- 建置：\`${o.repo.build_cmd}\``] : []), ...(o.repo.test_cmd ? [`- 測試：\`${o.repo.test_cmd}\``] : [])];
  if (cmds.length) parts.push(`## ${o.repo.name} 的指令\n${cmds.join('\n')}`);
  return parts.join('\n\n');
}

function stripFences(s: string): string {
  const t = s.trim();
  return t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? t;
}

/** A repo-relative file path from a model (backticks, ./ and a :line suffix dropped); null when unsafe. */
export function cleanRepoPath(raw: unknown): string | null {
  let p = String(raw ?? '').trim().replace(/^`+|`+$/g, '').replace(/\\/g, '/').replace(/^\.\//, '');
  p = p.replace(/:(\d+)(?::\d+)?$/, '');
  if (!p || p === 'null' || p.length > 300 || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..') || /[\u0000-\u001f]/.test(p)) return null;
  return p;
}

function repoFile(repoPath: string, rel: string): boolean {
  try {
    return fs.statSync(path.join(repoPath, rel)).isFile();
  } catch {
    return false;
  }
}

/**
 * The model's JSON, parsed defensively like chat/intent.ts parseModel: anything invented is dropped
 * (a cause whose file is not in the repo, a repro without a command or a test file). Null when the
 * reply is not a JSON object at all.
 */
export function parseProposal(text: string, ctx: { repoPath: string; candidates: Candidate[]; recentOf?: (file: string) => string[] }): Proposal | null {
  let j: Record<string, unknown> | null = null;
  for (const src of [stripFences(text), /\{[\s\S]*\}/.exec(text)?.[0] ?? '']) {
    if (!src) continue;
    try {
      const v = JSON.parse(src) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        j = v as Record<string, unknown>;
        break;
      }
    } catch {
      /* try the next form */
    }
  }
  if (!j) return null;
  const nul = (s: string): string | null => (s && s.toLowerCase() !== 'null' && s.toLowerCase() !== 'none' ? s : null);
  const byFile = new Map(ctx.candidates.map((c) => [c.file, c]));
  const causes: Cause[] = [];
  for (const raw of Array.isArray(j.causes) ? j.causes : []) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const file = cleanRepoPath(r.file);
    if (!file || causes.some((c) => c.file === file)) continue;
    const cand = byFile.get(file);
    if (!cand && !repoFile(ctx.repoPath, file)) continue; // invented
    const symbol = nul(clamp(r.symbol, 80).replace(/\(\)$/, ''));
    causes.push({
      file,
      symbol,
      why: clamp(r.why, 200) || (cand ? `符合線索：${cand.clues.slice(0, 4).join('、')}` : ''),
      evidence: cand ? cand.evidence.map((e) => ({ line: e.line, text: e.text })) : [],
      recent: cand ? cand.recent : (ctx.recentOf?.(file) ?? []),
    });
    if (causes.length >= MAX_CAUSES) break;
  }
  let repro: Repro | null = null;
  if (j.repro && typeof j.repro === 'object') {
    const r = j.repro as Record<string, unknown>;
    let mode: Repro['mode'] | null = r.mode === 'command' ? 'command' : r.mode === 'new_test' ? 'new_test' : null;
    const command = nul(clamp(r.command, 500));
    const testFile = cleanRepoPath(r.test_file);
    if (mode === 'command' && !command) mode = testFile ? 'new_test' : null;
    if (mode) repro = { mode, command: mode === 'command' ? command : null, test_file: testFile, description: clamp(r.description, 300), before: null };
  }
  return {
    kind: isKind(j.kind) ? j.kind : null,
    title: nul(clamp(j.title, 60)),
    symptom: nul(clamp(j.symptom, 400)),
    expected: nul(clamp(j.expected, 400)),
    causes,
    repro,
    complexity: isCx(j.complexity) ? j.complexity : null,
    questions: strList(j.questions, 3, 200),
  };
}

/** The symbol a candidate most likely is about: a clue that names one of its symbols, else the one enclosing its first evidence line. */
function symbolFor(c: Candidate, symbols: RepoSymbol[]): string | null {
  const here = symbols.filter((s) => s.file === c.file);
  if (!here.length) return null;
  const named = here.find((s) => c.clues.includes(s.name));
  if (named) return named.name;
  const line = c.evidence[0]?.line;
  if (!line) return null;
  const before = here.filter((s) => s.line <= line).sort((a, b) => b.line - a.line)[0];
  return before?.name ?? null;
}

/** No model: the kind from the keyword heuristic, the top candidates as causes, no repro. */
export function rulesProposal(description: string, candidates: Candidate[], symbols: RepoSymbol[]): { kind: TicketKind; causes: Cause[] } {
  const h = heuristicIntent(description, '');
  let kind: TicketKind = 'bugfix';
  if (h.intent === 'fix' && isKind(h.fix?.kind)) kind = h.fix!.kind as TicketKind;
  else if (h.intent === 'perf') kind = 'perf';
  else if (h.intent === 'feature') kind = 'feature';
  const causes = candidates.slice(0, MAX_CAUSES).map((c) => ({
    file: c.file,
    symbol: symbolFor(c, symbols),
    why: `符合線索：${c.clues.slice(0, 4).join('、')}`,
    evidence: c.evidence.map((e) => ({ line: e.line, text: e.text })),
    recent: c.recent,
  }));
  return { kind, causes };
}

/** The served model as a reference ('local:<id>'), for model_used. */
function loadedModelRef(db: Database.Database): string {
  const id = getSetting(db, 'local_model_loaded');
  return id ? `local:${id}` : 'local';
}

// ---- 執行條件 ----------------------------------------------------------------------------------

const DOMAIN_LABEL: Record<string, string> = { cuda: 'CUDA', cv: '影像', cpp: 'C++', csharp: 'C#', typescript: 'TypeScript', python: 'Python', other: '其他' };

export function modelLabel(db: Database.Database, id: string | null): string {
  if (!id) return '預設模型（CLI 預設）';
  if (isLocalModel(id)) return `${getLocalModel(db, localId(id))?.display_name ?? localId(id)}（本地）`;
  return `${id}（雲端）`;
}

/**
 * Which model the fix will run on and why — resolveModel's precedence (per-task model, domain
 * routing, complexity routing, default_model, then 公司模式's local fallback) without its logging.
 */
export function describeModel(db: Database.Database, task: Pick<Task, 'model' | 'domain' | 'complexity'>, complexity: Complexity = task.complexity): Conditions['model'] {
  let id: string | null;
  let reason: string;
  const perTask = task.model?.trim();
  if (perTask) {
    id = perTask === 'default' ? null : perTask;
    reason = '這張單指定的模型';
  } else {
    id = null;
    reason = '';
    if (getBool(db, 'domain_routing', false) && task.domain) {
      const pick = domainPick(db, task.domain);
      if (pick) {
        id = pick;
        let rate = '';
        try {
          const r = benchmarkRecommendations(db).find((x) => x.domain === task.domain);
          if (r?.local) rate = `通過率 ${Math.round(r.local.verify_pass_rate * 100)}%`;
        } catch {
          rate = '';
        }
        reason = `依領域挑：${DOMAIN_LABEL[task.domain] ?? task.domain} 領域${rate ? rate : '評比最好'}`;
      }
    }
    if (!id && getBool(db, 'model_routing', false)) {
      const routed = (getSetting(db, `route_${complexity}`) ?? '').trim();
      if (routed && routed !== 'default') {
        id = routed;
        reason = `依規模挑（route_${complexity}）`;
      }
    }
    if (!id) {
      const def = (getSetting(db, 'default_model') ?? '').trim();
      id = def && def !== 'default' ? def : null;
      reason = '預設模型（default_model）';
    }
  }
  if (!cloudAllowed(db) && (!id || isCloudModel(id))) {
    const local = localFallbackModel(db);
    if (local) {
      id = local;
      reason = `${reason}；公司模式只用本地模型`;
    }
  }
  return { id, label: modelLabel(db, id), reason };
}

export function ticketConditions(db: Database.Database, task: Task, state: AnalysisState | null, repo: Repo | null): Conditions {
  const complexity = state?.complexity ?? task.complexity ?? 'M';
  let machine: Conditions['machine'] = null;
  if (repo?.machine) {
    const m = getMachine(db, repo.machine);
    machine = m
      ? { name: m.name, os: m.os, ok: m.last_check_ok == null ? null : m.last_check_ok === 1, last_check_at: m.last_check_at }
      : { name: repo.machine, os: 'auto', ok: null, last_check_at: null };
  }
  const model = describeModel(db, task, complexity);
  const minutes = timeoutMinFor(db, { timeout_min: task.timeout_min ?? null, complexity }, model.id);
  const win = (getSetting(db, 'local_task_window') ?? '').trim();
  const fixAttempts = (getSetting(db, 'fix_attempts') ?? '').trim();
  const attempts = fixAttempts !== '' && Number.isFinite(Number(fixAttempts)) ? Number(fixAttempts) : null;
  const next = (getSetting(db, 'fix_escalation') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && s !== model.id);
  return {
    machine,
    model,
    estimate: { complexity, minutes, window: win && isLocalModel(model.id) ? win : null },
    ladder: { attempts, next },
  };
}

// ---- checks, PRD, apply ----------------------------------------------------------------------

interface Selected {
  fields: TicketCheckFields;
  snapshot: unknown[] | null;
  fromChecks: boolean;
}

/** The detected-commands fallback: build, test and the repro command, each required, exit 0. */
export function fallbackChecks(repo: Repo, repro: Repro | null): { fields: TicketCheckFields; view: CheckRow[] } {
  const view: CheckRow[] = [];
  const row = (id: string, name: string, kind: string, command: string): CheckRow => ({ id, name, kind, machine: repo.machine, command, required: true, on: true, rule: 'exit 0' });
  if (repo.build_cmd) view.push(row('build', '建置', 'build', repo.build_cmd));
  if (repo.test_cmd) view.push(row('test', '測試', 'test', repo.test_cmd));
  if (repro?.mode === 'command' && repro.command) view.push(row('repro', '重現', 'repro', repro.command));
  const steps = [...new Set(view.map((r) => r.command!))];
  return {
    view,
    // verify_mode '' = the PRD decides (a checklist-only PRD runs as manual)
    fields: { verification_steps: steps, acceptance_metrics: null, protected_paths: null, artifacts: null, manual_checks: [], verify_mode: '', requires: null },
  };
}

function selectChecks(db: Database.Database, repo: Repo, state: AnalysisState, deps: AnalyseDeps): Selected & { note: string | null } {
  let note: string | null = null;
  // default: the repo's 檢查 (src/intake/checks.ts); null = only the repo's detected commands
  const checks = deps.checks === undefined ? repoTicketChecks : deps.checks;
  if (checks) {
    try {
      const got = checks.select(db, repo, { kind: state.kind ?? 'bugfix', repro: state.repro, off: state.checks_off });
      if (got) {
        state.checks = got.view;
        return { fields: got.fields, snapshot: got.snapshot, fromChecks: true, note: null };
      }
    } catch (err) {
      note = `檢查設定讀不到（${errText(err)}），先用偵測到的指令`;
    }
  }
  const fb = fallbackChecks(repo, state.repro);
  state.checks = fb.view;
  return { fields: fb.fields, snapshot: null, fromChecks: false, note };
}

/** Text going into the PRD must not look like the gate's "unfilled template" markers. */
const prdSafe = (s: string): string =>
  s.replace(/</g, '＜').replace(/>/g, '＞').replace(/\bTODO\b/g, 'todo').replace(/\bTBD\b/g, 'tbd').replace(/待補/g, '待 補');

const DEFAULT_EXPECTED: Record<TicketKind, string> = {
  bugfix: '照問題描述修正後不再發生，既有功能不受影響',
  algo: '照問題描述判定正確，其他案例的結果不變',
  feature: '照問題描述提供這個功能，既有功能不受影響',
  perf: '照問題描述達到效能目標，輸出結果不變',
};

export const NO_VERIFY_QUESTION =
  '這個 repo 沒有偵測到建置或測試指令，也沒有現成的重現指令：請到 Repo 頁補上建置／測試指令（或加一個檢查），或在「重現方式」填一個指令，否則沒辦法自動驗收。';

/** The ticket's PRD: the work template's form (buildWorkForm) filled from the analysis. */
export function composeTicketPrd(o: { task: Task; intake: TicketIntake; repo: Repo; state: AnalysisState; fields: TicketCheckFields }): string {
  const kind = o.state.kind ?? 'bugfix';
  const branch = o.task.base_branch || o.repo.default_branch;
  const r = o.state.repro;
  const reproText = r ? prdSafe(r.mode === 'command' && r.command ? `${r.description || '照重現指令執行'}（重現指令：${r.command}）` : r.description || '') : '';
  const facts: WorkFacts = {
    kind,
    title: prdSafe(o.task.title),
    expected: prdSafe(o.state.expected || DEFAULT_EXPECTED[kind]),
    symptom: prdSafe(o.state.symptom || oneLine(o.intake.description).slice(0, 400)),
    repro: reproText || undefined,
    files: o.state.causes.map((c) => c.file),
    size: o.state.complexity,
  };
  const verification: Verification = { source: 'detected', commands: o.fields.verification_steps, plan: null, task: null, setup: o.repo.setup_cmd ?? null, note: '' };
  const form = buildWorkForm({ facts, repo: { path: o.repo.local_path, name: o.repo.name, branch, branches: [] }, branch, verification, model: o.task.model });
  if (o.state.causes.length) {
    form.change.files = o.state.causes.map((c) => ({ path: c.file, why: prdSafe(`可能原因：${c.symbol ? `${c.symbol}，` : ''}${c.why}`) }));
    form.change.extra = ['以上是分析推測的可能位置：先讀程式確認，只做修正這個問題所需的最小修改'];
  }
  form.scope.domain = o.repo.domain;
  form.scope.complexity = o.state.complexity;
  if (r?.mode === 'new_test') form.scope.constraints.push(`先在 ${r.test_file ?? '既有的測試目錄'} 新增一個會重現這個問題的測試（修改前失敗、修改後通過），再修`);
  if (r?.mode === 'command' && r.command) form.scope.constraints.push(`重現指令 ${r.command} 在修改前會失敗，修改後必須通過`);
  if (o.fields.acceptance_metrics) form.verify.metrics = o.fields.acceptance_metrics.split(/\s*;\s*/).filter(Boolean);
  if (o.fields.protected_paths) form.scope.protected = o.fields.protected_paths.split(',').map((s) => s.trim()).filter(Boolean);
  if (o.fields.artifacts) form.verify.artifacts = o.fields.artifacts.split(',').map((s) => s.trim()).filter(Boolean);
  if (o.fields.manual_checks.length) form.verify.manual = [...form.verify.manual, ...o.fields.manual_checks.map(prdSafe)];
  return composeWork(form);
}

function dedupe(list: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const q of list.map((s) => s.trim()).filter(Boolean)) {
    if (seen.has(q)) continue;
    seen.add(q);
    out.push(q);
    if (out.length >= max) break;
  }
  return out;
}

type Mark = (key: StepKey, state: StepState, detail?: string) => void;

/**
 * Checks → PRD → lint (→ the local review when `review`) → plan file → the draft task's fields.
 * Shared by the analysis and by a card edit's re-render (no model call there). Returns whether the
 * review blocked (prd_require_llm) with the reason.
 */
async function planTicket(
  db: Database.Database,
  taskId: string,
  state: AnalysisState,
  deps: AnalyseDeps,
  o: { review: boolean; mark: Mark },
): Promise<{ blocked: string | null }> {
  let task = getTask(db, taskId);
  if (!task || task.status !== 'draft' || !task.intake_json) throw new Cancelled();
  const intake = readIntake(task)!;
  const repo = task.repo_id ? getRepo(db, task.repo_id) : null;
  if (!repo) throw new AnalysisError('找不到這張單的 repo（可能已被移除登錄）');

  // checks
  o.mark('checks', 'running');
  const sel = selectChecks(db, repo, state, deps);
  db.prepare('UPDATE tasks SET checks_json = ? WHERE id = ?').run(sel.snapshot ? JSON.stringify(sel.snapshot) : null, taskId);
  const required = state.checks.filter((c) => c.required).length;
  o.mark(
    'checks',
    'done',
    [state.checks.length ? `${state.checks.length} 項（必過 ${required}）` : '沒有可以自動跑的檢查', sel.fromChecks ? null : '用 repo 偵測到的指令', sel.note].filter(Boolean).join('；'),
  );

  // PRD
  o.mark('review', 'running');
  task = getTask(db, taskId);
  if (!task || task.status !== 'draft') throw new Cancelled();
  const markdown = composeTicketPrd({ task, intake, repo, state, fields: sel.fields });
  const lint = lintPrd(markdown, deps.lintDeps);
  let check: PrdCheck | null = null;
  let reviewNote = '';
  if (o.review && lint.ok) {
    const chat = deps.localChat ?? chatLocal;
    const exec: PrdReviewExec =
      deps.prdReviewExec ??
      (async (p) => {
        const r = await chat(db, { ...p, maxTokens: 4096 });
        if (r.ok) return r.content;
        if (r.reason === 'disabled' || r.reason === 'not_ready') return null;
        throw new Error(r.detail);
      });
    check = await checkPrd(db, markdown, { exec, lintDeps: deps.lintDeps });
  }
  const noVerify = sel.fields.verification_steps.length === 0;
  const lintGaps = lint.missing.filter((m) => !(noVerify && m.includes('驗證指令')));
  if (check) {
    state.review_questions = dedupe([...check.llm.questions, ...check.missing.filter((m) => m.startsWith('審查：')).map((m) => m.replace(/^審查：/, ''))], 8);
  }
  state.questions = dedupe([...state.model_questions, ...(noVerify ? [NO_VERIFY_QUESTION] : []), ...lintGaps.map((m) => `需求文件：${m}`), ...state.review_questions], 10);

  if (!o.review) reviewNote = '改過之後重新整理了需求文件（沒有重新複核）';
  else if (!lint.ok) reviewNote = '需求文件還有缺漏，略過複核';
  else if (check?.llm.status === 'unavailable') reviewNote = '本地模型沒有載入，略過複核';
  else if (check?.llm.status === 'error') reviewNote = `複核失敗：${check.llm.error ?? ''}`;
  else if (check?.llm.status === 'ok') reviewNote = state.review_questions.length ? `${state.review_questions.length} 個問題` : '沒有疑問';
  const reviewState: StepState = !o.review ? 'done' : check?.llm.status === 'ok' ? 'done' : check?.llm.status === 'error' ? 'failed' : 'skipped';

  // the task: plan file + fields (never across an await: a cancel cannot slip in between)
  task = getTask(db, taskId);
  if (!task || task.status !== 'draft') throw new Cancelled();
  const planRef = writePlanFile(markdown, task.title);
  const tf = taskFieldsFromPrd(lint.fields, planRef);
  const applied: PrdTaskFields = {
    ...tf,
    title: task.title,
    goal: intake.description,
    repo_path: repo.local_path,
    base_branch: task.base_branch || repo.default_branch,
    verification_steps: sel.fields.verification_steps,
    complexity: state.complexity,
    domain: repo.domain,
    setup_cmd: tf.setup_cmd ?? repo.setup_cmd ?? null,
    ...(sel.fromChecks
      ? {
          verify_mode: sel.fields.verify_mode || tf.verify_mode,
          requires: sel.fields.requires,
          acceptance_metrics: sel.fields.acceptance_metrics,
          protected_paths: sel.fields.protected_paths,
          artifacts: sel.fields.artifacts,
        }
      : {}),
  };
  const old = task.plan_ref;
  applyPrdToTask(db, taskId, applied);
  const oldPlan = old && old !== planRef ? resolveInside(paths.plansDir, old) : null;
  if (oldPlan) fs.rmSync(oldPlan, { force: true });
  o.mark('review', reviewState, reviewNote);

  const blocked = o.review && lint.ok && check && !check.ok && getBool(db, 'prd_require_llm', false) ? check.missing.join('；') : null;
  return { blocked };
}

// ---- the job -----------------------------------------------------------------------------------

async function runAnalysis(db: Database.Database, taskId: string, deps: AnalyseDeps): Promise<void> {
  const t0 = Date.now();
  let task = getTask(db, taskId);
  if (!task || !task.intake_json || task.status !== 'draft') return;
  const state = freshAnalysis(readAnalysis(task));
  state.started_at = nowIso();
  const put = (status?: AnalysisStatus): void => {
    try {
      save(db, taskId, state, status);
    } catch {
      /* the DB is gone (shutdown): nothing to record into */
    }
  };
  const mark: Mark = (key, st, detail) => {
    const s = state.steps.find((x) => x.key === key)!;
    s.state = st;
    if (detail !== undefined) s.detail = detail;
    else if (st === 'running') delete s.detail;
    put();
  };
  const alive = (): Task => {
    const t = getTask(db, taskId);
    if (!t || t.status !== 'draft' || !t.intake_json) throw new Cancelled();
    return t;
  };

  try {
    put('running');
    const intake = readIntake(task)!;
    const repo = task.repo_id ? getRepo(db, task.repo_id) : null;
    if (!repo) throw new AnalysisError('找不到這張單的 repo（可能已被移除登錄）');
    if (!fs.existsSync(repo.local_path)) throw new AnalysisError(`repo 的本機複本不見了：${repo.local_path}`);
    const git = deps.git ?? defaultGit;
    const chat = deps.localChat ?? chatLocal;
    const branch = task.base_branch || repo.default_branch;

    // 1. map
    mark('map', 'running');
    await breathe();
    let map: MapInfo = { markdown: '', symbols: [], sha: null, rebuilt: false };
    try {
      map = refreshRepoMap(db, repo, deps.git);
      mark('map', 'done', `${repo.name} @ ${branch}，${map.rebuilt ? '地圖已更新' : '地圖是最新的'}${map.sha ? `（${map.sha.slice(0, 7)}）` : ''}`);
    } catch (err) {
      mark('map', 'failed', `地圖產生失敗：${errText(err)}`);
    }
    await breathe();

    // 2. vision
    task = alive();
    let images: TaskImage[] = readTaskImages(task);
    const unread = images.map((im, i) => ({ im, i })).filter(({ im }) => !im.via || im.via === 'none');
    if (!images.length) mark('vision', 'skipped', '沒有截圖');
    else {
      if (unread.length) {
        mark('vision', 'running', `${unread.length} 張`);
        const readings = await readImages(
          db,
          unread.map(({ im }) => ({ file: im.file, mime: im.mime ?? 'image/png' })),
          { localChat: chat, exec: deps.visionExec },
        );
        task = alive();
        images = readTaskImages(task);
        unread.forEach(({ i }, k) => {
          const r = readings[k];
          const cur = images[i];
          if (!r || !cur) return;
          const next: TaskImage & { note?: string } = { ...cur, text: r.text, via: r.via };
          if (r.note) next.note = r.note;
          else delete (next as { note?: string }).note;
          images[i] = next;
        });
        db.prepare('UPDATE tasks SET images_json = ? WHERE id = ?').run(JSON.stringify(images), taskId);
      }
      const count = (via: string) => images.filter((im) => im.via === via).length;
      mark('vision', 'done', [`${images.length} 張`, count('model') ? `模型讀了 ${count('model')} 張` : '', count('ocr') ? `OCR ${count('ocr')} 張` : '', count('none') ? `${count('none')} 張沒有辨識出文字` : ''].filter(Boolean).join('，'));
    }

    // 3. locate
    mark('locate', 'running');
    await breathe();
    const imageTexts = images.map((im) => im.text ?? '');
    const clues = extractClues([intake.description, ...imageTexts.filter(Boolean)].join('\n'));
    let candidates: Candidate[] = [];
    try {
      candidates = locateIssue(repo.local_path, clues, { ...(deps.git ? { git: deps.git } : {}), symbols: map.symbols, rev: revFor(repo, branch, git) });
      const n = clues.errors.length + clues.identifiers.length + clues.paths.length + clues.labels.length;
      mark('locate', 'done', candidates.length ? `找到 ${candidates.length} 個候選檔案（${n} 個線索）` : `沒有找到明確位置（${n} 個線索）`);
    } catch (err) {
      mark('locate', 'failed', `搜尋失敗：${errText(err)}`);
    }
    await breathe();

    // 4. propose
    task = alive();
    mark('propose', 'running');
    let similar: FixEntry[] = [];
    try {
      similar = similarFixes(db, repo.id, `${task.title}\n${intake.description}`, 5).filter((f) => f.task_id !== taskId);
    } catch {
      similar = [];
    }
    const recentOf = (file: string): string[] => {
      try {
        return git(['log', '-3', '--format=%h %s (%cr)', '--', file], repo.local_path).split('\n').map((s) => s.trim()).filter(Boolean);
      } catch {
        return [];
      }
    };
    let proposal: Proposal | null = null;
    let why = '';
    let reply: LocalChatResult;
    try {
      reply = await chat(db, {
        system: PROPOSE_SYSTEM,
        user: buildProposePrompt({ description: intake.description, imageTexts, clues, candidates, mapMarkdown: map.markdown, similar, repo, kindHint: intake.kind_hint }),
        maxTokens: 1500,
        thinking: false,
      });
    } catch (err) {
      reply = { ok: false, reason: 'network', detail: errText(err) };
    }
    if (reply.ok) {
      proposal = parseProposal(reply.content, { repoPath: repo.local_path, candidates, recentOf });
      if (!proposal) why = '模型回覆無法解析';
    } else why = reply.reason === 'disabled' || reply.reason === 'not_ready' ? '本地模型未載入' : `本地模型沒有回應：${reply.detail}`;
    task = alive();
    const rules = rulesProposal(intake.description, candidates, map.symbols);
    state.kind = intake.kind_hint ?? proposal?.kind ?? rules.kind;
    state.causes = proposal?.causes.length ? proposal.causes : rules.causes;
    state.repro = proposal?.repro ?? null;
    // a command counts as the person's only when they typed it into a ticket they opened themselves
    state.repro_by = state.repro?.command && intake.from !== 'issue' && commandSaidByUser([intake.description], state.repro.command) ? 'person' : state.repro ? 'model' : null;
    state.complexity = proposal?.complexity ?? WORK_TEMPLATES[state.kind].complexity;
    state.symptom = proposal?.symptom ?? null;
    state.expected = proposal?.expected ?? null;
    state.model_questions = proposal?.questions ?? [];
    state.model_used = proposal ? loadedModelRef(db) : null;
    if (proposal?.title && !intake.title) {
      db.prepare("UPDATE tasks SET title = ?, updated_at = datetime('now') WHERE id = ? AND status = 'draft'").run(proposal.title, taskId);
    }
    mark('propose', 'done', proposal ? `本地模型：${state.causes.length} 個可能位置${state.repro ? `，重現方式：${state.repro.mode === 'command' ? '現成指令' : '先寫會失敗的測試'}` : ''}` : `規則分析（${why}）：${state.causes.length} 個可能位置`);

    // 5. repro (failing_first dry run)
    const r = state.repro;
    if (!r) mark('repro', 'skipped', '沒有提出重現方式');
    else if (r.mode !== 'command' || !r.command) mark('repro', 'skipped', 'Loop 會先寫一個會失敗的測試，沒有現成的指令可以試跑');
    else if (!getBool(db, 'failing_first', false)) mark('repro', 'skipped', '「開始修之前先確認重現會失敗」沒有開（failing_first）');
    else if (state.repro_by !== 'person') mark('repro', 'skipped', '重現指令是 Loop 提的：確認（改一下）之後才會試跑');
    else if (!deps.runRepro) mark('repro', 'skipped', '重現試跑還沒接上');
    else {
      mark('repro', 'running');
      try {
        const before = await deps.runRepro(db, alive(), repo, r);
        r.before = { ok: Boolean(before.ok), exit_code: typeof before.exit_code === 'number' ? before.exit_code : null, ms: Number(before.ms) || 0, tail: String(before.tail ?? '').slice(-4000) };
        mark('repro', 'done', r.before.ok ? '現在就通過了——可能重現不了，請確認' : `現在：✗ 失敗（exit ${r.before.exit_code ?? '?'}）— 正確`);
      } catch (err) {
        mark('repro', 'failed', `試跑失敗：${errText(err)}`);
      }
    }

    // 6 + 7. checks, PRD, review, apply
    const { blocked } = await planTicket(db, taskId, state, deps, { review: true, mark });
    state.took_ms = Date.now() - t0;
    state.finished_at = nowIso();
    if (blocked) {
      state.error = `本地模型複核沒有通過（prd_require_llm=true）：${blocked}`;
      put('failed');
      logEvent(db, { task_id: taskId, kind: 'note', detail: `分析沒有完成：${state.error}` });
      return;
    }
    state.error = null;
    put('ready');
    logEvent(db, {
      task_id: taskId,
      kind: 'note',
      detail: `分析完成（${state.model_used ? `本地模型 ${state.model_used}` : '規則分析'}）：${state.causes.length} 個可能位置、${state.checks.length} 項檢查${state.questions.length ? `、${state.questions.length} 個待確認` : ''}`,
    });
    // an issue-sourced ticket tells its issue what Loop found (no-op without an issue link)
    (deps.reportIssue ?? reportIssue)(db, taskId, 'analysis');
    if (deps.onTicketReady) {
      try {
        const ready = getTask(db, taskId);
        if (ready) deps.onTicketReady(db, ready);
      } catch {
        /* a hook never fails the analysis */
      }
    }
  } catch (err) {
    if (err instanceof Cancelled) return;
    state.error = err instanceof AnalysisError ? err.message : `分析出錯：${errText(err)}`;
    for (const s of state.steps) if (s.state === 'running') s.state = 'failed';
    state.took_ms = Date.now() - t0;
    state.finished_at = nowIso();
    put('failed');
    try {
      logEvent(db, { task_id: taskId, kind: 'note', detail: `分析沒有完成：${state.error}` });
    } catch {
      /* the DB is gone */
    }
  }
}

/** The revision to search: the working tree when the branch is checked out, else the branch / origin branch. */
function revFor(repo: Repo, branch: string, git: GitExec): string | undefined {
  try {
    const cur = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo.local_path).trim();
    if (!branch || cur === branch) return undefined;
  } catch {
    return undefined;
  }
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    try {
      git(['rev-parse', '--verify', '--quiet', ref], repo.local_path);
      return ref.startsWith('refs/heads/') ? branch : `origin/${branch}`;
    } catch {
      /* next */
    }
  }
  return undefined;
}

/**
 * A card edit (causes, repro, checks, kind, branch, title): re-select the checks, recompose the
 * PRD and re-apply the task fields without asking any model. The card becomes ready.
 */
export async function renderTicket(db: Database.Database, taskId: string, deps: AnalyseDeps = {}): Promise<Task> {
  const task = getTask(db, taskId);
  if (!task || !task.intake_json) throw new Error(`not a ticket: ${taskId}`);
  const intake = readIntake(task)!;
  const state = readAnalysis(task) ?? freshAnalysis();
  state.kind = intake.kind_hint ?? state.kind ?? 'bugfix';
  const mark: Mark = (key, st, detail) => {
    if (key !== 'checks' && key !== 'review') return;
    const s = state.steps.find((x) => x.key === key)!;
    if (st === 'running') return;
    s.state = st;
    if (detail !== undefined) s.detail = detail;
  };
  try {
    await planTicket(db, taskId, state, deps, { review: false, mark });
  } catch (err) {
    if (err instanceof Cancelled) return getTask(db, taskId) ?? task;
    throw err;
  }
  state.error = null;
  save(db, taskId, state, 'ready');
  return getTask(db, taskId)!;
}
