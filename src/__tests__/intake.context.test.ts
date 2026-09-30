import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, getTask } from '../tasks.js';
import { writeTaskFile } from '../orchestrator/prompt.js';
import { attachmentsFor, repoMapFor, similarFixesFor } from '../intake/context.js';

let db: Database.Database;
let dir: string;

beforeEach(() => {
  db = openTestDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-ctx-'));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const base = { title: '第二次載入沒生效', goal: 'bypass_edge_x 第二次載入沒套用', plan_ref: 'https://example.com/p.md', coding_tool: 'mock', verification_steps: ['true', 'check:ck_1'] };

describe('LOOP_TASK.md for a ticket', () => {
  it('a task that is not a ticket gets exactly the same file as before', () => {
    const t = createTask(db, { ...base, verification_steps: ['true'] });
    const plain = fs.readFileSync(writeTaskFile(dir, t), 'utf8');
    const withNulls = fs.readFileSync(
      writeTaskFile(dir, t, { attachments: attachmentsFor(t), repoMap: repoMapFor(db, t), similarFixes: similarFixesFor(db, t), reproBefore: null, checks: null }),
      'utf8',
    );
    expect(withNulls).toBe(plain);
    expect(plain).not.toContain('## 附件');
  });

  it('adds screenshots, the repo map (flag), past fixes (flag), repro output and the checks', () => {
    const img = path.join(dir, 'shot.png');
    fs.writeFileSync(img, 'png');
    const map = path.join(dir, 'r_1.md');
    fs.writeFileSync(map, `# Repo 地圖 — cf-aoi @ abc\n\n- 語言：C++ 62%\n${'- src/x.cpp: f():1\n'.repeat(400)}`);
    db.prepare("INSERT INTO repos (id, name, remote_url, local_path, map_path) VALUES ('r_1', 'cf-aoi', 'http://g/aoi/cf-aoi', '/tmp/x', ?)").run(map);
    db.prepare("INSERT INTO fix_ledger (repo_id, task_id, title, symptom, files, summary, outcome) VALUES ('r_1', 't_old', '載入沒生效的舊問題', 'bypass_edge_x', 'src/control/recipe_loader.cpp', 'guard removed', 'merged')").run();
    const t0 = createTask(db, base);
    db.prepare('UPDATE tasks SET repo_id = ?, images_json = ? WHERE id = ?').run('r_1', JSON.stringify([{ file: img, text: 'LOAD_RECIPE OK' }, { file: '/nope.png' }]), t0.id);
    const t = getTask(db, t0.id)!;

    expect(repoMapFor(db, t)).toBeNull(); // flags off
    expect(similarFixesFor(db, t)).toBeNull();
    setSetting(db, 'repo_map_inject', 'true');
    setSetting(db, 'fix_ledger_inject', 'true');
    setSetting(db, 'repo_map_budget_chars', '2000');
    const mapText = repoMapFor(db, t)!;
    expect(mapText.length).toBeLessThan(2100);
    expect(mapText).toContain('…（其餘省略）');

    const body = fs.readFileSync(
      writeTaskFile(dir, t, {
        attachments: attachmentsFor(t),
        repoMap: mapText,
        similarFixes: similarFixesFor(db, t),
        reproBefore: 'FAILED tests/test_recipe_reload.py::test_second_load',
        checks: ['- [必過] 單元測試：`ctest --test-dir build`（在 aoi-1，引擎代跑）'],
      }),
      'utf8',
    );
    expect(body).toContain('## 附件（截圖）');
    expect(body).toContain(img);
    expect(body).not.toContain('/nope.png'); // a missing file is not offered
    expect(body).toContain('LOAD_RECIPE OK');
    expect(body).toContain('## Repo 地圖（引擎產生');
    expect(body).not.toContain('# Repo 地圖 — cf-aoi'); // its own title line is dropped
    expect(body).toContain('## 這個 repo 過去類似的修法');
    expect(body).toContain('載入沒生效的舊問題（已合併）');
    expect(body).toContain('## 重現輸出（修改前');
    expect(body).toContain('FAILED tests/test_recipe_reload.py::test_second_load');
    // checks replace the raw check:<id> line; plain steps stay
    expect(body).toContain('- [必過] 單元測試：`ctest --test-dir build`（在 aoi-1，引擎代跑）');
    expect(body).toContain('- `true`');
    expect(body).not.toContain('check:ck_1');
    expect(body).toContain('驗收檢查由引擎執行');
  });
});
