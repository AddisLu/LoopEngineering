import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { getBool, getNum } from '../db/index.js';
import { backendFor, localPrompt } from '../local/backend.js';
import { latestRun } from '../tasks.js';
import { readUsage } from '../token/usage.js';
import type { Task } from '../types.js';
import { upsertNode, findActiveByTitleScope, linkNodeToChunks } from './store.js';
import { search } from './retrieve.js';
import { KIND, type Kind, type KnowledgeNode } from './types.js';

const execFileAsync = promisify(execFile);

const MATERIAL_CAP = 6000;
const TITLE_MAX = 160;
const BODY_MAX = 1200;
const TIMEOUT_MS = 3 * 60_000;
const MAX_ITEMS = 3;
const EVIDENCE_TOP_K = 3;

export interface DistillItem {
  kind: Kind;
  title: string;
  body: string;
  tags: string[];
  scope: string;
}

/**
 * Collect the material a distiller pass reasons over: HANDOFF.md from the task's
 * latest run's worktree + the gap-review file + the task goal + the most recent
 * merge/status event detail. SYNCHRONOUS and must run BEFORE cleanupWorktree deletes
 * the worktree (the whole reason this is split out of runDistiller). Capped at
 * MATERIAL_CAP chars; null when nothing meaningful was found (never throws).
 */
export function collectDistillMaterial(db: Database.Database, task: Task): string | null {
  const parts: string[] = [];

  const run = latestRun(db, task.id);
  if (run?.worktree_path) {
    try {
      const txt = fs.readFileSync(path.join(run.worktree_path, 'HANDOFF.md'), 'utf8').trim();
      if (txt) parts.push(`## HANDOFF.md\n${txt}`);
    } catch {
      /* absent — fine */
    }
  }

  if (task.review_md_path) {
    try {
      const txt = fs.readFileSync(task.review_md_path, 'utf8').trim();
      if (txt) parts.push(`## Gap review\n${txt}`);
    } catch {
      /* absent — fine */
    }
  }

  const goal = task.goal?.trim();
  if (goal) parts.push(`## Goal\n${goal}`);

  try {
    // 'status' rows exist for every transition, including the boilerplate draft/queued/
    // running churn every task has — restrict to kinds/to_status values that actually
    // carry a close-relevant outcome (verify result, merge outcome, failure reason).
    const lastEvent = db
      .prepare(
        `SELECT kind, detail FROM task_events
          WHERE task_id = ? AND detail IS NOT NULL AND detail != ''
            AND (kind = 'merge' OR (kind = 'status' AND to_status IN ('review', 'closed', 'failed', 'attention')))
          ORDER BY id DESC LIMIT 1`,
      )
      .get(task.id) as { kind: string; detail: string } | undefined;
    if (lastEvent) parts.push(`## Last ${lastEvent.kind} event\n${lastEvent.detail}`);
  } catch {
    /* best-effort */
  }

  if (parts.length === 0) return null;
  return parts.join('\n\n').slice(0, MATERIAL_CAP);
}

function buildPrompt(material: string): string {
  return `You are extracting durable, REUSABLE knowledge from a just-closed coding task, for a
persistent knowledge base that gets injected into the prompts of FUTURE, unrelated tasks.

Only extract knowledge that stays true and useful across many future tasks:
- environment constraints (OS/runtime/tool/version limits)
- architectural decisions with lasting rationale
- user preferences (workflow, deployment, style)

Do NOT extract task-specific trivia — this task's particular bug, file names, or any
one-off implementation detail that won't matter once this task is closed.

Write "body" in the SAME language as the material below (material in Traditional
Chinese stays Traditional Chinese).

Output STRICT JSON ONLY — no markdown code fences, no commentary — exactly this shape:
{"items":[{"kind":"environment|project|constraint|preference|tech|fact|person|repo","title":"...","body":"...","tags":["..."],"scope":"global|repo:<path>|env:<name>"}]}
At most ${MAX_ITEMS} items. If nothing durable is worth keeping, output {"items":[]}.

## Material
${material}`;
}

function stripFences(s: string): string {
  const trimmed = s.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ?? trimmed;
}

function isValidScope(s: unknown): s is string {
  return typeof s === 'string' && (s === 'global' || s.startsWith('repo:') || s.startsWith('env:'));
}

/**
 * Strict-JSON parse + validation of a distiller response: bad shape/JSON -> null;
 * per-item kind/scope validated (invalid item dropped); title/body length-capped
 * (clamped, not rejected). Returns null (not []) when every item was dropped.
 */
export function parseDistillerOutput(text: string): DistillItem[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { items?: unknown }).items)) {
    return null;
  }

  const items: DistillItem[] = [];
  for (const raw of (parsed as { items: unknown[] }).items.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (!(KIND as readonly string[]).includes(r.kind as string)) continue;
    const title = typeof r.title === 'string' ? r.title.trim().slice(0, TITLE_MAX) : '';
    const body = typeof r.body === 'string' ? r.body.trim().slice(0, BODY_MAX) : '';
    if (!title || !body) continue;
    const scope = isValidScope(r.scope) ? r.scope : 'global';
    const tags = Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string').slice(0, 8) : [];
    items.push({ kind: r.kind as Kind, title, body, tags, scope });
  }
  return items.length ? items : null;
}

/**
 * Insert distilled items as source='distilled' status='draft' nodes — drafts never
 * inject (see knowledgeContext's status='approved' filter). Skips any item whose
 * (title, scope) already exists as an ACTIVE node of any status, so re-closing similar
 * tasks doesn't spam duplicate drafts or clobber an already-approved/rejected node.
 */
export function insertDraftNodes(db: Database.Database, items: DistillItem[]): KnowledgeNode[] {
  const inserted: KnowledgeNode[] = [];
  for (const item of items) {
    if (findActiveByTitleScope(db, item.title, item.scope)) continue;
    inserted.push(
      upsertNode(db, {
        kind: item.kind,
        title: item.title,
        body: item.body,
        tags: item.tags,
        scope: item.scope,
        source: 'distilled',
        status: 'draft',
      }),
    );
  }
  return inserted;
}

/**
 * SSoT Phase 4 traceability: for each freshly-drafted node, hybrid-search the ingested
 * corpus by its title and record `evidences` links to the top matching chunks (see
 * node_chunk_links / store.ts's linkNodeToChunks) — a reviewer can then see WHY a draft
 * was suggested. Best-effort: an empty corpus, rag_enabled=false, or a search failure
 * all degrade to "no links" rather than blocking distillation.
 */
export async function linkDistilledEvidence(db: Database.Database, nodes: KnowledgeNode[]): Promise<void> {
  for (const node of nodes) {
    try {
      const hits = await search(db, node.title, { topK: EVIDENCE_TOP_K });
      if (hits.length) linkNodeToChunks(db, node.id, hits.map((h) => h.chunk_id));
    } catch {
      // best-effort — a search/embed failure never blocks distillation
    }
  }
}

export type DistillExec = (prompt: string) => Promise<string | null>;

/**
 * Real one-shot haiku call: `claude -p <prompt> --model haiku --output-format text`,
 * 3-minute hard timeout. Uses the async execFile (not execFileSync) so the spawn
 * itself never blocks the event loop — the whole point of runDistiller being
 * fire-and-forget from a live close request. Any failure -> null, never throws.
 */
async function defaultExec(prompt: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'claude',
      ['-p', prompt, '--model', 'haiku', '--output-format', 'text'],
      { timeout: TIMEOUT_MS, env: process.env, maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Guarded one-shot distiller pass, run fire-and-forget by the caller
 * (`void runDistiller(...).catch(...)`) so it never delays a task-close response.
 * Skips (resolves null) when there's no material, coding_tool is 'mock',
 * knowledge_distill is off, or current session usage is already at/over the hard
 * limit — mirrors gapReviewer's "any failure -> null, never throws" guard style.
 * `exec` is injectable so tests never spawn a real process (zero tokens/network).
 */
export async function runDistiller(
  db: Database.Database,
  task: Task,
  material: string | null,
  exec?: DistillExec,
): Promise<KnowledgeNode[] | null> {
  if (!material) return null;
  if (task.coding_tool === 'mock') return null;
  if (!getBool(db, 'knowledge_distill', true)) return null;
  // knowledge_distill_backend: claude (as before) | local (the served model, no usage guard) | off
  const backend = exec ? 'claude' : backendFor(db, 'knowledge_distill_backend');
  if (backend === 'off') return null;
  if (backend === 'claude') {
    const hardLimit = getNum(db, 'hard_limit_pct', 95);
    if (readUsage().session.percent >= hardLimit) return null;
  }
  const run: DistillExec = exec ?? (backend === 'local' ? (prompt) => localPrompt(db, prompt, { maxTokens: 2048 }) : defaultExec);

  try {
    const out = await run(buildPrompt(material));
    if (!out) return null;
    const items = parseDistillerOutput(out);
    if (!items) return null;
    const inserted = insertDraftNodes(db, items);
    await linkDistilledEvidence(db, inserted);
    return inserted;
  } catch {
    return null;
  }
}
