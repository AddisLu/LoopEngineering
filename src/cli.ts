#!/usr/bin/env node
import { Command } from 'commander';
import { getDb, getSetting, setSetting, getBool } from './db/index.js';
import {
  createTask,
  getTask,
  listTasks,
  setStatus,
  countByStatus,
  activeRuns,
} from './tasks.js';
import { validateTask } from './gate/validateTask.js';
import { readUsage, setCachedUsage } from './token/usage.js';
import { killRun } from './orchestrator/kill.js';
import { DEFAULT_SETTINGS, type Complexity } from './config.js';
import { validateSetting } from './settings.js';

const program = new Command();
program.name('loop').description('Loop Engineering — token-aware coding-task scheduler').version('0.1.0');

program
  .command('add')
  .description('create a task (starts in draft)')
  .requiredOption('--title <title>')
  .requiredOption('--goal <goal>')
  .option('--plan <ref>', 'plan .md/.html path or URL')
  .option('--tool <tool>', 'claude-code | mock', 'claude-code')
  .option('--verify <steps>', 'comma-separated verification commands')
  .option('--setup <cmd>', 'setup command run in worktree before dispatch')
  .option('--repo <path>', 'git repo path')
  .option('--base <branch>', 'base branch')
  .option('--complexity <SML>', 'S|M|L', 'M')
  .option('--priority <n>', 'integer priority', (v) => parseInt(v, 10), 2)
  .option('--model <model>', 'sonnet|opus|default')
  .action((o) => {
    const db = getDb();
    const kind = o.plan
      ? /^https?:\/\//i.test(o.plan)
        ? 'url'
        : /\.html?$/i.test(o.plan)
          ? 'html'
          : 'md'
      : null;
    const t = createTask(db, {
      title: o.title,
      goal: o.goal,
      plan_ref: o.plan ?? null,
      plan_kind: kind,
      coding_tool: o.tool,
      verification_steps: o.verify ? String(o.verify).split(',').map((s: string) => s.trim()) : [],
      setup_cmd: o.setup ?? null,
      repo_path: o.repo ?? null,
      base_branch: o.base ?? null,
      complexity: o.complexity as Complexity,
      priority: o.priority,
      model: o.model ?? null,
    });
    const gate = validateTask(getTask(db, t.id)!);
    console.log(`created ${t.id} (${t.status})`);
    printGate(gate);
  });

program
  .command('gate <id>')
  .description('show the intake checklist for a task')
  .action((id) => {
    const db = getDb();
    const t = getTask(db, id);
    if (!t) return fail(`no such task: ${id}`);
    printGate(validateTask(t));
  });

program
  .command('queue <id>')
  .description('validate + enqueue a draft task')
  .action((id) => {
    const db = getDb();
    const t = getTask(db, id);
    if (!t) return fail(`no such task: ${id}`);
    const gate = validateTask(t);
    if (!gate.ok) {
      console.log('cannot queue — gate not satisfied:');
      printGate(gate);
      process.exitCode = 1;
      return;
    }
    setStatus(db, id, 'queued', { detail: 'queued via cli' });
    console.log(`${id} -> queued`);
  });

program
  .command('list')
  .description('list tasks (optionally by status)')
  .option('--status <status>')
  .action((o) => {
    const db = getDb();
    const rows = listTasks(db, o.status);
    for (const t of rows) {
      console.log(
        `${t.id}  ${pad(t.status, 10)} ${t.complexity} P${t.priority}  ${t.title}`,
      );
    }
    console.log('\ncounts:', JSON.stringify(countByStatus(db)));
  });

program
  .command('status')
  .description('scheduler + token status')
  .action(() => {
    const db = getDb();
    const u = readUsage();
    console.log(`paused: ${getBool(db, 'scheduler_paused')}`);
    console.log(`session: ${u.session.percent}%  weekly: ${u.weekly.percent}%  (source=${u.source})`);
    console.log(`counts: ${JSON.stringify(countByStatus(db))}`);
    const runs = activeRuns(db);
    if (runs.length) {
      console.log('active runs:');
      for (const r of runs) console.log(`  ${r.id} task=${r.task_id} pid=${r.pid}`);
    }
  });

program
  .command('pause')
  .description('pause the scheduler (blocks new dispatch)')
  .option('--hard', 'also interrupt running tasks (-> blocked, resumable)')
  .action((o) => {
    const db = getDb();
    setSetting(db, 'scheduler_paused', 'true');
    console.log('scheduler paused');
    if (o.hard) {
      for (const r of activeRuns(db)) {
        killRun(db, { id: r.id, pid: r.pid }, 'user');
        console.log(`  interrupted run ${r.id}`);
      }
    }
  });

program
  .command('resume')
  .description('resume the scheduler')
  .action(() => {
    setSetting(getDb(), 'scheduler_paused', 'false');
    console.log('scheduler resumed');
  });

program
  .command('abort <id>')
  .description('interrupt a task\'s active run and mark it failed')
  .action((id) => {
    const db = getDb();
    const runs = activeRuns(db).filter((r) => r.task_id === id);
    for (const r of runs) killRun(db, { id: r.id, pid: r.pid }, 'user');
    setStatus(db, id, 'failed', { detail: 'aborted via cli' });
    console.log(`${id} aborted`);
  });

program
  .command('close <id>')
  .description('mark a reviewed task closed')
  .action((id) => {
    const db = getDb();
    const t = getTask(db, id);
    if (!t) return fail(`no such task: ${id}`);
    setStatus(db, id, 'closed', { detail: 'closed via cli' });
    console.log(`${id} -> closed`);
  });

program
  .command('set-usage')
  .description('DEV: force the shared usage cache (breaker drill)')
  .requiredOption('--session <pct>', 'session %', (v) => parseFloat(v))
  .option('--weekly <pct>', 'weekly %', (v) => parseFloat(v), 0)
  .action((o) => {
    setCachedUsage(o.session, o.weekly);
    console.log(`usage cache set: session=${o.session}% weekly=${o.weekly}%`);
  });

program
  .command('config')
  .description('view or change scheduler settings live (e.g. day/night thresholds)')
  .argument('[action]', 'list | get | set', 'list')
  .argument('[key]', 'setting key, e.g. day_session_max')
  .argument('[value]', 'new value (for set)')
  .action((action: string, key: string | undefined, value: string | undefined) => {
    const db = getDb();
    if (action === 'list') {
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        const cur = getSetting(db, k);
        const def = DEFAULT_SETTINGS[k] ?? '';
        const changed = cur !== undefined && cur !== def ? `  (default ${def})` : '';
        console.log(`${pad(k, 27)} ${pad(cur ?? def, 14)}${changed}`);
      }
      return;
    }
    if (action === 'get') {
      if (!key) return fail('usage: loop config get <key>');
      console.log(getSetting(db, key) ?? DEFAULT_SETTINGS[key] ?? '(unset)');
      return;
    }
    if (action === 'set') {
      if (!key || value === undefined) return fail('usage: loop config set <key> <value>');
      if (!(key in DEFAULT_SETTINGS)) console.warn(`warning: '${key}' is not a known setting`);
      const err = validateSetting(key, value);
      if (err) return fail(err);
      const prev = getSetting(db, key);
      setSetting(db, key, value);
      console.log(`${key}: ${prev ?? '(unset)'} -> ${value}  (live next tick)`);
      return;
    }
    return fail(`unknown action '${action}' — use: list | get | set`);
  });

program.parseAsync();

function printGate(g: { ok: boolean; missing: string[]; warnings: string[] }): void {
  if (g.ok) console.log('  gate: OK');
  else console.log('  gate: MISSING -> ' + g.missing.join('; '));
  for (const w of g.warnings) console.log('  warn: ' + w);
}

function pad(s: string, n: number): string {
  return (s + ' '.repeat(n)).slice(0, n);
}

function fail(msg: string): void {
  console.error(msg);
  process.exitCode = 1;
}
