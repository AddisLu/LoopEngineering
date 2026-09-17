import type { FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { getBool, getSetting } from '../db/index.js';
import { identityOf, IdentityError, type ChatIdentity } from '../server/identity.js';

/**
 * Who may open a shell on this machine through the browser. Off unless terminal_enabled, and
 * then only identities listed in terminal_allowed_users — `ts:<login>` (the Tailscale header,
 * trusted because the server sits behind `tailscale serve` on 127.0.0.1), `name:<x>` (a typed
 * name: no authentication value, only for a trusted LAN) or `local` (no headers at all, i.e.
 * a developer on the box itself).
 */

export interface TerminalAccess {
  allowed: boolean;
  /** 404 = feature off, 403 = not on the list */
  code: 200 | 403 | 404;
  reason: string | null;
  user: ChatIdentity | null;
}

export function parseAllowedUsers(csv: string): Set<string> {
  return new Set(
    csv
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function terminalAccess(req: FastifyRequest, db: Database.Database, identity: (req: FastifyRequest) => ChatIdentity = identityOf): TerminalAccess {
  if (!getBool(db, 'terminal_enabled', false)) return { allowed: false, code: 404, reason: '終端機未啟用（terminal_enabled=false）', user: null };
  let user: ChatIdentity;
  try {
    user = identity(req);
  } catch (err) {
    if (err instanceof IdentityError) return { allowed: false, code: 403, reason: err.message, user: null };
    throw err;
  }
  const allowed = parseAllowedUsers(getSetting(db, 'terminal_allowed_users') || '');
  if (!allowed.has(user.user_key.toLowerCase())) {
    return { allowed: false, code: 403, reason: `這個身分（${user.user_key}）不在 terminal_allowed_users 內`, user };
  }
  return { allowed: true, code: 200, reason: null, user };
}
