import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type Database from 'better-sqlite3';
import { paths } from '../config.js';
import { logEvent } from '../db/index.js';
import type { Task } from '../types.js';
import { setStatus, getTask } from '../tasks.js';
import {
  getEnvironment,
  recordDeployment,
  getDeployment,
  previousDeployed,
  type DeploymentRow,
  type EnvironmentRow,
} from '../deploy/store.js';
import { listNodes } from '../knowledge/store.js';
import { envScope } from '../knowledge/types.js';

/**
 * Injectable shell runner for `deploy_cmd` — mirrors the Adapter/JudgeExec test-injection
 * convention. Production call sites omit it and get `defaultDeployExec` (a real `bash -lc`
 * spawn); tests inject a fake so NO real deploy ever runs hermetically.
 */
export type DeployExec = (
  cmd: string,
  cwd: string,
  extraEnv?: Record<string, string>,
) => Promise<{ exitCode: number | null; tail: string }>;

function defaultDeployExec(
  cmd: string,
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number | null; tail: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', cmd], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    });
    let tail = '';
    const w = (d: Buffer) => {
      tail = (tail + d.toString('utf8')).slice(-1500);
    };
    child.stdout.on('data', w);
    child.stderr.on('data', w);
    const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, tail });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ exitCode: null, tail });
    });
  });
}

/** Local (no fetch) rev-parse — deploy targets whatever the repo already has for `ref`. */
function captureCommitSha(repoPath: string, ref: string): string | null {
  try {
    return execFileSync('git', ['-C', repoPath, 'rev-parse', ref], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** This environment's approved knowledge constraints (env:<name>), rendered for DEPLOY.md. */
function envConstraintsText(db: Database.Database, envName: string): string {
  const nodes = listNodes(db, { scope: envScope(envName), status: 'approved' });
  if (!nodes.length) return '(無相關知識)';
  return nodes.map((n) => `- [${n.kind}] ${n.title}${n.body ? `：${n.body}` : ''}`).join('\n');
}

function writeDeployPackage(db: Database.Database, task: Task, envName: string, sha: string | null): string {
  const dir = path.join(paths.outputsDir, `deploy-${task.id}`);
  fs.mkdirSync(dir, { recursive: true });
  const md = `# DEPLOY.md — ${task.title}

## 目標環境
${envName}

## 部署內容
- commit: ${sha ?? '(unknown)'}
- repo: ${task.repo_path ?? '-'}
- base: ${task.base_branch ?? '-'}

## 環境限制（來自知識庫 env:${envName}）
${envConstraintsText(db, envName)}

## 部署步驟（人工執行）
1. 於目標主機取得上述 commit（git fetch/checkout 或拉取部署包）。
2. 依環境限制調整指令（例如 Windows 路徑分隔／編碼）。
3. 執行部署，確認服務正常。
4. 回到 Loop board 按「結案」。
`;
  fs.writeFileSync(path.join(dir, 'DEPLOY.md'), md);
  return dir;
}

/**
 * Full lifecycle for a `coding_tool='deploy'` task: no agent dispatch, no worktree/verify —
 * resolve the target environment, capture what's being deployed, then either run
 * `deploy_cmd` (auto_deploy, e.g. home) or hand off a DEPLOY.md package + checklist for a
 * human to run at the target (e.g. company). Mirrors runPlanTask's shape in run.ts.
 */
export async function runDeployTask(db: Database.Database, task: Task, deployExec?: DeployExec): Promise<void> {
  setStatus(db, task.id, 'running', {});
  logEvent(db, { task_id: task.id, kind: 'dispatch', detail: 'tool=deploy' });

  const envName = task.environment;
  const env = envName ? getEnvironment(db, envName) : undefined;
  if (!envName || !env) {
    setStatus(db, task.id, 'attention', { detail: `deploy: unknown environment '${envName ?? ''}' — add it with 'loop env add'` });
    return;
  }
  if (!task.repo_path) {
    setStatus(db, task.id, 'attention', { detail: 'deploy: repo_path required (the source to deploy)' });
    return;
  }
  const sha = captureCommitSha(task.repo_path, task.base_branch || 'HEAD');

  if (env.auto_deploy && env.deploy_cmd) {
    const exec = deployExec ?? defaultDeployExec;
    const { exitCode, tail } = await exec(env.deploy_cmd, task.repo_path);
    if (exitCode === 0) {
      recordDeployment(db, { task_id: task.id, environment: envName, commit_sha: sha, status: 'deployed', detail: tail });
      setStatus(db, task.id, 'review', { detail: `已部署至 ${envName}（commit ${sha ?? '?'}）` });
    } else {
      recordDeployment(db, { task_id: task.id, environment: envName, commit_sha: sha, status: 'failed', detail: tail });
      setStatus(db, task.id, 'attention', { detail: `deploy_cmd failed (exit=${exitCode}): ${tail}` });
    }
    return;
  }

  // manual/prod: package + checklist, no shell run — human deploys at the target, then closes.
  const dir = writeDeployPackage(db, task, envName, sha);
  recordDeployment(db, { task_id: task.id, environment: envName, commit_sha: sha, status: 'manual-pending', detail: `package at ${dir}` });
  setStatus(db, task.id, 'review', { detail: `待人工部署 — 見 ${path.join(dir, 'DEPLOY.md')}` });
}

export interface RollbackOutcome {
  ok: boolean;
  error?: string;
  record?: DeploymentRow;
}

/** Best-effort: the repo path of a rollback's originating task, else the process cwd. */
function resolveRollbackCwd(db: Database.Database, dep: DeploymentRow): string {
  if (dep.task_id) {
    const t = getTask(db, dep.task_id);
    if (t?.repo_path) return t.repo_path;
  }
  return process.cwd();
}

function writeRollbackChecklist(env: EnvironmentRow, dep: DeploymentRow, prior: DeploymentRow): string {
  const dir = path.join(paths.outputsDir, `rollback-${env.name}-${dep.id}`);
  fs.mkdirSync(dir, { recursive: true });
  const md = `# ROLLBACK — ${env.name}

Rolling back deployment #${dep.id} (commit ${dep.commit_sha ?? '(unknown)'}).

## 回滾目標
- commit: ${prior.commit_sha ?? '(unknown)'}
- 原部署於: ${prior.created_at}

## 回滾步驟（人工執行）
1. 於目標主機 checkout 上述 commit。
2. 重新部署／重啟服務。
3. 確認回滾成功後，於 board 或 API 標記完成。
`;
  fs.writeFileSync(path.join(dir, 'ROLLBACK.md'), md);
  return dir;
}

/**
 * Roll a deployment back to the environment's previous 'deployed' commit. Creates a new
 * deployment record pointing at that prior sha (status='rolledback'); for an auto_deploy
 * environment, re-runs deploy_cmd (with LOOP_DEPLOY_SHA set, so the script itself can
 * checkout/pull that commit — Loop never touches the user's checkout directly, matching
 * the FF-only/no-mutation invariant); else emits a manual rollback checklist.
 */
export async function runRollback(
  db: Database.Database,
  deploymentId: number,
  deployExec?: DeployExec,
): Promise<RollbackOutcome> {
  const dep = getDeployment(db, deploymentId);
  if (!dep) return { ok: false, error: 'deployment not found' };
  const env = getEnvironment(db, dep.environment);
  if (!env) return { ok: false, error: `unknown environment: ${dep.environment}` };
  const prior = previousDeployed(db, dep.environment, dep.id);
  if (!prior) return { ok: false, error: 'no prior deployment to roll back to' };

  if (env.auto_deploy && env.deploy_cmd) {
    const exec = deployExec ?? defaultDeployExec;
    const cwd = resolveRollbackCwd(db, dep);
    const { exitCode, tail } = await exec(env.deploy_cmd, cwd, { LOOP_DEPLOY_SHA: prior.commit_sha ?? '' });
    const record = recordDeployment(db, {
      task_id: null,
      environment: dep.environment,
      commit_sha: prior.commit_sha,
      status: 'rolledback',
      detail: `rollback of #${dep.id} ${exitCode === 0 ? 'ok' : `failed (exit=${exitCode})`}: ${tail}`,
    });
    return { ok: exitCode === 0, record };
  }

  const dir = writeRollbackChecklist(env, dep, prior);
  const record = recordDeployment(db, {
    task_id: null,
    environment: dep.environment,
    commit_sha: prior.commit_sha,
    status: 'rolledback',
    detail: `manual rollback package at ${dir}`,
  });
  return { ok: true, record };
}
