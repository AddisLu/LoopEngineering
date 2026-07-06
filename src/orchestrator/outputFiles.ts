import fs from 'node:fs';
import path from 'node:path';

export interface OutputFile {
  /** Path relative to the output dir root (uses '/' even on Windows hosts). */
  name: string;
  size: number;
}

// Engine-written artifacts that are never part of a generic task's deliverable.
const SKIP_NAMES = new Set(['LOOP_TASK.md']);

/**
 * Recursively list files under `dir` (a generic task's persistent output dir), bounded
 * to `cap` entries. Dotfiles/dot-dirs (.claude, .git, loop-internal sentinels) and
 * LOOP_TASK.md are excluded — they are engine plumbing, not the task's output. Best
 * effort: an unreadable dir/file is silently skipped rather than throwing.
 */
export function listOutputFiles(dir: string, cap = 50): OutputFile[] {
  const out: OutputFile[] = [];
  function walk(curAbs: string, curRel: string): void {
    if (out.length >= cap) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(curAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries = entries.slice().sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (out.length >= cap) return;
      if (e.name.startsWith('.') || SKIP_NAMES.has(e.name)) continue;
      const abs = path.join(curAbs, e.name);
      const rel = curRel ? `${curRel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(abs, rel);
      } else if (e.isFile()) {
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          /* race with a concurrent write — best effort */
        }
        out.push({ name: rel, size });
      }
    }
  }
  walk(dir, '');
  return out;
}

const EXCERPT_EXT = /\.(md|txt|json|csv|ya?ml|log|py|js|ts|tsx|jsx|sh|html?)$/i;
const EXCERPT_MAX_FILE_SIZE = 4_000;
const EXCERPT_BUDGET = 8_000;
const EXCERPT_PER_FILE = 1_000;

/**
 * Bounded text description of a generic task's output dir for the LLM judge prompt
 * (no git diff exists for a repo-less task): a file listing plus small text-file
 * excerpts, capped so the prompt stays a reasonable size.
 */
export function buildFileListing(dir: string): string {
  const files = listOutputFiles(dir, 50);
  if (files.length === 0) return '(output dir is empty)';

  const lines = [`${files.length} file(s) under ${dir}:`, ...files.map((f) => `- ${f.name} (${f.size}B)`)];

  const excerpts: string[] = [];
  let budget = EXCERPT_BUDGET;
  for (const f of files) {
    if (budget <= 0) break;
    if (f.size === 0 || f.size > EXCERPT_MAX_FILE_SIZE || !EXCERPT_EXT.test(f.name)) continue;
    try {
      const full = fs.readFileSync(path.join(dir, ...f.name.split('/')), 'utf8');
      const take = full.slice(0, Math.min(EXCERPT_PER_FILE, budget));
      excerpts.push(`### ${f.name}\n${take}`);
      budget -= take.length;
    } catch {
      /* binary or unreadable — skip */
    }
  }

  return excerpts.length ? `${lines.join('\n')}\n\n${excerpts.join('\n\n')}` : lines.join('\n');
}
