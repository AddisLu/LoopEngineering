import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { createSource } from '../knowledge/ingest/sources.js';

/**
 * The repo / stat endpoints feed the PRD wizard with facts about a repo on this host. They are
 * reachable by anyone on the tailnet, so the two properties that matter are: nothing outside an
 * allowed root is ever answered, and what is answered is names-of-directories and counts — never
 * file names, never contents.
 */

let db: Database.Database;
let app: FastifyInstance;
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

beforeEach(async () => {
  db = openTestDb();
  setSetting(db, 'prd_gate_enabled', 'true');
  setSetting(db, 'host_capabilities', 'gpu');
  app = buildApp({ db, apiToken: null });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
  for (const d of tmp) fs.rmSync(d, { recursive: true, force: true });
  tmp = [];
});

const get = (url: string) => app.inject({ method: 'GET', url });

describe('GET /api/prd/repo', () => {
  it('describes a registered repo: directories, branches, presets, capabilities — and no file names', async () => {
    const dir = gitRepo();
    createSource(db, { kind: 'git', uri: dir });

    const res = await get(`/api/prd/repo?path=${encodeURIComponent(dir)}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
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

  it('refuses anything outside an allowed root, until the allow-list says otherwise', async () => {
    const dir = gitRepo(); // exists, but is not registered as a source
    expect((await get(`/api/prd/repo?path=${encodeURIComponent(dir)}`)).statusCode).toBe(403);
    expect((await get('/api/prd/repo?path=/etc')).statusCode).toBe(403);
    expect((await get('/api/prd/repo?path=/definitely/not/here')).statusCode).toBe(404);
    expect((await get('/api/prd/repo?path=relative/path')).statusCode).toBe(403);
    expect((await get('/api/prd/repo')).statusCode).toBe(400);

    setSetting(db, 'prd_repo_allowlist', dir);
    expect((await get(`/api/prd/repo?path=${encodeURIComponent(dir)}`)).statusCode).toBe(200);
  });

  it('resolves symlinks before deciding, so a link inside a root cannot point outside it', async () => {
    const dir = gitRepo();
    createSource(db, { kind: 'git', uri: dir });
    const outside = mkTmp('outside');
    fs.symlinkSync(outside, path.join(dir, 'escape'));
    expect((await get(`/api/prd/repo?path=${encodeURIComponent(path.join(dir, 'escape'))}`)).statusCode).toBe(403);
    expect((await get(`/api/prd/repo?path=${encodeURIComponent(path.join(dir, '..'))}`)).statusCode).toBe(403);
  });

  it('is 404 while the PRD gate is off', async () => {
    setSetting(db, 'prd_gate_enabled', 'false');
    expect((await get('/api/prd/repo?path=/tmp')).statusCode).toBe(404);
  });
});

describe('GET /api/prd/stat', () => {
  it('counts images and result files without naming them', async () => {
    const dir = gitRepo();
    createSource(db, { kind: 'git', uri: dir });
    const imgs = path.join(dir, 'ip', 'output', 'run1');
    fs.mkdirSync(imgs, { recursive: true });
    for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(imgs, `frame${i}.png`), '');
    fs.writeFileSync(path.join(imgs, 'panel_R1_ResultInfo.json'), '{}');
    fs.writeFileSync(path.join(imgs, 'notes.txt'), '');

    const res = await get(`/api/prd/stat?path=${encodeURIComponent(imgs)}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ exists: true, kind: 'dir', images: 5, result_json: 1 });
    expect(JSON.stringify(res.json())).not.toContain('frame');

    expect((await get(`/api/prd/stat?path=${encodeURIComponent(path.join(imgs, 'notes.txt'))}`)).json()).toMatchObject({ kind: 'file' });
    expect((await get(`/api/prd/stat?path=${encodeURIComponent(path.join(dir, 'nope'))}`)).statusCode).toBe(404);
    expect((await get('/api/prd/stat?path=/etc')).statusCode).toBe(403);
  });
});
