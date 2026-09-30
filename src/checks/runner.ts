import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { paths } from '../config.js';
import { getBool, getNum, getSetting, logEvent } from '../db/index.js';
import { parseSteps, type Task } from '../types.js';
import { resolveShell, runShell } from '../util/shell.js';
import { gitAsync } from '../git/async.js';
import { hasRemote, pushBranch } from '../git/integrate.js';
import { evaluateAcceptance, extractMetrics, globToRegExp } from '../orchestrator/acceptance.js';
import { parseCheckStep, type CheckStepRunner, type VerifyStepResult } from '../orchestrator/verify.js';
import { compareAnswers, metricsLine, parseAnswers, summarize, type ParsedAnswers } from './compare.js';
import { findOutput, listFiles, pulledPath, readAnswers } from './dataset.js';
import { parseCheckSnapshots, prefixedThresholds, snapshotCheck, targetsMachine, type CheckSnapshot, type DatasetSnapshot } from './render.js';
import { beginCheckRun, finishCheckRun, newCheckRunId, type CheckRunKind } from './runs.js';
import { getCheck } from './store.js';

export { parseCheckStep, type CheckStepRunner } from '../orchestrator/verify.js';

/**
 * Runs one `check:<id>` step (src/orchestrator/verify.ts) — or a 試跑 (src/checks/baseline.ts):
 * - engine host (machine null): the command in the worktree, like a plain verify step;
 * - a 機台: under that machine's lock, its clone of the repo is put at this HEAD, then the command;
 * - 圖資回歸: the dataset is cloned/updated where the command runs, {images} {answers} {out} filled
 *   in, {out} brought back under <dataDir>/check-runs/<run>/out and compared on the engine
 *   (compare.ts), which appends one LOOP_METRICS line — evaluateAcceptance judges it as before;
 * - 重現 with 修改前必須失敗 (verification only): the command on base with this change's test files
 *   carried over must FAIL, then on HEAD must PASS: 「修改前：✗ exit 1 · 修改後：✓ exit 0」.
 * Every execution is a check_runs row; the result's step is the check's NAME. Never throws.
 */

/** How the engine reaches a 機台 (bound by the integrator to src/exec/remote.ts; tests inject a fake). */
export interface MachineRunner {
  osOf(machine: string): 'linux' | 'windows';
  /** make the machine's clone of the repo sit at `sha` (it fetches from Gitea or the tree is copied); returns the clone dir on the machine */
  checkout(machine: string, req: { repoName: string; remoteUrl: string | null; sha: string; branch: string; localTree: string }): Promise<{ ok: boolean; out: string; dir: string }>;
  run(machine: string, req: { cwd: string; command: string; timeoutMs: number; env?: Record<string, string> }): Promise<{ ok: boolean; exitCode: number | null; timedOut: boolean; output: string; ms: number }>;
  /** clone/fetch a dataset repo on the machine; returns its dir */
  dataset(machine: string, ds: { name: string; remoteUrl: string }): Promise<{ ok: boolean; out: string; dir: string }>;
  pullBack(machine: string, remotePaths: string[], localDir: string): Promise<{ ok: boolean; out: string }>;
  lock<T>(machine: string, fn: () => Promise<T>): Promise<T>;
}

export interface ShellRun {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  ms: number;
}
export type CheckShell = (cmd: string, cwd: string, timeoutMs: number) => Promise<ShellRun>;
/** `git <args>` in `cwd`; resolves stdout, rejects on a non-zero exit (never prompts). */
export type CheckGit = (args: string[], cwd: string, timeoutMs?: number) => Promise<string>;

export interface CheckDeps {
  /** null/absent = not bound yet: a machine check fails with 「機台執行器尚未設定」 */
  machines?: MachineRunner | null;
  /** engine-host commands (default: runShell with the `shell` setting, like a plain verify step) */
  shell?: CheckShell;
  git?: CheckGit;
  now?: () => number;
}

/** CheckDeps with every default filled in (resolveCheckDeps). */
export interface ResolvedCheckDeps {
  machines: MachineRunner | null;
  shell: CheckShell;
  git: CheckGit;
  now: () => number;
}
type Deps = ResolvedCheckDeps;

/**
 * The machine runner production uses when the caller injects none. The integrator binds the real SSH
 * runner (src/exec/remote.ts over the `machines` table) here; until then machine checks fail with a
 * clear note and everything else runs.
 */
function defaultMachineRunner(_db: Database.Database): MachineRunner | null {
  return null;
}

export function resolveCheckDeps(db: Database.Database, deps: CheckDeps = {}): Deps {
  const now = deps.now ?? Date.now;
  return {
    machines: deps.machines !== undefined ? deps.machines : defaultMachineRunner(db),
    shell:
      deps.shell ??
      (async (cmd, cwd, timeoutMs) => {
        const t0 = Date.now();
        const r = await runShell(cmd, cwd, { timeoutMs, shell: resolveShell({ shellSetting: getSetting(db, 'shell') }) });
        return { ok: r.exitCode === 0, exitCode: r.exitCode, timedOut: r.timedOut, output: r.output, ms: Date.now() - t0 };
      }),
    git: deps.git ?? (async (args, cwd, timeoutMs) => (await gitAsync(cwd, args, { timeoutMs: timeoutMs ?? 60_000 })).stdout),
    now,
  };
}

/** What one execution is for; checkStepRunner and the 試跑 fill it in. */
export interface CheckExecution {
  cwd: string;
  /** used when the check has no timeout_min of its own */
  timeoutMs: number;
  kind: CheckRunKind;
  /** false = measure without writing check_runs (runVerifyGate with record: false) */
  record: boolean;
  taskId: string | null;
  runId: string | null;
  /** the base branch: the "before" of a 紅→綠 repro is HEAD's merge-base with it */
  base: string | null;
  /** the branch a machine fetches; null = the worktree's current branch */
  branch: string | null;
  /** 重現 with red_on_base runs 修改前／修改後 (verification); a 試跑 just runs the command */
  redGreen: boolean;
  /** a check_runs row created beforehand (a 試跑 returns its id before it starts) */
  crId?: string;
}

export interface CheckOutcome {
  result: VerifyStepResult;
  crId: string;
  /** what the check reported (namespaced like its thresholds) */
  values: Record<string, number | string>;
}

interface Outcome {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  baseSha?: string | null;
  result?: unknown;
  artifacts?: unknown;
}

interface RunLike {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
  ms: number;
}

const failed = (output: string): Outcome => ({ ok: false, exitCode: null, timedOut: false, output });
const passed = (r: Pick<RunLike, 'exitCode' | 'timedOut'>): boolean => r.exitCode === 0 && !r.timedOut;
const errText = (err: unknown): string => String((err as Error)?.message ?? err).trim();
const short = (sha: string | null | undefined): string => (sha ?? '').slice(0, 7);
const tail = (s: string, n: number): string => (s.length > n ? `…${s.slice(-n)}` : s).replace(/\s+$/, '');

/** Rewrite every LOOP_METRICS line of a check's output with its metric_prefix (the thresholds use the same names). */
export function prefixMetricLines(output: string, prefix: string): string {
  return output.replace(/^(\s*LOOP_METRICS\s+)(\{.*\})\s*$/gm, (line, lead: string, body: string) => {
    try {
      const obj = JSON.parse(body) as unknown;
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return line;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) out[k.startsWith(prefix) ? k : `${prefix}${k}`] = v;
      return `${lead}${JSON.stringify(out)}`;
    } catch {
      return line;
    }
  });
}

async function gitOut(d: Deps, args: string[], cwd: string, timeoutMs = 30_000): Promise<string | null> {
  try {
    return (await d.git(args, cwd, timeoutMs)).trim() || null;
  } catch {
    return null;
  }
}

function repoNameFor(db: Database.Database, repoId: string): string {
  let name: string | null = null;
  try {
    name = (db.prepare('SELECT name FROM repos WHERE id = ?').get(repoId) as { name: string } | undefined)?.name ?? null;
  } catch {
    name = null;
  }
  return (name ?? repoId ?? 'repo').replace(/[^\w.-]/g, '_') || 'repo';
}

/** One execution of one check. Never throws; records a check_runs row unless ex.record is false. */
export async function runCheck(db: Database.Database, snap: CheckSnapshot, ex: CheckExecution, deps: CheckDeps = {}): Promise<CheckOutcome> {
  const d = resolveCheckDeps(db, deps);
  const crId = ex.crId ?? newCheckRunId();
  const started = d.now();
  const head = await gitOut(d, ['rev-parse', 'HEAD'], ex.cwd);
  if (ex.record && !ex.crId) {
    beginCheckRun(db, { id: crId, check_id: snap.id, task_id: ex.taskId, run_id: ex.runId, kind: ex.kind, machine: snap.machine, head_sha: head });
  }
  const timeoutMs = snap.timeout_min ? snap.timeout_min * 60_000 : ex.timeoutMs;
  let out: Outcome;
  try {
    out = await execute(db, snap, ex, d, { crId, head, timeoutMs });
  } catch (err) {
    out = failed(`檢查執行失敗：${errText(err)}`);
  }
  let output = snap.metric_prefix ? prefixMetricLines(out.output, snap.metric_prefix) : out.output;
  if (output.length > 20_000) output = output.slice(-20_000);
  const values = extractMetrics([output]);
  const specs = prefixedThresholds(snap);
  const report = specs.length || Object.keys(values).length ? evaluateAcceptance(specs, values) : null;
  const ms = Math.max(0, d.now() - started);
  if (ex.record) {
    finishCheckRun(db, crId, {
      ok: out.ok,
      exit_code: out.exitCode,
      timed_out: out.timedOut,
      ms,
      output,
      metrics: report,
      result: out.result,
      artifacts: out.artifacts,
      head_sha: head,
      base_sha: out.baseSha ?? null,
    });
  }
  return { crId, values, result: { step: snap.name, ok: out.ok, exitCode: out.exitCode, timedOut: out.timedOut, output, ms } };
}

interface Ctx {
  crId: string;
  head: string | null;
  timeoutMs: number;
}

async function execute(db: Database.Database, snap: CheckSnapshot, ex: CheckExecution, d: Deps, ctx: Ctx): Promise<Outcome> {
  if (snap.kind === 'manual') return failed('人工檢查由人在驗收頁勾選，不會自動執行');
  if (!snap.command) return failed('這個檢查沒有指令');
  if (snap.machine?.startsWith('sandbox:')) return failed('這個檢查在 GPU 沙盒執行（sandbox 步驟），不能當成 check: 步驟跑');
  if (snap.kind === 'repro' && snap.red_on_base && ex.redGreen) return redGreen(db, snap, ex, d, ctx);
  if (snap.kind === 'dataset') return datasetRun(db, snap, ex, d, ctx);
  if (!snap.machine) {
    const r = await d.shell(snap.command, ex.cwd, ctx.timeoutMs);
    return { ok: passed(r), exitCode: r.exitCode, timedOut: r.timedOut, output: r.output };
  }
  return onMachine(snap.machine, d, async (m, machine) => {
    const co = await checkoutHead(db, m, machine, snap, ex, d, ctx);
    if (!co.ok) return failed(co.out);
    const r = await m.run(machine, { cwd: co.dir, command: snap.command!, timeoutMs: ctx.timeoutMs });
    return { ok: passed(r), exitCode: r.exitCode, timedOut: r.timedOut, output: `（在 ${machine}：${co.dir}）\n${r.output}` };
  });
}

async function onMachine(machine: string, d: Deps, fn: (m: MachineRunner, machine: string) => Promise<Outcome>): Promise<Outcome> {
  if (!d.machines) return failed(`機台執行器尚未設定：這個檢查要在機台 ${machine} 上跑，但引擎還沒有接上機台執行器。`);
  const m = d.machines;
  return m.lock(machine, () => fn(m, machine));
}

/** Put the machine's clone of the repo at this worktree's HEAD. */
async function checkoutHead(
  db: Database.Database,
  m: MachineRunner,
  machine: string,
  snap: CheckSnapshot,
  ex: CheckExecution,
  d: Deps,
  ctx: Ctx,
): Promise<{ ok: boolean; out: string; dir: string }> {
  if (!ctx.head) return { ok: false, out: '找不到要檢查的版本（這裡不是 git 工作目錄）', dir: '' };
  const remoteUrl = await gitOut(d, ['remote', 'get-url', 'origin'], ex.cwd);
  const branch = ex.branch ?? (await gitOut(d, ['symbolic-ref', '--short', '-q', 'HEAD'], ex.cwd)) ?? 'HEAD';
  const co = await m.checkout(machine, { repoName: repoNameFor(db, snap.repo_id), remoteUrl, sha: ctx.head, branch, localTree: ex.cwd });
  return co.ok ? co : { ...co, out: `機台 ${machine} 拿不到要檢查的程式（${short(ctx.head)}）：\n${co.out}` };
}

// ---- 圖資回歸 ------------------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();
/** One clone/update of a local dataset at a time (two checks of two tasks may want it together). */
function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  locks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/** Where the engine host keeps its clone of a dataset repo. */
export const localDatasetDir = (name: string): string => path.join(paths.dataDir, 'datasets', name);

async function ensureLocalDataset(ds: DatasetSnapshot, d: Deps): Promise<{ ok: boolean; dir: string; out: string }> {
  const dir = localDatasetDir(ds.name);
  return withKeyLock(`dataset:${ds.name}`, async () => {
    const notes: string[] = [];
    try {
      if (fs.existsSync(path.join(dir, '.git')) && (await gitOut(d, ['remote', 'get-url', 'origin'], dir)) !== ds.remote_url) {
        fs.rmSync(dir, { recursive: true, force: true }); // the 圖資 moved to another repo: start over
      }
      if (!fs.existsSync(path.join(dir, '.git'))) {
        fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        await d.git(['clone', '--depth', '1', ds.remote_url, dir], path.dirname(dir), 30 * 60_000);
      } else {
        try {
          await d.git(['pull', '--ff-only', '-q'], dir, 10 * 60_000);
        } catch (err) {
          notes.push(`圖資 ${ds.name} 更新失敗，用上次抓的版本：${errText(err)}`);
        }
      }
      let lfs = false;
      try {
        lfs = /filter=lfs/.test(fs.readFileSync(path.join(dir, '.gitattributes'), 'utf8'));
      } catch {
        lfs = false;
      }
      if (lfs) {
        try {
          await d.git(['lfs', 'pull'], dir, 30 * 60_000);
        } catch (err) {
          notes.push(`git lfs pull 失敗：${errText(err)}`);
        }
      }
      return { ok: true, dir, out: notes.join('\n') };
    } catch (err) {
      return { ok: false, dir, out: `抓不到圖資 ${ds.name}（${ds.remote_url}）：${errText(err)}` };
    }
  });
}

const fill = (cmd: string, v: { images: string; answers: string; out: string }): string =>
  cmd.replace(/\{(images|answers|out)\}/g, (_m, k: 'images' | 'answers' | 'out') => v[k]);
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

async function datasetRun(_db: Database.Database, snap: CheckSnapshot, ex: CheckExecution, d: Deps, ctx: Ctx): Promise<Outcome> {
  const ds = snap.dataset;
  if (!ds) return failed('這個圖資回歸沒有圖資（可能已被移除）：請到 Repo 的檢查重新選一個');
  const crDir = path.join(paths.checkRunsDir, ctx.crId);
  const localOut = path.join(crDir, 'out');
  fs.mkdirSync(localOut, { recursive: true });
  const notes: string[] = [];
  let ran: { r: RunLike; outRoot: string; answers: string; where: string };

  if (!snap.machine) {
    const got = await ensureLocalDataset(ds, d);
    if (!got.ok) return failed(got.out);
    if (got.out) notes.push(got.out);
    const answers = path.join(got.dir, ds.answer_file);
    const cmd = fill(snap.command!, { images: path.join(got.dir, ds.images_dir), answers, out: localOut });
    ran = { r: await d.shell(cmd, ex.cwd, ctx.timeoutMs), outRoot: localOut, answers, where: '' };
  } else {
    // assigned inside the machine lock (a cast, so the checker does not narrow it to null)
    let prepared = null as typeof ran | null;
    const early = await onMachine(snap.machine, d, async (m, machine) => {
      const co = await checkoutHead(_db, m, machine, snap, ex, d, ctx);
      if (!co.ok) return failed(co.out);
      const got = await m.dataset(machine, { name: ds.name, remoteUrl: ds.remote_url });
      if (!got.ok) return failed(`機台 ${machine} 準備圖資 ${ds.name} 失敗：\n${got.out}`);
      const win = m.osOf(machine) === 'windows';
      const J = win ? path.win32 : path.posix;
      const answersRemote = J.join(got.dir, ...ds.answer_file.split('/'));
      const outRemote = J.join(`${co.dir}-out`, ctx.crId);
      const mk = await m.run(machine, { cwd: co.dir, command: win ? `mkdir "${outRemote}"` : `mkdir -p ${shQuote(outRemote)}`, timeoutMs: 60_000 });
      if (!passed(mk)) return failed(`機台 ${machine} 建不了輸出資料夾 ${outRemote}：\n${mk.output}`);
      const cmd = fill(snap.command!, { images: J.join(got.dir, ...ds.images_dir.split('/')), answers: answersRemote, out: outRemote });
      const r = await m.run(machine, { cwd: co.dir, command: cmd, timeoutMs: ctx.timeoutMs });
      const where = `（在 ${machine}：${co.dir}）`;
      if (!passed(r)) return { ok: false, exitCode: r.exitCode, timedOut: r.timedOut, output: `${where}\n${r.output}` };
      const pb = await m.pullBack(machine, [outRemote], localOut);
      if (!pb.ok) notes.push(`從 ${machine} 收回輸出失敗：${pb.out}`);
      const localAnswers = path.join(crDir, 'answers');
      fs.mkdirSync(localAnswers, { recursive: true });
      const pa = await m.pullBack(machine, [answersRemote], localAnswers);
      if (!pa.ok) return failed(`${where}\n${r.output}\n從 ${machine} 收回答案檔失敗：${pa.out}`);
      prepared = { r, outRoot: pulledPath(localOut, ctx.crId), answers: pulledPath(localAnswers, path.posix.basename(ds.answer_file)), where };
      return { ok: true, exitCode: 0, timedOut: false, output: '' };
    });
    if (!prepared) return early;
    ran = prepared;
  }

  const { r } = ran;
  const head = ran.where ? `${ran.where}\n${r.output}` : r.output;
  if (!passed(r)) return { ok: false, exitCode: r.exitCode, timedOut: r.timedOut, output: [head, ...notes].join('\n') };
  let expected: ParsedAnswers;
  try {
    expected = readAnswers(ran.answers, ds.answer_format);
  } catch (err) {
    return { ok: false, exitCode: r.exitCode, timedOut: false, output: [head, ...notes, `讀不到圖資 ${ds.name} 的答案檔：${errText(err)}`].join('\n') };
  }
  const found = findOutput(ran.outRoot);
  let actual: ParsedAnswers | null = null;
  if (!found) notes.push('{out} 裡沒有找到結果檔（.json／.csv 或 .txt 標記）：每個案例都算沒有輸出');
  else {
    try {
      actual = parseAnswers(found.input);
    } catch (err) {
      notes.push(`輸出 ${found.source} 讀不懂：${errText(err)}`);
    }
  }
  if (expected.skipped) notes.push(`答案檔有 ${expected.skipped} 筆認不出案例或標籤，已略過`);
  if (actual?.skipped) notes.push(`輸出有 ${actual.skipped} 筆認不出案例或標籤，已略過`);
  const cmp = compareAnswers(expected, actual, { time_ms: r.ms });
  const output = [tail(head, 12_000), ...notes, summarize(cmp), metricsLine({ ...cmp.metrics })].filter(Boolean).join('\n');
  return {
    ok: true,
    exitCode: r.exitCode,
    timedOut: false,
    output,
    result: { dataset: ds.name, output: found?.source ?? null, metrics: cmp.metrics, cases: cmp.cases, extra: cmp.extra.slice(0, 200) },
    artifacts: { dir: crDir, files: listFiles(crDir) },
  };
}

// ---- 重現 紅→綠 -----------------------------------------------------------------------------------

/** The "before": HEAD's merge-base with the base branch (a task's recorded base when that is HEAD itself). */
async function baseShaFor(db: Database.Database, ex: CheckExecution, d: Deps, head: string | null): Promise<string | null> {
  if (!ex.base) return null;
  const ref = (await gitOut(d, ['rev-parse', '--verify', '--quiet', `origin/${ex.base}`], ex.cwd)) ? `origin/${ex.base}` : ex.base;
  let mb = await gitOut(d, ['merge-base', 'HEAD', ref], ex.cwd);
  if ((!mb || mb === head) && ex.runId) {
    // re-verifying work already in base: HEAD is its own merge-base; the run remembers the real before
    try {
      const rec = db.prepare('SELECT base_sha FROM task_runs WHERE id = ?').get(ex.runId) as { base_sha: string | null } | undefined;
      if (rec?.base_sha && rec.base_sha !== head) mb = rec.base_sha;
    } catch {
      /* keep mb */
    }
  }
  return mb;
}

/**
 * This change's test files, put onto the base tree: added or modified files matching test_globs (a
 * changed test must also fail before the change — that is what stops "fixing" the test), plus the
 * explicit test_files that exist at HEAD.
 */
async function carryTests(d: Deps, cwd: string, scratch: string, baseSha: string, head: string, snap: CheckSnapshot): Promise<string[]> {
  const res = snap.test_globs.map(globToRegExp);
  const files = new Set<string>();
  if (res.length) {
    const diff = await d.git(['diff', '--name-only', '-z', '--no-renames', '--diff-filter=AM', baseSha, head], cwd);
    for (const f of diff.split('\0').map((s) => s.trim()).filter(Boolean)) if (res.some((r) => r.test(f))) files.add(f);
  }
  for (const f of snap.test_files ?? []) {
    if (await gitOut(d, ['cat-file', '-t', `${head}:${f}`], cwd)) files.add(f);
  }
  const list = [...files];
  for (let i = 0; i < list.length; i += 100) await d.git(['checkout', head, '--', ...list.slice(i, i + 100)], scratch, 60_000);
  return list;
}

async function removeScratch(d: Deps, cwd: string, dir: string): Promise<void> {
  try {
    await d.git(['worktree', 'remove', '--force', dir], cwd, 60_000);
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    try {
      await d.git(['worktree', 'prune'], cwd, 30_000);
    } catch {
      /* a stale worktree entry is harmless; git prunes it later */
    }
  }
}

const mark = (r: RunLike): string => (passed(r) ? '✓ exit 0' : r.timedOut ? '✗ 逾時' : `✗ exit ${r.exitCode ?? '?'}`);

async function redGreen(db: Database.Database, snap: CheckSnapshot, ex: CheckExecution, d: Deps, ctx: Ctx): Promise<Outcome> {
  const head = ctx.head;
  if (!head) return failed('找不到要檢查的版本（這裡不是 git 工作目錄），無法做「修改前必須失敗」的檢查');
  const baseSha = await baseShaFor(db, ex, d, head);
  if (!baseSha) return failed(`找不到修改前的版本（和 ${ex.base ?? 'base'} 的分岔點），無法做「修改前必須失敗」的檢查`);
  if (baseSha === head) return failed('這裡沒有任何修改（HEAD 就是修改前的版本），重現證明不了什麼');
  fs.mkdirSync(paths.worktreesDir, { recursive: true });
  const scratch = path.join(paths.worktreesDir, `redgreen_${ex.taskId ?? snap.id}_${Date.now().toString(36)}`);
  try {
    await d.git(['worktree', 'add', '--detach', scratch, baseSha], ex.cwd, 120_000);
  } catch (err) {
    return { ...failed(`準備修改前的版本（${short(baseSha)}）失敗：${errText(err)}`), baseSha };
  }
  try {
    const carried = await carryTests(d, ex.cwd, scratch, baseSha, head, snap);
    let before: RunLike;
    let after: RunLike;
    if (!snap.machine) {
      before = await d.shell(snap.command!, scratch, ctx.timeoutMs);
      after = await d.shell(snap.command!, ex.cwd, ctx.timeoutMs);
    } else {
      let pair = null as { before: RunLike; after: RunLike } | null;
      const early = await onMachine(snap.machine, d, async (m, machine) => {
        // the "before" tree has this change's tests on it, which no remote has: always sent as files
        const baseCo = await m.checkout(machine, { repoName: `${repoNameFor(db, snap.repo_id)}-base`, remoteUrl: null, sha: baseSha, branch: ex.base ?? 'HEAD', localTree: scratch });
        if (!baseCo.ok) return failed(`機台 ${machine} 拿不到修改前的版本（${short(baseSha)}）：\n${baseCo.out}`);
        const b = await m.run(machine, { cwd: baseCo.dir, command: snap.command!, timeoutMs: ctx.timeoutMs });
        const co = await checkoutHead(db, m, machine, snap, ex, d, ctx);
        if (!co.ok) return failed(co.out);
        const a = await m.run(machine, { cwd: co.dir, command: snap.command!, timeoutMs: ctx.timeoutMs });
        pair = { before: b, after: a };
        return { ok: true, exitCode: 0, timedOut: false, output: '' };
      });
      if (!pair) return { ...early, baseSha };
      ({ before, after } = pair);
    }
    const red = !passed(before);
    const green = passed(after);
    const verdict = `修改前：${mark(before)} · 修改後：${mark(after)}`;
    const why = !red
      ? '修改前就通過了：這個重現在修改前的程式上也會過，證明不了修好了什麼（重現要在修改前失敗）'
      : !green
        ? '修改後還是沒通過'
        : '';
    const output = [
      `── 修改前（base ${short(baseSha)}${carried.length ? `，套上這次的測試檔：${carried.join('、')}` : ''}）──`,
      tail(before.output, 8_000),
      `── 修改後（HEAD ${short(head)}）──`,
      tail(after.output, 10_000),
      verdict,
      why,
    ]
      .filter(Boolean)
      .join('\n');
    const brief = (r: RunLike) => ({ exitCode: r.exitCode, timedOut: r.timedOut, ms: Math.round(r.ms), ok: passed(r) });
    return {
      ok: red && green,
      exitCode: red && green ? 0 : green ? null : after.exitCode,
      timedOut: after.timedOut,
      output,
      baseSha,
      result: { mode: 'red_green', before: brief(before), after: brief(after), carried },
    };
  } finally {
    await removeScratch(d, ex.cwd, scratch);
  }
}

// ---- verification seam -------------------------------------------------------------------------

export function hasCheckSteps(task: Pick<Task, 'verification_steps'>): boolean {
  return parseSteps(task).some((s) => parseCheckStep(s) !== null);
}

/**
 * The runner runVerification calls for `check:` steps of this task. A step resolves against the
 * task's frozen copy (checks_json), falling back to the live check. `record: null` measures without
 * writing check_runs; absent = recorded as a plain 'verify'.
 */
export function checkStepRunner(
  db: Database.Database,
  task: Task,
  deps: CheckDeps & { record?: { runId: string | null; kind: CheckRunKind } | null } = {},
): CheckStepRunner {
  const snaps = parseCheckSnapshots(task);
  const record = deps.record === undefined ? { runId: null, kind: 'verify' as CheckRunKind } : deps.record;
  return async (step, cwd, timeoutMs) => {
    try {
      const id = parseCheckStep(step);
      let snap = id ? (snaps.find((s) => s.id === id) ?? null) : null;
      if (!snap && id) {
        const live = getCheck(db, id);
        if (live) snap = snapshotCheck(db, live);
      }
      if (!snap) return { step, ok: false, exitCode: null, timedOut: false, output: `找不到檢查 ${id ?? step}（任務沒有它的副本，repo 裡也沒有這個檢查）` };
      // a check without its own timeout: the task's verify timeout when it set one, else check_timeout_min
      const fallbackMs = task.verify_timeout_min ? timeoutMs : getNum(db, 'check_timeout_min', 20) * 60_000;
      const out = await runCheck(
        db,
        snap,
        {
          cwd,
          timeoutMs: fallbackMs,
          kind: record?.kind ?? 'verify',
          record: record !== null,
          taskId: task.id,
          runId: record?.runId ?? null,
          base: task.base_branch,
          branch: null,
          redGreen: true,
        },
        deps,
      );
      return out.result;
    } catch (err) {
      return { step, ok: false, exitCode: null, timedOut: false, output: `檢查執行失敗：${errText(err)}` };
    }
  };
}

/**
 * The branch runVerifyGate pushes before verification when a check of this task runs on a 機台 (the
 * machine fetches it from origin); null when none does or the worktree is not on a branch.
 */
export function machineCheckBranch(task: Pick<Task, 'checks_json'>, worktree: string): string | null {
  if (!targetsMachine(parseCheckSnapshots(task))) return null;
  try {
    return execFileSync('git', ['-C', worktree, 'symbolic-ref', '--short', '-q', 'HEAD'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** Before verification: push the task branch when a check runs on a 機台 (auto_push_branch, origin only; never throws). */
export function pushForMachineChecks(db: Database.Database, task: Task, worktree: string, runId: string | null = null): void {
  const branch = machineCheckBranch(task, worktree);
  if (!branch || !getBool(db, 'auto_push_branch', true) || !hasRemote(worktree)) return;
  if (!pushBranch(worktree, branch)) {
    logEvent(db, { task_id: task.id, run_id: runId, kind: 'note', detail: `機台檢查前推送 ${branch} 失敗：機台可能拿不到這次的修改` });
  }
}
