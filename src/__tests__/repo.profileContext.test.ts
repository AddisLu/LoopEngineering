import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, createRun, getTask } from '../tasks.js';
import { createRepo } from '../repo/store.js';
import { saveStageA } from '../repo/profileStore.js';
import { profileContextFor, profileSectionFor, stylesFor } from '../repo/profileContext.js';
import { creditShown, readMeta, upsertLearned } from '../knowledge/learn.js';
import { repoScope } from '../knowledge/types.js';
import { writeTaskFile } from '../orchestrator/prompt.js';

let db: Database.Database;
let dir: string;
beforeEach(() => {
  db = openTestDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pctx-'));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const style = (module: string, enc: string) => ({ module, files_sampled: 10, languages: ['cpp'], encoding: { utf8: 0, utf8_bom: 0, big5: enc === 'big5' ? 10 : 0, other: 0, dominant: enc }, eol: 'crlf', indent: '4', brace: 'next_line', naming: ['成員變數 m_ 前綴（m_width）'], header_guard: 'pragma_once', comment_lang: 'zh', error_handling: ['回傳錯誤碼'], logging: ['std::cerr'], strings: ['std::string'], configs: [] });

function ticket() {
  const repo = createRepo(db, { name: 'cf-aoi', remote_url: 'http://g/aoi/cf-aoi', local_path: dir });
  saveStageA(
    db,
    repo.id,
    { sha: 'abc', style: [style('', 'utf8'), style('ip', 'big5')], requirements: [{ kind: 'sdk', name: 'CUDA', version: '12.2', note: null, module: 'ip', evidence: [] }] },
    [{ kind: 'param', key: 'fast_search_range', section: 'Pattern', file: 'ip/config/default_zone.ini', line: 22, text: 'fast_search_range = 1', value: '1', meaning: 'search range (px)' }],
  );
  const t = createTask(db, { title: 'fast_search_range 改 2 之後漏檢', goal: '調整 fast_search_range 後 kernel 漏檢，error C2065', coding_tool: 'mock', verification_steps: ['true'], repo_path: dir, base_branch: 'main' });
  db.prepare('UPDATE tasks SET repo_id = ?, analysis_json = ? WHERE id = ?').run(repo.id, JSON.stringify({ kind: 'bugfix', causes: [{ file: 'ip/src/kernel.cu' }] }), t.id);
  const p = upsertLearned(db, repoScope(dir), 'pitfall', 'ip/ 檔案是 Big5', '會看到：C2065；避免：不要轉 UTF-8', { trigger: { words: ['C2065'], files: ['ip/'], kinds: [] }, evidence: [{ task: 't_old' }] });
  const b = upsertLearned(db, repoScope(dir), 'playbook', '漏檢先跑 verify_flight', '步驟：1. 跑 verify_flight', { trigger: { words: [], files: ['ip/'], kinds: ['bugfix'] }, evidence: [{ task: 't_old' }] });
  db.prepare("UPDATE knowledge_nodes SET status = 'approved'").run();
  return { task: getTask(db, t.id)!, pit: p.id, book: b.id };
}

describe('這個 repo 的規範與經驗 in LOOP_TASK.md', () => {
  it('off by default: nothing, and the file is unchanged', () => {
    const { task } = ticket();
    expect(profileSectionFor(db, task)).toBeNull();
    const plain = fs.readFileSync(writeTaskFile(dir, task), 'utf8');
    expect(fs.readFileSync(writeTaskFile(dir, task, { repoKnowledge: null }), 'utf8')).toBe(plain);
  });

  it('pitfalls first, then the style of the touched module, playbooks, the named params, requirements', () => {
    const { task, pit, book } = ticket();
    setSetting(db, 'repo_profile_inject', 'true');
    const s = profileSectionFor(db, task)!;
    const lines = s.text.split('\n');
    expect(lines[0]).toBe('### 陷阱（先讀：這個 repo 以前在這裡卡過）');
    expect(lines[1]).toBe('- **ip/ 檔案是 Big5**：會看到：C2065；避免：不要轉 UTF-8');
    expect(s.text).toContain('- ip：編碼 Big5（存檔不要轉成 UTF-8）；換行 CRLF；縮排 4 格空白；大括號換行；標頭用 #pragma once');
    expect(s.text).not.toContain('- 整個 repo：'); // the touched module's style, not the repo-wide one
    expect(s.text).toContain('- **漏檢先跑 verify_flight**');
    expect(s.text).toContain('- `[Pattern] fast_search_range`（預設 1，定義在 ip/config/default_zone.ini:22）：search range (px)');
    expect(s.text).toContain('- CUDA 12.2（ip）');
    expect(s.shown).toEqual([pit, book]);
    const body = fs.readFileSync(writeTaskFile(dir, task, { repoKnowledge: s.text }), 'utf8');
    expect(body).toContain('## 這個 repo 的規範與經驗（Loop 從這個 repo 與過去的任務整理，已由人核可）');
  });

  it('a tight budget keeps the pitfalls; showing and passing are counted', () => {
    const { task, pit } = ticket();
    setSetting(db, 'repo_profile_inject', 'true');
    setSetting(db, 'repo_profile_budget_chars', '800');
    const run = createRun(db, { task_id: task.id, worktree_path: dir, branch: 'x' });
    const text = profileContextFor(db, task, run.id)!;
    expect(text.length).toBeLessThanOrEqual(800);
    expect(text).toContain('ip/ 檔案是 Big5');
    creditShown(db, task.id, run.id);
    const m = readMeta(db.prepare('SELECT meta_json FROM knowledge_nodes WHERE id = ?').get(pit) as { meta_json: string })!;
    expect(m.hits).toEqual({ shown: 1, passed: 1 });
  });

  it('stylesFor: the modules the files are in, else the repo-wide profile', () => {
    const all = [style('', 'utf8'), style('ip', 'big5'), style('grab', 'utf8')];
    expect(stylesFor(all, ['grab/src/cam.cpp']).map((s) => s.module)).toEqual(['grab']);
    expect(stylesFor(all, ['tools/x.py']).map((s) => s.module)).toEqual(['']);
  });
});
