import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { buildApp } from '../server/app.js';
import type { AssembleFs } from '../report/pptx/assemble.js';
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
const FIXED_NOW = () => new Date('2026-07-13T00:00:00Z'); // Monday, ISO week 2026-W29

const ONE_PROJECT_REGISTRY = {
  version: 1,
  pillars: ['AMC'],
  projects: [{ key: 'aoi-amc', pillar: 'AMC', name: 'AOI 專案', fab: 'Fab1', fab_line: 'Fab1/LineA', enabled: true }],
};

function fixedSpec(overrides: Partial<DeckSpec['projects'][0]> = {}): DeckSpec {
  return {
    version: 1,
    week: '2026-W02',
    summary: { rows: [] },
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

function fakeRenderExec(): PptxRenderExec {
  return async () => JSON.stringify({ output: `${PPTX_DIR}/weeks/2026-W02/weekly-2026-07-13.pptx`, slides: 3, warnings: [] });
}

let db: Database.Database;
let app: FastifyInstance;
beforeEach(() => {
  db = openTestDb();
  setSetting(db, 'report_pptx_enabled', 'true');
  setSetting(db, 'report_pptx_dir', PPTX_DIR);
});
afterEach(async () => {
  await app?.close();
  db.close();
});

describe('report_pptx disabled — zero behavior change', () => {
  it('POST /api/report/weekly 404s when report_pptx_enabled is false', async () => {
    setSetting(db, 'report_pptx_enabled', 'false');
    app = buildApp({ db, apiToken: null });
    const res = await app.inject({ method: 'POST', url: '/api/report/weekly', payload: { stage: 'run' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/disabled/);
  });

  it('GET /api/report/weekly/:week 404s when report_pptx_enabled is false', async () => {
    setSetting(db, 'report_pptx_enabled', 'false');
    app = buildApp({ db, apiToken: null });
    const res = await app.inject({ method: 'GET', url: '/api/report/weekly/2026-W02' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toMatch(/disabled/);
  });
});

describe('POST /api/report/weekly — stage dispatch', () => {
  it('stage=prepare writes deck-spec/explain-pages and returns their paths + warnings', async () => {
    const { fs } = fakeFs({ [`${PPTX_DIR}/projects.json`]: JSON.stringify(ONE_PROJECT_REGISTRY) });
    app = buildApp({ db, apiToken: null, reportPptxFs: fs, reportPptxNow: FIXED_NOW });
    const res = await app.inject({
      method: 'POST',
      url: '/api/report/weekly',
      payload: { stage: 'prepare', week: '2026-W01', noLlm: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.specPath).toBe(`${PPTX_DIR}/weeks/2026-W01/deck-spec.json`);
    expect(body.explainPath).toBe(`${PPTX_DIR}/weeks/2026-W01/explain-pages.json`);
    expect(Array.isArray(body.warnings)).toBe(true);
    expect(body.qualityFlags).toEqual({});
  });

  it('stage=render renders an existing deck-spec and returns output/slides/qualityFlags', async () => {
    const { fs } = fakeFs({
      [`${PPTX_DIR}/weeks/2026-W02/deck-spec.json`]: JSON.stringify(fixedSpec()),
    });
    app = buildApp({ db, apiToken: null, reportPptxFs: fs, reportPptxRenderExec: fakeRenderExec(), reportPptxNow: FIXED_NOW });
    const res = await app.inject({
      method: 'POST',
      url: '/api/report/weekly',
      payload: { stage: 'render', week: '2026-W02' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.output).toBe(`${PPTX_DIR}/weeks/2026-W02/weekly-2026-07-13.pptx`);
    expect(body.slides).toBe(3);
    expect(body.qualityFlags).toEqual({});
  });

  it('stage=run (default) with injected deps: no existing spec -> prepares then renders, explain pages dropped (not approved)', async () => {
    const { fs } = fakeFs({ [`${PPTX_DIR}/projects.json`]: JSON.stringify(ONE_PROJECT_REGISTRY) });
    app = buildApp({ db, apiToken: null, reportPptxFs: fs, reportPptxRenderExec: fakeRenderExec(), reportPptxNow: FIXED_NOW });
    const res = await app.inject({
      method: 'POST',
      url: '/api/report/weekly',
      payload: { week: '2026-W01', noLlm: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.specPath).toBe(`${PPTX_DIR}/weeks/2026-W01/deck-spec.json`);
    expect(body.explainPath).toBe(`${PPTX_DIR}/weeks/2026-W01/explain-pages.json`);
    expect(typeof body.output).toBe('string');
    expect(Array.isArray(body.warnings)).toBe(true);
  });

  it('stage=run with an already-approved explain-pages.json ships the approved explain pages (no prepare re-run)', async () => {
    const { fs } = fakeFs({
      [`${PPTX_DIR}/weeks/2026-W02/deck-spec.json`]: JSON.stringify(fixedSpec()),
      [`${PPTX_DIR}/weeks/2026-W02/explain-pages.json`]: JSON.stringify({
        approved: true,
        projects: { 'aoi-amc': [{ title: '已批准說明', note: 'n', images: [] }] },
      }),
    });
    app = buildApp({ db, apiToken: null, reportPptxFs: fs, reportPptxRenderExec: fakeRenderExec(), reportPptxNow: FIXED_NOW });
    const res = await app.inject({
      method: 'POST',
      url: '/api/report/weekly',
      payload: { stage: 'run', week: '2026-W02' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.specPath).toBeUndefined(); // spec already existed -> run went render-only
    expect(body.output).toBe(`${PPTX_DIR}/weeks/2026-W02/weekly-2026-07-13.pptx`);
  });

  it('a failing stage (e.g. missing registry for prepare) returns 500 with ok:false', async () => {
    const { fs } = fakeFs(); // no projects.json
    app = buildApp({ db, apiToken: null, reportPptxFs: fs, reportPptxNow: FIXED_NOW });
    const res = await app.inject({
      method: 'POST',
      url: '/api/report/weekly',
      payload: { stage: 'prepare', week: '2026-W01' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().ok).toBe(false);
  });

  it('responds within report_pptx_timeout_ms instead of hanging, and the render keeps running in the background', async () => {
    setSetting(db, 'report_pptx_timeout_ms', '20');
    const { fs } = fakeFs({
      [`${PPTX_DIR}/weeks/2026-W02/deck-spec.json`]: JSON.stringify(fixedSpec()),
    });
    const neverResolves: PptxRenderExec = () => new Promise(() => {});
    app = buildApp({ db, apiToken: null, reportPptxFs: fs, reportPptxRenderExec: neverResolves, reportPptxNow: FIXED_NOW });
    const started = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/api/report/weekly',
      payload: { stage: 'render', week: '2026-W02' },
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.statusCode).toBe(504);
    expect(res.json()).toEqual({ error: 'weekly report generation timed out', timedOut: true });
  });
});

describe('GET /api/report/weekly/:week', () => {
  it('a week with no deck-spec.json yet -> exists:false, approved:null, empty projects', async () => {
    const { fs } = fakeFs();
    app = buildApp({ db, apiToken: null, reportPptxFs: fs });
    const res = await app.inject({ method: 'GET', url: '/api/report/weekly/2026-W99' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      exists: false,
      files: {
        deckSpec: `${PPTX_DIR}/weeks/2026-W99/deck-spec.json`,
        explainPages: `${PPTX_DIR}/weeks/2026-W99/explain-pages.json`,
        output: null,
      },
      approved: null,
      projects: [],
    });
  });

  it('an existing week reports approved status, quality_flags and the rendered output path', async () => {
    const spec = fixedSpec({ quality_flags: ['缺對策'] });
    const { fs } = fakeFs({
      [`${PPTX_DIR}/weeks/2026-W02/deck-spec.json`]: JSON.stringify(spec),
      [`${PPTX_DIR}/weeks/2026-W02/explain-pages.json`]: JSON.stringify({ approved: true, projects: {} }),
      [`${PPTX_DIR}/weeks/2026-W02/weekly-2026-07-13.pptx`]: 'fake-pptx-bytes',
    });
    app = buildApp({ db, apiToken: null, reportPptxFs: fs });
    const res = await app.inject({ method: 'GET', url: '/api/report/weekly/2026-W02' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.exists).toBe(true);
    expect(body.approved).toBe(true);
    expect(body.files.output).toBe(`${PPTX_DIR}/weeks/2026-W02/weekly-2026-07-13.pptx`);
    expect(body.projects).toEqual([
      { key: 'aoi-amc', statusCount: 1, explainCount: 0, qualityFlags: ['缺對策'] },
    ]);
  });
});
