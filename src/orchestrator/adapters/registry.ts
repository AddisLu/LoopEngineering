import type { Adapter } from './types.js';
import { claudeCodeAdapter } from './claudeCode.js';
import { mockAdapter } from './mock.js';

/**
 * Two axes that today's code conflates and this registry keeps separate:
 *  - `coding_tool` (a Task field): the task's TYPE / workspace mode — claude-code | mock |
 *    generic | plan | deploy. Governs worktree vs. mock scratch-dir vs. persistent output
 *    dir. 'generic' ROUTES to whichever backend is selected below; it is not a backend.
 *  - `agent_backend` (a setting): which CLI actually gets spawned for a real (non-mock)
 *    run — 'claude-code' today, 'copilot-cli' reserved for a future company deployment
 *    on GitHub Copilot CLI. Swapping this setting swaps the backend everywhere at once
 *    (see pickAdapter in run.ts) without the orchestrator or `coding_tool` changing.
 */
const backends: Record<string, Adapter> = {
  'claude-code': claudeCodeAdapter,
  mock: mockAdapter,
};

/** Backend ids currently registered (includes any test-only ids added via registerBackend). */
export function registeredBackends(): string[] {
  return Object.keys(backends);
}

/** Test-only hook: register an additional backend id (e.g. an echo/spy adapter) so
 * `agent_backend` swap can be asserted without a real external CLI. */
export function registerBackend(id: string, adapter: Adapter): void {
  backends[id] = adapter;
}

/** Unknown id falls back to claude-code — a bad `agent_backend` setting must never
 * throw and break dispatch; it degrades to today's default behavior instead. */
export function getBackend(name: string): Adapter {
  return backends[name] ?? claudeCodeAdapter;
}
