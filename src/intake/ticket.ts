import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { paths } from '../config.js';
import { getSetting, logEvent } from '../db/index.js';
import { createTask, deleteTask, getTask, getTaskBySourceRef } from '../tasks.js';
import type { Task } from '../types.js';
import { validateTask, type GateResult } from '../gate/validateTask.js';
import { environmentMap } from '../deploy/store.js';
import { queueTask, TaskActionError } from '../taskActions.js';
import { pruneTaskArtifacts, resolveInside } from '../git/worktree.js';
import { validBranch } from '../git/refs.js';
import { giteaClientFor, parseGiteaUrl, parseRemoteUrl, type GiteaAsset, type GiteaClient } from '../git/gitea.js';
import { getRepo, listRepos, type Repo } from '../repo/store.js';
import { isModelValue, LOCAL_MODEL_RE } from '../settings.js';
import { getLocalModel, isLocalModel, localId } from '../local/models.js';
import { cloudAllowed } from '../local/backend.js';
import { notify } from '../notify.js';
import { linkIssue, reportIssue } from '../integrations/giteaIssues.js';
import { readTaskImages } from './context.js';
import { approvalMode, isManager, type ApprovalMode } from './roles.js';
import {
  analysisInFlight,
  cleanRepoPath,
  effectiveStatus,
  freshAnalysis,
  readAnalysis,
  readIntake,
  STALE_ERROR,
  TICKET_KINDS,
  ticketConditions,
  type AnalysisState,
  type AnalysisStatus,
  type Cause,
  type Repro,
  type TicketAnalysis,
  type TicketIntake,
  type TicketKind,
} from './analyse.js';

/**
 * 問題單: a draft task that carries what the person described (intake_json), their screenshots
 * (images_json, files under <dataDir>/task-images/<task>/) and, once analysed, the 分析卡
 * (analysis_json, see analyse.ts). Creating one never starts anything; 開始修 queues it through the
 * usual gate (validateTask), or — approval_mode=manager — sends it to a manager first. The shapes
 * the page reads (TicketView / TicketSummary) are the contract in ticket-api.md.
 */

export class TicketError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** who is acting (server/identity.ts ChatIdentity fits) */
export interface TicketActor {
  user_key: string;
  label: string;
}

export interface TicketImageView {
  n: number;
  name: string;
  mime: string;
  text: string;
  via: 'model' | 'ocr' | 'none';
  note?: string;
}

export interface TicketView {
  id: string;
  title: string;
  status: string;
  priority: number;
  model: string | null;
  created_by: string | null;
  owner: string | null;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
  repo: { id: string; name: string; remote_url: string; default_branch: string; machine: string | null } | null;
  /** tasks.base_branch */
  branch: string | null;
  description: string;
  issue: { number: number; url: string } | null;
  images: TicketImageView[];
  kind: TicketKind | null;
  analysis_status: AnalysisStatus | null;
  analysis: TicketAnalysis | null;
  approval_mode: ApprovalMode;
  approval_state: 'awaiting' | 'approved' | 'rejected' | null;
  start_approved_by: string | null;
  /** the caller is a manager and the ticket awaits their 核可 */
  can_approve: boolean;
  /** the caller may start without approval (the page says 開始修, not 送出核可) */
  is_manager: boolean;
}

export interface TicketSummary {
  id: string;
  title: string;
  status: string;
  analysis_status: AnalysisStatus | null;
  approval_state: string | null;
  repo_name: string | null;
  created_at: string;
  updated_at: string;
}

const DESC_MIN = 10;
const DESC_MAX = 20_000;
const TITLE_MAX = 120;
const AUTO_TITLE_MAX = 60;
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/=]+)$/;

const oneLine = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim();

// ---- validation --------------------------------------------------------------------------------

export function validDescription(v: unknown): string {
  if (typeof v !== 'string') throw new TicketError('描述要是文字');
  const d = v.replace(/\r\n?/g, '\n').trim();
  if (d.length < DESC_MIN) throw new TicketError(`描述至少 ${DESC_MIN} 個字：發生什麼事、在哪裡、期望應該怎樣`);
  if (d.length > DESC_MAX) throw new TicketError(`描述太長（最多 ${DESC_MAX} 字）`);
  return d;
}

/** The title the person typed, or null (Loop names it). */
function titleOf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new TicketError('標題要是文字');
  const t = oneLine(v);
  if (t.length > TITLE_MAX) throw new TicketError(`標題太長（最多 ${TITLE_MAX} 字）`);
  return t || null;
}

/** The first line of the description, as a title (≤ 60 characters). */
export function titleFrom(description: string): string {
  const first = description
    .split('\n')
    .map((l) => l.replace(/^\s*(?:#+|[-*>]|\d+[.)])\s*/, '').trim())
    .find(Boolean);
  return (first ?? '問題單').replace(/\s+/g, ' ').slice(0, AUTO_TITLE_MAX);
}

function kindOf(v: unknown): TicketKind | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string' && (TICKET_KINDS as readonly string[]).includes(v)) return v as TicketKind;
  throw new TicketError(`類型只能是：${TICKET_KINDS.join('、')}`);
}

function priorityOf(v: unknown): number {
  if (v === null || v === undefined || v === '') return 2;
  const n = Number(v);
  if (n === 1 || n === 2 || n === 3) return n;
  throw new TicketError('優先只能是 1（低）、2（中）或 3（高）');
}

function branchOf(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string' || !validBranch(v.trim())) throw new TicketError(`「${String(v)}」不是可以用的分支名稱`);
  return v.trim();
}

/** '' / null = let Loop pick; local:<id> must be registered; a cloud alias only when cloud models are allowed. */
function modelOf(db: Database.Database, v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new TicketError('模型要是文字');
  const m = v.trim();
  if (!m || m === 'default') return null;
  if (isLocalModel(m)) {
    if (!LOCAL_MODEL_RE.test(m) || !getLocalModel(db, localId(m))) throw new TicketError(`沒有這個本地模型：${m}`);
    return m;
  }
  if (!isModelValue(m)) throw new TicketError(`不認得這個模型：${m}`);
  if (!cloudAllowed(db)) throw new TicketError('公司模式只能用本地模型（cloud_llm_allowed=false）');
  return m;
}

function repoOf(db: Database.Database, v: unknown): Repo {
  if (typeof v !== 'string' || !v.trim()) throw new TicketError('要選一個 repo');
  const repo = getRepo(db, v.trim());
  if (!repo) throw new TicketError(`沒有這個 repo：${v}`);
  if (!repo.enabled) throw new TicketError(`repo ${repo.name} 已停用`);
  return repo;
}

// ---- screenshots -------------------------------------------------------------------------------

export interface DecodedImage {
  bytes: Buffer;
  mime: string;
  ext: string;
  name: string;
}

const cleanName = (v: unknown): string =>
  typeof v === 'string'
    ? path
        .basename(v.replace(/\\/g, '/'))
        .replace(/[\u0000-\u001f]/g, '')
        .trim()
        .slice(0, 100)
    : '';

/** Pasted screenshots: data:image/(png|jpeg|webp|gif);base64 URLs (or {data_url, name}), ≤ 6, ≤ 4 MB each. */
export function decodeTicketImages(v: unknown): DecodedImage[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw new TicketError('images 要是 data:image 網址的陣列');
  if (v.length > MAX_IMAGES) throw new TicketError(`截圖最多 ${MAX_IMAGES} 張`);
  return v.map((item, i) => {
    const o = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
    const url = typeof item === 'string' ? item : String(o?.data_url ?? o?.url ?? '');
    const b64Len = url.length - url.indexOf(',') - 1;
    if (b64Len > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4) throw new TicketError(`第 ${i + 1} 張截圖超過 4 MB`);
    const m = IMAGE_DATA_URL.exec(url.trim());
    if (!m) throw new TicketError(`第 ${i + 1} 張截圖不是 PNG／JPEG／WebP／GIF 的 data:image 網址`);
    const kind = m[1]!;
    const bytes = Buffer.from(m[2]!, 'base64');
    if (!bytes.length) throw new TicketError(`第 ${i + 1} 張截圖是空的`);
    if (bytes.length > MAX_IMAGE_BYTES) throw new TicketError(`第 ${i + 1} 張截圖超過 4 MB`);
    const ext = kind === 'jpeg' ? 'jpg' : kind;
    return { bytes, mime: `image/${kind}`, ext, name: cleanName(o?.name) || `截圖 ${i + 1}.${ext}` };
  });
}

export function taskImagesDir(taskId: string): string {
  return path.join(paths.taskImagesDir, taskId.replace(/[^\w-]+/g, '_'));
}

/** Writes the screenshots as <taskImagesDir>/<task>/<n>.<ext>; returns the images_json entries. */
export function writeTaskImages(taskId: string, images: DecodedImage[]): Array<{ file: string; name: string; mime: string; bytes: number }> {
  const dir = taskImagesDir(taskId);
  fs.mkdirSync(dir, { recursive: true });
  return images.map((im, n) => {
    const file = path.join(dir, `${n}.${im.ext}`);
    fs.writeFileSync(file, im.bytes);
    return { file, name: im.name, mime: im.mime, bytes: im.bytes.length };
  });
}

export function removeTaskImages(taskId: string): void {
  const dir = resolveInside(paths.taskImagesDir, taskImagesDir(taskId));
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

/** The stored file of screenshot n, only when it is inside the task's own image folder. */
export function ticketImageFile(task: Task, n: number): { file: string; mime: string; name: string } | null {
  const im = readTaskImages(task)[n];
  if (!Number.isInteger(n) || n < 0 || !im) return null;
  const file = resolveInside(taskImagesDir(task.id), im.file);
  if (!file || !fs.existsSync(file)) return null;
  return { file, mime: im.mime ?? 'application/octet-stream', name: im.name ?? path.basename(file) };
}

// ---- create ------------------------------------------------------------------------------------

export interface NewTicketInput {
  title?: unknown;
  description: unknown;
  repo_id: unknown;
  /** false = 先存草稿: save it as typed, no analysis yet */
  analyse?: boolean;
  branch?: unknown;
  priority?: unknown;
  model?: unknown;
  kind?: unknown;
  /** data:image URLs, or {data_url, name} */
  images?: unknown;
  from?: TicketIntake['from'];
  conversation_id?: string | null;
  message_id?: string | null;
  issue?: TicketIntake['issue'];
  source_ref?: string | null;
}

/**
 * A new 問題單: a draft task (goal = the description, repo / branch / domain from the repo row)
 * with intake_json, its screenshots on disk, and an analysis waiting to run (the caller starts it
 * with analyseTicket). Validation errors are TicketError(400); nothing is written for them.
 */
export function createTicket(db: Database.Database, input: NewTicketInput, who: TicketActor): Task {
  const description = validDescription(input.description);
  const repo = repoOf(db, input.repo_id);
  const branch = branchOf(input.branch) ?? repo.default_branch;
  const priority = priorityOf(input.priority);
  const model = modelOf(db, input.model);
  const kind = kindOf(input.kind);
  const title = titleOf(input.title);
  const images = decodeTicketImages(input.images);
  const intake: TicketIntake = {
    description,
    kind_hint: kind,
    issue: input.issue ?? null,
    from: input.from ?? 'ui',
    conversation_id: input.conversation_id ?? null,
    message_id: input.message_id ?? null,
    title,
    created_label: who.label,
  };
  const task = db.transaction(() => {
    const t = createTask(db, {
      title: title ?? titleFrom(description),
      goal: description,
      repo_path: repo.local_path,
      base_branch: branch,
      priority,
      model,
      coding_tool: 'claude-code',
      owner: who.user_key,
      created_by: who.user_key,
      source_ref: input.source_ref ?? null,
      domain: repo.domain,
    });
    // a draft saved with 先存草稿 (analyse: false) has no analysis until 請 Loop 分析
    const analyse = input.analyse !== false;
    db.prepare('UPDATE tasks SET repo_id = ?, intake_json = ?, analysis_status = ?, analysis_json = ? WHERE id = ?').run(
      repo.id,
      JSON.stringify(intake),
      analyse ? 'pending' : null,
      analyse ? JSON.stringify(freshAnalysis()) : null,
      t.id,
    );
    return t;
  })();
  if (images.length) {
    try {
      db.prepare('UPDATE tasks SET images_json = ? WHERE id = ?').run(JSON.stringify(writeTaskImages(task.id, images)), task.id);
    } catch (err) {
      removeTaskImages(task.id);
      deleteTask(db, task.id);
      throw new TicketError(`截圖存不下來：${String((err as Error)?.message ?? err).slice(0, 200)}`, 500);
    }
  }
  if (intake.issue) linkIssue(db, task.id, { repoId: repo.id, owner: intake.issue.owner, repo: intake.issue.repo, number: intake.issue.number, url: intake.issue.url });
  logEvent(db, { task_id: task.id, kind: 'note', detail: `問題單：${who.label} 開單（${intake.from === 'issue' ? 'Gitea issue' : intake.from === 'chat' ? '對話' : '問題單頁'}）` });
  return getTask(db, task.id)!;
}

// ---- views -------------------------------------------------------------------------------------

export function isTicket(task: Pick<Task, 'intake_json'> | undefined | null): boolean {
  return Boolean(task?.intake_json);
}

function needTicket(db: Database.Database, id: string): Task {
  const t = getTask(db, id);
  if (!t || !t.intake_json) throw new TicketError('找不到這張問題單', 404);
  return t;
}

/** The questions the card shows: a manager's 退回 first (while rejected), then the analysis'. */
function viewQuestions(task: Task, state: AnalysisState): string[] {
  const rej = task.approval_state === 'rejected' && state.rejection ? [`主管退回（${state.rejection.by}）：${state.rejection.reason}`] : [];
  return [...rej, ...state.questions];
}

export function ticketView(db: Database.Database, task: Task, who?: TicketActor | null): TicketView {
  const intake = readIntake(task) ?? { description: task.goal, kind_hint: null, from: 'ui' as const };
  const repo = task.repo_id ? getRepo(db, task.repo_id) : null;
  const state = readAnalysis(task);
  const eff = effectiveStatus(task, state);
  const approval = task.approval_state === 'awaiting' || task.approval_state === 'approved' || task.approval_state === 'rejected' ? task.approval_state : null;
  let analysis: TicketAnalysis | null = null;
  if (state) {
    analysis = {
      steps: state.steps.map((s) => (eff.stale && s.state === 'running' ? { ...s, state: 'failed' as const } : s)),
      causes: state.causes,
      repro: state.repro,
      checks: state.checks.map((c) => ({ ...c, on: c.required ? true : !state.checks_off.includes(c.id) })),
      conditions: ticketConditions(db, task, state, repo),
      questions: viewQuestions(task, state),
      error: eff.stale ? STALE_ERROR : state.error,
      model_used: state.model_used,
      took_ms: state.took_ms,
    };
  }
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    model: task.model,
    created_by: task.created_by,
    owner: task.owner,
    source_ref: task.source_ref,
    created_at: task.created_at,
    updated_at: task.updated_at,
    repo: repo ? { id: repo.id, name: repo.name, remote_url: repo.remote_url, default_branch: repo.default_branch, machine: repo.machine } : null,
    branch: task.base_branch,
    description: intake.description,
    issue: intake.issue ? { number: intake.issue.number, url: intake.issue.url } : null,
    images: readTaskImages(task).map((im, n) => {
      const via = im.via === 'model' || im.via === 'ocr' ? im.via : 'none';
      const note = (im as { note?: unknown }).note;
      return { n, name: im.name ?? `截圖 ${n + 1}`, mime: im.mime ?? 'image/png', text: im.text ?? '', via, ...(typeof note === 'string' && note ? { note } : {}) };
    }),
    kind: state?.kind ?? intake.kind_hint ?? null,
    analysis_status: eff.status,
    analysis,
    approval_mode: approvalMode(db),
    approval_state: approval,
    start_approved_by: task.start_approved_by ?? null,
    can_approve: Boolean(who && task.status === 'draft' && approval === 'awaiting' && isManager(db, who.user_key)),
    is_manager: Boolean(who && isManager(db, who.user_key)),
  };
}

export function ticketSummary(db: Database.Database, task: Task, repoName?: string | null): TicketSummary {
  const state = readAnalysis(task);
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    analysis_status: effectiveStatus(task, state).status,
    approval_state: task.approval_state ?? null,
    repo_name: repoName !== undefined ? repoName : task.repo_id ? (getRepo(db, task.repo_id)?.name ?? null) : null,
    created_at: task.created_at,
    updated_at: task.updated_at,
  };
}

/** Tickets, newest first; `mine` = only those this user key opened. */
export function listTickets(db: Database.Database, o: { mine?: string | null; limit?: number } = {}): TicketSummary[] {
  const limit = Math.min(100, Math.max(1, Math.floor(o.limit ?? 20)));
  const rows = db
    .prepare(
      `SELECT t.*, r.name AS repo_name FROM tasks t LEFT JOIN repos r ON r.id = t.repo_id
        WHERE t.intake_json IS NOT NULL ${o.mine ? 'AND t.created_by = @mine' : ''}
        ORDER BY t.created_at DESC, t.rowid DESC LIMIT @limit`,
    )
    .all({ ...(o.mine ? { mine: o.mine } : {}), limit }) as Array<Task & { repo_name: string | null }>;
  return rows.map((r) => ticketSummary(db, r, r.repo_name));
}

export function getTicket(db: Database.Database, id: string): Task {
  return needTicket(db, id);
}

// ---- start / approve / reject / withdraw / cancel ---------------------------------------------

function gateOf(db: Database.Database, t: Task): GateResult {
  return validateTask(t, getSetting(db, 'host_capabilities') ?? '', environmentMap(db));
}

const GATE_TEXT: Array<[RegExp, string]> = [
  [/^plan_ref/, '還沒有需求文件（分析沒有完成）'],
  [/^verification_steps \(>= 1/, '沒有可以自動跑的驗證（建置／測試／重現指令）'],
  [/^repo_path/, 'repo 的本機複本不見了'],
  [/^base_branch/, '分支不存在'],
];
const gateReasons = (g: GateResult): string[] => g.missing.map((m) => GATE_TEXT.find(([re]) => re.test(m))?.[1] ?? m);

function needStartable(db: Database.Database, t: Task): void {
  if (t.status !== 'draft') throw new TicketError(`這張單已經開始了（${t.status}）`, 409, { status: t.status });
  if (analysisInFlight(t.id)) throw new TicketError('分析還在進行，等它完成再開始', 409);
  const st = effectiveStatus(t, readAnalysis(t)).status;
  if (st !== 'ready') throw new TicketError(st === 'failed' ? '分析沒有完成：請先按「重試」，或改一下分析卡' : '分析還沒完成', 409, { analysis_status: st });
}

/** queueTask through the gate; a gate refusal becomes a TicketError(409) with the reasons. */
function queueThroughGate(db: Database.Database, id: string): void {
  try {
    queueTask(db, id);
  } catch (err) {
    if (err instanceof TaskActionError) {
      const gate = (err.extra as { gate?: GateResult }).gate;
      if (gate) throw new TicketError(`還不能開始：${gateReasons(gate).join('；')}`, 409, { gate, missing: gateReasons(gate) });
      throw new TicketError(err.message, err.status, err.extra);
    }
    throw err;
  }
}

/**
 * 開始修. approval_mode self, or the caller is a manager: queue it (the gate must pass). Manager
 * mode and not a manager: send it for approval (approval_state 'awaiting'); the gate is checked
 * first so a manager never approves something that cannot run.
 */
export function startTicket(db: Database.Database, taskId: string, who: TicketActor): Task {
  const t = needTicket(db, taskId);
  needStartable(db, t);
  const mode = approvalMode(db);
  const manager = isManager(db, who.user_key);
  if (mode === 'manager' && !manager) {
    if (t.approval_state === 'awaiting') return t;
    const gate = gateOf(db, t);
    if (!gate.ok) throw new TicketError(`還不能送出核可：${gateReasons(gate).join('；')}`, 409, { gate, missing: gateReasons(gate) });
    const intake = readIntake(t)!;
    intake.start_requested_by = { key: who.user_key, label: who.label, at: new Date().toISOString() };
    const state = readAnalysis(t);
    if (state) state.rejection = null;
    db.prepare(
      "UPDATE tasks SET approval_state = 'awaiting', start_approved_by = NULL, start_approved_at = NULL, intake_json = ?, analysis_json = COALESCE(?, analysis_json), updated_at = datetime('now') WHERE id = ?",
    ).run(JSON.stringify(intake), state ? JSON.stringify(state) : null, taskId);
    logEvent(db, { task_id: taskId, kind: 'note', detail: `送出核可：${who.label}` });
    void notify(db, { title: `待核可：${t.title}`, message: `${who.label} 想請 Loop 修這個；看分析卡再核可`, tags: ['hourglass'] }).catch(() => undefined);
    return getTask(db, taskId)!;
  }
  queueThroughGate(db, taskId);
  if (mode === 'manager') {
    db.prepare("UPDATE tasks SET approval_state = 'approved', start_approved_by = ?, start_approved_at = datetime('now') WHERE id = ?").run(who.label, taskId);
  } else if (t.approval_state) {
    // left over from manager mode: in self mode nobody approves
    db.prepare('UPDATE tasks SET approval_state = NULL WHERE id = ?').run(taskId);
  }
  logEvent(db, { task_id: taskId, kind: 'note', detail: `開始修：${who.label}` });
  reportIssue(db, taskId, 'started');
  return getTask(db, taskId)!;
}

function needManager(db: Database.Database, who: TicketActor): void {
  if (!isManager(db, who.user_key)) throw new TicketError('只有主管可以核可或退回（manager_users）', 403);
}

/** A manager's 核可: queue it and record who started it (start_approved_by/at). */
export function approveStart(db: Database.Database, taskId: string, who: TicketActor): Task {
  needManager(db, who);
  const t = needTicket(db, taskId);
  if (t.approval_state !== 'awaiting') throw new TicketError('這張單沒有在等核可', 409, { approval_state: t.approval_state ?? null });
  needStartable(db, t);
  queueThroughGate(db, taskId);
  db.prepare("UPDATE tasks SET approval_state = 'approved', start_approved_by = ?, start_approved_at = datetime('now') WHERE id = ?").run(who.label, taskId);
  logEvent(db, { task_id: taskId, kind: 'note', detail: `開工核可：${who.label}` });
  reportIssue(db, taskId, 'started');
  return getTask(db, taskId)!;
}

/** A manager's 退回: the ticket stays a draft, the reason shows first among the card's questions. */
export function rejectStart(db: Database.Database, taskId: string, who: TicketActor, reason: unknown): Task {
  needManager(db, who);
  const t = needTicket(db, taskId);
  if (t.status !== 'draft' || t.approval_state !== 'awaiting') throw new TicketError('這張單沒有在等核可', 409, { approval_state: t.approval_state ?? null });
  const why = oneLine(typeof reason === 'string' ? reason : '').slice(0, 500) || '（沒有寫原因）';
  const state = readAnalysis(t) ?? freshAnalysis();
  state.rejection = { by: who.label, reason: why, at: new Date().toISOString() };
  db.prepare("UPDATE tasks SET approval_state = 'rejected', analysis_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(state), taskId);
  logEvent(db, { task_id: taskId, kind: 'note', detail: `開工退回：${who.label}：${why}` });
  return getTask(db, taskId)!;
}

/** 撤回: take back a request for approval (the ticket is ready again). */
export function withdrawStart(db: Database.Database, taskId: string, who: TicketActor): Task {
  const t = needTicket(db, taskId);
  if (t.status !== 'draft' || t.approval_state !== 'awaiting') throw new TicketError('這張單沒有在等核可', 409, { approval_state: t.approval_state ?? null });
  const intake = readIntake(t)!;
  intake.start_requested_by = null;
  db.prepare("UPDATE tasks SET approval_state = NULL, intake_json = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(intake), taskId);
  logEvent(db, { task_id: taskId, kind: 'note', detail: `撤回核可申請：${who.label}` });
  return getTask(db, taskId)!;
}

/** 取消: only before it started (draft, incl. awaiting / rejected); the task, its plan and screenshots go. */
export function cancelTicket(db: Database.Database, taskId: string, who: TicketActor): void {
  const t = needTicket(db, taskId);
  if (t.status !== 'draft') throw new TicketError(`這張單已經開始了（${t.status}），不能取消；請到總覽中止它`, 409, { status: t.status });
  pruneTaskArtifacts(db, t);
  removeTaskImages(t.id);
  deleteTask(db, t.id);
  logEvent(db, { kind: 'note', detail: `問題單取消：${t.id}「${t.title}」by ${who.label}` });
}

// ---- edits (改一下) -----------------------------------------------------------------------------

const CARD_KEYS = ['causes', 'repro', 'checks_off'];

function recentOf(repo: Repo | null, file: string): string[] {
  if (!repo) return [];
  try {
    return execFileSync('git', ['log', '-3', '--format=%h %s (%cr)', '--', file], { cwd: repo.local_path, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function causesOf(v: unknown, repo: Repo | null, prev: Cause[]): Cause[] {
  if (!Array.isArray(v)) throw new TicketError('causes 要是陣列');
  if (v.length > 6) throw new TicketError('可能原因最多 6 列');
  const out: Cause[] = [];
  v.forEach((raw, i) => {
    const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
    const file = cleanRepoPath(r?.file);
    if (!r || !file) throw new TicketError(`第 ${i + 1} 列的檔案路徑不對（要是 repo 裡的相對路徑）`);
    if (repo && !fs.existsSync(path.join(repo.local_path, file))) throw new TicketError(`repo 裡沒有這個檔案：${file}`);
    if (out.some((c) => c.file === file)) return;
    const old = prev.find((c) => c.file === file);
    const evidence = Array.isArray(r.evidence)
      ? r.evidence
          .filter((e): e is { line: unknown; text: unknown } => Boolean(e) && typeof e === 'object')
          .map((e) => ({ line: Math.max(0, Math.floor(Number(e.line) || 0)), text: oneLine(e.text).slice(0, 300) }))
          .filter((e) => e.line > 0)
          .slice(0, 5)
      : (old?.evidence ?? []);
    const recent = Array.isArray(r.recent) ? r.recent.filter((x): x is string => typeof x === 'string').map((x) => oneLine(x).slice(0, 200)).slice(0, 3) : (old?.recent ?? recentOf(repo, file));
    const symbol = typeof r.symbol === 'string' && oneLine(r.symbol) ? oneLine(r.symbol).slice(0, 80) : null;
    out.push({ file, symbol, why: oneLine(r.why).slice(0, 300), evidence, recent });
  });
  return out;
}

function reproOf(v: unknown, prev: Repro | null): Repro | null {
  if (v === null) return null;
  if (!v || typeof v !== 'object') throw new TicketError('repro 要是 {mode, command, test_file, description} 或 null');
  const r = v as Record<string, unknown>;
  const mode = r.mode === 'command' ? 'command' : r.mode === 'new_test' ? 'new_test' : null;
  if (!mode) throw new TicketError('重現方式只能是 command（現成指令）或 new_test（先寫會失敗的測試）');
  const command = typeof r.command === 'string' ? r.command.trim() : '';
  if (/[\r\n]/.test(command)) throw new TicketError('重現指令只能一行');
  if (command.length > 500) throw new TicketError('重現指令太長（最多 500 字）');
  if (mode === 'command' && !command) throw new TicketError('「有現成的重現指令」要填指令');
  const testFile = r.test_file === null || r.test_file === undefined || r.test_file === '' ? null : cleanRepoPath(r.test_file);
  if (r.test_file && !testFile) throw new TicketError('測試檔要是 repo 裡的相對路徑');
  const next: Repro = { mode, command: mode === 'command' ? command : null, test_file: testFile, description: oneLine(r.description).slice(0, 300), before: null };
  if (prev && prev.mode === next.mode && prev.command === next.command) next.before = prev.before;
  return next;
}

function checksOffOf(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 50 || v.some((x) => typeof x !== 'string' || !/^[\w:.-]{1,64}$/.test(x))) {
    throw new TicketError('checks_off 要是檢查 id 的陣列');
  }
  return [...new Set(v as string[])];
}

function answersOf(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 10 || v.some((x) => typeof x !== 'string' || x.length > 2000)) {
    throw new TicketError('answers 要是文字陣列（最多 10 則，每則 2000 字內）');
  }
  return v as string[];
}

/** Answers go into the description (paired with the question they answer), so the next analysis reads them. */
export function appendAnswers(description: string, answers: string[], questions: string[]): string {
  const lines = answers
    .map((a, i) => {
      const text = a.replace(/\r\n?/g, '\n').trim();
      if (!text) return '';
      return questions[i] ? `問：${questions[i]}\n答：${text}` : `補充：${text}`;
    })
    .filter(Boolean);
  return lines.length ? `${description.trimEnd()}\n\n（回答 Loop 的問題）\n${lines.join('\n')}` : description;
}

export interface TicketPatchResult {
  task: Task;
  /** what the caller runs next: a full re-analysis, a re-render of the task fields, or nothing */
  next: 'analyse' | 'render' | null;
}

/**
 * 改一下: title / description / kind / model / priority / branch, and on the card causes / repro /
 * checks_off / answers. A new description (or answers) means a new analysis; the other card edits
 * re-render the PRD and task fields. Only while the ticket is a draft; card edits wait for a
 * running analysis.
 */
export function patchTicket(db: Database.Database, taskId: string, body: Record<string, unknown>, who: TicketActor): TicketPatchResult {
  const t = needTicket(db, taskId);
  if (t.status !== 'draft') throw new TicketError(`這張單已經開始了（${t.status}），不能再改`, 409, { status: t.status });
  const busy = analysisInFlight(taskId);
  if (busy && CARD_KEYS.some((k) => k in body)) throw new TicketError('分析還在進行，等它完成再改分析卡', 409);
  const intake = readIntake(t)!;
  const state = readAnalysis(t) ?? freshAnalysis();
  const repo = t.repo_id ? getRepo(db, t.repo_id) : null;
  const cols: Record<string, unknown> = {};
  let next: TicketPatchResult['next'] = null;
  const want = (n: 'analyse' | 'render') => {
    if (next !== 'analyse') next = n;
  };
  const changed: string[] = [];

  if ('title' in body) {
    const title = titleOf(body.title);
    intake.title = title;
    if (title && title !== t.title) cols.title = title;
    changed.push('標題');
    want('render');
  }
  if ('description' in body) {
    const d = validDescription(body.description);
    if (d !== intake.description) {
      intake.description = d;
      changed.push('描述');
      want('analyse');
    }
  }
  if ('answers' in body) {
    const answers = answersOf(body.answers);
    const d = appendAnswers(intake.description, answers, viewQuestions(t, state));
    if (d !== intake.description) {
      if (d.length > DESC_MAX) throw new TicketError(`描述加上回答太長了（最多 ${DESC_MAX} 字）`);
      intake.description = d;
      changed.push('回答');
      want('analyse');
    }
  }
  if (intake.description !== t.goal) cols.goal = intake.description;
  if ('kind' in body) {
    const k = kindOf(body.kind);
    intake.kind_hint = k;
    if (k) state.kind = k;
    changed.push('類型');
    want('render');
  }
  if ('model' in body) {
    cols.model = modelOf(db, body.model);
    changed.push('模型');
  }
  if ('priority' in body) {
    cols.priority = priorityOf(body.priority);
    changed.push('優先');
  }
  if ('branch' in body) {
    cols.base_branch = branchOf(body.branch) ?? repo?.default_branch ?? t.base_branch;
    changed.push('分支');
    want('render');
  }
  if ('causes' in body) {
    state.causes = causesOf(body.causes, repo, state.causes);
    changed.push('可能原因');
    want('render');
  }
  if ('repro' in body) {
    state.repro = reproOf(body.repro, state.repro);
    state.repro_by = state.repro ? 'person' : null;
    changed.push('重現方式');
    want('render');
  }
  if ('checks_off' in body) {
    state.checks_off = checksOffOf(body.checks_off);
    changed.push('驗收清單');
    want('render');
  }
  // a running analysis owns analysis_json: what it has not read yet it gets on a re-run
  if (busy && next === 'render') next = 'analyse';

  const sets = ['intake_json = @intake', "updated_at = datetime('now')", ...Object.keys(cols).map((k) => `${k} = @${k}`)];
  if (!busy) sets.push('analysis_json = @analysis');
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = @id AND status = 'draft'`).run({ ...cols, intake: JSON.stringify(intake), analysis: JSON.stringify(state), id: taskId });
  if (changed.length) logEvent(db, { task_id: taskId, kind: 'note', detail: `問題單修改（${changed.join('、')}）：${who.label}` });
  return { task: getTask(db, taskId)!, next };
}

// ---- Gitea: pasted links and issues ------------------------------------------------------------

export interface ResolvedLink {
  kind: 'repo' | 'issue' | 'pr' | null;
  remote_url: string | null;
  owner: string | null;
  repo_name: string | null;
  /** the imported repo it points at (null = not imported yet) */
  repo: { id: string; name: string } | null;
  issue: { number: number; title: string; body: string; html_url: string; images: { name: string; data_url: string }[] } | null;
  error?: string;
}

export interface GiteaDeps {
  fetchImpl?: typeof fetch;
  /** a ready client (tests); default: giteaClientFor(db) with fetchImpl */
  client?: GiteaClient | null;
}

const eq = (a: string | null | undefined, b: string | null | undefined): boolean => Boolean(a && b && a.toLowerCase() === b.toLowerCase());

/** The imported repo for owner/repo (the Gitea columns, else its remote URL). */
export function importedRepoFor(db: Database.Database, owner: string, name: string, host?: string | null): Repo | null {
  for (const r of listRepos(db)) {
    if (eq(r.gitea_owner, owner) && eq(r.gitea_repo, name)) return r;
    const rem = parseRemoteUrl(r.remote_url);
    if (rem && eq(rem.owner, owner) && eq(rem.repo, name) && (!host || eq(rem.host, host))) return r;
  }
  return null;
}

/** `https://host/owner/repo(.git)` (exactly two path segments) or an ssh / scp clone URL. */
function genericRepoUrl(url: string): { host: string; owner: string; repo: string } | null {
  if (/^https?:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      const parts = u.pathname.split('/').filter(Boolean);
      if (parts.length !== 2) return null;
      const repo = parts[1]!.replace(/\.git$/, '');
      return repo ? { host: u.hostname.toLowerCase(), owner: parts[0]!, repo } : null;
    } catch {
      return null;
    }
  }
  return parseRemoteUrl(url);
}

function sniffImage(buf: Buffer): 'png' | 'jpeg' | 'gif' | 'webp' | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 6 && buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

/** The issue's picture attachments as data URLs (≤ 6, ≤ 4 MB each; anything else is skipped). */
export async function issueImages(client: GiteaClient, assets: GiteaAsset[]): Promise<{ name: string; data_url: string }[]> {
  const out: { name: string; data_url: string }[] = [];
  for (const a of assets.filter((x) => /\.(png|jpe?g|gif|webp)$/i.test(x.name))) {
    if (out.length >= MAX_IMAGES) break;
    if (a.size > MAX_IMAGE_BYTES) continue;
    const got = await client.downloadAsset(a);
    if (!got.ok || got.data.length > MAX_IMAGE_BYTES) continue;
    const kind = sniffImage(got.data);
    if (!kind) continue;
    out.push({ name: cleanName(a.name) || `附件 ${out.length + 1}`, data_url: `data:image/${kind};base64,${got.data.toString('base64')}` });
  }
  return out;
}

function clientFor(db: Database.Database, deps: GiteaDeps): GiteaClient | null {
  if (deps.client !== undefined) return deps.client;
  return giteaClientFor(db, deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {});
}

/** 貼上網址: what a pasted repo / issue / PR link is, whether its repo is imported, and the issue itself. */
export async function resolveTicketLink(db: Database.Database, raw: unknown, deps: GiteaDeps = {}): Promise<ResolvedLink> {
  const url = typeof raw === 'string' ? raw.trim().slice(0, 1000) : '';
  const none: ResolvedLink = { kind: null, remote_url: null, owner: null, repo_name: null, repo: null, issue: null };
  if (!url) return { ...none, error: '請貼上網址' };
  const giteaUrl = (getSetting(db, 'gitea_url') ?? '').trim().replace(/\/+$/, '');
  const ref = giteaUrl ? parseGiteaUrl(giteaUrl, url) : null;
  if (!ref) {
    const g = genericRepoUrl(url);
    if (!g) return { ...none, error: giteaUrl ? '不是這台 Gitea 的 repo、issue 或 PR 網址' : '看不懂這個網址（還沒設定 gitea_url，issue 連結沒辦法辨識）' };
    const repo = importedRepoFor(db, g.owner, g.repo, g.host);
    return { ...none, kind: 'repo', remote_url: url.replace(/\/+$/, ''), owner: g.owner, repo_name: g.repo, repo: repo ? { id: repo.id, name: repo.name } : null };
  }
  const repo = importedRepoFor(db, ref.owner, ref.repo);
  const out: ResolvedLink = {
    kind: ref.kind,
    remote_url: `${giteaUrl}/${ref.owner}/${ref.repo}.git`,
    owner: ref.owner,
    repo_name: ref.repo,
    repo: repo ? { id: repo.id, name: repo.name } : null,
    issue: null,
  };
  if (ref.kind !== 'issue' || !ref.number) return out;
  const client = clientFor(db, deps);
  if (!client) return { ...out, error: 'Gitea 沒有設定好（gitea_url 與 GITEA_TOKEN），讀不到 issue' };
  const got = await client.getIssue(ref.owner, ref.repo, ref.number);
  if (!got.ok) return { ...out, error: `讀不到 issue #${ref.number}：${got.error}` };
  const images = await issueImages(client, got.data.assets);
  return { ...out, issue: { number: got.data.number || ref.number, title: got.data.title, body: got.data.body, html_url: got.data.html_url, images } };
}

/** An issue URL on the Gitea server → its ref and the source_ref a ticket for it carries. */
export function issueRefFromUrl(db: Database.Database, url: string): { owner: string; repo: string; number: number; url: string; source_ref: string } | null {
  const giteaUrl = (getSetting(db, 'gitea_url') ?? '').trim().replace(/\/+$/, '');
  const ref = giteaUrl ? parseGiteaUrl(giteaUrl, url) : null;
  if (!ref || ref.kind !== 'issue' || !ref.number) return null;
  return { owner: ref.owner, repo: ref.repo, number: ref.number, url: url.trim(), source_ref: issueSourceRef(ref.owner, ref.repo, ref.number) };
}

export const issueSourceRef = (owner: string, repo: string, n: number): string => `gitea:${owner}/${repo}#${n}`;

/**
 * A Gitea issue → a 問題單 (idempotent: one ticket per issue, by source_ref). The repo must be
 * imported. The issue's title and body become the description, its picture attachments the
 * screenshots. The caller starts the analysis when `created`.
 */
export async function ticketFromIssue(
  db: Database.Database,
  ref: { owner: string; repo: string; number: number },
  who: TicketActor,
  deps: GiteaDeps = {},
): Promise<{ task: Task; created: boolean }> {
  const sourceRef = issueSourceRef(ref.owner, ref.repo, ref.number);
  const existing = getTaskBySourceRef(db, sourceRef);
  if (existing) return { task: existing, created: false };
  const repo = importedRepoFor(db, ref.owner, ref.repo);
  if (!repo) throw new TicketError(`${ref.owner}/${ref.repo} 還沒匯入 Loop：先匯入這個 repo`, 409, { code: 'repo_not_imported' });
  const client = clientFor(db, deps);
  if (!client) throw new TicketError('Gitea 沒有設定好（gitea_url 與 GITEA_TOKEN）', 400);
  const got = await client.getIssue(ref.owner, ref.repo, ref.number);
  if (!got.ok) throw new TicketError(`讀不到 issue #${ref.number}：${got.error}`, 502);
  const images = await issueImages(client, got.data.assets);
  // the poller and a person may race on the same issue: look again after the network calls
  const again = getTaskBySourceRef(db, sourceRef);
  if (again) return { task: again, created: false };
  const title = oneLine(got.data.title).slice(0, TITLE_MAX) || `issue #${ref.number}`;
  const body = got.data.body.replace(/\r\n?/g, '\n').trim();
  const description = `${title}\n\n${body || '（issue 沒有內文）'}`.slice(0, DESC_MAX);
  const task = createTicket(
    db,
    {
      title,
      description,
      repo_id: repo.id,
      images,
      from: 'issue',
      issue: { owner: ref.owner, repo: ref.repo, number: ref.number, url: got.data.html_url },
      source_ref: sourceRef,
    },
    who,
  );
  return { task, created: true };
}
