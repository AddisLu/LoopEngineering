import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { getSetting, openTestDb, setSetting } from '../db/index.js';
import { getSource } from '../knowledge/ingest/sources.js';
import { listJobRepos } from '../plans/job.js';
import { awaitImport, detectStack, domainOfStack, getImportJob, importRepo, listImportJobs, redetectRepo, removeRepo, type ImportDeps } from '../repo/import.js';
import { createRepo, getRepo, getRepoByPath, listRepos, parseStack, RepoError, updateRepo } from '../repo/store.js';

/**
 * 匯入 repo against file:// bare origins: the clone lands under the clone root, the detection
 * fills the row (branch, commands, stack, domain), the repo picker sees it, the knowledge ingest
 * runs only when the flag is on, and nothing on disk is ever removed that the import did not make.
 */

let db: Database.Database;
let root: string;
let d: ImportDeps;
let ingested: string[];
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();

/** a bare origin seeded with `files`, default branch main */
function origin(name: string, files: Record<string, string>): string {
  const bare = path.join(root, `${name}.git`);
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = path.join(root, `seed-${name}`);
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 't@t');
  git(seed, 'config', 'user.name', 't');
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(seed, f)), { recursive: true });
    fs.writeFileSync(path.join(seed, f), body);
  }
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'init');
  git(seed, 'push', '-q', bare, 'main');
  return `file://${bare}`;
}
const NODE_FILES = {
  'package.json': JSON.stringify({ name: 'app', scripts: { lint: 'eslint .', build: 'tsc', test: 'vitest run' } }),
  'package-lock.json': '{}',
  'src/index.ts': 'export {};\n',
  'src/util.ts': 'export const x = 1;\n',
  'README.md': '# app\n',
  'docs/notes.md': 'notes\n',
};
const CPP_FILES = {
  'CMakeLists.txt': 'project(cfaoi)\n',
  'src/a.cpp': 'int main() {}\n',
  'src/a.h': '#pragma once\n',
  'kernels/k.cu': '__global__ void k() {}\n',
  'tools/run.py': 'print(1)\n',
};

beforeEach(() => {
  db = openTestDb();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loop-repo-')));
  ingested = [];
  d = { allowFileUrls: true, cloneRoot: path.join(root, 'repos'), timeoutMs: 20_000, ingest: async (_db, sid) => void ingested.push(sid) };
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const run = async (input: Parameters<typeof importRepo>[1], deps = d) => awaitImport(importRepo(db, input, deps).id, { ingest: true });

describe('importRepo', () => {
  it('clones, detects the commands and stack, registers the row, the picker sees it and the knowledge base reads it', async () => {
    const url = origin('app', NODE_FILES);
    const started = importRepo(db, { url, who: '呂侑儒' }, d);
    expect(started).toMatchObject({ status: 'running', name: 'app', dest: path.join(root, 'repos', 'app'), by: '呂侑儒' });
    expect(getImportJob(started.id)).toBe(started);
    expect(listImportJobs().map((j) => j.id)).toContain(started.id);
    const job = await awaitImport(started.id, { ingest: true });
    expect(job.status).toBe('done');
    expect(job.error).toBeNull();
    expect(job.steps.map((s) => [s.label, s.ok])).toEqual([['複製中', true], ['偵測建置與測試指令', true], ['完成', true]]);
    expect(job.steps[1]!.detail).toContain('typescript 100%');
    expect(job.finished_at).not.toBeNull();
    const r = getRepo(db, job.repo_id!)!;
    expect(r).toMatchObject({
      name: 'app', remote_url: url, gitea_owner: null, gitea_repo: null, local_path: path.join(root, 'repos', 'app'), default_branch: 'main', pr_base: null, machine: null,
      build_cmd: 'npm run build', test_cmd: 'npm test', setup_cmd: 'npm ci', domain: 'typescript', enabled: 1, issue_comments: 1, created_by: '呂侑儒',
    });
    expect(r.id).toMatch(/^r_/);
    expect(parseStack(r)).toEqual({ languages: { typescript: 1 }, dirs: ['docs', 'src'], entry_points: ['package.json'], files: 6 });
    expect(fs.readFileSync(path.join(r.local_path, 'src', 'util.ts'), 'utf8')).toBe('export const x = 1;\n');
    // the repo picker of 工作流程 / 對話操作 offers it
    expect(getSetting(db, 'prd_repo_allowlist')).toBe(r.local_path);
    expect(listJobRepos(db).map((j) => j.name)).toEqual(['app']);
    // repo_auto_ingest (default on): a git knowledge source at the clone, ingested in the background
    expect(r.source_id).toMatch(/^src_/);
    expect(getSource(db, r.source_id!)).toMatchObject({ kind: 'git', uri: r.local_path, enabled: 1 });
    expect(ingested).toEqual([r.source_id]);
  });

  it('with repo_auto_ingest off nothing reaches the knowledge base', async () => {
    setSetting(db, 'repo_auto_ingest', 'false');
    const job = await run({ url: origin('app', NODE_FILES) });
    expect(job.status).toBe('done');
    expect(getRepo(db, job.repo_id!)!.source_id).toBeNull();
    expect(ingested).toEqual([]);
    expect(job.steps.at(-1)!.detail).not.toContain('知識庫');
  });

  it('a C++/CUDA repo gets cmake commands, the cuda domain and its own name', async () => {
    const job = await run({ url: origin('cf', CPP_FILES), name: 'cf-aoi' });
    expect(job.status).toBe('done');
    const r = getRepo(db, job.repo_id!)!;
    expect(r).toMatchObject({ name: 'cf-aoi', local_path: path.join(root, 'repos', 'cf-aoi'), build_cmd: 'cmake -S . -B build && cmake --build build -j', test_cmd: 'cd build && ctest --output-on-failure', setup_cmd: null, domain: 'cuda' });
    expect(parseStack(r)).toEqual({ languages: { cpp: 0.5, cuda: 0.25, python: 0.25 }, dirs: ['kernels', 'src', 'tools'], entry_points: ['CMakeLists.txt'], files: 5 });
    // a domain given at import wins over the detected one
    const other = await run({ url: origin('cf2', CPP_FILES), name: 'cf-cv', domain: 'cv' });
    expect(getRepo(db, other.repo_id!)!.domain).toBe('cv');
  });

  it('refuses what it cannot import before starting anything', () => {
    const url = origin('app', NODE_FILES);
    const bad = (input: Parameters<typeof importRepo>[1], deps = d) => {
      try {
        importRepo(db, input, deps);
      } catch (err) {
        return err as RepoError;
      }
      return null;
    };
    expect(bad({ url: '/etc' })).toMatchObject({ status: 400 });
    expect(bad({ url: 'https://user:tok@github.com/a/b' })!.message).toContain('token');
    expect(bad({ url, name: '../x' })).toMatchObject({ status: 400, message: expect.stringContaining('資料夾名稱') });
    expect(bad({ url, name: '.git' })).toMatchObject({ status: 400 });
    // file:// only when the deps allow it (tests) — never from a person
    expect(bad({ url }, { ...d, allowFileUrls: false })).toMatchObject({ status: 400, message: expect.stringContaining('https') });
    // a folder in the way that is not a git checkout
    fs.mkdirSync(path.join(root, 'repos', 'taken'), { recursive: true });
    fs.writeFileSync(path.join(root, 'repos', 'taken', 'keep.txt'), 'mine');
    expect(bad({ url, name: 'taken' })).toMatchObject({ status: 409, message: expect.stringContaining('已經存在') });
    expect(fs.readFileSync(path.join(root, 'repos', 'taken', 'keep.txt'), 'utf8')).toBe('mine');
    expect(listRepos(db)).toEqual([]);
    expect(listImportJobs().filter((j) => j.dest.startsWith(root))).toEqual([]);
  });

  it('the same repo twice is a conflict, not a second clone', async () => {
    const url = origin('app', NODE_FILES);
    const first = await run({ url });
    expect(first.status).toBe('done');
    expect(() => importRepo(db, { url }, d)).toThrow(RepoError);
    try {
      importRepo(db, { url }, d);
    } catch (err) {
      expect(err).toMatchObject({ status: 409, message: expect.stringContaining('已經匯入過了') });
    }
    expect(listRepos(db)).toHaveLength(1);
  });

  it('adopts a checkout of the same URL that is already there (e.g. one the chat cloned), and not another repo', async () => {
    const url = origin('app', NODE_FILES);
    const dest = path.join(root, 'repos', 'app');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    git(root, 'clone', '-q', url, dest);
    fs.writeFileSync(path.join(dest, 'local.txt'), 'untracked work stays');
    const job = await run({ url });
    expect(job.status).toBe('done');
    expect(job.steps[0]).toMatchObject({ label: '複製中', ok: true, detail: '已有本機副本，直接登錄' });
    expect(fs.readFileSync(path.join(dest, 'local.txt'), 'utf8')).toBe('untracked work stays');
    expect(getRepo(db, job.repo_id!)!.local_path).toBe(dest);
    // a different repo checked out under the name we want: refused, untouched
    const other = origin('other', CPP_FILES);
    const dest2 = path.join(root, 'repos', 'cf-aoi');
    git(root, 'clone', '-q', other, dest2);
    const clash = await run({ url: origin('cf', CPP_FILES), name: 'cf-aoi' });
    expect(clash.status).toBe('failed');
    expect(clash.error).toContain('已經存在');
    expect(clash.steps[0]).toMatchObject({ label: '複製中', ok: false });
    expect(fs.existsSync(path.join(dest2, 'kernels', 'k.cu'))).toBe(true);
    expect(getRepoByPath(db, dest2)).toBeNull();
  });

  it('a failed clone leaves no half-made directory, no row and no allowlist entry', async () => {
    const job = await run({ url: `file://${root}/missing.git` });
    expect(job.status).toBe('failed');
    expect(job.error).toContain('抓不下來');
    expect(job.steps).toHaveLength(1);
    expect(fs.existsSync(path.join(root, 'repos', 'missing'))).toBe(false);
    expect(fs.readdirSync(path.join(root, 'repos'))).toEqual([]);
    expect(listRepos(db)).toEqual([]);
    expect(getSetting(db, 'prd_repo_allowlist')).toBe('');
    expect(ingested).toEqual([]);
  });

  it('a Gitea URL records owner / repo; any other host does not', () => {
    // no network: only the row-shaping around the clone is checked here, on an adopted checkout
    const url = origin('app', NODE_FILES);
    const dest = path.join(root, 'repos', 'app');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    git(root, 'clone', '-q', url, dest);
    git(dest, 'remote', 'set-url', 'origin', 'http://gitea.corp:3000/aoi/app.git');
    const job = importRepo(db, { url: 'http://gitea.corp:3000/aoi/app.git' }, { ...d, giteaHost: 'gitea.corp' });
    return awaitImport(job.id, { ingest: true }).then((j) => {
      expect(j.status).toBe('done');
      expect(getRepo(db, j.repo_id!)).toMatchObject({ gitea_owner: 'aoi', gitea_repo: 'app', remote_url: 'http://gitea.corp:3000/aoi/app.git' });
      // the same http URL is refused without a Gitea host to vouch for it
      expect(() => importRepo(db, { url: 'http://gitea.corp:3000/aoi/app2.git' }, { ...d, giteaHost: null })).toThrow(/http/);
    });
  });
});

describe('redetect and the store', () => {
  it('redetect follows the checkout; the engineer-set fields it does not own stay', async () => {
    const job = await run({ url: origin('app', NODE_FILES) });
    const r = getRepo(db, job.repo_id!)!;
    updateRepo(db, r.id, { pr_base: 'release', issue_label: 'loop', domain: 'cv' });
    const pj = path.join(r.local_path, 'package.json');
    fs.writeFileSync(pj, JSON.stringify({ name: 'app', scripts: { typecheck: 'tsc --noEmit' } }));
    fs.rmSync(path.join(r.local_path, 'package-lock.json'));
    fs.writeFileSync(path.join(r.local_path, 'extra.py'), 'x = 1\n');
    git(r.local_path, 'add', '-A');
    const again = (await redetectRepo(db, r.id, d))!;
    expect(again).toMatchObject({ build_cmd: 'npm run typecheck', test_cmd: null, setup_cmd: 'npm install', pr_base: 'release', issue_label: 'loop', domain: 'cv', default_branch: 'main' });
    expect(parseStack(again)!.languages).toEqual({ typescript: 0.67, python: 0.33 });
    expect(await redetectRepo(db, 'r_nope', d)).toBeNull();
    fs.rmSync(r.local_path, { recursive: true, force: true });
    await expect(redetectRepo(db, r.id, d)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('不見了') });
  });

  it('validates what the Repo page may change and ignores what it may not', async () => {
    const job = await run({ url: origin('app', NODE_FILES) });
    const id = job.repo_id!;
    const bad = (patch: Record<string, unknown>) => () => updateRepo(db, id, patch);
    expect(bad({ default_branch: '--force' })).toThrow(/分支名稱/);
    expect(bad({ pr_base: 'a:b' })).toThrow(/分支名稱/);
    expect(bad({ domain: 'cobol' })).toThrow(/領域/);
    expect(bad({ name: ' ' })).toThrow(/名稱/);
    expect(bad({ name: 'a/b' })).toThrow(/斜線/);
    expect(bad({ machine: 'win-aoi' })).toThrow(/沒有這台機台/);
    expect(bad({ machine: 'Bad Name' })).toThrow(/機台名稱/);
    expect(bad({ enabled: 'maybe' })).toThrow(/true 或 false/);
    expect(bad({ stack_json: '[1]' })).toThrow(/JSON 物件/);
    db.prepare("INSERT INTO machines (name, ssh_target, work_root) VALUES ('win-aoi', 'aoi@win', 'C:\\loop')").run();
    const r = updateRepo(db, id, { machine: 'win-aoi', name: '瑕疵判型', default_branch: 'develop', pr_base: null, issue_comments: false, enabled: 0, build_cmd: ' ', test_cmd: 'ctest', local_path: '/elsewhere', remote_url: 'x', id: 'r_hijack' } as never)!;
    expect(r).toMatchObject({ id, machine: 'win-aoi', name: '瑕疵判型', default_branch: 'develop', pr_base: null, issue_comments: 0, enabled: 0, build_cmd: null, test_cmd: 'ctest', remote_url: job.url });
    expect(r.local_path).toBe(path.join(root, 'repos', 'app'));
    expect(updateRepo(db, id, { machine: 'local' })!.machine).toBeNull();
    expect(updateRepo(db, id, {})).toEqual(getRepo(db, id));
    expect(updateRepo(db, 'r_nope', { name: 'x' })).toBeNull();
    expect(r.updated_at >= r.created_at).toBe(true);
  });

  it('finds a repo by any spelling of its path, and forgetting it keeps the clone', async () => {
    const job = await run({ url: origin('app', NODE_FILES) });
    const r = getRepo(db, job.repo_id!)!;
    const link = path.join(root, 'link');
    fs.symlinkSync(r.local_path, link);
    expect(getRepoByPath(db, link)?.id).toBe(r.id);
    expect(getRepoByPath(db, `${r.local_path}/`)?.id).toBe(r.id);
    expect(getRepoByPath(db, path.join(root, 'nope'))).toBeNull();
    expect(getRepoByPath(db, '')).toBeNull();
    expect(() => createRepo(db, { name: 'dup', remote_url: 'https://x/a/b', local_path: link })).toThrow(/已經匯入過了/);
    expect(() => createRepo(db, { name: 'rel', remote_url: 'https://x/a/b', local_path: 'relative/path' })).toThrow(/絕對路徑/);
    setSetting(db, 'prd_repo_allowlist', `/srv/other,${r.local_path}`);
    expect(removeRepo(db, r.id)).toMatchObject({ id: r.id });
    expect(getRepo(db, r.id)).toBeNull();
    expect(getSetting(db, 'prd_repo_allowlist')).toBe('/srv/other');
    expect(fs.existsSync(path.join(r.local_path, 'package.json'))).toBe(true);
    expect(getSource(db, r.source_id!)).toBeDefined(); // the knowledge source is the knowledge page's to remove
    expect(removeRepo(db, r.id)).toBeNull();
  });
});

describe('detectStack', () => {
  it('shares by extension over tracked files, .h following the C++ majority, entry points at the root or one level down', async () => {
    const dir = path.join(root, 'stack');
    fs.mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    const files: Record<string, string> = {
      'App.sln': '', 'src/App/App.csproj': '', 'src/App/Program.cs': '', 'src/App/Util.cs': '', 'src/App/Model.cs': '', 'native/lib.c': '', 'native/lib.h': '',
      'native/CMakeLists.txt': '', 'scripts/run.ps1': '', '.github/workflows/ci.yml': '', 'deep/a/b/c.vcxproj': '', 'README.md': '', 'untracked.cs': '',
    };
    for (const [f, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), body);
    }
    git(dir, 'add', '-A', '--', ':!untracked.cs');
    const s = await detectStack(dir);
    expect(s).toEqual({
      languages: { csharp: 0.5, c: 0.33, powershell: 0.17 },
      dirs: ['deep', 'native', 'scripts', 'src'], // dot-directories are noise; the untracked file is not counted
      entry_points: ['App.sln', 'src/App/App.csproj'], // a project file three levels down is not an entry point
      files: 12,
    });
    expect(Object.keys(s.languages)).toEqual(['csharp', 'c', 'powershell']);
    expect(domainOfStack(s)).toBe('csharp');
    expect(domainOfStack({ languages: { cpp: 0.9, cuda: 0.1 }, dirs: [], entry_points: [], files: 1 })).toBe('cuda');
    expect(domainOfStack({ languages: { python: 0.6, cpp: 0.4 }, dirs: [], entry_points: [], files: 1 })).toBe('python');
    expect(domainOfStack({ languages: {}, dirs: [], entry_points: [], files: 0 })).toBe('other');
    expect(await detectStack(path.join(root, 'not-a-repo'))).toEqual({ languages: {}, dirs: [], entry_points: [], files: 0 });
  });
});
