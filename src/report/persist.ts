import fs from 'node:fs';
import path from 'node:path';
import type { OpWorkPackage, OpSnapshotItem } from './opdata.js';

export interface PersistChart {
  kind: string;
  mmd: string;
}

/** Injectable mkdir/writeFile (mirrors voice/transcribe.ts's buildMergedTermsFile) so
 * persistReport is hermetic — tests never touch the real filesystem. */
export interface PersistWriteFns {
  mkdir?: (dir: string) => void;
  writeFile?: (p: string, content: string) => void;
}

export interface PersistReportInput {
  outputDir: string;
  /** 專案識別 — folder-sanitized; falls back to a placeholder when blank. */
  project: string;
  /** Used for the dated subfolder name; falls back to a placeholder when blank. */
  topic: string;
  markdown: string;
  items: (OpWorkPackage | OpSnapshotItem)[];
  charts: PersistChart[];
}

export interface PersistReportResult {
  dir: string;
  files: string[];
}

/** Strip filesystem-unsafe characters so project/topic text can be used as directory
 * segments; collapses whitespace/dashes and caps length so deeply nested vaults stay
 * navigable. */
function slugify(s: string, fallback: string): string {
  const cleaned = s
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || fallback;
}

/**
 * Write a generated report's markdown + structured WP snapshot JSON + each chart's raw
 * Mermaid source to `<output_dir>/<project>/<YYYY-MM-DD-topic>/` — laid out so a user's
 * own git can track it by project, and files can be grabbed straight into a slide deck.
 * Pure write, never commits (that's left to the user's git). Never throws: a write
 * failure is logged and null returned so a persistence problem never breaks report
 * generation itself (see generate.ts's generateReport).
 */
export function persistReport(input: PersistReportInput, fns: PersistWriteFns = {}): PersistReportResult | null {
  const mkdir = fns.mkdir ?? ((d: string) => fs.mkdirSync(d, { recursive: true }));
  const writeFile = fns.writeFile ?? ((p: string, content: string) => fs.writeFileSync(p, content, 'utf8'));
  try {
    const today = new Date().toISOString().slice(0, 10);
    const projectSlug = slugify(input.project, '未分類專案');
    const topicSlug = slugify(input.topic, '報告');
    const dir = path.join(input.outputDir, projectSlug, `${today}-${topicSlug}`);
    mkdir(dir);

    const files: string[] = [];

    const mdPath = path.join(dir, 'report.md');
    writeFile(mdPath, input.markdown);
    files.push(mdPath);

    const snapshotPath = path.join(dir, 'workpackages.json');
    writeFile(snapshotPath, JSON.stringify(input.items, null, 2));
    files.push(snapshotPath);

    for (const chart of input.charts) {
      const chartPath = path.join(dir, `${chart.kind}.mmd`);
      writeFile(chartPath, chart.mmd);
      files.push(chartPath);
    }

    return { dir, files };
  } catch (err) {
    console.error('report persist failed:', err instanceof Error ? err.message : err);
    return null;
  }
}
