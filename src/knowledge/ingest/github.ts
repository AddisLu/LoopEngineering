import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { paths } from '../../config.js';
import type { SourceRow } from './types.js';
import { parseSourceConfig } from './types.js';

/** Same budget as the network git calls in src/git/integrate.ts — a hung clone/fetch
 * must never block an ingest run (or the tick-loop auto-pump that drives it). */
const NET_TIMEOUT = 30_000;

export interface GithubRemote {
  /** URL git can clone/fetch from. */
  cloneUrl: string;
  /** `https://github.com/<owner>/<repo>` when the uri is recognizably github.com,
   * else null (non-GitHub remotes — e.g. file:// fixtures in tests — still sync). */
  webBase: string | null;
}

const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HTTPS_GITHUB = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
const SSH_GITHUB = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/;

/** Accepts `owner/repo`, an https github.com URL, or an ssh github.com URL — all
 * normalize to the https clone URL (tokens ride on a header, never in the URL). Any
 * other string passes through verbatim as a clone URL with no webBase. */
export function normalizeGithubUri(input: string): GithubRemote {
  const raw = input.trim();
  let owner: string | undefined;
  let repo: string | undefined;
  if (OWNER_REPO.test(raw)) {
    const [o, r] = raw.split('/');
    owner = o;
    repo = r?.replace(/\.git$/, '');
  } else {
    const m = HTTPS_GITHUB.exec(raw) ?? SSH_GITHUB.exec(raw);
    if (m) {
      owner = m[1];
      repo = m[2];
    }
  }
  if (owner && repo) {
    const webBase = `https://github.com/${owner}/${repo}`;
    return { cloneUrl: `${webBase}.git`, webBase };
  }
  return { cloneUrl: raw, webBase: null };
}

/** Injectable so tests never hit the network — the suite drives the real git binary
 * against file:// bare-origin fixtures instead. extraEnv carries the auth config
 * (GIT_CONFIG_* vars), kept out of argv so the token never shows up in a process
 * listing or an error message. */
export type GitSyncExec = (args: string[], extraEnv?: Record<string, string>) => string;

export const realGitSyncExec: GitSyncExec = (args, extraEnv) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    timeout: NET_TIMEOUT,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });

/** Auth for private repos: GITHUB_TOKEN from process.env (same convention as
 * src/integrations/config.ts — credentials live in the environment, never the DB,
 * never logged). Injected per-invocation via GIT_CONFIG_* so nothing is ever written
 * to the clone's .git/config. Only meaningful for https remotes; harmless otherwise. */
function authEnv(cloneUrl: string): Record<string, string> | undefined {
  const token = process.env.GITHUB_TOKEN;
  if (!token || !cloneUrl.startsWith('https://')) return undefined;
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraheader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

/** Stable per-source clone location under the engine data dir: readable prefix +
 * content hash so distinct uris can never collide after sanitizing. */
export function githubCloneDir(uri: string): string {
  const slug = uri.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  const hash = crypto.createHash('sha256').update(uri).digest('hex').slice(0, 8);
  return path.join(paths.dataDir, 'ingest-github', `${slug || 'repo'}-${hash}`);
}

export interface GithubSyncResult {
  /** Local clone directory — walk this like a 'git' source. */
  dir: string;
  webBase: string | null;
  /** Ref that was synced ('HEAD' = the remote's default branch). */
  ref: string;
  /** True when the remote was unreachable and an existing clone is being reused as-is. */
  stale: boolean;
}

/**
 * Brings the engine-owned clone of a kind='github' source up to date: first run clones
 * (shallow), later runs fetch the configured ref and hard-sync the working tree to
 * FETCH_HEAD. The forced checkout is fine here — this directory lives under the engine
 * data dir, is written by nobody else, and is NOT the user's checkout (the no-force
 * invariant protects user checkouts, not this cache). Degrades instead of breaking the
 * ingest run: an unreachable remote with an existing clone returns stale=true and the
 * last-synced content is walked (never invalidating documents on a network blip); with
 * no clone yet there is nothing to walk, so the error propagates.
 */
export function syncGithubSource(source: SourceRow, exec: GitSyncExec = realGitSyncExec): GithubSyncResult {
  const config = parseSourceConfig(source.config);
  const remote = normalizeGithubUri(source.uri);
  const dir = githubCloneDir(source.uri);
  const ref = config.branch || 'HEAD';
  const hasClone = fs.existsSync(path.join(dir, '.git'));
  const env = authEnv(remote.cloneUrl);
  try {
    if (!hasClone) {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      const branchArgs = config.branch ? ['--branch', config.branch] : [];
      exec(['clone', '--depth', '1', ...branchArgs, remote.cloneUrl, dir], env);
    } else {
      exec(['-C', dir, 'fetch', '--depth', '1', 'origin', ref], env);
      exec(['-C', dir, 'checkout', '--force', '--detach', 'FETCH_HEAD']);
    }
    return { dir, webBase: remote.webBase, ref, stale: false };
  } catch (e) {
    if (hasClone) return { dir, webBase: remote.webBase, ref, stale: true };
    throw new Error(`github source ${source.id} (${source.uri}): sync failed — ${(e as Error).message}`);
  }
}
