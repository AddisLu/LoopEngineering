import path from 'node:path';
import type { Adapter, DispatchContext, DispatchHandle } from './types.js';
import { spawnStreaming } from './spawn.js';

/**
 * Zero-token adapter. Spawns a real detached Node process that emits the same
 * stream-json event shape as Claude Code and then exits — so the scheduler,
 * watchdog (timeout kill), breaker (SIGINT), and crash recovery (orphan by pid)
 * can all be exercised end-to-end without spending any tokens.
 *
 * Behaviour is driven by the task's model field / env, but defaults to a short
 * successful run that writes a marker file into the worktree.
 */
const RUNNER = `
const sleepMs = Number(process.env.MOCK_SLEEP_MS || '800');
const writeFile = process.env.MOCK_WRITE_FILE || '';
const exitCode = Number(process.env.MOCK_EXIT || '0');
const subtypeOverride = process.env.MOCK_RESULT_SUBTYPE || '';
const sid = process.env.MOCK_SESSION_ID || ('mock-' + process.pid);
const w = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let stopped = false;
const bail = (code) => { w({ type: 'result', subtype: 'interrupted', session_id: sid }); process.exit(code); };
process.on('SIGINT', () => { stopped = true; bail(130); });
process.on('SIGTERM', () => { stopped = true; bail(143); });
w({ type: 'system', subtype: 'init', session_id: sid });
const start = Date.now();
(function tick() {
  if (stopped) return;
  if (Date.now() - start >= sleepMs) {
    if (writeFile) { try { require('node:fs').appendFileSync(writeFile, 'mock did work\\n'); } catch {} }
    w({ type: 'assistant', text: 'done' });
    w({ type: 'result', subtype: subtypeOverride || (exitCode === 0 ? 'success' : 'error'), session_id: sid, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 });
    process.exit(exitCode);
  }
  w({ type: 'assistant', text: 'working...' });
  setTimeout(tick, 200);
})();
`;

export const mockAdapter: Adapter = {
  name: 'mock',
  dispatch(ctx: DispatchContext): DispatchHandle {
    const marker = path.join(ctx.cwd, 'mock-output.txt');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MOCK_WRITE_FILE: marker,
      MOCK_SLEEP_MS: process.env.MOCK_SLEEP_MS ?? '800',
      MOCK_EXIT: process.env.MOCK_EXIT ?? '0',
      MOCK_SESSION_ID: ctx.resumeSessionId ?? '',
    };
    return spawnStreaming(process.execPath, ['--input-type=module', '-e', RUNNER], ctx, env);
  },
};
