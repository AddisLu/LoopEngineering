import { describe, it, expect } from 'vitest';
import { openTestDb, getSetting } from '../db/index.js';
import { validateSetting, TUNABLE_KEYS } from '../settings.js';
import { DEFAULT_SETTINGS } from '../config.js';
import fs from 'node:fs';
import path from 'node:path';

describe('問題單 flow settings', () => {
  it('ships every flag at its zero-impact default and the board can tune the role/accuracy keys', () => {
    const db = openTestDb();
    for (const [key, want] of [
      ['approval_mode', 'self'], ['cloud_llm_allowed', 'true'], ['failing_first', 'false'], ['local_self_review', 'false'],
      ['repo_map_inject', 'false'], ['fix_ledger_inject', 'false'], ['domain_routing', 'false'], ['fix_attempts', ''],
      ['fix_escalation', ''], ['llm_judge_backend', 'claude'], ['knowledge_distill_backend', 'claude'], ['planner_backend', 'claude'],
      ['intake_vision', 'auto'], ['gitea_merge_via_pr', 'true'], ['checks_migrated', 'false'],
    ] as const) {
      expect(DEFAULT_SETTINGS[key], key).toBe(want);
      expect(getSetting(db, key), key).toBe(want);
    }
    for (const key of ['approval_mode', 'manager_users', 'cloud_llm_allowed', 'fix_attempts', 'fix_escalation']) {
      expect(TUNABLE_KEYS as readonly string[]).toContain(key);
    }
    // the new tables exist on a fresh database
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ['repos', 'machines', 'datasets', 'checks', 'check_runs', 'issue_links', 'fix_ledger']) expect(tables).toContain(t);
    const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
    for (const c of ['repo_id', 'domain', 'intake_json', 'images_json', 'analysis_json', 'checks_json', 'fix_attempts', 'review_json', 'approval_state']) expect(cols).toContain(c);
    // fix_ledger's FTS follows inserts (the trigram index behind similarFixes)
    db.prepare("INSERT INTO fix_ledger (repo_id, title, symptom, files, summary, outcome) VALUES ('r_1', '第二次載入沒生效', 'bypass_edge_x', 'src/control/recipe_loader.cpp', 'guard removed', 'merged')").run();
    expect(db.prepare("SELECT count(*) AS n FROM fix_ledger_fts WHERE fix_ledger_fts MATCH '第二次載入'").get()).toEqual({ n: 1 });
    db.close();
  });

  it('validates the role, backend and ladder settings', () => {
    expect(validateSetting('approval_mode', 'manager')).toBeNull();
    expect(validateSetting('approval_mode', 'boss')).not.toBeNull();
    expect(validateSetting('manager_users', 'ts:addislyu@gmail.com, name:呂侑儒')).toBeNull();
    expect(validateSetting('manager_users', 'bob')).not.toBeNull();
    expect(validateSetting('llm_judge_backend', 'local')).toBeNull();
    expect(validateSetting('llm_judge_backend', 'off')).not.toBeNull();
    expect(validateSetting('knowledge_distill_backend', 'off')).toBeNull();
    expect(validateSetting('planner_backend', 'gpt')).not.toBeNull();
    expect(validateSetting('intake_vision', 'ocr')).toBeNull();
    expect(validateSetting('intake_vision', 'yes')).not.toBeNull();
    expect(validateSetting('fix_escalation', 'local:glm53-flash, local:deepseek-v4-flash')).toBeNull();
    expect(validateSetting('fix_escalation', 'sonnet')).not.toBeNull();
    for (const ok of ['', '0', '3']) expect(validateSetting('fix_attempts', ok), ok).toBeNull();
    for (const bad of ['x', '1.5', '-1']) expect(validateSetting('fix_attempts', bad), bad).not.toBeNull();
    for (const key of ['cloud_llm_allowed', 'failing_first', 'gitea_merge_via_pr']) {
      expect(validateSetting(key, 'true')).toBeNull();
      expect(validateSetting(key, 'maybe')).not.toBeNull();
    }
    expect(validateSetting('check_timeout_min', '20')).toBeNull();
    expect(validateSetting('check_timeout_min', '-2')).not.toBeNull();
  });

  it('the board settings dialog has a field for every role, confidentiality and accuracy key', () => {
    const html = fs.readFileSync(path.join(process.cwd(), 'web', 'board.html'), 'utf8');
    for (const key of ['approval_mode', 'manager_users', 'cloud_llm_allowed', 'failing_first', 'local_self_review', 'repo_map_inject', 'fix_ledger_inject', 'domain_routing', 'fix_attempts', 'fix_escalation']) {
      expect(html, key).toContain(`name="${key}"`);
      expect(TUNABLE_KEYS as readonly string[], key).toContain(key);
    }
  });
});
