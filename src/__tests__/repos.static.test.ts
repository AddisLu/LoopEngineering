import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openTestDb } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { createRepo } from '../repo/store.js';

/**
 * The Repo page (/repos.html, its 過去修法 tab) and the 機台 page (/machines.html): the one route
 * this link adds, and the static structure the pages' scripts depend on.
 */

describe('GET /api/repos/:id/fixes (the 過去修法 tab)', () => {
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

  const add = (repoId: string, taskId: string, title: string, outcome: string, at: string, extra: { files?: string; model?: string | null } = {}) =>
    db
      .prepare('INSERT INTO fix_ledger (repo_id, task_id, title, symptom, files, summary, outcome, model, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(repoId, taskId, title, `${title}的症狀`, extra.files ?? '', '', outcome, extra.model ?? null, 1, at);

  it('lists this repo\'s past fixes newest first, with the fields the tab shows', async () => {
    const repo = createRepo(db, { name: 'cf-aoi', remote_url: 'http://gitea.corp:3000/aoi/cf-aoi', local_path: '/srv/repos/cf-aoi' });
    const other = createRepo(db, { name: 'cf-aoi-ui', remote_url: 'http://gitea.corp:3000/aoi/cf-aoi-ui', local_path: '/srv/repos/cf-aoi-ui' });
    add(repo.id, 't_old', '第二次載入 recipe 沒生效', 'returned', '2026-09-01 10:00:00', { model: 'local:glm53-flash' });
    add(repo.id, 't_new', '邊緣檢出漏報', 'merged', '2026-09-20 10:00:00', { files: 'src/edge.cpp\nsrc/edge.h', model: 'local:qwen3-coder-next' });
    add(other.id, 't_ui', '別的 repo 的修法', 'merged', '2026-09-25 10:00:00');

    const res = await app.inject({ method: 'GET', url: `/api/repos/${repo.id}/fixes` });
    expect(res.statusCode).toBe(200);
    const { fixes } = res.json();
    expect(fixes.map((f: { title: string }) => f.title)).toEqual(['邊緣檢出漏報', '第二次載入 recipe 沒生效']);
    expect(fixes[0]).toMatchObject({
      repo_id: repo.id,
      task_id: 't_new',
      outcome: 'merged',
      files: 'src/edge.cpp\nsrc/edge.h',
      model: 'local:qwen3-coder-next',
      symptom: '邊緣檢出漏報的症狀',
      created_at: '2026-09-20 10:00:00',
    });
    // a limit for a long history; nonsense falls back to the default
    expect((await app.inject({ method: 'GET', url: `/api/repos/${repo.id}/fixes?limit=1` })).json().fixes).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/api/repos/${repo.id}/fixes?limit=abc` })).json().fixes).toHaveLength(2);
    // a repo with no history is an empty list, not an error
    expect((await app.inject({ method: 'GET', url: `/api/repos/${other.id}/fixes` })).json().fixes).toHaveLength(1);
  });

  it('404s for a repo that is not registered', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/repos/r_nope/fixes' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('沒有這個 repo');
  });
});
