import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, getTask, setStatus, createRun } from '../tasks.js';
import { listNodes, upsertNode, evidenceForNode } from '../knowledge/store.js';
import { knowledgeContext } from '../knowledge/context.js';
import {
  collectDistillMaterial,
  runDistiller,
  parseDistillerOutput,
  insertDraftNodes,
  type DistillItem,
  type DistillExec,
} from '../knowledge/distill.js';
import { buildApp } from '../server/app.js';
import { setCachedUsage } from '../token/usage.js';

let db: Database.Database;
let tmpRoots: string[] = [];

beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10); // safe, fresh — well under hard_limit_pct
  tmpRoots = [];
});
afterEach(() => {
  db.close();
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

function mkTmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-distill-${tag}-`));
  tmpRoots.push(d);
  return d;
}

/** Externally-resolvable promise, so a test can prove a caller returned before this settled. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// ---- 1. parseDistillerOutput ----

describe('parseDistillerOutput', () => {
  it('parses valid strict JSON into items', () => {
    const out = parseDistillerOutput(
      JSON.stringify({
        items: [
          {
            kind: 'environment',
            title: 'Windows 11 固定',
            body: '公司環境不可升級 Python',
            tags: ['windows'],
            scope: 'env:office',
          },
        ],
      }),
    );
    expect(out).toEqual([
      { kind: 'environment', title: 'Windows 11 固定', body: '公司環境不可升級 Python', tags: ['windows'], scope: 'env:office' },
    ]);
  });

  it('returns null for malformed JSON', () => {
    expect(parseDistillerOutput('not json {{{')).toBeNull();
  });

  it('returns null when items is missing or not an array', () => {
    expect(parseDistillerOutput(JSON.stringify({ nope: [] }))).toBeNull();
    expect(parseDistillerOutput(JSON.stringify({ items: 'nope' }))).toBeNull();
  });

  it('drops an item with an invalid kind enum but keeps the valid ones', () => {
    const out = parseDistillerOutput(
      JSON.stringify({
        items: [
          { kind: 'not-a-kind', title: 'bad', body: 'bad body', tags: [], scope: 'global' },
          { kind: 'fact', title: 'ok', body: 'ok body', tags: [], scope: 'global' },
        ],
      }),
    );
    expect(out).toEqual([{ kind: 'fact', title: 'ok', body: 'ok body', tags: [], scope: 'global' }]);
  });

  it('returns null (not []) when every item is invalid', () => {
    const out = parseDistillerOutput(JSON.stringify({ items: [{ kind: 'nope', title: 'x', body: 'y' }] }));
    expect(out).toBeNull();
  });

  it('clamps oversize title/body instead of dropping the item', () => {
    const hugeTitle = 'x'.repeat(500);
    const hugeBody = 'y'.repeat(5000);
    const out = parseDistillerOutput(
      JSON.stringify({ items: [{ kind: 'fact', title: hugeTitle, body: hugeBody, tags: [], scope: 'global' }] }),
    );
    expect(out).not.toBeNull();
    expect(out![0].title.length).toBeLessThan(hugeTitle.length);
    expect(out![0].body.length).toBeLessThan(hugeBody.length);
  });

  it('defaults a missing/invalid scope to global', () => {
    const out = parseDistillerOutput(JSON.stringify({ items: [{ kind: 'fact', title: 't', body: 'b', tags: [] }] }));
    expect(out![0].scope).toBe('global');
    const out2 = parseDistillerOutput(
      JSON.stringify({ items: [{ kind: 'fact', title: 't', body: 'b', tags: [], scope: 'not-a-valid-scope' }] }),
    );
    expect(out2![0].scope).toBe('global');
  });

  it('caps at 3 items even when the model returns more', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      kind: 'fact',
      title: `t${i}`,
      body: `b${i}`,
      tags: [],
      scope: 'global',
    }));
    const out = parseDistillerOutput(JSON.stringify({ items }));
    expect(out).toHaveLength(3);
  });

  it('strips a ```json fenced block before parsing', () => {
    const payload = JSON.stringify({ items: [{ kind: 'fact', title: 't', body: 'b', tags: [], scope: 'global' }] });
    const out = parseDistillerOutput('```json\n' + payload + '\n```');
    expect(out).toEqual([{ kind: 'fact', title: 't', body: 'b', tags: [], scope: 'global' }]);
  });
});

// ---- 2. insertDraftNodes ----

describe('insertDraftNodes', () => {
  it('inserts items as source=distilled status=draft', () => {
    const items: DistillItem[] = [
      { kind: 'preference', title: 'Prefer single-file delivery', body: '公司環境無法安裝相依', tags: [], scope: 'global' },
    ];
    const [node] = insertDraftNodes(db, items);
    expect(node.source).toBe('distilled');
    expect(node.status).toBe('draft');
  });

  it('skips an item whose (title, scope) already exists as an ACTIVE node of any status', () => {
    upsertNode(db, { title: 'Existing fact', body: 'original body', scope: 'global', status: 'approved' });
    const items: DistillItem[] = [{ kind: 'fact', title: 'Existing fact', body: 'new distilled body', tags: [], scope: 'global' }];
    const inserted = insertDraftNodes(db, items);
    expect(inserted).toHaveLength(0);
    const matches = listNodes(db, { scope: 'global' }).filter((n) => n.title === 'Existing fact');
    expect(matches).toHaveLength(1); // no duplicate drafted
    expect(matches[0].body).toBe('original body'); // untouched, not clobbered by the distiller
  });

  it('drafts NEVER appear in knowledgeContext output (injection safety)', () => {
    upsertNode(db, { title: 'Approved sibling', body: 'this one is approved', scope: 'global', status: 'approved' });
    const items: DistillItem[] = [
      { kind: 'environment', title: 'Draft-only knowledge', body: 'should never inject', tags: [], scope: 'global' },
    ];
    insertDraftNodes(db, items);
    const task = getTask(db, createTask(db, { title: 't', goal: 'g' }).id)!;
    const ctx = knowledgeContext(db, task);
    expect(ctx).toMatch(/Approved sibling/);
    expect(ctx).not.toMatch(/Draft-only knowledge/);
  });
});

// ---- 3. collectDistillMaterial ----

describe('collectDistillMaterial', () => {
  it("reads HANDOFF.md from the task's latest run worktree_path", () => {
    const wt = mkTmpDir('wt');
    fs.writeFileSync(path.join(wt, 'HANDOFF.md'), '## Done\nshipped the distiller\n');
    const t = createTask(db, { title: 't', goal: 'do the thing' });
    createRun(db, { task_id: t.id, worktree_path: wt });
    const material = collectDistillMaterial(db, getTask(db, t.id)!);
    expect(material).toMatch(/shipped the distiller/);
  });

  it('falls back to the task goal when HANDOFF.md/review files are absent', () => {
    const t = getTask(db, createTask(db, { title: 't', goal: 'a very specific durable goal statement' }).id)!;
    const material = collectDistillMaterial(db, t);
    expect(material).toMatch(/a very specific durable goal statement/);
  });

  it('returns null when there is nothing meaningful (no run, no review, empty goal)', () => {
    const t = getTask(db, createTask(db, { title: 't', goal: '' }).id)!;
    expect(collectDistillMaterial(db, t)).toBeNull();
  });
});

// ---- 4. close route: fire-and-forget + gating ----

describe('close route: distiller is fire-and-forget and properly gated', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('close responds before the distiller resolves; drafts land once it does', async () => {
    const t = createTask(db, { title: 't', goal: 'durable goal', coding_tool: 'claude-code', verification_steps: ['true'] });

    let calls = 0;
    const gate = deferred<string | null>();
    const fakeExec: DistillExec = async () => {
      calls++;
      return gate.promise;
    };

    app = buildApp({ db, apiToken: null, distillExec: fakeExec });
    const res = await app.inject({ method: 'POST', url: `/api/tasks/${t.id}/close` });

    expect(res.statusCode).toBe(200);
    expect(calls).toBe(1); // the distiller WAS kicked off...
    expect(listNodes(db, { status: 'draft' })).toHaveLength(0); // ...but hasn't resolved — close didn't wait

    gate.resolve(
      JSON.stringify({ items: [{ kind: 'preference', title: 'Distilled pref', body: 'body', tags: [], scope: 'global' }] }),
    );
    await new Promise((r) => setTimeout(r, 20)); // flush the fire-and-forget continuation

    const drafts = listNodes(db, { status: 'draft' });
    expect(drafts.some((n) => n.title === 'Distilled pref')).toBe(true);
  });

  it('never calls exec for a mock task', async () => {
    const t = createTask(db, { title: 't', goal: 'g', coding_tool: 'mock', verification_steps: ['true'] });
    let calls = 0;
    const fakeExec: DistillExec = async () => {
      calls++;
      return null;
    };
    app = buildApp({ db, apiToken: null, distillExec: fakeExec });
    const res = await app.inject({ method: 'POST', url: `/api/tasks/${t.id}/close` });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(0);
  });

  it('never calls exec when knowledge_distill is off', async () => {
    setSetting(db, 'knowledge_distill', 'false');
    const t = createTask(db, { title: 't', goal: 'g', coding_tool: 'claude-code', verification_steps: ['true'] });
    let calls = 0;
    const fakeExec: DistillExec = async () => {
      calls++;
      return null;
    };
    app = buildApp({ db, apiToken: null, distillExec: fakeExec });
    const res = await app.inject({ method: 'POST', url: `/api/tasks/${t.id}/close` });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toBe(0);
  });
});

// ---- 5. SSoT Phase 4: distiller <-> corpus chunk evidence linking ----

describe('runDistiller: evidence linking (SSoT Phase 4)', () => {
  function insertSource(id: string, kind: string, uri: string): void {
    db.prepare(`INSERT INTO sources (id, kind, uri) VALUES (?, ?, ?)`).run(id, kind, uri);
  }
  function insertDocument(sourceId: string, docPath: string): number {
    const info = db
      .prepare(`INSERT INTO documents (source_id, path, doc_kind) VALUES (?, ?, 'md')`)
      .run(sourceId, docPath);
    return Number(info.lastInsertRowid);
  }
  function insertChunk(documentId: number, text: string): number {
    const info = db.prepare(`INSERT INTO chunks (document_id, ord, text) VALUES (?, 0, ?)`).run(documentId, text);
    return Number(info.lastInsertRowid);
  }

  it('links a freshly-drafted node to the corpus chunk whose text matches its title', async () => {
    insertSource('src_1', 'git', '/repo');
    const doc = insertDocument('src_1', 'worktree.ts');
    const chunk = insertChunk(doc, 'Distilled evidence title appears verbatim here for FTS phrase match.');

    const t = getTask(db, createTask(db, { title: 't', goal: 'g', coding_tool: 'claude-code' }).id)!;
    const fakeExec: DistillExec = async () =>
      JSON.stringify({
        items: [{ kind: 'fact', title: 'Distilled evidence title', body: 'body text', tags: [], scope: 'global' }],
      });
    const inserted = await runDistiller(db, t, 'material', fakeExec);
    expect(inserted).toHaveLength(1);
    const evidence = evidenceForNode(db, inserted![0].id);
    expect(evidence.map((e) => e.chunk_id)).toContain(chunk);
    expect(evidence[0]!.relation).toBe('evidences');
  });

  it('a node with no corpus match gets no evidence links (best-effort, never throws)', async () => {
    const t = getTask(db, createTask(db, { title: 't', goal: 'g', coding_tool: 'claude-code' }).id)!;
    const fakeExec: DistillExec = async () =>
      JSON.stringify({
        items: [{ kind: 'fact', title: 'Nothing matches this anywhere', body: 'b', tags: [], scope: 'global' }],
      });
    const inserted = await runDistiller(db, t, 'material', fakeExec);
    expect(inserted).toHaveLength(1);
    expect(evidenceForNode(db, inserted![0].id)).toEqual([]);
  });
});

// ---- 6. budget guard ----

describe('runDistiller: budget guard', () => {
  it('does not call exec when session usage is already at/over hard_limit_pct', async () => {
    setCachedUsage(96, 10); // hard_limit_pct default is 95
    const t = getTask(db, createTask(db, { title: 't', goal: 'g', coding_tool: 'claude-code' }).id)!;
    let calls = 0;
    const fakeExec: DistillExec = async () => {
      calls++;
      return null;
    };
    const result = await runDistiller(db, t, 'some material', fakeExec);
    expect(result).toBeNull();
    expect(calls).toBe(0);
  });

  it('calls exec when usage is safely under the hard limit', async () => {
    setCachedUsage(10, 10);
    const t = getTask(db, createTask(db, { title: 't', goal: 'g', coding_tool: 'claude-code' }).id)!;
    let calls = 0;
    const fakeExec: DistillExec = async () => {
      calls++;
      return JSON.stringify({ items: [] });
    };
    const result = await runDistiller(db, t, 'some material', fakeExec);
    expect(calls).toBe(1);
    expect(result).toBeNull(); // {"items":[]} parses to no items -> null
  });
});
