import { execFile, execFileSync } from 'node:child_process';
import { backendFor, localPrompt } from '../local/backend.js';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { getNum } from '../db/index.js';
import { readUsage } from '../token/usage.js';
import { addEdge } from './store.js';
import { RELATION, type KnowledgeNode, type KnowledgeEdge, type Relation } from './types.js';
import { embed, type EmbedExec } from './embed.js';
import { isVecAvailable, vecUpsert, vecKnn } from './vec.js';

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 3 * 60_000;
const DEFAULT_TOP_K = 5;
const DEFAULT_LIMIT = 20;
const NOTE_MAX = 240;
const SNIPPET_MAX = 200;

// 'links-to' is reserved for wikilink auto-derivation (see src/knowledge/wikilink.ts) —
// the LLM never assigns it.
const ALLOWED_RELATIONS = new Set<Relation>(RELATION.filter((r) => r !== 'links-to'));

// Cached at module scope (computed once): mirrors src/voice/structure.ts's hasClaudeCli —
// `which` is a real process spawn, and this runs on every CLI/API invocation of relate.
let claudeCliCache: boolean | null = null;

function hasClaudeCli(): boolean {
  if (claudeCliCache === null) {
    try {
      execFileSync('which', ['claude'], { stdio: 'ignore' });
      claudeCliCache = true;
    } catch {
      claudeCliCache = false;
    }
  }
  return claudeCliCache;
}

/** Test-only: reset/force the cached claude-CLI-presence result. */
export function _setClaudeCliCacheForTests(present: boolean | null): void {
  claudeCliCache = present;
}

function stripFences(s: string): string {
  const trimmed = s.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ?? trimmed;
}

export interface SuggestedEdge {
  src: string;
  dst: string;
  relation: string;
  note: string | null;
}

export type RelateExec = (prompt: string) => Promise<string | null>;

export interface SuggestRelationsOptions {
  llmExec?: RelateExec;
  embedExec?: EmbedExec;
  /** Max candidate pairs (closest first) assessed in one LLM call. Default 20. */
  limit?: number;
}

interface ApprovedNode extends KnowledgeNode {
  rowid: number;
}

/** Approved+active nodes with their SQLite rowid (knowledge_nodes.id is TEXT, not the
 * table's implicit rowid — vec_nodes needs an INTEGER rowid, same convention knowledge_fts
 * already relies on via content_rowid='rowid'). */
function loadApprovedNodes(db: Database.Database): ApprovedNode[] {
  return db
    .prepare(`SELECT rowid AS rowid, * FROM knowledge_nodes WHERE status = 'approved' AND invalid_at IS NULL AND facet IS NULL`)
    .all() as ApprovedNode[];
}

/** Embeds each node's title+body and upserts it into vec_nodes; returns id -> vector for
 * the nodes that embedded successfully (best-effort — a short/empty result for one node
 * never blocks the others). */
async function embedNodes(
  db: Database.Database,
  nodes: ApprovedNode[],
  embedExec?: EmbedExec,
): Promise<Map<string, number[]>> {
  const texts = nodes.map((n) => `${n.title}\n${n.body}`.trim());
  const vectors = await embed(db, texts, embedExec);
  const byId = new Map<string, number[]>();
  nodes.forEach((n, i) => {
    const v = vectors[i];
    if (!Array.isArray(v) || !v.length) return;
    vecUpsert(db, 'vec_nodes', n.rowid, v, n.id);
    byId.set(n.id, v);
  });
  return byId;
}

interface CandidatePair {
  a: string;
  b: string;
  distance: number;
}

/** Top-K (cosine) nearest neighbor of every embedded node, deduped into undirected pairs
 * and sorted closest-first — the whole-graph candidate pool a caller then slices to `limit`. */
function buildCandidatePairs(
  db: Database.Database,
  nodes: ApprovedNode[],
  embeddings: Map<string, number[]>,
  topK: number,
): CandidatePair[] {
  const seen = new Map<string, CandidatePair>();
  for (const n of nodes) {
    const vector = embeddings.get(n.id);
    if (!vector) continue;
    for (const nb of vecKnn(db, 'vec_nodes', vector, topK + 1)) {
      const otherId = String(nb.refId);
      if (otherId === n.id) continue;
      const key = [n.id, otherId].sort().join(':');
      if (!seen.has(key)) seen.set(key, { a: n.id, b: otherId, distance: nb.distance });
    }
  }
  return [...seen.values()].sort((x, y) => x.distance - y.distance);
}

function nodeSnippet(n: KnowledgeNode): string {
  return n.body.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX);
}

function buildPrompt(pairs: CandidatePair[], nodeById: Map<string, KnowledgeNode>): string {
  const blocks = pairs.map((p, i) => {
    const a = nodeById.get(p.a)!;
    const b = nodeById.get(p.b)!;
    return (
      `[${i + 1}]\n` +
      `A: id=${a.id} kind=${a.kind} title="${a.title}" body="${nodeSnippet(a)}"\n` +
      `B: id=${b.id} kind=${b.kind} title="${b.title}" body="${nodeSnippet(b)}"`
    );
  });

  return `你在幫一個知識圖譜的候選節點配對指派關係型別，並濾掉沒有實質關聯的配對。

每組配對（[N]）是嵌入空間中彼此接近的兩個節點 A、B。判斷兩者之間是否有實質關聯：
有的話輸出一條邊，src/dst 從該組 A、B 的 id 中選（方向依語意決定），relation 必須是
以下之一：runs-on | constrains | deployed-at | uses | part-of | related
兩者之間沒有實質關聯的配對，不要輸出。

## 候選配對
${blocks.join('\n\n')}

Output STRICT JSON ONLY — no markdown code fences, no commentary — exactly this shape:
{"edges":[{"src":"...","dst":"...","relation":"...","note":"...(optional, 簡短說明為何相關)"}]}
全部配對都不相關時，輸出 {"edges":[]}。`;
}

/**
 * Strict-JSON parse + validation of a relate response: bad shape/JSON -> null. Each
 * edge's src/dst must both belong to `validIds` (the exact candidate pool sent in the
 * prompt — never trust a model-hallucinated id) and relation must be in the allowed
 * RELATION subset; anything else is dropped. Returns null (not []) when every edge was
 * dropped or the model explicitly returned none — mirrors distill.ts's parseDistillerOutput.
 */
export function parseRelateOutput(text: string, validIds: Set<string>): SuggestedEdge[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripFences(text));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { edges?: unknown }).edges)) {
    return null;
  }

  const items: SuggestedEdge[] = [];
  for (const raw of (parsed as { edges: unknown[] }).edges) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const src = typeof r.src === 'string' ? r.src.trim() : '';
    const dst = typeof r.dst === 'string' ? r.dst.trim() : '';
    if (!src || !dst || src === dst) continue;
    if (!validIds.has(src) || !validIds.has(dst)) continue;
    if (typeof r.relation !== 'string' || !ALLOWED_RELATIONS.has(r.relation as Relation)) continue;
    const note = typeof r.note === 'string' && r.note.trim() ? r.note.trim().slice(0, NOTE_MAX) : null;
    items.push({ src, dst, relation: r.relation, note });
  }
  return items.length ? items : null;
}

/**
 * Inserts each suggested edge as status='draft', skipping any (src,dst,relation) triple
 * that already exists (approved or draft, active or invalidated) — the UNIQUE(src,dst,relation)
 * constraint on knowledge_edges backs this, but the pre-check lets us report only the
 * edges genuinely newly created (addEdge's INSERT OR IGNORE would otherwise still return
 * the pre-existing row).
 */
function insertDraftEdges(db: Database.Database, items: SuggestedEdge[]): KnowledgeEdge[] {
  const inserted: KnowledgeEdge[] = [];
  for (const item of items) {
    const exists = db
      .prepare(`SELECT 1 FROM knowledge_edges WHERE src = ? AND dst = ? AND relation = ?`)
      .get(item.src, item.dst, item.relation);
    if (exists) continue;
    const edge = addEdge(db, { src: item.src, dst: item.dst, relation: item.relation, note: item.note, status: 'draft' });
    if (edge) inserted.push(edge);
  }
  return inserted;
}

/** Real one-shot call: `claude -p <prompt> --model haiku --output-format text`, mirrors
 * knowledge/distill.ts's defaultExec. Any failure -> null, never throws. */
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
 * Suggests relations between approved knowledge nodes: embeds each into vec_nodes, takes
 * every node's top-K (cosine) nearest neighbors as candidate pairs, then a single LLM call
 * classifies/filters those pairs into RELATION-typed edges. Suggestions land as status='draft'
 * (never auto-approved) and are deduped against any existing (src,dst,relation) triple.
 *
 * Guarded like distill.ts/planner.ts: `!exec` is checked before the `which claude` host
 * probe so injected-exec tests never depend on the host having the CLI installed; skips
 * (resolves null) when the vec extension didn't load, session usage is at/over
 * hard_limit_pct, fewer than 2 approved nodes exist, no candidate pairs were found, or the
 * LLM call/parse failed or explicitly returned nothing. `llmExec`/`embedExec` are injectable
 * so tests never spawn a real process or GPU (zero tokens/network).
 */
export async function suggestRelations(
  db: Database.Database,
  opts: SuggestRelationsOptions = {},
): Promise<KnowledgeEdge[] | null> {
  // knowledge_distill_backend: claude (as before) | local (the served model; no usage guard) | off.
  // 公司模式 (cloud_llm_allowed=false) turns claude into local.
  const backend = opts.llmExec ? 'claude' : backendFor(db, 'knowledge_distill_backend');
  if (backend === 'off') return null;
  if (backend === 'claude') {
    if (!opts.llmExec && !hasClaudeCli()) return null;
    const hardLimit = getNum(db, 'hard_limit_pct', 95);
    if (readUsage().session.percent >= hardLimit) return null;
  }
  if (!isVecAvailable(db)) return null;

  const nodes = loadApprovedNodes(db);
  if (nodes.length < 2) return null;

  try {
    const embeddings = await embedNodes(db, nodes, opts.embedExec);
    const pairs = buildCandidatePairs(db, nodes, embeddings, DEFAULT_TOP_K).slice(0, opts.limit ?? DEFAULT_LIMIT);
    if (!pairs.length) return null;

    const nodeById = new Map<string, KnowledgeNode>(nodes.map((n) => [n.id, n]));
    const run = opts.llmExec ?? (backend === 'local' ? (prompt: string) => localPrompt(db, prompt) : defaultExec);
    const out = await run(buildPrompt(pairs, nodeById));
    if (!out) return null;

    const validIds = new Set(pairs.flatMap((p) => [p.a, p.b]));
    const suggested = parseRelateOutput(out, validIds);
    if (!suggested) return null;

    return insertDraftEdges(db, suggested);
  } catch {
    return null;
  }
}
