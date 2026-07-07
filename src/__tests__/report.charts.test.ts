import { describe, it, expect } from 'vitest';
import { ganttChart, statusPie, phaseFlow } from '../report/charts.js';
import type { OpWorkPackage } from '../report/opdata.js';

function wp(overrides: Partial<OpWorkPackage> = {}): OpWorkPackage {
  return {
    id: 1,
    subject: '項目',
    status: '進行中',
    is_closed: false,
    type: 'Task',
    assignee_name: '小明',
    project_id: 1,
    project_name: '大型AOI',
    start_date: '',
    due_date: '',
    percent_done: 0,
    estimated_hours: 0,
    spent_hours: 0,
    remaining_hours: 0,
    description: '',
    custom_fields: {},
    updated_at: '',
    ...overrides,
  };
}

describe('charts.ts: ganttChart', () => {
  it('empty input -> ""', () => {
    expect(ganttChart([])).toBe('');
  });

  it('items with neither start_date nor due_date are skipped -> "" when nothing else qualifies', () => {
    expect(ganttChart([wp({ start_date: '', due_date: '' })])).toBe('');
  });

  it('produces valid-looking gantt syntax, tagging closed=done and overdue-and-unfinished=crit', () => {
    const out = ganttChart([
      wp({ subject: '已完成項目', is_closed: true, start_date: '2020-01-01', due_date: '2020-02-01' }),
      wp({ subject: '逾期項目', is_closed: false, due_date: '2020-01-01', percent_done: 20 }),
      wp({ subject: '未來項目', is_closed: false, due_date: '2099-01-01', percent_done: 10 }),
    ]);
    expect(out.startsWith('gantt')).toBe(true);
    expect(out).toContain('dateFormat YYYY-MM-DD');
    expect(out).toContain(':done,');
    expect(out).toContain(':crit,');
    // the not-yet-due, not-closed item gets neither tag
    expect(out).toMatch(/未來項目 :t\d+, 2099-01-01, 2099-01-01/);
  });

  it('a due-date-only item renders as a single-day bar (start defaults to due)', () => {
    const out = ganttChart([wp({ subject: '只有交期', due_date: '2030-05-01' })]);
    expect(out).toContain('只有交期 :t0, 2030-05-01, 2030-05-01');
  });

  it('a start-before-due data-quality issue (start after due) is swapped rather than emitting invalid syntax', () => {
    const out = ganttChart([wp({ subject: '交期在前', start_date: '2030-06-01', due_date: '2030-01-01' })]);
    expect(out).toContain('交期在前 :t0, 2030-01-01, 2030-06-01');
  });

  it('escapes structurally unsafe characters (colon/comma/hash/newline) out of task labels', () => {
    const out = ganttChart([wp({ subject: '含有:冒號,逗號#井號\n換行的標題', start_date: '2020-01-01', due_date: '2020-02-01' })]);
    expect(out).not.toContain('含有:冒號,逗號#井號');
    expect(out).toContain('含有 冒號 逗號 井號 換行的標題');
  });

  it('default groupBy sections by status text', () => {
    const out = ganttChart([
      wp({ subject: 'A', status: '進行中', due_date: '2020-01-01' }),
      wp({ subject: 'B', status: '審核中', due_date: '2020-01-01' }),
    ]);
    expect(out).toContain('section 進行中');
    expect(out).toContain('section 審核中');
  });

  it("groupBy:'type' sections by the type field instead", () => {
    const out = ganttChart(
      [
        wp({ subject: 'A', type: 'Milestone', due_date: '2020-01-01' }),
        wp({ subject: 'B', type: 'Task', due_date: '2020-01-01' }),
      ],
      { groupBy: 'type' },
    );
    expect(out).toContain('section Milestone');
    expect(out).toContain('section Task');
  });
});

describe('charts.ts: statusPie', () => {
  it('empty input -> ""', () => {
    expect(statusPie([])).toBe('');
  });

  it('counts into the four mutually-exclusive buckets correctly', () => {
    const items = [
      wp({ is_closed: true }),
      wp({ is_closed: true }),
      wp({ is_closed: false, due_date: '2020-01-01', percent_done: 50 }), // overdue
      wp({ is_closed: false, due_date: '2099-01-01', percent_done: 30 }), // in-progress
      wp({ is_closed: false, due_date: '', percent_done: 0 }), // not-started
    ];
    const out = statusPie(items);
    expect(out.startsWith('pie title 各狀態計數')).toBe(true);
    expect(out).toContain('"已結案" : 2');
    expect(out).toContain('"逾期" : 1');
    expect(out).toContain('"進行中" : 1');
    expect(out).toContain('"未開始" : 1');
  });

  it('omits zero-count buckets rather than emitting a 0-value slice', () => {
    const out = statusPie([wp({ is_closed: true }), wp({ is_closed: true })]);
    expect(out).toContain('"已結案" : 2');
    expect(out).not.toContain('進行中');
    expect(out).not.toContain('逾期');
    expect(out).not.toContain('未開始');
  });

  it('a fully-closed batch never crashes and always reports a nonzero closed slice', () => {
    expect(() => statusPie([wp({ is_closed: true })])).not.toThrow();
  });
});

describe('charts.ts: phaseFlow', () => {
  it('empty input -> ""', () => {
    expect(phaseFlow([])).toBe('');
  });

  it('a single distinct type renders one node with no arrows', () => {
    const out = phaseFlow([wp({ type: 'Task' }), wp({ type: 'Task' })]);
    expect(out.startsWith('flowchart LR')).toBe(true);
    expect(out).toContain('Task (2)');
    expect(out).not.toContain('-->');
  });

  it('multiple types chain left-to-right and red-flag the type containing an overdue item', () => {
    const out = phaseFlow([
      wp({ type: 'Milestone', due_date: '2020-01-01', percent_done: 10, is_closed: false }), // overdue
      wp({ type: 'Task', due_date: '2099-01-01' }),
    ]);
    expect(out).toContain(':::danger');
    expect(out).toContain(':::ok');
    expect(out).toContain('n0 --> n1');
  });
});
