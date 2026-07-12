import { describe, it, expect } from 'vitest';
import {
  weekId,
  findPrevWeekSpec,
  parseCheckpointDate,
  computeCurrentIndex,
  assembleDeckSpec,
  type AssembleFs,
} from '../report/pptx/assemble.js';
import type { DeckSpec, ProjectRegistry, RoadmapConfig } from '../report/pptx/spec.js';
import type { OpWorkPackage } from '../report/opdata.js';

function fakeFs(initial: Record<string, string> = {}): AssembleFs {
  const files = new Map<string, string>(Object.entries(initial));
  return {
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
}

function makeWp(id: number, is_closed: boolean): OpWorkPackage {
  return {
    id,
    subject: `wp-${id}`,
    status: is_closed ? 'closed' : 'open',
    is_closed,
    type: 'Task',
    assignee_name: '',
    project_id: null,
    project_name: '',
    start_date: '',
    due_date: '',
    percent_done: is_closed ? 100 : 50,
    estimated_hours: 0,
    spent_hours: 0,
    remaining_hours: 0,
    description: '',
    custom_fields: {},
    updated_at: '',
  };
}

describe('assemble.ts: weekId (ISO 8601 week)', () => {
  it('a Thursday Jan 1 belongs to week 1 of its own year', () => {
    expect(weekId(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01');
  });

  it('year boundary: Jan 1 of the next year can belong to week 53 of the previous year', () => {
    expect(weekId(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
  });

  it('year boundary the other direction: late December can belong to week 1 of the next year', () => {
    expect(weekId(new Date('2025-12-29T00:00:00Z'))).toBe('2026-W01');
  });

  it('another classic ISO edge case', () => {
    expect(weekId(new Date('2016-01-01T00:00:00Z'))).toBe('2015-W53');
  });
});

describe('assemble.ts: findPrevWeekSpec', () => {
  const SPEC_W20: DeckSpec = {
    version: 1,
    week: '2026-W20',
    summary: { rows: [{ pillar: 'AMC', project: 'AOI 專案', fab_line: 'Fab1/LineA', status_items: [] }] },
    projects: [],
  };
  const SPEC_W23: DeckSpec = {
    version: 1,
    week: '2026-W23',
    summary: { rows: [{ pillar: 'AMC', project: 'AOI 專案', fab_line: 'Fab1/LineA', status_items: [] }] },
    projects: [],
  };

  it('skip-week safe: finds the most recent prior week even after a gap', () => {
    const fs = fakeFs({
      '/data/report-pptx/weeks/2026-W20/deck-spec.json': JSON.stringify(SPEC_W20),
      '/data/report-pptx/weeks/2026-W23/deck-spec.json': JSON.stringify(SPEC_W23),
    });
    const prev = findPrevWeekSpec('/data/report-pptx', '2026-W25', fs);
    expect(prev?.week).toBe('2026-W23');
  });

  it('returns null when there is no prior week (first week ever)', () => {
    const fs = fakeFs({});
    expect(findPrevWeekSpec('/data/report-pptx', '2026-W01', fs)).toBeNull();
  });

  it('never returns a week >= currentWeek', () => {
    const fs = fakeFs({
      '/data/report-pptx/weeks/2026-W20/deck-spec.json': JSON.stringify(SPEC_W20),
    });
    expect(findPrevWeekSpec('/data/report-pptx', '2026-W20', fs)).toBeNull();
  });
});

describe('assemble.ts: parseCheckpointDate', () => {
  it('"YY/MM" -> last day of that month', () => {
    expect(parseCheckpointDate('24/12')?.toISOString().slice(0, 10)).toBe('2024-12-31');
    expect(parseCheckpointDate('25/06')?.toISOString().slice(0, 10)).toBe('2025-06-30');
  });

  it('"YY/MM/B" -> the 15th of that month', () => {
    expect(parseCheckpointDate('25/02/B')?.toISOString().slice(0, 10)).toBe('2025-02-15');
  });

  it('unrecognized formats return null', () => {
    expect(parseCheckpointDate('2025-06')).toBeNull();
    expect(parseCheckpointDate('not-a-date')).toBeNull();
    expect(parseCheckpointDate('25/13')).toBeNull();
  });
});

describe('assemble.ts: computeCurrentIndex', () => {
  const CHECKPOINTS = [
    { label: 'a', date: '24/12' },
    { label: 'b', date: '25/02/B' },
    { label: 'c', date: '25/06' },
  ];

  it('override wins over everything else, clamped into range', () => {
    const idx = computeCurrentIndex({ checkpoints: CHECKPOINTS }, new Map(), new Date('2020-01-01'), 99);
    expect(idx).toBe(2); // clamped to checkpoints.length - 1
  });

  it('wp-bound rule: last is_closed checkpoint among those resolvable via wpsById', () => {
    const roadmap = {
      checkpoints: [
        { label: 'a', date: '24/12', wp: 1 },
        { label: 'b', date: '25/02/B', wp: 2 },
        { label: 'c', date: '25/06', wp: 3 },
      ],
    };
    const wpsById = new Map<number, OpWorkPackage>([
      [1, makeWp(1, true)],
      [2, makeWp(2, true)],
      [3, makeWp(3, true)],
    ]);
    expect(computeCurrentIndex(roadmap, wpsById, new Date('2020-01-01'))).toBe(2);
  });

  it('wp-bound rule: none closed -> 0', () => {
    const roadmap = {
      checkpoints: [
        { label: 'a', date: '24/12', wp: 1 },
        { label: 'b', date: '25/02/B', wp: 2 },
      ],
    };
    const wpsById = new Map<number, OpWorkPackage>([
      [1, makeWp(1, false)],
      [2, makeWp(2, false)],
    ]);
    expect(computeCurrentIndex(roadmap, wpsById, new Date('2020-01-01'))).toBe(0);
  });

  it('date-based fallback (no wp binding): today=2025-03-10, dates=["24/12","25/02/B","25/06"] -> index 1', () => {
    const idx = computeCurrentIndex({ checkpoints: CHECKPOINTS }, new Map(), new Date('2025-03-10T00:00:00Z'));
    expect(idx).toBe(1);
  });

  it('no checkpoints -> 0', () => {
    expect(computeCurrentIndex({ checkpoints: [] }, new Map(), new Date())).toBe(0);
  });
});

describe('assemble.ts: assembleDeckSpec', () => {
  const REGISTRY: ProjectRegistry = {
    version: 1,
    pillars: ['Energy', 'AMC'],
    projects: [
      { key: 'aoi-amc', pillar: 'AMC', name: 'AOI 專案', fab: 'Fab1', fab_line: 'Fab1/LineA', enabled: true },
      { key: 'energy-mgmt', pillar: 'Energy', name: '能源管理專案', fab: 'Fab2', fab_line: 'Fab2/LineB', enabled: true },
      { key: 'disabled-one', pillar: 'AMC', name: '停用專案', fab: 'Fab1', fab_line: 'Fab1/LineC', enabled: false },
    ],
  };
  const ROADMAPS = new Map<string, RoadmapConfig>([
    ['aoi-amc', { checkpoints: [{ label: 'k', date: '24/12' }] }],
    ['energy-mgmt', { checkpoints: [] }],
  ]);
  const NOW = new Date('2026-07-13T00:00:00Z');

  it('statusCandidates missing a key falls back to prevSpec items, recolored all-black ("nothing updated but still ships")', () => {
    const prevSpec: DeckSpec = {
      version: 1,
      week: '2026-W28',
      summary: { rows: [] },
      projects: [
        {
          key: 'aoi-amc',
          pillar: 'AMC',
          fab: 'Fab1',
          name: 'AOI 專案',
          roadmap: { checkpoints: [], current_index: 0 },
          status_items: [
            { text: 'A案已導入', color: 'blue' },
            { text: 'B案評估中', color: 'black' },
          ],
          explain_pages: [],
        },
      ],
    };

    const spec = assembleDeckSpec({
      week: '2026-W29',
      registry: REGISTRY,
      roadmaps: ROADMAPS,
      prevSpec,
      statusCandidates: new Map(),
      explain: new Map(),
      wps: new Map(),
      now: NOW,
    });

    const aoi = spec.projects.find((p) => p.key === 'aoi-amc');
    expect(aoi?.status_items).toEqual([
      { text: 'A案已導入', color: 'black' },
      { text: 'B案評估中', color: 'black' },
    ]);
  });

  it('no prevSpec and no candidates -> empty status_items', () => {
    const spec = assembleDeckSpec({
      week: '2026-W01',
      registry: REGISTRY,
      roadmaps: ROADMAPS,
      prevSpec: null,
      statusCandidates: new Map(),
      explain: new Map(),
      wps: new Map(),
      now: NOW,
    });
    const energy = spec.projects.find((p) => p.key === 'energy-mgmt');
    expect(energy?.status_items).toEqual([]);
  });

  it('statusCandidates seam: an explicit entry is used verbatim (diffed against prevSpec)', () => {
    const spec = assembleDeckSpec({
      week: '2026-W01',
      registry: REGISTRY,
      roadmaps: ROADMAPS,
      prevSpec: null,
      statusCandidates: new Map([['aoi-amc', [{ text: '新項目' }]]]),
      explain: new Map(),
      wps: new Map(),
      now: NOW,
    });
    const aoi = spec.projects.find((p) => p.key === 'aoi-amc');
    expect(aoi?.status_items).toEqual([{ text: '新項目', color: 'blue' }]);
  });

  it('disabled projects are excluded entirely', () => {
    const spec = assembleDeckSpec({
      week: '2026-W01',
      registry: REGISTRY,
      roadmaps: ROADMAPS,
      prevSpec: null,
      statusCandidates: new Map(),
      explain: new Map(),
      wps: new Map(),
      now: NOW,
    });
    expect(spec.projects.some((p) => p.key === 'disabled-one')).toBe(false);
  });

  it('summary rows are grouped by registry.pillars declared order (Energy before AMC here)', () => {
    const spec = assembleDeckSpec({
      week: '2026-W01',
      registry: REGISTRY,
      roadmaps: ROADMAPS,
      prevSpec: null,
      statusCandidates: new Map(),
      explain: new Map(),
      wps: new Map(),
      now: NOW,
    });
    expect(spec.summary.rows.map((r) => r.pillar)).toEqual(['Energy', 'AMC']);
    expect(spec.summary.rows.map((r) => r.project)).toEqual(['能源管理專案', 'AOI 專案']);
  });

  it('summary rows share the exact same (colored) status_items as the main project page', () => {
    const spec = assembleDeckSpec({
      week: '2026-W01',
      registry: REGISTRY,
      roadmaps: ROADMAPS,
      prevSpec: null,
      statusCandidates: new Map([['aoi-amc', [{ text: 'X' }]]]),
      explain: new Map(),
      wps: new Map(),
      now: NOW,
    });
    const aoi = spec.projects.find((p) => p.key === 'aoi-amc')!;
    const row = spec.summary.rows.find((r) => r.project === 'AOI 專案')!;
    expect(row.status_items).toEqual(aoi.status_items);
  });

  it('currentOverrides seam feeds through to each project roadmap.current_index', () => {
    const spec = assembleDeckSpec({
      week: '2026-W01',
      registry: REGISTRY,
      roadmaps: ROADMAPS,
      prevSpec: null,
      statusCandidates: new Map(),
      explain: new Map(),
      wps: new Map(),
      currentOverrides: new Map([['aoi-amc', 0]]),
      now: NOW,
    });
    const aoi = spec.projects.find((p) => p.key === 'aoi-amc');
    expect(aoi?.roadmap.current_index).toBe(0);
  });
});
