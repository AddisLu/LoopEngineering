import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, createRun, getRun, updateRun } from '../tasks.js';
import { commitAll } from '../git/worktree.js';
import { artifactPath, buildZip, collectArtifacts, crc32, latestArtifacts, packageZip, unstageArtifacts } from '../review/artifacts.js';
import { upsertExecHost, type HostExec } from '../exec/hosts.js';
import { publishGiteaRelease } from '../git/gitea.js';
import { lintPrd } from '../prd/lint.js';
import { writeTaskFile } from '../orchestrator/prompt.js';

let db: Database.Database;
let tmp: string[] = [];
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => {
  db.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp = [];
});
const dir = (tag = 'a') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-art-${tag}-`));
  tmp.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function repoWith(files: Record<string, string>): string {
  const r = dir('repo');
  git(r, 'init', '-q', '-b', 'main');
  git(r, 'config', 'user.email', 't@t');
  git(r, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(r, 'README.md'), 'x\n');
  git(r, 'add', '-A');
  git(r, 'commit', '-qm', 'init');
  for (const [p, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(r, p)), { recursive: true });
    fs.writeFileSync(path.join(r, p), c);
  }
  return r;
}

describe('artifacts never reach a commit', () => {
  it('the auto-commit keeps the source change and leaves the binary and report on disk, uncommitted', () => {
    const r = repoWith({ 'src/kernel.cu': 'k', 'build/arith': 'ELF', 'arith_report.ncu-rep': 'NCU' });
    commitAll(r, 'auto', (wt) => unstageArtifacts(wt, ['build/arith', '*.ncu-rep']));
    expect(git(r, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n')).toEqual(['src/kernel.cu']);
    expect(fs.existsSync(path.join(r, 'build/arith'))).toBe(true);
    expect(git(r, 'status', '--porcelain')).toContain('?? arith_report.ncu-rep');
  });

  it('only artifacts changed: no empty commit', () => {
    const r = repoWith({ 'build/arith': 'ELF' });
    const before = git(r, 'rev-parse', 'HEAD');
    commitAll(r, 'auto', (wt) => unstageArtifacts(wt, ['build/**']));
    expect(git(r, 'rev-parse', 'HEAD')).toBe(before);
  });
});

function taskWith(worktree: string, extra: Record<string, unknown> = {}) {
  const t = createTask(db, { title: 'CUDA 加減乘除', goal: 'g', coding_tool: 'claude-code', verification_steps: ['sandbox: bash run.sh'], repo_path: worktree, base_branch: 'main', artifacts: 'build/arith,*.ncu-rep', ...extra });
  const run = createRun(db, { task_id: t.id, worktree_path: worktree });
  updateRun(db, run.id, {
    verify_json: JSON.stringify([{ step: 'sandbox: bash run.sh', ok: true, exitCode: 0, timedOut: false, tail: '' }]),
    metrics_json: JSON.stringify({ values: { kernels_pass: 4 }, checks: [], pass: true }),
  });
  return { t, run: getRun(db, run.id)! };
}

describe('collecting artifacts after verification', () => {
  it('local: copies the matching files with sha256 into the data dir and records them on the run', async () => {
    const wt = repoWith({ 'build/arith': 'ELF-binary', 'reports/arith_report.ncu-rep': 'NCU', 'src/kernel.cu': 'k' });
    const { t, run } = taskWith(wt);
    const m = (await collectArtifacts(db, t, run, wt))!;
    expect(m.files.map((f) => `${f.path}@${f.from}`)).toEqual(['build/arith@local', 'reports/arith_report.ncu-rep@local']);
    expect(m.files[0]!.sha256).toBe(sha('ELF-binary'));
    expect(m.head_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(m.metrics?.values.kernels_pass).toBe(4);
    expect(JSON.parse(getRun(db, run.id)!.artifacts_json!).files).toHaveLength(2);
    const latest = latestArtifacts(db, t.id)!;
    expect(latest.run_id).toBe(run.id);
    const abs = artifactPath(t.id, run.id, latest.manifest, 'build/arith')!;
    expect(fs.readFileSync(abs, 'utf8')).toBe('ELF-binary');
    expect(artifactPath(t.id, run.id, latest.manifest, 'src/kernel.cu')).toBeNull(); // not an artifact
    expect(artifactPath(t.id, run.id, latest.manifest, '../../etc/passwd')).toBeNull();
  });

  it('respects artifacts_max_mb and says what it skipped', async () => {
    setSetting(db, 'artifacts_max_mb', '0');
    const wt = repoWith({ 'build/arith': 'ELF' });
    const { t, run } = taskWith(wt);
    const m = (await collectArtifacts(db, t, run, wt))!;
    expect(m.files).toEqual([]);
    expect(m.skipped[0]).toContain('build/arith');
  });

  it('remote: pulls only the matching files back from the machine the sandbox steps ran on', async () => {
    upsertExecHost(db, { name: 'gpu', ssh_target: 'loop@gpu', work_root: '/srv/loop-exec' });
    const wt = repoWith({ 'build/arith': 'stale local copy' });
    const { t, run } = taskWith(wt, { verification_steps: ['sandbox@gpu: bash run.sh'] });
    const calls: string[][] = [];
    const exec: HostExec = async (cmd, args) => {
      calls.push([cmd, ...args]);
      const dest = args.at(-1)!;
      fs.mkdirSync(path.join(dest, 'build'), { recursive: true });
      fs.writeFileSync(path.join(dest, 'build/arith'), 'built on gpu');
      fs.writeFileSync(path.join(dest, 'arith_report.ncu-rep'), 'NCU from gpu');
      return { code: 0, out: '' };
    };
    const m = (await collectArtifacts(db, t, run, wt, { hostExec: exec }))!;
    expect(calls[0]![0]).toBe('rsync');
    expect(calls[0]).toEqual(expect.arrayContaining(['--include=*/', '--include=build/arith', '--include=*.ncu-rep', '--exclude=*', `loop@gpu:/srv/loop-exec/task-${t.id}/`]));
    expect(m.files.map((f) => `${f.path}@${f.from}`)).toEqual(['arith_report.ncu-rep@gpu', 'build/arith@gpu']);
    expect(m.files.find((f) => f.path === 'build/arith')!.sha256).toBe(sha('built on gpu'));
  });

  it('declares nothing: collects nothing', async () => {
    const wt = repoWith({ 'build/arith': 'x' });
    const { t, run } = taskWith(wt, { artifacts: null });
    expect(await collectArtifacts(db, t, run, wt)).toBeNull();
  });
});

/** read a zip back (central directory → entries), the way any unzip would */
function readZip(buf: Buffer): Record<string, Buffer> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out: Record<string, Buffer> = {};
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(local + 26);
    const body = buf.subarray(local + 30 + lnlen, local + 30 + lnlen + csize);
    const data = method === 8 ? zlib.inflateRawSync(body) : body;
    expect(crc32(data)).toBe(crc);
    out[name] = data;
    p += 46 + nlen;
  }
  return out;
}

describe('the delivery zip', () => {
  it('is a standard zip: CRC-32, deflate, UTF-8 names', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    const z = readZip(buildZip([{ name: '報告/結果.txt', data: Buffer.from('檢出率 0.991\n'.repeat(50)) }, { name: 'bin', data: Buffer.from([0, 1, 2]) }]));
    expect(z['報告/結果.txt']!.toString()).toContain('檢出率 0.991');
    expect([...z.bin!]).toEqual([0, 1, 2]);
  });

  it('packages the files, the manifest, a report and SHA256SUMS', async () => {
    const wt = repoWith({ 'build/arith': 'ELF-binary' });
    const { t, run } = taskWith(wt);
    const m = (await collectArtifacts(db, t, run, wt))!;
    const z = readZip(packageZip(t.id, run.id, m, '# 報告'));
    expect(Object.keys(z).sort()).toEqual(['REPORT.md', 'SHA256SUMS', 'files/build/arith', 'manifest.json']);
    expect(z['SHA256SUMS']!.toString()).toBe(`${sha('ELF-binary')}  files/build/arith\n`);
    expect(JSON.parse(z['manifest.json']!.toString()).task_id).toBe(t.id);
  });
});

describe('Gitea release', () => {
  const repo = { host: 'gitea.corp', owner: 'aoi', repo: 'cf-aoi' };
  const input = { tag: 'v1.4.0', target: 'abc123', name: '亮缺陷判型', body: 'notes' };
  type Call = { url: string; init?: RequestInit };
  const fake = (responses: Array<() => Response>, calls: Call[] = []) =>
    (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) throw new Error('unexpected call');
      return next();
    }) as unknown as typeof fetch;

  it('creates the release on the verified commit and attaches the zip', async () => {
    const calls: Call[] = [];
    const r = await publishGiteaRelease('http://gitea.corp:3000', 'tok', repo, input, { name: 'cf-aoi-v1.4.0.zip', data: Buffer.from('PK') }, fake([
      () => new Response(JSON.stringify({ id: 7, html_url: 'http://gitea.corp:3000/aoi/cf-aoi/releases/tag/v1.4.0' }), { status: 201 }),
      () => new Response(JSON.stringify({ browser_download_url: 'http://gitea.corp:3000/attachments/x' }), { status: 201 }),
    ], calls));
    expect(r).toEqual({ url: 'http://gitea.corp:3000/aoi/cf-aoi/releases/tag/v1.4.0', asset_url: 'http://gitea.corp:3000/attachments/x' });
    expect(calls[0]!.url).toBe('http://gitea.corp:3000/api/v1/repos/aoi/cf-aoi/releases');
    expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ tag_name: 'v1.4.0', target_commitish: 'abc123', draft: false });
    expect(calls[1]!.url).toBe('http://gitea.corp:3000/api/v1/repos/aoi/cf-aoi/releases/7/assets?name=cf-aoi-v1.4.0.zip');
    expect(calls[1]!.init!.body).toBeInstanceOf(FormData);
  });

  it('a tag that already has a release gets the zip attached to that release', async () => {
    const calls: Call[] = [];
    const r = await publishGiteaRelease('http://g', 't', repo, input, { name: 'a.zip', data: Buffer.from('PK') }, fake([
      () => new Response('release already exists', { status: 409 }),
      () => new Response(JSON.stringify({ id: 3, html_url: 'http://g/rel/3' })),
      () => new Response(JSON.stringify({ browser_download_url: 'http://g/a.zip' }), { status: 201 }),
    ], calls));
    expect(r.url).toBe('http://g/rel/3');
    expect(calls[1]!.url).toBe('http://g/api/v1/repos/aoi/cf-aoi/releases/tags/v1.4.0');
  });

  it('explains a missing token instead of throwing', async () => {
    const r = await publishGiteaRelease('http://g', 'bad', repo, input, { name: 'a.zip', data: Buffer.from('PK') }, fake([() => new Response('unauthorized', { status: 401 })]));
    expect(r.url).toBeNull();
    expect(r.error).toContain('GITEA_TOKEN');
  });
});

describe('the task says what it produces', () => {
  it('PRD 產出物 section and the LOOP_TASK.md block', () => {
    const md = `# t\n\n## 目標\n做一個可以驗證的 CUDA 程式並產出報告\n\n## 範圍\n- a.cu\n\n## 非範圍\n- 其他\n\n## 驗收標準\n- [ ] Given x When y Then z\n\n## 驗證指令\n\`\`\`bash\nmake\n\`\`\`\n\n## Repo\n- path: /r\n\n## 領域\ncuda\n\n## 產出物 (Artifacts)\n- build/arith\n- \`*.ncu-rep\`\n`;
    const r = lintPrd(md, { exists: () => true });
    expect(r.missing).toEqual([]);
    expect(r.fields.artifacts).toEqual(['build/arith', '*.ncu-rep']);
    expect(lintPrd(md.replace('- build/arith', '- /etc/passwd'), { exists: () => true }).missing.join()).toContain('產出物');

    const wt = dir('wt');
    const t = createTask(db, { title: 't', goal: 'g', coding_tool: 'claude-code', verification_steps: ['make'], repo_path: wt, base_branch: 'main', artifacts: 'build/arith,*.ncu-rep' });
    writeTaskFile(wt, t);
    const txt = fs.readFileSync(path.join(wt, 'LOOP_TASK.md'), 'utf8');
    expect(txt).toContain('## 產出物（不要 commit）');
    expect(txt).toContain('- `build/arith`');
  });
});
