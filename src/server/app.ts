import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import fastifyCors from '@fastify/cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { getDb, getSetting, setSetting, getBool, getNum } from '../db/index.js';
import { validateSetting, TUNABLE_KEYS } from '../settings.js';
import { createTask, getTask, setStatus, activeRuns, deleteTask, tasksForPrune } from '../tasks.js';
import { validateTask } from '../gate/validateTask.js';
import { readUsage } from '../token/usage.js';
import { resolvePolicy } from '../scheduler/policy.js';
import { killRun } from '../orchestrator/kill.js';
import { pruneTaskArtifacts } from '../git/worktree.js';
import { TaskActionError, abandonTask, abortTask, closeTask, deleteTaskSafe, holdTask, killTaskRuns, queueTask, restartTask, resumeTask } from '../taskActions.js';
import { mergeBlocker, mergeReviewedTask, MergeInProgressError } from '../orchestrator/mergeFlow.js';
import { updateVerification, TaskEditError, type VerificationPatch } from '../taskEdit.js';
import { identityOf, IdentityError } from './identity.js';
import { boardState, taskResult } from './board.js';
import { taskHistory } from '../orchestrator/history.js';
import { forecastBacklog } from '../token/accounting.js';
import { computeMetrics } from './metrics.js';
import type { Complexity } from '../config.js';
import { registerKnowledgeRoutes } from './knowledgeRoutes.js';
import { registerIngestRoutes } from './ingestRoutes.js';
import { registerRagRoutes } from './ragRoutes.js';
import { registerCaptureRoutes } from './captureRoutes.js';
import { registerDeployRoutes } from './deployRoutes.js';
import { registerPipelineRoutes } from './pipelineRoutes.js';
import { registerIntegrationRoutes } from './integrationRoutes.js';
import { registerVoiceRoutes } from './voiceRoutes.js';
import { registerReportRoutes } from './reportRoutes.js';
import { registerReportPptxRoutes } from './reportPptxRoutes.js';
import { environmentMap } from '../deploy/store.js';
import type { DistillExec } from '../knowledge/distill.js';
import { selectKnowledge } from '../knowledge/context.js';
import type { RelateExec } from '../knowledge/relate.js';
import type { EmbedExec } from '../knowledge/embed.js';
import type { TranscribeExec } from '../voice/transcribe.js';
import type { StructureExec } from '../voice/structure.js';
import type { ReportExec } from '../report/generate.js';
import type { OpDataExec, SearchFn } from '../report/opdata.js';
import type { PersistWriteFns } from '../report/persist.js';
import type { PptxRenderExec } from '../report/pptx/render.js';
import type { ContentExec } from '../report/pptx/status.js';
import type { AssembleFs } from '../report/pptx/assemble.js';
import { registerLocalRoutes, type LocalRouteOptions } from './localRoutes.js';
import { registerBenchmarkRoutes, type BenchmarkRouteOptions } from './benchmarkRoutes.js';
import type { BenchJudgeExec } from '../benchmark/judge.js';
import { registerPrdRoutes, type PrdRouteOptions } from './prdRoutes.js';
import { registerChatRoutes, type ChatRouteOptions } from './chatRoutes.js';
import { registerOpsRoutes } from './opsRoutes.js';
import type { OpsToolDeps } from '../chatops/tools.js';
import { registerExecRoutes } from './execRoutes.js';
import { registerPlanRoutes, type PlanRouteOptions } from './planRoutes.js';
import { registerReviewRoutes } from './reviewRoutes.js';
import { registerRepoRoutes, type RepoRouteOptions } from './repoRoutes.js';
import { registerMachineRoutes, type MachineRouteOptions } from './machineRoutes.js';
import { registerCheckRoutes, type CheckRouteOptions } from './checkRoutes.js';
import { registerTicketRoutes, type TicketRouteOptions } from './ticketRoutes.js';
import { buildMorningReport } from '../report/morning.js';
import fastifyWebsocket from '@fastify/websocket';
import { registerTerminalRoutes, type TerminalRouteOptions } from './terminalRoutes.js';
import { McpPool } from '../mcp/client.js';
import { parseMcpServers, runtimeEnvFor } from '../mcp/config.js';
import { paths } from '../config.js';
import type { PrdReviewExec } from '../prd/review.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** A refused task transition (src/taskActions.ts) becomes the response the route always sent. */
function actionError(reply: FastifyReply, err: unknown) {
  if (err instanceof TaskActionError) return reply.code(err.status).send({ error: err.message, ...err.extra });
  throw err;
}
const WEB_DIR = path.resolve(__dirname, '..', '..', 'web');
const DOCS_DIR = path.resolve(__dirname, '..', '..', 'docs');

const READONLY_PREFIXES = ['/api/rag/', '/api/knowledge', '/api/sources', '/api/status'];
function isReadonlyAllowed(url: string): boolean {
  const p = url.split('?')[0] ?? '';
  return READONLY_PREFIXES.some((pre) => p === pre || p.startsWith(pre));
}

export interface AppOptions {
  /** 問題單 flow test seams (each route module documents its own). */
  repoRoutes?: RepoRouteOptions;
  machineRoutes?: MachineRouteOptions;
  checkRoutes?: CheckRouteOptions;
  ticketRoutes?: TicketRouteOptions;
  db?: Database.Database;
  apiToken?: string | null;
  /** Second, read-only bearer: GET-only, restricted to the SSoT-read whitelist (see isReadonlyAllowed). */
  readonlyToken?: string | null;
  /** Browser CORS origin whitelist (test-only injection point; falls back to LOOP_CORS_ORIGINS). */
  corsOrigins?: string[];
  /** Test-only injection point for the close route's fire-and-forget distiller call. */
  distillExec?: DistillExec;
  /** Test-only injection points for POST /api/knowledge/relate (zero tokens/network). */
  relateLlmExec?: RelateExec;
  relateEmbedExec?: EmbedExec;
  /** Test-only injection points for POST /api/voice/intake (zero audio/GPU/tokens). */
  voiceTranscribeExec?: TranscribeExec;
  voiceStructureExec?: StructureExec;
  /** Test-only injection points for POST /api/report (zero network/tokens). */
  reportParseExec?: ReportExec;
  reportDataExec?: OpDataExec;
  reportSynthExec?: ReportExec;
  reportSearchFn?: SearchFn;
  reportPersistFns?: PersistWriteFns;
  /** Test-only injection points for POST/GET /api/report/weekly (zero network/tokens/python). */
  reportPptxDataExec?: OpDataExec;
  reportPptxRenderExec?: PptxRenderExec;
  reportPptxContentExec?: ContentExec;
  reportPptxFs?: AssembleFs;
  reportPptxNow?: () => Date;
  /** Test-only injection point for /api/local/* (zero docker/vLLM). */
  modelManager?: LocalRouteOptions['modelManager'];
  /** Test-only: HF cache dir the model switcher measures downloaded weights against. */
  localHubDir?: LocalRouteOptions['hubDir'];
  /** Test-only: stands in for `docker images -q` when checking a recipe's image. */
  dockerProbe?: LocalRouteOptions['dockerProbe'];
  /** Test-only: a stub download/build runner (never spawns uvx/docker). */
  localJobRunner?: LocalRouteOptions['jobRunner'];
  /** Test-only: HF size lookup / free-disk probe / clock for the model catalog. */
  localCatalog?: LocalRouteOptions['catalog'];
  /** Test-only: fake pty factory / identity for the terminal drawer (never spawns a shell). */
  /** Test-only: an MCP pool with in-memory transports; null disables the bridge. */
  mcpPool?: McpPool | null;
  chatToolFetch?: ChatRouteOptions['toolFetch'];
  chatToolLookup?: ChatRouteOptions['toolLookup'];
  terminalSpawnPty?: TerminalRouteOptions['spawnPty'];
  terminalIdentity?: TerminalRouteOptions['identity'];
  /** Test-only injection point for POST /api/benchmarks/:id/judge (zero tokens). */
  benchJudgeExec?: BenchJudgeExec;
  /** Test-only: built-in question dir / repo root for benchmark sources. */
  benchSource?: BenchmarkRouteOptions['source'];
  /** Test-only injection point for the PRD gate's local-model review (zero GPU). */
  prdReviewExec?: PrdReviewExec;
  /** Test-only seams for the PRD endpoints (knowledge search, local model, identity). */
  prdSearch?: PrdRouteOptions['search'];
  prdLocalChat?: PrdRouteOptions['localChat'];
  prdIdentity?: PrdRouteOptions['identity'];
  /** Test-only injection point for 模型對話 的使用者辨識 (see src/server/identity.ts). */
  chatIdentity?: ChatRouteOptions['identity'];
  /** Test injection for 對話操作 (src/chatops): preparer, runner and git dependencies. */
  opsDeps?: OpsToolDeps;
  /** Test-only: stands in for `docker run` behind the chat's GPU 沙盒 tools and POST /api/exec/run. */
  sandboxRun?: ChatRouteOptions['sandboxRun'];
  /** test injection: ssh behind 驗證方案 圖資 listing */
  planHostExec?: PlanRouteOptions['hostExec'];
  /** test injection: the sandbox probe behind 檢查機台 */
  planCheck?: PlanRouteOptions['check'];
  /** test injection: Gitea behind the 驗收頁's 發佈 */
  releaseFetch?: typeof fetch;
  releaseToken?: string;
}

interface CreateTaskBody {
  title?: string;
  goal?: string;
  plan_ref?: string | null;
  plan_kind?: 'md' | 'html' | 'url' | null;
  coding_tool?: string;
  verification_steps?: string[] | string;
  setup_cmd?: string | null;
  repo_path?: string | null;
  base_branch?: string | null;
  complexity?: string;
  priority?: number;
  model?: string | null;
  depends_on?: string | null;
  environment?: string | null;
  verify_mode?: string | null;
  verify_rubric?: string | null;
  verify_timeout_min?: number | null;
  requires?: string | null;
  experiment?: string | null;
  acceptance_metrics?: string | null;
  artifacts?: string | null;
  protected_paths?: string | null;
}

export function buildApp(opts: AppOptions = {}): FastifyInstance {
  const db = opts.db ?? getDb();
  // An explicit apiToken (including null, meaning "no auth") always wins; only fall
  // back to the ambient LOOP_API_TOKEN when the caller left it unspecified. Using ??
  // here would let the env var override an intentional `apiToken: null`.
  const apiToken = opts.apiToken !== undefined ? opts.apiToken : (process.env.LOOP_API_TOKEN ?? null);
  const readonlyToken =
    opts.readonlyToken !== undefined ? opts.readonlyToken : (process.env.LOOP_READONLY_TOKEN ?? null);
  const corsOrigins =
    opts.corsOrigins ?? (process.env.LOOP_CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const app = Fastify({ logger: false });
  app.register(fastifyMultipart, { limits: { fileSize: 25 * 1024 * 1024 } });
  // one WebSocket route today (/api/terminal/ws); frames are small JSON, so a modest cap
  app.register(fastifyWebsocket, { options: { maxPayload: 256 * 1024 } });

  // CORS is opt-in via LOOP_CORS_ORIGINS: empty (default) registers nothing, so
  // behavior is byte-for-byte identical to before this option existed.
  if (corsOrigins.length) {
    app.register(fastifyCors, {
      origin: corsOrigins,
      methods: ['GET', 'OPTIONS'],
      allowedHeaders: ['authorization', 'content-type', 'x-loop-user'],
      credentials: false,
    });
  }

  // --- bearer auth on /api/* (Tailscale is the primary boundary; this is layer 2) ---
  // Two tokens: the full apiToken (any method, any /api/* path) and an optional
  // readonlyToken scoped to GET requests on the SSoT-read whitelist (isReadonlyAllowed) —
  // for external automation that should only ever query, never mutate.
  app.addHook('onRequest', async (req, reply) => {
    if (!apiToken && !readonlyToken) return; // dev / no token configured
    if (!req.url.startsWith('/api/')) return;
    // 分享連結 (web/share.html): the token in the path is the whole credential and the page has no
    // way to hold a bearer. Exactly one method on one prefix — read-only, one conversation,
    // revocable from the chat page (src/server/chatRoutes.ts).
    if (req.method === 'GET' && (req.url.split('?')[0] ?? '').startsWith('/api/chat/shared/')) return;
    const auth = req.headers.authorization;
    const q = (req.query as any)?.token;
    if (apiToken && (auth === `Bearer ${apiToken}` || q === apiToken)) return;
    if (readonlyToken && (auth === `Bearer ${readonlyToken}` || q === readonlyToken)) {
      if (req.method === 'GET' && isReadonlyAllowed(req.url)) return;
      reply.code(403).send({ error: 'read-only token: forbidden' });
      return;
    }
    reply.code(401).send({ error: 'unauthorized' });
  });

  app.get('/api/status', async () => {
    const u = readUsage();
    return {
      paused: getBool(db, 'scheduler_paused'),
      usage: { session: u.session.percent, weekly: u.weekly.percent, source: u.source, error: u.error ?? null },
    };
  });

  app.get('/api/token', async () => readUsage());

  app.get('/api/board', async () => boardState(db));

  // the rail's usage ring on every page: the reading alone, without building the whole board
  app.get('/api/usage', async () => {
    const u = readUsage();
    const p = resolvePolicy(db);
    return {
      session: Math.round(u.session.percent),
      weekly: Math.round(u.weekly.percent),
      sessionResetsInMin: u.session.resetsInMinutes,
      weeklyResetsInMin: u.weekly.resetsInMinutes,
      error: u.error ?? null,
      policy: { window: p.window, sessionMax: p.sessionMax, weeklyMax: p.weeklyMax },
      paused: getBool(db, 'scheduler_paused'),
    };
  });

  // Backlog usage forecast: "should I add more tasks?" — read-only over existing
  // per-task estimates (see forecastBacklog).
  app.get('/api/forecast', async () => forecastBacklog(db));

  app.get('/api/history', async (req) => {
    const limit = Math.min(2000, Number((req.query as any)?.limit ?? 500));
    return db
      .prepare(
        `SELECT session_pct, weekly_pct, session_resets_at, weekly_resets_at, source, created_at
           FROM token_snapshots ORDER BY id DESC LIMIT ?`,
      )
      .all(limit);
  });

  app.post('/api/tasks', async (req, reply) => {
    const b = (req.body ?? {}) as CreateTaskBody;
    if (!b.title || !b.goal) return reply.code(400).send({ error: 'title and goal required' });
    const steps = Array.isArray(b.verification_steps)
      ? b.verification_steps
      : typeof b.verification_steps === 'string'
        ? b.verification_steps.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    const t = createTask(db, {
      title: b.title,
      goal: b.goal,
      plan_ref: b.plan_ref ?? null,
      plan_kind: b.plan_kind ?? null,
      coding_tool: b.coding_tool ?? 'claude-code',
      verification_steps: steps,
      setup_cmd: b.setup_cmd ?? null,
      repo_path: b.repo_path ?? null,
      base_branch: b.base_branch ?? null,
      complexity: (b.complexity as Complexity) ?? 'M',
      priority: b.priority ?? 2,
      model: b.model ?? null,
      depends_on: b.depends_on ?? null,
      environment: b.environment ?? null,
      verify_mode: b.verify_mode ?? null,
      verify_rubric: b.verify_rubric ?? null,
      verify_timeout_min: b.verify_timeout_min ?? null,
      requires: b.requires ?? null,
      experiment: b.experiment ?? null,
      acceptance_metrics: b.acceptance_metrics ?? null,
      artifacts: b.artifacts ?? null,
      protected_paths: b.protected_paths ?? null,
    });
    return { task: t, gate: validateTask(t, getSetting(db, 'host_capabilities') ?? '', environmentMap(db)) };
  });

  app.get('/api/tasks/:id', async (req, reply) => {
    const t = getTask(db, (req.params as any).id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    return { task: t, gate: validateTask(t, getSetting(db, 'host_capabilities') ?? '', environmentMap(db)) };
  });

  // Change how a task is verified after it was created (taskEdit.ts) — e.g. move a step into
  // the GPU 沙盒 so 試跑 can re-run it. Only the verification fields; never while it runs.
  app.patch('/api/tasks/:id', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const patch: VerificationPatch = {};
    if (b.verification_steps !== undefined) {
      patch.verification_steps = typeof b.verification_steps === 'string'
        ? b.verification_steps.split(',').map((s) => s.trim()).filter(Boolean)
        : (b.verification_steps as string[]);
    }
    for (const k of ['verify_mode', 'acceptance_metrics', 'artifacts', 'protected_paths'] as const) {
      if (b[k] !== undefined) patch[k] = b[k] === null ? null : String(b[k]);
    }
    if (b.verify_timeout_min !== undefined) patch.verify_timeout_min = b.verify_timeout_min === null ? null : Number(b.verify_timeout_min);
    let by: string | null = null;
    try {
      by = identityOf(req).label;
    } catch {
      /* an unreadable name header only loses the attribution */
    }
    try {
      return { task: updateVerification(db, (req.params as { id: string }).id, patch, by) };
    } catch (err) {
      if (err instanceof TaskEditError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  // Who the engine takes this request to be (server/identity.ts) — the operator pages show it
  // instead of only the name typed into the browser, which a Tailscale login overrides.
  app.get('/api/whoami', async (req, reply) => {
    try {
      return identityOf(req);
    } catch (err) {
      if (err instanceof IdentityError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/tasks/:id/queue', async (req, reply) => {
    // the MCP queues by default through this capped path (see queueTask); the board/CLI don't pass it
    const auto =
      (req.query as any)?.auto === '1' ||
      (req.query as any)?.auto === 'true' ||
      (req.body as any)?.auto === true;
    try {
      queueTask(db, (req.params as any).id, { auto });
      return { ok: true };
    } catch (err) {
      return actionError(reply, err);
    }
  });

  // Manual integrate for a task left at merge_status pending/conflict (e.g. no-gh host, a
  // manual verify outcome, or a base that moved on after the task finished): brings the latest
  // base in, re-verifies when that changed the branch, then fast-forwards (orchestrator/mergeFlow).
  app.post('/api/tasks/:id/merge', async (req, reply) => {
    const id = (req.params as any).id;
    const t = getTask(db, id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    const blocked = mergeBlocker(t);
    if (blocked) return reply.code(409).send({ error: blocked.error, ...blocked.extra });
    try {
      return await mergeReviewedTask(db, t);
    } catch (err) {
      if (err instanceof MergeInProgressError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/tasks/:id/close', async (req, reply) => {
    try {
      closeTask(db, (req.params as any).id, { distillExec: opts.distillExec });
      return { ok: true };
    } catch (err) {
      return actionError(reply, err);
    }
  });

  // Task result for editors/MCP: PR link, gap-review, failure reason, recent log —
  // so a caller can see the outcome without opening the board.
  /**
   * 知識注入預覽: exactly what this task would get, and why. Answers "did my knowledge base
   * reach the task" before the task ever runs — including the usual reason it did not (the
   * nodes live in a repo scope this task does not point at).
   */
  // 工作流程 canvas: every attempt, the event log, and where each lifecycle stage stands
  app.get('/api/tasks/:id/runs', async (req, reply) => {
    const h = taskHistory(db, (req.params as any).id);
    return h ?? reply.code(404).send({ error: 'not found' });
  });

  app.get('/api/tasks/:id/knowledge', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const t = getTask(db, id);
    if (!t) return reply.code(404).send({ error: 'not found' });
    return selectKnowledge(db, t);
  });

  app.get('/api/tasks/:id/result', async (req, reply) => {
    const r = taskResult(db, (req.params as any).id);
    if (!r) return reply.code(404).send({ error: 'not found' });
    return r;
  });

  // --- attention (待確認) triage actions ---

  // 續跑 / 重來 / 放棄 / 轉待確認 / 中止 / 刪除: the transitions live in src/taskActions.ts, shared
  // with 對話操作 (src/chatops); these routes only map a refusal to its HTTP status.
  app.post('/api/tasks/:id/resume', async (req, reply) => {
    try {
      resumeTask(db, (req.params as any).id);
      return { ok: true };
    } catch (err) {
      return actionError(reply, err);
    }
  });

  app.post('/api/tasks/:id/restart', async (req, reply) => {
    try {
      restartTask(db, (req.params as any).id);
      return { ok: true };
    } catch (err) {
      return actionError(reply, err);
    }
  });

  // ?cleanup=1 also reclaims the worktree
  app.post('/api/tasks/:id/abandon', async (req, reply) => {
    const cleanup = (req.query as any)?.cleanup === '1' || (req.query as any)?.cleanup === 'true';
    try {
      abandonTask(db, (req.params as any).id, { cleanup });
      return { ok: true };
    } catch (err) {
      return actionError(reply, err);
    }
  });

  app.post('/api/tasks/:id/hold', async (req, reply) => {
    try {
      holdTask(db, (req.params as any).id);
      return { ok: true };
    } catch (err) {
      return actionError(reply, err);
    }
  });

  app.post('/api/tasks/:id/abort', async (req, reply) => {
    try {
      abortTask(db, (req.params as any).id);
      return { ok: true };
    } catch (err) {
      return actionError(reply, err);
    }
  });

  app.delete('/api/tasks/:id', async (req, reply) => {
    const q = req.query as { force?: string };
    const force = q?.force === '1' || q?.force === 'true';
    try {
      return { ok: true, ...deleteTaskSafe(db, (req.params as { id: string }).id, { force }) };
    } catch (err) {
      return actionError(reply, err);
    }
  });

  // Batch-prune terminal tasks + their disk artifacts. Never deletes active/blocked/review
  // (tasksForPrune enforces that). dryRun returns the would-delete list without deleting.
  app.post('/api/tasks/prune', async (req) => {
    const b = (req.body ?? {}) as { status?: string[]; olderThanDays?: number; dryRun?: boolean };
    const targets = tasksForPrune(db, { status: b.status, olderThanDays: b.olderThanDays });
    const ids = targets.map((t) => t.id);
    if (b.dryRun) return { count: ids.length, ids, dryRun: true };
    for (const t of targets) {
      pruneTaskArtifacts(db, t);
      deleteTask(db, t.id);
    }
    return { count: ids.length, ids };
  });

  app.post('/api/pause', async (req) => {
    setSetting(db, 'scheduler_paused', 'true');
    const hard = (req.query as any)?.hard === '1' || (req.query as any)?.hard === 'true';
    // reason 'pause' (NOT 'user'): a user abort is terminal, a hard pause must stay
    // resumable — the interrupted task goes to blocked and auto-resumes on unpause.
    if (hard) for (const r of activeRuns(db)) killRun(db, { id: r.id, pid: r.pid }, 'pause');
    return { ok: true, paused: true, hard };
  });

  app.post('/api/resume-scheduler', async () => {
    setSetting(db, 'scheduler_paused', 'false');
    return { ok: true, paused: false };
  });

  // --- tunable scheduler settings (day/night thresholds etc.), read/written from the board ---
  const readSettings = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const k of TUNABLE_KEYS) out[k] = getSetting(db, k) ?? '';
    return out;
  };
  app.get('/api/settings', async () => ({ settings: readSettings() }));

  // 晨報: what ran overnight and what needs a person (src/report/morning.ts; page: /morning.html)
  app.get('/api/morning', async (req) => {
    const h = Number((req.query as { hours?: string }).hours);
    return buildMorningReport(db, { hours: Number.isFinite(h) && h > 0 ? h : 24 });
  });
  app.post('/api/settings', async (req, reply) => {
    const b = (req.body ?? {}) as { settings?: Record<string, unknown>; key?: string; value?: unknown };
    const entries: [string, string][] = b.settings
      ? Object.entries(b.settings).map(([k, v]) => [k, String(v)])
      : b.key != null && b.value != null
        ? [[b.key, String(b.value)]]
        : [];
    if (!entries.length) return reply.code(400).send({ error: 'no settings provided' });
    const errors: Record<string, string> = {};
    for (const [k, v] of entries) {
      const err = validateSetting(k, v);
      if (err) errors[k] = err;
    }
    if (Object.keys(errors).length) return reply.code(400).send({ error: 'validation failed', errors });
    for (const [k, v] of entries) setSetting(db, k, v);
    return { ok: true, settings: readSettings() };
  });

  // --- SSE: push a full board snapshot every second (+ immediately) ---
  // Every open page shares one snapshot per second: building it walks every task (and a log tail
  // per running one), so N open tabs used to cost N rebuilds a second.
  let snap = { at: 0, data: '' };
  const boardSnapshot = (): string => {
    const now = Date.now();
    if (!snap.data || now - snap.at >= 900) snap = { at: now, data: JSON.stringify(boardState(db)) };
    return snap.data;
  };
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = () => {
      try {
        reply.raw.write(`data: ${boardSnapshot()}\n\n`);
      } catch {
        /* client gone */
      }
    };
    send();
    const iv = setInterval(send, 1000);
    req.raw.on('close', () => clearInterval(iv));
  });

  // Autonomous-velocity dashboard: what ADO's human-velocity view can't show.
  app.get('/api/metrics', async (req) => {
    const raw = Number((req.query as any)?.days);
    const days = Number.isFinite(raw) ? Math.min(90, Math.max(1, Math.round(raw))) : 14;
    return computeMetrics(db, { days });
  });

  registerKnowledgeRoutes(app, db, { relateLlmExec: opts.relateLlmExec, relateEmbedExec: opts.relateEmbedExec });
  registerIngestRoutes(app, db);
  registerRagRoutes(app, db);
  registerCaptureRoutes(app, db);
  registerDeployRoutes(app, db);
  registerPipelineRoutes(app, db);
  registerIntegrationRoutes(app, db);
  registerLocalRoutes(app, db, {
    modelManager: opts.modelManager,
    hubDir: opts.localHubDir,
    dockerProbe: opts.dockerProbe,
    jobRunner: opts.localJobRunner,
    catalog: opts.localCatalog,
  });
  registerBenchmarkRoutes(app, db, {
    judgeExec: opts.benchJudgeExec,
    source: opts.benchSource,
    prdReviewExec: opts.prdReviewExec,
    // cancelling a benchmark has to stop the arm that is running right now, not just mark it
    onArmCancel: (t) => {
      killTaskRuns(db, t.id, 'user');
    },
  });
  registerPrdRoutes(app, db, {
    reviewExec: opts.prdReviewExec,
    search: opts.prdSearch,
    localChat: opts.prdLocalChat,
    identity: opts.prdIdentity,
  });
  // MCP bridge for the chat page: servers from mcp_servers_json, secrets injected at spawn
  const mcpPool =
    opts.mcpPool !== undefined
      ? opts.mcpPool
      : new McpPool({
          cfgs: () => {
            try {
              return parseMcpServers(getSetting(db, 'mcp_servers_json') || '');
            } catch {
              return [];
            }
          },
          env: (name) =>
            runtimeEnvFor(name, db, {
              apiUrl: `http://127.0.0.1:${process.env.LOOP_PORT || 4711}`,
              apiToken: apiToken ?? '',
              dataDir: paths.dataDir,
              toolTimeoutMs: getNum(db, 'mcp_timeout_ms', 30_000),
            }),
          timeoutMs: () => getNum(db, 'mcp_timeout_ms', 30_000),
        });
  app.addHook('onClose', async () => {
    await mcpPool?.close();
  });
  registerChatRoutes(app, db, { identity: opts.chatIdentity, toolFetch: opts.chatToolFetch, toolLookup: opts.chatToolLookup, mcpPool, sandboxRun: opts.sandboxRun, opsDeps: opts.opsDeps });
  registerOpsRoutes(app, db, { identity: opts.chatIdentity, deps: opts.opsDeps });
  registerExecRoutes(app, db, { run: opts.sandboxRun });
  // 問題單 → 分析 → 檢查 → PR: repos, machines, checks and tickets (each filled in by its own link)
  registerRepoRoutes(app, db, opts.repoRoutes ?? {});
  registerMachineRoutes(app, db, opts.machineRoutes ?? {});
  registerCheckRoutes(app, db, opts.checkRoutes ?? {});
  registerTicketRoutes(app, db, opts.ticketRoutes ?? {});
  registerPlanRoutes(app, db, { hostExec: opts.planHostExec, check: opts.planCheck, reviewExec: opts.prdReviewExec });
  registerReviewRoutes(app, db, { sandboxRun: opts.sandboxRun, releaseFetch: opts.releaseFetch, releaseToken: opts.releaseToken, identity: opts.chatIdentity });
  // inside a child plugin so it loads after @fastify/websocket (a `websocket: true` route
  // declared in the root scope runs before the plugin has decorated the instance)
  app.register(async (inst) => {
    registerTerminalRoutes(inst, db, { spawnPty: opts.terminalSpawnPty, identity: opts.terminalIdentity });
  });
  registerVoiceRoutes(app, db, {
    transcribeExec: opts.voiceTranscribeExec,
    structureExec: opts.voiceStructureExec,
  });
  registerReportRoutes(app, db, {
    parseExec: opts.reportParseExec,
    dataExec: opts.reportDataExec,
    synthExec: opts.reportSynthExec,
    searchFn: opts.reportSearchFn,
    persistFns: opts.reportPersistFns,
  });
  registerReportPptxRoutes(app, db, {
    dataExec: opts.reportPptxDataExec,
    renderExec: opts.reportPptxRenderExec,
    contentExec: opts.reportPptxContentExec,
    fs: opts.reportPptxFs,
    now: opts.reportPptxNow,
  });

  app.register(fastifyStatic, { root: WEB_DIR, prefix: '/' });
  // 操作說明 is the single source of truth for user docs; the chat shell links to it here instead
  // of shipping a second copy under web/ that drifts.
  app.register(fastifyStatic, { root: DOCS_DIR, prefix: '/docs/', decorateReply: false });

  return app;
}
