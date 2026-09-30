import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, getTask, setStatus } from '../tasks.js';
import { appendMessage, createConversation } from '../chat/store.js';
import { createBenchmark, getBenchmark } from '../benchmark/store.js';
import { createPending, getActionById } from '../chatops/actions.js';
import { prepareAction, prepareBenchmark, prepareScreen } from '../chatops/prepareOps.js';
import { listScreens } from '../benchmark/screen.js';
import { showView } from '../chatops/views.js';
import { factsFrom, prepareWork } from '../chatops/prepare.js';
import { confirmButton, confirmTyped, getOpsRunner, type ExecDeps } from '../chatops/execute.js';
import type { ChatCtx } from '../chatops/types.js';

// Confirmed actions run through the same functions the board uses; a task that moved on since the
// preparation is left alone; slow jobs report 「已開始」 and finish in the background.
let db: Database.Database;
let repo: string;
const USER = 'ts:addis@example.com';
const never = () => false;

beforeEach(() => {
  db = openTestDb();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-exec-'));
  // a real repo: a rerun's arms are ordinary coding tasks and the gate checks repo and base
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@t'], ['config', 'user.name', 't'], ['commit', '-q', '--allow-empty', '-m', 'init']]) {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  }
});
afterEach(async () => {
  await getOpsRunner().idle();
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

function chat() {
  const c = createConversation(db, { user_key: USER });
  return (text: string): ChatCtx => {
    appendMessage(db, c.id, USER, { role: 'user', content: text });
    const a = appendMessage(db, c.id, USER, { role: 'assistant', content: '' });
    return { messageId: a.id, conversationId: c.id, userKey: USER, label: 'addis' };
  };
}
const mk = (status: string, extra: Record<string, unknown> = {}) => {
  const t = createTask(db, { title: '修登入', goal: 'a goal long enough', plan_ref: 'https://example.com/p.md', coding_tool: 'mock', verification_steps: ['true'], complexity: 'S' });
  if (status !== 'draft') setStatus(db, t.id, status as never);
  for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE tasks SET ${k} = ? WHERE id = ?`).run(v, t.id);
  return t.id;
};
const deps: ExecDeps = { waitMs: 2000 };

describe('task actions from the chat', () => {
  it('prepare → the person says yes → the same transition the board makes, with an audit note', async () => {
    const turn = chat();
    const id = mk('draft');
    const p = await prepareAction(db, turn(`排入 ${id}`), { action: 'queue', target: id });
    if (!p.ok) throw new Error(JSON.stringify(p.missing));
    expect(p.action.summary).toContain(`排入 ${id}「修登入」`);
    const r = await confirmTyped(db, turn('確認'), undefined, never, deps);
    expect(r).toMatchObject({ ok: true, action: { status: 'done' } });
    expect(getTask(db, id)?.status).toBe('queued');
    const note = db.prepare("SELECT detail FROM task_events WHERE task_id = ? AND kind = 'note' ORDER BY id DESC LIMIT 1").get(id) as { detail: string };
    expect(note.detail).toMatch(/^對話操作（addis）：排入 .* → 完成/);
  });

  it('refuses what the state does not allow, and says what would', async () => {
    const turn = chat();
    const id = mk('running');
    expect(await prepareAction(db, turn('排入'), { action: 'queue', target: id })).toMatchObject({ ok: false, missing: [{ question: expect.stringContaining('不能排入') }] });
    const r = mk('review', { merge_status: 'pending', verify_mode: 'command,manual', verify_rubric: '人工驗收：\n- 看過登入畫面' });
    expect(await prepareAction(db, turn('核可'), { action: 'approve', target: r })).toMatchObject({ ok: false, missing: [{ question: expect.stringContaining('對話不會代勾') }] });
    const arm = mk('running', { benchmark_id: 'b_x' });
    expect(await prepareAction(db, turn('中止'), { action: 'abort', target: arm })).toMatchObject({ ok: false, missing: [{ question: expect.stringContaining('取消評比 b_x') }] });
  });

  it('退回修改 shows the whole note that will be appended to the goal', async () => {
    const turn = chat();
    const id = mk('review', { merge_status: 'pending' });
    const note = `請改用逾時十秒${'，並補上測試'.repeat(40)}`;
    const p = await prepareAction(db, turn('退回修改'), { action: 'request_changes', target: id, note });
    if (!p.ok) throw new Error(JSON.stringify(p.missing));
    expect(p.action.summary).toContain(`- 意見：${note}`);
    expect(await prepareAction(db, turn('退回修改'), { action: 'request_changes', target: id, note: 'x'.repeat(1200) })).toMatchObject({ ok: false, missing: [{ fact: 'note' }] });
  });

  it('a task that moved on since the preparation is left alone', async () => {
    const turn = chat();
    const id = mk('running');
    const p = await prepareAction(db, turn(`中止 ${id}`), { action: 'abort', target: id });
    if (!p.ok) throw new Error('prepare');
    expect(p.action.risk).toBe('high');
    setStatus(db, id, 'attention');
    const r = await confirmTyped(db, turn(`確認 ${p.action.code}`), undefined, never, deps);
    expect(r).toMatchObject({ ok: true, action: { status: 'failed', result: { detail: expect.stringContaining('狀態已經變了（running → attention）') } } });
    expect(getTask(db, id)?.status).toBe('attention');
  });
});

describe('new work from the chat', () => {
  it('an unchanged draft is submitted on the verdict it was prepared with — even when the review is required', async () => {
    setSetting(db, 'prd_require_llm', 'true');
    setSetting(db, 'prd_repo_allowlist', repo);
    // recipes from an empty dir: no real recipe files, no docker probe
    setSetting(db, 'local_vllm_repo', fs.mkdtempSync(path.join(os.tmpdir(), 'loop-recipes-')));
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node -e 0' } }));
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['commit', '-qm', 'pkg'], { cwd: repo });
    const turn = chat();
    let reviews = 0;
    const reviewExec = async () => (reviews++, '{"ok":true,"missing":[],"questions":[],"risk_notes":[]}');
    const facts = factsFrom({ kind: 'bugfix', title: '登入逾時要顯示錯誤', expected: '網路慢時十秒內顯示錯誤訊息並可以重試', repro: '把網路限速到 2G 後按登入，畫面永遠轉圈', repo: path.basename(repo) })!;
    const p = await prepareWork(db, turn('登入會卡住，請修'), facts, { reviewExec });
    if (!p.ok) throw new Error(JSON.stringify(p.missing));
    expect(reviews).toBe(1);
    const r = await confirmTyped(db, turn('確認'), undefined, never, { ...deps, reviewExec: async () => { throw new Error('reviewed twice'); } });
    expect(r).toMatchObject({ ok: true, action: { status: 'done', result: { detail: expect.stringContaining('並排入') } } });
  });
});

describe('benchmarks from the chat', () => {
  it('a rerun copies the question, the yardstick and the lineup, with models added and removed', async () => {
    setSetting(db, 'benchmark_enabled', 'true');
    const plan = path.join(repo, 'PLAN.md');
    fs.writeFileSync(plan, '# q');
    const old = createBenchmark(db, {
      title: 'CCL 8192×5000',
      goal: '每張 ≤ 10 ms',
      plan_ref: plan,
      repo_path: repo,
      base_branch: 'main',
      verification_steps: ['sandbox: bash run_bench.sh'],
      acceptance_metrics: 'correct == 1; max_ms <= 10',
      protected_paths: 'bench/**,run_bench.sh',
      artifacts: 'build/check.log',
      domain: 'cuda',
      complexity: 'L',
      models: ['sonnet', 'haiku'],
      coding_tool: 'mock',
    }).benchmark;
    const turn = chat();
    // one benchmark at a time
    expect(await prepareBenchmark(db, turn('重賽 CCL'), { from: 'benchmark', ref: 'CCL' })).toMatchObject({ ok: false, missing: [{ fact: 'busy' }] });
    db.prepare("UPDATE benchmarks SET status = 'judged' WHERE id = ?").run(old.id);
    const p = await prepareBenchmark(db, turn('重賽 CCL，加 opus，拿掉 haiku'), { from: 'benchmark', ref: 'CCL', add_models: ['opus'], remove_models: ['haiku'] }, { usage: () => ({ session: { percent: 10 } }) });
    if (!p.ok) throw new Error(JSON.stringify(p.missing));
    expect(p.action.summary).toContain('重賽');
    expect(p.action.summary).toContain('參賽：sonnet（雲端）、opus（雲端）');
    expect(p.action.summary).toContain('門檻 correct == 1; max_ms <= 10');
    const r = await confirmTyped(db, turn('好，開始'), undefined, never, deps);
    expect(r).toMatchObject({ ok: true, action: { status: 'done' } });
    const id = (getActionById(db, r.action!.id)!.result!.data as { benchmark_id: string }).benchmark_id;
    const b = getBenchmark(db, id)!;
    expect(b.benchmark).toMatchObject({ title: 'CCL 8192×5000（重賽）', acceptance_metrics: 'correct == 1; max_ms <= 10', protected_paths: 'bench/**,run_bench.sh', domain: 'cuda', complexity: 'L' });
    expect(JSON.parse(b.benchmark.verification_steps)).toEqual(['sandbox: bash run_bench.sh']);
    expect(b.arms.map((a) => a.model).sort()).toEqual(['opus', 'sonnet']);
  });
});

describe('模型快篩 from the chat', () => {
  it('prepared from the templates, started only after the confirming answer, cancelled as a batch', async () => {
    setSetting(db, 'benchmark_enabled', 'true');
    setSetting(db, 'local_models_enabled', 'true');
    // a model the switcher would offer: weights complete in a (fake) HF cache, recipes from an empty dir
    setSetting(db, 'local_vllm_repo', fs.mkdtempSync(path.join(os.tmpdir(), 'loop-recipes-')));
    const hubDir = path.join(repo, 'hub');
    const snap = path.join(hubDir, 'models--local-inference-lab--Qwen3.8-Flash-Next-NVFP4', 'snapshots', 'rev1');
    fs.mkdirSync(snap, { recursive: true });
    fs.writeFileSync(path.join(snap, 'model.safetensors'), 'w');
    fs.mkdirSync(path.join(hubDir, 'models--local-inference-lab--Qwen3.8-Flash-Next-NVFP4', 'blobs'));
    fs.writeFileSync(path.join(hubDir, 'models--local-inference-lab--Qwen3.8-Flash-Next-NVFP4', 'blobs', 'b1'), 'w');
    const guard = { hubDir, dockerProbe: () => true };
    const turn = chat();
    expect(await prepareScreen(db, turn('快篩 sonnet'), { models: ['sonnet'] }, guard)).toMatchObject({ ok: false, missing: [{ question: expect.stringContaining('不是本地模型') }] });
    const p = await prepareScreen(db, turn('快篩 qwen38-flash'), { models: ['qwen38-flash'], questions: ['slugify'] }, guard);
    if (!p.ok) throw new Error(JSON.stringify(p.missing));
    expect(p.action).toMatchObject({ kind: 'benchmark', op: 'screen', speed: 'deferred', risk: 'normal' });
    expect(p.action.summary).toContain('模型快篩：qwen38-flash');
    expect(p.action.summary).toContain('slugify（簡單）');
    expect(p.action.summary).toContain('不花訂閱額度');
    const t2 = turn('確認');
    // the same machine at run time: the engine checks again that the model can start
    const r = await confirmTyped(db, t2, undefined, never, { ...deps, ...guard });
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining('這則回答結束後') });
    expect(listScreens(db)).toEqual([]); // nothing switches the model while this answer is written
    await getOpsRunner().runDeferred(t2.messageId);
    expect(getActionById(db, r.action!.id)).toMatchObject({ status: 'done', result: { detail: expect.stringContaining('已開始') } });
    const g = listScreens(db)[0]!;
    expect(g.cells[0]).toMatchObject({ model: 'local:qwen38-flash', question: 'slugify', outcome: 'running' });
    expect(showView(db, g.group)!.markdown).toContain(`${g.group} 快篩 qwen38-flash：進行中`);
    const c = await prepareAction(db, turn(`取消快篩 ${g.group}`), { action: 'cancel_benchmark', target: g.group });
    if (!c.ok) throw new Error(JSON.stringify(c.missing));
    expect(c.action.summary).toContain(`取消快篩 ${g.group}`);
    const done = await confirmTyped(db, turn('好'), undefined, never, deps);
    expect(done).toMatchObject({ ok: true, action: { status: 'done', result: { detail: expect.stringContaining(`快篩 ${g.group} 已取消`) } } });
    expect(listScreens(db)[0]!.status).toBe('cancelled');
  });
});

describe('the runner', () => {
  it('a slow job answers 「已開始」 and finishes in the background; the button runs it once', async () => {
    const turn = chat();
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => (release = res));
    const slow: ExecDeps = {
      waitMs: 30,
      git: async () => {
        await gate;
        return { ok: true, detail: 'pulled' };
      },
    };
    const a = createPending(db, turn('pull 一下'), { kind: 'git', op: 'pull', target: 'repo', params: {}, expect: null, summary: 'pull repo', risk: 'normal', speed: 'slow' });
    const r = await confirmButton(db, a.id, USER, slow);
    expect(r).toMatchObject({ ok: true, action: { status: 'running' }, message: expect.stringContaining('已開始') });
    expect(getOpsRunner().inFlight()).toBe(1);
    expect(await confirmButton(db, a.id, USER, slow)).toMatchObject({ ok: false });
    release();
    await getOpsRunner().idle();
    expect(getActionById(db, a.id)).toMatchObject({ status: 'done', result: { detail: 'pulled' } });
  });

  it('a model switch clicked on the card while its answer is still written waits for that answer', async () => {
    const turn = chat();
    const loaded: string[] = [];
    const mm = { state: () => ({ loaded: 'a', wanted: 'a', status: 'ready' as const, since: null, error: null }), ensureLoaded: (id: string) => (loaded.push(id), 'switching' as const) };
    db.prepare("INSERT INTO local_models (id, display_name, recipe, served_model_id, enabled) VALUES ('b', 'B', 'b', 'org/b', 1)").run();
    const t1 = turn('切到 b');
    const a = createPending(db, t1, { kind: 'model', op: 'switch_model', target: 'b', params: { id: 'b' }, expect: null, summary: '切到 b', risk: 'normal', speed: 'deferred' });
    let streaming = true;
    const r = await confirmButton(db, a.id, USER, { modelManager: mm, dockerProbe: () => true, hubDir: repo, otherAnswers: () => (streaming ? 1 : 0), isRunning: (id) => streaming && id === t1.messageId });
    expect(r).toMatchObject({ ok: true, action: { status: 'running' }, message: expect.stringContaining('這則回答結束後') });
    expect(getActionById(db, a.id)!.status).toBe('running');
    streaming = false;
    await getOpsRunner().runDeferred(t1.messageId);
    // it ran when the answer ended (the empty weight cache is what stops it here)
    expect(getActionById(db, a.id)).toMatchObject({ status: 'failed', result: { detail: expect.stringContaining('權重') } });
  });

  it('a model switch waits until the answer that confirmed it has finished, and not while others write', async () => {
    const turn = chat();
    const loaded: string[] = [];
    const mm = { state: () => ({ loaded: 'a', wanted: 'a', status: 'ready' as const, since: null, error: null }), ensureLoaded: (id: string) => (loaded.push(id), 'switching' as const) };
    db.prepare("INSERT INTO local_models (id, display_name, recipe, served_model_id, enabled) VALUES ('b', 'B', 'b', 'org/b', 1)").run();
    createPending(db, turn('切到 b'), { kind: 'model', op: 'switch_model', target: 'b', params: { id: 'b' }, expect: null, summary: '切到 b', risk: 'normal', speed: 'deferred' });
    const t2 = turn('確認');
    const r = await confirmTyped(db, t2, undefined, never, { modelManager: mm, dockerProbe: () => true, hubDir: repo, otherAnswers: () => 0 });
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining('這則回答結束後') });
    expect(loaded).toEqual([]);
    await getOpsRunner().runDeferred(t2.messageId);
    // weights are not in the (empty) cache: the guard refuses instead of stopping vLLM for nothing
    expect(getActionById(db, r.action!.id)).toMatchObject({ status: 'failed', result: { detail: expect.stringContaining('權重') } });
    expect(loaded).toEqual([]);
  });
});
