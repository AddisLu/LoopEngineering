import type { Adapter, DispatchContext, DispatchHandle } from './types.js';
import { spawnStreaming } from './spawn.js';
import { promptFor } from './claudeCode.js';
import type { LocalModel } from '../../local/models.js';
import type { McpServerCfg } from '../../mcp/config.js';

/**
 * 本地模型 backend: drives a model served by vLLM through opencode's headless mode
 * (`opencode run --format json`). Selected by pickAdapter whenever a task's resolved model is
 * 'local:<id>' — never via agent_backend. The provider/permission config is passed inline via
 * OPENCODE_CONFIG_CONTENT (opencode's highest-precedence config layer), so nothing is written
 * into the task worktree and the user's global opencode config is left alone.
 */

export const OPENCODE_PROVIDER_ID = 'loop-local';
export const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:8000/v1';

export function buildOpencodeConfig(model: LocalModel, baseUrl: string = DEFAULT_LOCAL_BASE_URL, mcp: McpServerCfg[] = []): string {
  // the same servers the chat page bridges (mcp_servers_json); opencode speaks MCP natively
  const mcpBlock = Object.fromEntries(
    mcp.filter((s) => s.enabled).map((s) => [s.name, { type: 'local', command: s.command, ...(s.cwd ? { cwd: s.cwd } : {}), environment: s.environment ?? {}, enabled: true, ...(s.timeout ? { timeout: s.timeout } : {}) }]),
  );
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    provider: {
      [OPENCODE_PROVIDER_ID]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Loop local vLLM',
        options: { baseURL: baseUrl, apiKey: 'local' },
        models: { [model.served_model_id]: { name: model.display_name } },
      },
    },
    model: `${OPENCODE_PROVIDER_ID}/${model.served_model_id}`,
    ...(Object.keys(mcpBlock).length ? { mcp: mcpBlock } : {}),
    // `--auto` approves every permission that is not explicitly denied, so deny what an
    // unattended run must never do: fetch from the network, push (integration is the engine's
    // FF-only close-out, never the agent's), escalate, or wipe outside the worktree.
    permission: {
      webfetch: 'deny',
      bash: {
        '*': 'allow',
        'git push*': 'deny',
        'sudo *': 'deny',
        'rm -rf /*': 'deny',
        'rm -rf ~*': 'deny',
      },
    },
  });
}

export function buildOpencodeArgs(ctx: DispatchContext & { local: LocalModel }): string[] {
  const args = [
    'run',
    '--model',
    `${OPENCODE_PROVIDER_ID}/${ctx.local.served_model_id}`,
    '--format',
    'json',
    '--auto',
    '--dir',
    ctx.cwd,
    '--title',
    `loop ${ctx.task.id}`,
  ];
  if (ctx.resumeSessionId) args.push('--session', ctx.resumeSessionId);
  args.push(promptFor(ctx));
  return args;
}

/** A dispatch that fails before spawning (pid 0 so killRun/isAlive never signal anything). */
function failedHandle(error: string): DispatchHandle {
  return {
    pid: 0,
    wait: Promise.resolve({ exitCode: null, sessionId: null, usageJson: null, resultSubtype: null, signal: null, error }),
  };
}

export const opencodeAdapter: Adapter = {
  name: 'opencode',
  dispatch(ctx: DispatchContext): DispatchHandle {
    const local = ctx.local;
    if (!local) {
      return failedHandle(
        `opencode backend needs a registered local model (model=${ctx.model ?? 'none'}) — see loop local list`,
      );
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(ctx.env ?? {}),
      OPENCODE_CONFIG_CONTENT: buildOpencodeConfig(local, ctx.localBaseUrl || DEFAULT_LOCAL_BASE_URL, ctx.mcpServers ?? []),
    };
    // LOOP_OPENCODE_BIN: test seam (a replay script) / non-PATH installs.
    return spawnStreaming(process.env.LOOP_OPENCODE_BIN || 'opencode', buildOpencodeArgs({ ...ctx, local }), ctx, env);
  },
};
