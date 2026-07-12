import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting, getBool } from '../db/index.js';
import { DEFAULT_SETTINGS, ENGINE_REPO_ROOT } from '../config.js';
import { renderDeck, qaRender, type PptxRenderExec, type QaExec } from '../report/pptx/render.js';
import type { DeckSpec } from '../report/pptx/spec.js';

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => db.close());

const SAMPLE_SPEC: DeckSpec = {
  version: 1,
  week: '2026-W28',
  summary: { rows: [] },
  projects: [
    {
      key: 'aoi',
      pillar: 'AMC',
      fab: 'Fab1',
      name: '大型AOI',
      roadmap: { checkpoints: [], current_index: 0 },
      status_items: [{ text: '進度正常', color: 'black' }],
      explain_pages: [],
    },
  ],
};

const SCRIPT_PATH = path.join(ENGINE_REPO_ROOT, 'scripts', 'report_pptx.py');

// ---- renderDeck ----

describe('renderDeck: pythonBin resolution chain', () => {
  it('defaults to python3 when neither setting is configured', async () => {
    let seenBin = '';
    const exec: PptxRenderExec = async (bin) => {
      seenBin = bin;
      return JSON.stringify({ output: '/tmp/out.pptx', slides: 1, warnings: [] });
    };
    await renderDeck(db, SAMPLE_SPEC, { out: '/tmp/out.pptx' }, exec);
    expect(seenBin).toBe('python3');
  });

  it('falls back to ingest_openproject_python when report_pptx_python is empty', async () => {
    setSetting(db, 'ingest_openproject_python', 'python');
    let seenBin = '';
    const exec: PptxRenderExec = async (bin) => {
      seenBin = bin;
      return JSON.stringify({ output: '/tmp/out.pptx', slides: 1, warnings: [] });
    };
    await renderDeck(db, SAMPLE_SPEC, { out: '/tmp/out.pptx' }, exec);
    expect(seenBin).toBe('python');
  });

  it('prefers report_pptx_python over ingest_openproject_python', async () => {
    setSetting(db, 'ingest_openproject_python', 'python');
    setSetting(db, 'report_pptx_python', 'python3.8');
    let seenBin = '';
    const exec: PptxRenderExec = async (bin) => {
      seenBin = bin;
      return JSON.stringify({ output: '/tmp/out.pptx', slides: 1, warnings: [] });
    };
    await renderDeck(db, SAMPLE_SPEC, { out: '/tmp/out.pptx' }, exec);
    expect(seenBin).toBe('python3.8');
  });
});

describe('renderDeck: args + stdin', () => {
  it('passes the script path, --render/--template/--manifest/--out, and the spec JSON on stdin', async () => {
    let seenArgs: string[] = [];
    let seenStdin = '';
    const exec: PptxRenderExec = async (_bin, args, stdinData) => {
      seenArgs = args;
      seenStdin = stdinData;
      return JSON.stringify({ output: '/tmp/out.pptx', slides: 2, warnings: [] });
    };
    await renderDeck(db, SAMPLE_SPEC, { out: '/tmp/out.pptx' }, exec);

    expect(seenArgs[0]).toBe(SCRIPT_PATH);
    expect(seenArgs).toContain('--render');
    expect(seenArgs).toContain('--template');
    expect(seenArgs).toContain('--manifest');
    expect(seenArgs).toContain('--out');
    expect(seenArgs[seenArgs.indexOf('--out') + 1]).toBe('/tmp/out.pptx');

    const parsed = JSON.parse(seenStdin);
    expect(parsed).toEqual(SAMPLE_SPEC);
  });

  it('defaults template/manifest paths under <report_pptx_dir>/template/ when the settings are empty', async () => {
    setSetting(db, 'report_pptx_dir', '/data/report-pptx');
    let seenArgs: string[] = [];
    const exec: PptxRenderExec = async (_bin, args) => {
      seenArgs = args;
      return JSON.stringify({ output: '/tmp/out.pptx', slides: 1, warnings: [] });
    };
    await renderDeck(db, SAMPLE_SPEC, { out: '/tmp/out.pptx' }, exec);
    expect(seenArgs[seenArgs.indexOf('--template') + 1]).toBe(path.join('/data/report-pptx', 'template', 'fillready.pptx'));
    expect(seenArgs[seenArgs.indexOf('--manifest') + 1]).toBe(path.join('/data/report-pptx', 'template', 'manifest.json'));
  });

  it('uses report_pptx_template/report_pptx_manifest when explicitly set', async () => {
    setSetting(db, 'report_pptx_template', '/custom/fillready.pptx');
    setSetting(db, 'report_pptx_manifest', '/custom/manifest.json');
    let seenArgs: string[] = [];
    const exec: PptxRenderExec = async (_bin, args) => {
      seenArgs = args;
      return JSON.stringify({ output: '/tmp/out.pptx', slides: 1, warnings: [] });
    };
    await renderDeck(db, SAMPLE_SPEC, { out: '/tmp/out.pptx' }, exec);
    expect(seenArgs[seenArgs.indexOf('--template') + 1]).toBe('/custom/fillready.pptx');
    expect(seenArgs[seenArgs.indexOf('--manifest') + 1]).toBe('/custom/manifest.json');
  });
});

describe('renderDeck: result parsing + failure handling', () => {
  it('parses the last stdout line as the result JSON', async () => {
    const exec: PptxRenderExec = async () => 'some progress noise\n{"output": "/tmp/out.pptx", "slides": 3, "warnings": ["文字截斷"]}\n';
    const result = await renderDeck(db, SAMPLE_SPEC, { out: '/tmp/out.pptx' }, exec);
    expect(result).toEqual({ output: '/tmp/out.pptx', slides: 3, warnings: ['文字截斷'] });
  });

  it('returns null (never throws) when exec rejects', async () => {
    const exec: PptxRenderExec = async () => {
      throw new Error('spawn ENOENT');
    };
    await expect(renderDeck(db, SAMPLE_SPEC, { out: '/tmp/out.pptx' }, exec)).resolves.toBeNull();
  });

  it('returns null when stdout has no parseable JSON line', async () => {
    const exec: PptxRenderExec = async () => 'not json at all\n';
    await expect(renderDeck(db, SAMPLE_SPEC, { out: '/tmp/out.pptx' }, exec)).resolves.toBeNull();
  });

  it('returns null when stdout is empty', async () => {
    const exec: PptxRenderExec = async () => '';
    await expect(renderDeck(db, SAMPLE_SPEC, { out: '/tmp/out.pptx' }, exec)).resolves.toBeNull();
  });

  it('returns null when the result JSON is missing required fields', async () => {
    const exec: PptxRenderExec = async () => JSON.stringify({ output: '/tmp/out.pptx' }); // no slides
    await expect(renderDeck(db, SAMPLE_SPEC, { out: '/tmp/out.pptx' }, exec)).resolves.toBeNull();
  });
});

// ---- qaRender ----

describe('qaRender', () => {
  let tmpDir: string;
  let pptxPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-pptx-qa-test-'));
    pptxPath = path.join(tmpDir, 'weekly.pptx');
    fs.writeFileSync(pptxPath, 'not a real pptx, qaRender never reads its content');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('converts to PDF then PNGs, returning their paths under a qa/ dir next to the pptx', async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const exec: QaExec = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'pdftoppm') {
        const qaDir = path.join(tmpDir, 'qa');
        fs.writeFileSync(path.join(qaDir, 'weekly-1.png'), '');
        fs.writeFileSync(path.join(qaDir, 'weekly-2.png'), '');
      }
      return '';
    };

    const result = await qaRender(db, pptxPath, exec);
    expect(result).not.toBeNull();
    expect(result!.pdf).toBe(path.join(tmpDir, 'qa', 'weekly.pdf'));
    expect(result!.images).toEqual([path.join(tmpDir, 'qa', 'weekly-1.png'), path.join(tmpDir, 'qa', 'weekly-2.png')]);

    expect(calls[0]?.cmd).toBe('soffice');
    expect(calls[0]?.args).toContain('--headless');
    expect(calls[0]?.args).toContain(pptxPath);
    expect(calls[1]?.cmd).toBe('pdftoppm');
    expect(calls[1]?.args).toContain(path.join(tmpDir, 'qa', 'weekly.pdf'));
  });

  it('returns null (never throws) when soffice is unavailable', async () => {
    const exec: QaExec = async (cmd) => {
      if (cmd === 'soffice') throw new Error('spawn soffice ENOENT');
      return '';
    };
    await expect(qaRender(db, pptxPath, exec)).resolves.toBeNull();
  });

  it('returns null (never throws) when pdftoppm is unavailable', async () => {
    const exec: QaExec = async (cmd) => {
      if (cmd === 'pdftoppm') throw new Error('spawn pdftoppm ENOENT');
      return '';
    };
    await expect(qaRender(db, pptxPath, exec)).resolves.toBeNull();
  });
});

// ---- settings defaults ----

describe('report_pptx_* settings', () => {
  it('report_pptx_enabled defaults to false (zero behavior change)', () => {
    expect(DEFAULT_SETTINGS.report_pptx_enabled).toBe('false');
    expect(getBool(db, 'report_pptx_enabled', true)).toBe(false);
  });

  it('report_pptx_template/manifest/python default to empty string (fallback chains apply)', () => {
    expect(DEFAULT_SETTINGS.report_pptx_template).toBe('');
    expect(DEFAULT_SETTINGS.report_pptx_manifest).toBe('');
    expect(DEFAULT_SETTINGS.report_pptx_python).toBe('');
  });

  it('report_pptx_timeout_ms defaults to a positive number', () => {
    expect(Number(DEFAULT_SETTINGS.report_pptx_timeout_ms)).toBeGreaterThan(0);
  });
});
