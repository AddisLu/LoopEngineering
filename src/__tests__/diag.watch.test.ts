import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createRepo } from '../repo/store.js';
import { parseWatchDirs, scanWatchDirs } from '../diag/watch.js';
import { getReport } from '../diag/diagnose.js';
import { validateSetting } from '../settings.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'diag');
let db: Database.Database;
let dir: string;
beforeEach(() => {
  db = openTestDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-watch-'));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const chat = { localChat: (async () => ({ ok: true, content: '{"category":"data","confidence":"medium","summary":"上游 recipe 格式錯","causes":[],"suggestions":[]}' })) as never };

describe('機況監看', () => {
  it('new incident files become one diagnosed report; seen files are not read again; session-only files open nothing', async () => {
    const repo = createRepo(db, { name: 'cf-aoi', remote_url: 'http://g/aoi/cf-aoi', local_path: dir });
    const out = path.join(dir, 'IP01', '_diag');
    fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(path.join(FIX, 'incident_20260712_053710_819.json'), path.join(out, 'incident_20260712_053710_819.json'));
    setSetting(db, 'diag_watch_dirs', `cf-aoi=${dir}`);
    expect(parseWatchDirs(db, `cf-aoi=${dir}\n=${dir}\nrelative/path`)).toEqual([
      { repoId: repo.id, dir },
      { repoId: null, dir },
    ]);
    const first = await scanWatchDirs(db, { diagnose: chat, pull: () => undefined });
    expect(first).toHaveLength(1);
    const rep = getReport(db, first[0]!)!;
    expect(rep).toMatchObject({ source: 'watch', repo_id: repo.id, status: 'ready' });
    expect(rep.inputs.map((i) => i.name)).toEqual(['IP01/_diag/incident_20260712_053710_819.json']);
    expect(await scanWatchDirs(db, { diagnose: chat, pull: () => undefined })).toEqual([]);
    // a session-only day file: remembered, no report
    fs.writeFileSync(path.join(out, '20260713.jsonl'), '{"type":"session","ts":"2026-07-13T08:00:00","ip_name":"IP01","mode":"online"}\n');
    expect(await scanWatchDirs(db, { diagnose: chat, pull: () => undefined })).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM diag_seen').get()).toEqual({ n: 2 });
  });

  it('a git clone is pulled before reading; the setting is validated', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    setSetting(db, 'diag_watch_dirs', `=${dir}`);
    const pulled: string[] = [];
    await scanWatchDirs(db, { diagnose: chat, pull: (d) => pulled.push(d) });
    expect(pulled).toEqual([dir]);
    expect(validateSetting('diag_watch_dirs', 'cf-aoi=/srv/share/aoi\n=/mnt/diag')).toBeNull();
    expect(validateSetting('diag_watch_dirs', 'cf-aoi=relative')).toContain('absolute');
  });
});
