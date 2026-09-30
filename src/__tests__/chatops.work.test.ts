import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { setSetting, openTestDb, setSetting } from '../db/index.js';
import { appendMessage, createConversation, getMessage } from '../chat/store.js';
import { getDraft } from '../prd/drafts.js';
import { lintPrd } from '../prd/lint.js';
import { composePrd } from '../../web/prd-compose.js';
import { createPlan } from '../plans/store.js';
import { factsFrom, prepareWork } from '../chatops/prepare.js';
import type { ChatCtx } from '../chatops/types.js';

// New work from the chat: the model only collects facts; the template supplies the rest, the
// verification must have a real source, and the draft reopens unchanged in the 工作流程 editor.
let db: Database.Database;
let root: string;
let repo: string;
const USER = 'ts:addis@example.com';
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString();

beforeEach(() => {
  db = openTestDb();
  // recipes from an empty dir: no real recipe files, no `docker images` probe
  setSetting(db, 'local_vllm_repo', fs.mkdtempSync(path.join(os.tmpdir(), 'loop-recipes-')));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-work-'));
  repo = path.join(root, 'login-app');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc' } }));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  setSetting(db, 'prd_repo_allowlist', repo);
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function turn(texts: string[]): ChatCtx {
  const c = createConversation(db, { user_key: USER });
  for (const t of texts) {
    appendMessage(db, c.id, USER, { role: 'user', content: t });
    appendMessage(db, c.id, USER, { role: 'assistant', content: 'ok' });
  }
  const a = appendMessage(db, c.id, USER, { role: 'assistant', content: '' });
  return { messageId: a.id, conversationId: c.id, userKey: USER, label: 'addis' };
}
const deps = { reviewExec: async () => null };
const bugfix = (over: Record<string, unknown> = {}) =>
  factsFrom({ kind: 'bugfix', title: '登入逾時要顯示錯誤', expected: '網路慢時十秒內顯示錯誤訊息並可以重試', repro: '把網路限速到 2G 後按登入，畫面永遠轉圈', repo: 'login-app', ...over })!;

describe('prepareWork', () => {
  it('asks for what the template needs, in one pass', async () => {
    const r = await prepareWork(db, turn(['登入會卡住']), factsFrom({ kind: 'bugfix', title: '登入卡住', expected: '不要卡住' })!, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.missing.map((m) => m.fact)).toEqual(['expected', 'repro']);
    expect(r.missing[1]!.question).toContain('怎麼重現');
  });

  it('never takes a verification command the person did not give', async () => {
    const r = await prepareWork(db, turn(['登入會卡住，請修']), bugfix({ verify: ['npm run e2e'] }), deps);
    expect(r).toMatchObject({ ok: false, missing: [{ fact: 'verify', question: expect.stringContaining('親口給的') }] });
    const ok = await prepareWork(db, turn(['驗證就跑 `npm run e2e` 吧']), bugfix({ verify: ['npm run e2e'], notes: ['不要動 API'] }), deps);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    // what will run on this machine is on the card as it will run
    expect(ok.action.summary).toContain('  - `npm run e2e`');
    expect(ok.action.summary).toContain('- 補充與限制：不要動 API');
    // a command lifted out of a longer line of pasted text does not count as given
    const readme = `${'README 摘錄：這個專案的說明很長。'.repeat(20)}\n要清快取就跑 rm -rf build 再重跑`;
    const lifted = await prepareWork(db, turn([readme]), bugfix({ verify: ['rm -rf build'] }), deps);
    expect(lifted).toMatchObject({ ok: false, missing: [{ fact: 'verify' }] });
    const partial = await prepareWork(db, turn(['驗證就跑 make deploy-prod --force-all 吧']), bugfix({ verify: ['make deploy-prod'] }), deps);
    expect(partial).toMatchObject({ ok: false, missing: [{ fact: 'verify' }] });
    const ownLine = await prepareWork(db, turn([`${'很長的說明。'.repeat(40)}\n驗證指令：\nnpm run e2e`]), bugfix({ verify: ['npm run e2e'] }), deps);
    expect(ownLine.ok).toBe(true);
  });

  it('with nothing given, uses what the repo offers and says so', async () => {
    const r = await prepareWork(db, turn(['登入會卡住，請修']), bugfix(), deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.action.summary).toContain('- 驗證：偵測到的驗證指令（請確認）\n  - `npm run typecheck`\n  - `npm test`');
    expect(r.action.summary).toContain('repo：login-app · main');
    expect(r.action).toMatchObject({ kind: 'work', op: 'submit', status: 'pending', risk: 'normal' });
  });

  it('composes a PRD the gate accepts, and the draft reopens exactly as prepared', async () => {
    const ctx = turn(['登入會卡住，請修']);
    const r = await prepareWork(db, ctx, bugfix({ files: ['src/login.ts'], notes: ['不能改 API'] }), deps);
    if (!r.ok) throw new Error(JSON.stringify(r.missing));
    expect(lintPrd(r.markdown!).missing).toEqual([]);
    expect(r.markdown).toContain('- `src/login.ts`');
    expect(r.markdown).toContain('不能改 API');
    expect(r.markdown).toContain('先新增重現此 bug 的測試，再修'); // the bugfix template's constraint
    const draft = getDraft(db, USER, r.action.draft_id!)!;
    expect(composePrd(JSON.parse(draft.form_json!))).toBe(draft.markdown);
    expect(getMessage(db, ctx.messageId, USER)?.message.draft_id).toBe(draft.id);
  });

  it('a 驗證方案 brings its yardstick; perf needs numbers that improve', async () => {
    const plan = createPlan(db, { name: 'login 量尺', repo_path: repo, steps: ['npm test'], metrics: 'p95_ms <= 300', protected_paths: ['bench/**'], manual_checks: [], domain: 'typescript' } as never, 'test');
    const vague = await prepareWork(db, turn(['登入要快一點']), factsFrom({ kind: 'perf', title: '登入加速', expected: '登入要快很多，體感明顯', baseline: '很慢', target: '快一點', plan: plan.name })!, deps);
    expect(vague).toMatchObject({ ok: false });
    if (vague.ok) return;
    expect(vague.missing.map((m) => m.fact)).toEqual(['baseline', 'target']);
    const r = await prepareWork(db, turn(['登入要快一點']), factsFrom({ kind: 'perf', title: '登入加速', expected: '登入的 p95 要降到 300 ms 內', baseline: '420 ms', target: '300 ms', plan: plan.name })!, deps);
    if (!r.ok) throw new Error(JSON.stringify(r.missing));
    expect(r.markdown).toContain('## 驗收指標 (Metrics)');
    expect(r.markdown).toContain('p95_ms <= 300');
    expect(r.markdown).toContain('bench/**');
    expect(r.action.summary).toContain('驗證方案「login 量尺」');
    expect(r.action.params).toMatchObject({ verify_plan_id: plan.id });
  });

  it('names the repos when the one asked for is ambiguous or unknown', async () => {
    const other = path.join(root, 'login-admin');
    fs.mkdirSync(other);
    git(other, 'init', '-q', '-b', 'main');
    setSetting(db, 'prd_repo_allowlist', `${repo},${other}`);
    const amb = await prepareWork(db, turn(['修登入']), bugfix({ repo: 'login' }), deps);
    expect(amb).toMatchObject({ ok: false, missing: [{ fact: 'repo', question: expect.stringMatching(/login-admin、login-app|login-app、login-admin/) }] });
    const none = await prepareWork(db, turn(['修登入']), bugfix({ repo: 'payments' }), deps);
    expect(none).toMatchObject({ ok: false, missing: [{ fact: 'repo', question: expect.stringContaining('git 把它抓進來') }] });
  });

  it('a spike needs a URL the person pasted; an epic becomes a planner task', async () => {
    const s = await prepareWork(db, turn(['幫我評估這個套件']), factsFrom({ kind: 'spike', title: 'cuCIM 評估', expected: '能不能在 8192x5000 上 10 ms 內做完 CCL', urls: ['https://github.com/rapidsai/cucim'] })!, deps);
    expect(s).toMatchObject({ ok: false, missing: [{ fact: 'urls' }] });
    const s2 = await prepareWork(db, turn(['幫我評估 https://github.com/rapidsai/cucim']), factsFrom({ kind: 'spike', title: 'cuCIM 評估', expected: '能不能在 8192x5000 上 10 ms 內做完 CCL', urls: ['https://github.com/rapidsai/cucim'] })!, deps);
    expect(s2).toMatchObject({ ok: true, action: { op: 'spike', params: { urls: ['https://github.com/rapidsai/cucim'] } } });
    const e = await prepareWork(
      db,
      turn(['登入整個翻新']),
      factsFrom({ kind: 'epic', title: '登入翻新', expected: '登入流程全部改成新版，三個畫面都有測試守住而且逾時會顯示錯誤', parts: ['先量現況', '改逾時處理', '加回歸測試'], repo: 'login-app' })!,
      deps,
    );
    if (!e.ok) throw new Error(JSON.stringify(e.missing));
    expect(e.action).toMatchObject({ op: 'epic', params: { coding_tool: 'plan' } });
    expect(e.markdown).toContain('- 改逾時處理');
  });

  it('an unknown model is a question, not a guess', async () => {
    const r = await prepareWork(db, turn(['修登入']), bugfix({ model: 'gpt-9' }), deps);
    expect(r).toMatchObject({ ok: false, missing: [{ fact: 'model', question: expect.stringContaining('不認得模型') }] });
  });
});
