import type Database from 'better-sqlite3';
import { customAlphabet, nanoid } from 'nanoid';
import { getNum } from '../db/index.js';
import { classifyReply } from './affirm.js';
import type { ActionResult, ActionStatus, ActionView, ChatCtx, OpsAction, Prepared } from './types.js';

/**
 * The 對話操作 action store and its confirm protocol (schema.sql: ops_actions).
 *
 * A preparer stores a PENDING action; nothing runs. It runs once a person confirms:
 *  - typed, in the turn right after the answer that prepared (or re-showed) it — the person's
 *    reply must be a plain yes (affirm.ts), carry the code for a high-risk action, and come after
 *    that answer finished streaming. The model can never confirm in the turn that prepared, since
 *    no newer user message exists yet.
 *  - or with the card's button (the page's own request, carrying the person's identity).
 * One pending action per conversation: preparing another supersedes it. Claiming is a
 * compare-and-swap, so a typed confirm and a click can never both run it.
 */

interface Row {
  id: string;
  code: string;
  conversation_id: string;
  user_key: string;
  user_label: string | null;
  kind: string;
  op: string;
  target: string | null;
  params_json: string;
  expect_json: string | null;
  summary: string;
  risk: string;
  speed: string;
  draft_id: string | null;
  md_sha: string | null;
  prepared_msg_id: string;
  presented_msg_id: string;
  presented_ord: number;
  confirmed_msg_id: string | null;
  confirmed_by: string | null;
  status: string;
  result_json: string | null;
  error: string | null;
  expires_at: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface MsgRow {
  id: string;
  conversation_id: string;
  ord: number;
  role: string;
  content: string;
  invalid_at: string | null;
}

const parse = <T>(raw: string | null, fallback: T): T => {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

function toAction(r: Row): OpsAction {
  return {
    id: r.id,
    code: r.code,
    conversation_id: r.conversation_id,
    user_key: r.user_key,
    user_label: r.user_label,
    kind: r.kind as OpsAction['kind'],
    op: r.op,
    target: r.target,
    params: parse<unknown>(r.params_json, {}),
    expect: parse<unknown>(r.expect_json, null),
    summary: r.summary,
    risk: r.risk === 'high' ? 'high' : 'normal',
    speed: r.speed === 'slow' || r.speed === 'deferred' ? r.speed : 'fast',
    draft_id: r.draft_id,
    md_sha: r.md_sha,
    prepared_msg_id: r.prepared_msg_id,
    presented_msg_id: r.presented_msg_id,
    presented_ord: r.presented_ord,
    confirmed_msg_id: r.confirmed_msg_id,
    confirmed_by: r.confirmed_by === 'chat' || r.confirmed_by === 'button' ? r.confirmed_by : null,
    status: r.status as ActionStatus,
    result: parse<ActionResult | null>(r.result_json, null),
    error: r.error,
    expires_at: r.expires_at,
    created_at: r.created_at,
    started_at: r.started_at,
    finished_at: r.finished_at,
  };
}

export function actionView(a: OpsAction): ActionView {
  return {
    id: a.id,
    code: a.code,
    kind: a.kind,
    op: a.op,
    target: a.target,
    summary: a.summary,
    risk: a.risk,
    status: a.status,
    expires_at: a.expires_at,
    started_at: a.started_at,
    finished_at: a.finished_at,
    result: a.result,
    error: a.error,
  };
}

/** sqlite's own clock format ("YYYY-MM-DD HH:MM:SS", UTC) so expiry compares with datetime('now') */
const sqliteTime = (d: Date): string => d.toISOString().slice(0, 19).replace('T', ' ');

// no 0/O, 1/I/L, 2/Z, 5/S, 6/G, 8/B: a code read aloud or retyped from a phone survives
const codeOf = customAlphabet('ACDEFHJKMNPQRTUVWXY3479', 3);

function message(db: Database.Database, id: string): MsgRow | undefined {
  return db.prepare('SELECT id, conversation_id, ord, role, content, invalid_at FROM chat_messages WHERE id = ?').get(id) as MsgRow | undefined;
}

export class OpsActionError extends Error {}

/**
 * Store a prepared action as the conversation's one pending action (any earlier pending one is
 * superseded). `chat.messageId` is the answer doing the preparing: the person confirms in the turn
 * right after it.
 */
export function createPending(db: Database.Database, chat: ChatCtx, p: Prepared, now: Date = new Date()): OpsAction {
  const msg = message(db, chat.messageId);
  if (!msg || msg.conversation_id !== chat.conversationId || msg.invalid_at) throw new OpsActionError('這則回答已經不在對話裡，無法準備動作');
  const ttl = Math.max(1, getNum(db, 'ops_confirm_ttl_min', 30));
  const id = `oa_${nanoid(10)}`;
  const busy = new Set(
    (db.prepare("SELECT code FROM ops_actions WHERE conversation_id = ? AND status IN ('pending','running')").all(chat.conversationId) as Array<{ code: string }>).map(
      (r) => r.code,
    ),
  );
  let code = codeOf();
  for (let i = 0; busy.has(code) && i < 20; i++) code = codeOf();
  db.transaction(() => {
    db.prepare("UPDATE ops_actions SET status = 'superseded', finished_at = datetime('now') WHERE conversation_id = ? AND status = 'pending'").run(chat.conversationId);
    db.prepare(
      `INSERT INTO ops_actions (id, code, conversation_id, user_key, user_label, kind, op, target, params_json, expect_json,
         summary, risk, speed, draft_id, md_sha, prepared_msg_id, presented_msg_id, presented_ord, expires_at)
       VALUES (@id, @code, @conversation_id, @user_key, @user_label, @kind, @op, @target, @params_json, @expect_json,
         @summary, @risk, @speed, @draft_id, @md_sha, @msg, @msg, @ord, @expires_at)`,
    ).run({
      id,
      code,
      conversation_id: chat.conversationId,
      user_key: chat.userKey,
      user_label: chat.label || null,
      kind: p.kind,
      op: p.op,
      target: p.target,
      params_json: JSON.stringify(p.params ?? {}),
      expect_json: p.expect == null ? null : JSON.stringify(p.expect),
      summary: p.summary,
      risk: p.risk,
      speed: p.speed,
      draft_id: p.draftId ?? null,
      md_sha: p.mdSha ?? null,
      msg: chat.messageId,
      ord: msg.ord,
      expires_at: sqliteTime(new Date(now.getTime() + ttl * 60_000)),
    });
  })();
  return getActionById(db, id)!;
}

/** ops_show on a pending action shows it again: the person may now confirm in the next turn. */
export function markPresented(db: Database.Database, id: string, chat: ChatCtx, now: Date = new Date()): void {
  const msg = message(db, chat.messageId);
  if (!msg || msg.conversation_id !== chat.conversationId || msg.invalid_at) return;
  const ttl = Math.max(1, getNum(db, 'ops_confirm_ttl_min', 30));
  // only ever forward, to a live answer: never back onto an older or regenerated one
  db.prepare(
    "UPDATE ops_actions SET presented_msg_id = ?, presented_ord = ?, expires_at = ? WHERE id = ? AND conversation_id = ? AND user_key = ? AND status = 'pending' AND presented_ord <= ?",
  ).run(chat.messageId, msg.ord, sqliteTime(new Date(now.getTime() + ttl * 60_000)), id, chat.conversationId, chat.userKey, msg.ord);
}

/**
 * ops_show on a pending action: show it again so the person can confirm in the next turn — unless
 * the answer right before this one already showed it (then the person may be confirming right now,
 * and moving it would make their 「確認」 miss).
 */
export function reshow(db: Database.Database, a: OpsAction, chat: ChatCtx, now: Date = new Date()): boolean {
  if (a.status !== 'pending' || a.conversation_id !== chat.conversationId || a.user_key !== chat.userKey) return false;
  const cur = message(db, chat.messageId);
  if (!cur) return false;
  const prev = db
    .prepare("SELECT MAX(ord) AS ord FROM chat_messages WHERE conversation_id = ? AND role = 'assistant' AND invalid_at IS NULL AND ord < ?")
    .get(chat.conversationId, cur.ord) as { ord: number | null };
  if (a.presented_ord >= (prev.ord ?? -1)) return false;
  markPresented(db, a.id, chat, now);
  return true;
}

/** Lazily retire pending actions: past their time, or shown by an answer that was since regenerated or deleted. */
export function refreshPending(db: Database.Database, conversationId: string, now: Date = new Date()): void {
  db.prepare("UPDATE ops_actions SET status = 'expired', finished_at = datetime('now') WHERE conversation_id = ? AND status = 'pending' AND expires_at < ?").run(
    conversationId,
    sqliteTime(now),
  );
  db.prepare(
    `UPDATE ops_actions SET status = 'superseded', finished_at = datetime('now')
      WHERE conversation_id = ? AND status = 'pending'
        AND NOT EXISTS (SELECT 1 FROM chat_messages m WHERE m.id = ops_actions.presented_msg_id AND m.invalid_at IS NULL)`,
  ).run(conversationId);
}

export function getActionById(db: Database.Database, id: string): OpsAction | null {
  const r = db.prepare('SELECT * FROM ops_actions WHERE id = ?').get(id) as Row | undefined;
  return r ? toAction(r) : null;
}

/** An action by id, or by its code within this user's conversation (codes are only unique per conversation). */
export function findAction(db: Database.Database, idOrCode: string, userKey: string, conversationId?: string | null): OpsAction | null {
  const key = String(idOrCode ?? '').trim();
  if (!key) return null;
  if (key.startsWith('oa_')) {
    const a = getActionById(db, key);
    return a && a.user_key === userKey ? a : null;
  }
  const code = key.replace(/^#/, '').toUpperCase();
  const r = (conversationId
    ? db.prepare('SELECT * FROM ops_actions WHERE code = ? AND user_key = ? AND conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(code, userKey, conversationId)
    : db.prepare('SELECT * FROM ops_actions WHERE code = ? AND user_key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(code, userKey)) as Row | undefined;
  return r ? toAction(r) : null;
}

/** The conversation's one pending action for this user, after retiring stale ones. */
export function pendingFor(db: Database.Database, conversationId: string, userKey: string, now: Date = new Date()): OpsAction | null {
  refreshPending(db, conversationId, now);
  const r = db
    .prepare("SELECT * FROM ops_actions WHERE conversation_id = ? AND user_key = ? AND status = 'pending' ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get(conversationId, userKey) as Row | undefined;
  return r ? toAction(r) : null;
}

export function listActions(db: Database.Database, o: { userKey: string; conversationId?: string | null; limit?: number }): OpsAction[] {
  const limit = Math.min(50, Math.max(1, o.limit ?? 10));
  const rows = (o.conversationId
    ? db.prepare('SELECT * FROM ops_actions WHERE user_key = ? AND conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(o.userKey, o.conversationId, limit)
    : db.prepare('SELECT * FROM ops_actions WHERE user_key = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(o.userKey, limit)) as Row[];
  return rows.map(toAction);
}

export type ConfirmCheck = { ok: true; action: OpsAction } | { ok: false; reason: string; action?: OpsAction };

/**
 * May the model confirm now, on the person's behalf? Only when ALL hold:
 *  - the conversation has a pending action (matching `code` when one is given);
 *  - it was prepared or re-shown by the answer right before this one;
 *  - the person has spoken since (a regenerated answer adds no user message);
 *  - that answer had finished streaming;
 *  - the person's latest message is a plain yes, carrying the code for a high-risk action.
 */
export function checkTypedConfirm(
  db: Database.Database,
  chat: ChatCtx,
  code: string | undefined,
  isRunning: (messageId: string) => boolean,
  now: Date = new Date(),
): ConfirmCheck {
  const a = pendingFor(db, chat.conversationId, chat.userKey, now);
  if (!a) return { ok: false, reason: '這個對話沒有待確認的動作（可能已過期、被取消，或已被新的準備取代）。' };
  if (code && code.replace(/^#/, '').toUpperCase() !== a.code) return { ok: false, reason: `待確認的動作代碼是 ${a.code}，不是 ${code}。`, action: a };
  const cur = message(db, chat.messageId);
  if (!cur || cur.conversation_id !== chat.conversationId || cur.invalid_at) return { ok: false, reason: '這則回答已經不在對話裡。', action: a };
  // the answer that prepared (or re-showed) it is this very answer: the person has not replied yet
  if (cur.ord <= a.presented_ord) return { ok: false, reason: '使用者還沒有回覆，不能代替使用者確認；把摘要給使用者看，等下一則回覆。', action: a };
  const prevA = db
    .prepare("SELECT MAX(ord) AS ord FROM chat_messages WHERE conversation_id = ? AND role = 'assistant' AND invalid_at IS NULL AND ord < ?")
    .get(chat.conversationId, cur.ord) as { ord: number | null };
  const lastU = db
    .prepare("SELECT id, ord, content FROM chat_messages WHERE conversation_id = ? AND role = 'user' AND invalid_at IS NULL AND ord < ? ORDER BY ord DESC LIMIT 1")
    .get(chat.conversationId, cur.ord) as { id: string; ord: number; content: string } | undefined;
  if (prevA.ord !== a.presented_ord) {
    return { ok: false, reason: `動作 ${a.code} 不是上一則回答出示的；先用 ops_show 把它再給使用者看一次，等使用者回覆後才能確認。`, action: a };
  }
  if (!lastU || lastU.ord <= a.presented_ord) return { ok: false, reason: '使用者還沒有回覆，不能代替使用者確認。', action: a };
  if (isRunning(a.presented_msg_id)) return { ok: false, reason: '出示這個動作的回答還在產生中，使用者還沒看到完整內容。', action: a };
  const reply = classifyReply(lastU.content, a.code);
  if (!reply.affirmative) return { ok: false, reason: `使用者的回覆不是明確的同意（${reply.reason}）；不要執行，照使用者的意思重新準備或取消。`, action: a };
  if (a.risk === 'high' && !reply.hasCode) return { ok: false, reason: `這是高風險動作，使用者要回覆「確認 ${a.code}」才能執行。`, action: a };
  return { ok: true, action: a };
}

/** The card's button: the page's own request, so only ownership, status, time and a still-present answer matter. */
export function checkButtonConfirm(db: Database.Database, idOrCode: string, userKey: string, now: Date = new Date()): ConfirmCheck {
  const found = findAction(db, idOrCode, userKey);
  if (!found) return { ok: false, reason: '找不到這個動作。' };
  refreshPending(db, found.conversation_id, now);
  const a = getActionById(db, found.id)!;
  if (a.status !== 'pending') return { ok: false, reason: `這個動作已經是「${STATUS_WORD[a.status]}」。`, action: a };
  return { ok: true, action: a };
}

/** Compare-and-swap pending → running; exactly one caller wins. */
export function claim(db: Database.Database, id: string, via: { msgId: string | null; by: 'chat' | 'button' }): boolean {
  return (
    db
      .prepare("UPDATE ops_actions SET status = 'running', confirmed_msg_id = ?, confirmed_by = ?, started_at = datetime('now') WHERE id = ? AND status = 'pending'")
      .run(via.msgId, via.by, id).changes === 1
  );
}

export function finishAction(db: Database.Database, id: string, r: ActionResult): void {
  db.prepare("UPDATE ops_actions SET status = ?, result_json = ?, error = ?, finished_at = datetime('now') WHERE id = ?").run(
    r.ok ? 'done' : 'failed',
    JSON.stringify(r),
    r.ok ? null : r.detail.slice(0, 2000),
    id,
  );
}

/** Drop a pending action (by id or code); null when there was nothing pending to drop. */
export function cancelAction(db: Database.Database, idOrCode: string | null, userKey: string, conversationId?: string | null): OpsAction | null {
  const a = idOrCode ? findAction(db, idOrCode, userKey, conversationId) : conversationId ? pendingFor(db, conversationId, userKey) : null;
  if (!a || a.status !== 'pending') return null;
  const changed = db.prepare("UPDATE ops_actions SET status = 'cancelled', finished_at = datetime('now') WHERE id = ? AND status = 'pending'").run(a.id).changes;
  return changed ? getActionById(db, a.id) : null;
}

/** At startup: a job that was running when the engine stopped did not finish — say so instead of 'running' forever. */
export function markInterrupted(db: Database.Database): number {
  return db
    .prepare("UPDATE ops_actions SET status = 'interrupted', error = '引擎在執行途中重新啟動，結果不確定；請到任務／評比頁確認', finished_at = datetime('now') WHERE status = 'running'")
    .run().changes;
}

export const STATUS_WORD: Record<ActionStatus, string> = {
  pending: '待確認',
  running: '執行中',
  done: '已完成',
  failed: '失敗',
  cancelled: '已取消',
  superseded: '已被新的準備取代',
  expired: '已過期',
  interrupted: '中斷（引擎重啟）',
};
