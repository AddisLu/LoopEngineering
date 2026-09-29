import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';
import { createGiteaPr, giteaRepoFor, parseRemoteUrl } from '../git/gitea.js';
import { createPr } from '../git/pr.js';
import { prBody, readMetrics, readVerify } from '../orchestrator/runSummary.js';
import { validateSetting } from '../settings.js';
import type { Task, TaskRun } from '../types.js';

let tmp: string[] = [];
afterEach(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp = [];
});
const dir = (tag = 'g') => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-gitea-${tag}-`));
  tmp.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

type Call = { url: string; init?: RequestInit };
const fakeFetch = (responses: Array<() => Response>, calls: Call[] = []) =>
  (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('unexpected call');
    return next();
  }) as unknown as typeof fetch;

describe('remote URLs', () => {
  it('parses https, ssh:// and scp-style remotes', () => {
    expect(parseRemoteUrl('http://gitea.corp:3000/aoi/cf-aoi.git')).toEqual({ host: 'gitea.corp', owner: 'aoi', repo: 'cf-aoi' });
    expect(parseRemoteUrl('ssh://git@Gitea.Corp:2222/aoi/cf-aoi.git')).toEqual({ host: 'gitea.corp', owner: 'aoi', repo: 'cf-aoi' });
    expect(parseRemoteUrl('git@gitea.corp:aoi/cf-aoi.git')).toEqual({ host: 'gitea.corp', owner: 'aoi', repo: 'cf-aoi' });
    expect(parseRemoteUrl('/srv/git/app.git')).toBeNull();
    expect(parseRemoteUrl('http://gitea.corp/only-one')).toBeNull();
  });

  it('only a remote on the configured Gitea host counts (the port may differ: ssh vs web)', () => {
    expect(giteaRepoFor('http://gitea.corp:3000', 'ssh://git@gitea.corp:2222/aoi/app.git')).toMatchObject({ owner: 'aoi', repo: 'app' });
    expect(giteaRepoFor('http://gitea.corp:3000', 'https://github.com/aoi/app.git')).toBeNull();
    expect(giteaRepoFor('not a url', 'git@gitea.corp:aoi/app.git')).toBeNull();
    expect(validateSetting('gitea_url', 'http://gitea.corp:3000')).toBeNull();
    expect(validateSetting('gitea_url', 'gitea.corp')).toMatch(/gitea_url/);
  });
});

describe('createGiteaPr', () => {
  const repo = { host: 'gitea.corp', owner: 'aoi', repo: 'cf-aoi' };
  const input = { head: 'loop/t1', base: 'feature/x', title: 'fix', body: 'body' };

  it('creates the PR with the token and returns its page', async () => {
    const calls: Call[] = [];
    const r = await createGiteaPr('http://gitea.corp:3000/', 'tok', repo, input, fakeFetch([() => new Response(JSON.stringify({ html_url: 'http://gitea.corp:3000/aoi/cf-aoi/pulls/7' }), { status: 201 })], calls));
    expect(r.url).toBe('http://gitea.corp:3000/aoi/cf-aoi/pulls/7');
    expect(calls[0]!.url).toBe('http://gitea.corp:3000/api/v1/repos/aoi/cf-aoi/pulls');
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('token tok');
    expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ head: 'loop/t1', base: 'feature/x', title: 'fix', body: 'body' });
  });

  it('reuses the open PR for the same branch (a resumed task)', async () => {
    const r = await createGiteaPr('http://g', 't', repo, input, fakeFetch([
      () => new Response('pull request already exists', { status: 409 }),
      () => new Response(JSON.stringify([{ html_url: 'http://g/other', head: { ref: 'loop/zz' }, base: { ref: 'feature/x' } }, { html_url: 'http://g/pulls/3', head: { ref: 'loop/t1' }, base: { ref: 'feature/x' } }])),
    ]));
    expect(r.url).toBe('http://g/pulls/3');
  });

  it('explains auth failures and network errors instead of throwing', async () => {
    const denied = await createGiteaPr('http://g', 'bad', repo, input, fakeFetch([() => new Response('unauthorized', { status: 401 })]));
    expect(denied.url).toBeNull();
    expect(denied.error).toContain('GITEA_TOKEN');
    const down = await createGiteaPr('http://g', 't', repo, input, (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    expect(down.error).toContain('連不上');
  });
});

describe('createPr through Gitea', () => {
  /** a checkout whose origin READS as the Gitea server but PUSHES to a local bare repo */
  function fixture(): { wt: string; bare: string } {
    const bare = dir('bare');
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    const wt = dir('wt');
    git(wt, 'init', '-q', '-b', 'main');
    git(wt, 'config', 'user.email', 't@t');
    git(wt, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'a\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'init');
    git(wt, 'remote', 'add', 'origin', 'http://gitea.corp:3000/aoi/cf-aoi.git');
    git(wt, 'remote', 'set-url', '--push', 'origin', bare);
    git(wt, 'checkout', '-q', '-b', 'loop/t1');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'b\n');
    git(wt, 'commit', '-qam', 'change');
    return { wt, bare };
  }

  it('pushes the branch and opens the PR with the verification body', async () => {
    const { wt, bare } = fixture();
    const calls: Call[] = [];
    const url = await createPr(wt, 'loop/t1', 'Fix bright defect', {
      base: 'main',
      body: '## 自動驗證',
      gitea: { url: 'http://gitea.corp:3000', token: 'tok' },
      fetchImpl: fakeFetch([() => new Response(JSON.stringify({ html_url: 'http://gitea.corp:3000/aoi/cf-aoi/pulls/9' }), { status: 201 })], calls),
    });
    expect(url).toBe('http://gitea.corp:3000/aoi/cf-aoi/pulls/9');
    expect(git(bare, 'branch', '--list', 'loop/t1')).toContain('loop/t1');
    expect(JSON.parse(String(calls[0]!.init!.body))).toMatchObject({ head: 'loop/t1', base: 'main', title: 'Fix bright defect', body: '## 自動驗證' });
  });

  it('without a token it says so and opens nothing', async () => {
    const { wt } = fixture();
    const errors: string[] = [];
    const url = await createPr(wt, 'loop/t1', 't', { base: 'main', gitea: { url: 'http://gitea.corp:3000', token: '' }, onError: (m) => errors.push(m), fetchImpl: fakeFetch([]) });
    expect(url).toBeNull();
    expect(errors[0]).toContain('GITEA_TOKEN');
  });
});

describe('the PR body a reviewer reads in the morning', () => {
  it('shows the goal, each verify step, the metrics table and VERIFY.md', () => {
    const wt = dir('body');
    fs.writeFileSync(path.join(wt, 'VERIFY.md'), '- [ ] 上機台跑 20260615 圖集，確認 X 區亮缺陷判型');
    const task = { id: 't_1', goal: '修正亮缺陷判型', model: 'local:qwen3-coder-next' } as Task;
    const run = {
      id: 'r_1',
      attempt: 2,
      verify_json: JSON.stringify([
        { step: 'sandbox@aoi-gpu: make', ok: true, exitCode: 0, timedOut: false, tail: 'ok' },
        { step: 'sandbox@aoi-gpu: python3 eval.py', ok: true, exitCode: 0, timedOut: false, tail: 'LOOP_METRICS {}' },
      ]),
      metrics_json: JSON.stringify({
        values: { detection_rate: 0.991, miss: 0, fps: 31 },
        checks: [
          { name: 'detection_rate', op: '>=', target: 0.98, actual: 0.991, pass: true },
          { name: 'miss', op: '==', target: 0, actual: 0, pass: true },
        ],
        pass: true,
      }),
    } as TaskRun;
    const md = prBody(task, run, wt);
    expect(md).toContain('## 目標\n修正亮缺陷判型');
    expect(md).toContain('- ✅ `sandbox@aoi-gpu: make`（exit 0）');
    expect(md).toContain('| detection_rate | 0.991 | >= 0.98 | ✅ |');
    expect(md).toContain('其他回報：fps=31');
    expect(md).toContain('## 人工驗收（VERIFY.md）');
    expect(md).toContain('run `r_1`（第 2 次）');
    expect(readVerify({ verify_json: 'not json' })).toEqual([]);
    expect(readMetrics({ metrics_json: null })).toBeNull();
  });
});
