import { describe, it, expect } from 'vitest';
import { validateDeckSpec, parseManifest, parseRoadmap, parseRegistry } from '../report/pptx/spec.js';

describe('validateDeckSpec', () => {
  it('accepts a well-formed spec', () => {
    const result = validateDeckSpec({
      version: 1,
      week: '2026-W28',
      summary: { rows: [{ pillar: 'AMC', project: 'AOI', fab_line: 'Fab1/LineA', status_items: [] }] },
      projects: [
        {
          key: 'aoi',
          pillar: 'AMC',
          fab: 'Fab1',
          name: 'AOI 專案',
          roadmap: { checkpoints: [{ label: 'Kickoff', date: '2026-06-01' }], current_index: 0 },
          status_items: [{ text: '進度正常', color: 'black' }],
          explain_pages: [],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.week).toBe('2026-W28');
    expect(result.spec.projects).toHaveLength(1);
    expect(result.spec.projects[0]?.status_items).toEqual([{ text: '進度正常', color: 'black' }]);
  });

  it('clamps status_items beyond 2 down to 2', () => {
    const result = validateDeckSpec({
      week: '2026-W28',
      summary: { rows: [] },
      projects: [
        {
          key: 'aoi',
          name: 'AOI',
          roadmap: { checkpoints: [], current_index: 0 },
          status_items: [
            { text: 'one', color: 'black' },
            { text: 'two', color: 'blue' },
            { text: 'three', color: 'red' },
          ],
          explain_pages: [],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.projects[0]?.status_items).toHaveLength(2);
    expect(result.spec.projects[0]?.status_items.map((i) => i.text)).toEqual(['one', 'two']);
  });

  it('defaults an invalid color to blue', () => {
    const result = validateDeckSpec({
      week: '2026-W28',
      summary: { rows: [] },
      projects: [
        {
          key: 'aoi',
          name: 'AOI',
          roadmap: { checkpoints: [], current_index: 0 },
          status_items: [{ text: 'x', color: 'purple' }],
          explain_pages: [],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.projects[0]?.status_items[0]?.color).toBe('blue');
  });

  it('collapses embedded newlines/whitespace to a single line', () => {
    const result = validateDeckSpec({
      week: '2026-W28',
      summary: { rows: [] },
      projects: [
        {
          key: 'aoi',
          name: 'AOI\n專案',
          roadmap: { checkpoints: [], current_index: 0 },
          status_items: [{ text: '進度\n正常\t延遲', color: 'black' }],
          explain_pages: [],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.projects[0]?.name).toBe('AOI 專案');
    expect(result.spec.projects[0]?.status_items[0]?.text).toBe('進度 正常 延遲');
  });

  it('clamps explain_pages beyond 2 down to 2', () => {
    const result = validateDeckSpec({
      week: '2026-W28',
      summary: { rows: [] },
      projects: [
        {
          key: 'aoi',
          name: 'AOI',
          roadmap: { checkpoints: [], current_index: 0 },
          status_items: [],
          explain_pages: [
            { title: 'p1', note: '', images: [] },
            { title: 'p2', note: '', images: [] },
            { title: 'p3', note: '', images: [] },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.projects[0]?.explain_pages).toHaveLength(2);
    expect(result.spec.projects[0]?.explain_pages.map((p) => p.title)).toEqual(['p1', 'p2']);
  });

  it('clamps current_index into [0, checkpoints.length-1]', () => {
    const result = validateDeckSpec({
      week: '2026-W28',
      summary: { rows: [] },
      projects: [
        {
          key: 'aoi',
          name: 'AOI',
          roadmap: {
            checkpoints: [{ label: 'a', date: '2026-01-01' }, { label: 'b', date: '2026-02-01' }],
            current_index: 99,
          },
          status_items: [],
          explain_pages: [],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.projects[0]?.roadmap.current_index).toBe(1);
  });

  it('current_index defaults to 0 when checkpoints is empty', () => {
    const result = validateDeckSpec({
      week: '2026-W28',
      summary: { rows: [] },
      projects: [
        {
          key: 'aoi',
          name: 'AOI',
          roadmap: { checkpoints: [], current_index: 5 },
          status_items: [],
          explain_pages: [],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.projects[0]?.roadmap.current_index).toBe(0);
  });

  it('drops invalid project entries but keeps valid ones', () => {
    const result = validateDeckSpec({
      week: '2026-W28',
      summary: { rows: [] },
      projects: [
        { key: '', name: 'no key' }, // invalid: missing key
        null,
        {
          key: 'ok',
          name: 'OK 專案',
          roadmap: { checkpoints: [], current_index: 0 },
          status_items: [],
          explain_pages: [],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.projects).toHaveLength(1);
    expect(result.spec.projects[0]?.key).toBe('ok');
  });

  it('never throws on wholesale-garbage input, and reports {ok:false}', () => {
    expect(() => validateDeckSpec(null)).not.toThrow();
    expect(() => validateDeckSpec('not an object')).not.toThrow();
    expect(() => validateDeckSpec(42)).not.toThrow();
    expect(() => validateDeckSpec([])).not.toThrow();
    expect(validateDeckSpec(null)).toEqual({ ok: false, error: expect.any(String) });
    expect(validateDeckSpec({})).toEqual({ ok: false, error: expect.any(String) });
    expect(validateDeckSpec({ week: '2026-W28' })).toEqual({ ok: false, error: expect.any(String) });
  });

  it('accepts a spec with only summary rows and no projects', () => {
    const result = validateDeckSpec({
      week: '2026-W28',
      summary: { rows: [{ pillar: 'AMC', project: 'X', fab_line: '', status_items: [] }] },
      projects: [],
    });
    expect(result.ok).toBe(true);
  });
});

describe('parseManifest', () => {
  it('accepts a well-formed manifest and fills defaults for missing sub-fields', () => {
    const result = parseManifest({
      shape_prefix: 'LOOP:',
      pool: [
        { slide: 0, kind: 'summary' },
        { slide: 1, kind: 'main', slot: 0 },
      ],
      summary: { table_shape: 'LOOP:summary:table' },
      colors: { carried: '000000', new: '0000FF', highlight: 'FF0000' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.pool).toHaveLength(2);
    expect(result.manifest.summary.header_rows).toBe(1); // default
    expect(result.manifest.summary.font_size_pt).toBe(10); // default
    expect(result.manifest.main.checkpoints).toBe(0); // default when main is omitted entirely
    expect(result.manifest.colors.carried).toBe('000000');
  });

  it('drops invalid pool entries (missing slide/kind) but keeps valid ones', () => {
    const result = parseManifest({
      pool: [
        { slide: 0, kind: 'summary' },
        { kind: 'main' }, // missing slide
        { slide: 2, kind: 'bogus' }, // invalid kind
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.pool).toHaveLength(1);
  });

  it('never throws and reports {ok:false} when there are zero valid pool entries', () => {
    expect(() => parseManifest(null)).not.toThrow();
    expect(parseManifest(null)).toEqual({ ok: false, error: expect.any(String) });
    expect(parseManifest({ pool: [] })).toEqual({ ok: false, error: expect.any(String) });
    expect(parseManifest({ pool: [{ kind: 'summary' }] })).toEqual({ ok: false, error: expect.any(String) });
  });
});

describe('parseRoadmap', () => {
  it('accepts a well-formed roadmap config', () => {
    const result = parseRoadmap({
      benefit: '提升良率',
      checkpoints: [{ label: 'Kickoff', date: '2026-06-01' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roadmap.checkpoints).toHaveLength(1);
    expect(result.roadmap.benefit).toBe('提升良率');
  });

  it('drops invalid checkpoints (missing label/date)', () => {
    const result = parseRoadmap({
      checkpoints: [{ label: 'ok', date: '2026-06-01' }, { label: 'no date' }, { date: '2026-07-01' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.roadmap.checkpoints).toHaveLength(1);
  });

  it('never throws and reports {ok:false} when there are zero valid checkpoints', () => {
    expect(() => parseRoadmap(undefined)).not.toThrow();
    expect(parseRoadmap(undefined)).toEqual({ ok: false, error: expect.any(String) });
    expect(parseRoadmap({ checkpoints: [] })).toEqual({ ok: false, error: expect.any(String) });
  });
});

describe('parseRegistry', () => {
  it('accepts a well-formed registry', () => {
    const result = parseRegistry({
      pillars: ['AMC', 'Energy'],
      projects: [{ key: 'aoi', pillar: 'AMC', name: 'AOI', fab: 'Fab1', fab_line: 'Fab1/LineA', enabled: true }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registry.pillars).toEqual(['AMC', 'Energy']);
    expect(result.registry.projects).toHaveLength(1);
    expect(result.registry.projects[0]?.enabled).toBe(true);
  });

  it('defaults enabled to true and drops invalid projects (missing key/name)', () => {
    const result = parseRegistry({
      projects: [
        { key: 'ok', name: 'OK Project', pillar: 'AMC', fab: 'Fab1', fab_line: 'Fab1/LineA' },
        { key: '', name: 'no key' },
        { name: 'no key either' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registry.projects).toHaveLength(1);
    expect(result.registry.projects[0]?.enabled).toBe(true);
  });

  it('never throws and reports {ok:false} when there are zero valid projects', () => {
    expect(() => parseRegistry(123)).not.toThrow();
    expect(parseRegistry(123)).toEqual({ ok: false, error: expect.any(String) });
    expect(parseRegistry({ projects: [] })).toEqual({ ok: false, error: expect.any(String) });
  });
});
