import { execFile } from 'node:child_process';

/**
 * git without blocking the event loop. The engine's close-out uses execFileSync with short
 * timeouts; 對話操作 runs git on request — a clone may take minutes — and must never stall the
 * tick loop or the API while it does. Never prompts: no terminal, ssh in batch mode.
 */

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly stderr: string,
    readonly timedOut: boolean,
  ) {
    super(message);
  }
}

export interface GitOptions {
  timeoutMs: number;
  env?: Record<string, string>;
  /** restrict transports (GIT_ALLOW_PROTOCOL), e.g. 'https:ssh' for a clone of a URL someone typed */
  allowProtocols?: string;
}

/** Credentials in a URL (https://user:token@host/…) never reach a message or a log. */
export function redactUrl(s: string): string {
  return String(s ?? '').replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/gi, '$1***@');
}

export function gitAsync(cwd: string, args: string[], o: GitOptions): Promise<{ stdout: string; stderr: string }> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o ConnectTimeout=15',
    LC_ALL: 'C',
    ...(o.allowProtocols ? { GIT_ALLOW_PROTOCOL: o.allowProtocols } : {}),
    ...(o.env ?? {}),
  };
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, timeout: o.timeoutMs, maxBuffer: 16 * 1024 * 1024, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
        const timedOut = Boolean(e.killed) && e.code == null;
        const msg = redactUrl(String(stderr || e.message || '').trim().split('\n').slice(-6).join('\n')) || `git ${args[0]} failed`;
        reject(new GitError(timedOut ? `git ${args[0]} 逾時（${Math.round(o.timeoutMs / 1000)} 秒）` : msg, typeof e.code === 'number' ? e.code : null, String(stderr ?? ''), timedOut));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
