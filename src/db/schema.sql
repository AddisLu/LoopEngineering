-- Loop Engineering schema. Applied idempotently at startup (see index.ts).
-- SQLite with WAL. Single-user, single-host.

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  goal           TEXT NOT NULL,

  -- intake gate fields
  plan_ref       TEXT,                       -- md/html path or URL
  plan_kind      TEXT,                        -- md | html | url
  coding_tool    TEXT NOT NULL DEFAULT 'claude-code', -- claude-code | mock | generic (non-git, persistent output dir)
  verification_steps TEXT NOT NULL DEFAULT '[]',       -- JSON array of shell commands
  setup_cmd      TEXT,                        -- optional, run in worktree before dispatch

  -- execution target
  repo_path      TEXT,
  base_branch    TEXT,

  -- scheduling attributes
  complexity     TEXT NOT NULL DEFAULT 'M',   -- S | M | L
  priority       INTEGER NOT NULL DEFAULT 2,
  model          TEXT,                        -- sonnet | opus | default(NULL)
  timeout_min    INTEGER,                     -- NULL -> derived from complexity
  depends_on     TEXT,                        -- task id this one waits for (serial chains);
                                              -- held until that task is closed. Soft ref (no FK).

  -- layered verification (see src/orchestrator/judge.ts + verify.ts)
  verify_mode    TEXT NOT NULL DEFAULT 'command', -- CSV of command|llm|manual
  verify_rubric  TEXT,                        -- acceptance criteria: what "done" means
  verify_timeout_min INTEGER,                 -- per-task verify per-step timeout override (min)

  -- hardware/environment awareness (see src/capabilities.ts)
  requires       TEXT,                        -- CSV of capability tokens this task needs
                                              -- (e.g. gpu, camera, network, os:windows) — unmet
                                              -- ones defer command verification to manual

  -- lifecycle
  status         TEXT NOT NULL DEFAULT 'draft',
    -- draft|ready|queued|running|verifying|blocked|attention|review|failed|closed
  resume_count   INTEGER NOT NULL DEFAULT 0,

  -- result snapshot
  pr_url         TEXT,
  review_md_path TEXT,
  est_session_pct REAL,                       -- estimate used at dispatch time
  merge_status   TEXT,                         -- merged | pending | conflict | NULL (git close-out)
  parent_task_id TEXT,                          -- set on auto-created merge-conflict resolution tasks

  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- one row per execution attempt (first run or resume)
CREATE TABLE IF NOT EXISTS task_runs (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  resume_of      TEXT REFERENCES task_runs(id),      -- NULL = first run
  attempt        INTEGER NOT NULL DEFAULT 1,

  session_id     TEXT,                         -- claude session id (for --resume)
  pid            INTEGER,                       -- process-group leader pid
  worktree_path  TEXT,
  branch         TEXT,
  log_path       TEXT,                          -- raw NDJSON .jsonl

  exit_code      INTEGER,
  error          TEXT,
  interrupted_by TEXT,                          -- breaker | timeout | user | pause | window | orphaned | NULL

  usage_json     TEXT,                          -- result-event usage (debug/future)
  session_pct_before REAL,
  session_pct_after  REAL,
  weekly_pct_before  REAL,                       -- Phase 3 #2: weekly budget packing/calibration
  weekly_pct_after   REAL,
  dispatch_window    TEXT,                        -- Phase 3 #1: 'day' | 'night' at dispatch time
  discipline     INTEGER,                        -- 0|1: prompt_discipline setting at dispatch time

  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_task ON task_runs(task_id);
CREATE INDEX IF NOT EXISTS idx_runs_pid ON task_runs(pid);

-- audit trail: every status transition, dispatch, breaker/timeout, with token snapshot
CREATE TABLE IF NOT EXISTS task_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  run_id      TEXT REFERENCES task_runs(id),
  kind        TEXT NOT NULL,                    -- status | dispatch | breaker | timeout | recovery | note
  from_status TEXT,
  to_status   TEXT,
  detail      TEXT,
  session_pct REAL,
  weekly_pct  REAL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_task ON task_events(task_id);

-- key/value settings (see config.ts for defaults + seeding)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- periodic oauth/usage readings for the dashboard history
CREATE TABLE IF NOT EXISTS token_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_pct REAL,
  weekly_pct  REAL,
  session_resets_at TEXT,
  weekly_resets_at  TEXT,
  source      TEXT,                             -- api | cache | ledger
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_snap_created ON token_snapshots(created_at);

-- Knowledge base: user facts/constraints (e.g. "公司只能用 Windows 11 + Python 3.8.10")
-- that later tasks inject into prompts. This schema is persistence-only (zero behavior
-- change elsewhere) — see src/knowledge/{types,store}.ts.
CREATE TABLE IF NOT EXISTS knowledge_nodes (
  id         TEXT PRIMARY KEY,                 -- k_<nanoid(10)>
  kind       TEXT NOT NULL DEFAULT 'fact',     -- environment|project|constraint|preference|tech|fact|person|repo
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  tags       TEXT NOT NULL DEFAULT '[]',       -- JSON string[]
  scope      TEXT NOT NULL DEFAULT 'global',   -- 'global' | 'repo:<realpath>' | 'env:<name>'
  source     TEXT NOT NULL DEFAULT 'manual',   -- manual | mcp | distilled | seed
  status     TEXT NOT NULL DEFAULT 'approved', -- approved | draft | rejected
  weight     INTEGER NOT NULL DEFAULT 3,       -- 1..5 injection priority
  invalid_at TEXT,                             -- bi-temporal: superseded facts are invalidated, never deleted
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_know_scope  ON knowledge_nodes(scope);
CREATE INDEX IF NOT EXISTS idx_know_status ON knowledge_nodes(status);

CREATE TABLE IF NOT EXISTS knowledge_edges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  src        TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  dst        TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  relation   TEXT NOT NULL DEFAULT 'related',  -- runs-on|constrains|deployed-at|uses|part-of|related|links-to
  note       TEXT,
  invalid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(src, dst, relation)
);
-- SSoT Phase 3: multi-hop traversal at scale needs both directions indexed — the
-- UNIQUE(src,dst,relation) constraint's implicit index only serves src-first lookups.
CREATE INDEX IF NOT EXISTS idx_edges_src ON knowledge_edges(src);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON knowledge_edges(dst);

-- Environments: promotes `tasks.environment` from a knowledge-scope label to a real
-- execution/deploy target (see src/deploy/store.ts). Additive — the env:<name> knowledge
-- scope keeps working unchanged whether or not a row exists here.
CREATE TABLE IF NOT EXISTS environments (
  name        TEXT PRIMARY KEY,         -- 'home' | 'company' | any
  kind        TEXT NOT NULL DEFAULT 'dev',   -- dev | staging | prod
  host        TEXT,                      -- informational (e.g. 'linux-rtx2080', 'windows-11')
  capabilities TEXT NOT NULL DEFAULT '', -- CSV, mirrors host_capabilities semantics (gpu,camera,os:windows...)
  deploy_cmd  TEXT,                      -- shell run on auto-deploy (dev); NULL/empty = manual (prod)
  auto_deploy INTEGER NOT NULL DEFAULT 0,-- 1 = run deploy_cmd automatically on a deploy task
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- History of deploy attempts (+ rollback targets). task_id is nullable so a deployment
-- record survives its originating task being deleted (e.g. a later rollback).
CREATE TABLE IF NOT EXISTS deployments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  environment TEXT NOT NULL,
  commit_sha  TEXT,                      -- what was deployed (for rollback)
  status      TEXT NOT NULL DEFAULT 'pending', -- pending|deployed|manual-pending|failed|rolledback
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deployments_env ON deployments(environment);

-- Pipeline templates: ordered stage specs that instantiate a depends_on task chain in one
-- action (see src/pipeline/*.ts). def is the JSON stage array; built-ins (feature/fix/ship)
-- are seeded from seed/pipelines/*.json at startup, same idiom as environments below.
CREATE TABLE IF NOT EXISTS pipelines (
  name        TEXT PRIMARY KEY,
  description TEXT,
  def         TEXT NOT NULL,   -- JSON: { name, description, stages: [...] }
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Reusable "boss persona" report templates (see src/report/templates.ts): a stored
-- instructions/format/audience blob that generateReport injects in place of its
-- built-in default one-page instructions. Same shape/idiom as pipelines above; seeded
-- from seed/report-templates/*.json at first startup.
CREATE TABLE IF NOT EXISTS report_templates (
  name        TEXT PRIMARY KEY,
  description TEXT,
  def         TEXT NOT NULL,   -- JSON: { name, description, audience, format, instructions, sections?, default_project?, model? }
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- MUST use the trigram tokenizer: default unicode61 cannot segment Chinese
-- ("只能" would never match "公司只能用"). Requires SQLite >= 3.34 (better-sqlite3
-- 11.x bundles >= 3.45), verified with a runtime probe in knowledge.store.test.ts.
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  title, body, tags, content='knowledge_nodes', content_rowid='rowid', tokenize='trigram'
);

-- external-content sync: keep knowledge_fts in lockstep with knowledge_nodes
-- ('delete' + insert is the documented pattern for external-content FTS5 tables).
CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge_nodes BEGIN
  INSERT INTO knowledge_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge_nodes BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body, tags) VALUES ('delete', old.rowid, old.title, old.body, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge_nodes BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, body, tags) VALUES ('delete', old.rowid, old.title, old.body, old.tags);
  INSERT INTO knowledge_fts(rowid, title, body, tags) VALUES (new.rowid, new.title, new.body, new.tags);
END;

-- SSoT/RAG Phase 0 foundation (see src/knowledge/{vec,embed}.ts). Persistence-only here —
-- nothing reads/writes these tables yet (Phase 1 ingest pipeline populates them); the
-- vec0 virtual tables below are created separately (guarded on loadExtension success, see
-- src/db/index.ts) since a plain CREATE TABLE IF NOT EXISTS would fail without the extension.

-- Source registry: where documents/chunks are ingested from (Phase 1 walker).
CREATE TABLE IF NOT EXISTS sources (
  id               TEXT PRIMARY KEY,              -- src_<nanoid(10)>
  kind             TEXT NOT NULL,                  -- git|folder|vault|github-issues
  uri              TEXT NOT NULL,
  config           TEXT NOT NULL DEFAULT '{}',     -- JSON: include/exclude globs, branch, ...
  enabled          INTEGER NOT NULL DEFAULT 1,
  last_ingested_at TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per ingested file/page. INTEGER PRIMARY KEY so `id` doubles as the vec_chunks
-- rowid correlation for chunks below (vec0 requires an integer rowid).
CREATE TABLE IF NOT EXISTS documents (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id    TEXT REFERENCES sources(id) ON DELETE CASCADE,
  path         TEXT NOT NULL,
  uri          TEXT,
  title        TEXT,
  doc_kind     TEXT,                               -- md|code|issue|...
  sha256       TEXT,
  bytes        INTEGER,
  mtime        TEXT,
  lang         TEXT,
  invalid_at   TEXT,                                -- bi-temporal: superseded/removed, never deleted
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source_id);

-- Chunked document content (RAG corpus layer — only ever selectively pulled top-K,
-- never bulk-injected into a task prompt; see the two-plane design in plan-SSoT-master.md).
CREATE TABLE IF NOT EXISTS chunks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord          INTEGER NOT NULL,
  text         TEXT NOT NULL,
  section      TEXT,
  start_line   INTEGER,
  end_line     INTEGER,
  sha256       TEXT,
  invalid_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);

-- RAG Phase 2 (src/knowledge/retrieve.ts): FTS5 trigram index over chunk text, mirroring
-- knowledge_fts's external-content pattern so hybrid search can do keyword ranking over
-- the corpus layer alongside vec0 KNN. Only AI/AD triggers: chunk rows are add-only
-- (bi-temporal supersede inserts a new row, see ingest.ts) — no code path ever UPDATEs
-- chunks.text, so no AU trigger is needed. A DB with chunks predating this table gets
-- backfilled by db/index.ts (external-content FTS5 tables start empty, not auto-populated).
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, section, content='chunks', content_rowid='id', tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text, section) VALUES (new.id, new.text, new.section);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text, section) VALUES ('delete', old.id, old.text, old.section);
END;

-- SSoT Phase 3 (src/knowledge/wikilink.ts): outbound [[wikilink]] targets parsed out of
-- vault/markdown documents, resolved against other documents (by basename sans extension)
-- and curated knowledge_nodes (by title) — the "documents become graph vertices, linked
-- both ways" half of the Obsidian-style graph (node-body wikilinks reuse knowledge_edges
-- directly, relation='links-to', see resyncNodeWikilinks). Rebuilt wholesale on every
-- ingest run (see resyncDocumentWikilinks) rather than incrementally, so a link stays
-- correct even when its target is ingested by a later/different source run. Unresolved
-- links (target_document_id AND target_node_id both NULL) are kept so a later ingest of
-- the missing target resolves them without re-parsing document text.
CREATE TABLE IF NOT EXISTS doc_links (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id        INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_title       TEXT NOT NULL,
  target_document_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  target_node_id     TEXT REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_doc_links_document ON doc_links(document_id);
CREATE INDEX IF NOT EXISTS idx_doc_links_target_document ON doc_links(target_document_id);
CREATE INDEX IF NOT EXISTS idx_doc_links_target_node ON doc_links(target_node_id);

-- SSoT Phase 4 (src/knowledge/distill.ts): traceability from a distilled draft node back
-- to the corpus chunks that support it (hybrid-searched by the node's title/body right
-- after it's drafted). Separate from knowledge_edges because a chunk isn't a
-- knowledge_nodes row (integer id, different table) — knowledge_edges' src/dst both FK
-- to knowledge_nodes(id) and can't reference it.
CREATE TABLE IF NOT EXISTS node_chunk_links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id    TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  chunk_id   INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  relation   TEXT NOT NULL DEFAULT 'evidences',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(node_id, chunk_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_node_chunk_node ON node_chunk_links(node_id);
CREATE INDEX IF NOT EXISTS idx_node_chunk_chunk ON node_chunk_links(chunk_id);
