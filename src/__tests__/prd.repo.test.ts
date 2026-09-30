import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createSource } from '../knowledge/ingest/sources.js';
import { allowedRoots, probeRepo, resolveAllowed } from '../prd/repo.js';

/**
 * What the pages may learn about a repo on this host (the repo picker of 工作流程 / 對話操作, the
 * PRD helpers). Anyone on the tailnet can open those pages, so the two properties that matter are:
 * nothing outside an allowed root is ever resolved, and a probe answers with names of directories
 * and branches — never file names, never contents.
 */

let db: Database.Database;
let tmp: string[] = [];

const mkTmp = (tag: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-prd-${tag}-`));
  tmp.push(d);
  return d;
};

function gitRepo(): string {
  const dir = mkTmp('repo');
  const git = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'ip', 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.mkdirSync(path.join(dir, '.hidden'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# secret-ish\n');
  fs.writeFileSync(path.join(dir, 'ip', 'CMakeLists.txt'), 'project(x)\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'verify_rules_edge.py'), '#!/usr/bin/env python3\n');
  fs.writeFileSync(path.join(dir, 'scripts', 'helper.py'), '\n');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  git('branch', 'feature/x');
  return dir;
}

beforeEach(() => {
  db = openTestDb();
  setSetting(db, 'host_capabilities', 'gpu');
});
afterEach(() => {
  db.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp = [];
});

describe('probeRepo', () => {
  it('describes a registered repo: directories, branches, presets, capabilities — and no file names', () => {
    const dir = fs.realpathSync(gitRepo());
    createSource(db, { kind: 'git', uri: dir });
    const body = probeRepo(db, dir);
    expect(body).toMatchObject({ is_git: true, branch: 'main', host_capabilities: ['gpu'] });
    expect(body.branches).toEqual(expect.arrayContaining(['main', 'feature/x']));
    expect(body.dirs).toEqual(['ip', 'scripts']); // node_modules and dotdirs are noise
    expect(body.presets).toMatchObject({ npm_test: false, cmake: true, verify_scripts: ['verify_rules_edge.py'] });
    expect(body.registered).toMatchObject({ kind: 'git' });
    // the whole answer, serialised, must not carry file names other than the verify scripts
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('README');
    expect(raw).not.toContain('helper.py');
    expect(raw).not.toContain('secret');
  });
});

describe('resolveAllowed', () => {
  it('refuses anything outside an allowed root, until the allow-list says otherwise', () => {
    const dir = gitRepo(); // exists, but is not registered as a source
    expect(resolveAllowed(dir, allowedRoots(db))).toBeNull();
    expect(resolveAllowed('/etc', allowedRoots(db))).toBeNull();
    expect(resolveAllowed('/definitely/not/here', allowedRoots(db))).toBeNull();
    expect(resolveAllowed('relative/path', allowedRoots(db))).toBeNull();
    expect(resolveAllowed('', allowedRoots(db))).toBeNull();

    setSetting(db, 'prd_repo_allowlist', dir);
    expect(resolveAllowed(dir, allowedRoots(db))).toBe(fs.realpathSync(dir));
  });

  it('resolves symlinks before deciding, so a link inside a root cannot point outside it', () => {
    const dir = gitRepo();
    createSource(db, { kind: 'git', uri: dir });
    const outside = mkTmp('outside');
    fs.symlinkSync(outside, path.join(dir, 'escape'));
    expect(resolveAllowed(path.join(dir, 'escape'), allowedRoots(db))).toBeNull();
    expect(resolveAllowed(path.join(dir, '..'), allowedRoots(db))).toBeNull();
    expect(resolveAllowed(path.join(dir, 'ip'), allowedRoots(db))).toBe(path.join(fs.realpathSync(dir), 'ip'));
  });
});
