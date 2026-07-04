import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Keep the host awake while there is work in flight. On Linux the host is also
 * configured to never sleep (systemctl mask sleep targets) as the primary guard;
 * this holds a `systemd-inhibit` idle/sleep block only while queued+running > 0.
 * No-op on non-Linux (Mac dev): there we rely on the OS staying awake.
 */
let inhibitor: ChildProcess | null = null;

export function updatePower(active: boolean): void {
  if (process.platform !== 'linux') return;
  if (active && !inhibitor) {
    try {
      inhibitor = spawn(
        'systemd-inhibit',
        ['--what=idle:sleep', '--who=loop-engineering', '--why=running tasks', '--mode=block', 'sleep', 'infinity'],
        { stdio: 'ignore', detached: false },
      );
      inhibitor.on('error', () => {
        inhibitor = null;
      });
      inhibitor.on('exit', () => {
        inhibitor = null;
      });
    } catch {
      inhibitor = null;
    }
  } else if (!active && inhibitor) {
    try {
      inhibitor.kill('SIGTERM');
    } catch {
      /* ignore */
    }
    inhibitor = null;
  }
}

export function releasePower(): void {
  updatePower(false);
}
