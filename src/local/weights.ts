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
 * Weights present and not mid-download. `hf download` links each finished file into
 * `snapshots/` and leaves `*.incomplete` blobs while fetching, so "some bytes on disk" is not
 * "usable": a half-pulled model must read as partial here, or the switcher offers it, vLLM
 * fails to load it, and the machine serves nothing. Same rule the ModelManager applies.
 */
export function weightsComplete(servedId: string, dir = hubDir()): boolean {
  const repo = repoDir(servedId, dir);
  try {
    if (fs.readdirSync(path.join(repo, 'snapshots')).length === 0) return false;
    return !fs.readdirSync(path.join(repo, 'blobs')).some((f) => f.endsWith('.incomplete'));
  } catch {
    return false;
  }
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
