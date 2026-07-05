import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { createTask } from '../tasks.js';
import { commitCheckpoint } from '../orchestrator/run.js';
import { excludeLocal, commitAll, isDirty } from '../git/worktree.js';
import { nearLimitEdge } from '../notify.js';
import { formatEvent, tailLog } from '../server/board.js';

let db: Database.Database;
let repo: string;

function git(args: string[], cwd = repo): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

beforeEach(() => {
  db = openTestDb();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-phase1-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(['add', '-A']);
  git(['commit', '-q', '--no-verify', '-m', 'seed']);
});
afterEach(() => {
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('interrupt checkpoint (item 1)', () => {
  it('commits a dirty worktree when interrupted by the breaker', () => {
    const t = createTask(db, { title: 'x', goal: 'g', verification_steps: ['true'], complexity: 'S' });
    // agent made an uncommitted edit, then the breaker fired
    fs.writeFileSync(path.join(repo, 'src.txt'), 'work in progress\n');
    expect(isDirty(repo)).toBe(true);

    const committed = commitCheckpoint(db, t, 'r_1', repo, 'breaker');
    expect(committed).toBe(true);
    expect(isDirty(repo)).toBe(false);

    const subject = git(['log', '-1', '--pretty=%s']).trim();
    expect(subject).toBe(`loop(${t.id}): checkpoint (interrupted: breaker)`);
    const files = git(['show', '--name-only', '--pretty=format:', 'HEAD']).trim();
    expect(files).toContain('src.txt');
  });

  it('is a no-op on a clean worktree', () => {
    const t = createTask(db, { title: 'x', goal: 'g', verification_steps: ['true'], complexity: 'S' });
    expect(commitCheckpoint(db, t, 'r_1', repo, 'timeout')).toBe(false);
    // still just the seed commit
    expect(git(['rev-list', '--count', 'HEAD']).trim()).toBe('1');
  });
});

describe('engine artifacts excluded from commits (item 7)', () => {
  it('keeps LOOP_TASK.md and .claude/settings.local.json out of git add -A', () => {
    // engine-written artifacts + a real source change
    fs.writeFileSync(path.join(repo, 'LOOP_TASK.md'), '# task\n');
    fs.mkdirSync(path.join(repo, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.claude', 'settings.local.json'), '{}\n');
    fs.writeFileSync(path.join(repo, 'feature.ts'), 'export const x = 1;\n');

    excludeLocal(repo, ['/LOOP_TASK.md', '/.claude/settings.local.json']);
    commitAll(repo, 'loop(t): auto-commit');

    const tree = git(['ls-tree', '-r', '--name-only', 'HEAD']);
    const files = tree.split('\n').map((s) => s.trim()).filter(Boolean);
    expect(files).toContain('feature.ts'); // real work is committed
    expect(files).not.toContain('LOOP_TASK.md');
    expect(files).not.toContain('.claude/settings.local.json');

    // the artifacts remain on disk (just ignored), so the agent can still read them
    expect(fs.existsSync(path.join(repo, 'LOOP_TASK.md'))).toBe(true);
  });

  it('is idempotent — repeated calls do not duplicate patterns', () => {
    excludeLocal(repo, ['/LOOP_TASK.md', '/.claude/settings.local.json']);
    excludeLocal(repo, ['/LOOP_TASK.md', '/.claude/settings.local.json']);
    const excludePath = git(['rev-parse', '--git-path', 'info/exclude']).trim();
    const abs = path.isAbsolute(excludePath) ? excludePath : path.join(repo, excludePath);
    const body = fs.readFileSync(abs, 'utf8');
    expect(body.split('\n').filter((l) => l.trim() === '/LOOP_TASK.md')).toHaveLength(1);
  });
});

describe('near-limit warning edge (item 5)', () => {
  const base = { hardLimitPct: 95, warnMarginPct: 5 }; // warn at 90

  it('fires once when session first crosses the threshold with a run active', () => {
    const r = nearLimitEdge({ ...base, sessionPct: 91, hasActiveRun: true, alreadyWarned: false });
    expect(r).toEqual({ fire: true, warned: true });
  });

  it('does not fire again while still above the threshold (no re-spam)', () => {
    const r = nearLimitEdge({ ...base, sessionPct: 93, hasActiveRun: true, alreadyWarned: true });
    expect(r).toEqual({ fire: false, warned: true });
  });

  it('does not fire above the threshold when nothing is running, but stays armed', () => {
    const r = nearLimitEdge({ ...base, sessionPct: 92, hasActiveRun: false, alreadyWarned: false });
    expect(r).toEqual({ fire: false, warned: false });
  });

  it('resets the edge once usage drops back below the threshold', () => {
    const r = nearLimitEdge({ ...base, sessionPct: 80, hasActiveRun: true, alreadyWarned: true });
    expect(r).toEqual({ fire: false, warned: false });
  });
});

describe('board tailLog tool activity (item 6a)', () => {
  it('formats tool_use blocks from stream-json assistant events', () => {
    expect(formatEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: 'src/foo.ts' } }] } }))
      .toEqual(['→ Edit src/foo.ts']);
    expect(formatEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }))
      .toEqual(['→ Bash: npm test']);
    expect(formatEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }] } }))
      .toEqual(['thinking']);
    // legacy/mock flat-text shape still handled
    expect(formatEvent({ type: 'assistant', text: 'working...' })).toEqual(['working...']);
    expect(formatEvent({ type: 'result', subtype: 'success' })).toEqual(['● result: success']);
    expect(formatEvent({ type: 'system', subtype: 'init' })).toEqual(['○ init']);
  });

  it('tails a real jsonl log, surfacing the latest tool calls', () => {
    const p = path.join(repo, 'run.jsonl');
    const lines = [
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'let me edit' }, { type: 'tool_use', name: 'Edit', input: { file_path: 'a.ts' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run typecheck' } }] } },
      { type: 'result', subtype: 'success' },
    ];
    fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const out = tailLog(p, 6);
    expect(out).toContain('→ Edit a.ts');
    expect(out).toContain('→ Bash: npm run typecheck');
    expect(out.at(-1)).toBe('● result: success');
  });
});
