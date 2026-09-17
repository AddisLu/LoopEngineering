import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { collectSources, guessRepo, heuristicIntent, slugify, suggestIntent } from '../chat/intent.js';
import { prefillForm } from '../prd/prefill.js';
import { createSpike, SpikeError } from '../spike/create.js';
import { validateTask } from '../gate/validateTask.js';
import { getTask } from '../tasks.js';

let db: Database.Database;
let tmp: string[] = [];
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => {
  db.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp = [];
});

const msg = (content: string, tools: unknown[] = []) => ({ content, tools });
const sources = (uris: string[]) => () => uris.map((uri) => ({ kind: 'git', uri, enabled: 1 }));

describe('intent helpers', () => {
  it('slugifies names, dedupes sources, and guesses the repo only when its name is mentioned', () => {
    expect(slugify('TGV Inspector v2 (open source)')).toBe('tgv-inspector-v2-open-source');
    expect(slugify('中文名稱')).toBe('spike');
    const s = collectSources(msg('see https://a.example/x. and https://a.example/x', [{ calls: [{ sources: [{ title: 'A', url: 'https://a.example/x' }, { title: 'B', url: 'https://b.example/' }] }] }]));
    expect(s).toEqual([
      { title: 'A', url: 'https://a.example/x' },
      { title: 'B', url: 'https://b.example/' },
    ]);
    expect(guessRepo('cf-aoi 的 ROI', ['/r/cf-aoi', '/r/other'])).toBe('/r/cf-aoi');
    expect(guessRepo('nothing here', ['/r/cf-aoi', '/r/other'])).toBeNull();
    expect(guessRepo('nothing here', ['/r/only'])).toBe('/r/only');
  });

  it('keyword fallback: 誤判 → fix/algo, crash → bugfix, github + 能不能用 → spike, else todo', () => {
    expect(heuristicIntent('ROI 邊緣常把正常紋路判成刮傷', '')).toMatchObject({ intent: 'fix', fix: { kind: 'algo' } });
    expect(heuristicIntent('LOAD_RECIPE 之後 control 會 crash', '')).toMatchObject({ intent: 'fix', fix: { kind: 'bugfix' } });
    expect(heuristicIntent('這個 github.com/x/y 專案能不能用', '')).toMatchObject({ intent: 'spike' });
    expect(heuristicIntent('整理一週內 TGV 檢測新聞', '')).toMatchObject({ intent: 'todo' });
    expect(heuristicIntent('單張處理太慢，要 300 ms 內', '')).toMatchObject({ intent: 'perf' });
  });
});

describe('suggestIntent', () => {
  it('uses the model answer, clamps fields, and fills spike urls from the sources', async () => {
    const localChat = async () => ({
      ok: true as const,
      content: '```json\n{"intent":"spike","confidence":"high","reason":"評估開源 TGV 檢測專案","title":"驗證 TGV Inspector","spike":{"name":"TGV Inspector!!","goal":"裝起來跑 demo","urls":[]}}\n```',
    });
    const s = await suggestIntent(db, msg('請看 https://github.com/x/tgv-inspector', []), ['github 上的 tgv-inspector 能不能用'], 'TGV', { localChat, sources: sources(['/r/cf-aoi']) });
    expect(s).toMatchObject({ intent: 'spike', confidence: 'high', model_ready: true, repo_hint: '/r/cf-aoi', title: '驗證 TGV Inspector' });
    expect(s.spike).toEqual({ name: 'tgv-inspector', goal: '裝起來跑 demo', urls: ['https://github.com/x/tgv-inspector'] });
  });

  it('falls back to heuristics when the model is down or answers garbage', async () => {
    const down = async () => ({ ok: false as const, reason: 'not_ready' as const, detail: 'idle' });
    const s = await suggestIntent(db, msg('…'), ['ROI 邊緣誤判'], '對話', { localChat: down, sources: sources([]) });
    expect(s).toMatchObject({ intent: 'fix', confidence: 'low', model_ready: false, repo_hint: null });
    expect(s.fix).toMatchObject({ kind: 'algo', symptom: 'ROI 邊緣誤判' });
    const garbage = async () => ({ ok: true as const, content: 'sure thing' });
    const g = await suggestIntent(db, msg('…'), ['整理新聞'], '對話', { localChat: garbage, sources: sources([]) });
    expect(g).toMatchObject({ intent: 'todo', confidence: 'low', model_ready: true });
    expect(g.reason).toContain('無法解析');
  });
});

describe('prefillForm', () => {
  it('mirrors emptyForm() and carries the sources as 範圍 bullets', () => {
    const f = prefillForm({ kind: 'algo', title: 'T', symptom: 'S', expected: 'E', repo_path: '/r/cf-aoi', module: 'ip', sources: [{ title: 'Doc', url: 'https://d' }, { title: 'https://e', url: 'https://e' }], conversationTitle: '對話 A' });
    expect(Object.keys(f)).toEqual(['kind', 'repo', 'change', 'verify', 'scope', 'acceptance', 'markdown_override']);
    expect(f.repo).toEqual({ path: '/r/cf-aoi', branch: 'main', module: 'ip' });
    expect((f.change as { extra: string[] }).extra).toEqual(['參考來源：Doc https://d', '參考來源：https://e', '來自對話：對話 A']);
    expect((f.scope as { complexity: string }).complexity).toBe('M');
    expect((prefillForm({ kind: 'bugfix', title: 't', symptom: '', expected: '', repo_path: null, module: null, sources: [], conversationTitle: '' }).scope as { complexity: string }).complexity).toBe('S');
  });
});

describe('createSpike', () => {
  it('makes a repo with a bare origin, README/PLAN, and a task that passes the gate', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spikes-'));
    tmp.push(root);
    setSetting(db, 'spike_root', root);
    const { task, repo_path } = createSpike(db, { name: 'TGV Inspector', goal: '裝起來跑 demo', urls: ['https://github.com/x/y', 'not a url'], owner: 'me', sourceRef: 'chat:m1' });
    expect(repo_path).toBe(path.join(root, 'tgv-inspector'));
    expect(fs.existsSync(path.join(repo_path, 'README.md'))).toBe(true);
    expect(fs.readFileSync(path.join(repo_path, 'PLAN.md'), 'utf8')).toContain('REPORT.md');
    expect(fs.readFileSync(path.join(repo_path, 'README.md'), 'utf8')).toContain('https://github.com/x/y');
    // the engine fetches origin/<base> before cutting a worktree — the bare origin must resolve it
    expect(execFileSync('git', ['rev-parse', '--verify', 'origin/main'], { cwd: repo_path, encoding: 'utf8' }).trim()).toMatch(/^[0-9a-f]{40}$/);
    expect(task).toMatchObject({ title: '驗證：TGV Inspector', repo_path, base_branch: 'main', plan_ref: path.join(repo_path, 'PLAN.md'), verify_mode: 'command,manual', status: 'draft', source_ref: 'chat:m1' });
    const gate = validateTask(getTask(db, task.id)!);
    expect(gate.missing).toEqual([]);
    // a second spike with the same name gets its own directory
    const again = createSpike(db, { name: 'TGV Inspector', goal: 'g', urls: [], sourceRef: 'chat:m2' });
    expect(again.repo_path).toBe(path.join(root, 'tgv-inspector-2'));
  });

  it('cleans up when git fails and refuses empty names', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spikes-'));
    tmp.push(root);
    expect(() => createSpike(db, { name: 'x', goal: 'g', urls: [], sourceRef: 'chat:m3' }, { root, git: () => { throw new Error('boom'); } })).toThrow(SpikeError);
    expect(fs.existsSync(path.join(root, 'x'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.origins', 'x.git'))).toBe(false);
    expect(() => createSpike(db, { name: '  ', goal: 'g', urls: [], sourceRef: 'chat:m4' }, { root })).toThrow(/name/);
  });
});
