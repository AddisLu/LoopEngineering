import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getSetting, getNum } from '../../db/index.js';
import { ENGINE_REPO_ROOT } from '../../config.js';
import type { DeckSpec } from './spec.js';

const execFileAsync = promisify(execFile);
const QA_TIMEOUT_MS = 120_000;

/** Injectable spawn of scripts/report_pptx.py's --render mode. Unlike
 * src/report/opdata.ts's execFile-based OpDataExec (see its lines ~20-23), this is
 * `spawn`-based: the deck spec is a large, Chinese-heavy JSON payload that goes over
 * stdin per --render's contract (`大量中文走stdin不走argv`), not as an argv string. */
export type PptxRenderExec = (pythonBin: string, args: string[], stdinData: string) => Promise<string>;

/** Injectable spawn for qaRender's soffice/pdftoppm calls -- no stdin needed. */
export type QaExec = (cmd: string, args: string[]) => Promise<string>;

export interface RenderDeckResult {
  output: string;
  slides: number;
  warnings: string[];
}

export interface QaRenderResult {
  pdf: string;
  images: string[];
}

/** pythonBin fallback chain: report_pptx_python -> ingest_openproject_python -> 'python3'
 * (the OpenProject connector's own python setting is a reasonable fallback since both
 * are stdlib-plus-one-package scripts meant to run under the same interpreter). */
export function resolvePythonBin(db: Database.Database): string {
  const explicit = getSetting(db, 'report_pptx_python');
  if (explicit && explicit.trim()) return explicit.trim();
  const fallback = getSetting(db, 'ingest_openproject_python');
  if (fallback && fallback.trim()) return fallback.trim();
  return 'python3';
}

/** Also used by `loop report pptx probe/validate` (src/cli.ts) so the default-path
 * resolution logic lives in exactly one place. */
export function resolveTemplatePath(db: Database.Database): string {
  const explicit = getSetting(db, 'report_pptx_template');
  if (explicit && explicit.trim()) return explicit.trim();
  return path.join(getSetting(db, 'report_pptx_dir') || '', 'template', 'fillready.pptx');
}

export function resolveManifestPath(db: Database.Database): string {
  const explicit = getSetting(db, 'report_pptx_manifest');
  if (explicit && explicit.trim()) return explicit.trim();
  return path.join(getSetting(db, 'report_pptx_dir') || '', 'template', 'manifest.json');
}

async function defaultRenderExec(pythonBin: string, args: string[], stdinData: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`report_pptx.py timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`report_pptx.py exited ${code}: ${stderr.trim().slice(0, 2000)}`));
        return;
      }
      resolve(stdout);
    });

    child.stdin.write(stdinData, 'utf8');
    child.stdin.end();
  });
}

/**
 * Renders a DeckSpec into a .pptx via scripts/report_pptx.py --render. Resolves
 * pythonBin/template/manifest from settings, spawns the script with the spec as JSON on
 * stdin, and parses the last stdout line as the result JSON ({output, slides,
 * warnings}). Any failure (spawn error, non-zero exit, unparseable output) is logged
 * and returns null -- never throws.
 */
export async function renderDeck(
  db: Database.Database,
  spec: DeckSpec,
  opts: { out: string },
  exec?: PptxRenderExec,
): Promise<RenderDeckResult | null> {
  const pythonBin = resolvePythonBin(db);
  const scriptPath = path.join(ENGINE_REPO_ROOT, 'scripts', 'report_pptx.py');
  const templatePath = resolveTemplatePath(db);
  const manifestPath = resolveManifestPath(db);
  const timeoutMs = getNum(db, 'report_pptx_timeout_ms', 120_000);
  const run: PptxRenderExec = exec ?? ((bin, args, stdinData) => defaultRenderExec(bin, args, stdinData, timeoutMs));

  const args = [scriptPath, '--render', '--template', templatePath, '--manifest', manifestPath, '--out', opts.out];

  try {
    const stdout = await run(pythonBin, args, JSON.stringify(spec));
    const lastLine = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .pop();
    if (!lastLine) {
      console.error('renderDeck: report_pptx.py produced no stdout');
      return null;
    }
    const parsed = JSON.parse(lastLine) as Record<string, unknown>;
    const output = typeof parsed.output === 'string' ? parsed.output : null;
    const slides = typeof parsed.slides === 'number' ? parsed.slides : null;
    if (output === null || slides === null) {
      console.error(`renderDeck: unexpected result shape from report_pptx.py: ${lastLine.slice(0, 500)}`);
      return null;
    }
    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.filter((w): w is string => typeof w === 'string') : [];
    return { output, slides, warnings };
  } catch (e) {
    console.error(`renderDeck: ${(e as Error).message}`);
    return null;
  }
}

async function defaultQaExec(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, { timeout: QA_TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 });
  return stdout;
}

/**
 * Visual QA pass: converts pptxPath to PDF via LibreOffice (soffice --headless), then
 * rasterizes each page to PNG via pdftoppm, under a `qa/` directory next to pptxPath.
 * Either tool being unavailable (not installed) or failing is logged to stderr and
 * returns null -- this is a best-effort visual check, never a hard failure.
 */
export async function qaRender(db: Database.Database, pptxPath: string, exec: QaExec = defaultQaExec): Promise<QaRenderResult | null> {
  const qaDir = path.join(path.dirname(pptxPath), 'qa');
  try {
    fs.mkdirSync(qaDir, { recursive: true });
  } catch (e) {
    console.error(`qaRender: could not create ${qaDir}: ${(e as Error).message}`);
    return null;
  }

  try {
    await exec('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', qaDir, pptxPath]);
  } catch (e) {
    console.error(`qaRender: soffice unavailable or failed -- ${(e as Error).message}`);
    return null;
  }

  const base = path.basename(pptxPath, path.extname(pptxPath));
  const pdfPath = path.join(qaDir, `${base}.pdf`);

  try {
    await exec('pdftoppm', ['-png', pdfPath, path.join(qaDir, base)]);
  } catch (e) {
    console.error(`qaRender: pdftoppm unavailable or failed -- ${(e as Error).message}`);
    return null;
  }

  let images: string[] = [];
  try {
    images = fs
      .readdirSync(qaDir)
      .filter((f) => f.startsWith(`${base}-`) && f.endsWith('.png'))
      .sort()
      .map((f) => path.join(qaDir, f));
  } catch {
    images = [];
  }

  return { pdf: pdfPath, images };
}
