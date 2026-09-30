import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { logEvent } from '../db/index.js';
import { identityOf, IdentityError } from './identity.js';
import { CheckError, createCheck, deleteCheck, getCheck, listChecks, parseBaseline, reorderChecks, repoExists, updateCheck, type Check, type CheckInput } from '../checks/store.js';
import { createDataset, deleteDataset, getDataset, listDatasets, updateDataset, type DatasetInput } from '../checks/datasets.js';
import { getCheckRun, latestCheckRuns, listCheckRuns, runValues, type CheckRun } from '../checks/runs.js';
import { setBaseline, startTrialCheck } from '../checks/baseline.js';
import type { CheckDeps } from '../checks/runner.js';

/**
 * 檢查 API for the Repo page's 檢查 tab (engineers): a repo's checks, 試跑 on the default branch,
 * 設為基準, and the 圖資 registry. Nothing here runs code except a 試跑, which runs one check exactly
 * where a ticket would run it.
 *
 * /api/repos/:id/checks (GET, POST), /api/repos/:id/checks/reorder, /api/repos/:id/checks/from-detected,
 * /api/checks/:id (GET, PATCH, DELETE), /api/checks/:id/trial, /api/checks/:id/baseline,
 * /api/checks/:id/runs, /api/check-runs/:id, /api/datasets (GET, POST), /api/datasets/:id (PATCH, DELETE).
 */
export interface CheckRouteOptions {
  /** test injection: the machine runner / shell / git a 試跑 uses (src/checks/runner.ts) */
  checkDeps?: CheckDeps;
}

const str = (v: unknown): string | null | undefined => (v === undefined ? undefined : v === null ? null : typeof v === 'string' ? v : String(v));
const scalar = (v: unknown): string | number | boolean | null | undefined =>
  v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : String(v);
const list = (v: unknown): string | string[] | null | undefined => (Array.isArray(v) ? v.map(String) : (str(v) as string | null | undefined));

/** Only the fields a person can set; absent stays absent (PATCH keeps them). */
function checkInputOf(body: unknown): CheckInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: CheckInput = {};
  const set = <K extends keyof CheckInput>(k: K, v: CheckInput[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set('name', str(b.name));
  set('kind', str(b.kind));
  set('machine', str(b.machine));
  set('command', str(b.command));
  set('pass_rule', str(b.pass_rule));
  set('metrics', str(b.metrics));
  set('baseline_tol', scalar(b.baseline_tol) as CheckInput['baseline_tol']);
  set('dataset_id', str(b.dataset_id));
  set('test_globs', list(b.test_globs));
  set('red_on_base', scalar(b.red_on_base));
  set('timeout_min', scalar(b.timeout_min) as CheckInput['timeout_min']);
  set('required', scalar(b.required));
  set('ord', scalar(b.ord) as CheckInput['ord']);
  set('protected_paths', list(b.protected_paths));
  set('artifacts', list(b.artifacts));
  set('manual_text', str(b.manual_text));
  set('enabled', scalar(b.enabled));
  return out;
}

function datasetInputOf(body: unknown): DatasetInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: DatasetInput = {};
  for (const k of ['name', 'remote_url', 'images_dir', 'answer_file', 'answer_format'] as const) {
    const v = str(b[k]);
    if (v !== undefined) out[k] = v;
  }
  if (b.cases !== undefined) out.cases = scalar(b.cases) as DatasetInput['cases'];
  return out;
}

/** A run as the editor shows it: JSON columns parsed, whether it still runs, the metric names it reported. */
function runView(r: CheckRun, withOutput: boolean) {
  const parse = (s: string | null): unknown => {
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const { output_tail, metrics_json, result_json, artifacts_json, ...rest } = r;
  return {
    ...rest,
    running: r.finished_at === null,
    discovered: Object.keys(runValues(r)),
    metrics: parse(metrics_json),
    ...(withOutput ? { output_tail, result: parse(result_json), artifacts: parse(artifacts_json) } : {}),
  };
}

function checkView(c: Check, last?: CheckRun) {
  return { ...c, baseline: parseBaseline(c), last_run: last ? runView(last, false) : null };
}

export function registerCheckRoutes(app: FastifyInstance, db: Database.Database, opts: CheckRouteOptions = {}): void {
  const who = (req: FastifyRequest): string => {
    try {
      return identityOf(req).label;
    } catch (err) {
      if (err instanceof IdentityError) return 'unknown';
      throw err;
    }
  };
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof CheckError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };
  const noRepo = (reply: FastifyReply) => reply.code(404).send({ error: '沒有這個 repo' });
  const noCheck = (reply: FastifyReply) => reply.code(404).send({ error: '沒有這個檢查' });

  // ---- a repo's checks ----
  app.get('/api/repos/:id/checks', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!repoExists(db, id)) return noRepo(reply);
    const checks = listChecks(db, id);
    const last = latestCheckRuns(db, checks.map((c) => c.id));
    return { checks: checks.map((c) => checkView(c, last.get(c.id))) };
  });

  app.post('/api/repos/:id/checks', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      const c = createCheck(db, id, checkInputOf(req.body), who(req));
      logEvent(db, { kind: 'note', detail: `檢查新增：${c.name}（${c.id}，repo ${id}）by ${c.created_by}` });
      return reply.code(201).send(checkView(c));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/repos/:id/checks/reorder', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ids = (req.body as { ids?: unknown } | null)?.ids;
    if (!Array.isArray(ids)) return reply.code(400).send({ error: 'ids 要是檢查 id 的陣列' });
    try {
      return { checks: reorderChecks(db, id, ids.map(String)).map((c) => checkView(c)) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  // 「用偵測到的指令建立」: 建置 + 測試 from the commands the import detected, on the repo's machine
  app.post('/api/repos/:id/checks/from-detected', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const repo = db.prepare('SELECT build_cmd, test_cmd, machine FROM repos WHERE id = ?').get(id) as
      | { build_cmd: string | null; test_cmd: string | null; machine: string | null }
      | undefined;
    if (!repo) return noRepo(reply);
    const wanted = [
      { name: '建置', kind: 'build', command: repo.build_cmd?.trim() || null },
      { name: '測試', kind: 'test', command: repo.test_cmd?.trim() || null },
    ].filter((w): w is { name: string; kind: string; command: string } => !!w.command);
    if (!wanted.length) return reply.code(409).send({ error: '這個 repo 沒有偵測到建置或測試指令：請在 Repo 設定補上，或自己新增檢查' });
    const existing = listChecks(db, id);
    const by = who(req);
    const created: ReturnType<typeof checkView>[] = [];
    const skipped: string[] = [];
    try {
      for (const w of wanted) {
        if (existing.some((c) => c.kind === w.kind && c.command === w.command)) {
          skipped.push(w.name);
          continue;
        }
        created.push(checkView(createCheck(db, id, { ...w, machine: repo.machine, pass_rule: 'exit0', required: true }, by)));
      }
    } catch (err) {
      return fail(reply, err);
    }
    if (created.length) logEvent(db, { kind: 'note', detail: `檢查新增（偵測到的指令）：${created.map((c) => c.name).join('、')}（repo ${id}）by ${by}` });
    return reply.code(created.length ? 201 : 200).send({ created, skipped });
  });

  // ---- one check ----
  app.get('/api/checks/:id', async (req, reply) => {
    const c = getCheck(db, (req.params as { id: string }).id);
    if (!c) return noCheck(reply);
    return checkView(c, latestCheckRuns(db, [c.id]).get(c.id));
  });

  app.patch('/api/checks/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      const c = updateCheck(db, id, checkInputOf(req.body), who(req));
      if (!c) return noCheck(reply);
      logEvent(db, { kind: 'note', detail: `檢查修改：${c.name}（${c.id}）by ${c.updated_by}` });
      return checkView(c);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete('/api/checks/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const c = getCheck(db, id);
    if (!c || !deleteCheck(db, id)) return noCheck(reply);
    logEvent(db, { kind: 'note', detail: `檢查刪除：${c.name}（${id}）by ${who(req)}` });
    return { ok: true };
  });

  // 試跑一次: returns at once; poll GET /api/check-runs/:id
  app.post('/api/checks/:id/trial', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    try {
      const t = startTrialCheck(db, id, opts.checkDeps ?? {});
      logEvent(db, { kind: 'note', detail: `檢查試跑：${getCheck(db, id)?.name ?? id}（${t.runId}）by ${who(req)}` });
      return reply.code(202).send({ run_id: t.runId });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/checks/:id/baseline', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const runId = str((req.body as { run_id?: unknown } | null)?.run_id);
    if (!runId) return reply.code(400).send({ error: '要指定 run_id（哪一次試跑當基準）' });
    try {
      const c = setBaseline(db, id, runId, who(req));
      logEvent(db, { kind: 'note', detail: `檢查設為基準：${c.name}（${c.id}，${runId}）by ${c.updated_by}` });
      return checkView(c);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get('/api/checks/:id/runs', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!getCheck(db, id) && !listCheckRuns(db, id, 1).length) return noCheck(reply);
    const limit = Number((req.query as { limit?: string }).limit) || 20;
    return { runs: listCheckRuns(db, id, limit).map((r) => runView(r, false)) };
  });

  app.get('/api/check-runs/:id', async (req, reply) => {
    const r = getCheckRun(db, (req.params as { id: string }).id);
    if (!r) return reply.code(404).send({ error: '沒有這次執行紀錄' });
    return runView(r, true);
  });

  // ---- 圖資 ----
  app.get('/api/datasets', async () => ({ datasets: listDatasets(db) }));

  app.post('/api/datasets', async (req, reply) => {
    try {
      const d = createDataset(db, datasetInputOf(req.body), who(req));
      logEvent(db, { kind: 'note', detail: `圖資新增：${d.name}（${d.id}）by ${d.created_by}` });
      return reply.code(201).send(d);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.patch('/api/datasets/:id', async (req, reply) => {
    try {
      const d = updateDataset(db, (req.params as { id: string }).id, datasetInputOf(req.body));
      if (!d) return reply.code(404).send({ error: '沒有這個圖資' });
      return d;
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete('/api/datasets/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const d = getDataset(db, id);
    try {
      if (!d || !deleteDataset(db, id)) return reply.code(404).send({ error: '沒有這個圖資' });
    } catch (err) {
      return fail(reply, err);
    }
    logEvent(db, { kind: 'note', detail: `圖資刪除：${d.name}（${id}）by ${who(req)}` });
    return { ok: true };
  });
}
