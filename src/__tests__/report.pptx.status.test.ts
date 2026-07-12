import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { setCachedUsage } from '../token/usage.js';
import {
  buildStatusPrompt,
  parseStatusItems,
  detectChangedWps,
  generateStatusCandidates,
  type ContentExec,
} from '../report/pptx/status.js';
import type { OpWorkPackage } from '../report/opdata.js';

function mkWp(overrides: Partial<OpWorkPackage> = {}): OpWorkPackage {
  return {
    id: 1,
    subject: '測試 WP',
    status: '進行中',
    is_closed: false,
    type: 'Task',
    assignee_name: '王小明',
    project_id: 1,
    project_name: 'AOI 專案',
    start_date: '2026-07-01',
    due_date: '2026-07-31',
    percent_done: 50,
    estimated_hours: 10,
    spent_hours: 5,
    remaining_hours: 5,
    description: '',
    custom_fields: {},
    updated_at: '2026-07-10T00:00:00Z',
    ...overrides,
  };
}

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10); // safe, fresh — well under hard_limit_pct
});

// ---- buildStatusPrompt ----

describe('status.ts: buildStatusPrompt', () => {
  it('contains the required synthesis/countermeasure/carryover/STRICT-JSON instructions, prevItems verbatim, and maxItemChars as a literal number', () => {
    const prompt = buildStatusPrompt({
      projectName: 'AOI 專案',
      changedWps: [mkWp({ id: 101, subject: '良率驗證' })],
      allOpenWps: [],
      prevItems: ['上週原文第一項', '上週原文第二項'],
      maxItemChars: 60,
    });
    expect(prompt).toContain('不得照抄');
    expect(prompt).toContain('必附對策');
    expect(prompt).toContain('沿用上週措辭');
    expect(prompt).toContain('STRICT JSON');
    expect(prompt).toContain('上週原文第一項');
    expect(prompt).toContain('上週原文第二項');
    expect(prompt).toContain('60');
  });

  it('packs changedWps into the prompt and marks an empty set explicitly', () => {
    const withWps = buildStatusPrompt({
      projectName: 'X',
      changedWps: [mkWp({ id: 202, subject: '關鍵字ABC' })],
      allOpenWps: [],
      prevItems: [],
      maxItemChars: 60,
    });
    expect(withWps).toContain('關鍵字ABC');
    expect(withWps).toContain('202');

    const empty = buildStatusPrompt({ projectName: 'X', changedWps: [], allOpenWps: [], prevItems: [], maxItemChars: 60 });
    expect(empty).toContain('本週無偵測到變動');
  });

  it('appends judge feedback for a regeneration pass when given', () => {
    const prompt = buildStatusPrompt({
      projectName: 'X',
      changedWps: [],
      allOpenWps: [],
      prevItems: [],
      maxItemChars: 60,
      feedback: '缺對策',
    });
    expect(prompt).toContain('缺對策');
  });
});

// ---- parseStatusItems fault-tolerance matrix ----

describe('status.ts: parseStatusItems', () => {
  it('parses fenced JSON', () => {
    const out = parseStatusItems('```json\n{"items":[{"text":"進度正常"}]}\n```');
    expect(out).toEqual([{ text: '進度正常' }]);
  });

  it('clamps 3 items down to 2', () => {
    const out = parseStatusItems(JSON.stringify({ items: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] }));
    expect(out).toHaveLength(2);
  });

  it('collapses multi-line text to a single line', () => {
    const out = parseStatusItems(JSON.stringify({ items: [{ text: '第一行\n第二行  第三行' }] }));
    expect(out?.[0]?.text).toBe('第一行 第二行 第三行');
  });

  it('garbage input -> null', () => {
    expect(parseStatusItems('not json at all')).toBeNull();
    expect(parseStatusItems(JSON.stringify({ nope: true }))).toBeNull();
    expect(parseStatusItems(JSON.stringify({ items: 'not an array' }))).toBeNull();
  });

  it('all items dropped (every text empty/missing) -> null, not []', () => {
    const out = parseStatusItems(JSON.stringify({ items: [{ text: '' }, { highlight: true }] }));
    expect(out).toBeNull();
  });

  it('highlight only kept when literally true; non-boolean/false omitted', () => {
    const out = parseStatusItems(
      JSON.stringify({
        items: [
          { text: 'a', highlight: true },
          { text: 'b', highlight: 'yes' },
        ],
      }),
    );
    expect(out?.[0]).toEqual({ text: 'a', highlight: true });
    expect(out?.[1]).toEqual({ text: 'b' });

    const falseCase = parseStatusItems(JSON.stringify({ items: [{ text: 'c', highlight: false }] }));
    expect(falseCase?.[0]).toEqual({ text: 'c' });
  });

  it('invalid source entries are dropped; an all-invalid sources array is omitted', () => {
    const out = parseStatusItems(
      JSON.stringify({
        items: [
          { text: 'a', sources: [{ wp: 123 }, { bogus: true }, { wp: 'not-a-number' }] },
          { text: 'b', sources: [{ bogus: true }] },
        ],
      }),
    );
    expect(out?.[0]).toEqual({ text: 'a', sources: [{ wp: 123 }] });
    expect(out?.[1]).toEqual({ text: 'b' });
  });
});

// ---- detectChangedWps ----

describe('status.ts: detectChangedWps', () => {
  it('no prev snapshot at all -> every current WP counts as changed', () => {
    const current = [mkWp({ id: 1 }), mkWp({ id: 2 })];
    expect(detectChangedWps(current, null)).toEqual(current);
  });

  it('newly opened WP (absent from prev) counts as changed', () => {
    const current = [mkWp({ id: 1 }), mkWp({ id: 2 })];
    const prev = [mkWp({ id: 1 })];
    const changed = detectChangedWps(current, prev);
    expect(changed.map((w) => w.id)) .toEqual([2]);
  });

  it('is_closed flip counts as changed even when updated_at is unchanged', () => {
    const current = [mkWp({ id: 1, is_closed: true, updated_at: '2026-07-01T00:00:00Z' })];
    const prev = [mkWp({ id: 1, is_closed: false, updated_at: '2026-07-01T00:00:00Z' })];
    expect(detectChangedWps(current, prev).map((w) => w.id)).toEqual([1]);
  });

  it('newer updated_at counts as changed', () => {
    const current = [mkWp({ id: 1, updated_at: '2026-07-10T00:00:00Z' })];
    const prev = [mkWp({ id: 1, updated_at: '2026-07-01T00:00:00Z' })];
    expect(detectChangedWps(current, prev).map((w) => w.id)).toEqual([1]);
  });

  it('unchanged WP (same is_closed, same/older updated_at) is excluded', () => {
    const current = [mkWp({ id: 1, updated_at: '2026-07-01T00:00:00Z' })];
    const prev = [mkWp({ id: 1, updated_at: '2026-07-01T00:00:00Z' })];
    expect(detectChangedWps(current, prev)).toEqual([]);
  });

  it('union of all three signals, order follows currentWps', () => {
    const current = [
      mkWp({ id: 1, updated_at: '2026-07-01T00:00:00Z' }), // unchanged
      mkWp({ id: 2, updated_at: '2026-07-10T00:00:00Z' }), // newer
      mkWp({ id: 3, is_closed: true, updated_at: '2026-07-01T00:00:00Z' }), // closed flip
      mkWp({ id: 4 }), // new
    ];
    const prev = [
      mkWp({ id: 1, updated_at: '2026-07-01T00:00:00Z' }),
      mkWp({ id: 2, updated_at: '2026-07-01T00:00:00Z' }),
      mkWp({ id: 3, is_closed: false, updated_at: '2026-07-01T00:00:00Z' }),
    ];
    expect(detectChangedWps(current, prev).map((w) => w.id)).toEqual([2, 3, 4]);
  });
});

// ---- generateStatusCandidates ----

describe('status.ts: generateStatusCandidates', () => {
  const BASE_INPUT = { projectName: 'AOI 專案', changedWps: [mkWp()], allOpenWps: [], prevItems: [], maxItemChars: 60 };

  it('usage guard: session usage >= hard_limit_pct -> fallback without calling exec', async () => {
    setCachedUsage(96, 10); // hard_limit_pct default is 95
    let calls = 0;
    const exec: ContentExec = async () => {
      calls++;
      return null;
    };
    const result = await generateStatusCandidates(db, BASE_INPUT, exec);
    expect(result).toEqual({ items: [], usedLlm: false });
    expect(calls).toBe(0);
  });

  it('exec returns null -> fallback {items:[], usedLlm:false}, never throws', async () => {
    setCachedUsage(10, 10);
    const exec: ContentExec = async () => null;
    const result = await generateStatusCandidates(db, BASE_INPUT, exec);
    expect(result).toEqual({ items: [], usedLlm: false });
  });

  it('exec returns unparseable output -> fallback {items:[], usedLlm:false}', async () => {
    setCachedUsage(10, 10);
    const exec: ContentExec = async () => 'not json at all';
    const result = await generateStatusCandidates(db, BASE_INPUT, exec);
    expect(result).toEqual({ items: [], usedLlm: false });
  });

  it('exec throws -> fallback, never throws out of generateStatusCandidates', async () => {
    setCachedUsage(10, 10);
    const exec: ContentExec = async () => {
      throw new Error('boom');
    };
    const result = await generateStatusCandidates(db, BASE_INPUT, exec);
    expect(result).toEqual({ items: [], usedLlm: false });
  });

  it('successful parse -> items + usedLlm:true', async () => {
    setCachedUsage(10, 10);
    const exec: ContentExec = async () => JSON.stringify({ items: [{ text: '進度正常，如期交付', sources: [{ wp: 1 }] }] });
    const result = await generateStatusCandidates(db, BASE_INPUT, exec);
    expect(result.usedLlm).toBe(true);
    expect(result.items).toEqual([{ text: '進度正常，如期交付', sources: [{ wp: 1 }] }]);
  });

  it('model resolves report_pptx_model -> report_model -> sonnet, in that priority', async () => {
    setCachedUsage(10, 10);
    const seenModels: string[] = [];
    const exec: ContentExec = async (_p, model) => {
      seenModels.push(model);
      return null;
    };

    await generateStatusCandidates(db, BASE_INPUT, exec);
    expect(seenModels.at(-1)).toBe('sonnet');

    setSetting(db, 'report_model', 'opus');
    await generateStatusCandidates(db, BASE_INPUT, exec);
    expect(seenModels.at(-1)).toBe('opus');

    setSetting(db, 'report_pptx_model', 'haiku');
    await generateStatusCandidates(db, BASE_INPUT, exec);
    expect(seenModels.at(-1)).toBe('haiku');
  });
});
