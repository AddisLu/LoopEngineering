import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, ensureDirs, DEFAULT_SETTINGS } from '../config.js';
import { seedPipelines } from '../pipeline/store.js';
import { seedReportTemplates } from '../report/templates.js';
import { loadVec } from '../knowledge/vec.js';
import { seedLocalModels } from '../local/models.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db: Database.Database | null = null;

export function getDb(dbPath: string = paths.db): Database.Database {
  if (_db) return _db;
  ensureDirs();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrate(db);
  seedSettings(db);
  seedEnvironments(db);
  seedPipelines(db);
  seedReportTemplates(db);
  seedLocalModels(db);
  loadVec(db, getNum(db, 'embed_dim', 1024));
  backfillChunksFts(db);
  backfillChatMessagesFts(db);

  _db = db;
  return db;
}

/** For tests: open an isolated in-memory (or temp) DB, not the singleton. */
export function openTestDb(): Database.Database {
  ensureDirs(); // logs/worktrees dirs needed by the orchestrator
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migrate(db);
  seedSettings(db);
  seedEnvironments(db);
  seedPipelines(db);
  seedReportTemplates(db);
  seedLocalModels(db);
  loadVec(db, getNum(db, 'embed_dim', 1024));
  backfillChunksFts(db);
  backfillChatMessagesFts(db);
  return db;
}

/**
 * chunks_fts is an external-content FTS5 table (see schema.sql) — it starts empty even
 * when the backing `chunks` table already has rows (a DB created before this table
 * existed). One-time idempotent rebuild: only runs when the index is empty but chunks
 * has data, so a normally-synced DB (triggers keep it current) pays nothing on startup.
 */
/** Same one-time rebuild for chat_messages_fts on a DB that already holds conversations. */
function backfillChatMessagesFts(db: Database.Database): void {
  try {
    const indexed = (db.prepare(`SELECT count(*) AS n FROM chat_messages_fts`).get() as { n: number }).n;
    if (indexed > 0) return;
    const rows = (db.prepare(`SELECT count(*) AS n FROM chat_messages`).get() as { n: number }).n;
    if (rows > 0) db.exec(`INSERT INTO chat_messages_fts(chat_messages_fts) VALUES ('rebuild')`);
  } catch {
    /* FTS5 unavailable — search degrades to LIKE, see src/chat/store.ts */
  }
}

function backfillChunksFts(db: Database.Database): void {
  const ftsCount = (db.prepare(`SELECT count(*) AS n FROM chunks_fts`).get() as { n: number }).n;
  if (ftsCount > 0) return;
  const chunkCount = (db.prepare(`SELECT count(*) AS n FROM chunks`).get() as { n: number }).n;
  if (chunkCount > 0) db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')`);
}

/**
 * Idempotent column migrations for DBs created before a `schema.sql` change.
 * `CREATE TABLE IF NOT EXISTS` never adds columns to an existing table, so new
 * columns are added here (guarded by PRAGMA table_info). Safe to run every startup.
 */
function migrate(db: Database.Database): void {
  const cols = (table: string): Set<string> =>
    new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
    );
  const add = (table: string, defs: [string, string][]): void => {
    const have = cols(table);
    for (const [name, ddl] of defs) {
      if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
    }
  };
  // Phase 3: weekly-budget packing (#2) + day/night window checkpoint (#1)
  add('task_runs', [
    ['weekly_pct_before', 'REAL'],
    ['weekly_pct_after', 'REAL'],
    ['dispatch_window', 'TEXT'],
  ]);
  // serial task chains: hold a task until the task it depends on is closed
  add('tasks', [['depends_on', 'TEXT']]);
  // Git close-out: merge outcome + merge-conflict resolution task lineage
  add('tasks', [
    ['merge_status', 'TEXT'],
    ['parent_task_id', 'TEXT'],
  ]);
  // knowledge base: optional environment label a task's knowledge should be scoped to
  add('tasks', [['environment', 'TEXT']]);
  // layered verification: modes (command/llm/manual) + rubric + per-task timeout override
  add('tasks', [
    ["verify_mode", "TEXT NOT NULL DEFAULT 'command'"],
    ['verify_rubric', 'TEXT'],
    ['verify_timeout_min', 'INTEGER'],
  ]);
  // hardware/environment awareness: capability tokens a task requires (see capabilities.ts)
  add('tasks', [['requires', 'TEXT']]);
  // team-prep: nullable, unused passthrough reserving the multi-user path (no reads/writes
  // beyond createTask/getTask) — zero behavior change until a future task wires them up.
  add('tasks', [
    ['owner', 'TEXT'],
    ['created_by', 'TEXT'],
  ]);
  // epic decomposition: the epic task's id on each child materialized by the planner
  // (src/orchestrator/planner.ts). Nullable; distinct from depends_on/parent_task_id.
  add('tasks', [['parent_id', 'TEXT']]);
  // execution-discipline A/B: which side of prompt_discipline a run was dispatched under.
  add('task_runs', [['discipline', 'INTEGER']]);
  // SDD Phase 4: resolved model at dispatch, so estimatePct can key cost on (complexity, model)
  // — see src/token/accounting.ts. Nullable; pre-migration rows only feed the legacy no-model query.
  add('task_runs', [['model', 'TEXT']]);
  // delivery pipeline templates: which pipeline instance + stage this task materializes
  // from (see src/pipeline/materialize.ts). Nullable; distinct from parent_id/depends_on.
  add('tasks', [
    ['pipeline_id', 'TEXT'],
    ['stage_name', 'TEXT'],
  ]);
  // ADO/GitHub integration bridge: which work item this task was imported from (see
  // src/integrations/import.ts) — nullable, drives idempotent re-import + pushback.
  add('tasks', [['source_ref', 'TEXT']]);
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_source_ref ON tasks(source_ref)');
  // SDD Phase 1: A/B experiment cohort label (see src/server/metrics.ts experiment_ab).
  // Nullable, write-only from intake, never read by scheduler/gate — pure measurement tag.
  add('tasks', [['experiment', 'TEXT']]);
  // auto-relate (see src/knowledge/relate.ts): edges get a review state just like nodes —
  // existing rows default to 'approved' (unaffected), LLM-suggested edges land as 'draft'.
  add('knowledge_edges', [["status", "TEXT NOT NULL DEFAULT 'approved'"]]);
  // 本地模型: per-run token counts parsed from the adapter stream (opencode step_finish sums /
  // claude result.usage) + which adapter actually ran it ('claude-code' | 'opencode' | 'mock').
  add('task_runs', [
    ['tokens_in', 'INTEGER'],
    ['tokens_out', 'INTEGER'],
    ['backend', 'TEXT'],
  ]);
  // benchmark mode (src/benchmark/*.ts): which benchmark this task is an arm of. Nullable.
  add('tasks', [['benchmark_id', 'TEXT']]);
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_benchmark ON tasks(benchmark_id)');
  // 模型對話 actions: what a single answer turned into. escalated_from points at the local answer
  // a cloud review was asked about; captured_path / task_id make 存進知識庫 and 轉成任務 idempotent.
  add('chat_messages', [
    ['escalated_from', 'TEXT'],
    ['captured_path', 'TEXT'],
    ['task_id', 'TEXT'],
  ]);
  // 上網／工具: the tool rounds (name, args, outcome, source URLs) behind an answer
  add('chat_messages', [['tools_json', 'TEXT']]);
  // 轉成任務 → PRD 精靈: the wizard draft an answer became (task_id follows once it is submitted)
  add('chat_messages', [['draft_id', 'TEXT']]);
  // 分享連結: an unguessable token makes one conversation readable without a login. Partial index
  // so the many NULLs (every unshared conversation) do not collide.
  add('chat_conversations', [
    ['share_token', 'TEXT'],
    ['shared_at', 'TEXT'],
  ]);
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_conversations_share ON chat_conversations(share_token) WHERE share_token IS NOT NULL',
  );
}

function seedSettings(db: Database.Database): void {
  const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insert.run(k, v);
  });
  tx();
}

/**
 * First-run seed for the two environments this engine's own deploy workflow targets
 * (在家開發帶去公司部署): home = dev, auto-deploys; company = prod, manual gate (no
 * deploy_cmd). INSERT OR IGNORE so a user's own edits (via `loop env add`/API) are
 * never overwritten on a later startup.
 */
function seedEnvironments(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO environments (name, kind, host, capabilities, deploy_cmd, auto_deploy)
     VALUES (@name, @kind, @host, @capabilities, @deploy_cmd, @auto_deploy)`,
  );
  const tx = db.transaction(() => {
    insert.run({ name: 'home', kind: 'dev', host: 'linux-rtx2080', capabilities: 'gpu', deploy_cmd: null, auto_deploy: 1 });
    insert.run({ name: 'company', kind: 'prod', host: 'windows-11', capabilities: 'os:windows', deploy_cmd: null, auto_deploy: 0 });
  });
  tx();
}

// ---- settings helpers ----

export function getSetting(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function getNum(db: Database.Database, key: string, fallback: number): number {
  const v = getSetting(db, key);
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function getBool(db: Database.Database, key: string, fallback = false): boolean {
  const v = getSetting(db, key);
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}

// ---- event log helper ----

export function logEvent(
  db: Database.Database,
  e: {
    task_id?: string | null;
    run_id?: string | null;
    kind: string;
    from_status?: string | null;
    to_status?: string | null;
    detail?: string | null;
    session_pct?: number | null;
    weekly_pct?: number | null;
  },
): void {
  db.prepare(
    `INSERT INTO task_events (task_id, run_id, kind, from_status, to_status, detail, session_pct, weekly_pct)
     VALUES (@task_id, @run_id, @kind, @from_status, @to_status, @detail, @session_pct, @weekly_pct)`,
  ).run({
    task_id: e.task_id ?? null,
    run_id: e.run_id ?? null,
    kind: e.kind,
    from_status: e.from_status ?? null,
    to_status: e.to_status ?? null,
    detail: e.detail ?? null,
    session_pct: e.session_pct ?? null,
    weekly_pct: e.weekly_pct ?? null,
  });
}
