import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  caseKey,
  compareAnswers,
  CompareError,
  formatFromName,
  iou,
  matchCase,
  metricsLine,
  parseAnswers,
  summarize,
  type ParsedAnswers,
} from '../checks/compare.js';
import { answerInput, findOutput, listFiles, pulledPath, readAnswers } from '../checks/dataset.js';
import { extractMetrics } from '../orchestrator/acceptance.js';

let tmp: string[] = [];
afterEach(() => {
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp = [];
});
function dir(files: Record<string, string>): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-compare-'));
  tmp.push(d);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true });
    fs.writeFileSync(path.join(d, rel), text);
  }
  return d;
}

const labelsOf = (p: ParsedAnswers) => Object.fromEntries([...p.cases].map(([k, c]) => [k, c.objects.map((o) => o.label)]));

// ---- fixtures: one small AOI-like set in every format ----
const ANSWERS_MAP = JSON.stringify({ 'img001.png': 'OK', 'img002.png': 'scratch', 'img003.png': 'dent', 'img004.png': 'OK' });
const ANSWERS_ROWS = JSON.stringify([
  { image: 'images/a.png', label: 'scratch', bbox: [10, 10, 20, 20] },
  { image: 'images/a.png', label: 'dent', bbox: { x: 50, y: 50, w: 10, h: 10 } },
  { image: 'images/b.png', label: null },
  { file: 'c.png', class: 'scratch', x1: 0, y1: 0, x2: 10, y2: 10 },
  { label: 'orphan' },
]);
const ANSWERS_CSV = 'image,label,x,y,w,h\nimages/a.png,scratch,10,10,20,20\n"images/b.png",,,,,\nc.png,"scr,atch",0,0,10,10\n# comment\n\n';
const YOLO = {
  'a.txt': '0 0.5 0.5 0.2 0.2\n1 0.1 0.1 0.05 0.05 0.93\n',
  'b.txt': '',
  'c.txt': '2\n',
  'classes.txt': 'scratch\ndent\nstain\n',
};

describe('parseAnswers', () => {
  it('json map: case → label (lists and objects too), keys without folders or image extension', () => {
    const p = parseAnswers({ format: 'json', text: ANSWERS_MAP });
    expect(p.format).toBe('json');
    expect(labelsOf(p)).toEqual({ img001: ['OK'], img002: ['scratch'], img003: ['dent'], img004: ['OK'] });
    const q = parseAnswers({ format: 'json', text: '\uFEFF{"x.jpg": ["scratch", {"label": "dent", "bbox": [1,2,3,4]}], "y": null, "z": ""}' });
    expect(labelsOf(q)).toEqual({ x: ['scratch', 'dent'], y: [], z: [] });
    expect(q.cases.get('x')!.objects[1]!.bbox).toEqual([1, 2, 3, 4]);
  });

  it('json rows: [{image, label, bbox?}] (x/y/w/h, x1..y2), an empty label is a case with nothing, unnamed rows are skipped', () => {
    const p = parseAnswers({ format: 'json', text: ANSWERS_ROWS });
    expect(labelsOf(p)).toEqual({ a: ['scratch', 'dent'], b: [], c: ['scratch'] });
    expect(p.cases.get('a')!.objects.map((o) => o.bbox)).toEqual([[10, 10, 20, 20], [50, 50, 10, 10]]);
    expect(p.cases.get('c')!.objects[0]!.bbox).toEqual([0, 0, 10, 10]);
    expect(p.skipped).toBe(1);
    const wrapped = parseAnswers({ format: 'json', text: JSON.stringify({ predictions: [{ image: 'a.png', label: 'x' }] }) });
    expect(labelsOf(wrapped)).toEqual({ a: ['x'] });
  });

  it('csv: header names the columns, quoted fields, empty label = nothing, tab-separated works too', () => {
    const p = parseAnswers({ format: 'csv', text: ANSWERS_CSV });
    expect(labelsOf(p)).toEqual({ a: ['scratch'], b: [], c: ['scr,atch'] });
    expect(p.cases.get('a')!.objects[0]!.bbox).toEqual([10, 10, 20, 20]);
    const noHeader = parseAnswers({ format: 'csv', text: 'img1.png,OK\r\nimg2.png,NG\r\n' });
    expect(labelsOf(noHeader)).toEqual({ img1: ['OK'], img2: ['NG'] });
    const reordered = parseAnswers({ format: 'csv', text: 'class\tfile\nNG\timg9.bmp\n' });
    expect(labelsOf(reordered)).toEqual({ img9: ['NG'] });
  });

  it('labels: one YOLO .txt per image (center boxes → corner boxes), classes.txt ignored, an empty file = nothing', () => {
    const p = parseAnswers({ format: 'labels', files: YOLO });
    expect(labelsOf(p)).toEqual({ a: ['0', '1'], b: [], c: ['2'] });
    const box = p.cases.get('a')!.objects[0]!.bbox!;
    expect(box.map((v) => Number(v.toFixed(6)))).toEqual([0.4, 0.4, 0.2, 0.2]);
    expect(p.cases.get('c')!.objects[0]!.bbox).toBeNull();
  });

  it('unreadable JSON is an error, not an empty answer set', () => {
    expect(() => parseAnswers({ format: 'json', text: '{nope' })).toThrow(CompareError);
    expect(() => parseAnswers({ format: 'json', text: '42' })).toThrow(CompareError);
  });

  it('helpers: caseKey, formatFromName, iou', () => {
    expect(caseKey('images/val/img001.PNG')).toBe('img001');
    expect(caseKey('C:\\data\\x.tif')).toBe('x');
    expect(caseKey('sample.001')).toBe('sample.001');
    expect(formatFromName('answers.JSON')).toBe('json');
    expect(formatFromName('gt.tsv')).toBe('csv');
    expect(formatFromName('a.txt')).toBe('labels');
    expect(formatFromName('answers.xml')).toBeNull();
    expect(iou([0, 0, 10, 10], [0, 0, 10, 10])).toBe(1);
    expect(iou([0, 0, 10, 10], [5, 0, 10, 10])).toBeCloseTo(50 / 150);
    expect(iou([0, 0, 10, 10], [20, 20, 5, 5])).toBe(0);
  });
});

describe('matchCase', () => {
  it('labels only: case-insensitive equality, multisets must match exactly', () => {
    expect(matchCase([{ label: 'OK', bbox: null }], [{ label: 'ok ', bbox: null }]).ok).toBe(true);
    expect(matchCase([{ label: 'OK', bbox: null }], [{ label: 'NG', bbox: null }])).toEqual({ ok: false, note: '期望 OK，得到 NG' });
    expect(matchCase([], [])).toEqual({ ok: true, note: '' });
    expect(matchCase([], [{ label: 'dent', bbox: null }])).toEqual({ ok: false, note: '多了 dent' });
    expect(matchCase([{ label: 'dent', bbox: null }, { label: 'dent', bbox: null }], [{ label: 'dent', bbox: null }])).toEqual({ ok: false, note: '少了 dent' });
  });

  it('with boxes on both sides IoU ≥ 0.5 is required; best pairs are matched first', () => {
    const e = [{ label: 'scratch', bbox: [0, 0, 10, 10] as [number, number, number, number] }];
    expect(matchCase(e, [{ label: 'scratch', bbox: [1, 1, 10, 10] }]).ok).toBe(true); // IoU 0.68
    const off = matchCase(e, [{ label: 'scratch', bbox: [6, 0, 10, 10] }]); // IoU 0.25
    expect(off.ok).toBe(false);
    expect(off.note).toBe('scratch 位置不符（IoU 0.25）');
    // a box on one side only: the label decides
    expect(matchCase(e, [{ label: 'scratch', bbox: null }]).ok).toBe(true);
    const two = [
      { label: 's', bbox: [0, 0, 10, 10] as [number, number, number, number] },
      { label: 's', bbox: [100, 100, 10, 10] as [number, number, number, number] },
    ];
    expect(matchCase(two, [{ label: 's', bbox: [100, 101, 10, 10] }, { label: 's', bbox: [0, 1, 10, 10] }]).ok).toBe(true);
    expect(matchCase(two, [{ label: 's', bbox: [0, 1, 10, 10] }, { label: 'x', bbox: [200, 200, 1, 1] }]).note).toBe('少了 s；多了 x');
  });
});

describe('compareAnswers', () => {
  it('correct / mismatched / missing per case, fixed metric names, extra cases do not count', () => {
    const exp = parseAnswers({ format: 'json', text: ANSWERS_MAP });
    const act = parseAnswers({ format: 'csv', text: 'image,label\nimg001.png,OK\nimg002.png,OK\nimg004.jpg,ok\nimg999.png,dent\n' });
    const c = compareAnswers(exp, act, { time_ms: 5123.4 });
    expect(c.metrics).toEqual({ correct_rate: 0.5, mismatches: 1, missing: 1, total: 4, time_ms: 5123 });
    expect(c.cases).toEqual([
      { case: 'img001', expected: 'OK', actual: 'OK', ok: true, note: '' },
      { case: 'img002', expected: 'scratch', actual: 'OK', ok: false, note: '期望 scratch，得到 OK' },
      { case: 'img003', expected: 'dent', actual: null, ok: false, note: '沒有輸出' },
      { case: 'img004', expected: 'OK', actual: 'ok', ok: true, note: '' },
    ]);
    expect(c.extra).toEqual(['img999']);
    const text = summarize(c);
    expect(text).toContain('圖資比對：2/4 正確（50.00%）；不符 1、沒有輸出 1');
    expect(text).toContain('- img002：期望 scratch，得到 OK');
    expect(text).toContain('- img003：期望 dent，沒有輸出');
    expect(text).toContain('另有 1 個');
    const line = metricsLine({ ...c.metrics });
    expect(extractMetrics([`noise\n${line}\n`])).toEqual(c.metrics);
  });

  it('no output at all: every case is missing; an empty answer set rates 0', () => {
    const exp = parseAnswers({ format: 'labels', files: YOLO });
    const c = compareAnswers(exp, null, { time_ms: 10 });
    expect(c.metrics).toEqual({ correct_rate: 0, mismatches: 0, missing: 3, total: 3, time_ms: 10 });
    expect(compareAnswers(parseAnswers({ format: 'json', text: '{}' }), null, { time_ms: 0 }).metrics.correct_rate).toBe(0);
  });

  it('detections: YOLO answers against a JSON output in the same normalized units', () => {
    const exp = parseAnswers({ format: 'labels', files: { 'a.txt': '0 0.5 0.5 0.2 0.2\n', 'b.txt': '' } });
    const act = parseAnswers({
      format: 'json',
      text: JSON.stringify([
        { image: 'a.png', label: '0', bbox: [0.41, 0.4, 0.2, 0.2] },
        { image: 'b.png', label: '' },
      ]),
    });
    expect(compareAnswers(exp, act, { time_ms: 1 }).metrics.correct_rate).toBe(1);
  });
});

describe('dataset files', () => {
  it('reads an answer file by extension or by the dataset setting, and a label folder', () => {
    const d = dir({ 'answers.json': ANSWERS_MAP, 'gt.data': 'img1.png,OK\n', 'labels/a.txt': '0\n', 'labels/classes.txt': 'x\n', 'labels/b.txt': '' });
    expect(readAnswers(path.join(d, 'answers.json'), 'auto').cases.size).toBe(4);
    expect(labelsOf(readAnswers(path.join(d, 'gt.data'), 'csv'))).toEqual({ img1: ['OK'] });
    expect(labelsOf(readAnswers(path.join(d, 'labels'), 'auto'))).toEqual({ a: ['0'], b: [] });
    expect(() => answerInput(path.join(d, 'gt.data'), 'auto')).toThrow(/認不出/);
    expect(() => answerInput(path.join(d, 'labels'), 'json')).toThrow(/資料夾/);
    expect(() => answerInput(path.join(d, 'missing.json'), 'auto')).toThrow(/找不到答案檔/);
  });

  it('finds what the software wrote into {out}: json first, then csv, then labels; overlays are not answers', () => {
    expect(findOutput(path.join(os.tmpdir(), 'loop-no-such-dir'))).toBeNull();
    expect(findOutput(dir({ 'overlays/x.png': 'png', 'log.md': '' }))).toBeNull();
    const both = findOutput(dir({ 'b.csv': 'a,1\n', 'results.json': '{"a": "1"}', 'other.json': '{}' }))!;
    expect(both.source).toBe('results.json');
    expect(findOutput(dir({ 'pred.csv': 'a,1\n' }))!.input.format).toBe('csv');
    const yolo = findOutput(dir({ 'labels/a.txt': '1\n' }))!;
    expect(yolo.source).toBe('labels');
    expect(findOutput(dir({ 'a.txt': '1\n', 'classes.txt': 'x' }))!.source).toBe('.');
  });

  it('listFiles and pulledPath', () => {
    const d = dir({ 'out/cr_1/results.json': '{}', 'out/cr_1/overlays/a.png': 'x' });
    expect(listFiles(path.join(d, 'out'))).toEqual(['cr_1/overlays/a.png', 'cr_1/results.json']);
    expect(pulledPath(path.join(d, 'out'), 'cr_1')).toBe(path.join(d, 'out', 'cr_1'));
    expect(pulledPath(path.join(d, 'out'), 'cr_2')).toBe(path.join(d, 'out'));
  });
});
