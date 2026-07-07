import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createSource } from '../knowledge/ingest/sources.js';
import { pumpIngest } from '../knowledge/ingest/pump.js';

let db: Database.Database;
let tmpRoots: string[] = [];

beforeEach(() => {
  db = openTestDb();
});
afterEach(() => {
  db.close();
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
  tmpRoots = [];
});

function mkTmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-pump-${tag}-`));
  tmpRoots.push(d);
  return d;
}

function activeDocCount(sourceId: string): number {
  return (
    db.prepare(`SELECT count(*) n FROM documents WHERE source_id = ? AND invalid_at IS NULL`).get(sourceId) as {
      n: number;
    }
  ).n;
}

describe('pumpIngest', () => {
  it('is a no-op (cursor unchanged, nothing ingested) when ingest_auto_pump is off — the default', async () => {
    const root = mkTmpDir('off');
    fs.writeFileSync(path.join(root, 'a.md'), '# A\nbody\n');
    const source = createSource(db, { kind: 'folder', uri: root });

    const next = await pumpIngest(db, 0, 1_000_000);
    expect(next).toBe(0);
    expect(activeDocCount(source.id)).toBe(0);
  });

  it('skips a run before the interval has elapsed, even when enabled', async () => {
    setSetting(db, 'ingest_auto_pump', 'true');
    setSetting(db, 'ingest_pump_interval_min', '30');
    const root = mkTmpDir('early');
    fs.writeFileSync(path.join(root, 'a.md'), '# A\nbody\n');
    const source = createSource(db, { kind: 'folder', uri: root });

    const lastRunAt = 1_000_000;
    const tooSoon = lastRunAt + 5 * 60_000; // 5 min later, interval is 30 min
    const next = await pumpIngest(db, lastRunAt, tooSoon);
    expect(next).toBe(lastRunAt);
    expect(activeDocCount(source.id)).toBe(0);
  });

  it('runs ingestAll and advances the cursor once the interval elapses', async () => {
    setSetting(db, 'ingest_auto_pump', 'true');
    setSetting(db, 'ingest_pump_interval_min', '30');
    const root = mkTmpDir('due');
    fs.writeFileSync(path.join(root, 'a.md'), '# A\nbody\n');
    const source = createSource(db, { kind: 'folder', uri: root });

    const lastRunAt = 1_000_000;
    const due = lastRunAt + 31 * 60_000;
    const next = await pumpIngest(db, lastRunAt, due);
    expect(next).toBe(due);
    expect(activeDocCount(source.id)).toBe(1);
  });

  it('runs immediately when lastRunAtMs is 0 (server just (re)started), regardless of the interval', async () => {
    setSetting(db, 'ingest_auto_pump', 'true');
    const root = mkTmpDir('startup');
    fs.writeFileSync(path.join(root, 'a.md'), '# A\nbody\n');
    const source = createSource(db, { kind: 'folder', uri: root });

    // a realistic wall-clock "now" (like Date.now() at server start) is always far past
    // any lastRunAtMs=0 baseline, unlike this suite's other small fake timestamps.
    const now = 1_800_000_000_000;
    const next = await pumpIngest(db, 0, now);
    expect(next).toBe(now);
    expect(activeDocCount(source.id)).toBe(1);
  });
});
