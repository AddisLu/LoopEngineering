import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { createSource } from '../knowledge/ingest/sources.js';
import { ingestSource } from '../knowledge/ingest/ingest.js';
import {
  normalizeGithubUri,
  githubCloneDir,
  syncGithubSource,
  realGitSyncExec,
} from '../knowledge/ingest/github.js';
import type { DocumentRow, SourceRow } from '../knowledge/ingest/types.js';

// All remote interaction in this suite goes through file:// bare-origin fixtures with
// the real git binary — zero network, zero tokens (see CLAUDE.md test invariants).

let db: Database.Database;
let tmpRoots: string[] = [];
let savedToken: string | undefined;

function mkTmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-gh-${tag}-`));
  tmpRoots.push(d);
  return d;
}

beforeEach(() => {
  db = openTestDb();
  savedToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN; // hermetic: never pick up an ambient dev-shell token
});
afterEach(() => {
  db.close();
  if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = savedToken;
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
  tmpRoots = [];
});

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

/** Seed a work repo + bare origin; returns the file:// origin URL and the work dir. */
function makeOrigin(): { originUrl: string; work: string; bare: string } {
  const work = mkTmpDir('work');
  git(work, ['init', '-q', '-b', 'main']);
  git(work, ['config', 'user.email', 'test@example.com']);
  git(work, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(work, 'README.md'), '# hello from origin\n');
  fs.writeFileSync(path.join(work, 'src.ts'), 'export const x = 1;\n');
  git(work, ['add', '-A']);
  git(work, ['commit', '-q', '--no-verify', '-m', 'seed']);
  const bare = mkTmpDir('bare');
  git(work, ['clone', '-q', '--bare', work, path.join(bare, 'origin.git')]);
  return { originUrl: `file://${path.join(bare, 'origin.git')}`, work, bare };
}

function ghSource(uri: string, config: Record<string, unknown> = {}): SourceRow {
  return createSource(db, { kind: 'github', uri, config });
}

function activeDocs(sourceId: string): DocumentRow[] {
  return db
    .prepare(`SELECT * FROM documents WHERE source_id = ? AND invalid_at IS NULL ORDER BY path`)
    .all(sourceId) as DocumentRow[];
}

describe('normalizeGithubUri', () => {
  it('canonicalizes owner/repo, https (.git / trailing slash), and ssh forms', () => {
    for (const input of [
      'addislu/loopengineering',
      'https://github.com/addislu/loopengineering',
      'https://github.com/addislu/loopengineering.git',
      'https://github.com/addislu/loopengineering/',
      'git@github.com:addislu/loopengineering.git',
    ]) {
      const r = normalizeGithubUri(input);
      expect(r.webBase).toBe('https://github.com/addislu/loopengineering');
      expect(r.cloneUrl).toBe('https://github.com/addislu/loopengineering.git');
    }
  });

  it('passes non-GitHub clone URLs through verbatim with no webBase', () => {
    const r = normalizeGithubUri('file:///srv/repos/thing.git');
    expect(r.cloneUrl).toBe('file:///srv/repos/thing.git');
    expect(r.webBase).toBeNull();
  });
});

describe('githubCloneDir', () => {
  it('is stable per uri and distinct across uris', () => {
    const a = githubCloneDir('https://github.com/a/one');
    expect(githubCloneDir('https://github.com/a/one')).toBe(a);
    expect(githubCloneDir('https://github.com/a/two')).not.toBe(a);
    expect(a.startsWith(path.join(process.env.LOOP_DATA_DIR!, 'ingest-github'))).toBe(true);
  });
});

describe('syncGithubSource + ingestSource (file:// origin, real git)', () => {
  it('clones on first ingest and creates documents with local-uri fallback', async () => {
    const { originUrl } = makeOrigin();
    const source = ghSource(originUrl);
    const result = await ingestSource(db, source);
    expect(result.documents_created).toBe(2);
    const docs = activeDocs(source.id);
    expect(docs.map((d) => d.path)).toEqual(['README.md', 'src.ts']);
    // non-github.com remote -> uri points into the engine-owned clone
    expect(docs[0]!.uri).toBe(path.join(githubCloneDir(originUrl), 'README.md'));
  });

  it('re-ingest picks up new commits pushed to the origin', async () => {
    const { originUrl, work } = makeOrigin();
    const source = ghSource(originUrl);
    await ingestSource(db, source);

    fs.writeFileSync(path.join(work, 'README.md'), '# updated\n');
    git(work, ['commit', '-aqm', 'update readme']);
    git(work, ['push', '-q', originUrl, 'main']);

    const second = await ingestSource(db, source);
    expect(second.documents_replaced).toBe(1);
    expect(second.skipped_unchanged).toBe(1);
    const readme = activeDocs(source.id).find((d) => d.path === 'README.md')!;
    const clone = githubCloneDir(originUrl);
    expect(fs.readFileSync(path.join(clone, 'README.md'), 'utf8')).toBe('# updated\n');
    expect(readme.sha256).not.toBeNull();
  });

  it('honors config.branch: walks the requested branch, not the default', async () => {
    const { originUrl, work } = makeOrigin();
    git(work, ['checkout', '-qb', 'feature']);
    fs.writeFileSync(path.join(work, 'feature.md'), '# only on feature\n');
    git(work, ['add', '-A']);
    git(work, ['commit', '-qm', 'feature file']);
    git(work, ['push', '-q', originUrl, 'feature']);

    const source = ghSource(originUrl, { branch: 'feature' });
    await ingestSource(db, source);
    expect(activeDocs(source.id).map((d) => d.path)).toContain('feature.md');
  });

  it('unreachable origin with an existing clone degrades to stale content — nothing invalidated', async () => {
    const { originUrl, bare } = makeOrigin();
    const source = ghSource(originUrl);
    await ingestSource(db, source);

    fs.rmSync(bare, { recursive: true, force: true }); // origin gone
    const sync = syncGithubSource(db.prepare(`SELECT * FROM sources WHERE id = ?`).get(source.id) as SourceRow);
    expect(sync.stale).toBe(true);

    const result = await ingestSource(db, source);
    expect(result.documents_invalidated).toBe(0);
    expect(result.skipped_unchanged).toBe(2);
  });

  it('unreachable origin with no clone yet throws (nothing to walk)', () => {
    const source = ghSource('file:///nonexistent/nowhere.git');
    expect(() => syncGithubSource(source)).toThrow(/sync failed/);
  });

  it('github.com sources record web blob URLs on documents (sync exec injected)', async () => {
    const { originUrl } = makeOrigin();
    // Register the canonical github.com uri, but redirect the actual clone/fetch to the
    // local fixture: swap the github.com clone URL for the file:// origin in argv.
    const source = ghSource('https://github.com/addislu/loopengineering');
    const redirect = (args: string[], extraEnv?: Record<string, string>) =>
      realGitSyncExec(args.map((a) => (a === 'https://github.com/addislu/loopengineering.git' ? originUrl : a)), extraEnv);
    const result = await ingestSource(db, source, { gitSyncExec: redirect });
    expect(result.documents_created).toBe(2);
    const readme = activeDocs(source.id).find((d) => d.path === 'README.md')!;
    expect(readme.uri).toBe('https://github.com/addislu/loopengineering/blob/HEAD/README.md');
  });

  it('never persists GITHUB_TOKEN into the clone (auth rides on per-invocation env only)', async () => {
    const { originUrl } = makeOrigin();
    process.env.GITHUB_TOKEN = 'ghp_test_secret_token_0123456789abcdef0000';
    const seenEnvs: Array<Record<string, string> | undefined> = [];
    const spy = (args: string[], extraEnv?: Record<string, string>) => {
      seenEnvs.push(extraEnv);
      return realGitSyncExec(args, extraEnv);
    };
    const source = ghSource(originUrl);
    await ingestSource(db, source, { gitSyncExec: spy });
    // file:// remote -> no auth header at all
    expect(seenEnvs.every((e) => e === undefined)).toBe(true);
    const cloneConfig = fs.readFileSync(path.join(githubCloneDir(originUrl), '.git', 'config'), 'utf8');
    expect(cloneConfig).not.toContain('ghp_test_secret_token');
    expect(cloneConfig).not.toContain('extraheader');
  });
});
