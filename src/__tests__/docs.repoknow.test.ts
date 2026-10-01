import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { DEFAULT_SETTINGS } from '../config.js';

const DOC = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', '操作說明.html'), 'utf8');

describe('操作說明: 5c Repo 檔案、解法與陷阱、機況診斷', () => {
  it('has the chapter after 5b, in the TOC, and documents every new setting with its default', () => {
    const toc = DOC.indexOf('href="#repoknow"');
    expect(toc).toBeGreaterThan(DOC.indexOf('href="#tickets"'));
    expect(DOC.indexOf('<section id="repoknow">')).toBeGreaterThan(DOC.indexOf('<section id="tickets">'));
    for (const key of ['repo_profile_auto', 'repo_profile_infer', 'repo_profile_inject', 'repo_profile_budget_chars', 'learn_from_runs', 'diag_watch_dirs', 'diag_watch_interval_min']) {
      expect(DOC, key).toContain(`<code>${key}</code>`);
      expect(DEFAULT_SETTINGS, key).toHaveProperty(key);
    }
    for (const term of ['一次改對', '可能卡在哪', '這個錯誤以前見過', '記成案例', '不會寫入機台', 'M_SYSTEM_HOST', 'Big5']) expect(DOC, term).toContain(term);
    for (const route of ['/api/repos/:id/profile', '/api/diag', '/api/knowledge/approve-many']) expect(DOC, route).toContain(route);
  });
});
