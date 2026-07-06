import type { Task } from '../types.js';
import type { WorkItem } from './types.js';

/**
 * `tasks.source_ref` encoding: `${provider}:${repo}#${id}` (GitHub, repo-qualified since
 * issue numbers repeat across repos) or `${provider}:${id}` (ADO, org-unique ids). One
 * column carries both the provider and enough to reconstruct a minimal WorkItem for
 * pushback without a second lookup table.
 */
export function buildSourceRef(provider: 'github' | 'ado', item: WorkItem): string {
  return item.repo ? `${provider}:${item.repo}#${item.id}` : `${provider}:${item.id}`;
}

/** Recovers the provider name from a source_ref, e.g. 'github' from 'github:owner/name#123'. */
export function sourceRefProvider(sourceRef: string): string | null {
  const idx = sourceRef.indexOf(':');
  return idx > 0 ? sourceRef.slice(0, idx) : null;
}

/**
 * Reconstructs a minimal WorkItem from a stored source_ref for pushback — title/body are
 * backfilled from the task since the original item text isn't persisted. Returns null for
 * a malformed ref (never throws into a caller).
 */
export function parseSourceRef(sourceRef: string, task: Pick<Task, 'title'>): WorkItem | null {
  const idx = sourceRef.indexOf(':');
  if (idx <= 0) return null;
  const rest = sourceRef.slice(idx + 1);
  if (!rest) return null;
  const hashIdx = rest.lastIndexOf('#');
  const repo = hashIdx >= 0 ? rest.slice(0, hashIdx) : undefined;
  const id = hashIdx >= 0 ? rest.slice(hashIdx + 1) : rest;
  if (!id) return null;
  return { id, title: task.title, body: '', url: '', repo };
}
