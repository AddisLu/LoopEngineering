import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
// the web modules are plain ESM with no DOM at import time
import { rankNodes, layered, grid, stackGroups, bounds, fitTransform, edgePath } from '../../web/flow/layout.js';
import { niceMax, ticks, scaleLinear, scaleLog, logTicks, heatColor, fmtNum, stackLabels } from '../../web/charts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, '..', '..', 'web');

describe('flow layout (總覽 / 工作流程 canvases)', () => {
  const n = (id: string, w = 100, h = 40, extra: Record<string, unknown> = {}) => ({ id, w, h, ...extra });

  it('ranks by the longest path, ignoring the gate\'s send-back edge and a cluster\'s sub-nodes', () => {
    const nodes = ['need', 'setup', 'ai', 'verify', 'gate', 'merge', 'model'].map((id) => n(id));
    const edges = [
      { from: 'need', to: 'setup' },
      { from: 'setup', to: 'ai' },
      { from: 'ai', to: 'verify' },
      { from: 'verify', to: 'gate' },
      { from: 'gate', to: 'merge' },
      { from: 'gate', to: 'ai', kind: 'back' },
      { from: 'ai', to: 'model', kind: 'attach' },
    ];
    const r = rankNodes(nodes, edges);
    expect([...['need', 'setup', 'ai', 'verify', 'gate', 'merge'].map((id) => r.get(id))]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(r.get('model')).toBe(0);
  });

  it('survives a cycle and honours pinned ranks', () => {
    const r = rankNodes([n('a'), n('b'), n('c', 100, 40, { rank: 7 })], [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]);
    expect(r.get('c')).toBe(7);
    // the edge that closes the cycle is dropped: two distinct, consecutive layers
    expect(Math.abs(r.get('a')! - r.get('b')!)).toBe(1);
  });

  it('a fan-out and its fan-in line up: the question, three arms, the final measurement', () => {
    const nodes = [n('q', 132, 64), n('a1', 212, 56), n('a2', 212, 56), n('a3', 212, 56), n('fin', 148, 64), n('judge', 132, 64)];
    const edges = [
      ...['a1', 'a2', 'a3'].map((a) => ({ from: 'q', to: a })),
      ...['a1', 'a2', 'a3'].map((a) => ({ from: a, to: 'fin' })),
      { from: 'fin', to: 'judge' },
    ];
    const { pos, width, height } = layered(nodes, edges, { gapX: 64, gapY: 20 });
    // arms stack in one column; the column is as tall as the layout
    expect(pos.get('a1')!.x).toBe(pos.get('a3')!.x);
    expect(height).toBe(56 * 3 + 20 * 2);
    // question and final measurement sit at the arms' middle
    const mid = (id: string) => pos.get(id)!.y + pos.get(id)!.h / 2;
    expect(mid('q')).toBe(mid('a2'));
    expect(mid('fin')).toBe(mid('a2'));
    expect(width).toBe(132 + 212 + 148 + 132 + 64 * 3);
  });

  it('packs loose nodes into a grid and stacks groups with room for their headers', () => {
    const g = grid([n('x', 220, 64), n('y', 220, 64), n('z', 220, 64)], { cols: 2, gapX: 24, gapY: 20 });
    expect(g.pos.get('z')).toMatchObject({ x: 0, y: 84 });
    expect(g.width).toBe(220 * 2 + 24);
    const s = stackGroups([{ id: 'g1', layout: g }, { id: 'g2', layout: layered([n('solo')], []) }], { pad: 24, head: 44, gap: 16, origin: 16 });
    expect(s.groups[0]).toMatchObject({ x: 16, y: 16, h: 44 + g.height + 24 });
    expect(s.groups[1]!.y).toBe(16 + s.groups[0]!.h + 16);
    expect(s.pos.get('x')).toMatchObject({ x: 16 + 24, y: 16 + 44 });
  });

  it('fits the content into the viewport without zooming in past 100%', () => {
    const box = bounds([{ x: 0, y: 0, w: 2000, h: 500 }]);
    const t = fitTransform(box, 1000, 800, { margin: 20 });
    expect(t.k).toBeCloseTo(0.48, 2);
    expect(fitTransform(bounds([{ x: 0, y: 0, w: 100, h: 50 }]), 1000, 800).k).toBe(1);
  });

  it('draws forward edges as curves and the send-back edge above the row', () => {
    const a = { x: 0, y: 100, w: 100, h: 40 };
    const b = { x: 200, y: 100, w: 100, h: 40 };
    expect(edgePath(a, b, undefined)).toMatch(/^M 100 120 C /);
    const back = edgePath(b, a, 'back', 56);
    expect(back.startsWith('M 250 100 L 250')).toBe(true);
    expect(back).toContain(' 44 ');
  });
});

describe('chart scales', () => {
  it('rounds axis maxima and spaces ticks on round steps', () => {
    expect(niceMax(27.7)).toBe(30);
    expect(niceMax(8.2)).toBe(10);
    expect(niceMax(0)).toBe(1);
    expect(ticks(30, 6)).toEqual([0, 5, 10, 15, 20, 25, 30]);
    expect(ticks(10, 4)).toEqual([0, 2.5, 5, 7.5, 10]);
  });

  it('maps linear and log scales', () => {
    const y = scaleLinear(0, 30, 300, 0);
    expect(y(10)).toBe(200);
    const l = scaleLog(1, 100, 0, 200);
    expect(l(10)).toBeCloseTo(100);
    expect(l(0.001)).toBe(0);
    expect(logTicks(1, 30)).toEqual([1, 2, 5, 10, 20]);
  });

  it('colours pass rates from brick to green, and formats numbers', () => {
    expect(heatColor(null)).toBeNull();
    expect(heatColor(0)).toBe('rgb(234, 185, 178)');
    expect(heatColor(1)).toBe('rgb(140, 197, 165)');
    expect(heatColor(0.5)).toBe('rgb(243, 228, 200)');
    expect(fmtNum(27.746)).toBe('27.75');
    expect(fmtNum(null)).toBe('–');
    expect(fmtNum(1234.5)).toBe('1235');
  });

  it('stacks names that would print over each other (two models ending on the same point)', () => {
    const out = stackLabels([
      { x: 10, y: 50, name: 'haiku' },
      { x: 12, y: 50, name: 'sonnet' },
      { x: 300, y: 52, name: 'far away' },
      { x: 11, y: 90, name: 'lower' },
    ]);
    expect(out.map((l) => [l.name, l.y])).toEqual([
      ['haiku', 50],
      ['sonnet', 64],
      ['far away', 52],
      ['lower', 90],
    ]);
    // a label is checked against every one placed before it, not just the one above it
    const abc = stackLabels([{ x: 10, y: 50 }, { x: 300, y: 51 }, { x: 12, y: 52 }, { x: 14, y: 60 }]);
    expect(abc.map((l) => l.y)).toEqual([50, 51, 64, 78]);
  });
});

describe('the new pages stay textContent-only and offline', () => {
  const files = ['frame.js', 'charts.js', 'flow/layout.js', 'flow/canvas.js', 'flow.js', 'board-flow.js', 'benchmarks.js', 'prd-form.js'];
  it.each(files)('%s never builds markup from strings', (f) => {
    const src = fs.readFileSync(path.join(WEB, f), 'utf8');
    for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) expect(src, `${f} uses ${bad}`).not.toContain(bad);
  });
});
