import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createSource } from '../knowledge/ingest/sources.js';
import { prepareWeekly, renderWeekly, type WeeklyDeps } from '../report/pptx/weekly.js';
import type { AssembleFs } from '../report/pptx/assemble.js';
import type { OpDataExec } from '../report/opdata.js';
import type { PptxRenderExec } from '../report/pptx/render.js';
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
    const result = await prepareWeekly(db, {}, { fs, now: FIXED_NOW });
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
    const result = await prepareWeekly(db, {}, { fs, now: FIXED_NOW });
    expect(result).toBeNull();
  });

  it('writes deck-spec.json, explain-pages.json skeleton, and a per-project workpackages/<key>.json', async () => {
    const { fs, files } = fakeFs({
      [`${PPTX_DIR}/projects.json`]: JSON.stringify(ONE_PROJECT_REGISTRY),
    });
    const result = await prepareWeekly(db, { week: '2026-W01' }, { fs, now: FIXED_NOW });
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
    await prepareWeekly(db, { week: '2026-W01' }, { fs, now: FIXED_NOW });
    const explain = JSON.parse(files.get(`${PPTX_DIR}/weeks/2026-W01/explain-pages.json`)!);
    expect(explain).toEqual(existingExplain);
  });

  it('backs up an existing deck-spec.json to .bak before overwriting, with a warning', async () => {
    const priorDraft = '{"note":"human was mid-edit"}';
    const { fs, files } = fakeFs({
      [`${PPTX_DIR}/projects.json`]: JSON.stringify(ONE_PROJECT_REGISTRY),
      [`${PPTX_DIR}/weeks/2026-W01/deck-spec.json`]: priorDraft,
    });
    const result = await prepareWeekly(db, { week: '2026-W01' }, { fs, now: FIXED_NOW });
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
    await prepareWeekly(db, { week: '2026-W01' }, { fs, now: FIXED_NOW, dataExec });

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
    const result = await prepareWeekly(db, { week: '2026-W01', currentOverrides: { 'aoi-amc': 2 } }, { fs, now: FIXED_NOW });
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
