import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';

/**
 * check_runs: one row per execution of one check — a 試跑 from the editor, a baseline measurement,
 * every verify / re-verify step of a task run. The per-check history under task_runs.verify_json.
 * Writes never throw: a reporting failure must not fail a verification.
 */

export type CheckRunKind = 'trial' | 'baseline' | 'repro_before' | 'verify' | 'reverify' | 'red_green';

export interface CheckRun {
  id: string;
  check_id: string;
  task_id: string | null;
  run_id: string | null;
  kind: CheckRunKind;
  machine: string | null;
  head_sha: string | null;
  base_sha: string | null;
  /** null while it runs */
  ok: number | null;
  exit_code: number | null;
  timed_out: number;
  ms: number | null;
  output_tail: string | null;
  /** MetricsReport {values, checks[], pass} of this check alone (null = it reported nothing) */
  metrics_json: string | null;
  /** 圖資回歸: {cases[], metrics, …}; 紅→綠: {before, after, carried} */
  result_json: string | null;
  artifacts_json: string | null;
  started_at: string;
  finished_at: string | null;
}

export const OUTPUT_TAIL = 20_000;

export function newCheckRunId(): string {
  return `cr_${nanoid(10)}`;
}

export function beginCheckRun(
  db: Database.Database,
  r: { id: string; check_id: string; kind: CheckRunKind; task_id?: string | null; run_id?: string | null; machine?: string | null; head_sha?: string | null },
): boolean {
  try {
    db.prepare(
      `INSERT INTO check_runs (id, check_id, task_id, run_id, kind, machine, head_sha)
       VALUES (@id, @check_id, @task_id, @run_id, @kind, @machine, @head_sha)`,
    ).run({ task_id: null, run_id: null, machine: null, head_sha: null, ...r });
    return true;
  } catch {
    return false;
  }
}

const json = (v: unknown): string | null => (v === null || v === undefined ? null : JSON.stringify(v));

export function finishCheckRun(
  db: Database.Database,
  id: string,
  r: {
    ok: boolean;
    exit_code: number | null;
    timed_out: boolean;
    ms: number | null;
    output: string;
    metrics?: unknown;
    result?: unknown;
    artifacts?: unknown;
    head_sha?: string | null;
    base_sha?: string | null;
  },
): void {
  try {
    db.prepare(
      `UPDATE check_runs SET ok = @ok, exit_code = @exit_code, timed_out = @timed_out, ms = @ms, output_tail = @output_tail,
         metrics_json = @metrics_json, result_json = @result_json, artifacts_json = @artifacts_json,
         head_sha = COALESCE(@head_sha, head_sha), base_sha = COALESCE(@base_sha, base_sha), finished_at = datetime('now')
       WHERE id = @id`,
    ).run({
      id,
      ok: r.ok ? 1 : 0,
      exit_code: r.exit_code,
      timed_out: r.timed_out ? 1 : 0,
      ms: r.ms === null ? null : Math.round(r.ms),
      output_tail: r.output.slice(-OUTPUT_TAIL),
      metrics_json: json(r.metrics),
      result_json: json(r.result),
      artifacts_json: json(r.artifacts),
      head_sha: r.head_sha ?? null,
      base_sha: r.base_sha ?? null,
    });
  } catch {
    /* reporting only */
  }
}

export function getCheckRun(db: Database.Database, id: string): CheckRun | null {
  return (db.prepare('SELECT * FROM check_runs WHERE id = ?').get(id) as CheckRun | undefined) ?? null;
}

/** A check's recent runs, newest first. */
export function listCheckRuns(db: Database.Database, checkId: string, limit = 20): CheckRun[] {
  return db.prepare('SELECT * FROM check_runs WHERE check_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?').all(checkId, Math.max(1, Math.min(200, limit))) as CheckRun[];
}

/** The newest run of each of these checks (the 檢查 list's 「最近一次」). */
export function latestCheckRuns(db: Database.Database, checkIds: string[]): Map<string, CheckRun> {
  const out = new Map<string, CheckRun>();
  const q = db.prepare('SELECT * FROM check_runs WHERE check_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1');
  for (const id of checkIds) {
    const r = q.get(id) as CheckRun | undefined;
    if (r) out.set(id, r);
  }
  return out;
}

/** The checks one task run verified (the 結果 page's checks list). */
export function checkRunsForRun(db: Database.Database, runId: string): CheckRun[] {
  return db.prepare('SELECT * FROM check_runs WHERE run_id = ? ORDER BY started_at, rowid').all(runId) as CheckRun[];
}

/** A second verification of the same task run (after base was merged in, `loop verify`, 合併) is a re-verify. */
export function verifyKindFor(db: Database.Database, taskId: string, runId: string): 'verify' | 'reverify' {
  try {
    const seen = db.prepare("SELECT 1 FROM check_runs WHERE task_id = ? AND run_id = ? AND kind IN ('verify', 'reverify') LIMIT 1").get(taskId, runId);
    return seen ? 'reverify' : 'verify';
  } catch {
    return 'verify';
  }
}

/** metrics_json values of a finished run ({} when it reported none). */
export function runValues(r: Pick<CheckRun, 'metrics_json'>): Record<string, number | string> {
  if (!r.metrics_json) return {};
  try {
    const v = (JSON.parse(r.metrics_json) as { values?: Record<string, number | string> }).values;
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
