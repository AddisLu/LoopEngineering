import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { validateSetting } from '../settings.js';
import { appendMessage, createConversation, truncateFrom } from '../chat/store.js';
import { classifyReply } from '../chatops/affirm.js';
import {
  cancelAction,
  checkButtonConfirm,
  checkTypedConfirm,
  claim,
  createPending,
  findAction,
  finishAction,
  markInterrupted,
  markPresented,
  pendingFor,
} from '../chatops/actions.js';
import type { ChatCtx, Prepared } from '../chatops/types.js';

// 對話操作's confirm protocol: nothing the chat model prepares runs until the person says yes in a
// LATER turn (or clicks), and the server — not the model — decides whether that happened.
let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => db.close());

const USER = 'ts:addis@example.com';
const prep = (over: Partial<Prepared> = {}): Prepared => ({
  kind: 'task',
  op: 'queue',
  target: 't_1',
  params: { id: 't_1' },
  expect: { status: 'draft' },
  summary: '把 t_1 排入',
  risk: 'normal',
  speed: 'fast',
  ...over,
});

/** A conversation driven the way the page does it: the user row, then an empty answer row. */
function convo(user = USER) {
  const c = createConversation(db, { user_key: user });
  const turn = (text: string): ChatCtx => {
    appendMessage(db, c.id, user, { role: 'user', content: text });
    const a = appendMessage(db, c.id, user, { role: 'assistant', content: '' });
    return { messageId: a.id, conversationId: c.id, userKey: user, label: 'addis' };
  };
  return { c, turn };
}
const never = () => false;

describe('classifyReply: only a plain yes counts', () => {
  it.each([
    ['確認', true],
    ['好，開始', true],
    ['OK', true],
    ['沒問題', true],
    ['確認 K7Q', true],
    ['好，但標題改成 X', false],
    ['不要', false],
    ['等一下', false],
    ['可以嗎？', false],
    ['幫我確認一下現在的狀況', false],
    ['開一場新的評比', false],
    ['好的，另外再幫我把第二張任務也排進去然後通知我', false],
  ])('%s → %s', (text, yes) => {
    expect(classifyReply(text, 'K7Q').affirmative).toBe(yes);
  });

  it('sees the code wherever it is typed', () => {
    expect(classifyReply('確認K7Q', 'K7Q').hasCode).toBe(true);
    expect(classifyReply('k7q 確認', 'K7Q').hasCode).toBe(true);
    expect(classifyReply('確認', 'K7Q').hasCode).toBe(false);
  });
});

describe('the typed confirm', () => {
  it('is refused in the turn that prepared it, and allowed after the person says yes', () => {
    const { turn } = convo();
    const t1 = turn('把 t_1 排入');
    const a = createPending(db, t1, prep());
    expect(a).toMatchObject({ status: 'pending', presented_msg_id: t1.messageId });
    expect(a.code).toMatch(/^[A-Z0-9]{3}$/);
    // the same answer tries to confirm right away: no user message after it
    expect(checkTypedConfirm(db, t1, undefined, never)).toMatchObject({ ok: false, reason: expect.stringContaining('還沒有回覆') });
    const t2 = turn('確認');
    expect(checkTypedConfirm(db, t2, undefined, never)).toMatchObject({ ok: true, action: { id: a.id } });
  });

  it('only for the action the answer right before showed; ops_show re-presents it', () => {
    const { turn } = convo();
    const a = createPending(db, turn('把 t_1 排入'), prep());
    turn('先等等');
    const t3 = turn('確認');
    expect(checkTypedConfirm(db, t3, undefined, never)).toMatchObject({ ok: false, reason: expect.stringContaining('不是上一則回答出示的') });
    markPresented(db, a.id, t3);
    const t4 = turn('確認');
    expect(checkTypedConfirm(db, t4, undefined, never).ok).toBe(true);
  });

  it('refuses a reply that is not a plain yes, and a high-risk action without its code', () => {
    const { turn } = convo();
    createPending(db, turn('中止 t_1'), prep({ op: 'abort', risk: 'high' }));
    expect(checkTypedConfirm(db, turn('好，但先等我看一下'), undefined, never)).toMatchObject({ ok: false });
    const { turn: turn2 } = convo();
    const a = createPending(db, turn2('中止 t_1'), prep({ op: 'abort', risk: 'high' }));
    expect(checkTypedConfirm(db, turn2('確認'), undefined, never)).toMatchObject({ ok: false, reason: expect.stringContaining(`確認 ${a.code}`) });
    const { turn: turn3 } = convo();
    const b = createPending(db, turn3('中止 t_1'), prep({ op: 'abort', risk: 'high' }));
    expect(checkTypedConfirm(db, turn3(`確認 ${b.code}`), undefined, never).ok).toBe(true);
  });

  it('refuses while the answer that showed it is still streaming, and a wrong code', () => {
    const { turn } = convo();
    const t1 = turn('把 t_1 排入');
    const a = createPending(db, t1, prep());
    const t2 = turn('確認');
    expect(checkTypedConfirm(db, t2, undefined, (id) => id === t1.messageId)).toMatchObject({ ok: false, reason: expect.stringContaining('還在產生中') });
    expect(checkTypedConfirm(db, t2, 'ZZZ', never)).toMatchObject({ ok: false, reason: expect.stringContaining(a.code) });
  });

  it('a regenerated answer adds no user message; editing the question retires the action', () => {
    const { c, turn } = convo();
    const t1 = turn('把 t_1 排入');
    createPending(db, t1, prep());
    // 重答: the answer row is soft-deleted and a new one appended — no new user row
    const ord = (db.prepare('SELECT ord FROM chat_messages WHERE id = ?').get(t1.messageId) as { ord: number }).ord;
    truncateFrom(db, c.id, USER, ord);
    const again = appendMessage(db, c.id, USER, { role: 'assistant', content: '' });
    expect(checkTypedConfirm(db, { ...t1, messageId: again.id }, undefined, never)).toMatchObject({ ok: false });
    expect(pendingFor(db, c.id, USER)).toBeNull(); // the answer that showed it is gone
  });

  it('another person, another conversation, or an expired action is not found', () => {
    const { turn } = convo();
    const t1 = turn('把 t_1 排入');
    const a = createPending(db, t1, prep());
    const other = convo('name:someone').turn('確認');
    expect(checkTypedConfirm(db, other, a.code, never)).toMatchObject({ ok: false, reason: expect.stringContaining('沒有待確認') });
    const t2 = turn('確認');
    expect(checkTypedConfirm(db, t2, undefined, never, new Date(Date.now() + 31 * 60_000))).toMatchObject({ ok: false, reason: expect.stringContaining('沒有待確認') });
    expect(findAction(db, a.code, USER, t1.conversationId)?.status).toBe('expired');
  });

  it('a new preparation supersedes the pending one', () => {
    const { turn } = convo();
    const a = createPending(db, turn('把 t_1 排入'), prep());
    const b = createPending(db, turn('不對，排 t_2'), prep({ target: 't_2' }));
    expect(findAction(db, a.id, USER)?.status).toBe('superseded');
    expect(pendingFor(db, b.conversation_id, USER)?.id).toBe(b.id);
  });
});

describe('button, claim, cancel and restarts', () => {
  it('the button needs only the owner and a pending action; a claim wins exactly once', () => {
    const { turn } = convo();
    const a = createPending(db, turn('把 t_1 排入'), prep());
    expect(checkButtonConfirm(db, a.id, 'name:someone')).toMatchObject({ ok: false, reason: '找不到這個動作。' });
    expect(checkButtonConfirm(db, a.id, USER).ok).toBe(true);
    expect(claim(db, a.id, { msgId: null, by: 'button' })).toBe(true);
    expect(claim(db, a.id, { msgId: 'm_x', by: 'chat' })).toBe(false);
    expect(checkButtonConfirm(db, a.id, USER)).toMatchObject({ ok: false, reason: expect.stringContaining('執行中') });
    finishAction(db, a.id, { ok: true, detail: '已排入' });
    expect(findAction(db, a.id, USER)).toMatchObject({ status: 'done', result: { ok: true, detail: '已排入' }, confirmed_by: 'button' });
  });

  it('cancel drops only a pending action; a restart marks running jobs interrupted', () => {
    const { turn } = convo();
    const t1 = turn('把 t_1 排入');
    const a = createPending(db, t1, prep());
    expect(cancelAction(db, null, USER, t1.conversationId)?.status).toBe('cancelled');
    expect(cancelAction(db, a.id, USER)).toBeNull();
    const b = createPending(db, turn('再排一次'), prep());
    claim(db, b.id, { msgId: null, by: 'button' });
    expect(markInterrupted(db)).toBe(1);
    expect(findAction(db, b.id, USER)?.status).toBe('interrupted');
  });
});

describe('settings', () => {
  it('validate the new keys', () => {
    expect(validateSetting('ops_chat_enabled', 'yes')).toMatch(/true or false/);
    expect(validateSetting('ops_allowed_users', 'ts:a@b.c, name:x')).toBeNull();
    expect(validateSetting('ops_allowed_users', 'bob')).toMatch(/ts:<login>/);
    expect(validateSetting('ops_hide_mcp_servers', 'loop,loop-ops')).toBeNull();
    expect(validateSetting('ops_hide_mcp_servers', 'Loop Ops')).toMatch(/CSV/);
    expect(validateSetting('git_clone_root', 'repos')).toMatch(/absolute/);
    expect(validateSetting('ops_confirm_ttl_min', '-1')).toMatch(/non-negative/);
  });
});
