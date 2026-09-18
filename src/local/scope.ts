import fs from 'node:fs';
import path from 'node:path';

/**
 * Run a long-lived host process outside this service's cgroup.
 *
 * `systemctl --user restart loop-engineering` kills the service's **entire** cgroup, detached
 * children included. That has bitten twice: a 24 GB docker pull died mid-download, and a deploy
 * killed the vLLM the operator was talking to (run-recipe.sh traps the signal and stops the
 * container). `systemd-run --scope` execs the command in a new transient scope under the user
 * manager, so the pid we get back is the command's own and it outlives us.
 */

let cached: boolean | null = null;

export function systemdRunAvailable(): boolean {
  if (cached == null) {
    cached = (process.env.PATH ?? '').split(':').some((d) => {
      try {
        fs.accessSync(path.join(d, 'systemd-run'), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  }
  return cached;
}

/** The same command, wrapped in a transient scope when the user manager is reachable. */
export function scopedCommand(
  cmd: string,
  args: string[],
  unit: string,
  env: NodeJS.ProcessEnv = process.env,
  hasSystemdRun = systemdRunAvailable,
): { cmd: string; args: string[] } {
  if (!env.XDG_RUNTIME_DIR || !hasSystemdRun()) return { cmd, args };
  return { cmd: 'systemd-run', args: ['--user', '--scope', '--quiet', '--collect', `--unit=${unit}`, '--', cmd, ...args] };
}

/** A unit name systemd accepts: ascii, no spaces, bounded. */
export function unitName(prefix: string, ...parts: string[]): string {
  const tail = parts.join('-').replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 80);
  return `${prefix}-${tail}`;
}
