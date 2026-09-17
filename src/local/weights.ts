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

export interface WeightInfo {
  downloaded: boolean;
  disk_bytes: number | null;
}

export function weightInfo(servedId: string, dir = hubDir()): WeightInfo {
  const bytes = weightsBytes(servedId, dir);
  return { downloaded: bytes != null, disk_bytes: bytes };
}
