#!/usr/bin/env node
// Loop Engineering MCP server.
// Lets any MCP client (e.g. Claude Code in VS Code) create and manage coding tasks
// in Loop Engineering by talking to its local REST API. You describe WHAT to fix and
// the GOAL; the server auto-detects the repo, base branch, verification steps and
// setup command, synthesizes a plan, creates the task, and (by default) queues it.
//
// Config (auto-detected; override via env if needed):
//   LOOP_API_URL      base URL of the board API   (default http://127.0.0.1:<port>)
//   LOOP_API_TOKEN    bearer token for /api/*     (default: read from the deploy env file)
//   LOOP_DATA_DIR     data dir for saved plans    (default ~/.local/share/loop-engineering)
//   LOOP_DEFAULT_REPO fallback repo when none is passed / detected
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readEnvFile, BASE, createApi } from './lib.mjs';

const ENVF = readEnvFile();
const TOKEN = process.env.LOOP_API_TOKEN || ENVF.LOOP_API_TOKEN || '';
const DATA_DIR = process.env.LOOP_DATA_DIR || ENVF.LOOP_DATA_DIR ||
  path.join(os.homedir(), '.local', 'share', 'loop-engineering');
const PLANS_DIR = path.join(DATA_DIR, 'plans');

const api = createApi({ base: BASE, token: TOKEN });

// ---- auto-detection helpers (so the caller only needs the fix + goal) ----
function git(repo, args) {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return ''; }
}
/** Resolve the target git repo: explicit path, else LOOP_DEFAULT_REPO, else the MCP cwd. */
function detectRepo(given) {
  for (const c of [given, process.env.LOOP_DEFAULT_REPO, process.cwd()]) {
    if (!c) continue;
    const top = git(c, ['rev-parse', '--show-toplevel']);
    if (top) return top;
  }
  return given || null; // may be non-git; the gate will flag it
}
/** Default branch: origin's HEAD, else main/master, else the current branch. */
function detectBranch(repo, given) {
  if (given) return given;
  if (!repo) return 'main';
  const head = git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (head) return head.replace(/^origin\//, '');
  for (const b of ['main', 'master']) if (git(repo, ['rev-parse', '--verify', '--quiet', b])) return b;
  return git(repo, ['branch', '--show-current']) || 'main';
}
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
/** Verification steps inferred from the repo's toolchain (never build+typecheck redundantly). */
function detectVerify(repo) {
  if (!repo) return [];
  const pj = readJSON(path.join(repo, 'package.json'));
  if (pj && pj.scripts) {
    const s = pj.scripts, out = [];
    if (s.lint) out.push('npm run lint');
    if (s.typecheck) out.push('npm run typecheck');
    else if (s['type-check']) out.push('npm run type-check');
    else if (s.build) out.push('npm run build');
    if (s.test) out.push('npm test');
    return out.length ? out : ['npm test'];
  }
  if (fs.existsSync(path.join(repo, 'go.mod'))) return ['go build ./...', 'go test ./...'];
  if (fs.existsSync(path.join(repo, 'Cargo.toml'))) return ['cargo build', 'cargo test'];
  if (fs.existsSync(path.join(repo, 'pyproject.toml')) || fs.existsSync(path.join(repo, 'requirements.txt'))) return ['python -m pytest'];
  if (fs.existsSync(path.join(repo, 'Makefile'))) return ['make test'];
  return [];
}
/** Setup command (deps install) inferred from the repo. */
function detectSetup(repo, given) {
  if (given !== undefined && given !== null) return given;
  if (!repo) return null;
  if (fs.existsSync(path.join(repo, 'package-lock.json'))) return 'npm ci';
  if (fs.existsSync(path.join(repo, 'pnpm-lock.yaml'))) return 'pnpm install --frozen-lockfile';
  if (fs.existsSync(path.join(repo, 'yarn.lock'))) return 'yarn install --frozen-lockfile';
  if (fs.existsSync(path.join(repo, 'package.json'))) return 'npm install';
  if (fs.existsSync(path.join(repo, 'requirements.txt'))) return 'pip install -r requirements.txt';
  return null;
}

// ---- plan handling: inline markdown / synthesized plan -> a persisted .md file ----
function firstLine(s) {
  return String(s ?? '').split(/[\n。.!?！？]/)[0].trim().slice(0, 80) || 'task';
}
function synthPlan(title, goal, steps) {
  const v = (steps.length ? steps : ['(待補：驗證步驟)']).map((s) => '- `' + s + '`').join('\n');
  return `# ${title}\n\n## 目標\n${goal}\n\n## 驗證步驟\n${v}\n\n> 本計畫由 loop-engineering MCP 依你的描述自動產生。\n`;
}
function resolvePlan(plan, title) {
  const s = String(plan ?? '').trim();
  if (!s) return { plan_ref: null, plan_kind: null };
  if (/^https?:\/\//i.test(s)) return { plan_ref: s, plan_kind: 'url' };
  if (/\.(md|html?)$/i.test(s) && s.length < 512 && fs.existsSync(s)) {
    return { plan_ref: s, plan_kind: /\.html?$/i.test(s) ? 'html' : 'md' };
  }
  fs.mkdirSync(PLANS_DIR, { recursive: true });
  const slug = (title || 'plan').replace(/[^\w一-鿿-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'plan';
  const file = path.join(PLANS_DIR, `${slug}-${Date.now()}.md`);
  fs.writeFileSync(file, s.endsWith('\n') ? s : s + '\n', 'utf8');
  return { plan_ref: file, plan_kind: 'md' };
}
function normSteps(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}

const server = new McpServer({ name: 'loop-engineering', version: '1.2.0' });

server.registerTool('loop_add_task', {
  title: 'Add a Loop Engineering task (minimal input)',
  description:
    'Hand a coding job to Loop Engineering — the token-aware autonomous scheduler that runs Claude Code in an isolated git worktree when the usage budget allows. ' +
    'DESIGNED FOR MINIMAL INPUT: the user normally only states WHAT to fix and the GOAL. You should call this with just { goal } (and a short title if handy); everything else is AUTO-DETECTED from the target repo: ' +
    'repo_path (from the current workspace / git), base_branch (origin default → main), verification_steps (from package.json scripts / go / cargo / python), setup_cmd (npm ci / etc.), and the plan (synthesized from the goal). ' +
    'ALWAYS pass repo_path = the current VS Code workspace root when you know it (most reliable). ' +
    'By DEFAULT the task is QUEUED for execution (queue defaults true); pass queue=false only if the user says to keep it as a draft to review on the board. ' +
    'The result echoes every AUTO-FILLED value and the gate result. Only ask the user about a field if the gate reports it MISSING and it cannot be auto-detected (e.g. no repo found, or no verify command discoverable).',
  inputSchema: {
    goal: z.string().describe('REQUIRED. What the task must achieve (the fix and its intent). Usually the only thing the user provides.'),
    title: z.string().optional().describe('Short title; if omitted, derived from the goal.'),
    repo_path: z.string().optional().describe('Target git repo (absolute). Prefer passing the current workspace root. If omitted, auto-detected from LOOP_DEFAULT_REPO / the MCP cwd.'),
    base_branch: z.string().optional().describe('If omitted, auto-detected: origin default branch, else main/master.'),
    verification_steps: z.union([z.array(z.string()), z.string()]).optional().describe('Commands that must all exit 0 to pass. If omitted, auto-detected from the repo (e.g. ["npm run typecheck","npm test"]).'),
    setup_cmd: z.string().optional().describe('Deps install run before dispatch. If omitted, auto-detected (npm ci / pip install ...).'),
    plan: z.string().optional().describe('markdown text / .md path / URL. If omitted, synthesized from title+goal+verify.'),
    coding_tool: z.enum(['claude-code', 'mock', 'generic', 'plan']).optional().describe('default "claude-code"; "mock" is a zero-token dry run; "generic" runs the real agent in a persistent output dir with NO git/repo/PR — for non-coding work (reports, data analysis, one-off scripts); "plan" is an EPIC — hand it one big goal and an AI planner decomposes it into 2-6 concrete subtasks, chains them with depends_on, and executes them autonomously one after another (use this instead of decomposing a large feature into multiple loop_add_task calls yourself). repo/base are skipped for generic; optional for plan (inherited by its children if given). give generic verify_mode=manual or llm (or explicit verification_steps); plan needs no verification_steps at all.'),
    complexity: z.enum(['S', 'M', 'L']).optional().describe('S/M/L — sets timeout, estimate, model routing (default M).'),
    priority: z.number().int().optional().describe('integer priority (default 2; lower runs first).'),
    model: z.string().optional().describe('sonnet | opus | default | local:<id> (optional). local:<id> runs on the local vLLM model via opencode — zero Anthropic tokens; list ids with loop_local_models.'),
    queue: z.boolean().optional().describe('default TRUE — queue for execution if the gate passes. false = leave as draft.'),
    depends_on: z.string().optional().describe('Task id this one waits for (serial chain): held until that task is CLOSED, then auto-queued. Use to run tasks strictly one after another.'),
    environment: z.string().optional().describe('Environment label (e.g. "company", "home") this task should be scoped to — pulls in matching env:<name> knowledge nodes when the task runs.'),
    verify_mode: z.string().optional().describe('CSV of command|llm|manual (default "command"). "llm" judges the diff against verify_rubric/goal; "manual" (or an inconclusive llm judge) defers to a human — the task still reaches review with a backup PR, merge deferred until you verify and press 合併.'),
    verify_rubric: z.string().optional().describe('Acceptance criteria — what "done" means. Required when verify_mode includes "llm"; also shown to a human for a "manual" review.'),
    verify_timeout_min: z.number().int().optional().describe('Per-task verify per-step timeout override, in minutes (default: the verify_step_timeout_min setting, 10).'),
    requires: z.string().optional().describe('CSV of capability tokens this task needs this HOST to have (e.g. "gpu", "camera", "network", "os:windows"). If the host\'s `host_capabilities` setting is missing one, command verification is skipped and the task auto-defers to manual review instead of failing — use this when a task needs hardware/OS this machine may not have.'),
    experiment: z.string().optional().describe('A/B cohort label for measurement (e.g. "ab_A"/"ab_B"). Pure tag — never affects scheduling/gate; compare cohorts later with the `loop experiment` CLI or metrics.experiment_ab.'),
    acceptance_metrics: z.string().optional().describe('Thresholds the ENGINE checks, e.g. "kernels_pass == 4; ncu_ok == 1; mem_throughput_pct >= 60". A verification step must print one line `LOOP_METRICS {"name": number, ...}`; a metric that is missing or misses its threshold fails verification. Use this whenever "done" is measurable — never let a skipped measurement count as a pass.'),
    protected_paths: z.string().optional().describe('CSV of repo-relative globs the implementer must not change (the checker, golden data), e.g. "tests/eval/**,scripts/check.sh". Changing one fails verification.'),
  },
}, async (a) => {
  const isMock = a.coding_tool === 'mock';
  const isGeneric = a.coding_tool === 'generic';
  const isPlan = a.coding_tool === 'plan';
  const skipRepoDetect = isMock || isGeneric || isPlan; // plan's repo/base (if given) are only inherited by its children
  const title = (a.title && a.title.trim()) ? a.title.trim().slice(0, 80) : firstLine(a.goal);
  const repo = skipRepoDetect ? (a.repo_path ?? null) : detectRepo(a.repo_path);
  const base = skipRepoDetect ? (a.base_branch ?? null) : detectBranch(repo, a.base_branch);
  let steps = normSteps(a.verification_steps);
  if (!steps.length) steps = isMock ? ['true'] : (isGeneric || isPlan) ? [] : detectVerify(repo);
  const setup = (isMock || isPlan) ? null : detectSetup(repo, a.setup_cmd);
  const planText = (a.plan && a.plan.trim()) ? a.plan : synthPlan(title, a.goal, steps);
  const { plan_ref, plan_kind } = resolvePlan(planText, title);

  const created = await api('/api/tasks', {
    method: 'POST',
    body: {
      title,
      goal: a.goal,
      plan_ref,
      plan_kind,
      coding_tool: a.coding_tool ?? 'claude-code',
      verification_steps: steps,
      setup_cmd: setup,
      repo_path: repo,
      base_branch: base,
      complexity: a.complexity ?? 'M',
      priority: a.priority ?? 2,
      model: a.model ?? null,
      depends_on: a.depends_on ?? null,
      environment: a.environment ?? null,
      verify_mode: a.verify_mode ?? null,
      verify_rubric: a.verify_rubric ?? null,
      verify_timeout_min: a.verify_timeout_min ?? null,
      requires: a.requires ?? null,
      experiment: a.experiment ?? null,
      acceptance_metrics: a.acceptance_metrics ?? null,
      protected_paths: a.protected_paths ?? null,
    },
  });
  const id = created.task?.id;
  const gate = created.gate ?? { ok: false, missing: ['unknown'], warnings: [] };
  const wantQueue = a.queue !== false; // DEFAULT: queue
  let queued = false, note = '';
  if (wantQueue) {
    if (gate.ok) {
      // auto=true routes through the controlled queue path (max_autoqueue cap) so a burst
      // of MCP calls can't flood autonomous spend; a rejection leaves the task as a draft.
      try {
        await api(`/api/tasks/${id}/queue`, { method: 'POST', body: { auto: true } });
        queued = true;
      } catch (e) {
        note = `Auto-queue skipped: ${e.message}\nLeft as draft — queue it from the board / loop_queue_task, or raise max_autoqueue.`;
      }
    } else {
      note = 'Wanted to queue but the gate is not satisfied — left as draft. Fix the missing fields below.';
    }
  }
  const autofill = [
    `  repo:   ${repo ?? '(none — please provide repo_path)'}`,
    `  branch: ${base ?? '(n/a)'}`,
    `  verify: ${steps.length ? steps.join(' , ') : '(none detected — please provide verification_steps)'}`,
    `  setup:  ${setup ?? '(none)'}`,
    `  plan:   ${plan_kind === 'url' ? plan_ref : (plan_ref ? path.basename(plan_ref) + ' (auto-synthesized)' : '(none)')}`,
  ].join('\n');
  const lines = [
    `Task ${id} — status: ${queued ? 'queued ✓ (will run when budget allows)' : (created.task?.status ?? 'draft')}`,
    `Title: ${title}`,
    'Auto-filled:',
    autofill,
    gate.ok ? 'Gate: OK ✓' : `Gate: MISSING -> ${gate.missing.join('; ')}`,
    ...(gate.warnings?.length ? [`Warnings: ${gate.warnings.join('; ')}`] : []),
    ...(note ? [note] : []),
    queued
      ? 'Done — enqueued. Tell the user it is queued; they can watch/close it on the board.'
      : (gate.ok ? 'Left as draft (queue=false). Call loop_queue_task or use the board to run it.'
        : 'Ask the user only for the MISSING field(s) that could not be auto-detected, then call loop_add_task again.'),
  ];
  return { content: [{ type: 'text', text: lines.join('\n') + '\n\n' + JSON.stringify({ id, status: queued ? 'queued' : created.task?.status, gate, autofilled: { repo, base, steps, setup } }) }] };
});

// ---- knowledge base: 記住/回想/連結 from any chat, thin REST clients ----

server.registerTool('loop_remember', {
  title: 'Remember a fact into the Loop knowledge base',
  description:
    '記住一件事 — save a durable fact/preference/constraint/environment note so future Loop tasks and chats can recall it. ' +
    'Use this whenever the user says something like 「記住：...」or states a lasting preference, constraint, or environment detail ' +
    '(not a one-off, in-conversation detail). Pick `kind` from environment|project|constraint|preference|tech|fact (default "fact") ' +
    'based on what the text describes, and `scope` from context: "global" (default, applies everywhere), "repo:<absolute path>" ' +
    '(specific to one repo — use the current workspace root), or "env:<name>" (specific to a named environment, e.g. "env:company"). ' +
    'Dedup key is (title, scope): remembering the same title again updates the existing node instead of duplicating it.',
  inputSchema: {
    text: z.string().describe('REQUIRED. The fact/body text to remember, verbatim or lightly cleaned up.'),
    title: z.string().optional().describe('Short title; if omitted, derived from the first line/sentence of text.'),
    kind: z.string().optional().describe('environment | project | constraint | preference | tech | fact | person | repo (default "fact").'),
    tags: z.union([z.array(z.string()), z.string()]).optional().describe('optional tags (array or comma-separated string).'),
    scope: z.string().optional().describe('"global" (default) | "repo:<absolute path>" | "env:<name>".'),
  },
}, async (a) => {
  const title = (a.title && a.title.trim()) ? a.title.trim().slice(0, 80) : firstLine(a.text);
  const tags = normSteps(a.tags);
  try {
    const created = await api('/api/knowledge', {
      method: 'POST',
      body: {
        title,
        body: a.text,
        kind: a.kind ?? 'fact',
        tags,
        scope: a.scope ?? 'global',
        source: 'mcp',
      },
    });
    const n = created.node ?? {};
    return { content: [{ type: 'text', text: `Remembered ${n.id} — [${n.kind}] ${n.title} (scope: ${n.scope})` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Could not remember: ${e.message}` }] };
  }
});

server.registerTool('loop_recall', {
  title: 'Recall facts from the Loop knowledge base',
  description:
    '回想 — full-text search the Loop knowledge base for facts/preferences/constraints/environment notes relevant to the current ' +
    'task or conversation. Use before starting work that might be affected by a known constraint or environment detail.',
  inputSchema: {
    q: z.string().describe('REQUIRED. Search query (keywords or phrase).'),
    kind: z.string().optional().describe('optional kind filter: environment|project|constraint|preference|tech|fact|person|repo.'),
    limit: z.number().int().optional().describe('max results (default 10).'),
  },
}, async (a) => {
  try {
    const qs = new URLSearchParams({ q: a.q });
    if (a.kind) qs.set('kind', a.kind);
    const res = await api(`/api/knowledge?${qs.toString()}`);
    let nodes = Array.isArray(res.nodes) ? res.nodes : [];
    const limit = a.limit ?? 10;
    nodes = nodes.slice(0, limit);
    if (!nodes.length) return { content: [{ type: 'text', text: `(no knowledge nodes match "${a.q}")` }] };
    const lines = nodes.map((n) => {
      const body = String(n.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
      return `${n.id}  [${n.kind}] ${n.scope}  ${n.title}${body ? ' — ' + body : ''}`;
    });
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Could not recall: ${e.message}` }] };
  }
});

server.registerTool('loop_link', {
  title: 'Link two Loop knowledge nodes',
  description:
    '將兩個知識節點連結起來 — record a relation between two existing knowledge nodes (e.g. "this constraint applies to that environment"). ' +
    'Both src and dst must already exist (use loop_recall to find their ids first).',
  inputSchema: {
    src: z.string().describe('REQUIRED. Source node id (e.g. k_XXXXXXXX).'),
    dst: z.string().describe('REQUIRED. Destination node id.'),
    relation: z.string().optional().describe('runs-on | constrains | deployed-at | uses | part-of | related (default "related").'),
    note: z.string().optional().describe('optional free-text note about the relation.'),
  },
}, async (a) => {
  try {
    const created = await api('/api/knowledge/edges', {
      method: 'POST',
      body: { src: a.src, dst: a.dst, relation: a.relation, note: a.note ?? null },
    });
    const edge = created.edge ?? {};
    return { content: [{ type: 'text', text: `Linked ${edge.src} -[${edge.relation}]-> ${edge.dst}` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Could not link: ${e.message}` }] };
  }
});

server.registerTool('loop_queue_task', {
  title: 'Queue a draft Loop task',
  description: 'Validate and enqueue an existing DRAFT task for autonomous execution. Reports the missing fields if the intake gate is not satisfied.',
  inputSchema: { id: z.string().describe('Task id, e.g. t_XXXXXXXX') },
}, async ({ id }) => {
  try {
    await api(`/api/tasks/${id}/queue`, { method: 'POST' });
    return { content: [{ type: 'text', text: `Task ${id} -> queued. It will run when the usage budget allows.` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Could not queue ${id}: ${e.message}` }] };
  }
});

server.registerTool('loop_list_tasks', {
  title: 'List Loop tasks',
  description: 'List Loop Engineering tasks (optionally filtered by status) with a board summary. Statuses: draft, queued, running, verifying, blocked, attention (human hold — resume/restart/abandon from the board), review, failed, closed.',
  inputSchema: { status: z.string().optional().describe('optional status to filter by') },
}, async ({ status }) => {
  const board = await api('/api/board');
  let cards = board.cards ?? [];
  if (status) cards = cards.filter((c) => c.status === status);
  const rows = cards.map((c) =>
    `${c.id}  ${String(c.status).padEnd(9)} ${c.complexity} P${c.priority}  ${c.title}` +
    (c.elapsedMin != null ? `  ${c.elapsedMin}m` : '') +
    (c.gate && !c.gate.ok ? `  [gate: ${c.gate.missing.join(', ')}]` : ''));
  const head = `counts: ${JSON.stringify(board.counts)} | usage: session ${board.usage?.session}% / weekly ${board.usage?.weekly}% | scheduler: ${board.paused ? 'PAUSED' : 'running'}`;
  return { content: [{ type: 'text', text: head + '\n' + (rows.join('\n') || '(no tasks)') }] };
});

server.registerTool('loop_status', {
  title: 'Loop scheduler status',
  description: 'Get Loop Engineering scheduler + usage status: whether scheduling is paused, the current session/weekly usage percentages, and a backlog forecast (pending tasks\' weekly cost, headroom, and ~how many more M/L tasks fit). Use this for "Loop 還能加幾個任務？" / "is there budget to add more tasks?".',
  inputSchema: {},
}, async () => {
  const s = await api('/api/status');
  let forecastLine = '';
  try {
    const f = await api('/api/forecast');
    forecastLine =
      `\nBacklog 預估: ${f.pending} pending (S${f.by_complexity.S}/M${f.by_complexity.M}/L${f.by_complexity.L}) ` +
      `— weekly +${f.weekly_backlog_pct}% · 剩 ${f.weekly_headroom}% · 可加~${f.capacity_more_M} 個 M / ~${f.capacity_more_L} 個 L（${f.verdict}）`;
  } catch { /* forecast is a nice-to-have; never fail loop_status over it */ }
  return { content: [{ type: 'text', text: `paused: ${s.paused}\nsession: ${s.usage?.session}%  weekly: ${s.usage?.weekly}%  (source=${s.usage?.source})` + forecastLine }] };
});

// ---- inspect a task's outcome without opening the board ----
function fmtVerify(r) {
  const steps = Array.isArray(r.verify) ? r.verify : [];
  if (!steps.length) return null;
  const out = [`\n--- verification (run ${r.verify_run?.id ?? '?'}, attempt ${r.verify_run?.attempt ?? '?'}) — the engine's own record, not the agent's claim ---`];
  for (const s of steps) {
    out.push(`${s.ok ? 'PASS' : 'FAIL'}  ${s.step}  (${s.timedOut ? 'timed out' : `exit ${s.exitCode ?? '?'}`})`);
    if (s.tail && (!s.ok || steps.length === 1)) out.push(String(s.tail).split('\n').slice(-15).map((l) => `    | ${l}`).join('\n'));
  }
  const m = r.metrics;
  if (m && Array.isArray(m.checks) && m.checks.length) {
    out.push(`metrics vs thresholds (${m.pass ? 'all met' : 'NOT met'}):`);
    for (const c of m.checks) out.push(`  ${c.pass ? 'ok ' : 'MISS'} ${c.name} = ${c.actual ?? '(not reported)'}  (need ${c.op} ${c.target})`);
  } else if (r.thresholds) {
    out.push(`metrics: none measured (thresholds ${r.thresholds})`);
  }
  return out.join('\n');
}

function fmtResult(r) {
  const files = Array.isArray(r.changed_files) ? r.changed_files : null;
  const lines = [
    `Task ${r.id} — status: ${r.status}`,
    r.branch ? `branch: ${r.branch}` : null,
    r.elapsedMin != null ? `elapsed: ${r.elapsedMin}m` : null,
    r.pr_url ? `PR: ${r.pr_url}` : null,
    r.review_url ? `review page (code, re-run, checklist): ${r.review_url}` : null,
    r.output_dir ? `output dir: ${r.output_dir} (${(r.output_files || []).length} file(s))` : null,
    r.fail_detail ? `failure:\n${r.fail_detail}` : null,
    fmtVerify(r),
    files && files.length ? `\n--- changed files (${files.length}) ---\n${files.slice(0, 40).map((f) => `${f.status} ${f.path}`).join('\n')}` : null,
    r.review_md ? `\n--- gap review ---\n${String(r.review_md).slice(0, 2000)}` : null,
    r.verify_md ? `\n--- VERIFY.md (manual verification checklist) ---\n${String(r.verify_md).slice(0, 2000)}` : null,
    Array.isArray(r.log_tail) && r.log_tail.length ? `\n--- log tail ---\n${r.log_tail.join('\n')}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

server.registerTool('loop_task_result', {
  title: 'Get a Loop task result',
  description:
    'Fetch the outcome of a Loop task WITHOUT opening the board: status, PR link, gap-review, failure reason, and a tail of the run log. ' +
    'Use after loop_add_task to see how a run ended (PR to open, or why it failed).',
  inputSchema: { id: z.string().describe('Task id, e.g. t_XXXXXXXX') },
}, async ({ id }) => {
  try {
    const r = await api(`/api/tasks/${id}/result`);
    return { content: [{ type: 'text', text: fmtResult(r) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Could not get result for ${id}: ${e.message}` }] };
  }
});

const WAIT_TERMINAL = new Set(['review', 'attention', 'failed', 'closed']);
server.registerTool('loop_wait_task', {
  title: 'Wait for a Loop task to finish',
  description:
    'Poll a Loop task until it reaches a terminal state (review / attention / failed / closed) or the timeout elapses, then return its result ' +
    '(PR link / failure reason / log tail). Blocks until an autonomous run is done. A task may pause in "blocked" while the budget ' +
    'recovers; waiting continues through blocked until it resolves or the timeout is hit. "attention" means the run hit trouble and is ' +
    'held for a human to resume/restart/abandon on the board — treat it as done for waiting purposes.',
  inputSchema: {
    id: z.string().describe('Task id, e.g. t_XXXXXXXX'),
    timeout_sec: z.number().int().optional().describe('max seconds to wait (default 900).'),
  },
}, async ({ id, timeout_sec }) => {
  // a caller with its own tool timeout (the chat page: mcp_timeout_ms) gets an answer before it,
  // saying the task is still running, instead of a timeout error with nothing in it
  const clientMs = Number(process.env.LOOP_MCP_TIMEOUT_MS) || 0;
  const cap = clientMs > 0 ? Math.max(2, Math.floor(clientMs / 1000) - 5) : Infinity;
  const budget = Math.min(timeout_sec ?? 900, cap);
  const deadline = Date.now() + budget * 1000;
  let r;
  for (;;) {
    try {
      r = await api(`/api/tasks/${id}/result`);
    } catch (e) {
      return { content: [{ type: 'text', text: `Could not wait on ${id}: ${e.message}` }] };
    }
    if (WAIT_TERMINAL.has(r.status) || Date.now() >= deadline) break;
    await new Promise((res) => setTimeout(res, Math.max(0, Math.min(5000, deadline - Date.now()))));
  }
  const head = WAIT_TERMINAL.has(r.status)
    ? ''
    : `(still ${r.status} after ${budget}s — not finished yet; call loop_wait_task or loop_task_result again later)\n`;
  return { content: [{ type: 'text', text: head + fmtResult(r) }] };
});

server.registerTool('loop_delete_task', {
  title: 'Delete a Loop task',
  description:
    'Permanently DELETE a Loop Engineering task and its on-disk artifacts (its worktree + branch, the synthesized plan file, and run logs). ' +
    'This is IRREVERSIBLE — there is no soft-delete or undo. ' +
    'Active tasks (running / verifying / queued) are refused unless force=true, which aborts the run first. ' +
    'For removing many old tasks at once, prefer loop_cleanup.',
  inputSchema: {
    id: z.string().describe('Task id, e.g. t_XXXXXXXX'),
    force: z.boolean().optional().describe('delete even if the task is active (aborts its run first). Default false.'),
  },
}, async ({ id, force }) => {
  try {
    const r = await api(`/api/tasks/${id}${force ? '?force=1' : ''}`, { method: 'DELETE' });
    return { content: [{ type: 'text', text: `Deleted ${r.deleted ?? id}. Its worktree/branch, plan file and run logs were cleaned up.` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Could not delete ${id}: ${e.message}` }] };
  }
});

server.registerTool('loop_cleanup', {
  title: 'Batch-clean old Loop tasks',
  description:
    'Batch-DELETE terminal Loop tasks (default: closed + failed) together with their disk artifacts. ' +
    'This NEVER touches active/blocked/attention/review tasks — those are always excluded, even if requested. ' +
    'Optionally narrow by status and/or age (olderThanDays = only tasks not updated in the last N days). ' +
    'Deletion is IRREVERSIBLE. STRONGLY prefer a first call with dryRun=true to review the exact list, then repeat without dryRun to actually delete.',
  inputSchema: {
    status: z.array(z.string()).optional().describe('statuses to prune (default ["closed","failed"]). active/blocked/attention/review are always excluded.'),
    olderThanDays: z.number().optional().describe('only prune tasks not updated in the last N days.'),
    dryRun: z.boolean().optional().describe('if true, only report what WOULD be deleted — deletes nothing. Recommended for a first pass.'),
  },
}, async ({ status, olderThanDays, dryRun }) => {
  try {
    const r = await api('/api/tasks/prune', { method: 'POST', body: { status, olderThanDays, dryRun } });
    const head = dryRun ? `Would delete ${r.count} task(s)` : `Deleted ${r.count} task(s)`;
    const list = r.ids && r.ids.length ? ':\n' + r.ids.join('\n') : '.';
    const hint = dryRun && r.count ? '\n\nRe-run with dryRun=false to actually delete these.' : '';
    return { content: [{ type: 'text', text: head + list + hint }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Cleanup failed: ${e.message}` }] };
  }
});

// ---- 本地模型 + benchmark mode ----

server.registerTool('loop_local_models', {
  title: 'List local vLLM models',
  description: 'List the local models Loop can run coding tasks on (pass model "local:<id>" to loop_add_task — zero Anthropic tokens), which one vLLM currently has loaded, and whether local models are enabled.',
  inputSchema: {},
}, async () => {
  try {
    const { enabled, models, state, inflight } = await api('/api/local/models');
    const head = `local_models_enabled=${enabled} status=${state.status} loaded=${state.loaded ?? '-'} in-flight=${inflight}${state.error ? ` error=${state.error}` : ''}`;
    const rows = (models || []).map((m) =>
      `${state.loaded === m.id ? '*' : ' '} local:${m.id}  ${m.enabled ? 'enabled' : 'disabled'}  ${m.display_name}${m.notes ? ` — ${m.notes}` : ''}`);
    return { content: [{ type: 'text', text: [head, ...rows].join('\n') }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Could not list local models: ${e.message}` }] };
  }
});

server.registerTool('loop_bench_add', {
  title: 'Create a model benchmark',
  description: 'Run the SAME coding task on 2+ models (usually local:<id>) in separate worktrees. When every arm has finished, an external judge model (default opus) scores and ranks them; results accumulate in a model x domain matrix. Arms never merge into the base branch. Requires benchmark_enabled=true.',
  inputSchema: {
    title: z.string(),
    goal: z.string(),
    models: z.array(z.string()).min(2).describe('e.g. ["local:qwen38-flash","local:qwen3-coder-next"]'),
    repo_path: z.string().describe('absolute path of the git repository'),
    verification_steps: z.array(z.string()).min(1).describe('shell commands every arm must pass, e.g. ["npm test"]'),
    base_branch: z.string().optional().describe('default main'),
    plan_ref: z.string().optional().describe('absolute path or URL of the plan/PRD all arms follow'),
    domain: z.enum(['cuda', 'cv', 'cpp', 'csharp', 'typescript', 'python', 'other']).optional(),
    verify_rubric: z.string().optional(),
    setup_cmd: z.string().optional(),
    complexity: z.enum(['S', 'M', 'L']).optional(),
    judge_model: z.enum(['opus', 'fable', 'fable-5', 'sonnet']).optional(),
  },
}, async (a) => {
  try {
    const { benchmark, arms } = await api('/api/benchmarks', { method: 'POST', body: { ...a, base_branch: a.base_branch ?? 'main' } });
    const lines = [
      `Benchmark ${benchmark.id} created (domain=${benchmark.domain}, judge=${benchmark.judge_model}).`,
      ...arms.map((x) => `  ${x.model} -> task ${x.task_id} [${x.task_status}]`),
      'Check progress/results with loop_bench_status.',
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Could not create benchmark: ${e.message}` }] };
  }
});

server.registerTool('loop_bench_status', {
  title: 'Benchmark status / results',
  description: 'Without id: recent benchmarks plus the model x domain matrix. With id: per-arm verification outcome, judge scores, ranks and the judge summary.',
  inputSchema: { id: z.string().optional() },
}, async ({ id }) => {
  try {
    if (id) {
      const { benchmark: b, arms } = await api(`/api/benchmarks/${encodeURIComponent(id)}`);
      const lines = [`${b.id} ${b.title} — ${b.status} (domain=${b.domain}, judge=${b.judge_model}) winner=${b.winner ?? '-'}`];
      if (b.error) lines.push(`error: ${b.error}`);
      if (b.summary) lines.push(`summary: ${b.summary}`);
      for (const x of [...arms].sort((p, q) => (p.judge_rank ?? 99) - (q.judge_rank ?? 99))) {
        lines.push(`  #${x.judge_rank ?? '-'} ${x.model} score=${x.judge_score ?? '-'} verify=${x.verify_outcome ?? '-'} tokens_out=${x.tokens_out ?? '-'} task=${x.task_id} [${x.task_status}]${x.notes ? ` — ${x.notes}` : ''}`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }
    const [{ benchmarks }, { matrix }] = await Promise.all([api('/api/benchmarks'), api('/api/benchmarks/matrix')]);
    const lines = ['Recent benchmarks:', ...(benchmarks || []).slice(0, 15).map((b) => `  ${b.id} ${b.status} ${b.domain} arms ${b.arms_done}/${b.arm_count} winner=${b.winner ?? '-'} — ${b.title}`)];
    lines.push('', 'Model x domain matrix (judged only):');
    for (const r of matrix || []) {
      lines.push(`  ${r.domain} ${r.model}: n=${r.n} score=${r.avg_score ?? '-'} win=${Math.round(r.win_rate * 100)}% verify=${Math.round(r.verify_pass_rate * 100)}%`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Could not read benchmarks: ${e.message}` }] };
  }
});

// ---- PRD gate ----

const prdText = (a) => {
  if (a.markdown && a.markdown.trim()) return a.markdown;
  if (a.path) return fs.readFileSync(a.path, 'utf8');
  throw new Error('pass markdown or path');
};
const prdReport = (c) => [
  c.ok ? 'PRD: OK ✓' : 'PRD: BLOCKED ✗',
  ...c.missing.map((m) => `  ✗ ${m}`),
  ...c.warnings.map((w) => `  ! ${w}`),
  `  local-model review: ${c.llm.status}${c.llm.status === 'ok' ? ` (ok=${c.llm.ok})` : ''}${c.llm.error ? ` — ${c.llm.error}` : ''}`,
  ...c.llm.questions.map((q) => `  ? ${q}`),
  ...c.llm.risk_notes.map((n) => `  ~ ${n}`),
].join('\n');

server.registerTool('loop_prd_template', {
  title: 'Get the Loop PRD template',
  description:
    'The section skeleton the PRD gate expects (目標/範圍/非範圍/驗收標準/驗證指令/Repo/領域/複雜度). Write PRDs in this shape so a local model can implement them unattended. ' +
    'Optional sections worth using for overnight runs: 驗收指標 (machine-checked thresholds like "detection_rate >= 0.98" that the engine compares against a LOOP_METRICS {json} line a verify command prints), ' +
    '保護路徑 (globs such as scripts/eval/** the implementer must not change), 圖集比對 with 主機 (an exec host holding the image library; its verify command then starts with sandbox@<host>:).',
  inputSchema: {},
}, async () => {
  try {
    const { markdown } = await api('/api/prd/template');
    return { content: [{ type: 'text', text: markdown }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Could not read the PRD template: ${e.message}` }] };
  }
});

server.registerTool('loop_prd_check', {
  title: 'Check a PRD against the gate',
  description: 'Deterministic lint + a review by the loaded local model (zero Anthropic tokens). Returns every missing item; fix them before loop_prd_submit.',
  inputSchema: {
    markdown: z.string().optional().describe('the PRD markdown'),
    path: z.string().optional().describe('or an absolute path to a PRD .md file'),
  },
}, async (a) => {
  try {
    const check = await api('/api/prd/check', { method: 'POST', body: { markdown: prdText(a) } });
    return { content: [{ type: 'text', text: prdReport(check) }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `PRD check failed: ${e.message}` }] };
  }
});

server.registerTool('loop_prd_submit', {
  title: 'Submit a PRD as a task (or benchmark)',
  description: 'Re-checks the PRD; if it passes, saves it as the plan and creates a queued task that runs on the local model (or, with benchmark_models, a benchmark across those models). A blocked PRD creates nothing and returns the missing items.',
  inputSchema: {
    markdown: z.string().optional(),
    path: z.string().optional(),
    model: z.string().optional().describe('implementation model, e.g. local:qwen38-flash (default: prd_default_model)'),
    queue: z.boolean().optional().describe('default true'),
    benchmark_models: z.array(z.string()).optional().describe('2+ models -> create a benchmark instead of one task'),
  },
}, async (a) => {
  try {
    const r = await api('/api/prd', { method: 'POST', body: { markdown: prdText(a), model: a.model, queue: a.queue, benchmark_models: a.benchmark_models } });
    const head = r.kind === 'benchmark'
      ? `Benchmark ${r.benchmark.id} created from the PRD: ${r.arms.map((x) => x.model).join(', ')}`
      : `Task ${r.task.id} -> ${r.task.status} (model ${r.task.model ?? 'default_model'})${r.gate.ok ? '' : ` — gate MISSING: ${r.gate.missing.join('; ')}`}`;
    return { content: [{ type: 'text', text: `${head}\n${prdReport(r.check)}` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `PRD not submitted: ${e.message}` }] };
  }
});

// ---- environments + deploy (在家開發帶去公司部署) ----

server.registerTool('loop_list_exec_hosts', {
  title: 'List the machines verification can run on',
  description:
    'The GPU 執行沙盒 machines: "local" (the Loop engine machine) and any registered remote hosts, with their image, GPU, read-only datasets and what each is for. ' +
    'A verification step "sandbox@<host>: <command>" runs on that host ("sandbox: <command>" on the default one). Use this before choosing where a task is verified.',
  inputSchema: {},
}, async () => {
  try {
    const st = await api('/api/exec/status');
    if (!st.enabled) return { content: [{ type: 'text', text: 'The 執行沙盒 is off (exec_enabled=false): verification steps run on the engine machine\'s own shell.' }] };
    const rows = (st.hosts || []).map((h) =>
      `${h.default ? '* ' : '  '}${h.name}${h.name === 'local' ? ' (the Loop engine machine)' : ''}${h.description ? ` — ${h.description}` : ''}` +
      `${Array.isArray(h.data) && h.data.length ? `\n    datasets (read-only, container paths): ${h.data.map((d) => d.target).join(', ')}` : ''}`);
    return { content: [{ type: 'text', text: `${rows.join('\n')}\n(* = default for "sandbox:" steps)` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Could not list verification hosts: ${e.message}` }] };
  }
});

server.registerTool('loop_list_environments', {
  title: 'List Loop deploy environments',
  description:
    'List deploy environments (e.g. home/company): kind, host, capabilities, deploy_cmd, auto_deploy. ' +
    'NOTE: an environment\'s "host" is only a descriptive label — a task always runs and verifies on the Loop engine machine. ' +
    'To build or verify on another machine, use a verification host (loop_list_exec_hosts) through a "sandbox@<host>: <command>" verification step.',
  inputSchema: {},
}, async () => {
  try {
    const { environments } = await api('/api/environments');
    const rows = (environments || []).map((e) =>
      `${e.name}  kind=${e.kind} host=${e.host ?? '-'} capabilities=${e.capabilities || '-'} auto_deploy=${!!e.auto_deploy}`);
    return { content: [{ type: 'text', text: rows.join('\n') || '(no environments)' }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Could not list environments: ${e.message}` }] };
  }
});

server.registerTool('loop_deploy', {
  title: 'Deploy to an environment',
  description:
    'Create + queue a deploy task (coding_tool=deploy) targeting an environment. Auto-deploy environments (e.g. home) run deploy_cmd immediately; manual environments (e.g. company) produce a DEPLOY.md package + checklist for a human to run at the target, then the task reaches review.',
  inputSchema: {
    environment: z.string().describe('REQUIRED. Target environment name, e.g. "home" or "company" (see loop_list_environments).'),
    repo_path: z.string().describe('REQUIRED. Git repo path — the source to deploy.'),
    base_branch: z.string().describe('REQUIRED. Base branch to deploy, usually "main" after a feature merged.'),
  },
}, async ({ environment, repo_path, base_branch }) => {
  try {
    const { task } = await api('/api/tasks', {
      method: 'POST',
      body: {
        title: `deploy ${environment}`,
        goal: `Deploy ${base_branch} to ${environment}`,
        coding_tool: 'deploy',
        complexity: 'S',
        environment,
        repo_path,
        base_branch,
      },
    });
    await api(`/api/tasks/${task.id}/queue`, { method: 'POST' });
    return { content: [{ type: 'text', text: `Task ${task.id} -> queued (deploy ${base_branch} -> ${environment}).` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Could not create/queue deploy task: ${e.message}` }] };
  }
});

server.registerTool('loop_rollback_deployment', {
  title: 'Roll back a deployment',
  description: "Roll an environment back to its previous successfully deployed commit. Finds the environment's most recent 'deployed' record and rolls back from there.",
  inputSchema: { environment: z.string().describe('REQUIRED. Environment name to roll back, e.g. "home" or "company".') },
}, async ({ environment }) => {
  try {
    const { deployments } = await api(`/api/deployments?env=${encodeURIComponent(environment)}`);
    const current = (deployments || []).find((d) => d.status === 'deployed');
    if (!current) return { content: [{ type: 'text', text: `No deployment recorded for ${environment}.` }] };
    const r = await api(`/api/deployments/${current.id}/rollback`, { method: 'POST' });
    return { content: [{ type: 'text', text: `${environment}: rolled back -> commit ${r.record?.commit_sha ?? '(unknown)'} (${r.record?.status}).` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Rollback failed for ${environment}: ${e.message}` }] };
  }
});

// ---- delivery pipeline templates (feature/fix/ship) ----

server.registerTool('loop_run_pipeline', {
  title: 'Run a Loop delivery pipeline template',
  description:
    "Instantiate a Loop pipeline template (e.g. built-ins 'feature', 'fix', 'ship') into a queued depends_on task chain in one action — " +
    'ADO multi-stage pipelines, autonomous version: each stage reuses the V-chain verify modes (command/llm/manual) and the D3 deploy. ' +
    'The first stage is queued immediately; later stages stay draft and auto-queue one at a time as each dependency closes. ' +
    'A failing stage halts the chain (downstream stays waiting) — resolve it from the board like any other attention/failed task. ' +
    "Use loop_list_tasks / the board to see progress; call this again for a fresh run of the same template.",
  inputSchema: {
    name: z.string().describe("REQUIRED. Pipeline template name, e.g. 'feature' | 'fix' | 'ship' (see the board or GET /api/pipelines for the full list)."),
    goal: z.string().describe('REQUIRED. Shared goal for every stage — what the pipeline should accomplish end to end.'),
    repo_path: z.string().optional().describe('Target git repo (absolute). If omitted, auto-detected from LOOP_DEFAULT_REPO / the MCP cwd (skipped for a template whose every stage is repo-less, e.g. all-deploy templates targeting no code).'),
    base_branch: z.string().optional().describe('If omitted, auto-detected: origin default branch, else main/master.'),
    environment: z.string().optional().describe("Environment for stages that don't set their own in the template (a stage's own environment, e.g. a deploy stage's target, always wins)."),
    title: z.string().optional().describe('Label used in each stage task title, e.g. "<title>: implement". Defaults to the pipeline template name.'),
    verification_steps: z.union([z.array(z.string()), z.string()]).optional().describe('Commands shared by every command-mode stage (e.g. ["npm run typecheck","npm test"]). If omitted, auto-detected from the repo like loop_add_task.'),
  },
}, async (a) => {
  const repo = detectRepo(a.repo_path);
  const base = detectBranch(repo, a.base_branch);
  let steps = normSteps(a.verification_steps);
  if (!steps.length) steps = detectVerify(repo);
  try {
    const result = await api(`/api/pipelines/${encodeURIComponent(a.name)}/run`, {
      method: 'POST',
      body: {
        goal: a.goal,
        repo_path: repo,
        base_branch: base,
        environment: a.environment ?? null,
        title: a.title ?? null,
        verification_steps: steps,
      },
    });
    const rows = (result.tasks || []).map((t) => `${t.id}  ${String(t.status).padEnd(9)} ${t.stage_name ?? ''}  ${t.title}`);
    return {
      content: [{
        type: 'text',
        text: `Pipeline '${a.name}' -> ${result.task_ids?.length ?? 0} stage(s):\n${rows.join('\n')}\n\n` +
          'The first stage is queued; later stages auto-queue as each dependency closes. Watch with loop_list_tasks / loop_wait_task.',
      }],
    };
  } catch (e) {
    return { content: [{ type: 'text', text: `Could not run pipeline '${a.name}': ${e.message}` }] };
  }
});

// ---- ADO/GitHub integration bridge (D5) ----

server.registerTool('loop_pull_workitems', {
  title: 'Pull work items from GitHub/ADO into Loop tasks',
  description:
    "Import work items — GitHub issues via a search query, or ADO work items via a WIQL query — as Loop tasks, idempotent by " +
    "source_ref (running the same query twice never creates duplicates). Requires the server's integration_provider setting " +
    "to already be set to 'github' or 'ado' with credentials configured in ~/.config/loop-engineering/env — if unconfigured, " +
    'this returns an error explaining what to set. Each created task auto-queues up to max_autoqueue; the rest stay draft.',
  inputSchema: {
    provider: z.enum(['github', 'ado']).describe("REQUIRED. Must match the server's configured integration_provider setting."),
    query: z.string().describe('REQUIRED. GitHub: a search query, e.g. "assignee:@me label:loop repo:owner/name is:open". ADO: a WIQL query string.'),
    repo_path: z.string().optional().describe('Target git repo for created tasks (absolute). If omitted, auto-detected from LOOP_DEFAULT_REPO / the MCP cwd.'),
    base_branch: z.string().optional().describe('Base branch for created tasks. If omitted, auto-detected: origin default branch, else main/master.'),
    verification_steps: z.union([z.array(z.string()), z.string()]).optional().describe('Commands shared by every imported task. If omitted, auto-detected from the repo like loop_add_task.'),
  },
}, async (a) => {
  const repo = detectRepo(a.repo_path);
  const base = detectBranch(repo, a.base_branch);
  let steps = normSteps(a.verification_steps);
  if (!steps.length) steps = detectVerify(repo);
  try {
    const result = await api('/api/integrations/import', {
      method: 'POST',
      body: { provider: a.provider, query: a.query, repo_path: repo, base_branch: base, verification_steps: steps },
    });
    const skipped = result.skipped || [];
    const rows = (result.tasks || []).map((t) => `${t.id}  ${String(t.status).padEnd(9)} ${t.title}`);
    return {
      content: [{
        type: 'text',
        text: `Imported ${result.created?.length ?? 0} task(s)${skipped.length ? `, skipped ${skipped.length} already-imported` : ''}:\n${rows.join('\n')}`,
      }],
    };
  } catch (e) {
    return { content: [{ type: 'text', text: `Could not pull work items: ${e.message}` }] };
  }
});

// ---- SSoT ingestion (D-Phase1): trigger the walk->chunk->embed pipeline ----

server.registerTool('loop_ingest', {
  title: 'Run SSoT ingestion',
  description:
    'Trigger the SSoT ingest pipeline (governed walk -> chunk -> embed -> store) for one registered source or every ' +
    'enabled source. Sources (git repos / folders / Obsidian vaults) are registered on the server host via `loop ingest add` ' +
    '(not exposed here). Incremental by content hash — unchanged files are skipped, changed files supersede their prior ' +
    'version, removed files are invalidated (history is kept, never deleted).',
  inputSchema: {
    source_id: z.string().optional().describe('Ingest only this source id (see GET /api/sources on the board). Omit to run every enabled source.'),
  },
}, async ({ source_id }) => {
  try {
    const result = await api('/api/ingest', { method: 'POST', body: { source_id: source_id ?? undefined } });
    const rows = (result.results || []).map((r) =>
      `${r.source_id}: +${r.documents_created} created, ${r.documents_replaced} replaced, ` +
      `${r.documents_invalidated} invalidated, ${r.chunks_created} chunks, ${r.skipped_unchanged} unchanged`);
    return { content: [{ type: 'text', text: rows.join('\n') || '(no sources ingested)' }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Ingest failed: ${e.message}` }] };
  }
});

server.registerTool('loop_sources', {
  title: 'List SSoT ingestion sources',
  description:
    'List registered SSoT ingestion sources (git repos / folders / Obsidian vaults): id, kind, uri, enabled, ' +
    'last_ingested_at. Register new ones with `loop ingest add` on the server host (not exposed here); trigger a run ' +
    'with loop_ingest, then search the ingested corpus with loop_search.',
  inputSchema: {},
}, async () => {
  try {
    const { sources } = await api('/api/sources');
    if (!sources?.length) return { content: [{ type: 'text', text: '(no sources registered)' }] };
    const rows = sources.map((s) =>
      `${s.id}  [${s.kind}] ${s.enabled ? 'on ' : 'off'}  ${s.uri}  last=${s.last_ingested_at ?? '-'}`);
    return { content: [{ type: 'text', text: rows.join('\n') }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Could not list sources: ${e.message}` }] };
  }
});

// ---- SSoT hybrid RAG search (D-Phase2): src/knowledge/retrieve.ts via REST ----

server.registerTool('loop_search', {
  title: 'Hybrid RAG search over the SSoT corpus',
  description:
    '混合語義+全文檢索 SSoT 語料庫（documents/chunks，由 loop_ingest 擷取）— FTS5 trigram 全文與向量 KNN 語意檢索以 RRF ' +
    '(Reciprocal Rank Fusion) 融合排序，回傳帶引用（來源路徑/行號/分數）的片段。用於「這段程式碼/決策在哪裡」之類的問題。' +
    '若伺服器 rag_enabled 設定為 false（向量嵌入未啟用），自動退回純 FTS 全文檢索，仍可用。',
  inputSchema: {
    q: z.string().describe('REQUIRED. Search query (keywords or a natural-language question).'),
    scope: z.string().optional().describe('Restrict to one ingested source/repo — an absolute path prefix matching a registered source uri (see loop_sources).'),
    kind: z.string().optional().describe('Restrict to one document kind, e.g. "md" or "ts" (the file extension recorded at ingest time).'),
    top_k: z.number().int().optional().describe('Max results (default: the server rag_top_k setting, usually 8).'),
  },
}, async (a) => {
  try {
    const qs = new URLSearchParams({ q: a.q });
    if (a.scope) qs.set('scope', a.scope);
    if (a.kind) qs.set('kind', a.kind);
    if (a.top_k != null) qs.set('topK', String(a.top_k));
    const { results } = await api(`/api/rag/search?${qs.toString()}`);
    if (!results?.length) return { content: [{ type: 'text', text: `(no chunks match "${a.q}")` }] };
    const lines = results.map((r) => {
      const lineRef = r.start_line != null ? `:${r.start_line}-${r.end_line ?? r.start_line}` : '';
      const excerpt = String(r.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
      return `${r.path}${lineRef}  (score ${Number(r.score).toFixed(3)})\n  ${excerpt}`;
    });
    return { content: [{ type: 'text', text: lines.join('\n\n') }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Search failed: ${e.message}` }] };
  }
});

// ---- SSoT capture (D-Phase4): quick markdown note -> vault + immediate ingest ----

server.registerTool('loop_capture', {
  title: 'Capture a quick note into the SSoT vault',
  description:
    '快速記錄 — write a short note as a markdown file into the registered SSoT vault (~/SSoT, editable in Obsidian too) and ' +
    'immediately ingest it, so it is searchable via loop_search right away. Distinct from loop_remember: this lands in the ' +
    'RAG corpus (documents/chunks), NOT the curated knowledge_nodes layer that gets injected into task prompts — use this for ' +
    'raw notes/decisions/logs you want captured verbatim and searchable, and loop_remember for a durable fact that should ' +
    'shape every future task. Requires a vault source already registered on the server (`loop ingest add --vault <path>`).',
  inputSchema: {
    text: z.string().describe('REQUIRED. The note body (markdown).'),
    title: z.string().optional().describe('Short title; if omitted, derived from the first line/sentence of text.'),
    tags: z.union([z.array(z.string()), z.string()]).optional().describe('optional tags (array or comma-separated string) — written as YAML frontmatter.'),
  },
}, async (a) => {
  try {
    const result = await api('/api/capture', {
      method: 'POST',
      body: { title: a.title, body: a.text, tags: normSteps(a.tags) },
    });
    return { content: [{ type: 'text', text: `Captured -> ${result.source_id}/${result.filename} (ingested: +${result.ingest?.documents_created ?? 0} created, ${result.ingest?.chunks_created ?? 0} chunks).` }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Capture failed: ${e.message}` }] };
  }
});

// ---- 報告生成 A: OpenProject project report from a natural-language description ----

server.registerTool('loop_report', {
  title: 'Generate an OpenProject project report from a description',
  description:
    '用一句自然語言描述生成 OpenProject 專案報告（例：「大型AOI PR 最新進度 one page」）— 伺服器會盡量即時查詢 OpenProject，' +
    '查不到才退回既有語料快照，套用範本（見 loop_report_templates）或內建一頁式繁中範本產生報告。若伺服器 report_enabled 設定為 false（預設），回傳空報告。',
  inputSchema: {
    description: z.string().describe('用描述下報告，例：大型AOI PR 最新進度 one page'),
    template: z.string().optional().describe('選填。指定要套用的老闆範本名稱（見 loop_report_templates），例如 "plant-manager-onepage"；省略則自動挑選或用內建預設。'),
  },
}, async ({ description, template }) => {
  try {
    const body = { description };
    if (template) body.template = template;
    const r = await api('/api/report', { method: 'POST', body });
    return { content: [{ type: 'text', text: r.markdown || '(無內容)' }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Report generation failed: ${e.message}` }] };
  }
});

server.registerTool('loop_report_templates', {
  title: 'List reusable report (boss persona) templates',
  description: '列出目前登錄的報告範本（老闆 persona）：名稱 + 描述，供 loop_report 的 template 參數挑選。若伺服器 report_enabled 設定為 false（預設），回傳空清單。',
  inputSchema: {},
}, async () => {
  try {
    const { templates } = await api('/api/report/templates');
    const rows = (templates || []).map((t) => `${t.name}  ${t.description ?? ''}`);
    return { content: [{ type: 'text', text: rows.join('\n') || '(no report templates)' }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Could not list report templates: ${e.message}` }] };
  }
});

server.registerTool('loop_report_weekly', {
  title: 'Run the weekly enterprise report PPTX pipeline (prepare / render / run)',
  description:
    '企業週報 PPTX 週流程：stage=prepare 只組草稿(WP 快照＋LLM status 候選＋品質閘門)供人工在 explain-pages.json 把關' +
    '（改措辭／標紅／批准說明頁）；stage=render 在人工把關後重驗證＋重上色＋渲染出片(未批准的說明頁一律剔除，絕不繞過把關)；' +
    "stage=run(預設)為一鍵：該週 deck-spec 不存在就先 prepare 再 render，已存在就只 render。若伺服器 report_pptx_enabled 設定為 false，動作會失敗。",
  inputSchema: {
    stage: z.enum(['prepare', 'render', 'run']).optional().describe("流程階段，預設 'run'"),
    week: z.string().optional().describe('ISO week id（例：2026-W29），省略則用本週'),
    qa: z.boolean().optional().describe('render 完成後是否順便跑 LibreOffice+pdftoppm 視覺 QA'),
    no_llm: z.boolean().optional().describe('停用 LLM status 生成（僅在本次需要 prepare 時生效），維持全黑沿用行為'),
  },
}, async ({ stage, week, qa, no_llm }) => {
  try {
    const body = {};
    if (stage) body.stage = stage;
    if (week) body.week = week;
    if (qa !== undefined) body.qa = qa;
    if (no_llm !== undefined) body.noLlm = no_llm;
    const r = await api('/api/report/weekly', { method: 'POST', body });
    const lines = [];
    if (r.specPath) lines.push(`deck-spec: ${r.specPath}`);
    if (r.explainPath) lines.push(`explain-pages: ${r.explainPath}`);
    if (r.output) lines.push(`output: ${r.output}${r.slides != null ? `（${r.slides} 頁）` : ''}`);
    if (r.qualityFlags && Object.keys(r.qualityFlags).length) {
      lines.push('[quality flags]');
      for (const [key, flags] of Object.entries(r.qualityFlags)) lines.push(`  ${key}: ${(flags || []).join('; ')}`);
    }
    if (Array.isArray(r.warnings) && r.warnings.length) {
      lines.push('[warnings]');
      for (const w of r.warnings) lines.push(`  ${w}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') || '(no output)' }] };
  } catch (e) {
    return { content: [{ type: 'text', text: `Weekly report failed: ${e.message}` }] };
  }
});

// ---- MCP resources: let any MCP client browse the SSoT without calling a tool ----

server.registerResource(
  'ssot-sources',
  'ssot://sources',
  {
    title: 'SSoT ingestion sources',
    description: '已登錄的 SSoT 擷取來源（git/folder/vault）— 治理 walker 的輸入清單，含啟用狀態與最近擷取時間。',
    mimeType: 'application/json',
  },
  async (uri) => {
    const { sources } = await api('/api/sources');
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(sources ?? [], null, 2) }] };
  },
);

server.registerResource(
  'ssot-graph',
  'ssot://graph',
  {
    title: 'SSoT curated knowledge graph',
    description: '策展知識圖譜（knowledge_nodes/edges）— 人工核可、會注入任務 prompt 的小量知識，與語料層 documents/chunks 分開。',
    mimeType: 'application/json',
  },
  async (uri) => {
    const graph = await api('/api/knowledge/graph');
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(graph ?? {}, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
