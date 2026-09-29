// Charts for the 評比 pages, drawn as plain SVG (no library: this box is sometimes offline, and
// the repo vendors nothing it can do without). Scales and ticks are pure functions the tests
// import; the draw functions build SVG with createElementNS + textContent only. Colours are
// passed in (series colours) or come from frame.css classes (grid, axis, threshold, bands).

const NS = 'http://www.w3.org/2000/svg';

// ---- pure helpers ------------------------------------------------------------------------------

/** A round axis maximum at or above v: 27.7 → 30, 8.2 → 10, 0 → 1. */
export function niceMax(v) {
  if (!Number.isFinite(v) || v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v - 1e-9) return m * p;
  return 10 * p;
}

/** Evenly spaced ticks from 0 to max (inclusive), about n of them, on round steps. */
export function ticks(max, n = 6) {
  if (!(max > 0)) return [0];
  const raw = max / Math.max(1, n);
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw - 1e-9) ?? raw;
  const out = [];
  for (let v = 0; v <= max + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/** linear scale: value in [d0, d1] → [r0, r1] */
export const scaleLinear = (d0, d1, r0, r1) => (v) => (d1 === d0 ? r0 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0));

/** log10 scale over [lo, hi] (both > 0); values ≤ lo pin to r0 */
export function scaleLog(lo, hi, r0, r1) {
  const a = Math.log10(Math.max(lo, 1e-9));
  const b = Math.log10(Math.max(hi, lo * 10));
  return (v) => r0 + ((Math.log10(Math.max(v, lo)) - a) / (b - a)) * (r1 - r0);
}

/** ticks for a log axis: the powers of ten (and their 2× / 5×) inside [lo, hi] */
export function logTicks(lo, hi) {
  const out = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (v >= lo - 1e-9 && v <= hi + 1e-9) out.push(Math.round(v * 1e6) / 1e6);
    }
  }
  return out;
}

/** a pass rate (0..1) as a heat colour from brick through sand to green; null → none */
export function heatColor(rate) {
  if (rate == null || !Number.isFinite(rate)) return null;
  const stops = [
    [0, [234, 185, 178]],
    [0.5, [243, 228, 200]],
    [1, [140, 197, 165]],
  ];
  const r = Math.max(0, Math.min(1, rate));
  let i = 0;
  while (i < stops.length - 2 && r > stops[i + 1][0]) i++;
  const [p0, c0] = stops[i];
  const [p1, c1] = stops[i + 1];
  const f = (r - p0) / (p1 - p0 || 1);
  const c = c0.map((v, k) => Math.round(v + (c1[k] - v) * f));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** number → short label: 27.746 → "27.75", 6.1 → "6.10", 1234 → "1234" */
export function fmtNum(v, digits = 2) {
  if (v == null || !Number.isFinite(Number(v))) return '–';
  const n = Number(v);
  return Math.abs(n) >= 100 ? String(Math.round(n)) : n.toFixed(digits);
}

// ---- svg plumbing --------------------------------------------------------------------------------

function el(tag, attrs = {}, text) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, String(v));
  if (text != null) e.textContent = String(text);
  return e;
}

function frame(w, hgt, label) {
  const wrap = document.createElement('div');
  wrap.className = 'chart';
  const svg = el('svg', { viewBox: `0 0 ${w} ${hgt}`, role: 'img', 'aria-label': label || '圖表' });
  if (label) svg.appendChild(el('title', {}, label));
  wrap.appendChild(svg);
  return { wrap, svg };
}

// ---- grouped bars with a threshold line ----------------------------------------------------------------

/**
 * groupedBars({ categories, series: [{ label, color, values }], threshold: { value, label }, unit, log })
 * Bars per category, one per series; a dashed threshold line; value labels on the bars (a value
 * over the threshold is drawn in the warning colour). Missing values leave a gap.
 */
export function groupedBars(o) {
  const W = o.width ?? 1200;
  const H = o.height ?? 320;
  const L = 44;
  const B = 34;
  const T = 18;
  const plotW = W - L - 8;
  const plotH = H - B - T;
  const all = o.series.flatMap((s) => s.values).filter((v) => Number.isFinite(v));
  const top = niceMax(Math.max(...all, o.threshold?.value ?? 0, o.max ?? 0) * (o.log ? 1.3 : 1.08));
  const lo = o.log ? Math.max(0.1, Math.min(...all.filter((v) => v > 0), o.threshold?.value ?? Infinity) / 2) : 0;
  const y = o.log ? scaleLog(lo, top, T + plotH, T) : scaleLinear(0, top, T + plotH, T);
  const { wrap, svg } = frame(W, H, o.label);

  const tks = o.log ? logTicks(lo, top) : ticks(top, 6);
  for (const v of tks) {
    const yy = y(v);
    svg.appendChild(el('line', { class: 'grid', x1: L, x2: W - 8, y1: yy, y2: yy }));
    svg.appendChild(el('text', { x: L - 8, y: yy + 4, 'text-anchor': 'end' }, v));
  }
  svg.appendChild(el('line', { class: 'axis', x1: L, x2: W - 8, y1: T + plotH, y2: T + plotH }));

  const nCat = o.categories.length;
  const nSer = o.series.length;
  const groupW = plotW / Math.max(1, nCat);
  const gap = 6;
  const barW = Math.max(6, Math.min(44, (groupW * 0.78 - gap * (nSer - 1)) / Math.max(1, nSer)));
  const used = barW * nSer + gap * (nSer - 1);
  o.categories.forEach((cat, ci) => {
    const x0 = L + ci * groupW + (groupW - used) / 2;
    o.series.forEach((s, si) => {
      const v = s.values[ci];
      if (!Number.isFinite(v)) return;
      const x = x0 + si * (barW + gap);
      const yy = y(Math.max(v, lo));
      const rect = el('rect', { x, y: yy, width: barW, height: Math.max(1, T + plotH - yy), rx: 3, fill: s.color });
      rect.appendChild(el('title', {}, `${s.label} · ${cat}：${fmtNum(v)}${o.unit ? ` ${o.unit}` : ''}`));
      svg.appendChild(rect);
      const over = o.threshold && v > o.threshold.value;
      const cls = over && !s.base ? 'v bad' : s.hi ? 'v hi' : 'v';
      svg.appendChild(el('text', { class: cls, x: x + barW / 2, y: yy - 5, 'text-anchor': 'middle' }, fmtNum(v)));
    });
    svg.appendChild(el('text', { class: 'cat', x: L + ci * groupW + groupW / 2, y: H - 10, 'text-anchor': 'middle' }, cat));
  });

  if (o.threshold && Number.isFinite(o.threshold.value)) {
    const ty = y(o.threshold.value);
    svg.appendChild(el('line', { class: 'thr', x1: L, x2: W - 8, y1: ty, y2: ty }));
    // the label sits at the left end, where the first category's bars are usually low
    svg.appendChild(el('text', { class: 'thr-l', x: L + 6, y: ty - 6, 'text-anchor': 'start' }, o.threshold.label ?? `門檻 ${o.threshold.value}`));
  }
  return wrap;
}

// ---- horizontal bars (a single metric per model; phones) -------------------------------------------------

/** hbars({ rows: [{ label, value, color, hi }], threshold, unit }) */
export function hbars(o) {
  const W = o.width ?? 560;
  const rowH = 26;
  const L = o.labelW ?? 110;
  const R = 64;
  const H = o.rows.length * rowH + 16;
  const vals = o.rows.map((r) => r.value).filter((v) => Number.isFinite(v));
  const top = niceMax(Math.max(...vals, o.threshold?.value ?? 0) * 1.05);
  const x = scaleLinear(0, top, L, W - R);
  const { wrap, svg } = frame(W, H, o.label);
  o.rows.forEach((r, i) => {
    const yy = 8 + i * rowH;
    svg.appendChild(el('text', { class: 'lab', x: L - 10, y: yy + 14, 'text-anchor': 'end' }, r.label));
    if (!Number.isFinite(r.value)) {
      svg.appendChild(el('text', { x: L, y: yy + 14 }, r.missing ?? '沒有量到'));
      return;
    }
    svg.appendChild(el('rect', { x: L, y: yy + 3, width: Math.max(2, x(r.value) - L), height: rowH - 10, rx: 3, fill: r.color }));
    const over = o.threshold && r.value > o.threshold.value;
    svg.appendChild(el('text', { class: over ? 'v bad' : r.hi ? 'v hi' : 'v', x: x(r.value) + 6, y: yy + 14 }, `${fmtNum(r.value)}${o.unit ? ` ${o.unit}` : ''}`));
  });
  if (o.threshold) {
    const tx = x(o.threshold.value);
    svg.appendChild(el('line', { class: 'thr', x1: tx, x2: tx, y1: 2, y2: H - 4 }));
  }
  return wrap;
}

// ---- bullet bar: one value against a threshold and a baseline -----------------------------------------

/** bullet({ value, max, threshold, baseline, pass }) → a small bar with markers */
export function bullet(o) {
  const W = 360;
  const H = 34;
  const top = niceMax(Math.max(o.max ?? 0, o.value ?? 0, o.baseline ?? 0, o.threshold ?? 0) * 1.05);
  const x = scaleLinear(0, top, 2, W - 2);
  const { wrap, svg } = frame(W, H, o.label);
  svg.appendChild(el('rect', { x: 2, y: 8, width: W - 4, height: 10, rx: 5, class: 'grid', fill: 'var(--surface-sunk)' }));
  if (Number.isFinite(o.value)) {
    const color = o.pass ? 'var(--ok)' : o.threshold != null && o.value > o.threshold * 1.5 ? 'var(--danger)' : 'var(--warn)';
    svg.appendChild(el('rect', { x: 2, y: 8, width: Math.max(4, x(o.value) - 2), height: 10, rx: 5, fill: color }));
  }
  const mark = (v, cls, text, anchor) => {
    if (!Number.isFinite(v)) return;
    const xx = x(v);
    svg.appendChild(el('line', { x1: xx, x2: xx, y1: 3, y2: 23, stroke: cls === 'base' ? 'var(--text-3)' : 'var(--text)', 'stroke-width': 2 }));
    svg.appendChild(el('text', { x: xx, y: 33, 'text-anchor': anchor }, text));
  };
  mark(o.threshold, 'thr', `門檻 ${fmtNum(o.threshold, 0)}`, 'middle');
  mark(o.baseline, 'base', `基準 ${fmtNum(o.baseline, 1)}`, 'end');
  return wrap;
}

// ---- line chart: a metric per attempt --------------------------------------------------------------------

/**
 * lineChart({ xLabels, series: [{ label, color, points: [v|null], fails: [index] }], band: { below, label } })
 * `fails` marks attempts that measured nothing (the function was wrong) with a square at the top.
 */
export function lineChart(o) {
  const W = o.width ?? 520;
  const H = o.height ?? 260;
  const L = 36;
  const B = 28;
  const T = 16;
  const plotW = W - L - 16;
  const plotH = H - B - T;
  const vals = o.series.flatMap((s) => s.points).filter((v) => Number.isFinite(v));
  const top = niceMax(Math.max(...vals, o.band?.below ?? 0, 1) * 1.1);
  const y = scaleLinear(0, top, T + plotH, T);
  const n = Math.max(1, o.xLabels.length);
  const x = (i) => L + (n === 1 ? plotW / 2 : 24 + (i * (plotW - 48)) / (n - 1));
  const { wrap, svg } = frame(W, H, o.label);
  if (o.band && Number.isFinite(o.band.below)) {
    const by = y(o.band.below);
    svg.appendChild(el('rect', { class: 'band-ok', x: L, y: by, width: plotW, height: T + plotH - by }));
    svg.appendChild(el('text', { class: 'band-l', x: L + plotW - 6, y: T + plotH - 6, 'text-anchor': 'end' }, o.band.label ?? `≤ ${o.band.below}`));
  }
  for (const v of ticks(top, 4)) {
    svg.appendChild(el('line', { class: 'grid', x1: L, x2: L + plotW, y1: y(v), y2: y(v) }));
    svg.appendChild(el('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, v));
  }
  svg.appendChild(el('line', { class: 'axis', x1: L, x2: L + plotW, y1: T + plotH, y2: T + plotH }));
  o.xLabels.forEach((lab, i) => svg.appendChild(el('text', { x: x(i), y: H - 8, 'text-anchor': 'middle' }, lab)));
  for (const s of o.series) {
    const pts = s.points.map((v, i) => (Number.isFinite(v) ? [x(i), y(v)] : null));
    const seg = pts.filter(Boolean);
    if (seg.length > 1) svg.appendChild(el('polyline', { points: seg.map((p) => p.join(',')).join(' '), fill: 'none', stroke: s.color, 'stroke-width': 2.5 }));
    pts.forEach((p, i) => {
      if (!p) return;
      const c = el('circle', { cx: p[0], cy: p[1], r: 5.5, fill: 'var(--surface-2)', stroke: s.color, 'stroke-width': 3 });
      c.appendChild(el('title', {}, `${s.label} · ${o.xLabels[i]}：${fmtNum(s.points[i])}`));
      svg.appendChild(c);
    });
    for (const i of s.fails || []) {
      const r = el('rect', { x: x(i) - 6, y: T - 6, width: 12, height: 12, rx: 2, fill: 'var(--danger)' });
      r.appendChild(el('title', {}, `${s.label} · ${o.xLabels[i]}：功能沒過，沒有量到`));
      svg.appendChild(r);
    }
    const last = [...pts].reverse().find(Boolean);
    if (last) svg.appendChild(el('text', { class: 'lab', x: last[0] + 10, y: last[1] - 8, fill: s.color }, s.label));
  }
  return wrap;
}

// ---- dot plot: criteria × models ---------------------------------------------------------------------------

/** dotPlot({ rows: [{ label, values: [{ label, color, v }] , strong }], min, max }) */
export function dotPlot(o) {
  const W = o.width ?? 600;
  const rowH = 40;
  const L = 96;
  const R = 20;
  const H = o.rows.length * rowH + 26;
  const x = scaleLinear(o.min ?? 0, o.max ?? 10, L, W - R);
  const { wrap, svg } = frame(W, H, o.label);
  o.rows.forEach((r, i) => {
    const yy = 12 + i * rowH + rowH / 2;
    svg.appendChild(el('text', { class: r.strong ? 'lab' : undefined, x: 0, y: yy + 4 }, r.label));
    svg.appendChild(el('line', { class: r.strong ? 'axis' : 'grid', x1: L, x2: W - R, y1: yy, y2: yy, 'stroke-width': 2 }));
    // stack dots that share a value so none hides another
    const seen = new Map();
    for (const d of r.values) {
      if (!Number.isFinite(d.v)) continue;
      const k = Math.round(d.v * 10);
      const nth = seen.get(k) ?? 0;
      seen.set(k, nth + 1);
      const c = el('circle', { cx: x(d.v), cy: yy + (nth ? (nth % 2 ? -7 : 7) : 0), r: r.strong ? 8 : 7, fill: d.color, stroke: 'var(--surface-2)', 'stroke-width': 2 });
      c.appendChild(el('title', {}, `${d.label} · ${r.label}：${d.v}`));
      svg.appendChild(c);
    }
  });
  for (const v of ticks(o.max ?? 10, 2)) svg.appendChild(el('text', { x: x(v), y: H - 4, 'text-anchor': 'middle' }, v));
  return wrap;
}

// ---- scatter with a "good" quadrant ------------------------------------------------------------------------

/**
 * scatter({ points: [{ label, x, y, r, color }], xMax, yMax, xLabel, yLabel, good: { xBelow, yAbove, label }, xFmt, yFmt })
 */
export function scatter(o) {
  const W = o.width ?? 560;
  const H = o.height ?? 280;
  const L = 44;
  const B = 34;
  const T = 14;
  const plotW = W - L - 20;
  const plotH = H - B - T;
  const xMax = o.xMax ?? niceMax(Math.max(...o.points.map((p) => p.x), 1) * 1.15);
  const yMax = o.yMax ?? niceMax(Math.max(...o.points.map((p) => p.y), 1) * 1.1);
  const x = scaleLinear(0, xMax, L, L + plotW);
  const y = scaleLinear(0, yMax, T + plotH, T);
  const { wrap, svg } = frame(W, H, o.label);
  if (o.good) {
    const gx = x(Math.min(o.good.xBelow, xMax));
    const gy = y(Math.min(o.good.yAbove, yMax));
    svg.appendChild(el('rect', { class: 'band-ok', x: L, y: T, width: gx - L, height: gy - T }));
    // bottom corner of the zone: the points that belong in it sit near its top
    svg.appendChild(el('text', { class: 'band-l', x: gx - 6, y: gy - 6, 'text-anchor': 'end' }, o.good.label));
  }
  for (const v of ticks(yMax, 4)) svg.appendChild(el('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, o.yFmt ? o.yFmt(v) : v));
  for (const v of ticks(xMax, 4)) svg.appendChild(el('text', { x: x(v), y: H - 16, 'text-anchor': 'middle' }, o.xFmt ? o.xFmt(v) : v));
  svg.appendChild(el('line', { class: 'axis', x1: L, x2: L + plotW, y1: T + plotH, y2: T + plotH }));
  svg.appendChild(el('line', { class: 'axis', x1: L, x2: L, y1: T, y2: T + plotH }));
  if (o.xLabel) svg.appendChild(el('text', { x: L + plotW, y: H - 2, 'text-anchor': 'end' }, o.xLabel));
  if (o.yLabel) svg.appendChild(el('text', { x: L + 4, y: T - 2 }, o.yLabel));
  for (const p of o.points) {
    const r = p.r ?? 8;
    const c = el('circle', { cx: x(p.x), cy: y(p.y), r, fill: p.color, 'fill-opacity': 0.88, stroke: 'var(--surface-2)', 'stroke-width': 2 });
    c.appendChild(el('title', {}, `${p.label}：${o.xFmt ? o.xFmt(p.x) : p.x}，${o.yFmt ? o.yFmt(p.y) : p.y}`));
    svg.appendChild(c);
    svg.appendChild(el('text', { class: 'lab', x: x(p.x) + r + 5, y: y(p.y) + 4, fill: p.color }, p.label));
  }
  return wrap;
}

// ---- swimlane: attempts over time --------------------------------------------------------------------------

/**
 * swimlane({ rows: [{ label, segs: [{ from, to, kind: 'run'|'wait', outcome, text, color }], marks: [{ at, kind }] }], max, unit })
 * Minutes on x; a run segment ends in an outcome marker (pass ● / metrics ○ / functional ■);
 * a wait is dotted; small dots above a run are the model's own 沙盒 runs, 'ncu' a profiler run.
 */
export function swimlane(o) {
  const W = o.width ?? 740;
  const rowH = 60;
  const L = 150;
  const R = 70;
  const H = o.rows.length * rowH + 30;
  const max = o.max ?? niceMax(Math.max(1, ...o.rows.flatMap((r) => r.segs.map((s) => s.to))));
  const x = scaleLinear(0, max, L, W - R);
  const { wrap, svg } = frame(W, H, o.label);
  o.rows.forEach((r, i) => {
    const yy = 8 + i * rowH + rowH / 2;
    svg.appendChild(el('text', { class: 'lab', x: 0, y: yy + 4 }, r.label));
    svg.appendChild(el('line', { class: 'grid', x1: L, x2: W - R, y1: yy + rowH / 2 - 2, y2: yy + rowH / 2 - 2 }));
    for (const s of r.segs) {
      const x0 = x(s.from);
      const x1 = Math.max(x0 + 3, x(s.to));
      if (s.kind === 'wait') {
        svg.appendChild(el('line', { x1: x0, x2: x1, y1: yy, y2: yy, stroke: 'var(--text-3)', 'stroke-width': 2, 'stroke-dasharray': '2 4' }));
        if (s.text && x1 - x0 > 90) svg.appendChild(el('text', { x: (x0 + x1) / 2, y: yy - 8, 'text-anchor': 'middle' }, s.text));
        continue;
      }
      const bar = el('rect', { x: x0, y: yy - 4, width: x1 - x0, height: 8, rx: 4, fill: s.color, 'fill-opacity': 0.55 });
      bar.appendChild(el('title', {}, s.title ?? ''));
      svg.appendChild(bar);
      if (s.outcome) svg.appendChild(outcomeMark(x1, yy, s.outcome));
      if (s.text) svg.appendChild(el('text', { class: s.outcome === 'pass' ? 'v hi' : 'v', x: x1 + 12, y: yy + 4 }, s.text));
    }
    for (const m of r.marks || []) {
      if (m.kind === 'ncu') {
        svg.appendChild(el('text', { class: 'v hi', x: x(m.at), y: yy + 20, 'text-anchor': 'middle' }, 'ncu'));
      } else if (m.kind === 'count') {
        // too many runs to draw one by one: a count above the attempt instead
        svg.appendChild(el('text', { class: 'v', x: x(m.at), y: yy - 9, 'text-anchor': 'middle', fill: 'var(--accent)' }, m.text));
      } else svg.appendChild(el('circle', { cx: x(m.at), cy: yy - 12, r: 2.6, fill: 'var(--accent)' }));
    }
  });
  for (const v of ticks(max, 5)) svg.appendChild(el('text', { x: x(v), y: H - 4, 'text-anchor': 'middle' }, `${v}${o.unit ?? ' 分'}`));
  return wrap;
}

/** the outcome glyph: pass = filled circle with a tick, metrics = ring, functional/protected = square with a cross */
export function outcomeMark(cx, cy, outcome) {
  const g = el('g');
  if (outcome === 'pass') {
    g.appendChild(el('circle', { cx, cy, r: 9, fill: 'var(--ok)' }));
    g.appendChild(el('path', { d: `M ${cx - 4} ${cy} l 3 3 l 5 -6`, fill: 'none', stroke: '#fff', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  } else if (outcome === 'metrics') {
    g.appendChild(el('circle', { cx, cy, r: 7.5, fill: 'var(--surface-2)', stroke: 'var(--warn)', 'stroke-width': 3.5 }));
  } else if (outcome === 'unverified') {
    g.appendChild(el('circle', { cx, cy, r: 7, fill: 'var(--surface-2)', stroke: 'var(--text-3)', 'stroke-width': 2, 'stroke-dasharray': '2 2' }));
  } else {
    g.appendChild(el('rect', { x: cx - 8, y: cy - 8, width: 16, height: 16, rx: 3, fill: 'var(--danger)' }));
    g.appendChild(el('path', { d: `M ${cx - 3.5} ${cy - 3.5} l 7 7 M ${cx + 3.5} ${cy - 3.5} l -7 7`, stroke: '#fff', 'stroke-width': 2, 'stroke-linecap': 'round' }));
  }
  const labels = { pass: '通過', metrics: '功能對、指標未達', functional: '功能沒過', protected: '改了保護路徑', unverified: '沒跑到驗證' };
  g.appendChild(el('title', {}, labels[outcome] ?? outcome));
  return g;
}

/** outcome glyphs in a row (a scorecard's attempts), as a small inline svg */
export function outcomeDots(outcomes) {
  const W = Math.max(1, outcomes.length) * 24;
  const svg = el('svg', { viewBox: `0 0 ${W} 22`, width: W, height: 22, role: 'img', 'aria-label': outcomes.map((x, i) => `第 ${i + 1} 次：${x}`).join('，') });
  outcomes.forEach((oc, i) => svg.appendChild(outcomeMark(11 + i * 24, 11, oc)));
  return svg;
}
