import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openTestDb } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { createTask } from '../tasks.js';
import { upsertNode } from '../knowledge/store.js';
import { repoScope } from '../knowledge/types.js';

let db: Database.Database;
let app: FastifyInstance;
beforeEach(async () => {
  db = openTestDb();
  app = buildApp({ db, apiToken: null });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
});

describe('GET /api/tasks/:id/knowledge', () => {
  it('says what a task gets and names the scope its knowledge is stranded in', async () => {
    upsertNode(db, { title: '全域規則', body: 'always', scope: 'global', kind: 'constraint' });
    upsertNode(db, { title: 'CF-AOI 限制', body: 'only there', scope: repoScope('/tmp/some-repo') });
    const t = createTask(db, { title: '修相機', goal: '相機掉幀' });

    const res = await app.inject({ method: 'GET', url: `/api/tasks/${t.id}/knowledge` });
    expect(res.statusCode).toBe(200);
    const k = res.json();
    expect(k.enabled).toBe(true);
    expect(k.scopes).toEqual(['global']);
    expect(k.items.filter((i: { included: boolean }) => i.included).map((i: { title: string }) => i.title)).toEqual(['全域規則']);
    // the silent failure made loud: 1 approved node exists that this task cannot reach
    expect(k.skipped).toEqual([{ scope: repoScope('/tmp/some-repo'), count: 1 }]);
    expect(k.used).toBeGreaterThan(0);
    expect(k.budget).toBeGreaterThan(0);
    expect((await app.inject({ method: 'GET', url: '/api/tasks/t_nope/knowledge' })).statusCode).toBe(404);
  });
});
