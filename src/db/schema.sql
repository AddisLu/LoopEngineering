-- Loop Engineering schema. Applied idempotently at startup (see index.ts).
-- SQLite with WAL. Single-user, single-host.

CREATE TABLE IF NOT EXISTS tasks (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  goal           TEXT NOT NULL,

  -- intake gate fields
  plan_ref       TEXT,                       -- md/html path or URL
  plan_kind      TEXT,                        -- md | html | url
  coding_tool    TEXT NOT NULL DEFAULT 'claude-code', -- claude-code | mock
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

  -- lifecycle
  status         TEXT NOT NULL DEFAULT 'draft',
    -- draft|ready|queued|running|verifying|blocked|review|failed|closed
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
  interrupted_by TEXT,                          -- breaker | timeout | user | orphaned | NULL

  usage_json     TEXT,                          -- result-event usage (debug/future)
  session_pct_before REAL,
  session_pct_after  REAL,
  weekly_pct_before  REAL,                       -- Phase 3 #2: weekly budget packing/calibration
  weekly_pct_after   REAL,
  dispatch_window    TEXT,                        -- Phase 3 #1: 'day' | 'night' at dispatch time

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
