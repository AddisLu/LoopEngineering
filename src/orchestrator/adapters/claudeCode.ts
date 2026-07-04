import type { Adapter, DispatchContext, DispatchHandle } from './types.js';
import { spawnStreaming } from './spawn.js';

/**
 * Default tool allow-list written to settings.local.json AND passed via --allowed-tools
 * (same source). Deliberately NOT the whole `Bash` tool — only scoped git/npm.
 * Runaway protection is the watchdog timeout + budget-guard hook (there is no
 * --max-turns flag in claude 2.1.201).
 */
export const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Grep',
  'Glob',
  'Bash(git:*)',
  'Bash(npm:*)',
  'Bash(node:*)',
  'Bash(ls:*)',
  'Bash(cat:*)',
];

const PROMPT = '請先完整閱讀 LOOP_TASK.md，依其執行任務，完成後自行跑 verification steps 並修到通過。';

export function buildClaudeArgs(ctx: DispatchContext): string[] {
  const args = [
    '-p',
    PROMPT,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    'acceptEdits',
    '--allowed-tools',
    ...DEFAULT_ALLOWED_TOOLS,
  ];
  if (ctx.model && ctx.model !== 'default') args.push('--model', ctx.model);
  if (ctx.resumeSessionId) args.push('--resume', ctx.resumeSessionId);
  return args;
}

export const claudeCodeAdapter: Adapter = {
  name: 'claude-code',
  dispatch(ctx: DispatchContext): DispatchHandle {
    // Never --bare (skips hooks) and never --dangerously-skip-permissions.
    return spawnStreaming('claude', buildClaudeArgs(ctx), ctx, process.env);
  },
};
