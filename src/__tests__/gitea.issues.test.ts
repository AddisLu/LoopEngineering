import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting, getSetting } from '../db/index.js';
import { createTask, getTask, setStatus } from '../tasks.js';
import { giteaClient } from '../git/gitea.js';
import { linkIssue, getIssueLink, postIssueUpdate, pumpGiteaIssues, resetIssuePoller, issueComment } from '../integrations/giteaIssues.js';
import { escalateTask, TaskActionError } from '../taskActions.js';

let db: Database.Database;
type Call = { url: string; method: string; body: unknown };

/** A tiny in-memory Gitea: comments, edits, closes, and a labelled issue list. */
function fakeGitea(opts: { issues?: unknown[]; failComment?: boolean } = {}) {
  const calls: Call[] = [];
  let nextId = 100;
  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u, method, body });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (/\/issues\/\d+\/comments$/.test(u) && method === 'POST') {
      if (opts.failComment) return json({ message: 'nope' }, 500);
      return json({ id: nextId++, html_url: 'http://g/c', body: body?.body ?? '' }, 201);
    }
    if (/\/issues\/comments\/\d+$/.test(u) && method === 'PATCH') return json({ id: Number(u.split('/').pop()), html_url: 'http://g/c', body: body?.body ?? '' });
    if (/\/issues\/\d+$/.test(u) && method === 'PATCH') return json({ number: 12, state: 'closed' });
    if (/\/issues\?/.test(u) || /\/issues$/.test(u)) return json(opts.issues ?? []);
    return json({ message: 'not found' }, 404);
  };
  return { calls, client: giteaClient({ url: 'http://gitea.corp:3000', token: 't' }, { fetchImpl: fetchImpl as typeof fetch }) };
}

beforeEach(() => {
  db = openTestDb();
  resetIssuePoller();
  db.prepare("INSERT INTO repos (id, name, remote_url, local_path, gitea_owner, gitea_repo) VALUES ('r_1', 'cf-aoi', 'http://gitea.corp:3000/aoi/cf-aoi', '/tmp/cf-aoi', 'aoi', 'cf-aoi')").run();
});
afterEach(() => db.close());

function issueTicket() {
  const t = createTask(db, { title: 'bypass_edge_x 第二次沒生效', goal: 'fix it', plan_ref: 'https://e/p.md', coding_tool: 'mock', verification_steps: ['true'] });
  db.prepare("UPDATE tasks SET repo_id = 'r_1', source_ref = 'gitea:aoi/cf-aoi#12', analysis_json = ? WHERE id = ?").run(
    JSON.stringify({ kind: 'bugfix', causes: [{ file: 'src/control/recipe_loader.cpp', why: '第二次載入提前 return' }], checks: [{ name: '建置', on: true }, { name: '圖資回歸', on: false }] }),
    t.id,
  );
  linkIssue(db, t.id, { repoId: 'r_1', owner: 'aoi', repo: 'cf-aoi', number: 12, url: 'http://gitea.corp:3000/aoi/cf-aoi/issues/12' });
  return getTask(db, t.id)!;
}

describe('Gitea issue comment-back', () => {
  it('does nothing for a task without an issue link', async () => {
    const t = createTask(db, { title: 'x', goal: 'y', plan_ref: 'https://e/p.md', coding_tool: 'mock', verification_steps: ['true'] });
    const g = fakeGitea();
    expect(await postIssueUpdate(db, t, 'analysis', { client: g.client })).toBe(false);
    expect(g.calls).toEqual([]);
  });

  it('posts each update once, edits the live check comment in place, and closes the issue when asked', async () => {
    const t = issueTicket();
    const g = fakeGitea();
    expect(await postIssueUpdate(db, t, 'analysis', { client: g.client, publicUrl: 'http://loop' })).toBe(true);
    expect(await postIssueUpdate(db, t, 'analysis', { client: g.client })).toBe(true); // already said
    expect(g.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    const first = g.calls[0]!.body as { body: string };
    expect(first.body).toContain('Loop 的分析');
    expect(first.body).toContain('`src/control/recipe_loader.cpp`：第二次載入提前 return');
    expect(first.body).toContain('- [ ] 建置');
    expect(first.body).not.toContain('圖資回歸'); // unticked checks are not promised
    expect(first.body).toContain('http://loop/fix.html?id=');

    await postIssueUpdate(db, t, 'verify', { client: g.client });
    await postIssueUpdate(db, t, 'verify', { client: g.client });
    expect(g.calls.filter((c) => c.method === 'PATCH' && /comments\/\d+$/.test(c.url))).toHaveLength(1);

    await postIssueUpdate(db, t, 'returned', { client: g.client }, { feedback: '門檻還是不對' });
    await postIssueUpdate(db, t, 'returned', { client: g.client }, { feedback: '再改一次' });
    expect(Object.keys(JSON.parse(getIssueLink(db, t.id)!.posted_json))).toEqual(['analysis', 'verify', 'returned_1', 'returned_2']);

    await postIssueUpdate(db, t, 'done', { client: g.client }, { closeIssue: true });
    expect(g.calls.some((c) => c.method === 'PATCH' && /issues\/12$/.test(c.url) && (c.body as { state: string }).state === 'closed')).toBe(true);
    expect(getIssueLink(db, t.id)!.closed_at).not.toBeNull();
  });

  it('respects both switches, and a Gitea error is a note, never a throw', async () => {
    const t = issueTicket();
    const g = fakeGitea({ failComment: true });
    expect(await postIssueUpdate(db, t, 'started', { client: g.client })).toBe(false);
    setSetting(db, 'gitea_issue_comments', 'false');
    const g2 = fakeGitea();
    expect(await postIssueUpdate(db, t, 'started', { client: g2.client })).toBe(false);
    setSetting(db, 'gitea_issue_comments', 'true');
    db.prepare("UPDATE repos SET issue_comments = 0 WHERE id = 'r_1'").run();
    expect(await postIssueUpdate(db, t, 'started', { client: g2.client })).toBe(false);
    expect(g2.calls).toEqual([]);
    expect(issueComment(db, t, 'done')).toContain('已合併到');
  });
});

describe('Gitea label poller', () => {
  const issue = (n: number) => ({ number: n, title: `issue ${n}`, body: 'b', state: 'open', html_url: `http://gitea.corp:3000/aoi/cf-aoi/issues/${n}`, labels: [{ id: 1, name: 'loop', color: 'f00' }], user: { login: 'eng' }, created_at: null, updated_at: null });

  it('stays idle without a labelled repo, then opens one ticket per new labelled issue and comments', async () => {
    const g = fakeGitea({ issues: [issue(7), issue(8)] });
    const created: number[] = [];
    const createFromIssue = async (_db: Database.Database, ref: { number: number }) => {
      created.push(ref.number);
      const t = createTask(db, { title: `t${ref.number}`, goal: 'g', plan_ref: 'https://e/p.md', coding_tool: 'mock', verification_steps: ['true'] });
      db.prepare('UPDATE tasks SET source_ref = ? WHERE id = ?').run(`gitea:aoi/cf-aoi#${ref.number}`, t.id);
      return getTask(db, t.id)!;
    };
    expect(await pumpGiteaIssues(db, { client: g.client, createFromIssue, now: () => 1_000_000 })).toBe(0);
    expect(g.calls).toEqual([]);

    db.prepare("UPDATE repos SET issue_label = 'loop' WHERE id = 'r_1'").run();
    expect(await pumpGiteaIssues(db, { client: g.client, createFromIssue, now: () => 2_000_000 })).toBe(2);
    expect(created).toEqual([7, 8]);
    expect(g.calls[0]!.url).toContain('labels=loop');
    expect(g.calls.filter((c) => c.method === 'POST' && (c.body as { body: string }).body.includes('Loop 已接單'))).toHaveLength(2);
    expect(getSetting(db, 'gitea_issue_cursor')).not.toBe('');

    // throttled inside the interval, and idempotent after it
    expect(await pumpGiteaIssues(db, { client: g.client, createFromIssue, now: () => 2_000_000 + 60_000 })).toBe(0);
    expect(await pumpGiteaIssues(db, { client: g.client, createFromIssue, now: () => 2_000_000 + 11 * 60_000 })).toBe(0);
    expect(created).toEqual([7, 8]);
  });
});

describe('再試一次（換模型）', () => {
  it('moves a stopped task to the next model on the ladder, or the one picked', () => {
    setSetting(db, 'fix_escalation', 'local:qwen3-coder-next,local:glm53-flash');
    const t = createTask(db, { title: 'x', goal: 'y', plan_ref: 'https://e/p.md', coding_tool: 'mock', verification_steps: ['true'], model: 'local:qwen3-coder-next' });
    expect(() => escalateTask(db, t.id)).toThrow(TaskActionError); // a draft is not stopped
    setStatus(db, t.id, 'attention');
    const a = escalateTask(db, t.id, { by: '呂侑儒' });
    expect(a).toMatchObject({ model: 'local:glm53-flash', status: 'queued', ladder_step: 2, fix_attempts: 0 });
    setStatus(db, t.id, 'attention');
    expect(() => escalateTask(db, t.id)).toThrow('沒有下一個模型');
    expect(escalateTask(db, t.id, { model: 'local:deepseek-v4-flash' }).model).toBe('local:deepseek-v4-flash');
  });
});
