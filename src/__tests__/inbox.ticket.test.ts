import { describe, it, expect } from 'vitest';
// @ts-expect-error plain browser module
import { awaiting, needsYou, startAwaiting } from '../../web/inbox.js';

const card = (over: Record<string, unknown>) => ({ id: 't_x', title: 'x', status: 'draft', gate: { ok: false, missing: ['repo'] }, ...over });

describe('需要你處理 / 待核可 with 問題單', () => {
  it('a ticket draft is never 草稿缺資料; a plain draft still is', () => {
    expect(needsYou(card({ ticket: true }))).toBe(false);
    expect(needsYou(card({}))).toBe(true);
  });
  it('a ticket waiting for a manager is 待核可（開工）, counted with 待核可', () => {
    const c = card({ ticket: true, approval_state: 'awaiting', requested_by: 'Eng' });
    expect([startAwaiting(c), awaiting(c), needsYou(c)]).toEqual([true, true, false]);
    expect(awaiting(card({ ticket: true, approval_state: 'rejected' }))).toBe(false);
    expect(awaiting(card({ status: 'review', merge_status: 'pending' }))).toBe(true);
  });
});
