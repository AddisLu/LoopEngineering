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

// ---- resolve config from env vars, falling back to the deploy env file ----
function readEnvFile() {
  const p = path.join(os.homedir(), '.config', 'loop-engineering', 'env');
  const out = {};
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch { /* no env file — use defaults */ }
  return out;
}
const ENVF = readEnvFile();
const PORT = process.env.LOOP_PORT || ENVF.LOOP_PORT || '4711';
const BASE = (process.env.LOOP_API_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
const TOKEN = process.env.LOOP_API_TOKEN || ENVF.LOOP_API_TOKEN || '';
const DATA_DIR = process.env.LOOP_DATA_DIR || ENVF.LOOP_DATA_DIR ||
  path.join(os.homedir(), '.local', 'share', 'loop-engineering');
const PLANS_DIR = path.join(DATA_DIR, 'plans');

function headers(json) {
  const h = {};
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  if (json) h['content-type'] = 'application/json';
  return h;
}
async function api(pathname, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(BASE + pathname, {
      method,
      headers: headers(!!body),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(`cannot reach Loop API at ${BASE} (${e.message}). Is the service running? ` +
      `Check: systemctl --user status loop-engineering`);
  }
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const hint = res.status === 401 ? ' (401 — token missing/wrong; MCP reads LOOP_API_TOKEN from ~/.config/loop-engineering/env)' : '';
    throw new Error(`${method} ${pathname} -> HTTP ${res.status}${hint}: ${text.slice(0, 300)}`);
  }
  return json;
}

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

const server = new McpServer({ name: 'loop-engineering', version: '1.1.0' });

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
    coding_tool: z.enum(['claude-code', 'mock']).optional().describe('default "claude-code"; "mock" is a zero-token dry run.'),
    complexity: z.enum(['S', 'M', 'L']).optional().describe('S/M/L — sets timeout, estimate, model routing (default M).'),
    priority: z.number().int().optional().describe('integer priority (default 2; lower runs first).'),
    model: z.string().optional().describe('sonnet | opus | default (optional).'),
    queue: z.boolean().optional().describe('default TRUE — queue for execution if the gate passes. false = leave as draft.'),
    depends_on: z.string().optional().describe('Task id this one waits for (serial chain): held until that task is CLOSED, then auto-queued. Use to run tasks strictly one after another.'),
  },
}, async (a) => {
  const isMock = a.coding_tool === 'mock';
  const title = (a.title && a.title.trim()) ? a.title.trim().slice(0, 80) : firstLine(a.goal);
  const repo = isMock ? (a.repo_path ?? null) : detectRepo(a.repo_path);
  const base = isMock ? (a.base_branch ?? null) : detectBranch(repo, a.base_branch);
  let steps = normSteps(a.verification_steps);
  if (!steps.length) steps = isMock ? ['true'] : detectVerify(repo);
  const setup = isMock ? null : detectSetup(repo, a.setup_cmd);
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
  description: 'List Loop Engineering tasks (optionally filtered by status) with a board summary. Statuses: draft, ready, queued, running, verifying, blocked, attention (human hold — resume/restart/abandon from the board), review, failed, closed.',
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
  description: 'Get Loop Engineering scheduler + usage status: whether scheduling is paused and the current session/weekly usage percentages.',
  inputSchema: {},
}, async () => {
  const s = await api('/api/status');
  return { content: [{ type: 'text', text: `paused: ${s.paused}\nsession: ${s.usage?.session}%  weekly: ${s.usage?.weekly}%  (source=${s.usage?.source})` }] };
});

// ---- inspect a task's outcome without opening the board ----
function fmtResult(r) {
  const lines = [
    `Task ${r.id} — status: ${r.status}`,
    r.branch ? `branch: ${r.branch}` : null,
    r.elapsedMin != null ? `elapsed: ${r.elapsedMin}m` : null,
    r.pr_url ? `PR: ${r.pr_url}` : null,
    r.fail_detail ? `failure:\n${r.fail_detail}` : null,
    r.review_md ? `\n--- gap review ---\n${String(r.review_md).slice(0, 2000)}` : null,
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
  const budget = timeout_sec ?? 900;
  const deadline = Date.now() + budget * 1000;
  let r;
  for (;;) {
    try {
      r = await api(`/api/tasks/${id}/result`);
    } catch (e) {
      return { content: [{ type: 'text', text: `Could not wait on ${id}: ${e.message}` }] };
    }
    if (WAIT_TERMINAL.has(r.status) || Date.now() >= deadline) break;
    await new Promise((res) => setTimeout(res, 5000));
  }
  const head = WAIT_TERMINAL.has(r.status) ? '' : `(timed out after ${budget}s; still ${r.status})\n`;
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

const transport = new StdioServerTransport();
await server.connect(transport);
