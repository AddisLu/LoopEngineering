import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { getBool, getNum, logEvent } from '../db/index.js';
import { BENCH_DOMAINS } from '../benchmark/store.js';
import { gitAsync, redactUrl } from '../git/async.js';
import { giteaGitEnv, giteaHostOf, parseRemoteUrl } from '../git/gitea.js';
import { addToAllowlist, cloneProtocols, cloneRoot, removeFromAllowlist, repoNameOf, validateCloneUrl, withRepoLock, type CloneUrlOptions } from '../chatops/git.js';
import { detectSetup, detectVerify } from '../chatops/verify.js';
import { probeRepo, type RepoProbe } from '../prd/repo.js';
import { createSource, listSources } from '../knowledge/ingest/sources.js';
import { ingestOne } from '../knowledge/ingest/ingest.js';
import { createRepo, deleteRepo, getRepo, getRepoByPath, RepoError, updateRepo, validRepoName, type Repo, type RepoStack } from './store.js';

/**
 * 匯入 repo: a pasted clone URL becomes a registered repo — cloned under git_clone_root with
 * the Gitea token (never in argv), probed for its default branch, build / test / setup commands
 * and language stack, added to prd_repo_allowlist (so 工作流程 / 對話操作 can pick it) and, when
 * repo_auto_ingest is on, registered as a git knowledge source and ingested in the background.
 *
 * The import is an async job: `importRepo` validates synchronously (a bad URL / name / a path
 * already taken throws RepoError) and returns at once with the job; the route answers 202 and
 * the page polls `getImportJob`. `awaitImport` is for the CLI and tests.
 * The repo map (src/repo/map.ts) is built by its own link, not here.
 */

export interface ImportInput {
  url: string;
  /** folder + display name; default: from the URL */
  name?: string | null;
  /** who asked (identity label) */
  who?: string | null;
  /** BENCH_DOMAINS; default: from the detected stack */
  domain?: string | null;
}

export interface ImportDeps {
  /** tests: allow file:// clone URLs (never in production: a clone URL comes from a person) */
  allowFileUrls?: boolean;
  cloneRoot?: string;
  cloneTimeoutMs?: number;
  /** local git reads (remote, ls-files) */
  timeoutMs?: number;
  /** the knowledge ingest of the repo's git source (default ingestOne); runs in the background */
  ingest?: (db: Database.Database, sourceId: string) => Promise<unknown>;
  /** the Gitea host (default: from gitea_url) */
  giteaHost?: string | null;
}

export type ImportStatus = 'running' | 'done' | 'failed';

export interface ImportStep {
  label: string;
  /** null while running */
  ok: boolean | null;
  detail: string | null;
  at: string;
}

export interface ImportJob {
  id: string;
  url: string;
  name: string;
  dest: string;
  by: string | null;
  status: ImportStatus;
  steps: ImportStep[];
  repo_id: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/** What import / redetect learn from the clone (all of it lands on the row). */
export interface Detected {
  default_branch: string;
  build_cmd: string | null;
  test_cmd: string | null;
  setup_cmd: string | null;
  stack: RepoStack;
  domain: string;
}

const now = () => new Date().toISOString();
/** an event-log line from a background job: never throws (the DB may be gone by then) */
const note = (db: Database.Database, detail: string): void => {
  try {
    logEvent(db, { kind: 'note', detail });
  } catch {
    /* a closed DB or a full disk must not turn a finished job into an unhandled rejection */
  }
};
const JOB_TTL_MS = 60 * 60 * 1000;
const jobs = new Map<string, ImportJob>();
const running = new Map<string, Promise<void>>();
const ingesting = new Map<string, Promise<void>>();

function remember(job: ImportJob): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, j] of jobs) {
    if (j.status !== 'running' && j.finished_at && Date.parse(j.finished_at) < cutoff) jobs.delete(id);
  }
  jobs.set(job.id, job);
}

export function getImportJob(id: string): ImportJob | undefined {
  return jobs.get(id);
}

/** newest first */
export function listImportJobs(): ImportJob[] {
  return [...jobs.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
}

/** The job once it has finished (and, with `ingest`, once its background ingest has too). */
export async function awaitImport(id: string, o: { ingest?: boolean } = {}): Promise<ImportJob> {
  const job = jobs.get(id);
  if (!job) throw new RepoError('沒有這個匯入工作', 404);
  await running.get(id);
  if (o.ingest) await ingesting.get(id);
  return job;
}

const localTimeout = (db: Database.Database, d: ImportDeps) => d.timeoutMs ?? Math.max(10, getNum(db, 'ops_git_timeout_sec', 120)) * 1000;

/** the same remote written two ways (`.git`, a trailing slash, the host's case) */
function sameRemote(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/\/+$/, '').replace(/\.git$/, '').toLowerCase();
  const pa = parseRemoteUrl(a);
  const pb = parseRemoteUrl(b);
  if (pa && pb) return pa.host === pb.host && pa.owner === pb.owner && pa.repo === pb.repo;
  return norm(a) === norm(b);
}

/**
 * Start an import. Validates the URL (https / ssh; plain http only to the Gitea host; file://
 * only with deps.allowFileUrls), the folder name and that nothing is registered at the
 * destination yet; the clone, detection and registration run in the background job returned.
 */
export function importRepo(db: Database.Database, input: ImportInput, deps: ImportDeps = {}): ImportJob {
  const url = String(input.url ?? '').trim();
  const giteaHost = deps.giteaHost === undefined ? giteaHostOf(db) : deps.giteaHost;
  const urlOpts: CloneUrlOptions = { allowFile: deps.allowFileUrls, giteaHost };
  const bad = validateCloneUrl(url, urlOpts);
  if (bad) throw new RepoError(bad);
  const name = String(input.name ?? '').trim() || repoNameOf(url);
  if (!name) throw new RepoError('看不出這個網址的 repo 名稱，請給一個名稱');
  if (!validRepoName(name)) throw new RepoError(`「${name}」不能當資料夾名稱（只能用英數、點、底線、連字號，不能以點或連字號開頭）`);
  const dest = path.join(cloneRoot(db, deps), name);
  const existing = getRepoByPath(db, dest);
  if (existing) throw new RepoError(`已經匯入過了：${existing.name}（${existing.id}）`, 409);
  if ([...jobs.values()].some((j) => j.status === 'running' && j.dest === dest)) throw new RepoError(`${name} 正在匯入中`, 409);
  // an existing folder is adopted only when it is a git checkout of this very URL (checked in the job)
  if (fs.existsSync(dest) && !fs.existsSync(path.join(dest, '.git'))) throw new RepoError(`${dest} 已經存在，而且不是 git 的副本`, 409);
  const domain = input.domain ? String(input.domain).trim() : null;
  if (domain && !(BENCH_DOMAINS as readonly string[]).includes(domain)) throw new RepoError(`領域只能是：${BENCH_DOMAINS.join('、')}`);
  const job: ImportJob = {
    id: `imp_${nanoid(10)}`,
    url,
    name,
    dest,
    by: input.who ? String(input.who).slice(0, 200) : null,
    status: 'running',
    steps: [],
    repo_id: null,
    error: null,
    started_at: now(),
    finished_at: null,
  };
  remember(job);
  running.set(job.id, runImport(db, job, deps, urlOpts, domain, giteaHost).finally(() => running.delete(job.id)));
  return job;
}

async function runImport(db: Database.Database, job: ImportJob, deps: ImportDeps, urlOpts: CloneUrlOptions, domain: string | null, giteaHost: string | null): Promise<void> {
  const step = (label: string): ImportStep => {
    const s: ImportStep = { label, ok: null, detail: null, at: now() };
    job.steps.push(s);
    return s;
  };
  const done = (s: ImportStep, detail?: string | null) => {
    s.ok = true;
    if (detail) s.detail = detail;
  };
  try {
    // 1. the clone (or an existing checkout of the same URL, e.g. one the chat made earlier)
    const cloning = step('複製中');
    await withRepoLock(job.dest, async () => {
      if (fs.existsSync(job.dest)) {
        const origin = await gitAsync(job.dest, ['remote', 'get-url', 'origin'], { timeoutMs: localTimeout(db, deps) }).then((r) => r.stdout.trim(), () => '');
        if (!origin || !sameRemote(origin, job.url)) {
          throw new RepoError(`${job.dest} 已經存在，而且不是這個網址的副本（origin：${origin ? redactUrl(origin) : '沒有'}）`, 409);
        }
        done(cloning, '已有本機副本，直接登錄');
        return;
      }
      fs.mkdirSync(path.dirname(job.dest), { recursive: true });
      // clone beside the destination and rename: a failure only ever removes what it made itself
      const tmp = `${job.dest}.cloning-${Date.now().toString(36)}`;
      try {
        await gitAsync(path.dirname(job.dest), ['clone', '--', job.url, tmp], {
          timeoutMs: deps.cloneTimeoutMs ?? Math.max(30, getNum(db, 'ops_git_clone_timeout_sec', 900)) * 1000,
          allowProtocols: cloneProtocols(job.url, urlOpts),
          // the Gitea token through GIT_ASKPASS for an http(s) URL on the Gitea host; nothing for any other server
          env: giteaGitEnv(db, { remoteUrl: job.url }) ?? undefined,
        });
        fs.renameSync(tmp, job.dest);
      } catch (err) {
        fs.rmSync(tmp, { recursive: true, force: true });
        throw new RepoError(`抓不下來：${(err as Error).message}`, 502);
      }
      done(cloning);
    });

    // 2. what the clone tells us
    const detecting = step('偵測建置與測試指令');
    const det = await detectRepo(db, job.dest, deps);
    done(detecting, describeDetected(det));

    // 3. the row, the allowlist, the knowledge source
    const remote = parseRemoteUrl(job.url);
    const gitea = remote && giteaHost && remote.host === giteaHost.toLowerCase() ? remote : null;
    const repo = createRepo(db, {
      name: job.name,
      remote_url: job.url,
      local_path: job.dest,
      gitea_owner: gitea?.owner ?? null,
      gitea_repo: gitea?.repo ?? null,
      default_branch: det.default_branch,
      stack_json: det.stack,
      build_cmd: det.build_cmd,
      test_cmd: det.test_cmd,
      setup_cmd: det.setup_cmd,
      domain: domain ?? det.domain,
      created_by: job.by,
    });
    addToAllowlist(db, job.dest);
    job.repo_id = repo.id;
    const finishing = step('完成');
    if (getBool(db, 'repo_auto_ingest', true)) {
      const source = ensureGitSource(db, job.dest);
      updateRepo(db, repo.id, { source_id: source.id });
      const ingest = deps.ingest ?? ((d: Database.Database, sid: string) => ingestOne(d, sid));
      // fire-and-forget: a big repo takes a while and the import must not wait on it
      ingesting.set(
        job.id,
        ingest(db, source.id).then(
          () => note(db, `repo ${repo.name}（${repo.id}）已加進知識庫（來源 ${source.id}）`),
          (err: unknown) => note(db, `repo ${repo.name}（${repo.id}）加進知識庫失敗：${String((err as Error)?.message ?? err).slice(0, 200)}`),
        ),
      );
      done(finishing, `已登錄為 ${repo.id}，知識庫在背景讀取中`);
    } else {
      done(finishing, `已登錄為 ${repo.id}`);
    }
    job.status = 'done';
    note(db, `repo 匯入：${repo.name}（${repo.id}）← ${redactUrl(job.url)} → ${job.dest}${job.by ? ` by ${job.by}` : ''}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cur = job.steps.at(-1);
    if (cur && cur.ok === null) {
      cur.ok = false;
      cur.detail = msg;
    }
    job.status = 'failed';
    job.error = msg;
    note(db, `repo 匯入失敗：${redactUrl(job.url)}：${msg.slice(0, 300)}`);
  } finally {
    job.finished_at = now();
  }
}

/** The enabled git source at `dir` (symlinks resolved), or a new one. */
function ensureGitSource(db: Database.Database, dir: string) {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const target = real(dir);
  const found = listSources(db, { enabled: true }).find((s) => s.kind === 'git' && real(s.uri) === target);
  return found ?? createSource(db, { kind: 'git', uri: dir });
}

// ---- detection --------------------------------------------------------------------------------

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', vue: 'javascript', svelte: 'javascript',
  py: 'python', pyi: 'python', ipynb: 'python',
  c: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', inl: 'cpp',
  cu: 'cuda', cuh: 'cuda',
  cs: 'csharp', fs: 'fsharp', vb: 'vb',
  go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', swift: 'swift', m: 'objc', mm: 'objc',
  rb: 'ruby', php: 'php', lua: 'lua', dart: 'dart', r: 'r', jl: 'julia', pl: 'perl',
  sh: 'shell', bash: 'shell', zsh: 'shell', ps1: 'powershell', psm1: 'powershell', bat: 'batch', cmd: 'batch',
  sql: 'sql', html: 'html', htm: 'html', css: 'css', scss: 'css', less: 'css',
  glsl: 'shader', hlsl: 'shader', cl: 'opencl',
};
const ROOT_ENTRY_POINTS = new Set([
  'package.json', 'CMakeLists.txt', 'pyproject.toml', 'setup.py', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Makefile', 'Dockerfile',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'Package.swift', 'meson.build', 'BUILD', 'WORKSPACE',
]);
const PROJECT_FILE_RE = /\.(sln|csproj|vcxproj|fsproj|xcodeproj|pro)$/i;

/**
 * The language stack of a checkout: language share by extension over `git ls-files`, the
 * top-level directories and the project / build entry points. Cheap, no file contents read.
 */
export async function detectStack(dir: string, deps: { timeoutMs?: number } = {}): Promise<RepoStack> {
  let files: string[] = [];
  try {
    const { stdout } = await gitAsync(dir, ['ls-files', '-z'], { timeoutMs: deps.timeoutMs ?? 60_000 });
    files = stdout.split('\0').filter(Boolean);
  } catch {
    files = [];
  }
  const counts = new Map<string, number>();
  let headers = 0;
  const dirCounts = new Map<string, number>();
  const entry = new Set<string>();
  for (const f of files) {
    const slash = f.indexOf('/');
    const top = slash > 0 ? f.slice(0, slash) : null;
    const base = slash >= 0 ? f.slice(f.lastIndexOf('/') + 1) : f;
    if (top) {
      if (!top.startsWith('.')) dirCounts.set(top, (dirCounts.get(top) ?? 0) + 1);
    } else if (ROOT_ENTRY_POINTS.has(base)) entry.add(base);
    if (PROJECT_FILE_RE.test(base) && (slash < 0 || f.split('/').length <= 3)) entry.add(f);
    const ext = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1).toLowerCase() : '';
    if (ext === 'h') headers++;
    else if (LANG_BY_EXT[ext]) counts.set(LANG_BY_EXT[ext]!, (counts.get(LANG_BY_EXT[ext]!) ?? 0) + 1);
  }
  // a .h file belongs to whichever of C / C++ the repo has more of
  if (headers) {
    const lang = (counts.get('cpp') ?? 0) >= (counts.get('c') ?? 0) && counts.get('cpp') ? 'cpp' : 'c';
    counts.set(lang, (counts.get(lang) ?? 0) + headers);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const languages: Record<string, number> = {};
  for (const [lang, n] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) languages[lang] = Math.round((n / total) * 100) / 100;
  const dirs = [...dirCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30).map(([d]) => d).sort();
  return { languages, dirs, entry_points: [...entry].sort(), files: files.length };
}

/** BENCH_DOMAINS from the stack: the dominant language decides, cuda before cpp. */
export function domainOfStack(stack: RepoStack): string {
  const langs = stack.languages;
  if ((langs.cuda ?? 0) > 0.05) return 'cuda';
  const top = Object.keys(langs)[0];
  switch (top) {
    case 'cpp':
    case 'c':
      return 'cpp';
    case 'csharp':
      return 'csharp';
    case 'typescript':
    case 'javascript':
      return 'typescript';
    case 'python':
      return 'python';
    default:
      return 'other';
  }
}

/** Build / test commands from the toolchain (chatops detectVerify) plus cmake / .NET presets. */
export function suggestCommands(dir: string, probe: RepoProbe, stack: RepoStack): { build_cmd: string | null; test_cmd: string | null } {
  const detected = detectVerify(dir);
  let build = detected.find((c) => /\b(build|typecheck|type-check)\b/.test(c)) ?? null;
  let test = [...detected].reverse().find((c) => /\b(test|pytest)\b/.test(c)) ?? null;
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  if (!build && !test && stack.entry_points.some((e) => /\.(sln|csproj|fsproj)$/i.test(e))) {
    build = 'dotnet build';
    test = 'dotnet test';
  }
  if (!build && (probe.presets.cmake || has('CMakeLists.txt'))) {
    build = 'cmake -S . -B build && cmake --build build -j';
    if (!test) test = 'cd build && ctest --output-on-failure';
  }
  if (!build && has('Makefile') && !has('package.json')) build = 'make';
  return { build_cmd: build, test_cmd: test };
}

/** Default branch (origin's HEAD, else the checked-out branch), commands, setup, stack, domain. */
export async function detectRepo(db: Database.Database, dir: string, deps: ImportDeps = {}): Promise<Detected> {
  if (!fs.existsSync(dir)) throw new RepoError(`本機副本不見了：${dir}`, 409);
  const probe = probeRepo(db, dir);
  let defaultBranch: string | null = null;
  try {
    const { stdout } = await gitAsync(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { timeoutMs: localTimeout(db, deps) });
    defaultBranch = stdout.trim().replace(/^origin\//, '') || null;
  } catch {
    defaultBranch = null;
  }
  const stack = await detectStack(dir, { timeoutMs: localTimeout(db, deps) });
  return {
    default_branch: defaultBranch ?? probe.branch ?? 'main',
    ...suggestCommands(dir, probe, stack),
    setup_cmd: detectSetup(dir),
    stack,
    domain: domainOfStack(stack),
  };
}

function describeDetected(d: Detected): string {
  const langs = Object.entries(d.stack.languages).slice(0, 3).map(([l, share]) => `${l} ${Math.round(share * 100)}%`).join('、');
  const parts = [`分支 ${d.default_branch}`, langs ? `語言 ${langs}` : '', d.build_cmd ? `建置「${d.build_cmd}」` : '', d.test_cmd ? `測試「${d.test_cmd}」` : '', d.setup_cmd ? `準備「${d.setup_cmd}」` : ''];
  return parts.filter(Boolean).join('；');
}

/**
 * Re-run the detection on an imported repo and write it to the row (default branch, commands,
 * stack; the domain only when it was still 'other'). Null = no such repo.
 */
export async function redetectRepo(db: Database.Database, id: string, deps: ImportDeps = {}): Promise<Repo | null> {
  const repo = getRepo(db, id);
  if (!repo) return null;
  const det = await detectRepo(db, repo.local_path, deps);
  const patch: Parameters<typeof updateRepo>[2] = {
    default_branch: det.default_branch,
    build_cmd: det.build_cmd,
    test_cmd: det.test_cmd,
    setup_cmd: det.setup_cmd,
    stack_json: det.stack,
  };
  if (repo.domain === 'other' && det.domain !== 'other') patch.domain = det.domain;
  return updateRepo(db, id, patch);
}

/** Forget a repo: the row and its allowlist entry go; the clone on disk and its knowledge source stay. */
export function removeRepo(db: Database.Database, id: string): Repo | null {
  const repo = getRepo(db, id);
  if (!repo) return null;
  deleteRepo(db, id);
  removeFromAllowlist(db, repo.local_path);
  logEvent(db, { kind: 'note', detail: `repo 移除登錄：${repo.name}（${repo.id}）；${repo.local_path} 保留在磁碟上` });
  return repo;
}
