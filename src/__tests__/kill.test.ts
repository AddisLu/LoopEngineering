import { describe, it, expect, vi } from 'vitest';
import { signalGroup } from '../orchestrator/kill.js';

// No real process is ever signaled: win32 exec is injected, POSIX process.kill is spied.

describe('signalGroup — win32 tree kill', () => {
  it('SIGKILL -> taskkill /PID <pid> /T /F', () => {
    const calls: Array<[string, string[]]> = [];
    const ok = signalGroup(1234, 'SIGKILL', { platform: 'win32', exec: (cmd, args) => calls.push([cmd, args]) });
    expect(ok).toBe(true);
    expect(calls).toEqual([['taskkill', ['/PID', '1234', '/T', '/F']]]);
  });

  it('SIGINT -> taskkill /PID <pid> /T (graceful, no /F)', () => {
    const calls: Array<[string, string[]]> = [];
    signalGroup(999, 'SIGINT', { platform: 'win32', exec: (cmd, args) => calls.push([cmd, args]) });
    expect(calls).toEqual([['taskkill', ['/PID', '999', '/T']]]);
  });
});

describe('signalGroup — POSIX (byte-identical to before)', () => {
  it('kills the process group with a negative pid', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true as never);
    try {
      const ok = signalGroup(4321, 'SIGINT', { platform: 'linux' });
      expect(ok).toBe(true);
      expect(spy).toHaveBeenCalledWith(-4321, 'SIGINT');
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to the single pid when the group kill throws', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(((p: number) => {
      if (p < 0) throw new Error('ESRCH');
      return true;
    }) as never);
    try {
      const ok = signalGroup(4321, 'SIGKILL', { platform: 'linux' });
      expect(ok).toBe(true);
      expect(spy).toHaveBeenCalledWith(-4321, 'SIGKILL');
      expect(spy).toHaveBeenCalledWith(4321, 'SIGKILL');
    } finally {
      spy.mockRestore();
    }
  });
});
