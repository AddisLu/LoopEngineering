/**
 * 圖資比對: the software's answers against a dataset's ground truth, case by case. Pure — the runner
 * reads the files (src/checks/dataset.ts) and hands their text over, so every format is tested with
 * fixtures. The metric names are fixed (correct_rate, mismatches, missing, total, time_ms): nobody
 * ever has to guess what a 圖資回歸 reports.
 *
 * Formats (the answer file and the software's output may use different ones):
 * - json: {"<case>": "<label>"} (a label may also be a list, or an object with label + bbox), or
 *   [{image, label, bbox?}] with one entry per object; {"predictions": [...]} wrappers are unwrapped
 * - csv: image,label[,x,y,w,h] — one row per object, an optional header row names the columns
 * - labels: one .txt per image, YOLO lines `class cx cy w h` (a line with only a class = a label)
 * A case with an empty label (json null / "", a csv row with no label, an empty .txt) is a case with
 * no objects — e.g. a good part — and that is an answer, unlike a case that is absent (沒有輸出).
 */

export type ConcreteFormat = 'json' | 'csv' | 'labels';
/** x, y, w, h — any unit, as long as both sides use the same one (YOLO boxes stay normalized) */
export type BBox = [number, number, number, number];

export interface AnswerObject {
  label: string;
  bbox: BBox | null;
}

export interface AnswerCase {
  /** the case's name: the image name without folders or image extension (caseKey) */
  key: string;
  objects: AnswerObject[];
}

export interface ParsedAnswers {
  format: ConcreteFormat;
  /** keyed by caseKey(): image name without folders and image extension */
  cases: Map<string, AnswerCase>;
  /** entries that named no case or no label (reported, never guessed) */
  skipped: number;
}

export type AnswerInput = { format: 'json' | 'csv'; text: string } | { format: 'labels'; files: Record<string, string> };

export class CompareError extends Error {}

export interface CaseResult {
  case: string;
  expected: string;
  /** null = the software wrote nothing for this case */
  actual: string | null;
  ok: boolean;
  note: string;
}

export interface DatasetMetrics {
  correct_rate: number;
  mismatches: number;
  missing: number;
  total: number;
  time_ms: number;
}

export interface Comparison {
  cases: CaseResult[];
  metrics: DatasetMetrics;
  /** cases the output has but the answers do not */
  extra: string[];
}

export const DATASET_METRIC_NAMES = ['correct_rate', 'mismatches', 'missing', 'total', 'time_ms'] as const;
export const IOU_MIN = 0.5;

const IMAGE_EXT = /\.(png|jpe?g|bmp|tiff?|gif|webp|txt|json|raw|pgm|ppm|npy)$/i;
const KEY_FIELDS = ['image', 'file', 'filename', 'case', 'name', 'path', 'img'];
const LABEL_FIELDS = ['label', 'class', 'category', 'defect', 'type'];

/** 'images/val/img001.png' → 'img001': both sides are matched by image name. */
export function caseKey(name: string): string {
  const base = String(name).split(/[\\/]/).pop() ?? '';
  return base.replace(IMAGE_EXT, '').trim();
}

/** By extension: .json → json, .csv/.tsv → csv, .txt → labels; anything else is unknown. */
export function formatFromName(name: string): ConcreteFormat | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if (ext === 'json') return 'json';
  if (ext === 'csv' || ext === 'tsv') return 'csv';
  if (ext === 'txt') return 'labels';
  return null;
}

export function parseAnswers(input: AnswerInput): ParsedAnswers {
  if (input.format === 'labels') return parseLabels(input.files);
  return input.format === 'json' ? parseJson(input.text) : parseCsv(input.text);
}

class Builder {
  readonly cases = new Map<string, AnswerCase>();
  skipped = 0;
  /** register a case (objects may be empty: an answer of "nothing") */
  touch(name: string): AnswerCase | null {
    const k = caseKey(name);
    if (!k) return null;
    let c = this.cases.get(k);
    if (!c) {
      c = { key: k, objects: [] };
      this.cases.set(k, c);
    }
    return c;
  }
  done(format: ConcreteFormat): ParsedAnswers {
    return { format, cases: this.cases, skipped: this.skipped };
  }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return finite(n) ? n : null;
};

function bboxFrom(b: unknown): BBox | null {
  if (Array.isArray(b)) {
    const n = b.slice(0, 4).map(num);
    return n.length === 4 && n.every((x) => x !== null) && n[2]! >= 0 && n[3]! >= 0 ? (n as BBox) : null;
  }
  if (b && typeof b === 'object') {
    const o = b as Record<string, unknown>;
    const x = num(o.x) ?? num(o.left);
    const y = num(o.y) ?? num(o.top);
    const w = num(o.w) ?? num(o.width);
    const h = num(o.h) ?? num(o.height);
    if (x !== null && y !== null && w !== null && h !== null && w >= 0 && h >= 0) return [x, y, w, h];
    const x1 = num(o.x1);
    const y1 = num(o.y1);
    const x2 = num(o.x2);
    const y2 = num(o.y2);
    if (x1 !== null && y1 !== null && x2 !== null && y2 !== null && x2 >= x1 && y2 >= y1) return [x1, y1, x2 - x1, y2 - y1];
  }
  return null;
}

/** An object entry: its label (+ box). 'empty' = the entry says "no object"; null = unreadable. */
function objectFrom(o: Record<string, unknown>): AnswerObject | 'empty' | null {
  const field = LABEL_FIELDS.find((f) => f in o);
  if (!field) return null;
  const v = o[field];
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return 'empty';
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return null;
  const box = o.bbox ?? o.box ?? o.rect ?? (('x' in o || 'x1' in o) ? o : undefined);
  return { label: String(v).trim(), bbox: box === undefined ? null : bboxFrom(box) };
}

function parseJson(text: string): ParsedAnswers {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    throw new CompareError(`JSON 讀不懂：${(err as Error).message}`);
  }
  // {"predictions": [...]} and friends: a single array under one key is the list of entries
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const vals = Object.values(data as Record<string, unknown>);
    if (vals.length === 1 && Array.isArray(vals[0]) && vals[0].every((e) => e && typeof e === 'object' && !Array.isArray(e))) data = vals[0];
  }
  const b = new Builder();
  if (Array.isArray(data)) {
    for (const el of data) {
      if (!el || typeof el !== 'object' || Array.isArray(el)) {
        b.skipped++;
        continue;
      }
      const o = el as Record<string, unknown>;
      const keyField = KEY_FIELDS.find((f) => typeof o[f] === 'string' || typeof o[f] === 'number');
      const obj = objectFrom(o);
      const c = keyField && obj !== null ? b.touch(String(o[keyField])) : null;
      if (!c) {
        b.skipped++;
        continue;
      }
      if (obj !== 'empty' && obj) c.objects.push(obj);
    }
    return b.done('json');
  }
  if (!data || typeof data !== 'object') throw new CompareError('JSON 要是 {"案例": "標籤"} 或 [{"image": …, "label": …}] 的形式');
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    const c = b.touch(k);
    if (!c) {
      b.skipped++;
      continue;
    }
    const items = Array.isArray(v) ? v : [v];
    for (const it of items) {
      if (it === null || it === undefined || (typeof it === 'string' && it.trim() === '')) continue;
      if (typeof it === 'string' || typeof it === 'number' || typeof it === 'boolean') {
        c.objects.push({ label: String(it).trim(), bbox: null });
        continue;
      }
      const obj = it && typeof it === 'object' && !Array.isArray(it) ? objectFrom(it as Record<string, unknown>) : null;
      if (obj === null) b.skipped++;
      else if (obj !== 'empty') c.objects.push(obj);
    }
  }
  return b.done('json');
}

/** One CSV line; double quotes may wrap a field and "" is a quote inside one. */
function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"' && cur.trim() === '') {
      quoted = true;
      cur = '';
    } else if (ch === delim) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function parseCsv(text: string): ParsedAnswers {
  const lines = text
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '' && !l.trimStart().startsWith('#'));
  const b = new Builder();
  if (!lines.length) return b.done('csv');
  const first = lines[0]!;
  const delim = (first.match(/\t/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? '\t' : ',';
  let rows = lines.map((l) => splitLine(l, delim));
  const col = { key: 0, label: 1, x: 2, y: 3, w: 4, h: 5 };
  const head = rows[0]!.map((s) => s.toLowerCase());
  // a header row starts with an image column name, or names both an image and a label column
  if (KEY_FIELDS.includes(head[0] ?? '') || (head.some((h) => KEY_FIELDS.includes(h)) && head.some((h) => LABEL_FIELDS.includes(h)))) {
    const at = (names: string[], fallback: number) => {
      const i = head.findIndex((h) => names.includes(h));
      return i >= 0 ? i : fallback;
    };
    col.key = at(KEY_FIELDS, 0);
    col.label = at(LABEL_FIELDS, 1);
    col.x = at(['x', 'left', 'x1'], 2);
    col.y = at(['y', 'top', 'y1'], 3);
    col.w = at(['w', 'width'], 4);
    col.h = at(['h', 'height'], 5);
    rows = rows.slice(1);
  }
  for (const r of rows) {
    const c = b.touch(r[col.key] ?? '');
    if (!c) {
      b.skipped++;
      continue;
    }
    const label = (r[col.label] ?? '').trim();
    if (!label) continue; // a case with no objects
    const box = [r[col.x], r[col.y], r[col.w], r[col.h]].map((s) => num(s ?? ''));
    c.objects.push({ label, bbox: box.every((v) => v !== null) && box[2]! >= 0 && box[3]! >= 0 ? (box as BBox) : null });
  }
  return b.done('csv');
}

function parseLabels(files: Record<string, string>): ParsedAnswers {
  const b = new Builder();
  for (const name of Object.keys(files).sort()) {
    const base = name.split(/[\\/]/).pop() ?? name;
    if (!/\.txt$/i.test(base) || /^classes\.txt$/i.test(base)) continue;
    const c = b.touch(name);
    if (!c) {
      b.skipped++;
      continue;
    }
    for (const line of files[name]!.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const parts = t.split(/[\s,]+/);
      const nums = parts.slice(1, 5).map((s) => num(s));
      if (parts.length >= 5 && nums.every((v) => v !== null)) {
        const [cx, cy, w, h] = nums as number[];
        c.objects.push({ label: parts[0]!, bbox: [cx! - w! / 2, cy! - h! / 2, w!, h!] });
      } else {
        c.objects.push({ label: parts[0]!, bbox: null });
      }
    }
  }
  return b.done('labels');
}

// ---- comparison ----------------------------------------------------------------------------------

export function iou(a: BBox, b: BBox): number {
  const iw = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const ih = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const inter = iw * ih;
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const show = (objs: AnswerObject[]) => (objs.length ? objs.map((o) => o.label).join('、') : '（無）');

/**
 * One case: every expected object needs its own actual object with the same label (case-insensitive)
 * and, when both carry a box, IoU ≥ iouMin; nothing may be left over on either side. Pairs are
 * assigned best-IoU first, like the usual detection matcher.
 */
export function matchCase(exp: AnswerObject[], act: AnswerObject[], iouMin = IOU_MIN): { ok: boolean; note: string } {
  const pairs: Array<{ e: number; a: number; score: number }> = [];
  exp.forEach((e, ei) =>
    act.forEach((a, ai) => {
      if (!same(e.label, a.label)) return;
      const score = e.bbox && a.bbox ? iou(e.bbox, a.bbox) : 1;
      if (score >= iouMin) pairs.push({ e: ei, a: ai, score });
    }),
  );
  pairs.sort((x, y) => y.score - x.score);
  const usedE = new Set<number>();
  const usedA = new Set<number>();
  for (const p of pairs) {
    if (usedE.has(p.e) || usedA.has(p.a)) continue;
    usedE.add(p.e);
    usedA.add(p.a);
  }
  const lostE = exp.map((_, i) => i).filter((i) => !usedE.has(i));
  const lostA = new Set(act.map((_, i) => i).filter((i) => !usedA.has(i)));
  if (!lostE.length && !lostA.size) return { ok: true, note: '' };
  if (exp.length === 1 && act.length === 1 && !(exp[0]!.bbox && act[0]!.bbox && same(exp[0]!.label, act[0]!.label))) {
    return { ok: false, note: `期望 ${exp[0]!.label}，得到 ${act[0]!.label}` };
  }
  const notes: string[] = [];
  const missed: string[] = [];
  for (const ei of lostE) {
    const e = exp[ei]!;
    // the same label in the wrong place reads better as one note than as 少了 + 多了
    let near = -1;
    let bestIou = -1;
    for (const ai of lostA) {
      const a = act[ai]!;
      if (!same(e.label, a.label) || !e.bbox || !a.bbox) continue;
      const v = iou(e.bbox, a.bbox);
      if (v > bestIou) {
        bestIou = v;
        near = ai;
      }
    }
    if (near >= 0) {
      lostA.delete(near);
      notes.push(`${e.label} 位置不符（IoU ${bestIou.toFixed(2)}）`);
    } else missed.push(e.label);
  }
  if (missed.length) notes.push(`少了 ${missed.join('、')}`);
  if (lostA.size) notes.push(`多了 ${[...lostA].map((i) => act[i]!.label).join('、')}`);
  return { ok: false, note: notes.join('；') };
}

export function compareAnswers(expected: ParsedAnswers, actual: ParsedAnswers | null, opts: { time_ms: number; iouMin?: number }): Comparison {
  const cases: CaseResult[] = [];
  let correct = 0;
  let mismatches = 0;
  let missing = 0;
  for (const [k, e] of expected.cases) {
    const a = actual?.cases.get(k);
    if (!a) {
      missing++;
      cases.push({ case: e.key, expected: show(e.objects), actual: null, ok: false, note: '沒有輸出' });
      continue;
    }
    const m = matchCase(e.objects, a.objects, opts.iouMin ?? IOU_MIN);
    if (m.ok) correct++;
    else mismatches++;
    cases.push({ case: e.key, expected: show(e.objects), actual: show(a.objects), ok: m.ok, note: m.note });
  }
  const total = expected.cases.size;
  const extra = actual ? [...actual.cases.values()].filter((c) => !expected.cases.has(caseKey(c.key))).map((c) => c.key) : [];
  return {
    cases,
    extra,
    metrics: {
      correct_rate: total ? Number((correct / total).toFixed(6)) : 0,
      mismatches,
      missing,
      total,
      time_ms: Math.max(0, Math.round(opts.time_ms)),
    },
  };
}

/** The lines a person (and the resume context) reads above the LOOP_METRICS line. */
export function summarize(c: Comparison, maxRows = 10): string {
  const m = c.metrics;
  const correct = m.total - m.mismatches - m.missing;
  const lines = [`圖資比對：${correct}/${m.total} 正確（${(m.correct_rate * 100).toFixed(2)}%）；不符 ${m.mismatches}、沒有輸出 ${m.missing}`];
  const bad = c.cases.filter((r) => !r.ok);
  for (const r of bad.slice(0, maxRows)) lines.push(`- ${r.case}：${r.actual === null ? `期望 ${r.expected}，沒有輸出` : r.note || `期望 ${r.expected}，得到 ${r.actual}`}`);
  if (bad.length > maxRows) lines.push(`…還有 ${bad.length - maxRows} 個案例沒過`);
  if (c.extra.length) lines.push(`輸出裡另有 ${c.extra.length} 個答案檔沒有的案例（例如 ${c.extra.slice(0, 3).join('、')}），不計分`);
  return lines.join('\n');
}

/** The line extractMetrics (src/orchestrator/acceptance.ts) reads. */
export function metricsLine(values: Record<string, number>): string {
  return `LOOP_METRICS ${JSON.stringify(values)}`;
}
