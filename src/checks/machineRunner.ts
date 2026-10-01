import type Database from 'better-sqlite3';
import { getMachine, type Machine } from '../exec/machines.js';
import { ensureCheckout, ensureDataset, osOf, pullBack, runRemote, withMachineLock } from '../exec/remote.js';
import { realHostExec, type HostExec } from '../exec/hosts.js';
import type { MachineRunner } from './runner.js';

/**
 * The checks engine's MachineRunner backed by the `machines` registry and the SSH runner
 * (src/exec/remote.ts). Getting the code there: the machine fetches the pushed branch from Gitea
 * itself (transport gitea), or the engine sends the tree (transport copy); with transport auto it
 * tries Gitea first when there is a remote and falls back to copying. Never throws.
 */
export function realMachineRunner(db: Database.Database, exec: HostExec = realHostExec): MachineRunner {
  const machine = (name: string): Machine | { error: string } => {
    const m = getMachine(db, name);
    if (!m) return { error: `機台 ${name} 不存在（到機台頁新增）` };
    if (!m.enabled) return { error: `機台 ${name} 已停用` };
    if (m.os === 'auto') return { error: `機台 ${name} 還沒檢查過（作業系統未知）：先在機台頁按「檢查」` };
    return m;
  };
  const fail = (out: string) => ({ ok: false, out, dir: '' });
  return {
    osOf: (name) => {
      const m = getMachine(db, name);
      return m && osOf(m) === 'windows' ? 'windows' : 'linux';
    },
    async checkout(name, req) {
      const m = machine(name);
      if ('error' in m) return fail(m.error);
      const wantGitea = m.transport === 'gitea' || (m.transport === 'auto' && !!req.remoteUrl);
      if (wantGitea && req.remoteUrl) {
        const r = await ensureCheckout(m, exec, { repoName: req.repoName, remoteUrl: req.remoteUrl, sha: req.sha, branch: req.branch, transport: 'gitea' });
        if (r.ok || m.transport === 'gitea') return r;
        const c = await ensureCheckout(m, exec, { repoName: req.repoName, remoteUrl: req.remoteUrl, sha: req.sha, branch: req.branch, transport: 'copy', localTree: req.localTree });
        return c.ok ? c : { ...c, out: `機台拿不到 Gitea（${r.out.slice(-300)}），改傳檔也失敗：${c.out}` };
      }
      return ensureCheckout(m, exec, { repoName: req.repoName, remoteUrl: req.remoteUrl ?? '', sha: req.sha, branch: req.branch, transport: 'copy', localTree: req.localTree });
    },
    async run(name, req) {
      const m = machine(name);
      if ('error' in m) return { ok: false, exitCode: null, timedOut: false, output: m.error, ms: 0 };
      return runRemote(m, exec, { cwd: req.cwd, command: req.command, timeoutMs: req.timeoutMs, env: req.env });
    },
    async dataset(name, ds) {
      const m = machine(name);
      if ('error' in m) return fail(m.error);
      return ensureDataset(m, exec, ds);
    },
    async pullBack(name, remotePaths, localDir) {
      const m = machine(name);
      if ('error' in m) return { ok: false, out: m.error };
      return pullBack(m, exec, remotePaths, localDir);
    },
    lock: (name, fn) => withMachineLock(name, fn),
  };
}
