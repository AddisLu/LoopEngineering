import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createSource } from '../knowledge/ingest/sources.js';
import { prepareWeekly, renderWeekly, type WeeklyDeps } from '../report/pptx/weekly.js';
import type { AssembleFs } from '../report/pptx/assemble.js';
import type { OpDataExec } from '../report/opdata.js';
import type { PptxRenderExec } from '../report/pptx/render.js';
import type { ContentExec } from '../report/pptx/status.js';
import type { DeckSpec } from '../report/pptx/spec.js';

function fakeFs(initial: Record<string, string> = {}): { fs: AssembleFs; files: Map<string, string> } {
  const files = new Map<string, string>(Object.entries(initial));
  const fs: AssembleFs = {
    readFile: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    writeFile: (p, content) => {
      files.set(p, content);
    },
    readdir: (dir) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const names = new Set<string>();
      for (const p of files.keys()) {
        if (p.startsWith(prefix)) names.add(p.slice(prefix.length).split('/')[0] ?? '');
      }
      return [...names];
    },
    exists: (p) => {
      if (files.has(p)) return true;
      const prefix = p.endsWith('/') ? p : `${p}/`;
      for (const f of files.keys()) if (f.startsWith(prefix)) return true;
      return false;
    },
    mkdir: () => {},
  };
  return { fs, files };
}

/** Live-fetch dataExec fixture: `--list-projects` resolves the registry's 'AOI 專案' by
 * exact name match (tier 3), `--project ... --structured` returns the given WPs as
 * newline-delimited JSON (see opdata.ts's parseJsonLines). */
function liveWpDataExec(wps: Array<Record<string, unknown>>): OpDataExec {
  return async (_bin, args) => {
    if (args.includes('--list-projects')) return JSON.stringify({ id: 42, name: 'AOI 專案', identifier: 'aoi-amc' });
    return wps.map((w) => JSON.stringify(w)).join('\n');
  };
}

/** Routes a shared ContentExec by each prompt's distinctive heading (status.ts's
 * buildStatusPrompt / quality.ts's buildPolishPrompt / buildJudgePrompt all start with a
 * different `# ...` line) so one fake can drive generate/polish/judge independently —
 * mirrors production, where all three share exactly one injected hook. */
function dispatchExec(handlers: {
  generate?: (prompt: string, call: number) => string | null;
  polish?: (prompt: string, call: number) => string | null;
  judge?: (prompt: string, call: number) => string | null;
}): {
  exec: ContentExec;
  prompts: { generate: string[]; polish: string[]; judge: string[] };
  calls: { generate: number; polish: number; judge: number };
} {
  const prompts = { generate: [] as string[], polish: [] as string[], judge: [] as string[] };
  const calls = { generate: 0, polish: 0, judge: 0 };
  const exec: ContentExec = async (prompt) => {
    if (prompt.startsWith('# 週報 status 項目生成')) {
      calls.generate++;
      prompts.generate.push(prompt);
      return handlers.generate ? handlers.generate(prompt, calls.generate) : null;
    }
    if (prompt.startsWith('# 週報 status 潤稿')) {
      calls.polish++;
      prompts.polish.push(prompt);
      return handlers.polish ? handlers.polish(prompt, calls.polish) : null;
    }
    if (prompt.startsWith('# 週報內容品質評分')) {
      calls.judge++;
      prompts.judge.push(prompt);
      return handlers.judge ? handlers.judge(prompt, calls.judge) : null;
    }
    return null;
  };
  return { exec, prompts, calls };
}

const PPTX_DIR = '/data/report-pptx';

const ONE_PROJECT_REGISTRY = {
  version: 1,
  pillars: ['AMC'],
  projects: [{ key: 'aoi-amc', pillar: 'AMC', name: 'AOI 專案', fab: 'Fab1', fab_line: 'Fab1/LineA', enabled: true }],
};

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
  setSetting(db, 'report_pptx_enabled', 'true');
  setSetting(db, 'report_pptx_dir', PPTX_DIR);
});
afterEach(() => db.close());

const FIXED_NOW = () => new Date('2026-07-13T00:00:00Z'); // Monday, ISO week 2026-W29

describe('weekly.ts: zero-impact — flag off fail-fast', () => {
  it('prepareWeekly returns null when report_pptx_enabled is false', async () => {
    setSetting(db, 'report_pptx_enabled', 'false');
    const { fs } = fakeFs();
    const result = await prepareWeekly(db, { llm: false }, { fs, now: FIXED_NOW });
    expect(result).toBeNull();
  });

  it('renderWeekly returns null when report_pptx_enabled is false', async () => {
    setSetting(db, 'report_pptx_enabled', 'false');
    const { fs } = fakeFs();
    const result = await renderWeekly(db, {}, { fs, now: FIXED_NOW });
    expect(result).toBeNull();
  });
});

describe('weekly.ts: prepareWeekly', () => {
  it('missing projects.json -> null (fail-fast with an example printed to stderr)', async () => {
    const { fs } = fakeFs();
    const result = await prepareWeekly(db, { llm: false }, { fs, now: FIXED_NOW });
    expect(result).toBeNull();
  });

  it('writes deck-spec.json, explain-pages.json skeleton, and a per-project workpackages/<key>.json', async () => {
    const { fs, files } = fakeFs({
      [`${PPTX_DIR}/projects.json`]: JSON.stringify(ONE_PROJECT_REGISTRY),
    });
    const result = await prepareWeekly(db, { week: '2026-W01', llm: false }, { fs, now: FIXED_NOW });
    expect(result).not.toBeNull();
    expect(result!.specPath).toBe(`${PPTX_DIR}/weeks/2026-W01/deck-spec.json`);
    expect(result!.explainPath).toBe(`${PPTX_DIR}/weeks/2026-W01/explain-pages.json`);

    const spec = JSON.parse(files.get(result!.specPath)!) as DeckSpec;
    expect(spec.week).toBe('2026-W01');
    expect(spec.projects).toHaveLength(1);
    expect(spec.projects[0]?.key).toBe('aoi-amc');

    const explain = JSON.parse(files.get(result!.explainPath)!);
    expect(explain).toEqual({ approved: false, projects: {} });

    const wpSnapshot = JSON.parse(files.get(`${PPTX_DIR}/weeks/2026-W01/workpackages/aoi-amc.json`)!);
    expect(wpSnapshot).toEqual([]); // no live openproject source configured -> empty + warning

    expect(result!.warnings.some((w) => w.includes('aoi-amc'))).toBe(true);
  });

  it('does not overwrite an existing explain-pages.json (a human may be mid-edit)', async () => {
    const existingExplain = { approved: true, projects: { 'aoi-amc': [{ title: '既有', note: 'n', images: [] }] } };
    const { fs, files } = fakeFs({
      [`${PPTX_DIR}/projects.json`]: JSON.stringify(ONE_PROJECT_REGISTRY),
      [`${PPTX_DIR}/weeks/2026-W01/explain-pages.json`]: JSON.stringify(existingExplain),
    });
    await prepareWeekly(db, { week: '2026-W01', llm: false }, { fs, now: FIXED_NOW });
    const explain = JSON.parse(files.get(`${PPTX_DIR}/weeks/2026-W01/explain-pages.json`)!);
    expect(explain).toEqual(existingExplain);
  });

  it('backs up an existing deck-spec.json to .bak before overwriting, with a warning', async () => {
    const priorDraft = '{"note":"human was mid-edit"}';
    const { fs, files } = fakeFs({
      [`${PPTX_DIR}/projects.json`]: JSON.stringify(ONE_PROJECT_REGISTRY),
      [`${PPTX_DIR}/weeks/2026-W01/deck-spec.json`]: priorDraft,
    });
    const result = await prepareWeekly(db, { week: '2026-W01', llm: false }, { fs, now: FIXED_NOW });
    expect(files.get(`${PPTX_DIR}/weeks/2026-W01/deck-spec.json.bak`)).toBe(priorDraft);
    const newSpec = JSON.parse(files.get(`${PPTX_DIR}/weeks/2026-W01/deck-spec.json`)!);
    expect(newSpec.week).toBe('2026-W01'); // freshly assembled, not the stale draft
    expect(result!.warnings.some((w) => w.includes('.bak'))).toBe(true);
  });

  it('a live WP fetch pins the resolved project id back into projects.json', async () => {
    createSource(db, { kind: 'openproject', uri: 'http://example/openproject', config: { op_repo: '/fake/op-repo' } });
    const dataExec: OpDataExec = async (_bin, args) => {
      if (args.includes('--list-projects')) return JSON.stringify({ id: 42, name: 'AOI 專案', identifier: 'aoi' });
      return JSON.stringify({ id: 1001, subject: '測試 WP', status: '進行中', is_closed: false });
    };
    const { fs, files } = fakeFs({
      [`${PPTX_DIR}/projects.json`]: JSON.stringify(ONE_PROJECT_REGISTRY),
    });
    await prepareWeekly(db, { week: '2026-W01', llm: false }, { fs, now: FIXED_NOW, dataExec });

    const wpSnapshot = JSON.parse(files.get(`${PPTX_DIR}/weeks/2026-W01/workpackages/aoi-amc.json`)!);
    expect(wpSnapshot).toHaveLength(1);
    expect(wpSnapshot[0].id).toBe(1001);

    const registry = JSON.parse(files.get(`${PPTX_DIR}/projects.json`)!);
    expect(registry.projects[0].op_project_id).toBe(42);
  });

  it('current_index override seam (--current key=idx) reaches assembleDeckSpec', async () => {
    const registryWithRoadmap = {
      ...ONE_PROJECT_REGISTRY,
    };
    const { fs, files } = fakeFs({
      [`${PPTX_DIR}/projects.json`]: JSON.stringify(registryWithRoadmap),
      [`${PPTX_DIR}/projects/aoi-amc/roadmap.json`]: JSON.stringify({
        checkpoints: [
          { label: 'a', date: '24/01' },
          { label: 'b', date: '24/02' },
          { label: 'c', date: '24/03' },
        ],
      }),
    });
    const result = await prepareWeekly(db, { week: '2026-W01', currentOverrides: { 'aoi-amc': 2 }, llm: false }, { fs, now: FIXED_NOW });
    const spec = JSON.parse(files.get(result!.specPath)!) as DeckSpec;
    expect(spec.projects[0]?.roadmap.current_index).toBe(2);
  });
});

describe('weekly.ts: renderWeekly', () => {
  function fixedSpec(overrides: Partial<DeckSpec['projects'][0]> = {}): DeckSpec {
    return {
      version: 1,
      week: '2026-W02',
      summary: { rows: [{ pillar: 'AMC', project: 'AOI 專案', fab_line: 'Fab1/LineA', status_items: [] }] },
      projects: [
        {
          key: 'aoi-amc',
          pillar: 'AMC',
          fab: 'Fab1',
          name: 'AOI 專案',
          roadmap: { checkpoints: [], current_index: 0 },
          status_items: [{ text: 'A案已導入', color: 'blue' }],
          explain_pages: [],
          ...overrides,
        },
      ],
    };
  }

  const PREV_SPEC: DeckSpec = {
    version: 1,
    week: '2026-W01',
    summary: { rows: [] },
    projects: [
      {
        key: 'aoi-amc',
        pillar: 'AMC',
        fab: 'Fab1',
        name: 'AOI 專案',
        roadmap: { checkpoints: [], current_index: 0 },
        status_items: [{ text: 'A案已導入', color: 'black' }],
        explain_pages: [],
      },
    ],
  };

  function fakeRenderExec(capture: { stdin?: string } = {}): PptxRenderExec {
    return async (_bin, _args, stdinData) => {
      capture.stdin = stdinData;
      return JSON.stringify({ output: `${PPTX_DIR}/weeks/2026-W02/weekly-2026-07-13.pptx`, slides: 3, warnings: [] });
    };
  }

  it('missing deck-spec.json -> null ("run prepare first")', async () => {
    const { fs } = fakeFs();
    const result = await renderWeekly(db, { week: '2026-W02' }, { fs, now: FIXED_NOW });
    expect(result).toBeNull();
  });

  it('unapproved explain-pages.json -> all explain pages dropped + warning, deck still renders', async () => {
    const capture: { stdin?: string } = {};
    const { fs, files } = fakeFs({
      [`${PPTX_DIR}/weeks/2026-W02/deck-spec.json`]: JSON.stringify(fixedSpec()),
      [`${PPTX_DIR}/weeks/2026-W02/explain-pages.json`]: JSON.stringify({
        approved: false,
        projects: { 'aoi-amc': [{ title: '有內容但未批准', note: 'n', images: [] }] },
      }),
    });
    const result = await renderWeekly(db, { week: '2026-W02' }, { fs, now: FIXED_NOW, renderExec: fakeRenderExec(capture) });
    expect(result).not.toBeNull();
    expect(result!.warnings.some((w) => w.includes('not approved'))).toBe(true);

    const sentSpec = JSON.parse(capture.stdin!) as DeckSpec;
    expect(sentSpec.projects[0]?.explain_pages).toEqual([]);

    const written = JSON.parse(files.get(`${PPTX_DIR}/weeks/2026-W02/deck-spec.json`)!) as DeckSpec;
    expect(written.projects[0]?.explain_pages).toEqual([]);
  });

  it('approved + image exists -> explain page kept; approved + missing image -> that page dropped + warning', async () => {
    const { fs, files } = fakeFs({
      [`${PPTX_DIR}/weeks/2026-W02/deck-spec.json`]: JSON.stringify(fixedSpec()),
      [`${PPTX_DIR}/weeks/2026-W02/explain-pages.json`]: JSON.stringify({
        approved: true,
        projects: {
          'aoi-amc': [
            { title: '有圖', note: 'n1', images: [{ path: '/tmp/exists.png' }] },
            { title: '缺圖', note: 'n2', images: [{ path: '/tmp/missing.png' }] },
          ],
        },
      }),
      '/tmp/exists.png': 'fake-png-bytes',
    });
    const result = await renderWeekly(db, { week: '2026-W02' }, { fs, now: FIXED_NOW, renderExec: fakeRenderExec() });
    expect(result).not.toBeNull();
    expect(result!.warnings.some((w) => w.includes('缺圖') && w.includes('missing image'))).toBe(true);

    const written = JSON.parse(files.get(`${PPTX_DIR}/weeks/2026-W02/deck-spec.json`)!) as DeckSpec;
    expect(written.projects[0]?.explain_pages).toHaveLength(1);
    expect(written.projects[0]?.explain_pages[0]?.title).toBe('有圖');
  });

  it('re-colors deterministically against prevSpec after a manual text edit, and preserves a manual "color":"red" as a highlight', async () => {
    const editedSpec = fixedSpec({
      status_items: [
        { text: 'A案已導入', color: 'blue' }, // unchanged text, stored color is stale -> must recompute to black
        { text: '手動標記重點', color: 'red' }, // brand-new text but manually marked red -> stays red
      ],
    });
    const { fs, files } = fakeFs({
      [`${PPTX_DIR}/weeks/2026-W01/deck-spec.json`]: JSON.stringify(PREV_SPEC),
      [`${PPTX_DIR}/weeks/2026-W02/deck-spec.json`]: JSON.stringify(editedSpec),
    });
    const result = await renderWeekly(db, { week: '2026-W02' }, { fs, now: FIXED_NOW, renderExec: fakeRenderExec() });
    expect(result).not.toBeNull();

    const written = JSON.parse(files.get(`${PPTX_DIR}/weeks/2026-W02/deck-spec.json`)!) as DeckSpec;
    expect(written.projects[0]?.status_items).toEqual([
      { text: 'A案已導入', color: 'black' },
      { text: '手動標記重點', color: 'red' },
    ]);
  });

  it('writes back the final (actually shipped) deck-spec.json after a successful render', async () => {
    const { fs, files } = fakeFs({
      [`${PPTX_DIR}/weeks/2026-W02/deck-spec.json`]: JSON.stringify(fixedSpec()),
    });
    const result = await renderWeekly(db, { week: '2026-W02' }, { fs, now: FIXED_NOW, renderExec: fakeRenderExec() });
    expect(result).toEqual({ output: `${PPTX_DIR}/weeks/2026-W02/weekly-2026-07-13.pptx`, slides: 3, warnings: expect.any(Array) });

    const written = JSON.parse(files.get(`${PPTX_DIR}/weeks/2026-W02/deck-spec.json`)!) as DeckSpec;
    expect(written.week).toBe('2026-W02');
  });

  it('render failure (renderExec rejects) -> null, deck-spec.json left untouched', async () => {
    const original = JSON.stringify(fixedSpec());
    const { fs, files } = fakeFs({ [`${PPTX_DIR}/weeks/2026-W02/deck-spec.json`]: original });
    const failingExec: PptxRenderExec = async () => {
      throw new Error('spawn ENOENT');
    };
    const result = await renderWeekly(db, { week: '2026-W02' }, { fs, now: FIXED_NOW, renderExec: failingExec });
    expect(result).toBeNull();
    expect(files.get(`${PPTX_DIR}/weeks/2026-W02/deck-spec.json`)).toBe(original);
  });
});

describe('weekly.ts: T3 LLM status generation', () => {
  const PREV_SPEC_BLACK: DeckSpec = {
    version: 1,
    week: '2026-W01',
    summary: { rows: [] },
    projects: [
      {
        key: 'aoi-amc',
        pillar: 'AMC',
        fab: 'Fab1',
        name: 'AOI 專案',
        roadmap: { checkpoints: [], current_index: 0 },
        status_items: [{ text: 'A案已導入', color: 'black' }],
        explain_pages: [],
      },
    ],
  };

  function oneWp(overrides: Record<string, unknown> = {}) {
    return { id: 1001, subject: '良率驗證', status: '進行中', is_closed: false, updated_at: '2026-07-10T00:00:00Z', ...overrides };
  }

  it('llm:false (--no-llm) never calls contentExec even when injected — matches T2 exactly', async () => {
    createSource(db, { kind: 'openproject', uri: 'http://example/openproject', config: { op_repo: '/fake/op-repo' } });
    const { exec, calls } = dispatchExec({ generate: () => JSON.stringify({ items: [{ text: '不應該被呼叫' }] }) });
    const { fs } = fakeFs({ [`${PPTX_DIR}/projects.json`]: JSON.stringify(ONE_PROJECT_REGISTRY) });
    const result = await prepareWeekly(
      db,
      { week: '2026-W02', llm: false },
      { fs, now: FIXED_NOW, dataExec: liveWpDataExec([oneWp()]), contentExec: exec },
    );
    expect(result).not.toBeNull();
    expect(calls.generate).toBe(0);
    expect(calls.polish).toBe(0);
    expect(calls.judge).toBe(0);
  });

  it('LLM candidate whose text differs from last week flows through the diff pipeline as blue, sources intact', async () => {
    setSetting(db, 'report_pptx_judge', 'false'); // isolate diff-coloring from the quality loop
    createSource(db, { kind: 'openproject', uri: 'http://example/openproject', config: { op_repo: '/fake/op-repo' } });
    const { exec } = dispatchExec({
      generate: () => JSON.stringify({ items: [{ text: '良率驗證完成，達標 98.5%', sources: [{ wp: 1001 }] }] }),
    });
    const { fs, files } = fakeFs({
      [`${PPTX_DIR}/projects.json`]: JSON.stringify(ONE_PROJECT_REGISTRY),
      [`${PPTX_DIR}/weeks/2026-W01/deck-spec.json`]: JSON.stringify(PREV_SPEC_BLACK),
    });
    const result = await prepareWeekly(db, { week: '2026-W02' }, { fs, now: FIXED_NOW, dataExec: liveWpDataExec([oneWp()]), contentExec: exec });
    expect(result).not.toBeNull();
    const spec = JSON.parse(files.get(result!.specPath)!) as DeckSpec;
    expect(spec.projects[0]?.status_items).toEqual([{ text: '良率驗證完成，達標 98.5%', color: 'blue', sources: [{ wp: 1001 }] }]);
  });

  it('LLM candidate whose text matches last week normalizes to black (continuation, not "new")', async () => {
    setSetting(db, 'report_pptx_judge', 'false');
    createSource(db, { kind: 'openproject', uri: 'http://example/openproject', config: { op_repo: '/fake/op-repo' } });
    const { exec } = dispatchExec({ generate: () => JSON.stringify({ items: [{ text: 'A案已導入' }] }) });
    const { fs, files } = fakeFs({
      [`${PPTX_DIR}/projects.json`]: JSON.stringify(ONE_PROJECT_REGISTRY),
      [`${PPTX_DIR}/weeks/2026-W01/deck-spec.json`]: JSON.stringify(PREV_SPEC_BLACK),
    });
    const result = await prepareWeekly(db, { week: '2026-W02' }, { fs, now: FIXED_NOW, dataExec: liveWpDataExec([oneWp()]), contentExec: exec });
    const spec = JSON.parse(files.get(result!.specPath)!) as DeckSpec;
    expect(spec.projects[0]?.status_items).toEqual([{ text: 'A案已導入', color: 'black' }]);
  });

  it('polish rewriting text back to last week\'s wording recolors it black on re-diff (polish output wins over the raw generate output)', async () => {
    setSetting(db, 'report_pptx_judge', 'false');
    createSource(db, { kind: 'openproject', uri: 'http://example/openproject', config: { op_repo: '/fake/op-repo' } });
    const { exec, calls } = dispatchExec({
      generate: () => JSON.stringify({ items: [{ text: 'A案 已經 導入了（措辭不同）' }] }),
      polish: () => JSON.stringify({ items: [{ text: 'A案已導入' }] }),
    });
    const { fs, files } = fakeFs({
      [`${PPTX_DIR}/projects.json`]: JSON.stringify(ONE_PROJECT_REGISTRY),
      [`${PPTX_DIR}/weeks/2026-W01/deck-spec.json`]: JSON.stringify(PREV_SPEC_BLACK),
    });
    const result = await prepareWeekly(db, { week: '2026-W02' }, { fs, now: FIXED_NOW, dataExec: liveWpDataExec([oneWp()]), contentExec: exec });
    const spec = JSON.parse(files.get(result!.specPath)!) as DeckSpec;
    expect(spec.projects[0]?.status_items).toEqual([{ text: 'A案已導入', color: 'black' }]);
    expect(calls.polish).toBe(1);
  });

  it('polish exec failure leaves the generated items untouched (still colors correctly)', async () => {
    setSetting(db, 'report_pptx_judge', 'false');
    createSource(db, { kind: 'openproject', uri: 'http://example/openproject', config: { op_repo: '/fake/op-repo' } });
    const { exec } = dispatchExec({
      generate: () => JSON.stringify({ items: [{ text: '全新項目內容' }] }),
      polish: () => null, // polish fails -> generated text passed through unchanged
    });
    const { fs, files } = fakeFs({ [`${PPTX_DIR}/projects.json`]: JSON.stringify(ONE_PROJECT_REGISTRY) });
    const result = await prepareWeekly(db, { week: '2026-W02' }, { fs, now: FIXED_NOW, dataExec: liveWpDataExec([oneWp()]), contentExec: exec });
    const spec = JSON.parse(files.get(result!.specPath)!) as DeckSpec;
    expect(spec.projects[0]?.status_items).toEqual([{ text: '全新項目內容', color: 'blue' }]);
  });

  it('quality loop: a failing judge triggers exactly one regenerate-with-feedback pass; still failing sets quality_flags + a warning', async () => {
    createSource(db, { kind: 'openproject', uri: 'http://example/openproject', config: { op_repo: '/fake/op-repo' } });
    const { exec, calls, prompts } = dispatchExec({
      generate: (_p, call) => JSON.stringify({ items: [{ text: call === 1 ? '第一次生成內容' : '第二次生成內容' }] }),
      judge: (_p, call) => JSON.stringify({ pass: false, score: 40, feedback: call === 1 ? '缺對策' : '仍缺對策' }),
    });
    const { fs, files } = fakeFs({ [`${PPTX_DIR}/projects.json`]: JSON.stringify(ONE_PROJECT_REGISTRY) });
    const result = await prepareWeekly(db, { week: '2026-W02' }, { fs, now: FIXED_NOW, dataExec: liveWpDataExec([oneWp()]), contentExec: exec });
    expect(result).not.toBeNull();
    expect(calls.generate).toBe(2);
    expect(calls.judge).toBe(2);
    expect(prompts.generate[1]).toContain('缺對策');

    const spec = JSON.parse(files.get(result!.specPath)!) as DeckSpec;
    expect(spec.projects[0]?.quality_flags).toEqual(['仍缺對策']);
    expect(result!.warnings.some((w) => w.includes('品質未達標'))).toBe(true);
  });

  it('judge returning garbage is an inconclusive pass — no regeneration, no quality_flags', async () => {
    createSource(db, { kind: 'openproject', uri: 'http://example/openproject', config: { op_repo: '/fake/op-repo' } });
    const { exec, calls } = dispatchExec({
      generate: () => JSON.stringify({ items: [{ text: '進度正常，如期交付' }] }),
      judge: () => 'not json at all',
    });
    const { fs, files } = fakeFs({ [`${PPTX_DIR}/projects.json`]: JSON.stringify(ONE_PROJECT_REGISTRY) });
    const result = await prepareWeekly(db, { week: '2026-W02' }, { fs, now: FIXED_NOW, dataExec: liveWpDataExec([oneWp()]), contentExec: exec });
    expect(calls.generate).toBe(1);
    expect(calls.judge).toBe(1);
    const spec = JSON.parse(files.get(result!.specPath)!) as DeckSpec;
    expect(spec.projects[0]?.quality_flags).toBeUndefined();
    expect(result!.warnings.some((w) => w.includes('品質未達標'))).toBe(false);
  });

  it('fallback chain: LLM fully unavailable -> prepare still completes, carries last week forward all-black, with a warning', async () => {
    createSource(db, { kind: 'openproject', uri: 'http://example/openproject', config: { op_repo: '/fake/op-repo' } });
    const { exec, calls } = dispatchExec({ generate: () => null });
    const { fs, files } = fakeFs({
      [`${PPTX_DIR}/projects.json`]: JSON.stringify(ONE_PROJECT_REGISTRY),
      [`${PPTX_DIR}/weeks/2026-W01/deck-spec.json`]: JSON.stringify(PREV_SPEC_BLACK),
    });
    const result = await prepareWeekly(db, { week: '2026-W02' }, { fs, now: FIXED_NOW, dataExec: liveWpDataExec([oneWp()]), contentExec: exec });
    expect(result).not.toBeNull();
    expect(calls.judge).toBe(0); // never reached — generate never used the LLM
    const spec = JSON.parse(files.get(result!.specPath)!) as DeckSpec;
    expect(spec.projects[0]?.status_items).toEqual([{ text: 'A案已導入', color: 'black' }]);
    expect(result!.warnings.some((w) => w.includes('aoi-amc') && w.includes('LLM status generation unavailable'))).toBe(true);
  });
});
