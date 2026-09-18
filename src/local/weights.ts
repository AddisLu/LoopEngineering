import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where a local model's weights live on this machine.
 *
 * Switching models from the UI is only safe if the page can tell "already downloaded" from
 * "would pull 100 GB first", so both the model list (src/server/localRoutes.ts) and the chat
 * stats panel (src/server/chatRoutes.ts) read the size from the same place: the HF cache.
 */

export function hubDir(): string {
  return (
    process.env.HF_HUB_CACHE ??
    path.join(process.env.HF_HOME ?? path.join(os.homedir(), '.cache', 'huggingface'), 'hub')
  );
}

/** '<hub>/models--org--name' for a served model id ('org/name'). */
export function repoDir(servedId: string, dir = hubDir()): string {
  return path.join(dir, `models--${servedId.replace(/\//g, '--')}`);
}

/**
 * Total size of the cached blobs, or null when this model is not in the cache. Symlinked
 * snapshots point back at the blobs, so summing blobs counts each file once.
 */
export function weightsBytes(servedId: string, dir = hubDir()): number | null {
  try {
    const blobs = path.join(repoDir(servedId, dir), 'blobs');
    const total = fs.readdirSync(blobs).reduce((sum, f) => {
      try {
        return sum + fs.statSync(path.join(blobs, f)).size;
      } catch {
        return sum; // a dangling entry mid-download
      }
    }, 0);
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

/**
 * The revision vLLM will actually load: `refs/main` when it is there, else the newest snapshot.
 *
 * This matters because a repo can publish a new revision at any time. When that happened to
 * Qwen3.8-Flash-Next, the cache held the new revision's config files but none of its 36 weight
 * shards — the old "any snapshot + no *.incomplete blob" rule still said "downloaded", so the
 * switcher offered it, vLLM resolved the new revision and started re-pulling ~100 GB over Wi-Fi
 * in the middle of a switch, and the machine ended up serving nothing.
 */
export function currentRevision(repo: string): string | null {
  const snapshots = path.join(repo, 'snapshots');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(snapshots).filter((d) => fs.statSync(path.join(snapshots, d)).isDirectory());
  } catch {
    return null;
  }
  if (!dirs.length) return null;
  try {
    const ref = fs.readFileSync(path.join(repo, 'refs', 'main'), 'utf8').trim();
    if (ref && dirs.includes(ref)) return ref;
  } catch {
    /* no refs/main — fall through to the newest snapshot */
  }
  return dirs
    .map((d) => ({ d, at: fs.statSync(path.join(snapshots, d)).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0]!.d;
}

const WEIGHT_RE = /\.(safetensors|bin|gguf|pt|pth)$/i;

/**
 * Are the weights this deployment would load actually on disk?
 *
 * Checked against the revision above, not the cache as a whole: every file a shard index names
 * must exist (hf only links a file into the snapshot once it finished, so a half-pulled shard is
 * simply absent), and there must be at least one weight file. Leftover `*.incomplete` blobs from
 * an abandoned revision therefore no longer make a perfectly good model look half-downloaded.
 */
export function weightsComplete(servedId: string, dir = hubDir()): boolean {
  const repo = repoDir(servedId, dir);
  const rev = currentRevision(repo);
  if (!rev) return false;
  const snap = path.join(repo, 'snapshots', rev);
  let entries: string[];
  try {
    entries = fs.readdirSync(snap);
  } catch {
    return false;
  }
  if (!entries.some((f) => WEIGHT_RE.test(f))) return false;
  for (const index of entries.filter((f) => /\.index\.json$/i.test(f))) {
    let map: Record<string, unknown>;
    try {
      map = (JSON.parse(fs.readFileSync(path.join(snap, index), 'utf8')) as { weight_map?: Record<string, unknown> }).weight_map ?? {};
    } catch {
      continue; // unreadable index: fall back to "there are weight files"
    }
    for (const file of new Set(Object.values(map).map(String))) {
      if (!fs.existsSync(path.join(snap, file))) return false;
    }
  }
  return true;
}

export interface WeightInfo {
  /** fully in the cache — switching will not pull tens of GB first */
  downloaded: boolean;
  /** some blobs on disk but not usable yet (interrupted download — resumable) */
  partial: boolean;
  disk_bytes: number | null;
}

export function weightInfo(servedId: string, dir = hubDir()): WeightInfo {
  const bytes = weightsBytes(servedId, dir);
  const complete = bytes != null && weightsComplete(servedId, dir);
  return { downloaded: complete, partial: bytes != null && !complete, disk_bytes: bytes };
}
