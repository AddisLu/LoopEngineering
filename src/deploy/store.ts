import type Database from 'better-sqlite3';

export interface EnvironmentRow {
  name: string;
  kind: string;
  host: string | null;
  capabilities: string;
  deploy_cmd: string | null;
  auto_deploy: number;
  created_at: string;
}

export interface UpsertEnvironmentInput {
  name: string;
  kind?: string;
  host?: string | null;
  capabilities?: string;
  deploy_cmd?: string | null;
  auto_deploy?: boolean;
}

export function upsertEnvironment(db: Database.Database, input: UpsertEnvironmentInput): EnvironmentRow {
  db.prepare(
    `INSERT INTO environments (name, kind, host, capabilities, deploy_cmd, auto_deploy)
     VALUES (@name, @kind, @host, @capabilities, @deploy_cmd, @auto_deploy)
     ON CONFLICT(name) DO UPDATE SET
       kind = excluded.kind, host = excluded.host, capabilities = excluded.capabilities,
       deploy_cmd = excluded.deploy_cmd, auto_deploy = excluded.auto_deploy`,
  ).run({
    name: input.name,
    kind: input.kind ?? 'dev',
    host: input.host ?? null,
    capabilities: input.capabilities ?? '',
    deploy_cmd: input.deploy_cmd ?? null,
    auto_deploy: input.auto_deploy ? 1 : 0,
  });
  return getEnvironment(db, input.name)!;
}

export function getEnvironment(db: Database.Database, name: string): EnvironmentRow | undefined {
  return db.prepare('SELECT * FROM environments WHERE name = ?').get(name) as EnvironmentRow | undefined;
}

export function listEnvironments(db: Database.Database): EnvironmentRow[] {
  return db.prepare('SELECT * FROM environments ORDER BY name ASC').all() as EnvironmentRow[];
}

/** name -> row, for cheap existence/capability lookups (gate, verify pipeline). */
export function environmentMap(db: Database.Database): Map<string, EnvironmentRow> {
  return new Map(listEnvironments(db).map((e) => [e.name, e]));
}

export function deleteEnvironment(db: Database.Database, name: string): boolean {
  return db.prepare('DELETE FROM environments WHERE name = ?').run(name).changes > 0;
}

export interface DeploymentRow {
  id: number;
  task_id: string | null;
  environment: string;
  commit_sha: string | null;
  status: string;
  detail: string | null;
  created_at: string;
}

export interface RecordDeploymentInput {
  task_id?: string | null;
  environment: string;
  commit_sha?: string | null;
  status: string;
  detail?: string | null;
}

export function recordDeployment(db: Database.Database, input: RecordDeploymentInput): DeploymentRow {
  const info = db
    .prepare(
      `INSERT INTO deployments (task_id, environment, commit_sha, status, detail)
       VALUES (@task_id, @environment, @commit_sha, @status, @detail)`,
    )
    .run({
      task_id: input.task_id ?? null,
      environment: input.environment,
      commit_sha: input.commit_sha ?? null,
      status: input.status,
      detail: input.detail ?? null,
    });
  return getDeployment(db, Number(info.lastInsertRowid))!;
}

export function getDeployment(db: Database.Database, id: number): DeploymentRow | undefined {
  return db.prepare('SELECT * FROM deployments WHERE id = ?').get(id) as DeploymentRow | undefined;
}

/** Newest first. Filters to one environment when given. */
export function listDeployments(db: Database.Database, environment?: string): DeploymentRow[] {
  if (environment) {
    return db
      .prepare('SELECT * FROM deployments WHERE environment = ? ORDER BY id DESC')
      .all(environment) as DeploymentRow[];
  }
  return db.prepare('SELECT * FROM deployments ORDER BY id DESC').all() as DeploymentRow[];
}

/** Most recent deployment row created BY a given task (any status) — for the board chip. */
export function latestDeploymentForTask(db: Database.Database, taskId: string): DeploymentRow | undefined {
  return db
    .prepare('SELECT * FROM deployments WHERE task_id = ? ORDER BY id DESC LIMIT 1')
    .get(taskId) as DeploymentRow | undefined;
}

/** Most recent successful ('deployed') row for an environment — the "current" deploy. */
export function lastDeployed(db: Database.Database, environment: string): DeploymentRow | undefined {
  return db
    .prepare(`SELECT * FROM deployments WHERE environment = ? AND status = 'deployed' ORDER BY id DESC LIMIT 1`)
    .get(environment) as DeploymentRow | undefined;
}

/** Most recent 'deployed' row for an environment strictly before `beforeId` — the rollback target. */
export function previousDeployed(db: Database.Database, environment: string, beforeId: number): DeploymentRow | undefined {
  return db
    .prepare(
      `SELECT * FROM deployments WHERE environment = ? AND status = 'deployed' AND id < ? ORDER BY id DESC LIMIT 1`,
    )
    .get(environment, beforeId) as DeploymentRow | undefined;
}
