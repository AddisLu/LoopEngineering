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

// Resume prompt: the run was cut off near the usage limit (or its verification failed).
// --resume restores the Claude session; HANDOFF.md / LOOP_RESUME_CONTEXT.md in the
// worktree restore the work state. Tell it to continue from there rather than restart.
const RESUME_PROMPT =
  '你在逼近使用上限時被中斷（或上次的 verification 未通過）。--resume 已還原 Claude session，' +
  'worktree 內的 HANDOFF.md 與（若有）LOOP_RESUME_CONTEXT.md 已保留先前狀態。' +
  '請先讀 LOOP_TASK.md、HANDOFF.md 與 LOOP_RESUME_CONTEXT.md，從未完成處接續，' +
  '不要重頭來過；修到 verification steps 全綠，並持續更新／commit HANDOFF.md。';

export function promptFor(ctx: DispatchContext): string {
  if (!ctx.resume) return PROMPT;
  const h = ctx.handoff?.trim();
  return h ? `${RESUME_PROMPT}\n\n先前交接摘要（節錄）：\n${h.slice(0, 1500)}` : RESUME_PROMPT;
}

export function buildClaudeArgs(ctx: DispatchContext): string[] {
  // 任務執行中查知識庫: the loop/loop-fs tools join the allow-list itself (they are values of
  // --allowed-tools, not standalone flags) so a mid-run lookup never stops on a prompt.
  const allowed = [...DEFAULT_ALLOWED_TOOLS, ...(ctx.mcpConfigPath ? (ctx.mcpTools ?? []) : [])];
  const args = [
    '-p',
    promptFor(ctx),
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode',
    'acceptEdits',
    '--allowed-tools',
    ...allowed,
  ];
  // --strict-mcp-config keeps the user's own servers out of a task run: what a task may reach
  // is decided here, not by whatever is in ~/.claude.json.
  if (ctx.mcpConfigPath) args.push('--mcp-config', ctx.mcpConfigPath, '--strict-mcp-config');
  if (ctx.model && ctx.model !== 'default') args.push('--model', ctx.model);
  if (ctx.resumeSessionId) args.push('--resume', ctx.resumeSessionId);
  return args;
}

export const claudeCodeAdapter: Adapter = {
  name: 'claude-code',
  dispatch(ctx: DispatchContext): DispatchHandle {
    // Never --bare (skips hooks) and never --dangerously-skip-permissions.
    return spawnStreaming('claude', buildClaudeArgs(ctx), ctx, ctx.env ? { ...process.env, ...ctx.env } : process.env);
  },
};
