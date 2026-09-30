import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { getSetting, openTestDb, setSetting } from '../db/index.js';
import { createTask, setStatus } from '../tasks.js';
import { appendMessage, createConversation } from '../chat/store.js';
import { getActionById } from '../chatops/actions.js';
import { confirmTyped, getOpsRunner } from '../chatops/execute.js';
import { cloneProtocols, prepareGit, repoStatus, runGit, validateCloneUrl, withRepoLock, type GitOpsDeps } from '../chatops/git.js';
import { redactUrl } from '../git/async.js';
import type { ChatCtx, OpsAction } from '../chatops/types.js';

// git from the chat, against file:// origins: fast-forward only, no force, conflicts leave nothing
// behind, a clone URL must be one the person pasted.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
let db: Database.Database;
let root: string;
let origin: string;
let work: string;
let other: string;
const USER = 'ts:addis@example.com';
const never = () => false;
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
const identity = (cwd: string) => {
  git(cwd, 'config', 'user.email', 't@t');
  git(cwd, 'config', 'user.name', 't');
};
const commit = (cwd: string, file: string, content: string, msg: string) => {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-qm', msg);
  return git(cwd, 'rev-parse', 'HEAD');
};
let d: GitOpsDeps;

beforeEach(() => {
  db = openTestDb();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loop-git-')));
  origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  identity(seed);
  commit(seed, 'a.txt', 'one\n', 'init');
  git(seed, 'push', '-q', origin, 'main');
  work = path.join(root, 'app');
  other = path.join(root, 'other');
  git(root, 'clone', '-q', origin, work);
  git(root, 'clone', '-q', origin, other);
  identity(work);
  identity(other);
  setSetting(db, 'prd_repo_allowlist', work);
  d = { allowFileUrls: true, cloneRoot: path.join(root, 'repos'), timeoutMs: 20_000 };
});
afterEach(async () => {
  await getOpsRunner().idle();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function chat() {
  const c = createConversation(db, { user_key: USER });
  return (text: string): ChatCtx => {
    appendMessage(db, c.id, USER, { role: 'user', content: text });
    const a = appendMessage(db, c.id, USER, { role: 'assistant', content: '' });
    return { messageId: a.id, conversationId: c.id, userKey: USER, label: 'addis' };
  };
}
async function prepared(turn: (t: string) => ChatCtx, text: string, args: Record<string, unknown>): Promise<OpsAction> {
  const p = await prepareGit(db, turn(text), args, d);
  if (!p.ok) throw new Error(JSON.stringify(p.missing));
  return p.action;
}
const question = async (turn: (t: string) => ChatCtx, args: Record<string, unknown>) => {
  const p = await prepareGit(db, turn('git'), args, d);
  return p.ok ? '' : p.missing.map((m) => m.question).join('\n');
};

describe('clone URLs', () => {
  it('https or ssh to a host; no credentials, no transport tricks, no local paths', () => {
    for (const ok of ['https://github.com/rapidsai/cucim', 'https://github.com/rapidsai/cucim.git', 'git@github.com:AddisLyu/TokenBar.git', 'ssh://git@gitlab.example.com/team/app.git']) {
      expect(validateCloneUrl(ok), ok).toBeNull();
    }
    for (const bad of [
      'ext::sh -c touch% /tmp/pwned',
      'fd::17',
      '--upload-pack=touch /tmp/x',
      '-u https://github.com/a/b',
      'https://user:ghp_secret@github.com/a/b',
      'https://github.com/a/b --config core.sshCommand=x',
      'file:///etc',
      '/home/auo001/secret-repo',
      'http://github.com/a/b',
    ]) {
      expect(validateCloneUrl(bad), bad).not.toBeNull();
    }
    expect(validateCloneUrl('file:///tmp/x/origin.git', true)).toBeNull();
    expect(redactUrl('fatal: could not read from https://bob:ghp_abc123@github.com/a/b.git')).toBe('fatal: could not read from https://***@github.com/a/b.git');
  });

  it('plain http only to the Gitea host; ssh with a port; still no credentials in a URL', () => {
    const gitea = { giteaHost: 'gitea.corp' };
    expect(validateCloneUrl('http://gitea.corp:3000/aoi/cf-aoi.git', gitea)).toBeNull();
    expect(validateCloneUrl('http://GITEA.corp/aoi/cf-aoi', gitea)).toBeNull();
    expect(validateCloneUrl('http://gitea.corp:3000/aoi/cf-aoi.git')).toMatch(/http/);
    expect(validateCloneUrl('http://github.com/a/b', gitea)).toContain('gitea.corp');
    expect(validateCloneUrl('http://gitea.corp.evil.com/a/b', gitea)).not.toBeNull();
    expect(validateCloneUrl('ssh://git@gitea.corp:2222/aoi/cf-aoi.git')).toBeNull();
    expect(validateCloneUrl('ssh://git@gitea.corp:2222/aoi/cf-aoi', gitea)).toBeNull();
    for (const bad of ['http://oauth2:tok@gitea.corp:3000/aoi/cf-aoi.git', 'http://tok@gitea.corp:3000/aoi/cf-aoi.git', 'ssh://git:pw@gitea.corp:2222/aoi/cf-aoi.git', 'ssh://root@gitea.corp:2222/aoi/cf-aoi.git', 'ssh://git@gitea.corp:2222/aoi']) {
      expect(validateCloneUrl(bad, gitea), bad).not.toBeNull();
    }
    expect(validateCloneUrl('file:///tmp/x/origin.git', { allowFile: true, giteaHost: 'gitea.corp' })).toBeNull();
    expect(validateCloneUrl('file:///tmp/x/origin.git', { giteaHost: 'gitea.corp' })).not.toBeNull();
    expect(cloneProtocols('https://github.com/a/b')).toBe('https:ssh');
    expect(cloneProtocols('http://gitea.corp:3000/a/b', gitea)).toBe('https:ssh:http');
    expect(cloneProtocols('http://github.com/a/b', gitea)).toBe('https:ssh');
    expect(cloneProtocols('file:///x', { allowFile: true })).toBe('https:ssh:file');
  });

  it('clones only a URL the person pasted, into the clone root, and makes it workable', async () => {
    const turn = chat();
    const url = `file://${origin}`;
    expect(await prepareGit(db, turn('幫我抓 repo'), { op: 'clone', url }, d)).toMatchObject({ ok: false, missing: [{ fact: 'url', question: expect.stringContaining('你貼過的') }] });
    // the prefix of a longer URL the person pasted is not what they pasted
    expect(await prepareGit(db, turn(`看看 ${url}-fork 這個`), { op: 'clone', url }, d)).toMatchObject({ ok: false, missing: [{ fact: 'url' }] });
    const a = await prepared(turn, `幫我抓 ${url}`, { op: 'clone', url });
    expect(a).toMatchObject({ kind: 'git', op: 'clone', target: 'origin', risk: 'normal', speed: 'slow' });
    const r = await runGit(db, a, d);
    expect(r).toMatchObject({ ok: true, detail: expect.stringContaining('已抓到') });
    const dest = path.join(root, 'repos', 'origin');
    expect(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8')).toBe('one\n');
    expect(getSetting(db, 'prd_repo_allowlist')).toBe(`${work},${dest}`);
    // a second clone into the same place is a question, not an overwrite
    expect(await question(turn, { op: 'clone', url })).toContain('已經存在');
  });

  it('a failed clone leaves no half-made directory', async () => {
    const turn = chat();
    const url = `file://${root}/missing.git`;
    const a = await prepared(turn, `抓 ${url}`, { op: 'clone', url });
    expect(await runGit(db, a, d)).toMatchObject({ ok: false, detail: expect.stringContaining('抓不下來') });
    expect(fs.existsSync(path.join(root, 'repos', 'missing'))).toBe(false);
  });
});

describe('pull', () => {
  it('fast-forwards a clean branch that is behind, listing what comes in', async () => {
    const turn = chat();
    expect(await question(turn, { op: 'pull', repo: 'app' })).toContain('已經是最新');
    commit(other, 'b.txt', 'two\n', 'add b');
    git(other, 'push', '-q', 'origin', 'main');
    const a = await prepared(turn, 'pull app', { op: 'pull', repo: 'app' });
    expect(a.summary).toContain('落後 1 個 commit');
    expect(a.summary).toMatch(/- [0-9a-f]{7,} add b/);
    const r = await confirmTyped(db, turn('確認'), undefined, never, { waitMs: 5000, git: (x, y) => runGit(x, y, d) });
    expect(r).toMatchObject({ ok: true, action: { status: 'done' } });
    expect(fs.readFileSync(path.join(work, 'b.txt'), 'utf8')).toBe('two\n');
    expect(getActionById(db, r.action!.id)!.result!.detail).toMatch(/已快轉/);
  });

  it('refuses uncommitted changes and a diverged branch, and says why', async () => {
    const turn = chat();
    commit(other, 'b.txt', 'two\n', 'add b');
    git(other, 'push', '-q', 'origin', 'main');
    fs.writeFileSync(path.join(work, 'a.txt'), 'edited\n');
    expect(await question(turn, { op: 'pull', repo: 'app' })).toMatch(/還沒提交.*a\.txt/);
    git(work, 'checkout', '-q', '--', 'a.txt');
    commit(work, 'c.txt', 'mine\n', 'local work');
    expect(await question(turn, { op: 'pull', repo: 'app' })).toContain('分岔');
  });

  it('waits while the engine verifies or merges a task into the same repo', async () => {
    const turn = chat();
    const t = createTask(db, { title: 'x', goal: 'a goal long enough', plan_ref: 'https://example.com/p.md', coding_tool: 'mock', verification_steps: ['true'], complexity: 'S', repo_path: work });
    setStatus(db, t.id, 'verifying');
    expect(await question(turn, { op: 'pull', repo: 'app' })).toContain(`任務 ${t.id} 正在驗證`);
  });
});

describe('push', () => {
  it('pushes new commits without force, and needs the code', async () => {
    const turn = chat();
    expect(await question(turn, { op: 'push', repo: 'app' })).toContain('沒有要推的新 commit');
    const sha = commit(work, 'c.txt', 'mine\n', 'local work');
    const a = await prepared(turn, 'push app', { op: 'push', repo: 'app' });
    expect(a).toMatchObject({ risk: 'high' });
    expect(a.summary).toContain('不 force');
    expect(a.summary).toContain('local work');
    expect(await confirmTyped(db, turn('確認'), undefined, never, { git: (x, y) => runGit(x, y, d) })).toMatchObject({ ok: false });
    await prepared(turn, 'push app', { op: 'push', repo: 'app' });
    const code = (db.prepare("SELECT code FROM ops_actions WHERE status = 'pending'").get() as { code: string }).code;
    const r = await confirmTyped(db, turn(`確認 ${code}`), undefined, never, { waitMs: 5000, git: (x, y) => runGit(x, y, d) });
    expect(r).toMatchObject({ ok: true, action: { status: 'done' } });
    expect(git(origin, 'rev-parse', 'main')).toBe(sha);
  });

  it('a new branch gets an upstream; a branch behind origin is not pushed over', async () => {
    const turn = chat();
    git(work, 'checkout', '-q', '-b', 'feature-x');
    commit(work, 'f.txt', 'f\n', 'feature');
    const a = await prepared(turn, 'push', { op: 'push', repo: 'app' });
    expect(a.summary).toContain('會建立並設為 upstream');
    expect(await runGit(db, a, d)).toMatchObject({ ok: true });
    expect(git(work, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/feature-x');
    git(work, 'checkout', '-q', 'main');
    commit(other, 'b.txt', 'two\n', 'theirs');
    git(other, 'push', '-q', 'origin', 'main');
    commit(work, 'c.txt', 'mine\n', 'mine');
    expect(await question(turn, { op: 'push', repo: 'app', branch: 'main' })).toContain('先 pull 或 merge');
  });

  it('if origin moved after the preparation, the push is rejected, never forced', async () => {
    const turn = chat();
    commit(work, 'c.txt', 'mine\n', 'mine');
    const a = await prepared(turn, 'push', { op: 'push', repo: 'app' });
    commit(other, 'b.txt', 'two\n', 'theirs');
    git(other, 'push', '-q', 'origin', 'main');
    const theirs = git(origin, 'rev-parse', 'main');
    expect(await runGit(db, a, d)).toMatchObject({ ok: false, detail: expect.stringContaining('不會 force') });
    expect(git(origin, 'rev-parse', 'main')).toBe(theirs);
  });
});

describe('exactly what was prepared', () => {
  it('a branch named like an option or a force marker is refused, and push never takes a bare name', async () => {
    const turn = chat();
    const sha = commit(work, 'c.txt', 'mine\n', 'mine');
    git(work, 'update-ref', 'refs/heads/+main', sha);
    git(work, 'update-ref', 'refs/heads/--force', sha);
    for (const b of ['+main', '--force', 'a:b', '../x']) expect(await question(turn, { op: 'push', repo: 'app', branch: b }), b).toContain('不是可以用的分支名稱');
    // even an action forged past the preparer cannot force: the runner checks the name again
    const forged = { ...(await prepared(turn, 'push', { op: 'push', repo: 'app' })) };
    forged.params = { ...(forged.params as object), branch: '+main' };
    commit(other, 'b.txt', 'two\n', 'theirs');
    git(other, 'push', '-q', 'origin', 'main');
    const theirs = git(origin, 'rev-parse', 'main');
    expect(await runGit(db, forged, d)).toMatchObject({ ok: false });
    expect(git(origin, 'rev-parse', 'main')).toBe(theirs);
  });

  it('push sends the prepared commit only; a commit added since is not pushed', async () => {
    const turn = chat();
    commit(work, 'c.txt', 'mine\n', 'listed');
    const a = await prepared(turn, 'push', { op: 'push', repo: 'app' });
    commit(work, 'd.txt', 'later\n', 'not listed');
    expect(await runGit(db, a, d)).toMatchObject({ ok: false, detail: expect.stringContaining('又動過了') });
    expect(git(origin, 'rev-parse', 'main')).not.toBe(git(work, 'rev-parse', 'HEAD'));
  });

  it('pull moves to the commit the preparation listed, even if origin moved on since', async () => {
    const turn = chat();
    const first = commit(other, 'b.txt', 'two\n', 'first');
    git(other, 'push', '-q', 'origin', 'main');
    const a = await prepared(turn, 'pull', { op: 'pull', repo: 'app' });
    commit(other, 'e.txt', 'three\n', 'second, after the preparation');
    git(other, 'push', '-q', 'origin', 'main');
    git(work, 'fetch', '-q', 'origin');
    expect(await runGit(db, a, d)).toMatchObject({ ok: true });
    expect(git(work, 'rev-parse', 'HEAD')).toBe(first);
  });

  it('a clone never removes a directory it did not make', async () => {
    const turn = chat();
    const url = `file://${origin}`;
    const a = await prepared(turn, `抓 ${url}`, { op: 'clone', url });
    const dest = path.join(root, 'repos', 'origin');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'keep.txt'), 'someone else\'s');
    expect(await runGit(db, a, d)).toMatchObject({ ok: false, detail: expect.stringContaining('已經存在') });
    expect(fs.readFileSync(path.join(dest, 'keep.txt'), 'utf8')).toBe("someone else's");
    expect(fs.readdirSync(path.join(root, 'repos'))).toEqual(['origin']);
  });
});

describe('merge', () => {
  it('fast-forwards the checked-out branch when it can', async () => {
    const turn = chat();
    git(work, 'checkout', '-q', '-b', 'feature');
    const sha = commit(work, 'f.txt', 'f\n', 'feature');
    git(work, 'checkout', '-q', 'main');
    const a = await prepared(turn, 'merge feature', { op: 'merge', repo: 'app', branch: 'feature' });
    expect(a).toMatchObject({ risk: 'high', params: { ff: true, checkedOut: true } });
    expect(a.summary).toContain('可以直接快轉');
    expect(await runGit(db, a, d)).toMatchObject({ ok: true, detail: expect.stringContaining('快轉') });
    expect(git(work, 'rev-parse', 'HEAD')).toBe(sha);
    expect(fs.existsSync(path.join(work, 'f.txt'))).toBe(true);
    expect(await question(turn, { op: 'merge', repo: 'app', branch: 'feature' })).toContain('已經在 main 裡了');
  });

  it('a real merge is made aside, then the checkout fast-forwards to it', async () => {
    const turn = chat();
    commit(other, 'b.txt', 'two\n', 'theirs');
    git(other, 'push', '-q', 'origin', 'main');
    commit(work, 'c.txt', 'mine\n', 'mine');
    const a = await prepared(turn, 'merge origin/main', { op: 'merge', repo: 'app', branch: 'origin/main' });
    expect(a.params).toMatchObject({ ff: false });
    expect(await runGit(db, a, d)).toMatchObject({ ok: true, detail: expect.stringContaining('合併 commit') });
    expect(git(work, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
    expect(fs.readFileSync(path.join(work, 'b.txt'), 'utf8')).toBe('two\n');
    expect(git(work, 'status', '--porcelain')).toBe('');
    expect(git(work, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  it('a conflict leaves the branch, the checkout and the worktree list exactly as they were', async () => {
    const turn = chat();
    commit(other, 'a.txt', 'theirs\n', 'theirs');
    git(other, 'push', '-q', 'origin', 'main');
    const mine = commit(work, 'a.txt', 'mine\n', 'mine');
    const a = await prepared(turn, 'merge origin/main', { op: 'merge', repo: 'app', branch: 'origin/main' });
    expect(await runGit(db, a, d)).toMatchObject({ ok: false, detail: expect.stringMatching(/有衝突.*a\.txt/) });
    expect(git(work, 'rev-parse', 'HEAD')).toBe(mine);
    expect(git(work, 'status', '--porcelain')).toBe('');
    expect(git(work, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  it('a branch that is not checked out moves by compare-and-swap, and not if it moved meanwhile', async () => {
    const turn = chat();
    git(work, 'branch', 'release');
    const sha = commit(work, 'n.txt', 'n\n', 'next');
    const a = await prepared(turn, 'merge main into release', { op: 'merge', repo: 'app', branch: 'main', into: 'release' });
    expect(a.params).toMatchObject({ ff: true, checkedOut: false });
    const b = { ...a, params: { ...a.params } };
    expect(await runGit(db, a, d)).toMatchObject({ ok: true });
    expect(git(work, 'rev-parse', 'release')).toBe(sha);
    // the same prepared merge again: release is no longer where the preparation saw it
    expect(await runGit(db, b, d)).toMatchObject({ ok: false, detail: expect.stringContaining('又動過了') });
  });

  it('never touches a branch another worktree has checked out', async () => {
    const turn = chat();
    const wt = path.join(root, 'wt');
    git(work, 'worktree', 'add', '-q', '-b', 'side', wt);
    commit(work, 'n.txt', 'n\n', 'next');
    expect(await question(turn, { op: 'merge', repo: 'app', branch: 'main', into: 'side' })).toContain('另一個 worktree');
  });
});

describe('the repo lock', () => {
  it('one git action per repo at a time; a failure releases it', async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const first = withRepoLock('/r', async () => {
      order.push('a1');
      await gate;
      order.push('a2');
      throw new Error('boom');
    });
    const second = withRepoLock('/r', async () => order.push('b'));
    const elsewhere = withRepoLock('/s', async () => order.push('s'));
    await elsewhere;
    expect(order).toEqual(['a1', 's']);
    release();
    await expect(first).rejects.toThrow('boom');
    await second;
    expect(order).toEqual(['a1', 's', 'a2', 'b']);
  });
});

describe('status', () => {
  it('branch, sync, changes and the last commit; credentials never shown', async () => {
    git(work, 'remote', 'set-url', 'origin', 'https://bob:ghp_abc@github.com/a/app.git');
    git(work, 'remote', 'set-url', '--push', 'origin', origin);
    fs.writeFileSync(path.join(work, 'a.txt'), 'edited\n');
    const s = await repoStatus(db, work, d);
    expect(s).toMatchObject({ name: 'app', branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, dirty: ['a.txt'], remote: 'https://***@github.com/a/app.git' });
    expect(s.last).toContain('init');
  });
});

describe('no synchronous subprocess', () => {
  it('chat operations never block the event loop on git', () => {
    const dir = path.join(__dirname, '..', 'chatops');
    const files = [...fs.readdirSync(dir).map((f) => path.join(dir, f)), path.join(__dirname, '..', 'git', 'async.ts')];
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/\b(execFileSync|spawnSync|execSync)\s*\(/);
      expect(src, f).not.toMatch(/import\s*\{[^}]*\b(execFileSync|spawnSync|execSync)\b[^}]*\}\s*from\s*'node:child_process'/);
    }
  });
});
