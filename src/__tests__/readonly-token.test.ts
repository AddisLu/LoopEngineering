import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { buildApp } from '../server/app.js';

let db: Database.Database;
let app: FastifyInstance;

beforeEach(() => {
  db = openTestDb();
});
afterEach(async () => {
  await app?.close();
  db.close();
});

describe('readonly token: GET-only access to the SSoT-read whitelist', () => {
  it('allows the readonly token on whitelisted GET routes', async () => {
    app = buildApp({ db, apiToken: 'FULL', readonlyToken: 'RO' });

    const search = await app.inject({
      method: 'GET',
      url: '/api/rag/search?q=x',
      headers: { authorization: 'Bearer RO' },
    });
    expect(search.statusCode).not.toBe(401);
    expect(search.statusCode).not.toBe(403);

    const knowledge = await app.inject({
      method: 'GET',
      url: '/api/knowledge?q=x',
      headers: { authorization: 'Bearer RO' },
    });
    expect(knowledge.statusCode).toBe(200);

    const graph = await app.inject({
      method: 'GET',
      url: '/api/knowledge/graph',
      headers: { authorization: 'Bearer RO' },
    });
    expect(graph.statusCode).toBe(200);

    const sources = await app.inject({
      method: 'GET',
      url: '/api/sources',
      headers: { authorization: 'Bearer RO' },
    });
    expect(sources.statusCode).toBe(200);
  });

  it('forbids the readonly token on writes and on non-whitelisted GETs', async () => {
    app = buildApp({ db, apiToken: 'FULL', readonlyToken: 'RO' });

    const postKnowledge = await app.inject({
      method: 'POST',
      url: '/api/knowledge',
      headers: { authorization: 'Bearer RO' },
      payload: { title: 'x' },
    });
    expect(postKnowledge.statusCode).toBe(403);

    const deleteKnowledge = await app.inject({
      method: 'DELETE',
      url: '/api/knowledge/xxx',
      headers: { authorization: 'Bearer RO' },
    });
    expect(deleteKnowledge.statusCode).toBe(403);

    const board = await app.inject({
      method: 'GET',
      url: '/api/board',
      headers: { authorization: 'Bearer RO' },
    });
    expect(board.statusCode).toBe(403);

    const postTasks = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: 'Bearer RO' },
      payload: { title: 't', goal: 'g' },
    });
    expect(postTasks.statusCode).toBe(403);
  });

  it('the full token still works on any method/path', async () => {
    app = buildApp({ db, apiToken: 'FULL', readonlyToken: 'RO' });
    const board = await app.inject({
      method: 'GET',
      url: '/api/board',
      headers: { authorization: 'Bearer FULL' },
    });
    expect(board.statusCode).toBe(200);
  });

  it('401s when no token is presented', async () => {
    app = buildApp({ db, apiToken: 'FULL', readonlyToken: 'RO' });
    const res = await app.inject({ method: 'GET', url: '/api/board' });
    expect(res.statusCode).toBe(401);
  });

  it('zero-impact default: no apiToken configured means no auth is enforced at all', async () => {
    app = buildApp({ db, apiToken: null });
    const res = await app.inject({ method: 'POST', url: '/api/tasks', payload: { title: 't', goal: 'g' } });
    expect(res.statusCode).not.toBe(401);
    expect(res.statusCode).not.toBe(403);
  });
});
