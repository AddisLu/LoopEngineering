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

  -- A/B experiment cohort label (see src/server/metrics.ts experiment_ab). Write-only from
  -- intake, NEVER read by scheduler/gate — a pure measurement tag. Nullable = zero behavior change.
  experiment     TEXT,

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
  model          TEXT,                            -- SDD Phase 4: resolved model at dispatch
                                                  -- ('sonnet'|'haiku'|'default'...) for model-aware cost calibration

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

-- 本地模型 registry (src/local/models.ts): one row per spark-vllm-docker recipe the ModelManager
-- can load into vLLM. Tasks reference a row as model='local:<id>'. Seeded INSERT OR IGNORE
-- (seedLocalModels) so edits survive restarts; only one model is loaded on the GPU at a time.
CREATE TABLE IF NOT EXISTS local_models (
  id              TEXT PRIMARY KEY,
  display_name    TEXT NOT NULL,
  recipe          TEXT NOT NULL,
  served_model_id TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Benchmark mode (src/benchmark/*.ts): the same task run by N models ("arms", usually local
-- models), each a normal task (tasks.benchmark_id) in its own worktree that never integrates.
-- Once every arm is terminal an external judge (bench_judge_model, default opus) scores and
-- ranks them; judged rows feed the model x domain matrix (benchmarkMatrix).
CREATE TABLE IF NOT EXISTS benchmarks (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  goal               TEXT NOT NULL,
  plan_ref           TEXT,
  repo_path          TEXT,
  base_branch        TEXT,
  verification_steps TEXT NOT NULL DEFAULT '[]',
  setup_cmd          TEXT,
  verify_rubric      TEXT,
  domain             TEXT NOT NULL DEFAULT 'other',
  complexity         TEXT NOT NULL DEFAULT 'M',
  judge_model        TEXT NOT NULL DEFAULT 'opus',
  status             TEXT NOT NULL DEFAULT 'running', -- running | judging | judged | judge_failed
  winner             TEXT,
  summary            TEXT,
  result_json        TEXT,
  error              TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  judged_at          TEXT
);
CREATE TABLE IF NOT EXISTS benchmark_arms (
  benchmark_id   TEXT NOT NULL REFERENCES benchmarks(id) ON DELETE CASCADE,
  model          TEXT NOT NULL,
  task_id        TEXT NOT NULL,
  verify_outcome TEXT,  -- pass | manual | fail (filled when judged)
  judge_score    REAL,  -- mean of the judge's 0-10 criterion scores
  judge_rank     INTEGER,
  scores_json    TEXT,
  notes          TEXT,
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  duration_s     INTEGER,
  diff_stat      TEXT,
  PRIMARY KEY (benchmark_id, model)
);
CREATE INDEX IF NOT EXISTS idx_benchmark_arms_task ON benchmark_arms(task_id);
-- One row per judge model per benchmark (multi-judge): the raw verdict; arms carry the mean.
CREATE TABLE IF NOT EXISTS benchmark_judgements (
  benchmark_id TEXT NOT NULL REFERENCES benchmarks(id) ON DELETE CASCADE,
  judge_model  TEXT NOT NULL,
  result_json  TEXT,
  summary      TEXT,
  winner       TEXT,
  error        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (benchmark_id, judge_model)
);


-- 模型對話 history (src/chat/store.ts, web/chat.html): server-side transcripts for the local-LLM
-- CF-AOI assistant, separated per user. These are conversations, not curated knowledge — an answer
-- only reaches the SSoT corpus when a human presses 存進知識庫 (captureNote).
-- user_key comes from src/server/identity.ts ('ts:<login>' from the headers tailscale serve
-- injects, 'name:<label>' from the manual picker, or 'local'). Deliberately NOT a foreign key:
-- there is no users table and a tailnet login can disappear.
-- Weight sizes looked up from the HF API for the model catalog (src/local/catalog.ts). Recipes do
-- not declare sizes; the answer changes rarely, so a hit is good for a day and a miss for an hour.
CREATE TABLE IF NOT EXISTS local_catalog_cache (
  model      TEXT PRIMARY KEY,                -- HF repo id
  size_bytes INTEGER,                         -- NULL = lookup failed (offline / 404)
  gated      INTEGER NOT NULL DEFAULT 0,      -- needs an HF token to download
  checked_at TEXT NOT NULL
);

-- 終端機 audit: who opened a shell and when (src/terminal/sessions.ts). Never the keystrokes.
CREATE TABLE IF NOT EXISTS terminal_sessions (
  id         TEXT PRIMARY KEY,                    -- t_<nanoid(10)>
  user_key   TEXT NOT NULL,
  user_label TEXT,
  pid        INTEGER,
  shell      TEXT NOT NULL,
  preset     TEXT,                                -- joblog / vllmlog / … or NULL for a login shell
  cols       INTEGER,
  rows       INTEGER,
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  exit_code  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_terminal_sessions_user ON terminal_sessions(user_key, started_at);

CREATE TABLE IF NOT EXISTS chat_conversations (
  id           TEXT PRIMARY KEY,                 -- c_<nanoid(10)>
  user_key     TEXT NOT NULL,
  user_label   TEXT,
  title        TEXT NOT NULL DEFAULT '新對話',
  title_source TEXT NOT NULL DEFAULT 'auto',     -- auto (local model) | manual (renamed by hand)
  knowledge    INTEGER NOT NULL DEFAULT 1,       -- 引用 CF-AOI 知識庫 state this thread was started with
  thinking     INTEGER NOT NULL DEFAULT 0,
  model_id     TEXT,                             -- local_models.id serving when it started
  last_msg_at  TEXT,                             -- denormalised for the sidebar ORDER BY only
  invalid_at   TEXT,                             -- soft delete (same convention as knowledge_nodes)
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_user
  ON chat_conversations(user_key, invalid_at, last_msg_at DESC);

-- ord is monotone over ALL rows including soft-deleted ones: 重答 soft-deletes the tail and appends,
-- so scoping MAX(ord) to live rows would reuse an ord and scramble the replay order.
CREATE TABLE IF NOT EXISTS chat_messages (
  id              TEXT PRIMARY KEY,              -- m_<nanoid(10)>
  conversation_id TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  ord             INTEGER NOT NULL,
  role            TEXT NOT NULL,                 -- user | assistant
  content         TEXT NOT NULL DEFAULT '',
  reasoning       TEXT,                          -- 思考模式 transcript
  images_json     TEXT,                          -- [{file,name,bytes,mime}] — files on disk, never data URLs
  sources_json    TEXT,                          -- KnowledgeSource[] snapshot (snippets truncated)
  keywords_json   TEXT,                          -- the expandQuery keywords behind those sources
  finish_reason   TEXT,                          -- stop | length | abort | error
  ttft_ms         INTEGER,
  duration_ms     INTEGER,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  model_id        TEXT,
  invalid_at      TEXT,                          -- soft delete: superseded by 重答 / 編輯重問
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id, invalid_at, ord);

-- Trigram FTS over transcripts (Chinese — same rationale as knowledge_fts/chunks_fts). Unlike
-- chunks_fts this needs the AFTER UPDATE trigger too: a streaming answer is written empty and
-- UPDATEd on commit, and 繼續產生 rewrites it again.
CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
  content, content='chat_messages', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS chat_messages_ai AFTER INSERT ON chat_messages BEGIN
  INSERT INTO chat_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS chat_messages_ad AFTER DELETE ON chat_messages BEGIN
  INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS chat_messages_au AFTER UPDATE ON chat_messages BEGIN
  INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO chat_messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- PRD 精靈 drafts (src/prd/drafts.ts, web/prd.html): a half-written PRD, per user, so an engineer
-- can leave the five-step wizard and come back. form_json is the wizard state; markdown is what
-- the composer produced from it (or the hand-edited override). Submitting turns it into a task.
CREATE TABLE IF NOT EXISTS prd_drafts (
  id         TEXT PRIMARY KEY,                 -- d_<nanoid(10)>
  user_key   TEXT NOT NULL,                    -- src/server/identity.ts (same convention as chat)
  title      TEXT NOT NULL DEFAULT '未命名 PRD',
  form_json  TEXT NOT NULL,
  markdown   TEXT NOT NULL DEFAULT '',
  step       INTEGER NOT NULL DEFAULT 1,       -- highest wizard step reached (1..5)
  status     TEXT NOT NULL DEFAULT 'draft',    -- draft | submitted
  task_id    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prd_drafts_user ON prd_drafts(user_key, status, updated_at DESC);

-- Materialised cross-layer similarity edges for the brain graph view (src/knowledge/bridge.ts).
-- Derived data only: safe to delete at any time, rebuilt on the next request whose signature
-- does not match. Rows carry the signature they were built from, so a stale set never matches.
CREATE TABLE IF NOT EXISTS knowledge_bridge_edges (
  src       TEXT NOT NULL,
  dst       TEXT NOT NULL,
  relation  TEXT NOT NULL DEFAULT 'related',
  signature TEXT NOT NULL,
  built_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (src, dst)
);
CREATE INDEX IF NOT EXISTS idx_knowledge_bridge_signature ON knowledge_bridge_edges(signature);

-- GPU 執行沙盒 on other machines (src/exec/hosts.ts): each row is a Linux box the engine reaches
-- over SSH and drives with `docker -H ssh://…` — same container policy as the local sandbox. The
-- workspace is rsync'ed to <work_root>/<key> before each run; data_mounts are bind-mounted
-- read-only (e.g. the AOI image library). remote_uid/gid are learned by `loop exec check --host`.
CREATE TABLE IF NOT EXISTS exec_hosts (
  name        TEXT PRIMARY KEY,
  ssh_target  TEXT NOT NULL,            -- user@host, or an ~/.ssh/config alias
  ssh_port    INTEGER,                  -- NULL = 22 / whatever ssh config says
  work_root   TEXT NOT NULL,            -- remote dir that holds the synced workspaces
  image       TEXT,                     -- NULL = exec_image
  gpus        TEXT,                     -- NULL = exec_gpus ('' = no GPU)
  memory      TEXT,                     -- NULL = exec_memory
  cpus        TEXT,                     -- NULL = exec_cpus
  data_mounts TEXT NOT NULL DEFAULT '', -- CSV of /remote/src:/container/dst, always read-only
  description TEXT,                     -- told to the model: what this box is for / what data it has
  remote_uid  INTEGER,
  remote_gid  INTEGER,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 驗證方案 (src/plans/store.ts): a named, reusable answer to "how is a change to this software
-- proven good" — which machine, which commands, which image folder, which thresholds, what may not
-- be touched, what gets collected. Written once by an engineer; an operator only picks one on the
-- 新工作 page. A task copies the plan's fields when it is created (a later edit of the plan never
-- changes a task already queued), and keeps verify_plan_id for the record.
CREATE TABLE IF NOT EXISTS verify_plans (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  repo_path       TEXT,                       -- NULL = offered for every repo
  description     TEXT,                       -- what it checks, in plain words
  host            TEXT,                       -- NULL = the engine's shell (no sandbox); 'local' or an exec_hosts name = the 沙盒
  steps           TEXT NOT NULL DEFAULT '[]', -- JSON array of commands; {dataset} = the picked image folder
  dataset_root    TEXT,                       -- container path whose sub-folders are offered as 圖資
  dataset_default TEXT,                       -- the sub-folder preselected
  metrics         TEXT,                       -- thresholds, e.g. "detection_rate >= 0.98; miss == 0"
  protected_paths TEXT,                       -- CSV globs the implementer must not change
  artifacts       TEXT,                       -- CSV globs collected after verification
  manual_checks   TEXT NOT NULL DEFAULT '[]', -- JSON array: what a person checks by hand
  domain          TEXT NOT NULL DEFAULT 'other',
  setup_cmd       TEXT,                       -- runs before the agent starts (fail-fast)
  created_by      TEXT,
  updated_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 對話操作 (src/chatops/*): something the chat's local model PREPARED (a work item, a benchmark,
-- a task / benchmark / model / git action) that runs only once a person confirms it — typed in a
-- LATER turn of the same conversation, or with the card's button. params_json is exactly what will
-- run (template-completed by the engine); expect_json is the precondition fingerprint checked
-- again right before running. The permanent audit trail is task_events ("對話操作（label）：…").
CREATE TABLE IF NOT EXISTS ops_actions (
  id               TEXT PRIMARY KEY,                -- oa_<nanoid(10)>
  code             TEXT NOT NULL,                   -- e.g. 'K7Q' (unambiguous alphabet), shown on the card
  conversation_id  TEXT NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  user_key         TEXT NOT NULL,
  user_label       TEXT,
  kind             TEXT NOT NULL,                   -- work|benchmark|task|bench_op|model|git
  op               TEXT NOT NULL,                   -- submit|rerun|queue|approve|switch_model|pull|...
  target           TEXT,
  params_json      TEXT NOT NULL DEFAULT '{}',
  expect_json      TEXT,
  summary          TEXT NOT NULL,                   -- engine-written; card and model show it verbatim
  risk             TEXT NOT NULL DEFAULT 'normal',  -- normal|high (high: the confirming message must carry the code)
  speed            TEXT NOT NULL DEFAULT 'fast',    -- fast|slow|deferred
  draft_id         TEXT,
  md_sha           TEXT,                            -- work: sha256 of the checked markdown (skip re-review when unchanged)
  prepared_msg_id  TEXT NOT NULL,
  presented_msg_id TEXT NOT NULL,
  presented_ord    INTEGER NOT NULL,
  confirmed_msg_id TEXT,
  confirmed_by     TEXT,                            -- chat|button
  status           TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|failed|cancelled|superseded|expired|interrupted
  result_json      TEXT,
  error            TEXT,
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  started_at       TEXT,
  finished_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_ops_actions_conv ON ops_actions(conversation_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_ops_actions_status ON ops_actions(status);
