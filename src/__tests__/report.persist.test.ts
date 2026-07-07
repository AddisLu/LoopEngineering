import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { persistReport } from '../report/persist.js';

function fakeFns() {
  const mkdirs: string[] = [];
  const written: Record<string, string> = {};
  return {
    mkdirs,
    written,
    fns: {
      mkdir: (d: string) => mkdirs.push(d),
      writeFile: (p: string, content: string) => {
        written[p] = content;
      },
    },
  };
}

const BASE_INPUT = {
  outputDir: '/data/reports',
  project: '大型AOI',
  topic: 'PR 最新進度',
  markdown: '# 報告內容',
  items: [{ id: 1, subject: 'x' } as unknown as { id: number; subject: string }],
  charts: [
    { kind: 'gantt', mmd: 'gantt\n  dateFormat YYYY-MM-DD' },
    { kind: 'pie', mmd: 'pie title x' },
  ],
};

describe('persist.ts: persistReport', () => {
  it('writes markdown + WP snapshot JSON + one .mmd per chart into a dated, project-sliced folder', () => {
    const { mkdirs, written, fns } = fakeFns();
    const result = persistReport(BASE_INPUT, fns);
    expect(result).not.toBeNull();
    const today = new Date().toISOString().slice(0, 10);
    const expectedDir = path.join('/data/reports', '大型AOI', `${today}-PR-最新進度`);
    expect(result!.dir).toBe(expectedDir);
    expect(mkdirs).toEqual([expectedDir]);
    expect(result!.files).toHaveLength(4); // report.md + workpackages.json + gantt.mmd + pie.mmd

    const mdPath = path.join(expectedDir, 'report.md');
    expect(written[mdPath]).toBe('# 報告內容');
    const snapshotPath = path.join(expectedDir, 'workpackages.json');
    expect(JSON.parse(written[snapshotPath])).toEqual(BASE_INPUT.items);
    expect(written[path.join(expectedDir, 'gantt.mmd')]).toBe('gantt\n  dateFormat YYYY-MM-DD');
    expect(written[path.join(expectedDir, 'pie.mmd')]).toBe('pie title x');
  });

  it('sanitizes filesystem-unsafe characters out of the project/topic path segments', () => {
    const { fns, mkdirs } = fakeFns();
    persistReport({ ...BASE_INPUT, project: '大型/AOI:專案', topic: '進度?報告"更新' }, fns);
    expect(mkdirs).toHaveLength(1);
    // the two segments persistReport itself builds (project, date-topic) — not outputDir,
    // which is passed through untouched — must contain no raw unsafe characters.
    const rel = path.relative(BASE_INPUT.outputDir, mkdirs[0]);
    const [projectSeg, dateTopicSeg] = rel.split(path.sep);
    expect(projectSeg).not.toMatch(/[/\\:*?"<>|]/);
    expect(dateTopicSeg).not.toMatch(/[/\\:*?"<>|]/);
    expect(projectSeg).toContain('AOI');
  });

  it('falls back to placeholder names when project/topic are blank', () => {
    const { fns, mkdirs } = fakeFns();
    persistReport({ ...BASE_INPUT, project: '', topic: '' }, fns);
    expect(mkdirs[0]).toContain('未分類專案');
    expect(mkdirs[0]).toMatch(/-報告$/);
  });

  it('a write failure (e.g. permission error) is caught and logged, returning null rather than throwing', () => {
    const fns = {
      mkdir: () => {
        throw new Error('EACCES');
      },
      writeFile: () => {},
    };
    expect(() => persistReport(BASE_INPUT, fns)).not.toThrow();
    expect(persistReport(BASE_INPUT, fns)).toBeNull();
  });

  it('no charts -> only the two base files (markdown + snapshot) are written', () => {
    const { fns } = fakeFns();
    const result = persistReport({ ...BASE_INPUT, charts: [] }, fns);
    expect(result!.files).toHaveLength(2);
  });
});
