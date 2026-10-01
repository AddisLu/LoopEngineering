import type { RepoCtx } from './context.js';
import type { Hotspot } from './types.js';

/**
 * 熱點: the files the last 500 commits touched most, fix commits first — where bugs live.
 * One `git log --name-only`; files no longer tracked are dropped.
 */

const FIX_RE = /\bfix|修|bug|hotfix|錯誤/i;
/** prose, not code: a STATUS.md every commit touches says nothing about where bugs live */
const DOC_RE = /\.(md|markdown|rst|txt|adoc)$|^docs?\//i;
const RS = '\x1e';
const US = '\x1f';

export function analyseHotspots(ctx: RepoCtx, limit = 15): Hotspot[] {
  let out = '';
  try {
    out = ctx.git(['-c', 'core.quotepath=false', 'log', '-n', '500', '--no-merges', '--name-only', `--format=${RS}%cI${US}%s`], ctx.dir);
  } catch (e) {
    ctx.warnings.push(`git log 失敗：${(e as Error).message.split('\n')[0]}`);
    return [];
  }
  const stats = new Map<string, Hotspot>();
  for (const rec of out.split(RS)) {
    if (!rec.trim()) continue;
    const lines = rec.split('\n');
    const [date, subject = ''] = lines[0]!.split(US);
    const fix = FIX_RE.test(subject);
    for (const f of new Set(lines.slice(1).map((l) => l.trim()).filter(Boolean))) {
      if (!ctx.fileSet.has(f) || DOC_RE.test(f)) continue;
      let h = stats.get(f);
      if (!h) {
        // log is newest first: the first time a file shows up is its last change
        h = { file: f, commits: 0, fix_commits: 0, last: date?.trim() || null };
        stats.set(f, h);
      }
      h.commits++;
      if (fix) h.fix_commits++;
    }
  }
  return [...stats.values()].sort((a, b) => b.fix_commits - a.fix_commits || b.commits - a.commits || a.file.localeCompare(b.file)).slice(0, limit);
}
