import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Adapter, DispatchContext, DispatchHandle, DispatchResult } from './types.js';

/**
 * GitHub Copilot CLI backend (`agent_backend='copilot-cli'`) — the company Windows 11
 * deployment. Copilot is a Claude-Code-shaped agentic terminal tool, but:
 *   - it does NOT emit Claude's stream-json (with `-s` it prints plain text), so this adapter
 *     does not reuse spawnStreaming/createNdjsonCollector — it synthesizes the DispatchResult
 *     from the exit code + stderr instead of parsing events;
 *   - it has no session/weekly usage API, so budget is enforced by the request-cap gate +
 *     watchdog (see usage_provider='none' in src/token/usage.ts + tick.ts), not the breaker;
 *   - it has no per-run usage to report -> usageJson is always null (audit-only anyway).
 *
 * The prompt is delivered via STDIN (equivalent to `echo "<prompt>" | copilot`), which keeps
 * the argv flag-only and metachar-free — so the Windows cmd.exe wrapper (needed because
 * `copilot` is a `.cmd` shim that Node's shell-less spawn can't launch) needs no fragile
 * quoting of the CJK/multiline prompt.
 */

// Copilot model ids differ from the loop's Claude aliases. Map the known aliases; pass through
// anything already Copilot-native (e.g. 'gpt-5'). null/'default' -> omit --model (Copilot default).
const COPILOT_MODEL_MAP: Record<string, string> = {
  sonnet: 'claude-sonnet-4.5',
  opus: 'claude-opus-4.1',
  haiku: 'claude-haiku-4.5',
};

export function mapModel(m: string | null): string | null {
  if (!m || m === 'default') return null;
  return COPILOT_MODEL_MAP[m] ?? m;
}

const PROMPT = '請先完整閱讀 LOOP_TASK.md，依其執行任務，完成後自行跑 verification steps 並修到通過。';

// Resume is prompt-based (Copilot has no reliable --resume): the worktree's HANDOFF.md carries
// the state, so a fresh run primed with this prompt continues rather than restarts.
const RESUME_PROMPT =
  '上次的執行被中斷或 verification 未通過。worktree 內的 HANDOFF.md 與（若有）' +
  'LOOP_RESUME_CONTEXT.md 已保留先前狀態。請先讀 LOOP_TASK.md、HANDOFF.md 與 ' +
  'LOOP_RESUME_CONTEXT.md，從未完成處接續，不要重頭來過；修到 verification steps 全綠，' +
  '並持續更新／commit HANDOFF.md。';

export function promptFor(ctx: DispatchContext): string {
  if (!ctx.resume) return PROMPT;
  const h = ctx.handoff?.trim();
  return h ? `${RESUME_PROMPT}\n\n先前交接摘要（節錄）：\n${h.slice(0, 1500)}` : RESUME_PROMPT;
}

/**
 * Flags only — no prompt here (it goes via stdin). Deliberately metachar-free so the win32
 * cmd.exe wrapper needs no arg quoting. `--allow-all-tools` for autonomy (scoped by cwd =
 * isolated worktree + the downstream verify pipeline); `--no-ask-user` so an unattended run
 * never blocks on a clarifying question; `-s` for clean, session-chrome-free stdout.
 */
export function buildCopilotArgs(ctx: DispatchContext): string[] {
  const args = ['-s', '--no-ask-user', '--allow-all-tools'];
  const model = mapModel(ctx.model);
  if (model) args.push('--model', model);
  return args;
}

// Detect "needs login / token expired" from Copilot's stderr so run.ts routes to attention
// (and pauses the scheduler) instead of burning premium requests re-dispatching unauthenticated.
const AUTH_FAIL_RE =
  /not (logged in|authenticated)|please (run|sign in)[^.]*login|authentication (failed|required)|device.?code|gh auth (login|status)|\b401\b|unauthorized/i;

export function looksUnauthenticated(s: string): boolean {
  return AUTH_FAIL_RE.test(s);
}

type SpawnFn = typeof spawn;

export interface CopilotDispatchOptions {
  /** Injectable for tests — defaults to node:child_process spawn. */
  spawnFn?: SpawnFn;
  /** Injectable for tests — defaults to process.platform. */
  platform?: NodeJS.Platform;
}

export function dispatchCopilot(ctx: DispatchContext, opts: CopilotDispatchOptions = {}): DispatchHandle {
  const spawnFn = opts.spawnFn ?? spawn;
  const platform = opts.platform ?? process.platform;
  const args = buildCopilotArgs(ctx);
  const prompt = promptFor(ctx);

  const logFd = fs.openSync(ctx.logPath, 'a');

  // Windows: `copilot` is a `.cmd` shim; launch it through cmd.exe. args are flag-only (no
  // spaces/CJK/metachars), so `/c "copilot <flags>"` is safe without arg quoting. POSIX:
  // spawn copilot directly (its own process group via detached, killed with kill(-pid)).
  const isWin = platform === 'win32';
  const cmd = isWin ? process.env.ComSpec ?? 'cmd.exe' : 'copilot';
  const spawnArgs = isWin ? ['/d', '/s', '/c', ['copilot', ...args].join(' ')] : args;

  const child = spawnFn(cmd, spawnArgs, {
    cwd: ctx.cwd,
    env: process.env,
    detached: true, // own group -> kill(-pid) (POSIX) / taskkill /T (win32) hits the whole tree
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Deterministic session id, emitted immediately so resume survives an early kill
  // (breaker/timeout) — run.ts persists it from this event before the process even finishes.
  const sessionId = `copilot-${ctx.run.id}`;
  ctx.onEvent?.({ session_id: sessionId });

  // Deliver the prompt over stdin (non-interactive; equivalent to piping). Guard EPIPE if the
  // child dies before we finish writing.
  child.stdin?.on('error', () => {
    /* child already gone */
  });
  try {
    child.stdin?.write(`${prompt}\n`);
    child.stdin?.end();
  } catch {
    /* ignore */
  }

  let stderrTail = '';
  child.stdout?.on('data', (d: Buffer) => {
    fs.writeSync(logFd, d);
  });
  child.stderr?.on('data', (d: Buffer) => {
    fs.writeSync(logFd, d);
    stderrTail = (stderrTail + d.toString('utf8')).slice(-4000);
  });

  const wait = new Promise<DispatchResult>((resolve) => {
    child.on('error', (err: Error) => {
      try {
        fs.closeSync(logFd);
      } catch {
        /* ignore */
      }
      resolve({ exitCode: null, sessionId, usageJson: null, resultSubtype: null, signal: null, error: err.message });
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      try {
        fs.closeSync(logFd);
      } catch {
        /* ignore */
      }
      const auth = looksUnauthenticated(stderrTail);
      resolve({
        exitCode: code,
        sessionId,
        usageJson: null,
        resultSubtype: auth ? 'auth-required' : code === 0 ? 'success' : 'error',
        signal: signal ?? null,
        ...(auth ? { error: 'copilot: not authenticated — run `copilot login`' } : {}),
      });
    });
  });

  return { pid: child.pid ?? -1, wait };
}

export const copilotCliAdapter: Adapter = {
  name: 'copilot-cli',
  dispatch(ctx: DispatchContext): DispatchHandle {
    return dispatchCopilot(ctx);
  },
};
