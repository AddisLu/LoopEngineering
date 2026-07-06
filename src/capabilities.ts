import type { Task } from './types.js';

/** Parsed `requires` CSV (case-insensitive tokens; `os:*`/`python:*` kept literal). */
export function parseRequires(task: Pick<Task, 'requires'>): string[] {
  return (task.requires ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseHostCaps(hostCaps: string): Set<string> {
  return new Set(
    hostCaps
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Capabilities a task `requires` that this host's `host_capabilities` setting does not
 * list — case-insensitive. Empty when `requires` is null/empty or every token is present
 * in `hostCaps`. `os:*`/`python:*` tokens are matched literally (the host must list the
 * exact same token, e.g. `os:windows`, to count as met).
 *
 * `extra` folds in additional required tokens beyond `task.requires` — e.g. the target
 * `environments` row's `capabilities` (see src/deploy/store.ts), so a task with
 * `environment='company'` inherits that environment's `os:windows` etc. into this check.
 */
export function unmetCapabilities(task: Pick<Task, 'requires'>, hostCaps: string, extra: string[] = []): string[] {
  const required = [...new Set([...parseRequires(task), ...extra])];
  if (required.length === 0) return [];
  const have = parseHostCaps(hostCaps);
  return required.filter((r) => !have.has(r.toLowerCase()));
}
