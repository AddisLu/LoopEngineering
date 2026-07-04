import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ALLOWED_TOOLS } from './adapters/claudeCode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// hooks/budget-guard.mjs lives at repo root (copied next to dist at build time too)
const BUDGET_GUARD = path.resolve(__dirname, '..', '..', 'hooks', 'budget-guard.mjs');

/**
 * Write <worktree>/.claude/settings.local.json for a dispatched task:
 * scoped tool allow-list + PreToolUse budget-guard hook (the in-flight inner
 * safeguard). Native sandbox keys are intentionally left to be confirmed against
 * official docs before enabling; see plan.
 */
export function writeSettingsLocal(worktree: string, hardLimitPct: number): void {
  const dir = path.join(worktree, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const settings = {
    permissions: {
      allow: DEFAULT_ALLOWED_TOOLS,
    },
    hooks: {
      PreToolUse: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: `node ${JSON.stringify(BUDGET_GUARD)}`,
              // budget-guard reads the shared usage cache and denies when
              // session% >= LOOP_HARD_LIMIT_PCT
            },
          ],
        },
      ],
    },
  };
  fs.writeFileSync(
    path.join(dir, 'settings.local.json'),
    JSON.stringify(settings, null, 2),
  );
  // export the threshold for the hook via env-in-file is not possible; the hook
  // reads LOOP_HARD_LIMIT_PCT from its own env, set when the engine spawns claude.
  void hardLimitPct;
}
