import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { getSetting, logEvent } from '../db/index.js';
import { identityOf, IdentityError } from './identity.js';
import { createPlan, deletePlan, getPlan, listDatasets, listPlans, PlanError, updatePlan, type PlanInput } from '../plans/store.js';
import { describeExecHosts, getExecHost, LOCAL_HOST, realHostExec, setHostIds, type HostExec } from '../exec/hosts.js';
import { checkSandbox, type CheckLine } from '../exec/check.js';
import { sandboxSettings } from '../exec/sandbox.js';
import { execRoot } from '../exec/workspace.js';
import { listJobRepos } from '../plans/job.js';
import { resolvePrdModel } from '../prd/intake.js';
import type { PrdReviewExec } from '../prd/review.js';
import { listLocalModels } from '../local/models.js';

/**
 * 驗證方案 API for the /plans.html editor (engineers) and the 新工作 page (operators pick one and
 * its 圖資). Everything here only reads or writes plan rows and lists folders; nothing runs code
 * except the machine check, which is the same probe as `loop exec check --host`.
 */

export interface PlanRouteOptions {
  /** test injection: the local-model review behind 新工作's check (as the PRD gate's) */
  reviewExec?: PrdReviewExec;
  /** test injection: ssh for listing a remote machine's 圖資 */
  hostExec?: HostExec;
  /** test injection: the sandbox probe behind 檢查機台 */
  check?: (hostName: string | null) => Promise<CheckLine[]>;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split('\n') : []);

function inputOf(body: unknown): PlanInput {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    name: str(b.name) ?? '',
    repo_path: str(b.repo_path),
    description: str(b.description),
    host: str(b.host),
    steps: arr(b.steps),
    dataset_root: str(b.dataset_root),
    dataset_default: str(b.dataset_default),
    metrics: str(b.metrics),
    protected_paths: Array.isArray(b.protected_paths) ? b.protected_paths.map(String) : str(b.protected_paths),
    artifacts: Array.isArray(b.artifacts) ? b.artifacts.map(String) : str(b.artifacts),
    manual_checks: arr(b.manual_checks),
    domain: str(b.domain),
    setup_cmd: str(b.setup_cmd),
  };
}

export function registerPlanRoutes(app: FastifyInstance, db: Database.Database, opts: PlanRouteOptions = {}): void {
  const who = (req: FastifyRequest): string => {
    try {
      return identityOf(req).label;
    } catch (err) {
      if (err instanceof IdentityError) return 'unknown';
      throw err;
    }
  };
  const planError = (reply: FastifyReply, err: unknown) => {
    if (err instanceof PlanError) return reply.code(400).send({ error: err.message });
    throw err;
  };

  app.get('/api/verify-plans', async (req) => {
    const repo = str((req.query as { repo?: unknown }).repo);
    return { plans: listPlans(db, repo || null), hosts: describeExecHosts(db) };
  });

  app.get('/api/verify-plans/:id', async (req, reply) => {
    const p = getPlan(db, (req.params as { id: string }).id);
    return p ?? reply.code(404).send({ error: '沒有這個驗證方案' });
  });

  app.post('/api/verify-plans', async (req, reply) => {
    try {
      const p = createPlan(db, inputOf(req.body), who(req));
      logEvent(db, { kind: 'note', detail: `驗證方案新增：${p.name}（${p.id}）by ${p.created_by}` });
      return reply.code(201).send(p);
    } catch (err) {
      return planError(reply, err);
    }
  });

  app.put('/api/verify-plans/:id', async (req, reply) => {
    try {
      const p = updatePlan(db, (req.params as { id: string }).id, inputOf(req.body), who(req));
      if (!p) return reply.code(404).send({ error: '沒有這個驗證方案' });
      logEvent(db, { kind: 'note', detail: `驗證方案修改：${p.name}（${p.id}）by ${p.updated_by}` });
      return p;
    } catch (err) {
      return planError(reply, err);
    }
  });

  app.delete('/api/verify-plans/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const p = getPlan(db, id);
    if (!p || !deletePlan(db, id)) return reply.code(404).send({ error: '沒有這個驗證方案' });
    logEvent(db, { kind: 'note', detail: `驗證方案刪除：${p.name}（${id}）by ${who(req)}` });
    return { ok: true };
  });

  // 圖資 an operator can pick: the sub-folders of the plan's dataset_root on its machine
  app.get('/api/verify-plans/:id/datasets', async (req, reply) => {
    const p = getPlan(db, (req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: '沒有這個驗證方案' });
    try {
      return { datasets: await listDatasets(db, p, opts.hostExec ?? realHostExec), default: p.dataset_default };
    } catch (err) {
      if (err instanceof PlanError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  // ---- 新工作流程 ----
  // what 新工作流程 and 對話操作 offer: the software (with branches), who can do the work, when it runs
  app.get('/api/jobs/options', async () => {
    let defaultModel: string | null = null;
    try {
      defaultModel = resolvePrdModel(db, null);
    } catch {
      defaultModel = null;
    }
    return {
      repos: listJobRepos(db),
      models: listLocalModels(db, { enabledOnly: true }).map((m) => ({ id: `local:${m.id}`, name: m.display_name })),
      default_model: defaultModel,
      local_task_window: getSetting(db, 'local_task_window') ?? '',
      morning_report_time: getSetting(db, 'morning_report_time') ?? '',
    };
  });

  // 檢查機台與圖資: the `loop exec check` probe against the plan's machine, then its 圖資 listing
  app.post('/api/verify-plans/:id/check', async (req, reply) => {
    const p = getPlan(db, (req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: '沒有這個驗證方案' });
    let lines: CheckLine[];
    if (!p.host) {
      lines = [{ ok: null, label: '驗證機台', detail: '這個方案在引擎主機的 shell 直接執行（沒有沙盒），不需要檢查容器' }];
    } else if (opts.check) {
      lines = await opts.check(p.host);
    } else {
      const remote = p.host === LOCAL_HOST ? undefined : getExecHost(db, p.host);
      if (p.host !== LOCAL_HOST && !remote) return reply.code(409).send({ error: `沒有這台驗證機台：${p.host}` });
      lines = await checkSandbox(sandboxSettings(db), path.join(execRoot(), 'check'), {
        remote,
        onRemoteIds: remote ? (uid, gid) => setHostIds(db, remote.name, uid, gid) : undefined,
      });
    }
    let datasets: { ok: boolean; detail: string; count: number } | null = null;
    if (p.dataset_root) {
      try {
        const ds = await listDatasets(db, p, opts.hostExec ?? realHostExec);
        datasets = { ok: ds.length > 0, detail: ds.length ? `${ds.length} 個圖資資料夾` : `${p.dataset_root} 裡沒有資料夾`, count: ds.length };
      } catch (err) {
        datasets = { ok: false, detail: (err as Error).message, count: 0 };
      }
    }
    return { lines, datasets, ok: lines.every((l) => l.ok !== false) && (datasets?.ok ?? true) };
  });
}
