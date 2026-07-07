import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths, ensureDirs, DEFAULT_SETTINGS } from '../config.js';
import { seedPipelines } from '../pipeline/store.js';
import { loadVec } from '../knowledge/vec.js';

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
  loadVec(db, getNum(db, 'embed_dim', 1024));

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
  loadVec(db, getNum(db, 'embed_dim', 1024));
  return db;
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
