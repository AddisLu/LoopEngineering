import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { setCachedUsage } from '../token/usage.js';

let db: Database.Database;
let app: FastifyInstance;

beforeEach(async () => {
  db = openTestDb();
  setCachedUsage(15, 25);
});
afterEach(async () => {
  await app?.close();
  db.close();
});

const MOCK_BODY = {
  title: 'api task',
  goal: 'do a thing',
  plan_ref: 'https://example.com/p.md',
  coding_tool: 'mock',
  verification_steps: 'true',
  complexity: 'S',
};

describe('REST API', () => {
  it('creates, gates, queues, and reports board', async () => {
    app = buildApp({ db, apiToken: null });

    const created = await app.inject({ method: 'POST', url: '/api/tasks', payload: MOCK_BODY });
    expect(created.statusCode).toBe(200);
    const { task, gate } = created.json();
    expect(gate.ok).toBe(true);

    const q = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/queue` });
    expect(q.statusCode).toBe(200);

    const board = await app.inject({ method: 'GET', url: '/api/board' });
    const state = board.json();
    expect(state.counts.queued).toBe(1);
    expect(state.usage.session).toBe(15);
    const card = state.cards.find((c: any) => c.id === task.id);
    expect(card.status).toBe('queued');
  });

  it('refuses to queue a task that fails the gate', async () => {
    app = buildApp({ db, apiToken: null });
    const created = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { ...MOCK_BODY, verification_steps: '' },
    });
    const { task } = created.json();
    const q = await app.inject({ method: 'POST', url: `/api/tasks/${task.id}/queue` });
    expect(q.statusCode).toBe(409);
    expect(q.json().error).toMatch(/gate/);
  });

  it('pauses and resumes the scheduler', async () => {
    app = buildApp({ db, apiToken: null });
    await app.inject({ method: 'POST', url: '/api/pause' });
    expect((await app.inject({ method: 'GET', url: '/api/status' })).json().paused).toBe(true);
    await app.inject({ method: 'POST', url: '/api/resume-scheduler' });
    expect((await app.inject({ method: 'GET', url: '/api/status' })).json().paused).toBe(false);
  });

  it('enforces bearer auth when a token is set', async () => {
    app = buildApp({ db, apiToken: 'secret' });
    const noauth = await app.inject({ method: 'GET', url: '/api/board' });
    expect(noauth.statusCode).toBe(401);

    const withHeader = await app.inject({
      method: 'GET',
      url: '/api/board',
      headers: { authorization: 'Bearer secret' },
    });
    expect(withHeader.statusCode).toBe(200);

    const withQuery = await app.inject({ method: 'GET', url: '/api/board?token=secret' });
    expect(withQuery.statusCode).toBe(200);
  });
});
