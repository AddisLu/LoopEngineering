import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { upsertNode, addEdge, listDraftEdges, graph } from '../knowledge/store.js';
import { createTask, getTask } from '../tasks.js';
import { knowledgeContext } from '../knowledge/context.js';
import {
  suggestRelations,
  parseRelateOutput,
  _setClaudeCliCacheForTests,
  type RelateExec,
} from '../knowledge/relate.js';
import type { EmbedExec } from '../knowledge/embed.js';
import { setCachedUsage } from '../token/usage.js';

let db: Database.Database;

beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10); // safe, fresh — well under hard_limit_pct
});
afterEach(() => {
  db.close();
  _setClaudeCliCacheForTests(null); // never leak a forced cache value into other test files
});

/** Deterministic fake embed: maps each node's exact `title\nbody` text to a hand-picked
 * vector via `byText`; anything unlisted falls back to `fallback` so extra/incidental
 * embed calls never throw. */
function fakeEmbed(byText: Map<string, number[]>, fallback: number[]): EmbedExec {
  return async (_bin, _args, texts) => texts.map((t) => byText.get(t) ?? fallback);
}

// vec_nodes is created with float[embed_dim] (default 1024, see src/config.ts) — a vector
// of any other length throws a dimension-mismatch error from the vec0 extension.
const DIM = 1024;
function pad(entries: [number, number][]): number[] {
  const v = new Array(DIM).fill(0);
  for (const [i, val] of entries) v[i] = val;
  return v;
}

// ---- 1. parseRelateOutput ----

describe('parseRelateOutput', () => {
  const ids = new Set(['k_a', 'k_b']);

  it('parses valid strict JSON into edges', () => {
    const out = parseRelateOutput(JSON.stringify({ edges: [{ src: 'k_a', dst: 'k_b', relation: 'uses', note: 'why' }] }), ids);
    expect(out).toEqual([{ src: 'k_a', dst: 'k_b', relation: 'uses', note: 'why' }]);
  });

  it('returns null for malformed JSON', () => {
    expect(parseRelateOutput('not json {{{', ids)).toBeNull();
  });

  it('returns null when edges is missing or not an array', () => {
    expect(parseRelateOutput(JSON.stringify({ nope: [] }), ids)).toBeNull();
    expect(parseRelateOutput(JSON.stringify({ edges: 'nope' }), ids)).toBeNull();
  });

  it('returns null (not []) for an explicitly empty edges array — mirrors distill.ts', () => {
    expect(parseRelateOutput(JSON.stringify({ edges: [] }), ids)).toBeNull();
  });

  it('drops an edge with an invalid relation enum, and never assigns links-to', () => {
    const out = parseRelateOutput(
      JSON.stringify({
        edges: [
          { src: 'k_a', dst: 'k_b', relation: 'links-to' },
          { src: 'k_a', dst: 'k_b', relation: 'not-a-relation' },
          { src: 'k_a', dst: 'k_b', relation: 'part-of' },
        ],
      }),
      ids,
    );
    expect(out).toEqual([{ src: 'k_a', dst: 'k_b', relation: 'part-of', note: null }]);
  });

  it('drops an edge whose src/dst is not in the candidate id set (no hallucinated ids)', () => {
    const out = parseRelateOutput(JSON.stringify({ edges: [{ src: 'k_a', dst: 'k_ghost', relation: 'uses' }] }), ids);
    expect(out).toBeNull();
  });

  it('drops a self-edge (src === dst)', () => {
    const out = parseRelateOutput(JSON.stringify({ edges: [{ src: 'k_a', dst: 'k_a', relation: 'related' }] }), ids);
    expect(out).toBeNull();
  });

  it('caps an oversize note instead of dropping the edge, and defaults a missing note to null', () => {
    const hugeNote = 'x'.repeat(1000);
    const out = parseRelateOutput(JSON.stringify({ edges: [{ src: 'k_a', dst: 'k_b', relation: 'related', note: hugeNote }] }), ids);
    expect(out![0].note!.length).toBeLessThan(hugeNote.length);

    const out2 = parseRelateOutput(JSON.stringify({ edges: [{ src: 'k_a', dst: 'k_b', relation: 'related' }] }), ids);
    expect(out2![0].note).toBeNull();
  });

  it('strips a ```json fenced block before parsing', () => {
    const payload = JSON.stringify({ edges: [{ src: 'k_a', dst: 'k_b', relation: 'related' }] });
    const out = parseRelateOutput('```json\n' + payload + '\n```', ids);
    expect(out).toEqual([{ src: 'k_a', dst: 'k_b', relation: 'related', note: null }]);
  });
});

// ---- 2. suggestRelations: guards ----

describe('suggestRelations: guards', () => {
  it('returns null and never embeds/calls the LLM with fewer than 2 approved nodes', async () => {
    upsertNode(db, { title: 'Solo node', body: 'alone', scope: 'global' });
    let embedCalls = 0;
    let llmCalls = 0;
    const result = await suggestRelations(db, {
      embedExec: (async (...a: Parameters<EmbedExec>) => {
        embedCalls++;
        return a[2].map(() => pad([]));
      }) as EmbedExec,
      llmExec: (async () => {
        llmCalls++;
        return null;
      }) as RelateExec,
    });
    expect(result).toBeNull();
    expect(embedCalls).toBe(0);
    expect(llmCalls).toBe(0);
  });

  it('returns null without calling embed/llm when session usage is at/over hard_limit_pct', async () => {
    setCachedUsage(96, 10); // hard_limit_pct default is 95
    upsertNode(db, { title: 'A', body: 'a', scope: 'global' });
    upsertNode(db, { title: 'B', body: 'b', scope: 'global' });
    let embedCalls = 0;
    const result = await suggestRelations(db, {
      embedExec: (async (...a: Parameters<EmbedExec>) => {
        embedCalls++;
        return a[2].map(() => pad([]));
      }) as EmbedExec,
      llmExec: async () => JSON.stringify({ edges: [] }),
    });
    expect(result).toBeNull();
    expect(embedCalls).toBe(0);
  });

  it('returns null without calling embed when no llmExec is injected and the claude CLI is unavailable (checked AFTER the !exec gate)', async () => {
    _setClaudeCliCacheForTests(false);
    upsertNode(db, { title: 'A', body: 'a', scope: 'global' });
    upsertNode(db, { title: 'B', body: 'b', scope: 'global' });
    let embedCalls = 0;
    const result = await suggestRelations(db, {
      embedExec: (async (...a: Parameters<EmbedExec>) => {
        embedCalls++;
        return a[2].map(() => pad([]));
      }) as EmbedExec,
      // no llmExec
    });
    expect(result).toBeNull();
    expect(embedCalls).toBe(0);
  });

  it('still runs with an injected llmExec even when the claude CLI is unavailable (hermeticity: !exec checked first)', async () => {
    _setClaudeCliCacheForTests(false);
    const a = upsertNode(db, { title: 'A', body: 'a', scope: 'global' });
    const b = upsertNode(db, { title: 'B', body: 'b', scope: 'global' });
    const vecA = pad([[0, 1]]);
    const vecB = pad([[0, 1]]);
    const embedExec = fakeEmbed(
      new Map([
        [`${a.title}\n${a.body}`, vecA],
        [`${b.title}\n${b.body}`, vecB],
      ]),
      pad([]),
    );
    let llmCalls = 0;
    const result = await suggestRelations(db, {
      embedExec,
      llmExec: async () => {
        llmCalls++;
        return JSON.stringify({ edges: [{ src: a.id, dst: b.id, relation: 'related' }] });
      },
    });
    expect(llmCalls).toBe(1);
    expect(result).toHaveLength(1);
  });
});

// ---- 3. suggestRelations: creates drafts, dedups, bad output -> none ----

describe('suggestRelations: draft creation + dedup', () => {
  function setupTwoNodes() {
    const a = upsertNode(db, { title: 'Node A', body: 'body a', scope: 'global' });
    const b = upsertNode(db, { title: 'Node B', body: 'body b', scope: 'global' });
    const embedExec = fakeEmbed(
      new Map([
        [`${a.title}\n${a.body}`, pad([[0, 1]])],
        [`${b.title}\n${b.body}`, pad([[0, 0.99]])],
      ]),
      pad([]),
    );
    return { a, b, embedExec };
  }

  it('creates a draft edge (never auto-approved) from a valid LLM suggestion', async () => {
    const { a, b, embedExec } = setupTwoNodes();
    const llmExec: RelateExec = async () => JSON.stringify({ edges: [{ src: a.id, dst: b.id, relation: 'uses', note: 'tight coupling' }] });

    const created = await suggestRelations(db, { embedExec, llmExec });
    expect(created).toHaveLength(1);
    expect(created![0]).toMatchObject({ src: a.id, dst: b.id, relation: 'uses', status: 'draft', note: 'tight coupling' });

    const drafts = listDraftEdges(db);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ src_title: 'Node A', dst_title: 'Node B' });
  });

  it('skips a suggestion whose (src,dst,relation) triple already exists (approved or draft) — never a duplicate', async () => {
    const { a, b, embedExec } = setupTwoNodes();
    addEdge(db, { src: a.id, dst: b.id, relation: 'uses' }); // pre-existing approved edge

    const llmExec: RelateExec = async () =>
      JSON.stringify({
        edges: [
          { src: a.id, dst: b.id, relation: 'uses' }, // dup of the approved edge above
          { src: a.id, dst: b.id, relation: 'related' }, // new triple -- should be created
        ],
      });

    const created = await suggestRelations(db, { embedExec, llmExec });
    expect(created).toHaveLength(1);
    expect(created![0].relation).toBe('related');

    // re-running with the identical response a second time creates nothing new (idempotent)
    const createdAgain = await suggestRelations(db, { embedExec, llmExec });
    expect(createdAgain).toHaveLength(0);
  });

  it('bad/unparseable model output -> no edges created', async () => {
    const { embedExec } = setupTwoNodes();
    const llmExec: RelateExec = async () => 'this is not json at all';

    const result = await suggestRelations(db, { embedExec, llmExec });
    expect(result).toBeNull();
    expect(listDraftEdges(db)).toHaveLength(0);
  });

  it('an explicit {"edges":[]} response (nothing relevant) -> no edges created', async () => {
    const { embedExec } = setupTwoNodes();
    const llmExec: RelateExec = async () => JSON.stringify({ edges: [] });

    const result = await suggestRelations(db, { embedExec, llmExec });
    expect(result).toBeNull();
    expect(listDraftEdges(db)).toHaveLength(0);
  });

  it('a null exec result (e.g. process failure) -> no edges created', async () => {
    const { embedExec } = setupTwoNodes();
    const llmExec: RelateExec = async () => null;

    const result = await suggestRelations(db, { embedExec, llmExec });
    expect(result).toBeNull();
    expect(listDraftEdges(db)).toHaveLength(0);
  });
});

// ---- 4. draft edges never leak into approved-only surfaces ----

describe('suggestRelations: draft edges excluded from approved-only surfaces', () => {
  it('a suggested draft edge does not appear in graph() nor in knowledgeContext injection', async () => {
    const a = upsertNode(db, { title: 'Repo A', body: 'repo body', scope: 'global' });
    // NOT 'global' -- only reachable through the (draft) edge hop from Repo A's seed tier,
    // never as a seed itself, so a leak would only show up via the tier-1 edge expansion.
    const b = upsertNode(db, { title: 'Env B', body: 'env body', scope: 'env:only-via-edge' });
    const embedExec = fakeEmbed(
      new Map([
        [`${a.title}\n${a.body}`, pad([[0, 1]])],
        [`${b.title}\n${b.body}`, pad([[0, 0.99]])],
      ]),
      pad([]),
    );
    const llmExec: RelateExec = async () => JSON.stringify({ edges: [{ src: a.id, dst: b.id, relation: 'related' }] });

    const created = await suggestRelations(db, { embedExec, llmExec });
    expect(created).toHaveLength(1);

    const g = graph(db);
    expect(g.edges.some((e) => e.src === a.id && e.dst === b.id)).toBe(false);

    const task = getTask(db, createTask(db, { title: 't', goal: 'g' }).id)!;
    const ctx = knowledgeContext(db, task);
    // Env B is only reachable via the (draft) edge from the Repo A seed's scope --
    // it must NOT show up since the hop only follows approved edges.
    expect(ctx ?? '').not.toMatch(/Env B/);
  });
});

// ---- 5. limit option caps candidate pairs sent to the LLM ----

describe('suggestRelations: limit caps candidate pairs per LLM call', () => {
  it('sends at most `limit` candidate pairs in one prompt', async () => {
    // 5 mutually-close nodes -> C(5,2)=10 candidate pairs, all within top-K(5) reach.
    const titles = ['N1', 'N2', 'N3', 'N4', 'N5'];
    const nodes = titles.map((t) => upsertNode(db, { title: t, body: `${t} body`, scope: 'global' }));
    const byText = new Map(nodes.map((n, i) => [`${n.title}\n${n.body}`, pad([[0, 1], [1, i * 0.001]])]));
    const embedExec = fakeEmbed(byText, pad([]));

    let lastPrompt = '';
    const llmExec: RelateExec = async (prompt) => {
      lastPrompt = prompt;
      return JSON.stringify({ edges: [] });
    };

    await suggestRelations(db, { embedExec, llmExec, limit: 3 });
    const blockCount = (lastPrompt.match(/^\[\d+\]$/gm) ?? []).length;
    expect(blockCount).toBe(3);
  });
});
