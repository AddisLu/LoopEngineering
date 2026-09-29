import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { buildApp } from '../server/app.js';

/**
 * The operator pages said 還沒填名字 to people the engine already knew from their Tailscale login
 * (their 試跑 were recorded under that name). GET /api/whoami tells the page who the engine takes
 * the browser to be, so the header can show it.
 */

let db: Database.Database;
let app: FastifyInstance | undefined;

beforeEach(() => {
  db = openTestDb();
  app = undefined;
});
afterEach(async () => {
  await app?.close();
  db.close();
});

describe('GET /api/whoami', () => {
  it('reports the Tailscale login first, then the typed name, else this machine', async () => {
    app = buildApp({ db, apiToken: null });
    const ts = await app.inject({ method: 'GET', url: '/api/whoami', headers: { 'tailscale-user-login': 'AddisLyu@gmail.com', 'x-loop-user': 'someone' } });
    expect(ts.json()).toMatchObject({ user_key: 'ts:addislyu@gmail.com', source: 'tailscale' });
    const typed = await app.inject({ method: 'GET', url: '/api/whoami', headers: { 'x-loop-user': encodeURIComponent('呂侑儒') } });
    expect(typed.json()).toMatchObject({ label: '呂侑儒', source: 'manual' });
    expect((await app.inject({ method: 'GET', url: '/api/whoami' })).json()).toMatchObject({ user_key: 'local', source: 'local' });
  });
});
