import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { logEvent } from '../db/index.js';
import { getRun } from '../tasks.js';
import { formatSandboxResult, runSandbox, sandboxSettings, summarizeSandboxResult } from '../exec/sandbox.js';
import type { SandboxRun } from '../chat/sandboxTools.js';

/**
 * GPU 執行沙盒 for task runs. mcp/loop-exec-mcp.mjs (started per run, see orchestrator/taskMcp.ts)
 * forwards the agent's `run` tool here with the run id it was started for; the engine looks the
 * worktree up in its own records, so a caller can only ever reach the worktree of a run that is
 * still in progress — never an arbitrary path.
 */

export interface ExecRouteOptions {
  /** Test injection: stands in for `docker run` (src/exec/sandbox.ts). */
  run?: SandboxRun;
}

export function registerExecRoutes(app: FastifyInstance, db: Database.Database, opts: ExecRouteOptions = {}): void {
  app.get('/api/exec/status', async () => {
    const s = sandboxSettings(db);
    return {
      enabled: s.enabled,
      image: s.image,
      gpus: s.gpus,
      memory: s.memory,
      cpus: s.cpus,
      timeout_sec: s.timeoutSec,
      max_timeout_sec: s.maxTimeoutSec,
      max_concurrency: s.maxConcurrency,
    };
  });

  app.post('/api/exec/run', async (req, reply) => {
    const s = sandboxSettings(db);
    if (!s.enabled) return reply.code(409).send({ error: '執行沙盒未啟用（loop config set exec_enabled true）' });
    const b = (req.body ?? {}) as { run_id?: unknown; command?: unknown; timeout_sec?: unknown };
    const runId = typeof b.run_id === 'string' ? b.run_id.trim() : '';
    const command = typeof b.command === 'string' ? b.command : '';
    if (!runId) return reply.code(400).send({ error: 'run_id is required' });
    if (!command.trim()) return reply.code(400).send({ error: 'command is required' });
    const run = getRun(db, runId);
    if (!run) return reply.code(404).send({ error: `no such run: ${runId}` });
    if (run.finished_at) return reply.code(409).send({ error: `run ${runId} 已結束；沙盒只在執行中可用` });
    const wt = run.worktree_path;
    if (!wt || !fs.existsSync(wt)) return reply.code(409).send({ error: `run ${runId} 沒有可用的工作目錄` });

    const r = await (opts.run ?? runSandbox)(s, { workdir: wt, command, timeoutSec: b.timeout_sec, scope: `task:${run.task_id}` });
    // an audit trail of what the agent executed, on the task's own timeline
    const shown = command.replace(/\s+/g, ' ').trim();
    logEvent(db, {
      task_id: run.task_id,
      run_id: run.id,
      kind: 'note',
      detail: `沙盒：${shown.length > 160 ? `${shown.slice(0, 160)}…` : shown} → ${summarizeSandboxResult(r)}`,
    });
    return { ...r, text: formatSandboxResult(r) };
  });
}
