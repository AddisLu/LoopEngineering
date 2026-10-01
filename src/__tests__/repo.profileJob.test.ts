import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openTestDb } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { createRepo } from '../repo/store.js';
import { awaitProfile, runProfile } from '../repo/profileJob.js';
import { getProfileRow } from '../repo/profileStore.js';
import { repoScope } from '../knowledge/types.js';

let db: Database.Database;
let dir: string;
beforeEach(() => {
  db = openTestDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pjob-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a]);
  git('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'ip', 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ip', 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'ip', 'CMakeLists.txt'), 'cmake_minimum_required(VERSION 3.24)\nproject(cfaoi_ip LANGUAGES CXX CUDA)\nfind_package(OpenCV REQUIRED)\nadd_executable(cfaoi_ip src/main.cpp)\n');
  fs.writeFileSync(path.join(dir, 'ip', 'src', 'main.cpp'), '#include <iostream>\n// TODO: pitch_y 也要讀\nint main(int argc, char** argv) {\n    if (key == "pitch_x") return 1;\n    std::cerr << "frame validation failed" << std::endl;\n    return 0;\n}\n');
  fs.writeFileSync(path.join(dir, 'ip', 'config', 'default_zone.ini'), '[Pattern]\n# Pattern pitch (px)\npitch_x = 26\nsearch_range_x = 3\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ANSWERS = (user: string): string => {
  if (user.includes('## 模組')) return JSON.stringify([{ module: 'cfaoi_ip', summary: '影像處理主程式：讀 ini、跑 CUDA kernel、輸出缺陷' }]);
  if (user.includes('## 統計出來的寫法')) return JSON.stringify([{ title: '縮排 4 格', body: '例：    return 0;' }]);
  if (user.includes('改這個 repo 時最容易出錯的地方')) return JSON.stringify([{ title: 'pitch_y 還沒讀', symptom: '改 pitch_y 沒效果', avoid: '先補 config_parser', words: ['pitch_y'], files: ['ip/src/main.cpp'] }]);
  if (user.includes('沒有說明的設定參數')) return JSON.stringify([{ key: 'search_range_x', section: 'Pattern', meaning: '找圖案位置時左右搜尋幾個像素（px，0–5）' }]);
  return '[]';
};

describe('Repo 檔案 job', () => {
  it('stage A on a real checkout: facts, index, state', async () => {
    const repo = createRepo(db, { name: 'cf-aoi', remote_url: 'http://g/aoi/cf-aoi', local_path: dir });
    await runProfile(db, repo.id);
    const row = getProfileRow(db, repo.id)!;
    expect(row.status).toBe('ready');
    expect(row.sha).toMatch(/^[0-9a-f]{7,40}$/);
    const f = JSON.parse(row.facets_json!);
    expect(f.requirements.map((r: { name: string }) => r.name)).toEqual(expect.arrayContaining(['OpenCV', 'CUDA']));
    const idx = db.prepare('SELECT kind, key FROM code_index WHERE repo_id = ? ORDER BY kind, key').all(repo.id) as Array<{ kind: string; key: string }>;
    expect(idx).toEqual(expect.arrayContaining([{ kind: 'param', key: 'pitch_x' }, { kind: 'param_use', key: 'pitch_x' }, { kind: 'param', key: 'search_range_x' }]));
    expect(db.prepare('SELECT COUNT(*) AS n FROM knowledge_nodes').get()).toEqual({ n: 0 }); // stage A writes no knowledge
  });

  it('stage B: module summaries, style rules, pitfall seeds and param meanings as drafts; a decided node is left alone', async () => {
    const repo = createRepo(db, { name: 'cf-aoi', remote_url: 'http://g/aoi/cf-aoi', local_path: dir });
    const chat = (async (_db: unknown, req: { user: string }) => ({ ok: true as const, content: ANSWERS(req.user) })) as never;
    await runProfile(db, repo.id, { infer: true }, { localChat: chat });
    const nodes = db.prepare('SELECT kind, title, status, source, scope FROM knowledge_nodes ORDER BY kind').all() as Array<{ kind: string; title: string; status: string; source: string; scope: string }>;
    expect(nodes.map((n) => [n.kind, n.title, n.status, n.source])).toEqual([
      ['module', 'cfaoi_ip', 'draft', 'inferred'],
      ['param', '[Pattern] search_range_x', 'draft', 'inferred'],
      ['pitfall', 'pitch_y 還沒讀', 'draft', 'inferred'],
      ['style', '縮排 4 格', 'draft', 'inferred'],
    ]);
    expect(new Set(nodes.map((n) => n.scope))).toEqual(new Set([repoScope(dir)]));
    expect(getProfileRow(db, repo.id)!.inferred_at).toBeTruthy();
    // the person rejects the module summary; a re-run neither revives nor duplicates it
    db.prepare("UPDATE knowledge_nodes SET status = 'rejected' WHERE kind = 'module'").run();
    await runProfile(db, repo.id, { infer: true }, { localChat: chat });
    expect(db.prepare("SELECT status FROM knowledge_nodes WHERE kind = 'module'").all()).toEqual([{ status: 'rejected' }]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM knowledge_nodes').get()).toEqual({ n: 4 });
  });

  it('POST /api/repos/:id/profile starts it; the page reads the result', async () => {
    const app: FastifyInstance = buildApp({ db, apiToken: null });
    await app.ready();
    try {
      const repo = createRepo(db, { name: 'cf-aoi', remote_url: 'http://g/aoi/cf-aoi', local_path: dir });
      expect((await app.inject({ method: 'POST', url: `/api/repos/${repo.id}/profile`, payload: {} })).statusCode).toBe(202);
      await awaitProfile(repo.id);
      const v = (await app.inject({ method: 'GET', url: `/api/repos/${repo.id}/profile` })).json();
      expect(v.status).toBe('ready');
      expect(v.facets.modules.map((m: { name: string }) => m.name)).toContain('cfaoi_ip');
      expect(v.fit.at(-1).name).toBe('引擎主機（這台 Spark）');
      expect(v.index_counts.param).toBe(2);
    } finally {
      await app.close();
    }
  });
});
