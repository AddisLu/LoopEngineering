import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { openTestDb, setSetting, getSetting } from '../db/index.js';
import { createTask, setStatus } from '../tasks.js';
import { tick, type TickDeps } from '../scheduler/tick.js';
import { inTimeWindow, resolvePolicy } from '../scheduler/policy.js';
import { setCachedUsage } from '../token/usage.js';
import { validateSetting } from '../settings.js';
import { buildMorningReport, formatMorningText, morningDue, morningPush, pumpMorningReport } from '../report/morning.js';
import { headerValue, notify } from '../notify.js';
import { buildApp } from '../server/app.js';
import type { ModelManagerState } from '../local/modelManager.js';

let db: Database.Database;
let tmp: string[] = [];
beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10);
});
afterEach(() => {
  db.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp = [];
});

const BASE = {
  title: 't',
  goal: 'g',
  plan_ref: 'https://example.com/p.md',
  plan_kind: 'url' as const,
  coding_tool: 'claude-code',
  verification_steps: ['true'],
  repo_path: '/tmp/cf-aoi',
  base_branch: 'main',
};

/** local clock, like the engine's */
const at = (h: number, m = 0) => new Date(2026, 8, 29, h, m);

describe('local_task_window', () => {
  it('wraps midnight; start inclusive, end exclusive', () => {
    expect(inTimeWindow('19:00-07:00', at(23))).toBe(true);
    expect(inTimeWindow('19:00-07:00', at(6, 59))).toBe(true);
    expect(inTimeWindow('19:00-07:00', at(7))).toBe(false);
    expect(inTimeWindow('19:00-07:00', at(12))).toBe(false);
    expect(inTimeWindow('09:00-17:00', at(9))).toBe(true);
    expect(inTimeWindow('09:00-17:00', at(17))).toBe(false);
    expect(inTimeWindow('00:00-24:00', at(23, 59))).toBe(true);
  });

  it('day/night budget policy reads the same as before the refactor', () => {
    setSetting(db, 'day_window', '08:00-23:00');
    expect(resolvePolicy(db, at(10)).window).toBe('day');
    expect(resolvePolicy(db, at(23, 30)).window).toBe('night');
    expect(resolvePolicy(db, at(7, 59)).window).toBe('night');
  });

  it('validates the settings', () => {
    expect(validateSetting('local_task_window', '19:00-07:00')).toBeNull();
    expect(validateSetting('local_task_window', '')).toBeNull();
    expect(validateSetting('local_task_window', '00:00-24:00')).toBeNull();
    expect(validateSetting('local_task_window', '19:00-19:00')).toMatch(/local_task_window/);
    expect(validateSetting('local_task_window', '7pm-7am')).toMatch(/local_task_window/);
    expect(validateSetting('local_task_window', '25:00-07:00')).toMatch(/local_task_window/);
    expect(validateSetting('morning_report_time', '08:00')).toBeNull();
    expect(validateSetting('morning_report_time', '')).toBeNull();
    expect(validateSetting('morning_report_time', '8:00')).toMatch(/morning_report_time/);
  });

  function stubManager(init: Partial<ModelManagerState> = {}) {
    const st: ModelManagerState = { loaded: null, wanted: null, status: 'idle', since: null, error: null, ...init };
    const ensured: string[] = [];
    return {
      ensured,
      mm: {
        state: () => ({ ...st }),
        ensureLoaded: (id: string) => {
          ensured.push(id);
          return 'switching' as const;
        },
        unavailable: () => false,
        refresh: () => {},
      },
    };
  }
  function runTick(mm: TickDeps['modelManager'], now: Date) {
    const started: string[] = [];
    const info = tick(db, { inflightCount: () => 0, startRun: (t) => started.push(t.id), modelManager: mm, now });
    return { info, started };
  }

  it('outside the window local work waits (no dispatch, no model load); cloud work is untouched', () => {
    setSetting(db, 'local_models_enabled', 'true');
    setSetting(db, 'local_task_window', '19:00-07:00');
    const local = createTask(db, { ...BASE, model: 'local:qwen3-coder-next', priority: 5 });
    setStatus(db, local.id, 'queued');
    const cloud = createTask(db, { ...BASE, model: 'sonnet' });
    setStatus(db, cloud.id, 'queued');
    const { mm, ensured } = stubManager({ status: 'ready', loaded: 'qwen3-coder-next' });

    const day = runTick(mm, at(10));
    expect(day.started).toEqual([cloud.id]);
    expect(day.info.reason).toContain('1 local task(s) wait for local_task_window 19:00-07:00');
    expect(ensured).toEqual([]);

    const night = runTick(mm, at(23));
    expect(night.started).toContain(local.id); // (the stub never moves the cloud task off queued)
    expect(night.info.reason).not.toContain('local_task_window');
  });

  it('empty window = any time (the old behavior)', () => {
    setSetting(db, 'local_models_enabled', 'true');
    const local = createTask(db, { ...BASE, model: 'local:qwen3-coder-next' });
    setStatus(db, local.id, 'queued');
    const { mm } = stubManager({ status: 'ready', loaded: 'qwen3-coder-next' });
    expect(runTick(mm, at(10)).started).toEqual([local.id]);
  });
});

// ---------------------------------------------------------------------------

const sqlTime = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
const hoursAgo = (h: number) => sqlTime(new Date(Date.now() - h * 3_600_000));
/** finishRun writes finished_at as an ISO string, not SQLite's format */
const isoHoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function seedRun(taskId: string, o: { startedH: number; finishedH?: number | null; verify?: unknown; metrics?: unknown; worktree?: string; model?: string }) {
  const id = `r_${nanoid(8)}`;
  db.prepare(
    `INSERT INTO task_runs (id, task_id, attempt, started_at, finished_at, verify_json, metrics_json, worktree_path, model, exit_code)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(
    id,
    taskId,
    hoursAgo(o.startedH),
    o.finishedH == null ? null : isoHoursAgo(o.finishedH),
    o.verify ? JSON.stringify(o.verify) : null,
    o.metrics ? JSON.stringify(o.metrics) : null,
    o.worktree ?? null,
    o.model ?? null,
  );
  return id;
}

function seedNight() {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-morning-'));
  tmp.push(wt);
  fs.writeFileSync(path.join(wt, 'VERIFY.md'), '- [ ] 上機台跑 20260615 圖集\n- [ ] 確認 UI 顯示新判型');

  const passed = createTask(db, { ...BASE, title: '亮缺陷判型', model: 'local:qwen3-coder-next', acceptance_metrics: 'detection_rate >= 0.98; miss == 0' });
  seedRun(passed.id, {
    startedH: 6,
    finishedH: 5,
    worktree: wt,
    model: 'local:qwen3-coder-next',
    verify: [
      { step: 'sandbox@aoi-gpu: make', ok: true, exitCode: 0, timedOut: false, tail: 'ok' },
      { step: 'sandbox@aoi-gpu: python3 scripts/eval/run.py', ok: true, exitCode: 0, timedOut: false, tail: 'LOOP_METRICS {}' },
    ],
    metrics: {
      values: { detection_rate: 0.991, miss: 0, fps: 31 },
      checks: [
        { name: 'detection_rate', op: '>=', target: 0.98, actual: 0.991, pass: true },
        { name: 'miss', op: '==', target: 0, actual: 0, pass: true },
      ],
      pass: true,
    },
  });
  setStatus(db, passed.id, 'review');
  db.prepare('UPDATE tasks SET merge_status = ?, pr_url = ? WHERE id = ?').run('merged', 'http://gitea.corp:3000/aoi/cf-aoi/pulls/12', passed.id);

  const stuck = createTask(db, { ...BASE, title: '暗點漏檢', model: 'local:qwen3-coder-next', acceptance_metrics: 'detection_rate >= 0.98' });
  seedRun(stuck.id, {
    startedH: 4,
    finishedH: 3,
    verify: [
      { step: 'sandbox@aoi-gpu: make', ok: true, exitCode: 0, timedOut: false, tail: '' },
      { step: 'sandbox@aoi-gpu: python3 scripts/eval/run.py', ok: false, exitCode: 1, timedOut: false, tail: 'Traceback\nKeyError: roi' },
    ],
  });
  setStatus(db, stuck.id, 'attention', { detail: 'verify failed after 2 resumes: sandbox@aoi-gpu: python3 scripts/eval/run.py' });

  const manual = createTask(db, { ...BASE, title: 'UI 文字調整', verification_steps: [] });
  seedRun(manual.id, { startedH: 8, finishedH: 7 });
  setStatus(db, manual.id, 'review', { detail: '待人工驗證 — 見 VERIFY.md；驗過後按合併' });

  const waiting = createTask(db, { ...BASE, title: '還在排隊', model: 'local:qwen3-coder-next' });
  setStatus(db, waiting.id, 'queued');

  // not news: closed days ago, and a benchmark arm (it has its own page)
  const old = createTask(db, { ...BASE, title: '上週的' });
  seedRun(old.id, { startedH: 80, finishedH: 79 });
  setStatus(db, old.id, 'closed');
  const arm = createTask(db, { ...BASE, title: '評比 arm' });
  db.prepare('UPDATE tasks SET benchmark_id = ? WHERE id = ?').run('b_1', arm.id);
  seedRun(arm.id, { startedH: 2, finishedH: 1 });

  return { passed, stuck, manual, waiting, old, arm };
}

describe('morning report', () => {
  it('lists what ran, needs-a-person first, with steps, metrics and the manual checklist', () => {
    const s = seedNight();
    const r = buildMorningReport(db);
    expect(r.tasks.map((t) => t.id)).toEqual([s.stuck.id, s.passed.id, s.manual.id, s.waiting.id]);
    expect(r.tasks.map((t) => t.outcome)).toEqual(['attention', 'pass', 'manual', 'queued']);
    expect(r.headline).toBe('過去 24 小時 4 個任務：1 要你處理、1 驗收通過、1 待人工驗收、1 還沒輪到');

    const [stuck, passed] = r.tasks;
    expect(stuck!.reason).toContain('verify failed after 2 resumes');
    expect(stuck!.failed_step?.tail).toContain('KeyError: roi');
    expect(passed!.metrics?.pass).toBe(true);
    expect(passed!.verify_md).toContain('20260615');
    expect(passed!.run?.minutes).toBe(60);
    expect(passed!.model).toBe('local:qwen3-coder-next');
    expect(passed!.repo).toBe('cf-aoi');

    const text = formatMorningText(r);
    expect(text).toContain('⚠ 要你處理');
    expect(text).toContain('失敗在 sandbox@aoi-gpu: python3 scripts/eval/run.py（exit 1）');
    expect(text).toContain('| KeyError: roi');
    expect(text).toContain('指標：detection_rate 0.991（>= 0.98）✅；miss 0（== 0）✅');
    expect(text).toContain('指標：沒有量到（門檻 detection_rate >= 0.98）');
    expect(text).toContain('PR：http://gitea.corp:3000/aoi/cf-aoi/pulls/12');
    expect(text).toContain('人工驗收：VERIFY.md 有 2 項待勾');
  });

  it('compares finish times as times, not strings (ISO finished_at vs SQLite started_at)', () => {
    const t = createTask(db, { ...BASE, title: '昨天早上' });
    setStatus(db, t.id, 'review');
    // window starts 2026-09-28 12:00 UTC; the run finished the same day at 08:00 — as strings
    // '2026-09-28T08…' sorts after '2026-09-28 12…', as times it is 4h before the window
    db.prepare(`INSERT INTO task_runs (id, task_id, attempt, started_at, finished_at) VALUES ('r_same_day', ?, 1, '2026-09-28 07:00:00', '2026-09-28T08:00:00.000Z')`).run(t.id);
    const now = new Date('2026-09-29T12:00:00Z');
    expect(buildMorningReport(db, { now }).tasks.some((x) => x.id === t.id)).toBe(false);
    expect(buildMorningReport(db, { now, hours: 30 }).tasks.find((x) => x.id === t.id)?.run?.minutes).toBe(60);
  });

  it('the window is adjustable, and an empty night says so', () => {
    seedNight();
    expect(buildMorningReport(db, { hours: 100 }).tasks.some((t) => t.title === '上週的')).toBe(true);
    const empty = openTestDb();
    try {
      const r = buildMorningReport(empty);
      expect(r.tasks).toEqual([]);
      expect(r.headline).toBe('過去 24 小時沒有任務執行');
      expect(morningPush(r, 'http://x/morning.html').message).toBe('過去 24 小時沒有任務執行');
    } finally {
      empty.close();
    }
  });

  it('the push: counts in the title, one line per task, high priority when someone must act', () => {
    seedNight();
    const p = morningPush(buildMorningReport(db), 'http://spark:4711/morning.html');
    expect(p.title).toBe('Loop 晨報：1 要你處理、1 驗收通過、1 待人工驗收、1 還沒輪到');
    expect(p.priority).toBe('high');
    expect(p.click).toBe('http://spark:4711/morning.html');
    const lines = p.message.split('\n');
    expect(lines[0]).toBe('⚠ 暗點漏檢 — 失敗在 sandbox@aoi-gpu: python3 scripts/eval/run.py');
    expect(lines[1]).toBe('✅ 亮缺陷判型 — detection_rate 0.991（>= 0.98）✅；miss 0（== 0）✅');
  });

  it('pushes once a day, from morning_report_time until 3h after it', async () => {
    expect(morningDue(db, at(8))).toBeNull(); // off by default
    setSetting(db, 'morning_report_time', '08:00');
    expect(morningDue(db, at(7, 59))).toBeNull();
    expect(morningDue(db, at(8))).toBe('2026-09-29');
    expect(morningDue(db, at(11))).toBeNull();

    const sent: { title: string; click: string }[] = [];
    const prev = process.env.LOOP_PUBLIC_URL;
    process.env.LOOP_PUBLIC_URL = 'http://spark.tail:4711/';
    try {
      expect(await pumpMorningReport(db, at(8, 5), async (p) => void sent.push(p))).toBe(true);
      expect(await pumpMorningReport(db, at(8, 6), async (p) => void sent.push(p))).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.LOOP_PUBLIC_URL;
      else process.env.LOOP_PUBLIC_URL = prev;
    }
    expect(sent).toHaveLength(1);
    expect(sent[0]!.click).toBe('http://spark.tail:4711/morning.html');
    expect(getSetting(db, 'morning_report_last')).toBe('2026-09-29');
    expect(morningDue(db, new Date(2026, 8, 30, 8, 1))).toBe('2026-09-30');
  });

  it('GET /api/morning returns the report', async () => {
    seedNight();
    const app = buildApp({ db, apiToken: null });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/morning?hours=12' });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { hours: number; tasks: { outcome: string }[] };
      expect(body.hours).toBe(12);
      expect(body.tasks.map((t) => t.outcome)).toEqual(['attention', 'pass', 'manual', 'queued']);
    } finally {
      await app.close();
    }
  });
});

describe('ntfy pushes with Chinese titles', () => {
  it('encodes non-ASCII header values (fetch rejects them raw), ASCII unchanged', () => {
    expect(headerValue('Loop: task failed')).toBe('Loop: task failed');
    const enc = headerValue('Loop 晨報：1 要你處理');
    expect(enc).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(Buffer.from(enc.slice(10, -2), 'base64').toString('utf8')).toBe('Loop 晨報：1 要你處理');
    expect(() => new Headers({ Title: 'Loop 晨報' })).toThrow();
    expect(() => new Headers({ Title: enc })).not.toThrow();
  });

  it('notify sends the encoded title and the click-through link', async () => {
    setSetting(db, 'ntfy_server', 'http://ntfy.local/');
    setSetting(db, 'ntfy_topic', 'loop');
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      new Headers(init.headers); // what real fetch does first — throws on a raw Chinese value
      calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response('ok');
    }) as unknown as typeof fetch;
    await notify(db, { title: 'Loop: 任務待確認', message: 't_1 — 驗證失敗', click: 'http://spark:4711/morning.html' }, fake);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://ntfy.local/loop');
    expect(calls[0]!.headers.Title).toBe(headerValue('Loop: 任務待確認'));
    expect(calls[0]!.headers.Click).toBe('http://spark:4711/morning.html');
    expect(calls[0]!.body).toBe('t_1 — 驗證失敗');
  });
});

describe('morning page: static assets', () => {
  const WEB = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'web');
  const read = (f: string) => fs.readFileSync(path.join(WEB, f), 'utf8');

  it('renders with textContent only and is linked from the app rail and the board', () => {
    expect(read('morning.js')).not.toMatch(/innerHTML/);
    expect(read('morning.html')).toContain('/morning.js');
    expect(read('frame.js')).toContain("'/morning.html'");
    expect(read('board.html')).toMatch(/href="\/morning\.html"/);
  });

  it('the board settings can set (and clear) the night window and the push time', () => {
    const board = read('board.html');
    expect(board).toMatch(/name="local_task_window"[^>]*data-clearable/);
    expect(board).toMatch(/name="morning_report_time"[^>]*data-clearable/);
    expect(read('app.js')).toContain("'clearable' in input.dataset");
  });
});
