import { describe, it, expect } from 'vitest';
import { rollOver } from '../token/usage.js';
import { tick } from '../scheduler/tick.js';
import { openTestDb } from '../db/index.js';
import { createTask, setStatus } from '../tasks.js';
import { setCachedUsage } from '../token/usage.js';

describe('an old cached usage reading', () => {
  it('a window whose reset has passed counts as reset; a later one counts from now', () => {
    const now = Date.parse('2026-10-02T09:58:00Z');
    const r = rollOver(
      {
        ok: true,
        subscription: 'max',
        fetchedAt: '2026-09-30T06:30:29Z',
        session: { percent: 88, resetsAt: '2026-09-30T07:30:00Z', resetsInMinutes: 60, severity: 'warning' },
        weekly: { percent: 34, resetsAt: '2026-10-04T21:00:00Z', resetsInMinutes: 6630, severity: 'normal' },
        source: 'cache',
      },
      now,
    );
    expect(r.session).toEqual({ percent: 0, resetsAt: null, resetsInMinutes: null, severity: 'unknown' });
    expect(r.weekly.percent).toBe(34);
    expect(r.weekly.resetsInMinutes).toBe(3542); // from 10/02 09:58, not the 6630 stored two days ago
  });

  it('an expired login holds cloud dispatch with a reason (local tasks are not affected)', async () => {
    const db = openTestDb();
    setCachedUsage(10, 10);
    const t = createTask(db, { title: 'x', goal: 'y', coding_tool: 'claude-code', verification_steps: ['true'], complexity: 'S' });
    setStatus(db, t.id, 'queued');
    const started: string[] = [];
    const r = await tick(db, { inflightCount: () => 0, startRun: (task) => started.push(task.id), authExpired: () => true });
    expect(started).toEqual([]);
    expect(r.reason).toBe('auth expired: Claude Code login on this host');
    db.close();
  });
});
