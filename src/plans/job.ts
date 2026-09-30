import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { allowedRoots, probeRepo } from '../prd/repo.js';

export interface JobRepo {
  path: string;
  name: string;
  branch: string | null;
  branches: string[];
}

/**
 * The software an operator may pick when starting work (新工作流程, 對話操作): the git repos under
 * the knowledge sources / PRD allowlist, with their branches.
 */
export function listJobRepos(db: Database.Database): JobRepo[] {
  const out: JobRepo[] = [];
  for (const root of allowedRoots(db)) {
    try {
      const probe = probeRepo(db, root);
      if (!probe.is_git) continue;
      let remote: string[] = [];
      try {
        remote = execFileSync('git', ['-C', root, 'for-each-ref', '--count=100', '--format=%(refname:short)', 'refs/remotes/origin'], { encoding: 'utf8', timeout: 15_000 })
          .split('\n')
          .map((s) => s.trim().replace(/^origin\//, ''))
          .filter((s) => s && s !== 'HEAD' && s !== 'origin');
      } catch {
        remote = [];
      }
      out.push({ path: root, name: path.basename(root), branch: probe.branch, branches: [...new Set([...probe.branches, ...remote])].sort() });
    } catch {
      /* unreadable root: not offered */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
