import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting, getBool } from '../db/index.js';
import { setCachedUsage } from '../token/usage.js';
import { buildApp } from '../server/app.js';
import { createSource } from '../knowledge/ingest/sources.js';
import { resolveProject, fetchProjectWorkPackages, type OpDataExec, type SearchFn } from '../report/opdata.js';
import { generateReport, type ReportExec } from '../report/generate.js';
import type { RetrievedChunk } from '../knowledge/retrieve.js';

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10); // safe, fresh — well under hard_limit_pct
});
afterEach(() => db.close());

function makeOpenProjectSource(): void {
  createSource(db, { kind: 'openproject', uri: 'http://example/openproject', config: { op_repo: '/fake/op-repo' } });
}

const LIST_PROJECTS_LINE = JSON.stringify({ id: 1, name: '大型AOI', identifier: 'aoi' });
const WP_LINE = JSON.stringify({
  id: 10,
  subject: 'PR-123 備料進度',
  status: '進行中',
  is_closed: false,
  type: 'Task',
  assignee_name: '小明',
  project_id: 1,
  project_name: '大型AOI',
  start_date: '',
  due_date: '2026-08-01',
  percent_done: 40,
  estimated_hours: 10,
  spent_hours: 4,
  remaining_hours: 6,
  description: '關鍵PR進度說明',
  custom_fields: {},
  updated_at: '',
});

function fakeChunk(overrides: Partial<RetrievedChunk> = {}): RetrievedChunk {
  return {
    chunk_id: 1,
    document_id: 1,
    source_id: 'src_x',
    source_kind: 'openproject',
    path: 'wp:900',
    uri: null,
    section: null,
    start_line: null,
    end_line: null,
    text: '快照摘要文字',
    score: 1,
    ...overrides,
  };
}

// ---- opdata.ts ----

describe('resolveProject', () => {
  it('returns null when no openproject source is registered', async () => {
    const exec: OpDataExec = async () => LIST_PROJECTS_LINE;
    expect(await resolveProject(db, '大型AOI', exec)).toBeNull();
  });

  it('fuzzy-matches name/identifier from --list-projects output', async () => {
    makeOpenProjectSource();
    const exec: OpDataExec = async (_bin, args) => {
      expect(args).toContain('--list-projects');
      return LIST_PROJECTS_LINE;
    };
    const resolved = await resolveProject(db, 'AOI', exec);
    expect(resolved).toEqual({ id: '1', name: '大型AOI' });
  });

  it('returns null when the exec throws (offline/timeout)', async () => {
    makeOpenProjectSource();
    const exec: OpDataExec = async () => {
      throw new Error('spawn failed');
    };
    expect(await resolveProject(db, '大型AOI', exec)).toBeNull();
  });
});

describe('fetchProjectWorkPackages', () => {
  it('live: resolves the project then fetches --structured work packages', async () => {
    makeOpenProjectSource();
    const exec: OpDataExec = async (_bin, args) => {
      if (args.includes('--list-projects')) return LIST_PROJECTS_LINE;
      if (args.includes('--structured')) return WP_LINE;
      throw new Error(`unexpected args: ${args.join(' ')}`);
    };
    const result = await fetchProjectWorkPackages(db, { project: 'AOI' }, exec);
    expect(result.source).toBe('live');
    expect(result.project).toEqual({ id: '1', name: '大型AOI' });
    expect(result.items).toHaveLength(1);
    expect((result.items[0] as { subject: string }).subject).toBe('PR-123 備料進度');
  });

  it('falls back to the corpus snapshot when the live exec throws', async () => {
    makeOpenProjectSource();
    const exec: OpDataExec = async () => {
      throw new Error('offline');
    };
    let seenQuery = '';
    const searchFn: SearchFn = async (_db, q) => {
      seenQuery = q;
      return [fakeChunk()];
    };
    const result = await fetchProjectWorkPackages(db, { project: '大型AOI', topic: 'PR' }, exec, searchFn);
    expect(result.source).toBe('snapshot');
    expect(seenQuery).toContain('大型AOI');
    expect(result.items).toHaveLength(1);
    expect((result.items[0] as { text: string }).text).toBe('快照摘要文字');
  });

  it('report_live_first=false skips the live exec entirely and goes straight to snapshot', async () => {
    makeOpenProjectSource();
    setSetting(db, 'report_live_first', 'false');
    let execCalled = false;
    const exec: OpDataExec = async () => {
      execCalled = true;
      return LIST_PROJECTS_LINE;
    };
    const searchFn: SearchFn = async () => [fakeChunk()];
    const result = await fetchProjectWorkPackages(db, { project: '大型AOI' }, exec, searchFn);
    expect(execCalled).toBe(false);
    expect(result.source).toBe('snapshot');
  });

  it('never throws when both live and snapshot fail', async () => {
    makeOpenProjectSource();
    const exec: OpDataExec = async () => {
      throw new Error('offline');
    };
    const searchFn: SearchFn = async () => {
      throw new Error('search backend down');
    };
    const result = await fetchProjectWorkPackages(db, { project: 'x' }, exec, searchFn);
    expect(result.source).toBe('snapshot');
    expect(result.items).toEqual([]);
  });
});

// ---- generate.ts ----

describe('generateReport', () => {
  it('report_enabled=false (default) -> null, zero behavior change regardless of injected deps', async () => {
    expect(getBool(db, 'report_enabled', false)).toBe(false);
    const synthExec: ReportExec = async () => {
      throw new Error('must never be called');
    };
    const result = await generateReport(db, { project: 'x' }, { synthExec });
    expect(result).toBeNull();
  });

  it('session usage at/over hard_limit_pct -> null', async () => {
    setSetting(db, 'report_enabled', 'true');
    setCachedUsage(96, 10); // hard_limit_pct default is 95
    const synthExec: ReportExec = async () => {
      throw new Error('must never be called');
    };
    const result = await generateReport(db, { project: 'x' }, { synthExec });
    expect(result).toBeNull();
  });

  it('packs live work-package data into the synth prompt, alongside the default template instructions', async () => {
    setSetting(db, 'report_enabled', 'true');
    makeOpenProjectSource();
    const dataExec: OpDataExec = async (_bin, args) => {
      if (args.includes('--list-projects')) return LIST_PROJECTS_LINE;
      return WP_LINE;
    };
    let seenPrompt = '';
    const synthExec: ReportExec = async (p) => {
      seenPrompt = p;
      return '# 報告內容';
    };
    const result = await generateReport(db, { project: '大型AOI', topic: 'PR 進度' }, { dataExec, synthExec });
    expect(result).not.toBeNull();
    expect(result!.markdown).toBe('# 報告內容');
    expect(result!.meta.source).toBe('live');
    expect(result!.meta.itemCount).toBe(1);
    expect(seenPrompt).toContain('摘要');
    expect(seenPrompt).toContain('進度總覽');
    expect(seenPrompt).toContain('PR-123 備料進度');
    expect(seenPrompt).toContain('關鍵PR進度說明');
  });

  it('parses a bare description into {project, topic} via parseExec', async () => {
    setSetting(db, 'report_enabled', 'true');
    setSetting(db, 'report_live_first', 'false');
    const parseExec: ReportExec = async () => JSON.stringify({ project: '大型AOI', topic: 'PR 最新進度' });
    let seenQuery = '';
    const searchFn: SearchFn = async (_db, q) => {
      seenQuery = q;
      return [];
    };
    const synthExec: ReportExec = async () => '# ok';
    const result = await generateReport(
      db,
      { description: '大型AOI PR 最新進度 one page' },
      { parseExec, searchFn, synthExec },
    );
    expect(result).not.toBeNull();
    expect(seenQuery).toContain('大型AOI');
    expect(seenQuery).toContain('PR 最新進度');
  });

  it('falls back to treating the whole description as topic when parseExec returns nothing parseable', async () => {
    setSetting(db, 'report_enabled', 'true');
    setSetting(db, 'report_live_first', 'false');
    const parseExec: ReportExec = async () => 'not json at all';
    let seenQuery = '';
    const searchFn: SearchFn = async (_db, q) => {
      seenQuery = q;
      return [];
    };
    const synthExec: ReportExec = async () => '# ok';
    const result = await generateReport(db, { description: '隨便聊聊' }, { parseExec, searchFn, synthExec });
    expect(result).not.toBeNull();
    expect(seenQuery).toContain('隨便聊聊');
  });

  it('a blank synth output is treated as unsafe/empty -> null (stripFences + non-empty check)', async () => {
    setSetting(db, 'report_enabled', 'true');
    setSetting(db, 'report_live_first', 'false');
    const searchFn: SearchFn = async () => [];
    const synthExec: ReportExec = async () => '   ';
    const result = await generateReport(db, { project: 'x' }, { searchFn, synthExec });
    expect(result).toBeNull();
  });

  it('a null synth output (call failed) -> null', async () => {
    setSetting(db, 'report_enabled', 'true');
    setSetting(db, 'report_live_first', 'false');
    const searchFn: SearchFn = async () => [];
    const synthExec: ReportExec = async () => null;
    const result = await generateReport(db, { project: 'x' }, { searchFn, synthExec });
    expect(result).toBeNull();
  });

  it('strips a fenced code block from the synth output', async () => {
    setSetting(db, 'report_enabled', 'true');
    setSetting(db, 'report_live_first', 'false');
    const searchFn: SearchFn = async () => [];
    const synthExec: ReportExec = async () => '```markdown\n# 標題\n內容\n```';
    const result = await generateReport(db, { project: 'x' }, { searchFn, synthExec });
    expect(result!.markdown).toBe('# 標題\n內容');
  });

  it('greedily packs snapshot items within report_budget_chars', async () => {
    setSetting(db, 'report_enabled', 'true');
    setSetting(db, 'report_live_first', 'false');
    setSetting(db, 'report_budget_chars', '40');
    const chunks = [fakeChunk({ text: 'A'.repeat(20), path: 'wp:1' }), fakeChunk({ text: 'B'.repeat(20), path: 'wp:2' })];
    const searchFn: SearchFn = async () => chunks;
    let seenPrompt = '';
    const synthExec: ReportExec = async (p) => {
      seenPrompt = p;
      return '# ok';
    };
    await generateReport(db, { project: 'x' }, { searchFn, synthExec });
    // budget is tight enough that not everything fits — the packer must not throw/overflow.
    expect(seenPrompt).toContain('AAAA');
  });
});

// ---- src/server/reportRoutes.ts ----

describe('POST /api/report', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('404s (disabled) by default — zero behavior change', async () => {
    app = buildApp({ db, apiToken: null });
    const res = await app.inject({ method: 'POST', url: '/api/report', payload: { description: 'x' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/disabled/);
  });

  it('returns generated markdown when enabled, using injected deps', async () => {
    setSetting(db, 'report_enabled', 'true');
    const searchFn: SearchFn = async () => [fakeChunk()];
    const synthExec: ReportExec = async () => '# 專案報告';
    app = buildApp({ db, apiToken: null, reportSearchFn: searchFn, reportSynthExec: synthExec });
    const res = await app.inject({ method: 'POST', url: '/api/report', payload: { project: 'x' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.markdown).toBe('# 專案報告');
    expect(body.meta.source).toBe('snapshot');
  });
});
