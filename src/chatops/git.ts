import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getBool, getNum, getSetting, setSetting } from '../db/index.js';
import { isEngineRepo, paths } from '../config.js';
import { gitAsync, GitError, redactUrl } from '../git/async.js';
import { mergingTaskIds } from '../orchestrator/mergeFlow.js';
import { getTask } from '../tasks.js';
import { listJobRepos } from '../plans/job.js';
import { createPending } from './actions.js';
import { resolveRepo } from './compose.js';
import { userTexts, saidByUser } from './provenance.js';
import type { PrepareOutcome } from './prepare.js';
import type { ActionResult, ChatCtx, OpsAction } from './types.js';

/**
 * git from the chat: clone (抓 repo), fetch, pull, push, merge — on the allow-listed repos only.
 *  - never force, never reset, never rebase; pull and merge move a checked-out branch only by a
 *    fast-forward (a real merge is made in a throwaway worktree first, then fast-forwarded to);
 *  - a branch that is not checked out moves only by a compare-and-swap update-ref;
 *  - one git action per repo at a time, and none while the engine verifies or merges a task there;
 *  - the engine's own repo is off limits unless ops_git_engine_repo is on;
 *  - everything is async with a timeout (src/git/async.ts): the tick loop never waits on a push.
 */

export interface GitOpsDeps {
  /** tests: allow file:// clone URLs (never in production: a clone URL comes from a person) */
  allowFileUrls?: boolean;
  cloneRoot?: string;
  timeoutMs?: number;
  cloneTimeoutMs?: number;
}

const timeout = (db: Database.Database, d: GitOpsDeps) => d.timeoutMs ?? Math.max(10, getNum(db, 'ops_git_timeout_sec', 120)) * 1000;
const str = (v: unknown, max = 300): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const no = (fact: string, question: string): PrepareOutcome => ({ ok: false, missing: [{ fact, question }] });
const expand = (p: string) => (p.startsWith('~') ? path.join(process.env.HOME ?? '', p.slice(1)) : p);

async function git(db: Database.Database, d: GitOpsDeps, repo: string, args: string[]): Promise<string> {
  return (await gitAsync(repo, args, { timeoutMs: timeout(db, d) })).stdout.trim();
}
async function tryGit(db: Database.Database, d: GitOpsDeps, repo: string, args: string[]): Promise<string | null> {
  try {
    return await git(db, d, repo, args);
  } catch {
    return null;
  }
}

export interface GitStatus {
  repo: string;
  name: string;
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  /** tracked files with uncommitted changes */
  dirty: string[];
  last: string | null;
  remote: string | null;
}

export async function repoStatus(db: Database.Database, repo: string, d: GitOpsDeps = {}): Promise<GitStatus> {
  const branch = await tryGit(db, d, repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const upstream = await tryGit(db, d, repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  let ahead: number | null = null;
  let behind: number | null = null;
  if (upstream) {
    const c = await tryGit(db, d, repo, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]);
    const m = /^(\d+)\s+(\d+)$/.exec(c ?? '');
    if (m) [ahead, behind] = [Number(m[1]), Number(m[2])];
  }
  // porcelain lines are 'XY path': not trimmed, the first line may start with a space
  const porcelain = await gitAsync(repo, ['status', '--porcelain', '--untracked-files=no'], { timeoutMs: timeout(db, d) }).then((r) => r.stdout, () => '');
  const dirty = porcelain.split('\n').filter((l) => l.length > 3).map((l) => l.slice(3));
  const last = await tryGit(db, d, repo, ['log', '-1', '--format=%h %s（%cr）']);
  const remote = await tryGit(db, d, repo, ['remote', 'get-url', 'origin']);
  return { repo, name: path.basename(repo), branch: branch === 'HEAD' ? null : branch, upstream, ahead, behind, dirty, last, remote: remote ? redactUrl(remote) : null };
}

export function statusLine(s: GitStatus): string {
  const sync = s.upstream ? (s.ahead || s.behind ? `領先 ${s.ahead ?? 0}、落後 ${s.behind ?? 0}（對 ${s.upstream}）` : `和 ${s.upstream} 同步`) : '沒有 upstream';
  return `| ${s.name} | ${s.branch ?? '（detached）'} | ${sync} | ${s.dirty.length ? `${s.dirty.length} 個檔案有未提交修改` : '乾淨'} | ${s.last ?? '—'} |`;
}

const locks = new Map<string, Promise<void>>();

/** One git action per repo at a time (this process). */
export async function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(repo) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((r) => (done = r));
  const tail = prev.then(() => mine);
  locks.set(repo, tail);
  await prev;
  try {
    return await fn();
  } finally {
    done();
    if (locks.get(repo) === tail) locks.delete(repo);
  }
}

const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

/** The engine is verifying or merging a task into this repo right now: git from the chat waits. */
export function repoBusy(db: Database.Database, repo: string): string | null {
  const r = real(repo);
  for (const t of db.prepare("SELECT id, repo_path FROM tasks WHERE status = 'verifying' AND repo_path IS NOT NULL").all() as Array<{ id: string; repo_path: string }>) {
    if (real(t.repo_path) === r) return `任務 ${t.id} 正在驗證並準備合併到這個 repo，等它結束再做`;
  }
  for (const id of mergingTaskIds()) {
    const t = getTask(db, id);
    if (t?.repo_path && real(t.repo_path) === r) return `任務 ${t.id} 正在合併到這個 repo，等它結束再做`;
  }
  return null;
}

function engineGuard(db: Database.Database, repo: string): string | null {
  return isEngineRepo(repo) && !getBool(db, 'ops_git_engine_repo', false)
    ? '這是引擎自己的 repo：從對話 pull／push／merge 預設關閉（會觸發重建與重啟、切斷對話）。需要的話在設定開 ops_git_engine_repo'
    : null;
}

/** A clone URL someone typed: https or ssh to a host, no credentials, no transport tricks. */
export function validateCloneUrl(url: string, allowFile = false): string | null {
  const u = url.trim();
  if (!u || /\s/.test(u) || u.startsWith('-')) return '網址格式不對';
  if (/^(ext|fd)::/i.test(u) || /--upload-pack|--config/i.test(u)) return '不接受這種網址';
  if (/^file:\/\//i.test(u)) return allowFile ? null : '只能抓網路上的 repo（https 或 ssh）';
  if (/^https:\/\/[^/@\s]+@/i.test(u)) return '網址裡不要放帳號或 token（伺服器已經設好 git 的認證）';
  if (/^https:\/\/[a-z0-9.-]+(:\d+)?\/[\w.~-]+\/[\w.~/-]+$/i.test(u)) return null;
  if (/^(ssh:\/\/)?git@[a-z0-9.-]+[:/][\w.~-]+\/[\w.~-]+$/i.test(u)) return null;
  return '只能抓 https://主機/擁有者/專案 或 git@主機:擁有者/專案 這種網址';
}

export function cloneRoot(db: Database.Database, d: GitOpsDeps = {}): string {
  return d.cloneRoot ?? expand(getSetting(db, 'git_clone_root') || path.join(process.env.HOME ?? '', 'Addis', 'repos'));
}

const repoNameOf = (url: string): string =>
  (url.replace(/\/+$/, '').split(/[/:]/).pop() ?? '')
    .replace(/\.git$/, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(0, 60);

export async function prepareGit(db: Database.Database, chat: ChatCtx, args: Record<string, unknown>, d: GitOpsDeps = {}): Promise<PrepareOutcome> {
  const op = str(args.op) as 'clone' | 'pull' | 'push' | 'merge';
  if (op === 'clone') {
    const url = str(args.url, 500);
    if (!url) return no('url', '要抓哪個 repo？把網址貼上來');
    const texts = userTexts(db, chat.conversationId);
    if (!saidByUser(texts, url) && !saidByUser(texts, url.replace(/\.git$/, ''))) return no('url', '要抓的網址要是你貼過的，請把網址貼上來');
    const bad = validateCloneUrl(url, d.allowFileUrls);
    if (bad) return no('url', bad);
    const name = repoNameOf(url);
    if (!name) return no('url', '看不出這個網址的 repo 名稱');
    const root = cloneRoot(db, d);
    const dest = path.join(root, name);
    if (fs.existsSync(dest)) return no('url', `${dest} 已經存在；要更新它請說「pull ${name}」`);
    const action = createPending(db, chat, {
      kind: 'git',
      op: 'clone',
      target: name,
      params: { url, dest },
      expect: null,
      summary: [`把 ${redactUrl(url)} 抓到 ${dest}`, '- 抓完後加進可以改的 repo 清單，之後就能在這裡開工作'].join('\n'),
      risk: 'normal',
      speed: 'slow',
    });
    return { ok: true, action, warnings: [] };
  }
  if (op !== 'pull' && op !== 'push' && op !== 'merge') return no('op', 'git 動作只有 clone（抓 repo）、pull、push、merge');
  const r = resolveRepo(db, str(args.repo), null);
  if (!r.ok) return no('repo', r.question);
  const repo = r.value.path;
  const eg = engineGuard(db, repo);
  if (eg) return no('repo', eg);
  const busy = repoBusy(db, repo);
  if (busy) return no('repo', busy);
  // fetch first: what origin has now decides whether this is a fast-forward
  try {
    await git(db, d, repo, ['fetch', '--prune', 'origin']);
  } catch (err) {
    return no('repo', `抓不到 origin 的最新狀態：${(err as Error).message}`);
  }
  const st = await repoStatus(db, repo, d);

  if (op === 'pull') {
    if (!st.branch) return no('repo', `${st.name} 現在不在任何分支上（detached），不能 pull`);
    if (!st.upstream) return no('repo', `${st.name} 的 ${st.branch} 沒有對應的遠端分支`);
    if (st.dirty.length) return no('repo', `${st.name} 有 ${st.dirty.length} 個檔案還沒提交（${st.dirty.slice(0, 3).join('、')}），不能 pull；先提交或收起來`);
    if ((st.behind ?? 0) === 0) return no('state', `${st.name} 的 ${st.branch} 已經是最新（和 ${st.upstream} 同步），不用 pull`);
    if ((st.ahead ?? 0) > 0) return no('state', `${st.name} 的 ${st.branch} 和 ${st.upstream} 分岔了（本地領先 ${st.ahead}、落後 ${st.behind}），不能快轉；要合併請說 merge`);
    const incoming = await tryGit(db, d, repo, ['log', '--format=%h %s', `HEAD..${st.upstream}`, '-8']);
    const action = createPending(db, chat, {
      kind: 'git',
      op: 'pull',
      target: st.name,
      params: { repo, branch: st.branch, upstream: st.upstream },
      expect: { head: await tryGit(db, d, repo, ['rev-parse', 'HEAD']) },
      summary: [`把 ${st.name} 的 ${st.branch} 快轉到 ${st.upstream}（落後 ${st.behind} 個 commit）`, ...(incoming ? incoming.split('\n').map((l) => `- ${l}`) : [])].join('\n'),
      risk: 'normal',
      speed: 'slow',
    });
    return { ok: true, action, warnings: [] };
  }

  if (op === 'push') {
    const branch = str(args.branch, 200) || st.branch;
    if (!branch) return no('branch', '要推哪個分支？');
    const local = await tryGit(db, d, repo, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    if (!local) return no('branch', `${st.name} 沒有 ${branch} 這個分支`);
    const remote = await tryGit(db, d, repo, ['rev-parse', '--verify', `refs/remotes/origin/${branch}`]);
    let commits: string | null;
    if (remote) {
      const behind = Number((await tryGit(db, d, repo, ['rev-list', '--count', `${branch}..origin/${branch}`])) ?? '0');
      if (behind > 0) return no('state', `origin/${branch} 有 ${behind} 個你本地沒有的 commit，直接推會蓋掉——先 pull 或 merge`);
      commits = await tryGit(db, d, repo, ['log', '--format=%h %s', `origin/${branch}..${branch}`, '-8']);
      if (!commits) return no('state', `${branch} 沒有要推的新 commit`);
    } else {
      commits = await tryGit(db, d, repo, ['log', '--format=%h %s', branch, '-5']);
    }
    const action = createPending(db, chat, {
      kind: 'git',
      op: 'push',
      target: st.name,
      params: { repo, branch, setUpstream: !remote },
      expect: { local },
      summary: [`把 ${st.name} 的 ${branch} 推到 origin${remote ? '' : '（遠端還沒有這個分支，會建立並設為 upstream）'}，不 force`, ...(commits ? commits.split('\n').map((l) => `- ${l}`) : [])].join('\n'),
      risk: 'high',
      speed: 'slow',
    });
    return { ok: true, action, warnings: [] };
  }

  // merge
  const from = str(args.branch, 200);
  const into = str(args.into, 200) || st.branch;
  if (!from) return no('branch', '要把哪個分支合併進來？（例：origin/main 或 feature-x）');
  if (!into) return no('into', '要合併到哪個分支？');
  const fromSha = await tryGit(db, d, repo, ['rev-parse', '--verify', `${from}^{commit}`]);
  const intoSha = await tryGit(db, d, repo, ['rev-parse', '--verify', `refs/heads/${into}`]);
  if (!fromSha) return no('branch', `${st.name} 找不到 ${from}`);
  if (!intoSha) return no('into', `${st.name} 沒有 ${into} 這個分支`);
  if ((await tryGit(db, d, repo, ['merge-base', '--is-ancestor', fromSha, intoSha])) !== null) return no('state', `${from} 已經在 ${into} 裡了，不用合併`);
  const ff = (await tryGit(db, d, repo, ['merge-base', '--is-ancestor', intoSha, fromSha])) !== null;
  const where = checkedOutAt(await tryGit(db, d, repo, ['worktree', 'list', '--porcelain']), into);
  if (where && real(where) !== real(repo)) return no('into', `${into} 正被另一個 worktree（${where}）用著，不能從這裡動它`);
  if (where && st.dirty.length) return no('repo', `${st.name} 有 ${st.dirty.length} 個檔案還沒提交，${into} 正在用，不能合併`);
  const count = await tryGit(db, d, repo, ['rev-list', '--count', `${intoSha}..${fromSha}`]);
  const action = createPending(db, chat, {
    kind: 'git',
    op: 'merge',
    target: st.name,
    params: { repo, from, into, fromSha, intoSha, ff, checkedOut: Boolean(where) },
    expect: { intoSha },
    summary: [
      `把 ${from} 合併到 ${st.name} 的 ${into}（${count ?? '?'} 個 commit）`,
      ff ? '- 可以直接快轉，不會產生合併 commit' : '- 不能快轉：會先在暫時的 worktree 做一個合併 commit，沒有衝突才把分支快轉過去；有衝突就放棄並列出檔案',
      '- 不會推到遠端（要推再說 push）',
    ].join('\n'),
    risk: 'high',
    speed: 'slow',
  });
  return { ok: true, action, warnings: [] };
}

/** Where `branch` is checked out, from `git worktree list --porcelain` (null = nowhere). */
function checkedOutAt(porcelain: string | null, branch: string): string | null {
  let cur: string | null = null;
  for (const line of (porcelain ?? '').split('\n')) {
    if (line.startsWith('worktree ')) cur = line.slice(9);
    else if (line === `branch refs/heads/${branch}`) return cur;
  }
  return null;
}

function addToAllowlist(db: Database.Database, dir: string): void {
  const cur = (getSetting(db, 'prd_repo_allowlist') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!cur.includes(dir)) setSetting(db, 'prd_repo_allowlist', [...cur, dir].join(','));
}

/** Run a confirmed git action (the OpsRunner's deps.git). */
export async function runGit(db: Database.Database, a: OpsAction, d: GitOpsDeps = {}): Promise<ActionResult> {
  const p = a.params as Record<string, unknown>;
  if (a.op === 'clone') {
    const url = String(p.url);
    const dest = String(p.dest);
    const bad = validateCloneUrl(url, d.allowFileUrls);
    if (bad) return { ok: false, detail: bad };
    if (fs.existsSync(dest)) return { ok: false, detail: `${dest} 已經存在` };
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    return withRepoLock(dest, async () => {
      try {
        await gitAsync(path.dirname(dest), ['clone', '--', url, dest], {
          timeoutMs: d.cloneTimeoutMs ?? Math.max(30, getNum(db, 'ops_git_clone_timeout_sec', 900)) * 1000,
          allowProtocols: d.allowFileUrls ? 'https:ssh:file' : 'https:ssh',
        });
      } catch (err) {
        fs.rmSync(dest, { recursive: true, force: true });
        return { ok: false, detail: `抓不下來：${(err as Error).message}` };
      }
      addToAllowlist(db, dest);
      const branch = await tryGit(db, d, dest, ['rev-parse', '--abbrev-ref', 'HEAD']);
      return { ok: true, detail: `已抓到 ${dest}（分支 ${branch ?? '?'}），已加進可以改的 repo 清單`, data: { repo: dest } };
    });
  }
  const repo = String(p.repo);
  if (!listJobRepos(db).some((r) => r.path === repo)) return { ok: false, detail: `${repo} 已經不在可以改的 repo 清單裡` };
  return withRepoLock(repo, async () => {
    const eg = engineGuard(db, repo);
    if (eg) return { ok: false, detail: eg };
    const busy = repoBusy(db, repo);
    if (busy) return { ok: false, detail: busy };
    try {
      const res = a.op === 'pull' ? await pull(db, d, repo, p) : a.op === 'push' ? await push(db, d, repo, p) : await merge(db, d, repo, p);
      if (res.ok && a.op !== 'push' && isEngineRepo(repo)) setSetting(db, 'self_update_pending', 'true');
      return res;
    } catch (err) {
      return { ok: false, detail: err instanceof GitError ? err.message : (err as Error).message };
    }
  });
}

async function pull(db: Database.Database, d: GitOpsDeps, repo: string, p: Record<string, unknown>): Promise<ActionResult> {
  const st = await repoStatus(db, repo, d);
  if (st.branch !== p.branch) return { ok: false, detail: `${st.name} 現在在 ${st.branch ?? 'detached'}，不是準備時的 ${String(p.branch)}，沒有 pull` };
  if (st.dirty.length) return { ok: false, detail: `${st.name} 有未提交的修改，沒有 pull` };
  const before = await git(db, d, repo, ['rev-parse', '--short', 'HEAD']);
  await git(db, d, repo, ['pull', '--ff-only']);
  const after = await git(db, d, repo, ['rev-parse', '--short', 'HEAD']);
  return { ok: true, detail: before === after ? `${st.name} 已經是最新` : `${st.name} 的 ${st.branch} 已快轉：${before} → ${after}` };
}

async function push(db: Database.Database, d: GitOpsDeps, repo: string, p: Record<string, unknown>): Promise<ActionResult> {
  const branch = String(p.branch);
  const args = p.setUpstream ? ['push', '-u', 'origin', branch] : ['push', 'origin', branch];
  try {
    await git(db, d, repo, args);
  } catch (err) {
    const msg = (err as Error).message;
    if (/non-fast-forward|fetch first|rejected/i.test(msg)) return { ok: false, detail: `遠端有新的 commit，沒有推（不會 force）；先 pull 或 merge 再推` };
    throw err;
  }
  return { ok: true, detail: `${path.basename(repo)} 的 ${branch} 已推到 origin` };
}

async function merge(db: Database.Database, d: GitOpsDeps, repo: string, p: Record<string, unknown>): Promise<ActionResult> {
  const into = String(p.into);
  const from = String(p.from);
  const intoSha = await tryGit(db, d, repo, ['rev-parse', '--verify', `refs/heads/${into}`]);
  if (!intoSha || intoSha !== p.intoSha) return { ok: false, detail: `${into} 在準備之後又動過了，沒有合併；請重新準備` };
  const fromSha = String(p.fromSha);
  const where = checkedOutAt(await tryGit(db, d, repo, ['worktree', 'list', '--porcelain']), into);
  if (where && real(where) !== real(repo)) return { ok: false, detail: `${into} 正被另一個 worktree 用著` };
  let target = fromSha;
  if (!p.ff) {
    // the merge commit is made in a throwaway worktree; the user's checkout only ever fast-forwards
    const tmp = path.join(paths.worktreesDir, `chatops-merge-${Date.now().toString(36)}`);
    await git(db, d, repo, ['worktree', 'add', '--detach', tmp, intoSha]);
    try {
      try {
        await git(db, d, tmp, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${from} into ${into}（對話操作）`, fromSha]);
      } catch {
        const files = (await tryGit(db, d, tmp, ['diff', '--name-only', '--diff-filter=U'])) ?? '';
        await tryGit(db, d, tmp, ['merge', '--abort']);
        return { ok: false, detail: `有衝突，沒有合併（${into} 沒動）：${files.split('\n').filter(Boolean).slice(0, 10).join('、') || '（看不出是哪些檔案）'}` };
      }
      target = await git(db, d, tmp, ['rev-parse', 'HEAD']);
    } finally {
      await tryGit(db, d, repo, ['worktree', 'remove', '--force', tmp]);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  if (where) {
    const st = await repoStatus(db, repo, d);
    if (st.dirty.length) return { ok: false, detail: `${st.name} 有未提交的修改，沒有動 ${into}` };
    await git(db, d, repo, ['merge', '--ff-only', target]);
  } else {
    await git(db, d, repo, ['update-ref', `refs/heads/${into}`, target, intoSha]);
  }
  const short = await git(db, d, repo, ['rev-parse', '--short', target]);
  return { ok: true, detail: `${from} 已合併到 ${into}（${p.ff ? '快轉' : '合併 commit'} ${short}）；還沒推到遠端` };
}
