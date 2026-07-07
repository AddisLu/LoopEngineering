import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting, getBool } from '../db/index.js';
import { setCachedUsage } from '../token/usage.js';
import { buildApp } from '../server/app.js';
import { createSource } from '../knowledge/ingest/sources.js';
import { resolveProject, fetchProjectWorkPackages, type OpDataExec, type SearchFn } from '../report/opdata.js';
import { generateReport, type ReportExec } from '../report/generate.js';
import {
  listReportTemplates,
  getReportTemplate,
  upsertReportTemplate,
  importReportTemplates,
  seedReportTemplates,
  validateReportTemplateDef,
  type ReportTemplateDef,
} from '../report/templates.js';
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

  it('fuzzy-matches ignoring full-width brackets and whitespace noise', async () => {
    makeOpenProjectSource();
    const exec: OpDataExec = async () => JSON.stringify({ id: 2, name: '【大型AOI】', identifier: 'aoi2' });
    const resolved = await resolveProject(db, '大型AOI', exec);
    expect(resolved).toEqual({ id: '2', name: '【大型AOI】' });
  });

  it('fuzzy-matches a keyword with stray internal spaces against a bracketed project name', async () => {
    makeOpenProjectSource();
    const exec: OpDataExec = async () => JSON.stringify({ id: 3, name: '【大型 AOI】', identifier: 'aoi3' });
    const resolved = await resolveProject(db, '大型  AOI', exec);
    expect(resolved).toEqual({ id: '3', name: '【大型 AOI】' });
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

  it('retries against projectCandidates when the primary project string does not resolve, staying live', async () => {
    makeOpenProjectSource();
    const exec: OpDataExec = async (_bin, args) => {
      if (args.includes('--list-projects')) return LIST_PROJECTS_LINE;
      if (args.includes('--structured')) return WP_LINE;
      throw new Error(`unexpected args: ${args.join(' ')}`);
    };
    const result = await fetchProjectWorkPackages(
      db,
      { project: '不存在的專案名稱', projectCandidates: ['大型AOI'] },
      exec,
    );
    expect(result.source).toBe('live');
    expect(result.project).toEqual({ id: '1', name: '大型AOI' });
  });

  it('sorts live work packages: overdue+open first, then open, then closed, tie-broken by due_date/percent_done', async () => {
    makeOpenProjectSource();
    const wps = [
      { ...JSON.parse(WP_LINE), id: 'closed', subject: '已結案項目', is_closed: true, due_date: '2020-01-01' },
      { ...JSON.parse(WP_LINE), id: 'no-due', subject: '無交期項目', is_closed: false, due_date: '', percent_done: 0 },
      {
        ...JSON.parse(WP_LINE),
        id: 'future',
        subject: '交期在未來項目',
        is_closed: false,
        due_date: '2099-01-01',
        percent_done: 10,
      },
      {
        ...JSON.parse(WP_LINE),
        id: 'overdue',
        subject: '逾期項目',
        is_closed: false,
        due_date: '2020-01-01',
        percent_done: 50,
      },
    ];
    const exec: OpDataExec = async (_bin, args) => {
      if (args.includes('--list-projects')) return LIST_PROJECTS_LINE;
      if (args.includes('--structured')) return wps.map((w) => JSON.stringify(w)).join('\n');
      throw new Error(`unexpected args: ${args.join(' ')}`);
    };
    const result = await fetchProjectWorkPackages(db, { project: 'AOI' }, exec);
    expect(result.source).toBe('live');
    const subjects = (result.items as { subject: string }[]).map((i) => i.subject);
    expect(subjects).toEqual(['逾期項目', '交期在未來項目', '無交期項目', '已結案項目']);
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
    expect(result!.markdown).toContain('# 報告內容');
    expect(result!.markdown).toContain('```mermaid');
    expect(result!.meta.source).toBe('live');
    expect(result!.meta.itemCount).toBe(1);
    expect(result!.meta.charts).toEqual(['gantt', 'pie']);
    expect(seenPrompt).toContain('摘要');
    expect(seenPrompt).toContain('風險與落後項');
    expect(seenPrompt).toContain('PR-123 備料進度');
    expect(seenPrompt).toContain('關鍵PR進度說明');
  });

  it('description containing generic report/PR words still resolves the project live, via the salient-keyword fallback candidate', async () => {
    setSetting(db, 'report_enabled', 'true');
    makeOpenProjectSource();
    // haiku parse yields a project string that does NOT match any live project --
    // the description's remaining salient keyword ("大型AOI") must be tried as a
    // fallback candidate instead of giving up to snapshot.
    const parseExec: ReportExec = async () => JSON.stringify({ project: '不存在的專案', topic: 'PR 最新進度' });
    const dataExec: OpDataExec = async (_bin, args) => {
      if (args.includes('--list-projects')) return LIST_PROJECTS_LINE;
      if (args.includes('--structured')) return WP_LINE;
      throw new Error(`unexpected args: ${args.join(' ')}`);
    };
    const synthExec: ReportExec = async () => '# ok';
    const result = await generateReport(
      db,
      { description: '大型AOI PR 最新進度 one page' },
      { parseExec, dataExec, synthExec },
    );
    expect(result).not.toBeNull();
    expect(result!.meta.source).toBe('live');
    expect(result!.meta.project).toBe('大型AOI');
  });

  it('falls back to snapshot only when neither the parsed project nor the salient keyword resolves live', async () => {
    setSetting(db, 'report_enabled', 'true');
    makeOpenProjectSource();
    const parseExec: ReportExec = async () => JSON.stringify({ project: '', topic: '隨便聊聊' });
    const dataExec: OpDataExec = async (_bin, args) => {
      if (args.includes('--list-projects')) return LIST_PROJECTS_LINE; // no candidate matches this list
      throw new Error(`unexpected args: ${args.join(' ')}`);
    };
    const searchFn: SearchFn = async () => [fakeChunk()];
    const synthExec: ReportExec = async () => '# ok';
    const result = await generateReport(
      db,
      { description: '隨便聊聊 report' },
      { parseExec, dataExec, searchFn, synthExec },
    );
    expect(result).not.toBeNull();
    expect(result!.meta.source).toBe('snapshot');
  });

  it('sorts and prepends an aggregate summary line so overdue/open items survive a tight char budget on a large parent-project fetch', async () => {
    setSetting(db, 'report_enabled', 'true');
    setSetting(db, 'report_budget_chars', '300');
    makeOpenProjectSource();
    const closedItems = Array.from({ length: 50 }, (_, i) => ({
      ...JSON.parse(WP_LINE),
      id: `closed-${i}`,
      subject: `已結案子項目 ${i}`,
      is_closed: true,
      due_date: '2020-01-01',
    }));
    const overdueItem = { ...JSON.parse(WP_LINE), id: 'overdue', subject: '關鍵逾期項目', is_closed: false, due_date: '2020-01-01', percent_done: 20 };
    // overdue item placed LAST in the raw API response -- only sorting saves it from truncation.
    const allItems = [...closedItems, overdueItem];
    const dataExec: OpDataExec = async (_bin, args) => {
      if (args.includes('--list-projects')) return LIST_PROJECTS_LINE;
      if (args.includes('--structured')) return allItems.map((w) => JSON.stringify(w)).join('\n');
      throw new Error(`unexpected args: ${args.join(' ')}`);
    };
    let seenPrompt = '';
    const synthExec: ReportExec = async (p) => {
      seenPrompt = p;
      return '# ok';
    };
    const result = await generateReport(db, { project: '大型AOI' }, { dataExec, synthExec });
    expect(result).not.toBeNull();
    expect(result!.meta.itemCount).toBe(51);
    expect(seenPrompt).toContain('關鍵逾期項目');
    expect(seenPrompt).toContain('整體彙整');
    expect(seenPrompt).toContain('逾期 1');
    expect(seenPrompt).not.toContain('已結案子項目 49');
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

// ---- report/templates.ts ----

const CUSTOM_TEMPLATE: ReportTemplateDef = {
  name: 'custom-a',
  description: '測試用自訂範本',
  audience: '測試對象',
  format: '自由格式',
  instructions: '【自訂範本指示標記 CUSTOM-A-XYZ】用這個語氣寫報告',
  sections: ['s1', 's2'],
};

describe('report/templates.ts: seeded built-ins', () => {
  it('seeds the 3 boss personas on first run (openTestDb calls seedReportTemplates)', () => {
    const names = listReportTemplates(db).map((d) => d.name).sort();
    expect(names).toEqual(['manager-pr-weekly', 'plant-manager-onepage', 'pm-detailed']);
  });

  it('every seeded template has non-empty instructions', () => {
    for (const d of listReportTemplates(db)) {
      expect(d.instructions.trim().length).toBeGreaterThan(0);
    }
  });

  it('a re-seed never clobbers a user edit (INSERT OR IGNORE, like pipelines)', () => {
    upsertReportTemplate(db, { name: 'plant-manager-onepage', instructions: '編輯過的指示' });
    seedReportTemplates(db);
    expect(getReportTemplate(db, 'plant-manager-onepage')?.instructions).toBe('編輯過的指示');
  });

  it('seeding twice is idempotent (same 3 names, no duplicates/errors)', () => {
    seedReportTemplates(db);
    seedReportTemplates(db);
    const names = listReportTemplates(db).map((d) => d.name).sort();
    expect(names).toEqual(['manager-pr-weekly', 'plant-manager-onepage', 'pm-detailed']);
  });
});

describe('report/templates.ts: CRUD + import', () => {
  it('upsertReportTemplate creates then updates in place by name', () => {
    upsertReportTemplate(db, CUSTOM_TEMPLATE);
    expect(getReportTemplate(db, 'custom-a')?.description).toBe('測試用自訂範本');
    upsertReportTemplate(db, { ...CUSTOM_TEMPLATE, description: 'v2' });
    expect(listReportTemplates(db).filter((d) => d.name === 'custom-a')).toHaveLength(1);
    expect(getReportTemplate(db, 'custom-a')?.description).toBe('v2');
  });

  it('validateReportTemplateDef rejects a bad shape without throwing', () => {
    expect(validateReportTemplateDef('nope').ok).toBe(false);
    expect(validateReportTemplateDef({}).ok).toBe(false);
    const missingInstructions = validateReportTemplateDef({ name: 'x' });
    expect(missingInstructions.ok).toBe(false);
    if (!missingInstructions.ok) expect(missingInstructions.error).toMatch(/instructions/);
    const missingName = validateReportTemplateDef({ instructions: 'x' });
    expect(missingName.ok).toBe(false);
    if (!missingName.ok) expect(missingName.error).toMatch(/name/);
    const badSections = validateReportTemplateDef({ name: 'x', instructions: 'y', sections: 'not-an-array' });
    expect(badSections.ok).toBe(false);
  });

  it('importReportTemplates reports created/updated and rejects bad items without failing the batch', () => {
    const result = importReportTemplates(db, [
      CUSTOM_TEMPLATE,
      { name: 'bad' }, // missing instructions
      { name: 'custom-b', instructions: 'ok' },
    ]);
    expect(result.created).toBe(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].error).toMatch(/instructions/);
    expect(getReportTemplate(db, 'custom-a')).toBeTruthy();
    expect(getReportTemplate(db, 'bad')).toBeUndefined();
  });

  it('re-importing the same template updates rather than duplicates', () => {
    importReportTemplates(db, [CUSTOM_TEMPLATE]);
    const result = importReportTemplates(db, [{ ...CUSTOM_TEMPLATE, description: 'updated via import' }]);
    expect(result.updated).toBe(1);
    expect(result.created).toBe(0);
    expect(getReportTemplate(db, 'custom-a')?.description).toBe('updated via import');
  });

  it('getReportTemplate returns undefined for a missing name (never throws)', () => {
    expect(getReportTemplate(db, 'does-not-exist')).toBeUndefined();
  });
});

// ---- generate.ts: template support ----

describe('generateReport: template support', () => {
  it('report_enabled=false (default) -> null even with a template requested — zero behavior change', async () => {
    const synthExec: ReportExec = async () => {
      throw new Error('must never be called');
    };
    const result = await generateReport(db, { project: 'x', template: 'plant-manager-onepage' }, { synthExec });
    expect(result).toBeNull();
  });

  it('an explicit known template: its instructions are injected into the synth prompt (not the built-in default), and meta.template is set', async () => {
    setSetting(db, 'report_enabled', 'true');
    setSetting(db, 'report_live_first', 'false');
    upsertReportTemplate(db, CUSTOM_TEMPLATE);
    const searchFn: SearchFn = async () => [];
    let seenPrompt = '';
    const synthExec: ReportExec = async (p) => {
      seenPrompt = p;
      return '# ok';
    };
    const result = await generateReport(db, { project: 'x', template: 'custom-a' }, { searchFn, synthExec });
    expect(result).not.toBeNull();
    expect(seenPrompt).toContain('CUSTOM-A-XYZ');
    expect(seenPrompt).not.toContain('風險與落後項'); // built-in default's own section heading
    expect(result!.meta.template).toBe('custom-a');
  });

  it('an unknown template name falls back to the built-in default instructions, and meta.template is left unset', async () => {
    setSetting(db, 'report_enabled', 'true');
    setSetting(db, 'report_live_first', 'false');
    const searchFn: SearchFn = async () => [];
    let seenPrompt = '';
    const synthExec: ReportExec = async (p) => {
      seenPrompt = p;
      return '# ok';
    };
    const result = await generateReport(db, { project: 'x', template: 'does-not-exist' }, { searchFn, synthExec });
    expect(result).not.toBeNull();
    expect(seenPrompt).toContain('風險與落後項');
    expect(result!.meta.template).toBeUndefined();
  });

  it("a template's default_project fills in project when the request gives none", async () => {
    setSetting(db, 'report_enabled', 'true');
    setSetting(db, 'report_live_first', 'false');
    upsertReportTemplate(db, { ...CUSTOM_TEMPLATE, default_project: '預設專案X' });
    const searchFn: SearchFn = async (_db, q) => {
      expect(q).toContain('預設專案X');
      return [];
    };
    const synthExec: ReportExec = async () => '# ok';
    const result = await generateReport(db, { template: 'custom-a', topic: '進度' }, { searchFn, synthExec });
    expect(result).not.toBeNull();
    expect(result!.meta.project).toBe('預設專案X');
  });

  it('a description without an explicit template lets the injected templatePickExec choose the best-fitting one', async () => {
    setSetting(db, 'report_enabled', 'true');
    setSetting(db, 'report_live_first', 'false');
    upsertReportTemplate(db, CUSTOM_TEMPLATE);
    upsertReportTemplate(db, { name: 'custom-b', instructions: '【另一個範本 B】' });
    const parseExec: ReportExec = async () => JSON.stringify({ project: '', topic: '隨便' });
    const templatePickExec: ReportExec = async (prompt) => {
      expect(prompt).toContain('custom-a');
      expect(prompt).toContain('custom-b');
      return JSON.stringify({ template: 'custom-b' });
    };
    const searchFn: SearchFn = async () => [];
    let seenPrompt = '';
    const synthExec: ReportExec = async (p) => {
      seenPrompt = p;
      return '# ok';
    };
    const result = await generateReport(
      db,
      { description: '幫我出一份報告' },
      { parseExec, templatePickExec, searchFn, synthExec },
    );
    expect(result).not.toBeNull();
    expect(seenPrompt).toContain('另一個範本 B');
    expect(result!.meta.template).toBe('custom-b');
  });

  it('templatePickExec returning an unmatched/empty name falls back to the built-in default (never throws)', async () => {
    setSetting(db, 'report_enabled', 'true');
    setSetting(db, 'report_live_first', 'false');
    upsertReportTemplate(db, CUSTOM_TEMPLATE);
    const parseExec: ReportExec = async () => JSON.stringify({ project: '', topic: '隨便' });
    const templatePickExec: ReportExec = async () => JSON.stringify({ template: '' });
    const searchFn: SearchFn = async () => [];
    const synthExec: ReportExec = async () => '# ok';
    const result = await generateReport(
      db,
      { description: '幫我出一份報告' },
      { parseExec, templatePickExec, searchFn, synthExec },
    );
    expect(result).not.toBeNull();
    expect(result!.meta.template).toBeUndefined();
  });

  it('an explicit template skips the LLM auto-pick entirely, even when a description is also given', async () => {
    setSetting(db, 'report_enabled', 'true');
    setSetting(db, 'report_live_first', 'false');
    upsertReportTemplate(db, CUSTOM_TEMPLATE);
    const templatePickExec: ReportExec = async () => {
      throw new Error('must never be called when template is explicit');
    };
    const searchFn: SearchFn = async () => [];
    const synthExec: ReportExec = async () => '# ok';
    const result = await generateReport(
      db,
      { description: '幫我出一份報告', template: 'custom-a' },
      { templatePickExec, searchFn, synthExec },
    );
    expect(result).not.toBeNull();
    expect(result!.meta.template).toBe('custom-a');
  });

  it('report_default_template setting is the last-resort fallback when no template/description picks one', async () => {
    setSetting(db, 'report_enabled', 'true');
    setSetting(db, 'report_live_first', 'false');
    upsertReportTemplate(db, CUSTOM_TEMPLATE);
    setSetting(db, 'report_default_template', 'custom-a');
    const searchFn: SearchFn = async () => [];
    let seenPrompt = '';
    const synthExec: ReportExec = async (p) => {
      seenPrompt = p;
      return '# ok';
    };
    const result = await generateReport(db, { project: 'x' }, { searchFn, synthExec });
    expect(result).not.toBeNull();
    expect(seenPrompt).toContain('CUSTOM-A-XYZ');
    expect(result!.meta.template).toBe('custom-a');
  });
});

// ---- src/server/reportRoutes.ts: templates CRUD ----

describe('report template routes', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('every /api/report/templates* route 404s (disabled) by default', async () => {
    app = buildApp({ db, apiToken: null });
    const list = await app.inject({ method: 'GET', url: '/api/report/templates' });
    expect(list.statusCode).toBe(404);
    const one = await app.inject({ method: 'GET', url: '/api/report/templates/plant-manager-onepage' });
    expect(one.statusCode).toBe(404);
    const add = await app.inject({ method: 'POST', url: '/api/report/templates', payload: CUSTOM_TEMPLATE });
    expect(add.statusCode).toBe(404);
    const imp = await app.inject({ method: 'POST', url: '/api/report/templates/import', payload: { items: [] } });
    expect(imp.statusCode).toBe(404);
  });

  it('GET /api/report/templates lists the seeded personas when enabled', async () => {
    setSetting(db, 'report_enabled', 'true');
    app = buildApp({ db, apiToken: null });
    const res = await app.inject({ method: 'GET', url: '/api/report/templates' });
    expect(res.statusCode).toBe(200);
    const names = res.json().templates.map((t: ReportTemplateDef) => t.name).sort();
    expect(names).toEqual(['manager-pr-weekly', 'plant-manager-onepage', 'pm-detailed']);
  });

  it('GET /api/report/templates/:name returns one template, 404s for an unknown name', async () => {
    setSetting(db, 'report_enabled', 'true');
    app = buildApp({ db, apiToken: null });
    const ok = await app.inject({ method: 'GET', url: '/api/report/templates/plant-manager-onepage' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().template.name).toBe('plant-manager-onepage');
    const missing = await app.inject({ method: 'GET', url: '/api/report/templates/does-not-exist' });
    expect(missing.statusCode).toBe(404);
  });

  it('POST /api/report/templates creates/updates a template; rejects an invalid body with 400', async () => {
    setSetting(db, 'report_enabled', 'true');
    app = buildApp({ db, apiToken: null });
    const created = await app.inject({ method: 'POST', url: '/api/report/templates', payload: CUSTOM_TEMPLATE });
    expect(created.statusCode).toBe(200);
    expect(created.json().template.name).toBe('custom-a');
    expect(getReportTemplate(db, 'custom-a')).toBeTruthy();

    const bad = await app.inject({ method: 'POST', url: '/api/report/templates', payload: { name: 'no-instructions' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/instructions/);
  });

  it('POST /api/report/templates/import bulk-imports and reports rejects', async () => {
    setSetting(db, 'report_enabled', 'true');
    app = buildApp({ db, apiToken: null });
    const res = await app.inject({
      method: 'POST',
      url: '/api/report/templates/import',
      payload: { items: [CUSTOM_TEMPLATE, { name: 'bad' }] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created).toBe(1);
    expect(body.rejected).toHaveLength(1);
  });

  it('POST /api/report threads the template field through to generateReport', async () => {
    setSetting(db, 'report_enabled', 'true');
    setSetting(db, 'report_live_first', 'false');
    upsertReportTemplate(db, CUSTOM_TEMPLATE);
    const searchFn: SearchFn = async () => [];
    let seenPrompt = '';
    const synthExec: ReportExec = async (p) => {
      seenPrompt = p;
      return '# ok';
    };
    app = buildApp({ db, apiToken: null, reportSearchFn: searchFn, reportSynthExec: synthExec });
    const res = await app.inject({
      method: 'POST',
      url: '/api/report',
      payload: { project: 'x', template: 'custom-a' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().meta.template).toBe('custom-a');
    expect(seenPrompt).toContain('CUSTOM-A-XYZ');
  });
});
