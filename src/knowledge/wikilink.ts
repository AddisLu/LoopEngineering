import type Database from 'better-sqlite3';

/**
 * Obsidian-style `[[title]]` / `[[title#heading]]` / `[[title|alias]]` — only the title
 * segment is a resolution target; an optional `#heading` anchor and/or `|alias` display
 * text are both discarded. Dedup'd (a body can mention the same target more than once).
 */
const WIKILINK_RE = /\[\[([^[\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g;

export function parseWikilinks(text: string): string[] {
  const out = new Set<string>();
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(text))) {
    const title = (m[1] ?? '').trim();
    if (title) out.add(title);
  }
  return [...out];
}

/**
 * Rebuilds every active node's outbound `links-to` edges from its current body text —
 * a full pass (not incremental) so forward references (node A links to a title that
 * doesn't exist yet, or a node's title/body changes) always converge to the correct set
 * on the very next call. Cheap: the curated graph is small by design (human-approved,
 * see plan-SSoT-master.md's two-plane split), so a full rescan on every write is fine.
 * Only 'links-to' edges are touched — manually-created edges of any other relation are
 * left alone even if their src/dst also happen to match a wikilink pair.
 */
export function resyncNodeWikilinks(db: Database.Database): void {
  const nodes = db
    .prepare(`SELECT id, title, body FROM knowledge_nodes WHERE invalid_at IS NULL AND status IN ('approved', 'draft')`)
    .all() as { id: string; title: string; body: string }[];
  const byTitle = new Map(nodes.map((n) => [n.title.toLowerCase(), n.id]));

  const existingStmt = db.prepare(`SELECT id, dst FROM knowledge_edges WHERE src = ? AND relation = 'links-to'`);
  const insertEdge = db.prepare(`INSERT OR IGNORE INTO knowledge_edges (src, dst, relation) VALUES (?, ?, 'links-to')`);
  const deleteEdge = db.prepare(`DELETE FROM knowledge_edges WHERE id = ?`);

  const tx = db.transaction(() => {
    for (const n of nodes) {
      const desired = new Set<string>();
      for (const title of parseWikilinks(n.body)) {
        const dst = byTitle.get(title.toLowerCase());
        if (dst && dst !== n.id) desired.add(dst);
      }
      const existing = existingStmt.all(n.id) as { id: number; dst: string }[];
      for (const e of existing) {
        if (desired.has(e.dst)) desired.delete(e.dst);
        else deleteEdge.run(e.id);
      }
      for (const dst of desired) insertEdge.run(n.id, dst);
    }
  });
  tx();
}

function docTitleKey(title: string | null): string {
  return (title ?? '').replace(/\.(md|markdown|mdx)$/i, '').toLowerCase();
}

/**
 * Rebuilds `doc_links` for every active markdown document (any ingested source kind —
 * vault is the primary case but a git/folder-ingested .md gets the same treatment) from
 * its current chunk text. Wholesale rebuild, same rationale as resyncNodeWikilinks: a
 * link's target may be ingested by a different source/run than the link itself, so only
 * a full re-resolution guarantees convergence. Unresolved links are kept (both target
 * columns NULL) so a later ingest of the missing target resolves them without having to
 * re-parse the source document's text again.
 */
export function resyncDocumentWikilinks(db: Database.Database): void {
  const docs = db
    .prepare(`SELECT id, title FROM documents WHERE invalid_at IS NULL AND doc_kind IN ('md', 'markdown', 'mdx')`)
    .all() as { id: number; title: string | null }[];
  if (!docs.length) return;

  const nodes = db
    .prepare(`SELECT id, title FROM knowledge_nodes WHERE invalid_at IS NULL AND status IN ('approved', 'draft')`)
    .all() as { id: string; title: string }[];
  const nodeByTitle = new Map(nodes.map((n) => [n.title.toLowerCase(), n.id]));
  const docByTitle = new Map(docs.map((d) => [docTitleKey(d.title), d.id]));

  const chunkStmt = db.prepare(`SELECT text FROM chunks WHERE document_id = ? AND invalid_at IS NULL ORDER BY ord ASC`);
  const deleteForDoc = db.prepare(`DELETE FROM doc_links WHERE document_id = ?`);
  const insert = db.prepare(
    `INSERT INTO doc_links (document_id, target_title, target_document_id, target_node_id) VALUES (?, ?, ?, ?)`,
  );

  const tx = db.transaction(() => {
    for (const d of docs) {
      deleteForDoc.run(d.id);
      const text = (chunkStmt.all(d.id) as { text: string }[]).map((r) => r.text).join('\n');
      const titles = parseWikilinks(text);
      for (const title of titles) {
        const lower = title.toLowerCase();
        const targetDocId = docByTitle.get(lower);
        if (targetDocId === d.id) continue; // no self-links
        const targetNodeId = nodeByTitle.get(lower);
        insert.run(d.id, title, targetDocId ?? null, targetNodeId ?? null);
      }
    }
  });
  tx();
}
