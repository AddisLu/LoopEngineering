#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { getDb, getSetting, setSetting, getBool } from './db/index.js';
import {
  createTask,
  getTask,
  listTasks,
  setStatus,
  countByStatus,
  activeRuns,
  deleteTask,
  tasksForPrune,
} from './tasks.js';
import { validateTask } from './gate/validateTask.js';
import { readUsage, setCachedUsage } from './token/usage.js';
import { forecastBacklog } from './token/accounting.js';
import { computeMetrics } from './server/metrics.js';
import { killRun } from './orchestrator/kill.js';
import { cleanupWorktree } from './orchestrator/cleanup.js';
import { pruneTaskArtifacts, type ArtifactCleanup } from './git/worktree.js';
import { DEFAULT_SETTINGS, ENGINE_REPO_ROOT, type Complexity } from './config.js';
import { validateSetting } from './settings.js';
import { upsertNode, listNodes, searchNodes, importNodes, type ImportNodeInput, type ImportEdgeInput } from './knowledge/store.js';
import { exportClaudeMd } from './knowledge/export.js';
import type { KnowledgeNode, Kind, Status } from './knowledge/types.js';
import { collectDistillMaterial, runDistiller } from './knowledge/distill.js';
import {
  upsertEnvironment,
  getEnvironment,
  listEnvironments,
  deleteEnvironment,
  environmentMap,
  lastDeployed,
  type EnvironmentRow,
} from './deploy/store.js';
import { runRollback } from './orchestrator/deployTask.js';
import { listPipelineDefs, getPipelineDef, importPipelineDefs } from './pipeline/store.js';
import { materializePipeline } from './pipeline/materialize.js';
import { resolveProvider } from './integrations/config.js';
import { importWorkItems } from './integrations/import.js';
import { createSource, listSources, deleteSource, getSource } from './knowledge/ingest/sources.js';
import type { SourceKind } from './knowledge/ingest/types.js';
import { ingestSource, ingestAll } from './knowledge/ingest/ingest.js';

const program = new Command();
program.name('loop').description('Loop Engineering — token-aware coding-task scheduler').version('0.1.0');

program
  .command('add')
  .description('create a task (starts in draft)')
  .requiredOption('--title <title>')
  .requiredOption('--goal <goal>')
  .option('--plan <ref>', 'plan .md/.html path or URL')
  .option('--tool <tool>', 'claude-code | mock | generic | plan | deploy (generic: no repo/git, real agent in a persistent output dir; plan: an epic — an AI planner decomposes --goal/--plan into a depends_on child task chain and executes it; deploy: no agent — runs/queues a deploy to --env, see `loop deploy`)', 'claude-code')
  .option('--verify <steps>', 'comma-separated verification commands')
  .option('--setup <cmd>', 'setup command run in worktree before dispatch')
  .option('--repo <path>', 'git repo path')
  .option('--base <branch>', 'base branch')
  .option('--complexity <SML>', 'S|M|L', 'M')
  .option('--priority <n>', 'integer priority', (v) => parseInt(v, 10), 2)
  .option('--model <model>', 'sonnet|opus|default')
  .option('--depends-on <taskId>', 'hold this task until that task is closed (serial chain)')
  .option('--env <name>', 'environment label (e.g. company, home) — scopes knowledge injection to matching env:<name> nodes')
  .option('--verify-mode <csv>', 'comma-separated: command|llm|manual (default command)')
  .option('--rubric <text>', 'acceptance criteria for the llm judge / manual review')
  .option('--verify-timeout <min>', 'per-task verify per-step timeout override (minutes)', (v) => parseInt(v, 10))
  .option('--requires <csv>', 'comma-separated capability tokens this task needs (e.g. gpu,camera,os:windows) — unmet ones defer command verification to manual')
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
      depends_on: o.dependsOn ?? null,
      environment: o.env ?? null,
      verify_mode: o.verifyMode ?? null,
      verify_rubric: o.rubric ?? null,
      verify_timeout_min: o.verifyTimeout ?? null,
      requires: o.requires ?? null,
    });
    const gate = validateTask(getTask(db, t.id)!, getSetting(db, 'host_capabilities') ?? '', environmentMap(db));
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
    printGate(validateTask(t, getSetting(db, 'host_capabilities') ?? '', environmentMap(db)));
  });

program
  .command('queue <id>')
  .description('validate + enqueue a draft task')
  .action((id) => {
    const db = getDb();
    const t = getTask(db, id);
    if (!t) return fail(`no such task: ${id}`);
    const gate = validateTask(t, getSetting(db, 'host_capabilities') ?? '', environmentMap(db));
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
  .command('forecast')
  .description('backlog usage forecast — should I add more tasks?')
  .action(() => {
    const db = getDb();
    const f = forecastBacklog(db);
    console.log(`usage: session ${f.session_now}%/${f.session_max}%  weekly ${f.weekly_now}%/${f.weekly_max}%`);
    console.log(
      `backlog: ${f.pending} pending (S${f.by_complexity.S} M${f.by_complexity.M} L${f.by_complexity.L}) — weekly +${f.weekly_backlog_pct}%`,
    );
    console.log(
      `weekly headroom: ${f.weekly_headroom}%  → ~${f.capacity_more_M} more M task(s) / ~${f.capacity_more_L} more L task(s)  [${f.verdict}]`,
    );
    console.log(
      `session (per-window, does not sum): largest backlog task ~${f.largest_task_session_pct}% ` +
        (f.largest_task_session_fits ? '— fits a session window' : '— ⚠ exceeds a single session window'),
    );
    const ab = computeMetrics(db).discipline_ab.groups;
    if (ab.some((g) => g.count > 0)) {
      const fmt = (g: (typeof ab)[number]): string =>
        `${g.discipline ? 'on ' : 'off'} n=${g.count} avg_session%=${g.avg_session_pct?.toFixed(1) ?? '–'} ` +
        `attention=${Math.round(g.attention_rate * 100)}% resumes=${g.avg_resume_count?.toFixed(1) ?? '–'} avg_cycle=${g.avg_cycle_min == null ? '–' : Math.round(g.avg_cycle_min) + 'm'}`;
      console.log(`discipline A/B (prompt_discipline, last 14d): ${ab.map(fmt).join('  |  ')}`);
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
      // reason 'pause' (NOT 'user'): a user abort is terminal, a hard pause must stay
      // resumable — the interrupted task goes to blocked and auto-resumes on unpause.
      for (const r of activeRuns(db)) {
        killRun(db, { id: r.id, pid: r.pid }, 'pause');
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
    // collect BEFORE cleanupWorktree destroys the worktree HANDOFF.md lives in
    const material = collectDistillMaterial(db, t);
    setStatus(db, id, 'closed', { detail: 'closed via cli' });
    cleanupWorktree(db, t); // work is done — reclaim the worktree's disk
    // fire-and-forget: never delays this command returning (see knowledge/distill.ts)
    void runDistiller(db, t, material).catch(() => {});
    console.log(`${id} -> closed`);
  });

program
  .command('delete <id>')
  .description('permanently delete a task + its disk artifacts (worktree/plan/logs)')
  .option('--force', 'delete even if the task is active (aborts its run first)')
  .action((id, o) => {
    const db = getDb();
    const t = getTask(db, id);
    if (!t) return fail(`no such task: ${id}`);
    const active = t.status === 'running' || t.status === 'verifying' || t.status === 'queued';
    if (active && !o.force) {
      return fail(`${id} is ${t.status} — pass --force to delete an active task (aborts its run first)`);
    }
    if (active) {
      for (const r of activeRuns(db).filter((r) => r.task_id === id)) killRun(db, { id: r.id, pid: r.pid }, 'user');
    }
    const cleaned = pruneTaskArtifacts(db, t);
    deleteTask(db, id);
    console.log(`deleted ${id}${cleanupNote(cleaned)}`);
  });

program
  .command('prune')
  .description('batch-delete terminal tasks + artifacts (dry-run unless --yes)')
  .option('--status <list>', 'comma-separated statuses (default closed,failed)')
  .option('--older-than <days>', 'only tasks not updated in the last N days', (v) => parseInt(v, 10))
  .option('--dry-run', 'list what would be deleted, delete nothing')
  .option('--yes', 'actually delete (otherwise dry-run)')
  .action((o) => {
    const db = getDb();
    const status = o.status
      ? String(o.status).split(',').map((s: string) => s.trim()).filter(Boolean)
      : undefined;
    const targets = tasksForPrune(db, { status, olderThanDays: o.olderThan });
    if (!targets.length) {
      console.log('nothing to prune');
      return;
    }
    const doDelete = Boolean(o.yes) && !o.dryRun;
    for (const t of targets) {
      console.log(`  ${doDelete ? 'delete' : 'would delete'} ${t.id}  ${pad(t.status, 8)} ${t.title}`);
    }
    if (!doDelete) {
      console.log(`\n${targets.length} task(s) — dry-run. Re-run with --yes to delete.`);
      return;
    }
    for (const t of targets) {
      pruneTaskArtifacts(db, t);
      deleteTask(db, t.id);
    }
    console.log(`\npruned ${targets.length} task(s)`);
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

const knowledge = program.command('knowledge').description('manage the knowledge base');

knowledge
  .command('list')
  .description('list knowledge nodes')
  .option('--kind <kind>')
  .option('--scope <scope>')
  .option('--status <status>')
  .action((o) => {
    const db = getDb();
    printNodes(listNodes(db, { kind: o.kind as Kind, scope: o.scope, status: o.status as Status }));
  });

knowledge
  .command('search <query>')
  .description('full-text search knowledge nodes')
  .action((query) => {
    printNodes(searchNodes(getDb(), query));
  });

knowledge
  .command('add')
  .description('create or update a knowledge node (dedup by title+scope)')
  .requiredOption('--title <title>')
  .option('--body <body>')
  .option('--kind <kind>', 'environment|project|constraint|preference|tech|fact|person|repo')
  .option('--scope <scope>', 'global | repo:<path> | env:<name>')
  .option('--weight <n>', 'integer 1-5', (v) => parseInt(v, 10))
  .action((o) => {
    const node = upsertNode(getDb(), {
      title: o.title,
      body: o.body,
      kind: o.kind as Kind | undefined,
      scope: o.scope,
      weight: o.weight,
    });
    console.log(`${node.id}  [${node.kind}] ${node.title}`);
  });

knowledge
  .command('import [file]')
  .description('bulk-import nodes+edges from a JSON file (defaults to the bundled seed)')
  .action((file: string | undefined) => {
    const target = file ?? path.join(ENGINE_REPO_ROOT, 'seed', 'knowledge-seed.json');
    const data = JSON.parse(fs.readFileSync(target, 'utf8')) as {
      items?: ImportNodeInput[];
      edges?: ImportEdgeInput[];
    };
    const result = importNodes(getDb(), data.items ?? [], data.edges ?? []);
    console.log(
      `import ${target}: created=${result.created} updated=${result.updated} edges=${result.edges}`,
    );
  });

knowledge
  .command('export')
  .description("render environment/constraint/preference knowledge into a target repo's CLAUDE.md")
  .requiredOption('--repo <path>', 'target repo path')
  .action((o) => {
    const result = exportClaudeMd(getDb(), o.repo);
    if (!result.ok) return fail(result.error ?? 'export failed');
    console.log(`exported ${result.nodeCount} node(s) -> ${result.path}`);
  });

const env = program.command('env').description('manage deploy environments (home/company/…)');

env
  .command('list')
  .description('list environments')
  .action(() => {
    printEnvironments(listEnvironments(getDb()));
  });

env
  .command('add <name>')
  .description('create or update an environment (deploy target)')
  .option('--kind <kind>', 'dev|staging|prod', 'dev')
  .option('--host <host>', 'informational, e.g. linux-rtx2080 / windows-11')
  .option('--capabilities <csv>', 'CSV, e.g. gpu,os:windows — feeds the V2 unmet-capability check', '')
  .option('--deploy-cmd <cmd>', 'shell command run on auto-deploy (omit for a manual/prod environment)')
  .option('--auto-deploy', 'run --deploy-cmd automatically on a deploy task (default: manual package + checklist)')
  .action((name: string, o) => {
    const env = upsertEnvironment(getDb(), {
      name,
      kind: o.kind,
      host: o.host ?? null,
      capabilities: o.capabilities ?? '',
      deploy_cmd: o.deployCmd ?? null,
      auto_deploy: !!o.autoDeploy,
    });
    console.log(`${env.name}  kind=${env.kind} host=${env.host ?? '-'} capabilities=${env.capabilities || '-'} auto_deploy=${!!env.auto_deploy}`);
  });

env
  .command('remove <name>')
  .description('delete an environment')
  .action((name: string) => {
    if (!deleteEnvironment(getDb(), name)) return fail(`no such environment: ${name}`);
    console.log(`removed ${name}`);
  });

// Plain (not required) options on the parent: `loop deploy rollback <env>` dispatches to
// the `rollback` subcommand below without ever invoking/validating the parent's own
// action, so required-option enforcement here would wrongly reject that invocation.
const deploy = program
  .command('deploy')
  .description('create + queue a deploy task (coding_tool=deploy) targeting an environment')
  .option('--env <name>', 'target environment (see `loop env list`)')
  .option('--repo <path>', 'git repo path (the source to deploy)')
  .option('--base <branch>', 'base branch to deploy (usually main, after a feature merged)')
  .action((o) => {
    if (!o.env || !o.repo || !o.base) return fail('usage: loop deploy --env <name> --repo <path> --base <branch>');
    const db = getDb();
    const t = createTask(db, {
      title: `deploy ${o.env}`,
      goal: `Deploy ${o.base} to ${o.env}`,
      coding_tool: 'deploy',
      complexity: 'S',
      environment: o.env,
      repo_path: o.repo,
      base_branch: o.base,
    });
    const gate = validateTask(getTask(db, t.id)!, getSetting(db, 'host_capabilities') ?? '', environmentMap(db));
    if (!gate.ok) {
      console.log(`created ${t.id} (${t.status}) — cannot queue yet:`);
      printGate(gate);
      return;
    }
    setStatus(db, t.id, 'queued', { detail: 'queued via cli (loop deploy)' });
    console.log(`created ${t.id} -> queued (deploy ${o.base} -> ${o.env})`);
  });

deploy
  .command('rollback <env>')
  .description("roll <env> back to its previous deployed commit")
  .action(async (envName: string) => {
    const db = getDb();
    if (!getEnvironment(db, envName)) return fail(`no such environment: ${envName}`);
    const cur = lastDeployed(db, envName);
    if (!cur) return fail(`no deployment recorded for ${envName}`);
    const result = await runRollback(db, cur.id);
    if (!result.ok && result.error) return fail(`rollback failed: ${result.error}`);
    console.log(`${envName}: rolled back -> commit ${result.record?.commit_sha ?? '(unknown)'} (${result.record?.status})`);
  });

const pipeline = program
  .command('pipeline')
  .description('delivery pipeline templates (feature/fix/ship) — instantiate a depends_on stage chain in one action');

pipeline
  .command('list')
  .description('list pipeline templates')
  .action(() => {
    const defs = listPipelineDefs(getDb());
    if (!defs.length) {
      console.log('(no pipeline templates — seeded feature/fix/ship should exist by default)');
      return;
    }
    for (const d of defs) {
      console.log(`${pad(d.name, 10)} ${d.description ?? ''}`);
      for (const s of d.stages) {
        console.log(
          `  - ${pad(s.name, 14)} tool=${s.coding_tool}` +
            (s.environment ? ` env=${s.environment}` : '') +
            (s.verify_mode ? ` verify=${s.verify_mode}` : ''),
        );
      }
    }
  });

pipeline
  .command('run <name>')
  .description('instantiate a pipeline template into a queued depends_on task chain')
  .requiredOption('--goal <goal>')
  .option('--repo <path>', 'git repo path')
  .option('--base <branch>', 'base branch')
  .option('--env <name>', "environment for stages that don't set their own (a stage's own environment always wins)")
  .option('--title <title>', 'label used in each stage task title (default: the pipeline name)')
  .option('--verify <steps>', 'comma-separated verification commands, shared by every command-mode stage')
  .action((name: string, o) => {
    const db = getDb();
    const def = getPipelineDef(db, name);
    if (!def) return fail(`no such pipeline: ${name} (see 'loop pipeline list')`);
    const tasks = materializePipeline(db, def, {
      goal: o.goal,
      repo_path: o.repo ?? null,
      base_branch: o.base ?? null,
      environment: o.env ?? null,
      title: o.title ?? null,
      verification_steps: o.verify ? String(o.verify).split(',').map((s: string) => s.trim()) : [],
    });
    console.log(`pipeline '${name}' -> ${tasks.length} stage(s):`);
    for (const t of tasks) console.log(`  ${t.id}  ${pad(t.status, 8)} ${pad(t.stage_name ?? '', 14)} ${t.title}`);
  });

pipeline
  .command('import [file]')
  .description('bulk-import pipeline templates from a JSON file ({"items":[...]}); defaults to the bundled seed/pipelines/*.json')
  .action((file: string | undefined) => {
    const db = getDb();
    let items: unknown[];
    if (file) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      items = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : [data];
    } else {
      const dir = path.join(ENGINE_REPO_ROOT, 'seed', 'pipelines');
      items = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    }
    const result = importPipelineDefs(db, items);
    console.log(`import: created=${result.created} updated=${result.updated} rejected=${result.rejected.length}`);
    for (const r of result.rejected) console.log(`  [${r.index}] ${r.error}`);
  });

program
  .command('pull')
  .description('pull work items (GitHub issues / ADO work items) into Loop tasks — idempotent by source_ref')
  .requiredOption('--provider <name>', 'github | ado (must match the configured integration_provider setting)')
  .requiredOption('--query <query>', 'GitHub: search query, e.g. "assignee:@me label:loop repo:owner/name". ADO: a WIQL query string.')
  .option('--repo <path>', 'target git repo for created tasks')
  .option('--base <branch>', 'base branch for created tasks')
  .option('--verify <steps>', 'comma-separated verification commands shared by every imported task')
  .action(async (o) => {
    const db = getDb();
    const active = getSetting(db, 'integration_provider') ?? 'none';
    if (active === 'none') return fail('integration_provider is "none" — set it (and provider credentials) first: loop config set integration_provider github');
    if (o.provider !== active) return fail(`provider mismatch: configured=${active}, requested=${o.provider}`);
    const provider = resolveProvider(db);
    if (!provider) return fail(`provider '${active}' is missing credentials in ~/.config/loop-engineering/env`);
    const result = await importWorkItems(db, provider, o.query, {
      repo_path: o.repo ?? null,
      base_branch: o.base ?? null,
      verification_steps: o.verify ? String(o.verify).split(',').map((s: string) => s.trim()) : [],
    });
    console.log(`pulled: created=${result.created.length} skipped=${result.skipped.length}`);
    for (const t of result.created) console.log(`  ${t.id}  ${pad(t.status, 8)} ${t.title}`);
  });

const ingest = program.command('ingest').description('SSoT ingestion: register sources + run the walk->chunk->embed pipeline');

ingest
  .command('add')
  .description('register an ingestion source (exactly one of --git/--folder/--vault)')
  .option('--git <path>', 'git repo — tracked files via `git ls-files` (respects .gitignore)')
  .option('--folder <path>', 'plain folder — recursive walk')
  .option('--vault <path>', 'Obsidian-style markdown vault — recursive walk')
  .option('--include <csv>', 'comma-separated include globs')
  .option('--exclude <csv>', 'comma-separated exclude globs')
  .option('--branch <name>', 'git ref to list from (git sources only; default: working tree)')
  .option('--disabled', 'register disabled (skipped by `loop ingest run` with no source id)')
  .action((o) => {
    const kind: SourceKind | null = o.git ? 'git' : o.folder ? 'folder' : o.vault ? 'vault' : null;
    const uri = o.git ?? o.folder ?? o.vault;
    if (!kind || !uri) return fail('usage: loop ingest add --git|--folder|--vault <path>');
    const source = createSource(getDb(), {
      kind,
      uri: path.resolve(uri),
      config: {
        include: o.include ? String(o.include).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
        exclude: o.exclude ? String(o.exclude).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
        branch: o.branch,
      },
      enabled: !o.disabled,
    });
    console.log(`${source.id}  [${source.kind}] ${source.uri}`);
  });

ingest
  .command('list')
  .description('list ingestion sources')
  .action(() => {
    const sources = listSources(getDb());
    if (!sources.length) return console.log('(no sources)');
    for (const s of sources) {
      console.log(`${s.id}  [${pad(s.kind, 14)}] ${pad(s.enabled ? 'on' : 'off', 4)} ${s.uri}  last=${s.last_ingested_at ?? '-'}`);
    }
  });

ingest
  .command('rm <id>')
  .description('remove an ingestion source (cascades its documents/chunks)')
  .action((id) => {
    if (!deleteSource(getDb(), id)) return fail(`no such source: ${id}`);
    console.log(`removed ${id}`);
  });

ingest
  .command('run [source]')
  .description('run the ingest pipeline — all enabled sources, or one by id')
  .action(async (sourceId: string | undefined) => {
    const db = getDb();
    const report = (r: Awaited<ReturnType<typeof ingestSource>>) =>
      console.log(
        `${r.source_id}: +${r.documents_created} created, ${r.documents_replaced} replaced, ` +
          `${r.documents_invalidated} invalidated, ${r.chunks_created} chunks, ${r.skipped_unchanged} unchanged`,
      );
    if (sourceId) {
      const source = getSource(db, sourceId);
      if (!source) return fail(`no such source: ${sourceId}`);
      report(await ingestSource(db, source));
      return;
    }
    const results = await ingestAll(db);
    if (!results.length) return console.log('(no enabled sources)');
    for (const r of results) report(r);
  });

program.parseAsync();

function printEnvironments(envs: EnvironmentRow[]): void {
  if (!envs.length) {
    console.log('(no environments — seeded home/company should exist by default)');
    return;
  }
  for (const e of envs) {
    console.log(
      `${pad(e.name, 12)} kind=${pad(e.kind, 8)} host=${pad(e.host ?? '-', 14)} capabilities=${pad(e.capabilities || '-', 16)} auto_deploy=${!!e.auto_deploy}`,
    );
  }
}

function printGate(g: { ok: boolean; missing: string[]; warnings: string[] }): void {
  if (g.ok) console.log('  gate: OK');
  else console.log('  gate: MISSING -> ' + g.missing.join('; '));
  for (const w of g.warnings) console.log('  warn: ' + w);
}

function pad(s: string, n: number): string {
  return (s + ' '.repeat(n)).slice(0, n);
}

function cleanupNote(c: ArtifactCleanup): string {
  const parts: string[] = [];
  if (c.worktrees.length) parts.push(`${c.worktrees.length} worktree(s)`);
  if (c.logs.length) parts.push(`${c.logs.length} log(s)`);
  if (c.plans.length) parts.push(`${c.plans.length} plan(s)`);
  const note = parts.length ? ` (removed ${parts.join(', ')})` : '';
  const skipped = c.skipped.length ? ` [skipped ${c.skipped.length} path(s) outside data dir]` : '';
  return note + skipped;
}

function fail(msg: string): void {
  console.error(msg);
  process.exitCode = 1;
}

function printNodes(nodes: KnowledgeNode[]): void {
  if (!nodes.length) {
    console.log('(no matching nodes)');
    return;
  }
  for (const n of nodes) {
    console.log(`${n.id}  ${pad(n.kind, 12)} w${n.weight}  ${pad(n.scope, 20)} ${n.title}`);
  }
}
