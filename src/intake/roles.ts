import type Database from 'better-sqlite3';
import { getSetting } from '../db/index.js';
import { parseAllowedUsers } from '../terminal/access.js';

/**
 * 角色與核可 (settings `approval_mode`, `manager_users`). `self` (the default): whoever opened a
 * 問題單 starts it. `manager`: 開始修 by someone who is not a manager only sends it for approval
 * (tasks.approval_state = 'awaiting'); a manager's 核可 queues it. Start approval has its own
 * columns (start_approved_by/at) so it never collides with the 驗收核可 approved_by/at.
 */

export type ApprovalMode = 'self' | 'manager';

export function approvalMode(db: Database.Database): ApprovalMode {
  return (getSetting(db, 'approval_mode') ?? '').trim() === 'manager' ? 'manager' : 'self';
}

/**
 * Is this identity (`ts:<login>` / `name:<name>` / `local`, see server/identity.ts) listed in
 * manager_users? Matched exactly like ops_allowed_users / terminal_allowed_users: case-insensitive,
 * whole entries only.
 */
export function isManager(db: Database.Database, userKey: string | null | undefined): boolean {
  return Boolean(userKey) && parseAllowedUsers(getSetting(db, 'manager_users') || '').has(String(userKey).toLowerCase());
}
