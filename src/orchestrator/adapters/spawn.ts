import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { DispatchContext, DispatchHandle, DispatchResult } from './types.js';
import { createNdjsonCollector } from '../stream.js';

/**
 * Shared streaming spawn used by every adapter. Runs `cmd args` in ctx.cwd as its
 * own process group (detached) so the watchdog / circuit-breaker can signal the
 * whole tree with process.kill(-pid, ...). Raw NDJSON is appended to ctx.logPath
 * and each parsed event is forwarded to ctx.onEvent.
 */
export function spawnStreaming(
  cmd: string,
  args: string[],
  ctx: DispatchContext,
  env: NodeJS.ProcessEnv = process.env,
): DispatchHandle {
  const logFd = fs.openSync(ctx.logPath, 'a');
  const child = spawn(cmd, args, {
    cwd: ctx.cwd,
    env,
    detached: true, // new process group -> kill(-pid) hits the whole group
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const collector = createNdjsonCollector(ctx.onEvent);

  child.stdout.on('data', (d: Buffer) => {
    const s = d.toString('utf8');
    fs.writeSync(logFd, s);
    collector.push(s);
  });
  child.stderr.on('data', (d: Buffer) => {
    fs.writeSync(logFd, d);
  });

  const wait = new Promise<DispatchResult>((resolve) => {
    child.on('error', (err) => {
      try {
        fs.closeSync(logFd);
      } catch {
        /* ignore */
      }
      resolve({
        exitCode: null,
        sessionId: null,
        usageJson: null,
        resultSubtype: null,
        signal: null,
        error: err.message,
      });
    });
    child.on('close', (code, signal) => {
      collector.flush();
      try {
        fs.closeSync(logFd);
      } catch {
        /* ignore */
      }
      const r = collector.result();
      resolve({
        exitCode: code,
        sessionId: r.sessionId,
        usageJson: r.usageJson,
        resultSubtype: r.resultSubtype,
        signal: signal ?? null,
      });
    });
  });

  return { pid: child.pid ?? -1, wait };
}
