import type { ToolSource } from '../chat/tools.js';

/**
 * 對話操作 (chat operations): the chat page's local model prepares work — a task, a benchmark, a
 * task / benchmark / model action, a git action — from the engine's templates, and a person
 * confirms it in a LATER turn (or with the card's button) before anything runs.
 */

/** Who is asking, in which conversation, from which (streaming) answer row. Built by the engine, never by the model. */
export interface ChatCtx {
  /** the assistant row this answer is being written into */
  messageId: string;
  conversationId: string;
  userKey: string;
  /** the display name recorded as "who did it" (approved_by, event notes) */
  label: string;
}

export type ActionKind = 'work' | 'benchmark' | 'task' | 'bench_op' | 'model' | 'git';
/** high: the confirming message must carry the action's code (「確認 K7Q」) */
export type Risk = 'normal' | 'high';
/** fast: runs within the confirm call; slow: a background job; deferred: after this answer has finished */
export type Speed = 'fast' | 'slow' | 'deferred';
export type ActionStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled' | 'superseded' | 'expired' | 'interrupted';

/** What a preparer hands to the action store: everything needed to run it later, and what to show. */
export interface Prepared {
  kind: ActionKind;
  op: string;
  target: string | null;
  /** exactly what will run, template-completed by the engine */
  params: unknown;
  /** the precondition fingerprint checked again right before running (e.g. { status: 'attention' }) */
  expect: unknown;
  /** engine-written, shown verbatim on the card and in the answer */
  summary: string;
  risk: Risk;
  speed: Speed;
  draftId?: string | null;
  mdSha?: string | null;
  links?: ToolSource[];
}

export interface ActionResult {
  ok: boolean;
  detail: string;
  links?: ToolSource[];
  data?: unknown;
}

export interface OpsAction {
  id: string;
  code: string;
  conversation_id: string;
  user_key: string;
  user_label: string | null;
  kind: ActionKind;
  op: string;
  target: string | null;
  params: unknown;
  expect: unknown;
  summary: string;
  risk: Risk;
  speed: Speed;
  draft_id: string | null;
  md_sha: string | null;
  prepared_msg_id: string;
  presented_msg_id: string;
  presented_ord: number;
  confirmed_msg_id: string | null;
  confirmed_by: 'chat' | 'button' | null;
  status: ActionStatus;
  result: ActionResult | null;
  error: string | null;
  expires_at: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

/** What the card and the API show about an action. */
export interface ActionView {
  id: string;
  code: string;
  kind: ActionKind;
  op: string;
  target: string | null;
  summary: string;
  risk: Risk;
  status: ActionStatus;
  expires_at: string;
  started_at: string | null;
  finished_at: string | null;
  result: ActionResult | null;
  error: string | null;
}
