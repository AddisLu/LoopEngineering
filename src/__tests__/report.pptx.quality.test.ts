import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { setCachedUsage } from '../token/usage.js';
import { polishItems, judgeDeckContent } from '../report/pptx/quality.js';
import type { ContentExec } from '../report/pptx/status.js';
import type { StatusCandidate } from '../report/pptx/diff.js';

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10); // safe, fresh — well under hard_limit_pct
});

// ---- polishItems ----

describe('quality.ts: polishItems', () => {
  const ITEMS: StatusCandidate[] = [
    { text: '良率驗證完成，達標 98.5%', sources: [{ wp: 1 }] },
    { text: 'Pilot run 已完成', highlight: true },
  ];

  it('empty items -> returned as-is, exec never called', async () => {
    let calls = 0;
    const exec: ContentExec = async () => {
      calls++;
      return null;
    };
    const out = await polishItems(db, [], 60, exec);
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it('exec returns null -> items returned unchanged', async () => {
    const exec: ContentExec = async () => null;
    const out = await polishItems(db, ITEMS, 60, exec);
    expect(out).toEqual(ITEMS);
  });

  it('exec throws -> items returned unchanged, never throws', async () => {
    const exec: ContentExec = async () => {
      throw new Error('boom');
    };
    const out = await polishItems(db, ITEMS, 60, exec);
    expect(out).toEqual(ITEMS);
  });

  it('exec returns unparseable/mismatched-count output -> items returned unchanged', async () => {
    const garbage: ContentExec = async () => 'not json';
    expect(await polishItems(db, ITEMS, 60, garbage)).toEqual(ITEMS);

    const wrongCount: ContentExec = async () => JSON.stringify({ items: [{ text: 'only one' }] });
    expect(await polishItems(db, ITEMS, 60, wrongCount)).toEqual(ITEMS);
  });

  it('usage guard: session usage >= hard_limit_pct -> items unchanged without calling exec', async () => {
    setCachedUsage(96, 10);
    let calls = 0;
    const exec: ContentExec = async () => {
      calls++;
      return null;
    };
    const out = await polishItems(db, ITEMS, 60, exec);
    expect(out).toEqual(ITEMS);
    expect(calls).toBe(0);
  });

  it('successful polish replaces text only — highlight/sources untouched, order preserved', async () => {
    const exec: ContentExec = async () =>
      JSON.stringify({ items: [{ text: '良率 98.5% 達標，已驗證完成' }, { text: 'Pilot run 完成' }] });
    const out = await polishItems(db, ITEMS, 60, exec);
    expect(out).toEqual([
      { text: '良率 98.5% 達標，已驗證完成', sources: [{ wp: 1 }] },
      { text: 'Pilot run 完成', highlight: true },
    ]);
  });

  it('always calls exec with model "haiku" regardless of report_pptx_model/llm_judge_model settings', async () => {
    setSetting(db, 'report_pptx_model', 'opus');
    setSetting(db, 'llm_judge_model', 'sonnet');
    const seenModels: string[] = [];
    const exec: ContentExec = async (_p, model) => {
      seenModels.push(model);
      return null;
    };
    await polishItems(db, ITEMS, 60, exec);
    expect(seenModels).toEqual(['haiku']);
  });
});

// ---- judgeDeckContent ----

describe('quality.ts: judgeDeckContent', () => {
  const BASE_INPUT = {
    projectName: 'AOI 專案',
    items: [{ text: '良率驗證完成，達標 98.5%', sources: [{ wp: 1 }] }] as StatusCandidate[],
    explainPages: [],
    changedWpCount: 3,
  };

  it('garbage/unparseable output -> inconclusive pass', async () => {
    const exec: ContentExec = async () => 'not json at all';
    const verdict = await judgeDeckContent(db, BASE_INPUT, exec);
    expect(verdict).toEqual({ pass: true, score: -1, feedback: 'judge inconclusive' });
  });

  it('exec returns null -> inconclusive pass', async () => {
    const exec: ContentExec = async () => null;
    const verdict = await judgeDeckContent(db, BASE_INPUT, exec);
    expect(verdict).toEqual({ pass: true, score: -1, feedback: 'judge inconclusive' });
  });

  it('exec throws -> inconclusive pass, never throws', async () => {
    const exec: ContentExec = async () => {
      throw new Error('boom');
    };
    const verdict = await judgeDeckContent(db, BASE_INPUT, exec);
    expect(verdict).toEqual({ pass: true, score: -1, feedback: 'judge inconclusive' });
  });

  it('usage guard: session usage >= hard_limit_pct -> inconclusive pass without calling exec', async () => {
    setCachedUsage(96, 10);
    let calls = 0;
    const exec: ContentExec = async () => {
      calls++;
      return null;
    };
    const verdict = await judgeDeckContent(db, BASE_INPUT, exec);
    expect(verdict).toEqual({ pass: true, score: -1, feedback: 'judge inconclusive' });
    expect(calls).toBe(0);
  });

  it('well-formed fail verdict is returned as-is', async () => {
    const exec: ContentExec = async () => JSON.stringify({ pass: false, score: 40, feedback: '缺對策' });
    const verdict = await judgeDeckContent(db, BASE_INPUT, exec);
    expect(verdict).toEqual({ pass: false, score: 40, feedback: '缺對策' });
  });

  it('well-formed pass verdict is returned as-is', async () => {
    const exec: ContentExec = async () => JSON.stringify({ pass: true, score: 90, feedback: 'ok' });
    const verdict = await judgeDeckContent(db, BASE_INPUT, exec);
    expect(verdict).toEqual({ pass: true, score: 90, feedback: 'ok' });
  });

  it('model resolves llm_judge_model -> "haiku", ignoring report_pptx_model', async () => {
    setSetting(db, 'report_pptx_model', 'opus');
    const seenModels: string[] = [];
    const exec: ContentExec = async (_p, model) => {
      seenModels.push(model);
      return null;
    };
    await judgeDeckContent(db, BASE_INPUT, exec);
    expect(seenModels).toEqual(['haiku']);

    setSetting(db, 'llm_judge_model', 'sonnet');
    await judgeDeckContent(db, BASE_INPUT, exec);
    expect(seenModels.at(-1)).toBe('sonnet');
  });
});
