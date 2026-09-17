import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { getSetting } from '../db/index.js';
import { listSources } from '../knowledge/ingest/sources.js';

/**
 * What the PRD wizard is allowed to learn about a repo on this host.
 *
 * Deliberately shallow: top-level directory names, git branch names, which build/test conventions
 * are present, and *counts* of images / result files under a path. Never file listings, never
 * file contents — the wizard runs in a browser that anyone on the tailnet can open, and the
 * repos hold production images and baseline results that must not leave the machine.
 *
 * Every path is realpath'ed and must sit inside an allowed root: an enabled git/folder knowledge
 * source, or an entry of the prd_repo_allowlist setting.
 */

export interface RepoPresets {
  npm_test: boolean;
  cmake: boolean;
  pytest: boolean;
  /** scripts/verify_*.py names — the repo's own end-to-end checks, offered as verify commands */
  verify_scripts: string[];
}

export interface RepoProbe {
  path: string;
  is_git: boolean;
  branch: string | null;
  branches: string[];
  registered: { source_id: string; kind: string } | null;
  dirs: string[];
  presets: RepoPresets;
  host_capabilities: string[];
}

export interface PathStat {
  exists: boolean;
  kind: 'dir' | 'file' | null;
  /** png/tif/tiff/bmp/jpg files directly inside (capped) */
  images: number;
  /** *_ResultInfo.json files directly inside */
  result_json: number;
}

/** `git <args>` in `cwd`; throws on failure. Injected by tests. */
export type GitExec = (args: string[], cwd: string) => string;

const defaultGit: GitExec = (args, cwd) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });

const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'output', '__pycache__', 'target', 'bin', 'obj']);
const IMAGE_RE = /\.(png|tiff?|bmp|jpe?g)$/i;
const COUNT_CAP = 10000;

const realpathOrNull = (p: string): string | null => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

/** Roots the wizard may read: enabled git/folder sources plus the allow-list setting. */
export function allowedRoots(db: Database.Database): string[] {
  const roots = new Set<string>();
  for (const s of listSources(db).filter((s) => s.enabled)) {
    if ((s.kind === 'git' || s.kind === 'folder') && s.uri && path.isAbsolute(s.uri)) {
      const real = realpathOrNull(s.uri);
      if (real) roots.add(real);
    }
  }
  for (const raw of (getSetting(db, 'prd_repo_allowlist') || '').split(',')) {
    const p = raw.trim();
    if (!p || !path.isAbsolute(p)) continue;
    const real = realpathOrNull(p);
    if (real) roots.add(real);
  }
  return [...roots];
}

/** realpath of `p` if it is inside one of `roots`, else null (symlinks resolved first). */
export function resolveAllowed(p: string, roots: string[]): string | null {
  if (!p || !path.isAbsolute(p)) return null;
  const real = realpathOrNull(p);
  if (!real) return null;
  for (const root of roots) {
    const rel = path.relative(root, real);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return real;
  }
  return null;
}

export function probeRepo(db: Database.Database, dir: string, git: GitExec = defaultGit): RepoProbe {
  let isGit = false;
  let branch: string | null = null;
  let branches: string[] = [];
  try {
    isGit = git(['rev-parse', '--is-inside-work-tree'], dir).trim() === 'true';
  } catch {
    isGit = false;
  }
  if (isGit) {
    try {
      branch = git(['symbolic-ref', '--short', 'HEAD'], dir).trim() || null;
    } catch {
      branch = null; // detached HEAD
    }
    try {
      branches = git(['for-each-ref', '--count=50', '--format=%(refname:short)', 'refs/heads'], dir)
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      branches = [];
    }
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name))
    .map((e) => e.name)
    .sort();
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  const cmakeAnywhere = has('CMakeLists.txt') || dirs.some((d) => fs.existsSync(path.join(dir, d, 'CMakeLists.txt')));
  let verifyScripts: string[] = [];
  try {
    verifyScripts = fs
      .readdirSync(path.join(dir, 'scripts'))
      .filter((f) => /^verify_.*\.py$/.test(f))
      .sort()
      .slice(0, 30);
  } catch {
    verifyScripts = [];
  }

  const registered = listSources(db).filter((s) => s.enabled).find((s) => realpathOrNull(s.uri) === dir);
  const caps = (getSetting(db, 'host_capabilities') || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  return {
    path: dir,
    is_git: isGit,
    branch,
    branches,
    registered: registered ? { source_id: registered.id, kind: registered.kind } : null,
    dirs,
    presets: {
      npm_test: has('package.json'),
      cmake: cmakeAnywhere,
      pytest: has('pytest.ini') || has('pyproject.toml') || has('tests') || has('test'),
      verify_scripts: verifyScripts,
    },
    host_capabilities: caps,
  };
}

/** Counts only — the point is "is this the image set I meant", not what is in it. */
export function statPath(p: string): PathStat {
  let st: fs.Stats;
  try {
    st = fs.statSync(p);
  } catch {
    return { exists: false, kind: null, images: 0, result_json: 0 };
  }
  if (!st.isDirectory()) return { exists: true, kind: 'file', images: 0, result_json: 0 };
  let images = 0;
  let resultJson = 0;
  for (const name of fs.readdirSync(p)) {
    if (IMAGE_RE.test(name)) images++;
    else if (/_ResultInfo\.json$/i.test(name)) resultJson++;
    if (images >= COUNT_CAP) break;
  }
  return { exists: true, kind: 'dir', images, result_json: resultJson };
}
