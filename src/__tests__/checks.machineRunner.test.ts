import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { createMachine } from '../exec/machines.js';
import { realMachineRunner } from '../checks/machineRunner.js';
import type { HostExec } from '../exec/hosts.js';

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => db.close());

describe('the real machine runner behind the checks engine', () => {
  it('refuses unknown, disabled or never-checked machines with what to do', async () => {
    const calls: string[] = [];
    const exec: HostExec = async (cmd, args) => (calls.push([cmd, ...args].join(' ')), { code: 0, out: '' });
    const r = realMachineRunner(db, exec);
    expect((await r.run('nope', { cwd: '/x', command: 'true', timeoutMs: 1000 })).output).toContain('不存在');
    createMachine(db, { name: 'aoi-1', ssh_target: 'aoi@aoi-1', work_root: 'C:\\loop' });
    expect((await r.run('aoi-1', { cwd: 'C:\\loop', command: 'dir', timeoutMs: 1000 })).output).toContain('還沒檢查過');
    expect(calls).toEqual([]);
  });

  it('tries Gitea first and falls back to sending the tree when the box cannot fetch', async () => {
    createMachine(db, { name: 'lab', ssh_target: 'loop@lab', os: 'linux', work_root: '/srv/loop' });
    const calls: string[] = [];
    const exec: HostExec = async (cmd, args) => {
      const line = [cmd, ...args].join(' ');
      calls.push(line);
      if (cmd === 'ssh' && /fetch|clone/.test(line)) return { code: 128, out: 'fatal: could not read Username' };
      return { code: 0, out: '' };
    };
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-'));
    const r = realMachineRunner(db, exec);
    expect(r.osOf('lab')).toBe('linux');
    const res = await r.checkout('lab', { repoName: 'cf-aoi', remoteUrl: 'http://gitea.corp:3000/aoi/cf-aoi.git', sha: 'a'.repeat(40), branch: 'loop/t_1', localTree: tree });
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.startsWith('rsync'))).toBe(true);
  });
});
