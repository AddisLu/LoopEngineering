import fs from 'node:fs';
import path from 'node:path';
import { CompareError, formatFromName, parseAnswers, type AnswerInput, type ParsedAnswers } from './compare.js';
import type { AnswerFormat } from './datasets.js';

/**
 * The file side of 圖資比對: turning an answer file / label folder and whatever the software wrote
 * into {out} into the text compare.ts parses. Folders are read flat (one level), like a YOLO split.
 */

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_LABEL_FILES = 200_000;

function readText(p: string): string {
  const st = fs.statSync(p);
  if (st.size > MAX_BYTES) throw new CompareError(`檔案太大（${Math.round(st.size / 1024 / 1024)} MB）：${path.basename(p)}`);
  return fs.readFileSync(p, 'utf8');
}

/** Every `.txt` directly in `dir` except YOLO's classes.txt. */
export function readLabelDir(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.txt$/i.test(e.name) && !/^classes\.txt$/i.test(e.name))
    .map((e) => e.name)
    .sort();
  if (names.length > MAX_LABEL_FILES) throw new CompareError(`標記檔太多（${names.length} 個）`);
  for (const n of names) files[n] = readText(path.join(dir, n));
  return files;
}

/** The answer file (or label folder) of a dataset as compare.ts input; `format` from the 圖資 row. */
export function answerInput(p: string, format: AnswerFormat): AnswerInput {
  if (!fs.existsSync(p)) throw new CompareError(`找不到答案檔：${p}`);
  if (fs.statSync(p).isDirectory()) {
    if (format !== 'auto' && format !== 'labels') throw new CompareError(`答案檔是資料夾，但圖資的答案格式設成 ${format}`);
    return { format: 'labels', files: readLabelDir(p) };
  }
  const f = format === 'auto' ? formatFromName(p) : format;
  if (!f) throw new CompareError(`認不出答案檔的格式：${path.basename(p)}（.json／.csv，或一個放 .txt 標記的資料夾；也可以在圖資設定指定格式）`);
  if (f === 'labels') return { format: 'labels', files: { [path.basename(p)]: readText(p) } };
  return { format: f, text: readText(p) };
}

export function readAnswers(p: string, format: AnswerFormat): ParsedAnswers {
  return parseAnswers(answerInput(p, format));
}

const PREFERRED = /^(results?|predictions?|outputs?|answers?)\.(json|csv|tsv)$/i;
const pick = (names: string[]): string => (names.length === 1 ? names[0]! : (names.find((n) => PREFERRED.test(n)) ?? [...names].sort()[0]!));

/**
 * What the software wrote into {out}: a .json (preferred) or .csv at the top, else the .txt labels
 * at the top or in labels/. null when there is nothing to read (every case counts as 沒有輸出).
 * overlays/ (pictures for people) is never read as answers.
 */
export function findOutput(dir: string): { input: AnswerInput; source: string } | null {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'));
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  const jsons = files.filter((n) => /\.json$/i.test(n));
  const csvs = files.filter((n) => /\.(csv|tsv)$/i.test(n));
  if (jsons.length) {
    const n = pick(jsons);
    return { input: { format: 'json', text: readText(path.join(dir, n)) }, source: n };
  }
  if (csvs.length) {
    const n = pick(csvs);
    return { input: { format: 'csv', text: readText(path.join(dir, n)) }, source: n };
  }
  if (files.some((n) => /\.txt$/i.test(n) && !/^classes\.txt$/i.test(n))) return { input: { format: 'labels', files: readLabelDir(dir) }, source: '.' };
  const labels = path.join(dir, 'labels');
  if (fs.existsSync(labels) && fs.statSync(labels).isDirectory()) return { input: { format: 'labels', files: readLabelDir(labels) }, source: 'labels' };
  return null;
}

/** Relative paths under `dir` (for check_runs.artifacts_json), capped. */
export function listFiles(dir: string, cap = 500): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    if (out.length >= cap || !fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= cap) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  walk(dir, '');
  return out;
}

/**
 * pullBack() may land the remote folder itself or only its contents in localDir; either way this
 * returns where `name` (the remote basename) ended up.
 */
export function pulledPath(localDir: string, name: string): string {
  const inside = path.join(localDir, name);
  return fs.existsSync(inside) ? inside : localDir;
}
