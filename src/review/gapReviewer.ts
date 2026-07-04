import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { paths } from '../config.js';
import type { Task } from '../types.js';

const PROMPT = `You are doing a fast gap review of a just-completed change.
Read LOOP_TASK.md (the task) and the working-tree diff already present in this repo.
Output concise markdown: (1) does the change meet the stated goal? (2) unmet acceptance
criteria or verification gaps, (3) risks/regressions, (4) anything out of scope.
Be terse. Do NOT modify any files.`;

/**
 * Read-only gap review of a finished task, run as a separate short claude session
 * (Read/Grep/Glob only). Host-only and fully guarded — returns null on any problem so
 * it never blocks the task reaching review. Writes reviews/<task>.md.
 */
export function runGapReview(task: Task, worktreePath: string): string | null {
  if (task.coding_tool !== 'claude-code') return null;
  try {
    execFileSync('which', ['claude'], { stdio: 'ignore' });
  } catch {
    return null;
  }
  try {
    const out = execFileSync(
      'claude',
      [
        '-p',
        PROMPT,
        '--output-format',
        'json',
        '--permission-mode',
        'acceptEdits',
        '--allowed-tools',
        'Read',
        'Grep',
        'Glob',
      ],
      {
        cwd: worktreePath,
        encoding: 'utf8',
        timeout: 5 * 60_000,
        env: process.env,
      },
    );
    const text = extractText(out);
    if (!text) return null;
    fs.mkdirSync(paths.reviewsDir, { recursive: true });
    const p = path.join(paths.reviewsDir, `${task.id}.md`);
    fs.writeFileSync(p, text);
    return p;
  } catch {
    return null;
  }
}

function extractText(stdout: string): string | null {
  try {
    const j = JSON.parse(stdout);
    // `--output-format json` returns a single result object; field name may vary by
    // version, so probe the common ones.
    return j.result ?? j.text ?? j.content ?? null;
  } catch {
    return stdout.trim() || null;
  }
}
