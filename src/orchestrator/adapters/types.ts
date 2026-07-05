import type { Task, TaskRun } from '../../types.js';

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
  onEvent?: (evt: any) => void; // live stream (SSE later)
}

export interface DispatchResult {
  exitCode: number | null;
  sessionId: string | null;
  usageJson: string | null;
  resultSubtype: string | null;
  signal: NodeJS.Signals | null;
  error?: string;
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
