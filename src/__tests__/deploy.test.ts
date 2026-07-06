import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { createTask, getTask, setStatus } from '../tasks.js';
import { runTask } from '../orchestrator/run.js';
import { runDeployTask, runRollback } from '../orchestrator/deployTask.js';
import { validateTask } from '../gate/validateTask.js';
import { paths } from '../config.js';
import { setCachedUsage } from '../token/usage.js';
import {
  upsertEnvironment,
  getEnvironment,
  listEnvironments,
  deleteEnvironment,
  environmentMap,
  recordDeployment,
  listDeployments,
  lastDeployed,
  previousDeployed,
} from '../deploy/store.js';

let db: Database.Database;
let tmpRoots: string[] = [];

beforeEach(() => {
  db = openTestDb();
  setCachedUsage(10, 10);
  tmpRoots = [];
});
afterEach(() => {
  db.close();
  delete process.env.MOCK_SLEEP_MS;
  for (const r of tmpRoots) fs.rmSync(r, { recursive: true, force: true });
});

function mkTmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `loop-deploy-${tag}-`));
  tmpRoots.push(d);
  return d;
}

/** A minimal real git repo with one commit on `main`, for repo_path/base_branch checks. */
function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'a@b.c']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'a']);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'init']);
}

// ---- 1. environments/deployments store CRUD + lastDeployed ----

describe('deploy/store: environments CRUD', () => {
  it('upserts, gets, lists, updates in place, and deletes', () => {
    const e = upsertEnvironment(db, {
      name: 'stage',
      kind: 'staging',
      host: 'vm1',
      capabilities: 'gpu',
      deploy_cmd: 'echo hi',
      auto_deploy: true,
    });
    expect(e.name).toBe('stage');
    expect(e.auto_deploy).toBe(1);
    expect(getEnvironment(db, 'stage')?.host).toBe('vm1');
    expect(listEnvironments(db).some((x) => x.name === 'stage')).toBe(true);

    // re-upsert by name updates the existing row rather than duplicating
    upsertEnvironment(db, { name: 'stage', kind: 'staging', capabilities: 'gpu,camera', auto_deploy: false });
    const updated = getEnvironment(db, 'stage')!;
    expect(updated.capabilities).toBe('gpu,camera');
    expect(updated.auto_deploy).toBe(0);
    expect(listEnvironments(db).filter((x) => x.name === 'stage')).toHaveLength(1);

    expect(deleteEnvironment(db, 'stage')).toBe(true);
    expect(getEnvironment(db, 'stage')).toBeUndefined();
  });

  it('seeds home (dev, auto_deploy) and company (prod, os:windows) on first run', () => {
    const home = getEnvironment(db, 'home')!;
    const company = getEnvironment(db, 'company')!;
    expect(home.kind).toBe('dev');
    expect(home.auto_deploy).toBe(1);
    expect(company.kind).toBe('prod');
    expect(company.capabilities).toBe('os:windows');
    expect(company.auto_deploy).toBe(0);
  });
});

describe('deploy/store: deployments record/list + lastDeployed/previousDeployed', () => {
  it('records deployments, lists newest-first, and finds the last/previous deployed row', () => {
    upsertEnvironment(db, { name: 'stage' });
    recordDeployment(db, { environment: 'stage', commit_sha: 'aaa', status: 'deployed' });
    recordDeployment(db, { environment: 'stage', commit_sha: 'bbb', status: 'failed' });
    const third = recordDeployment(db, { environment: 'stage', commit_sha: 'ccc', status: 'deployed' });

    const list = listDeployments(db, 'stage');
    expect(list).toHaveLength(3);
    expect(list[0].commit_sha).toBe('ccc'); // newest first

    expect(lastDeployed(db, 'stage')?.commit_sha).toBe('ccc');
    expect(previousDeployed(db, 'stage', third.id)?.commit_sha).toBe('aaa'); // skips the failed one
  });
});

// ---- 2. deploy task auto_deploy: injected deploy_cmd runner ----

describe('runDeployTask: auto_deploy environment', () => {
  it('exit 0 -> deployments deployed + commit_sha recorded, task -> review', async () => {
    const repo = mkTmpDir('repo-ok');
    initGitRepo(repo);
    upsertEnvironment(db, { name: 'auto-ok', deploy_cmd: 'true', auto_deploy: true });
    const t = createTask(db, {
      title: 'deploy ok',
      goal: 'g',
      coding_tool: 'deploy',
      environment: 'auto-ok',
      repo_path: repo,
      base_branch: 'main',
    });

    let called = 0;
    await runDeployTask(db, getTask(db, t.id)!, async () => {
      called++;
      return { exitCode: 0, tail: 'deployed ok' };
    });

    expect(called).toBe(1);
    const done = getTask(db, t.id)!;
    expect(done.status).toBe('review');
    const dep = lastDeployed(db, 'auto-ok');
    expect(dep?.status).toBe('deployed');
    expect(dep?.commit_sha).toBeTruthy();
    expect(dep?.commit_sha).toHaveLength(40); // a real git sha
  });

  it('non-zero exit -> deployments failed, task -> attention', async () => {
    const repo = mkTmpDir('repo-fail');
    initGitRepo(repo);
    upsertEnvironment(db, { name: 'auto-fail', deploy_cmd: 'false', auto_deploy: true });
    const t = createTask(db, {
      title: 'deploy fail',
      goal: 'g',
      coding_tool: 'deploy',
      environment: 'auto-fail',
      repo_path: repo,
      base_branch: 'main',
    });

    await runDeployTask(db, getTask(db, t.id)!, async () => ({ exitCode: 1, tail: 'boom' }));

    const done = getTask(db, t.id)!;
    expect(done.status).toBe('attention');
    const dep = listDeployments(db, 'auto-fail')[0];
    expect(dep.status).toBe('failed');
    expect(dep.detail).toContain('boom');
  });
});

// ---- 3. deploy task manual (auto_deploy=0) ----

describe('runDeployTask: manual environment (auto_deploy=0)', () => {
  it('writes DEPLOY.md, deployments manual-pending, task -> review, no shell run', async () => {
    const repo = mkTmpDir('repo-manual');
    initGitRepo(repo);
    upsertEnvironment(db, { name: 'company-like', deploy_cmd: null, auto_deploy: false, capabilities: 'os:windows' });
    const t = createTask(db, {
      title: 'deploy manual',
      goal: 'g',
      coding_tool: 'deploy',
      environment: 'company-like',
      repo_path: repo,
      base_branch: 'main',
    });

    let called = 0;
    await runDeployTask(db, getTask(db, t.id)!, async () => {
      called++;
      return { exitCode: 0, tail: '' };
    });

    expect(called).toBe(0); // no shell run for a manual environment
    const done = getTask(db, t.id)!;
    expect(done.status).toBe('review');
    const dep = listDeployments(db, 'company-like')[0];
    expect(dep.status).toBe('manual-pending');

    const deployMd = path.join(paths.outputsDir, `deploy-${t.id}`, 'DEPLOY.md');
    expect(fs.existsSync(deployMd)).toBe(true);
    expect(fs.readFileSync(deployMd, 'utf8')).toMatch(/company-like/);
  });
});

// ---- 4. environment capabilities feed the V2 unmet-capability check ----

describe('runVerifyPipeline: task.environment capabilities feed the unmet-capability check', () => {
  it('env=company (seeded: os:windows) on a host lacking it defers command verify to manual', async () => {
    process.env.MOCK_SLEEP_MS = '150';
    const t = createTask(db, {
      title: 'needs-windows',
      goal: 'g',
      coding_tool: 'mock',
      environment: 'company', // seeded capabilities: os:windows; host_capabilities setting default ''
      verification_steps: ['false'], // would fail if command verify actually ran
    });
    setStatus(db, t.id, 'queued');
    await runTask(db, getTask(db, t.id)!, {});
    const done = getTask(db, t.id)!;
    expect(done.status).toBe('review');
    expect(done.merge_status).toBe('pending');
  });
});

// ---- 5. rollback creates a record pointing at the prior sha ----

describe('runRollback', () => {
  it('auto_deploy environment: re-runs deploy_cmd against the prior sha, records rolledback', async () => {
    upsertEnvironment(db, { name: 'rb-auto', deploy_cmd: 'true', auto_deploy: true });
    recordDeployment(db, { environment: 'rb-auto', commit_sha: 'sha1', status: 'deployed' });
    const current = recordDeployment(db, { environment: 'rb-auto', commit_sha: 'sha2', status: 'deployed' });

    let capturedEnv: Record<string, string> | undefined;
    const result = await runRollback(db, current.id, async (_cmd, _cwd, extraEnv) => {
      capturedEnv = extraEnv;
      return { exitCode: 0, tail: 'ok' };
    });

    expect(result.ok).toBe(true);
    expect(result.record?.commit_sha).toBe('sha1');
    expect(result.record?.status).toBe('rolledback');
    expect(capturedEnv?.LOOP_DEPLOY_SHA).toBe('sha1');
  });

  it('manual environment: writes a rollback checklist, no shell run', async () => {
    upsertEnvironment(db, { name: 'rb-manual', deploy_cmd: null, auto_deploy: false });
    recordDeployment(db, { environment: 'rb-manual', commit_sha: 'shaA', status: 'deployed' });
    const current = recordDeployment(db, { environment: 'rb-manual', commit_sha: 'shaB', status: 'deployed' });

    let called = 0;
    const result = await runRollback(db, current.id, async () => {
      called++;
      return { exitCode: 0, tail: '' };
    });

    expect(called).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.record?.commit_sha).toBe('shaA');
    const dir = path.join(paths.outputsDir, `rollback-rb-manual-${current.id}`);
    expect(fs.existsSync(path.join(dir, 'ROLLBACK.md'))).toBe(true);
  });

  it('errors when there is no prior deployed row to roll back to', async () => {
    upsertEnvironment(db, { name: 'rb-empty' });
    const only = recordDeployment(db, { environment: 'rb-empty', commit_sha: 'x', status: 'deployed' });
    const result = await runRollback(db, only.id);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no prior deployment/);
  });
});

// ---- 6. gate: deploy task requires an existing environment ----

describe('gate: deploy task requires an existing environment', () => {
  it('no environment set -> missing', () => {
    const t = createTask(db, { title: 'd', goal: 'g', coding_tool: 'deploy', repo_path: '/tmp', base_branch: 'main' });
    const gate = validateTask(getTask(db, t.id)!, '', environmentMap(db));
    expect(gate.ok).toBe(false);
    expect(gate.missing.some((m) => m.startsWith('environment'))).toBe(true);
  });

  it('unknown environment name -> missing (unknown)', () => {
    const t = createTask(db, {
      title: 'd',
      goal: 'g',
      coding_tool: 'deploy',
      environment: 'does-not-exist',
      repo_path: '/tmp',
      base_branch: 'main',
    });
    const gate = validateTask(getTask(db, t.id)!, '', environmentMap(db));
    expect(gate.ok).toBe(false);
    expect(gate.missing.some((m) => m.includes('unknown'))).toBe(true);
  });

  it('known environment + valid repo/base -> gate passes (no verify_steps/plan_ref required)', () => {
    const repo = mkTmpDir('gate-repo');
    initGitRepo(repo);
    const t = createTask(db, {
      title: 'd',
      goal: 'g',
      coding_tool: 'deploy',
      environment: 'home', // seeded
      repo_path: repo,
      base_branch: 'main',
    });
    const gate = validateTask(getTask(db, t.id)!, '', environmentMap(db));
    expect(gate.ok).toBe(true);
  });
});
