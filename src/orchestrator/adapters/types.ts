import type { Task, TaskRun } from '../../types.js';
import type { LocalModel } from '../../local/models.js';

export interface DispatchContext {
  task: Task;
  run: TaskRun;
  cwd: string; // worktree path (or scratch dir for mock)
  taskFilePath: string; // absolute path to LOOP_TASK.md
  logPath: string; // where raw NDJSON is written
  model: string | null;
  timeoutMs: number;
  resumeSessionId?: string | null;
  resume?: boolean; // true when continuing an interrupted/verify-failed run (picks the resume prompt)
  handoff?: string | null; // restored HANDOFF.md / verify-failure context to prime the resume prompt
  /** 本地模型: registry row when the resolved model is 'local:<id>' (opencode adapter only). */
  local?: LocalModel | null;
  /** 本地模型: OpenAI-compatible base URL of the vLLM server (setting local_vllm_base_url). */
  localBaseUrl?: string;
  onEvent?: (evt: any) => void; // live stream (SSE later)
}

export interface DispatchResult {
  exitCode: number | null;
  sessionId: string | null;
  usageJson: string | null;
  resultSubtype: string | null;
  signal: NodeJS.Signals | null;
  error?: string;
  /** Token counts parsed from the stream (opencode step_finish sums / claude result.usage). */
  tokensIn?: number | null;
  tokensOut?: number | null;
}

export interface DispatchHandle {
  /** process-group leader pid; signal the whole group with process.kill(-pid, sig) */
  pid: number;
  wait: Promise<DispatchResult>;
}

export interface Adapter {
  name: string;
  dispatch(ctx: DispatchContext): DispatchHandle;
}
