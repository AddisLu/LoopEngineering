#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getConversation, messagesFor, pruneConversations } from './chat/store.js';
import { toMarkdown } from './chat/export.js';
import { getDb, getSetting, setSetting, getBool, getNum } from './db/index.js';
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
import { buildMorningReport, formatMorningText } from './report/morning.js';
import { computeMetrics } from './server/metrics.js';
import { killRun } from './orchestrator/kill.js';
import { cleanupWorktree } from './orchestrator/cleanup.js';
import { pruneTaskArtifacts, type ArtifactCleanup } from './git/worktree.js';
import { DEFAULT_SETTINGS, ENGINE_REPO_ROOT, type Complexity } from './config.js';
import { validateSetting } from './settings.js';
import { upsertNode, listNodes, searchNodes, importNodes, type ImportNodeInput, type ImportEdgeInput } from './knowledge/store.js';
import { exportClaudeMd } from './knowledge/export.js';
import { selectKnowledge } from './knowledge/context.js';
import type { KnowledgeNode, Kind, Status } from './knowledge/types.js';
import { collectDistillMaterial, runDistiller } from './knowledge/distill.js';
import { suggestRelations } from './knowledge/relate.js';
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
import type { SourceKind, SourceConfig } from './knowledge/ingest/types.js';
import { ingestSource, ingestAll } from './knowledge/ingest/ingest.js';
import { generateReport } from './report/generate.js';
import { listReportTemplates, importReportTemplates } from './report/templates.js';
import { validateDeckSpec } from './report/pptx/spec.js';
import { renderDeck, qaRender, resolvePythonBin, resolveTemplatePath, resolveManifestPath } from './report/pptx/render.js';
import { prepareWeekly, renderWeekly, runWeekly } from './report/pptx/weekly.js';
import { listLocalModels, getLocalModel } from './local/models.js';
import { getModelManager } from './local/modelManager.js';
import { getJobRunner, JobBusyError } from './local/jobs.js';
import { buildCatalog } from './local/catalog.js';
import { activeLocalRunCount } from './tasks.js';
import { BENCH_DOMAINS, BenchmarkInputError, benchmarkMatrix, createBenchmark, getBenchmark, listBenchmarks } from './benchmark/store.js';
import { judgeBenchmark } from './benchmark/complete.js';
import { checkPrd, submitPrd, PrdInputError, type PrdCheck } from './prd/intake.js';
import { formatSandboxResult, runSandbox, sandboxSettings, settingsForHost } from './exec/sandbox.js';
import { checkSandbox, formatCheck } from './exec/check.js';
import { parseAcceptance } from './orchestrator/acceptance.js';
import { ensureWorkspace, execRoot } from './exec/workspace.js';
import { deleteExecHost, getExecHost, listExecHosts, LOCAL_HOST, realHostExec, resolveExecTarget, setHostIds, sshArgs, upsertExecHost, type ExecHost, type ExecTarget } from './exec/hosts.js';

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
  .option('--experiment <tag>', 'A/B cohort label for measurement (see `loop experiment`) — pure tag, does not affect scheduling')
  .option('--metrics <expr>', '驗收指標 the engine checks against LOOP_METRICS lines, e.g. "detection_rate >= 0.98; miss == 0"')
  .option('--protect <globs>', '保護路徑: CSV globs the agent must not change, e.g. "scripts/eval/**,data/golden/**"')
  .action((o) => {
    const db = getDb();
    if (o.metrics) {
      try {
        parseAcceptance(String(o.metrics));
      } catch (err) {
        return fail((err as Error).message);
      }
    }
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
      experiment: o.experiment ?? null,
      acceptance_metrics: o.metrics ?? null,
      protected_paths: o.protect ?? null,
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
  .command('morning')
  .description('晨報: what ran overnight — acceptance results, PRs, what needs a person')
  .option('--hours <n>', 'look back this many hours', '24')
  .option('--json', 'print the report as JSON')
  .action((o: { hours: string; json?: boolean }) => {
    const db = getDb();
    const r = buildMorningReport(db, { hours: Number(o.hours) || 24 });
    console.log(o.json ? JSON.stringify(r, null, 2) : formatMorningText(r));
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
  .command('experiment [tag]')
  .description('A/B cohort comparison (tasks --experiment) — e.g. did {SDD spec + cheap model} beat the baseline?')
  .option('--days <n>', 'window in days (default 14)', (v) => parseInt(v, 10))
  .action((tag, o) => {
    const db = getDb();
    const groups = computeMetrics(db, o.days ? { days: o.days } : {}).experiment_ab.groups.filter(
      (g) => !tag || g.experiment.startsWith(tag),
    );
    if (!groups.length) {
      console.log(
        tag
          ? `no experiment cohorts matching "${tag}" among terminal tasks in the window`
          : 'no experiment cohorts yet — tag tasks with `loop add --experiment <name>`',
      );
      return;
    }
    for (const g of groups) {
      console.log(
        `${pad(g.experiment, 12)} n=${g.count} pass=${Math.round(g.pass_rate * 100)}% (${g.passed}/${g.count})  ` +
          `avg_session%=${g.avg_session_pct?.toFixed(1) ?? '–'}  attention=${Math.round(g.attention_rate * 100)}%  ` +
          `resumes=${g.avg_resume_count?.toFixed(1) ?? '–'}  avg_cycle=${g.avg_cycle_min == null ? '–' : Math.round(g.avg_cycle_min) + 'm'}`,
      );
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
  .command('rescope')
  .description('move approved nodes from one scope to another (e.g. a repo scope no task points at)')
  .requiredOption('--from <scope>', "source scope, e.g. 'repo:/home/me/proj'")
  .requiredOption('--to <scope>', "target scope, e.g. 'global'")
  .option('--kind <kind>', 'only this kind (environment|constraint|preference|project|tech|fact|person|repo)')
  .option('--yes', 'actually write; without it this is a dry run')
  .action((o) => {
    const db = getDb();
    const where = ["status = 'approved'", 'invalid_at IS NULL', 'scope = ?'];
    const params: unknown[] = [o.from];
    if (o.kind) {
      where.push('kind = ?');
      params.push(o.kind);
    }
    const rows = db.prepare(`SELECT id, kind, title FROM knowledge_nodes WHERE ${where.join(' AND ')} ORDER BY kind, title`).all(...params) as Array<{ id: string; kind: string; title: string }>;
    if (!rows.length) return console.log(`no approved nodes in scope '${o.from}'${o.kind ? ` of kind '${o.kind}'` : ''}`);
    for (const r of rows) console.log(`  [${r.kind}] ${r.title}`);
    if (!o.yes) return console.log(`\n${rows.length} node(s) would move ${o.from} -> ${o.to}. Re-run with --yes to apply.`);
    const upd = db.prepare("UPDATE knowledge_nodes SET scope = ?, updated_at = datetime('now') WHERE id = ?");
    const tx = db.transaction(() => {
      for (const r of rows) upd.run(o.to, r.id);
    });
    tx();
    console.log(`\nmoved ${rows.length} node(s): ${o.from} -> ${o.to}`);
  });

knowledge
  .command('preview <taskId>')
  .description('show exactly which knowledge a task would be given at dispatch, and what was skipped')
  .action((taskId: string) => {
    const db = getDb();
    const task = getTask(db, taskId);
    if (!task) return fail(`task not found: ${taskId}`);
    const sel = selectKnowledge(db, task);
    console.log(`task   ${task.id}  ${task.title}`);
    console.log(`repo   ${task.repo_path ?? '(none)'}`);
    console.log(`scopes ${sel.scopes.join(', ')}`);
    console.log(`inject ${sel.enabled ? 'on' : 'OFF (knowledge_inject=false)'} · ${sel.used}/${sel.budget} chars · ${sel.items.filter((i) => i.included).length}/${sel.items.length} nodes`);
    for (const i of sel.items) console.log(`  ${i.included ? '✓' : ' '} [${i.kind}] ${i.title}  (rel ${i.score}, w${i.weight}, ${i.chars}c)`);
    for (const s of sel.skipped) console.log(`  ! ${s.count} approved node(s) in scope '${s.scope}' — this task does not point there`);
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
  .command('relate')
  .description('suggest relations between approved knowledge nodes (embedding top-K + one LLM classify call); inserted as draft edges pending approval in the brain UI')
  .option('--limit <n>', 'max candidate pairs to assess (closest first)', (v) => parseInt(v, 10))
  .action(async (o) => {
    const db = getDb();
    const edges = await suggestRelations(db, { limit: o.limit });
    if (!edges) {
      console.log('no relations suggested');
      return;
    }
    console.log(`suggested ${edges.length} draft edge(s) — approve/reject in the brain UI`);
    for (const e of edges) console.log(`  ${e.src} --${e.relation}--> ${e.dst}${e.note ? `  (${e.note})` : ''}`);
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

const execCmd = program.command('exec').description('GPU 執行沙盒: check the Docker/GPU setup, or run one command in the sandbox (see exec_enabled)');

execCmd
  .command('check')
  .description('is this machine (or --host) ready? docker, image, GPU, nvcc/ncu, no network, writable /work, read-only data')
  .option('--host <name>', 'check a registered remote sandbox host instead (see `loop exec host`)')
  .option('--profile', 'also build a tiny kernel and run ncu on it (checks GPU counter permissions)')
  .action(async (o) => {
    const db = getDb();
    const s = sandboxSettings(db);
    let remote: ExecHost | undefined;
    if (o.host && o.host !== LOCAL_HOST) {
      remote = getExecHost(db, String(o.host));
      if (!remote) return fail(`no such exec host: ${o.host} (loop exec host list)`);
    }
    const shown = remote ? settingsForHost(s, remote) : s;
    console.log(
      `exec_enabled=${s.enabled}  host=${remote ? `${remote.name} (${remote.ssh_target})` : 'local'}  image=${shown.image}  gpus=${shown.gpus || '(none)'}  memory=${shown.memory}  cpus=${shown.cpus}`,
    );
    const lines = await checkSandbox(s, path.join(execRoot(), 'check'), {
      profile: !!o.profile,
      remote,
      onRemoteIds: remote ? (uid, gid) => setHostIds(db, remote!.name, uid, gid) : undefined,
    });
    console.log(formatCheck(lines));
    if (lines.some((l) => l.ok === false)) process.exitCode = 1;
    else if (!s.enabled) console.log('\n一切就緒；要讓對話頁與任務使用，執行：loop config set exec_enabled true');
  });

execCmd
  .command('run')
  .description('run one bash command in the sandbox (default workspace: <data dir>/exec/cli)')
  .argument('<command...>', 'the command (quote it, or put it after --)')
  .option('--dir <path>', 'local directory to mount at /work (synced to the host first when --host is remote)')
  .option('--host <name>', 'run on a registered remote sandbox host')
  .option('--timeout <sec>', 'timeout in seconds (capped by exec_max_timeout_sec)')
  .action(async (parts: string[], o) => {
    const db = getDb();
    const s = sandboxSettings(db);
    if (!s.enabled) console.error('（注意：exec_enabled=false —— 對話頁與任務還不能用沙盒；這個指令照樣執行）');
    let target: ExecTarget;
    try {
      target = resolveExecTarget(db, o.host ?? LOCAL_HOST);
    } catch (err) {
      return fail((err as Error).message);
    }
    const dir = o.dir ? path.resolve(String(o.dir)) : ensureWorkspace(path.join(execRoot(), 'cli'));
    const remote = target.kind === 'remote' ? { host: target.host, key: 'cli' } : null;
    const r = await runSandbox(s, { workdir: dir, command: parts.join(' '), timeoutSec: o.timeout, scope: 'cli', remote });
    console.log(formatSandboxResult(r));
    process.exitCode = r.exitCode === 0 && !r.infra ? 0 : r.exitCode && r.exitCode > 0 ? r.exitCode : 1;
  });

const execHost = execCmd.command('host').description('remote sandbox hosts: Linux + Docker + NVIDIA Container Toolkit, reached over SSH');

execHost
  .command('add <name>')
  .description('register (or update) a remote sandbox host')
  .requiredOption('--ssh <target>', 'user@host or an ~/.ssh/config alias (key login, no password)')
  .requiredOption('--work-root <dir>', 'remote directory for synced workspaces, e.g. /srv/loop-exec')
  .option('--port <n>', 'ssh port', (v) => parseInt(v, 10))
  .option('--image <image>', 'docker image on that host (default: exec_image)')
  .option('--gpus <value>', "docker --gpus value on that host ('' = none; default: exec_gpus)")
  .option('--memory <size>', 'container memory limit (default: exec_memory)')
  .option('--cpus <n>', 'container CPU limit (default: exec_cpus)')
  .option('--data <csv>', 'read-only data mounts, CSV of /remote/path:/container/path, e.g. /mnt/aoi:/datasets')
  .option('--desc <text>', 'what this host is for — shown to the model (e.g. "AOI 圖庫與 RTX 4090")')
  .option('--disabled', 'register it switched off')
  .action((name: string, o) => {
    const db = getDb();
    try {
      const h = upsertExecHost(db, {
        name,
        ssh_target: String(o.ssh),
        ssh_port: o.port ?? null,
        work_root: String(o.workRoot),
        image: o.image ?? null,
        gpus: o.gpus ?? null,
        memory: o.memory ?? null,
        cpus: o.cpus ?? null,
        data_mounts: o.data ?? '',
        description: o.desc ?? null,
        enabled: !o.disabled,
      });
      console.log(`${h.name}  ${h.ssh_target}${h.ssh_port ? `:${h.ssh_port}` : ''}  work_root=${h.work_root}  data=${h.data_mounts || '-'}`);
      console.log(`下一步：loop exec check --host ${h.name} --profile`);
    } catch (err) {
      fail((err as Error).message);
    }
  });

execHost
  .command('list')
  .description('registered remote sandbox hosts')
  .action(() => {
    const db = getDb();
    const def = (getSetting(db, 'exec_default_host') ?? '').trim() || LOCAL_HOST;
    console.log(`${def === LOCAL_HOST ? '*' : ' '} local  (this machine)`);
    for (const h of listExecHosts(db)) {
      console.log(
        `${def === h.name ? '*' : ' '} ${h.name}  ${h.ssh_target}${h.ssh_port ? `:${h.ssh_port}` : ''}  work_root=${h.work_root}` +
          `  image=${h.image ?? '(exec_image)'}  data=${h.data_mounts || '-'}${h.enabled ? '' : '  [disabled]'}${h.description ? `\n    ${h.description}` : ''}`,
      );
    }
    console.log('(* = exec_default_host)');
  });

execHost
  .command('rm <name>')
  .description('forget a remote sandbox host (its synced workspaces stay; use prune first)')
  .action((name: string) => {
    if (!deleteExecHost(getDb(), name)) return fail(`no such exec host: ${name}`);
    console.log(`removed ${name}`);
  });

execHost
  .command('prune <name>')
  .description('delete synced workspaces on that host not touched for N days')
  .option('--days <n>', 'age in days', (v) => parseInt(v, 10), 7)
  .action(async (name: string, o) => {
    const db = getDb();
    const h = getExecHost(db, name);
    if (!h) return fail(`no such exec host: ${name}`);
    const days = Math.max(1, Number(o.days) || 7);
    const r = await realHostExec(
      'ssh',
      [...sshArgs(h), h.ssh_target, `find ${h.work_root} -mindepth 1 -maxdepth 1 -type d -mtime +${days} -print -exec rm -rf {} +`],
      120_000,
    );
    if (r.code !== 0) return fail(`prune failed: ${r.out.slice(-300)}`);
    console.log(r.out.trim() ? `removed:\n${r.out.trim()}` : 'nothing older than that');
  });

const local = program.command('local').description('本地模型: list / load / stop / download / build / jobs (see local_models_enabled)');

local
  .command('list')
  .description('registered local models and what vLLM is serving (* = loaded)')
  .action(async () => {
    const db = getDb();
    const mm = getModelManager(db);
    const on = getBool(db, 'local_models_enabled', false);
    if (on) await mm.reconcile();
    const st = mm.state();
    console.log(
      `local_models_enabled=${on}  status=${st.status}  loaded=${st.loaded ?? '-'}  in-flight=${activeLocalRunCount(db)}` +
        (st.error ? `\n  error: ${st.error}` : ''),
    );
    for (const m of listLocalModels(db)) {
      const mark = st.loaded === m.id ? '*' : ' ';
      console.log(`${mark} local:${m.id.padEnd(18)} ${m.enabled ? 'enabled ' : 'disabled'}  ${m.recipe}  (${m.served_model_id})`);
      if (m.notes) console.log(`    ${m.notes}`);
    }
  });

local
  .command('load <id>')
  .description('load a local model into vLLM now and wait until it serves (~6 min for a 100 GB model)')
  .action(async (id: string) => {
    const db = getDb();
    if (!getBool(db, 'local_models_enabled', false)) return fail('local models disabled — loop config set local_models_enabled true');
    if (!getLocalModel(db, id)) return fail(`unknown local model: ${id} (see loop local list)`);
    if (getSetting(db, 'local_model_status') === 'starting') return fail('a model switch is already in progress (engine or another CLI)');
    const mm = getModelManager(db);
    await mm.reconcile();
    const inflight = activeLocalRunCount(db);
    if (inflight > 0 && mm.state().loaded !== id) return fail(`${inflight} local run(s) in flight — load after they finish`);
    const r = mm.ensureLoaded(id);
    if (r === 'busy') return fail(`cannot load ${id}: ${mm.state().error ?? 'busy'}`);
    const started = Date.now();
    const iv = setInterval(() => console.log(`  … ${mm.state().status} (${Math.round((Date.now() - started) / 1000)}s)`), 30_000);
    await mm.waitForSwitch();
    clearInterval(iv);
    const st = mm.state();
    if (st.status !== 'ready') return fail(`load failed: ${st.error ?? st.status}`);
    console.log(`local:${id} ready`);
  });

const gbs = (b: number | null) => (b == null ? '?' : `${(b / 1024 ** 3).toFixed(1)} GB`);

/** Start a download/build from the catalog and print progress until it ends. */
async function localJob(kind: 'download' | 'build', recipe: string): Promise<void> {
  const db = getDb();
  if (!getBool(db, 'local_models_enabled', false)) return fail('local models disabled — loop config set local_models_enabled true');
  const repo = getSetting(db, 'local_vllm_repo') || '';
  const runner = getJobRunner(db);
  const cat = await buildCatalog(db, repo, Math.max(1, getNum(db, 'local_spark_nodes', 1)), getModelManager(db).state(), runner.current(), {
    fetch: globalThis.fetch as never,
  });
  const entry = cat.entries.find((e) => e.recipe === recipe);
  if (!entry) return fail(`unknown recipe: ${recipe} (see ${repo}/recipes)`);
  if (kind === 'download' && entry.downloaded) return fail(`${entry.name}: weights already downloaded`);
  if (kind === 'build' && entry.image_ready) return fail(`${entry.name}: image ${entry.container} already built`);
  if (entry.nodes > cat.sparks) return fail(entry.blocked_by ?? 'needs more Sparks');
  let job;
  try {
    job = runner.start(kind, recipe, { model: entry.model, container: entry.container, size_bytes: entry.size_bytes, repo });
  } catch (err) {
    return fail(err instanceof JobBusyError ? err.message : (err as Error).message);
  }
  console.log(`${kind} ${recipe} started (pid ${job.pid ?? '?'}, log ${job.log_path})`);
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000));
    const cur = runner.current();
    if (!cur || cur.id !== job.id) break;
    if (cur.status !== 'running') {
      if (cur.status === 'done') console.log(`${kind} ${recipe} done`);
      else return fail(`${kind} ${recipe} ${cur.status}: ${cur.error ?? ''}`);
      break;
    }
    console.log(`  … ${kind === 'download' ? `${gbs(cur.bytes_now)} / ${gbs(cur.size_bytes)}` : 'building'}  ${cur.last_line}`);
  }
}

local
  .command('download <recipe>')
  .description('pull a recipe\'s weights in the background (resumable), printing progress until done')
  .action((recipe: string) => localJob('download', recipe));

local
  .command('build <recipe>')
  .description('build/pull the container image a recipe needs (run-recipe.sh --solo --build-only)')
  .action((recipe: string) => localJob('build', recipe));

local
  .command('jobs')
  .description('the current download/build job, if any')
  .action(() => {
    const cur = getJobRunner(getDb()).current();
    if (!cur) return console.log('no job');
    console.log(`${cur.kind} ${cur.recipe}  ${cur.status}  started ${cur.started_at}${cur.ended_at ? `  ended ${cur.ended_at}` : ''}`);
    if (cur.kind === 'download') console.log(`  ${gbs(cur.bytes_now)} / ${gbs(cur.size_bytes)}`);
    if (cur.last_line) console.log(`  ${cur.last_line}`);
    if (cur.error) console.log(`  error: ${cur.error}`);
    console.log(`  log: ${cur.log_path}`);
  });

local
  .command('stop')
  .description('stop vLLM and free the GPU')
  .action(async () => {
    const db = getDb();
    const inflight = activeLocalRunCount(db);
    if (inflight > 0) return fail(`${inflight} local run(s) in flight — stop after they finish`);
    await getModelManager(db).stop();
    console.log('vLLM stopped');
  });

const bench = program
  .command('bench')
  .description('benchmark mode: run one task on several models; an external model judges and ranks them');

const csvList = (v?: string): string[] => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const benchOn = (): boolean => {
  if (getBool(getDb(), 'benchmark_enabled', false)) return true;
  fail('benchmark mode disabled — loop config set benchmark_enabled true');
  return false;
};

bench
  .command('add')
  .description('create a benchmark: one arm task per model, queued now, judged when all arms finish')
  .requiredOption('--title <title>')
  .requiredOption('--goal <goal>')
  .requiredOption('--models <csv>', 'e.g. local:qwen38-flash,local:qwen3-coder-next (2+)')
  .requiredOption('--repo <path>', 'git repo every arm branches from')
  .requiredOption('--verify <csv>', 'verification commands every arm must pass')
  .option('--base <branch>', 'base branch', 'main')
  .option('--plan <ref>', 'plan/PRD file path or URL every arm follows')
  .option('--setup <cmd>', 'setup command (e.g. npm ci)')
  .option('--rubric <text>', 'acceptance criteria shown to the judge')
  .option('--domain <domain>', BENCH_DOMAINS.join('|'), 'other')
  .option('--complexity <c>', 'S|M|L', 'M')
  .option('--judge <model>', 'opus|fable|fable-5|sonnet (default: bench_judge_model)')
  .option('--priority <n>', 'arm task priority')
  .action((o) => {
    if (!benchOn()) return;
    const plan = o.plan && !/^https?:\/\//i.test(o.plan) ? path.resolve(o.plan) : o.plan;
    try {
      const { benchmark, arms } = createBenchmark(getDb(), {
        title: o.title,
        goal: o.goal,
        models: csvList(o.models),
        repo_path: path.resolve(o.repo),
        base_branch: o.base,
        verification_steps: csvList(o.verify),
        plan_ref: plan ?? null,
        setup_cmd: o.setup ?? null,
        verify_rubric: o.rubric ?? null,
        domain: o.domain,
        complexity: o.complexity as Complexity,
        judge_model: o.judge,
        priority: o.priority != null ? Number(o.priority) : undefined,
      });
      console.log(`benchmark ${benchmark.id}  domain=${benchmark.domain} judge=${benchmark.judge_model}`);
      for (const a of arms) console.log(`  ${pad(a.model, 28)} task ${a.task_id} [${a.task_status}]`);
    } catch (err) {
      if (err instanceof BenchmarkInputError) return fail(err.message);
      throw err;
    }
  });

bench
  .command('list')
  .description('recent benchmarks')
  .action(() => {
    if (!benchOn()) return;
    const rows = listBenchmarks(getDb());
    if (!rows.length) return console.log('(no benchmarks)');
    for (const b of rows) {
      console.log(`${b.id}  ${pad(b.status, 12)} ${pad(b.domain, 10)} arms ${b.arms_done}/${b.arm_count}  winner=${b.winner ?? '-'}  ${b.title}`);
    }
  });

bench
  .command('show <id>')
  .description('per-arm verification, judge scores and ranking')
  .action((id: string) => {
    if (!benchOn()) return;
    const d = getBenchmark(getDb(), id);
    if (!d) return fail(`no such benchmark: ${id}`);
    const b = d.benchmark;
    console.log(`${b.id}  ${b.title}\n  domain=${b.domain} status=${b.status} judge=${b.judge_model} winner=${b.winner ?? '-'}`);
    if (b.error) console.log(`  error: ${b.error}`);
    if (b.summary) console.log(`  summary: ${b.summary}`);
    for (const a of [...d.arms].sort((x, y) => (x.judge_rank ?? 99) - (y.judge_rank ?? 99))) {
      console.log(
        `  #${a.judge_rank ?? '-'} ${pad(a.model, 28)} score=${a.judge_score ?? '-'} verify=${a.verify_outcome ?? '-'} ` +
          `tokens_out=${a.tokens_out ?? '-'} time=${a.duration_s ?? '-'}s task=${a.task_id} [${a.task_status ?? '?'}]`,
      );
      if (a.notes) console.log(`      ${a.notes}`);
    }
  });

bench
  .command('matrix')
  .description('model x domain results over all judged benchmarks')
  .action(() => {
    if (!benchOn()) return;
    const rows = benchmarkMatrix(getDb());
    if (!rows.length) return console.log('(no judged benchmarks yet)');
    console.log(`${pad('domain', 11)} ${pad('model', 28)} ${pad('n', 3)} ${pad('score', 6)} ${pad('win', 5)} ${pad('verify', 7)} tokens_out  time`);
    for (const r of rows) {
      console.log(
        `${pad(r.domain, 11)} ${pad(r.model, 28)} ${pad(String(r.n), 3)} ${pad(String(r.avg_score ?? '-'), 6)} ` +
          `${pad(`${Math.round(r.win_rate * 100)}%`, 5)} ${pad(`${Math.round(r.verify_pass_rate * 100)}%`, 7)} ${pad(String(r.avg_tokens_out ?? '-'), 11)} ${r.avg_duration_s ?? '-'}s`,
      );
    }
  });

bench
  .command('judge <id>')
  .description('judge now (e.g. retry after judge_failed); arms must all be finished')
  .action(async (id: string) => {
    if (!benchOn()) return;
    const db = getDb();
    const d = getBenchmark(db, id);
    if (!d) return fail(`no such benchmark: ${id}`);
    const pending = d.arms.filter((a) => !['review', 'attention', 'failed', 'closed'].includes(a.task_status ?? 'failed'));
    if (pending.length) return fail(`${pending.length} arm(s) still running`);
    const b = await judgeBenchmark(db, id);
    if (!b) return fail('judge already in progress');
    console.log(`${b.id}: ${b.status}${b.winner ? `  winner=${b.winner}` : ''}${b.error ? `  error=${b.error}` : ''}`);
  });

const prdCmd = program
  .command('prd')
  .description('PRD gate: lint + local-model review a PRD, then turn it into a queued task or a benchmark');

function printPrdCheck(r: PrdCheck): void {
  console.log(r.ok ? 'PRD: OK ✓' : 'PRD: BLOCKED ✗');
  for (const m of r.missing) console.log(`  ✗ ${m}`);
  for (const w of r.warnings) console.log(`  ! ${w}`);
  const llm =
    r.llm.status === 'ok' ? `ok=${r.llm.ok}`
      : r.llm.status === 'unavailable' ? 'unavailable (no local model ready)'
      : r.llm.status === 'error' ? `failed: ${r.llm.error}`
      : 'skipped (fix the structure first)';
  console.log(`  local-model review: ${llm}`);
  for (const q of r.llm.questions) console.log(`  ? ${q}`);
  for (const n of r.llm.risk_notes) console.log(`  ~ ${n}`);
}
const prdOn = (): boolean => {
  if (getBool(getDb(), 'prd_gate_enabled', false)) return true;
  fail('PRD gate disabled — loop config set prd_gate_enabled true');
  return false;
};

prdCmd
  .command('template')
  .description('print the PRD template the gate expects (paste it into Opus/Fable)')
  .action(() => {
    process.stdout.write(fs.readFileSync(path.join(ENGINE_REPO_ROOT, 'seed', 'prd-template.md'), 'utf8'));
  });

prdCmd
  .command('check <file>')
  .description('lint + local-model review; exit code 1 when blocked')
  .action(async (file: string) => {
    if (!prdOn()) return;
    const r = await checkPrd(getDb(), fs.readFileSync(file, 'utf8'));
    printPrdCheck(r);
    if (!r.ok) process.exitCode = 1;
  });

prdCmd
  .command('submit <file>')
  .option('--verify-llm', 'also run the cloud claude -p judge against the acceptance rubric (spends token)')
  .description('re-check, save the PRD as the plan, and create a queued task (or a benchmark)')
  .option('--model <model>', 'implementation model (default prd_default_model / local default_model)')
  .option('--draft', 'leave the task as a draft instead of queueing it')
  .option('--bench-models <csv>', '2+ models: create a benchmark from this PRD instead of one task')
  .action(async (file: string, o) => {
    if (!prdOn()) return;
    try {
      const r = await submitPrd(getDb(), fs.readFileSync(file, 'utf8'), {
        verify_llm: Boolean(o.verifyLlm),
        model: o.model,
        queue: !o.draft,
        benchmark_models: o.benchModels ? csvList(o.benchModels) : undefined,
      });
      if (!r.ok) {
        printPrdCheck(r.check);
        process.exitCode = 1;
        return;
      }
      if (r.kind === 'benchmark') {
        console.log(`benchmark ${r.benchmark.id} created from PRD (${r.arms.map((a) => a.model).join(', ')})`);
      } else {
        console.log(`${r.task.id} -> ${r.task.status}  model=${r.task.model ?? '(default_model)'}  plan=${r.plan_ref}`);
        if (!r.gate.ok) console.log(`  gate: MISSING -> ${r.gate.missing.join('; ')}`);
      }
    } catch (err) {
      if (err instanceof PrdInputError || err instanceof BenchmarkInputError) return fail(err.message);
      throw err;
    }
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

const report = program
  .command('report')
  .description('OpenProject reports from a natural-language description, with reusable boss-persona templates');

report
  .command('generate <description>')
  .description('generate an OpenProject project report from a description (prints markdown to stdout)')
  .option('--project <name>', 'project name/keyword (skips description -> project parsing)')
  .option('--template <name>', 'named report template to use (see: loop report templates)')
  .option('--save', 'persist markdown + WP snapshot + chart .mmd files under report_output_dir, even if report_persist is off')
  .action(async (description: string, o) => {
    const db = getDb();
    if (!getBool(db, 'report_enabled', false)) {
      return fail('report_enabled is false — enable it first: loop config set report_enabled true');
    }
    const result = await generateReport(db, { description, project: o.project, template: o.template, save: o.save });
    if (!result) return fail('report generation failed (check report_enabled / hard_limit_pct / claude CLI availability)');
    console.log(result.markdown);
    console.error(
      `\n[meta] source=${result.meta.source} project=${result.meta.project ?? '-'} items=${result.meta.itemCount}` +
        (result.meta.template ? ` template=${result.meta.template}` : '') +
        (result.meta.charts.length ? ` charts=${result.meta.charts.join(',')}` : ''),
    );
    if (result.files?.length) {
      console.error(`[saved]\n${result.files.map((f) => `  ${f}`).join('\n')}`);
    }
  });

const reportTemplates = report
  .command('templates')
  .description('list report templates')
  .action(() => {
    const defs = listReportTemplates(getDb());
    if (!defs.length) {
      console.log('(no report templates — seeded personas should exist by default)');
      return;
    }
    for (const d of defs) console.log(`${pad(d.name, 24)} ${d.description ?? ''}`);
  });

reportTemplates
  .command('add')
  .description('bulk-import report templates from a JSON file ({"items":[...]})')
  .requiredOption('--file <path>', 'JSON file path')
  .action((o) => {
    const db = getDb();
    const data = JSON.parse(fs.readFileSync(o.file, 'utf8'));
    const items = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : [data];
    const result = importReportTemplates(db, items);
    console.log(`import: created=${result.created} updated=${result.updated} rejected=${result.rejected.length}`);
    for (const r of result.rejected) console.log(`  [${r.index}] ${r.error}`);
  });

const reportPptx = report
  .command('pptx')
  .description('企業週報 PPTX — deterministic fill-only renderer (see docs/report-pptx-authoring.md)');

function requirePptxEnabled(db: ReturnType<typeof getDb>): boolean {
  if (!getBool(db, 'report_pptx_enabled', false)) {
    fail('report_pptx_enabled is false — enable it first: loop config set report_pptx_enabled true');
    return false;
  }
  return true;
}

/** Streams scripts/report_pptx.py's --probe/--validate output straight through to this
 * process's stdio -- unlike --render (renderDeck) these modes are interactive/manual
 * tools whose whole point is for a human to read the raw output, not to be parsed. */
function runPptxScript(db: ReturnType<typeof getDb>, args: string[]): Promise<number> {
  const scriptPath = path.join(ENGINE_REPO_ROOT, 'scripts', 'report_pptx.py');
  return new Promise((resolve) => {
    const child = spawn(resolvePythonBin(db), [scriptPath, ...args], { stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`could not start python (${resolvePythonBin(db)}): ${err.message}`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

reportPptx
  .command('render')
  .description('render a DeckSpec JSON file into a .pptx via scripts/report_pptx.py')
  .requiredOption('--spec <file>', 'DeckSpec JSON file path (see seed/report-pptx/sample-deck-spec.json)')
  .option('--out <file>', 'output .pptx path (default: <report_pptx_dir>/weeks/adhoc/weekly-<today>.pptx)')
  .option('--template <file>', 'override report_pptx_template (persists the setting)')
  .option('--manifest <file>', 'override report_pptx_manifest (persists the setting)')
  .action(async (o) => {
    const db = getDb();
    if (!requirePptxEnabled(db)) return;

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(o.spec, 'utf8'));
    } catch (e) {
      return fail(`could not read/parse --spec ${o.spec}: ${(e as Error).message}`);
    }
    const validated = validateDeckSpec(raw);
    if (!validated.ok) return fail(`invalid deck spec: ${validated.error}`);

    if (o.template) setSetting(db, 'report_pptx_template', path.resolve(o.template));
    if (o.manifest) setSetting(db, 'report_pptx_manifest', path.resolve(o.manifest));

    const pptxDir = getSetting(db, 'report_pptx_dir') || DEFAULT_SETTINGS.report_pptx_dir || '';
    const outPath = o.out
      ? path.resolve(o.out)
      : path.join(pptxDir, 'weeks', 'adhoc', `weekly-${new Date().toISOString().slice(0, 10)}.pptx`);

    const result = await renderDeck(db, validated.spec, { out: outPath });
    if (!result) return fail('render failed (check report_pptx_python / template / manifest / logs)');
    console.log(`output: ${result.output}`);
    console.log(`slides: ${result.slides}`);
    if (result.warnings.length) {
      console.error('[warnings]');
      for (const w of result.warnings) console.error(`  ${w}`);
    }
  });

reportPptx
  .command('probe')
  .description('inventory every shape (name/type/text/table dims) in a .pptx — template-authoring discovery aid')
  .option('--file <pptx>', 'pptx to probe (default: resolved report_pptx_template)')
  .action(async (o) => {
    const db = getDb();
    if (!requirePptxEnabled(db)) return;
    const file = o.file ? path.resolve(o.file) : resolveTemplatePath(db);
    process.exitCode = await runPptxScript(db, ['--probe', file]);
  });

reportPptx
  .command('validate')
  .description('validate report_pptx_template against report_pptx_manifest (shape names / pool / capacity / sha256)')
  .action(async () => {
    const db = getDb();
    if (!requirePptxEnabled(db)) return;
    process.exitCode = await runPptxScript(db, ['--validate', '--template', resolveTemplatePath(db), '--manifest', resolveManifestPath(db)]);
  });

reportPptx
  .command('qa')
  .description('LibreOffice+pdftoppm visual QA pass for a rendered .pptx (PNGs land under its own qa/ dir)')
  .requiredOption('--file <pptx>', 'pptx to QA')
  .action(async (o) => {
    const db = getDb();
    if (!requirePptxEnabled(db)) return;
    const result = await qaRender(db, path.resolve(o.file));
    if (!result) return fail('qa failed (soffice/pdftoppm unavailable or failed — see stderr)');
    console.log(`pdf: ${result.pdf}`);
    for (const img of result.images) console.log(`image: ${img}`);
  });

/** Accumulates repeated `--current <key>=<idx>` flags into a Record for prepareWeekly's
 * currentOverrides — malformed entries (no `=`, non-numeric index) are silently skipped
 * rather than failing the whole command over one typo. */
function collectCurrentOverride(value: string, prev: Record<string, number>): Record<string, number> {
  const eq = value.indexOf('=');
  if (eq === -1) return prev;
  const key = value.slice(0, eq).trim();
  const idx = Number(value.slice(eq + 1).trim());
  if (key && Number.isFinite(idx)) prev[key] = idx;
  return prev;
}

const reportWeekly = report
  .command('weekly')
  .description('每週企業週報 PPTX 流程 — prepare 組草稿+抓 WP 快照,人工把關後 render 出片 (see docs/report-pptx-authoring.md)');

reportWeekly
  .command('prepare')
  .description('組裝本週 deck-spec 草稿 + WP 快照 + explain-pages 骨架,供人工編輯把關')
  .option('--week <week>', 'ISO week id (YYYY-Www), default = this week')
  .option('--current <kv>', '<projectKey>=<index> current_index override, repeatable', collectCurrentOverride, {})
  .option('--no-llm', '停用 LLM status 生成，維持 T2 全黑沿用行為')
  .action(async (o) => {
    const db = getDb();
    if (!requirePptxEnabled(db)) return;
    const result = await prepareWeekly(db, { week: o.week, currentOverrides: o.current, llm: o.llm });
    if (!result) return fail('prepare failed (see stderr)');
    console.log(`spec: ${result.specPath}`);
    console.log(`explain: ${result.explainPath}`);
    if (result.warnings.length) {
      console.error('[warnings]');
      for (const w of result.warnings) console.error(`  ${w}`);
    }
  });

reportWeekly
  .command('render')
  .description('重驗證 + 重上色 + 渲染本週 deck-spec,回寫最終出貨內容')
  .option('--week <week>', 'ISO week id (YYYY-Www), default = this week')
  .option('--qa', 'also run the LibreOffice+pdftoppm visual QA pass')
  .option('--allow-unapproved', 'render explain pages even when explain-pages.json is not approved')
  .action(async (o) => {
    const db = getDb();
    if (!requirePptxEnabled(db)) return;
    const result = await renderWeekly(db, { week: o.week, allowUnapproved: o.allowUnapproved, qa: o.qa });
    if (!result) return fail('render failed (see stderr)');
    console.log(`output: ${result.output}`);
    console.log(`slides: ${result.slides}`);
    if (result.warnings.length) {
      console.error('[warnings]');
      for (const w of result.warnings) console.error(`  ${w}`);
    }
  });

function reportQualityFlagsSummary(qualityFlags: Record<string, string[]>): void {
  const flagged = Object.entries(qualityFlags);
  if (!flagged.length) return;
  console.error('[quality flags]');
  for (const [key, flags] of flagged) console.error(`  ${key}: ${flags.join('; ')}`);
}

reportWeekly
  .command('run')
  .description('一鍵:本週 deck-spec 不存在則 prepare+render,已存在則只 render(把關安全:未批准說明頁一律不進 deck)')
  .option('--week <week>', 'ISO week id (YYYY-Www), default = this week')
  .option('--qa', 'also run the LibreOffice+pdftoppm visual QA pass')
  .option('--no-llm', '停用 LLM status 生成 (僅在本次需要 prepare 時生效)')
  .action(async (o) => {
    const db = getDb();
    if (!requirePptxEnabled(db)) return;
    const result = await runWeekly(db, { week: o.week, qa: o.qa, llm: o.llm });
    if (!result) return fail('run failed (see stderr)');
    console.log(`output: ${result.output}`);
    console.log(`slides: ${result.slides}`);
    const gateLabel = result.explainApproved
      ? `${result.explainPageCount} 頁已批准`
      : `${result.explainPageCount} 頁未批准(已剔除)`;
    console.log(`說明頁狀態: ${gateLabel}`);
    reportQualityFlagsSummary(result.qualityFlags);
    if (result.warnings.length) {
      console.error('[warnings]');
      for (const w of result.warnings) console.error(`  ${w}`);
    }
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
  .description('register an ingestion source (exactly one of --git/--folder/--vault/--openproject)')
  .option('--git <path>', 'git repo — tracked files via `git ls-files` (respects .gitignore)')
  .option('--folder <path>', 'plain folder — recursive walk')
  .option('--vault <path>', 'Obsidian-style markdown vault — recursive walk')
  .option('--openproject <path>', 'OpenProject connector — local path to the OpenProject_Exec_Report repo (reuses its op_api.py + config.json)')
  .option('--op-config <path>', 'openproject only: override path to config.json (default: <openproject-repo>/config.json)')
  .option('--kinds <csv>', 'openproject only: comma-separated work_packages,projects (default: both)')
  .option('--include <csv>', 'comma-separated include globs')
  .option('--exclude <csv>', 'comma-separated exclude globs')
  .option('--branch <name>', 'git ref to list from (git sources only; default: working tree)')
  .option('--disabled', 'register disabled (skipped by `loop ingest run` with no source id)')
  .action((o) => {
    const kind: SourceKind | null = o.git ? 'git' : o.folder ? 'folder' : o.vault ? 'vault' : o.openproject ? 'openproject' : null;
    if (!kind) return fail('usage: loop ingest add --git|--folder|--vault|--openproject <path>');

    if (kind === 'openproject') {
      const opRepo = path.resolve(o.openproject);
      const opConfigPath = o.opConfig ? path.resolve(o.opConfig) : path.join(opRepo, 'config.json');
      let raw: string;
      try {
        raw = fs.readFileSync(opConfigPath, 'utf8');
      } catch (e) {
        return fail(`could not read OpenProject config at ${opConfigPath}: ${(e as Error).message}`);
      }
      let parsedConfig: unknown;
      try {
        parsedConfig = JSON.parse(raw);
      } catch {
        return fail(`OpenProject config at ${opConfigPath} is not valid JSON`);
      }
      const baseUrl =
        parsedConfig && typeof parsedConfig === 'object'
          ? (parsedConfig as Record<string, unknown>).op_base_url
          : undefined;
      if (typeof baseUrl !== 'string' || !baseUrl) {
        return fail(`OpenProject config at ${opConfigPath} has no "op_base_url" field`);
      }
      const config: SourceConfig = {
        op_repo: opRepo,
        op_config: o.opConfig ? opConfigPath : undefined,
        kinds: o.kinds ? String(o.kinds).split(',').map((s: string) => s.trim()).filter(Boolean) : undefined,
      };
      const source = createSource(getDb(), {
        kind,
        uri: baseUrl.replace(/\/+$/, ''),
        config,
        enabled: !o.disabled,
      });
      console.log(`${source.id}  [${source.kind}] ${source.uri}`);
      return;
    }

    const uri = o.git ?? o.folder ?? o.vault;
    if (!uri) return fail('usage: loop ingest add --git|--folder|--vault <path>');
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

// ---- 模型對話 (web/index.html) --------------------------------------------
const chat = program.command('chat').description('模型對話 history (web/index.html)');

chat
  .command('prune')
  .description('delete conversations older than the retention window (dry-run unless --yes)')
  .option('--days <n>', 'override chat_retention_days for this run', (v) => parseInt(v, 10))
  .option('--yes', 'actually delete (otherwise dry-run)')
  .action((o) => {
    const db = getDb();
    const days = Number.isFinite(o.days) ? o.days : getNum(db, 'chat_retention_days', 0);
    if (!days || days <= 0) {
      console.log('chat_retention_days = 0 (keep forever). Pass --days <n> to prune anyway.');
      return;
    }
    const doomed = db
      .prepare(`SELECT id, title, updated_at FROM chat_conversations WHERE updated_at < datetime('now', ?)`)
      .all(`-${Math.floor(days)} days`) as { id: string; title: string; updated_at: string }[];
    if (!doomed.length) return console.log(`nothing older than ${days} day(s)`);
    for (const c of doomed) console.log(`  ${o.yes ? 'delete' : 'would delete'} ${c.id}  ${c.updated_at}  ${c.title}`);
    if (!o.yes) {
      console.log(`\n${doomed.length} conversation(s) — dry-run. Re-run with --yes to delete.`);
      return;
    }
    const { conversations, files } = pruneConversations(db, days);
    console.log(`\npruned ${conversations} conversation(s), ${files} image file(s)`);
  });

chat
  .command('export <id>')
  .description('print one conversation as Markdown')
  .option('--user <key>', "user_key that owns it (default: the conversation's own)")
  .option('--reasoning', 'include 思考過程')
  .action((id: string, o) => {
    const db = getDb();
    const owner =
      o.user ?? (db.prepare('SELECT user_key FROM chat_conversations WHERE id = ?').get(id) as { user_key?: string } | undefined)?.user_key;
    const conv = owner ? getConversation(db, id, owner) : null;
    if (!conv) return fail(`no such conversation: ${id}`);
    process.stdout.write(toMarkdown(conv, messagesFor(db, id), { includeReasoning: Boolean(o.reasoning) }));
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
