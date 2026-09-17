import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, getSetting } from '../db/index.js';
import { LocalJobRunner, JobBusyError, splitLogLines, explainFailure, scopedCommand, type JobHandle } from '../local/jobs.js';
import { getLocalModel } from '../local/models.js';

let db: Database.Database;
let launched: Array<{ cmd: string; args: string[]; cwd: string; logPath: string }> = [];
let exitCbs: Array<(code: number | null) => void> = [];
let killed: Array<[number, string]> = [];
let alivePids = new Set<number>();
let complete = new Set<string>();
let images = new Set<string>();
let logText = '';
let bytes = 0;
let t = Date.parse('2026-09-17T08:00:00Z');

function runner(): LocalJobRunner {
  return new LocalJobRunner(db, {
    launch: (cmd, args, cwd, logPath): JobHandle => {
      launched.push({ cmd, args, cwd, logPath });
      return { pid: 4242, onExit: (cb) => exitCbs.push(cb) };
    },
    kill: (pid, sig) => killed.push([pid, sig]),
    alive: (pid) => alivePids.has(pid),
    now: () => t,
    weightsBytes: () => bytes,
    weightsComplete: (m) => complete.has(m),
    imageExists: (img) => images.has(img),
    readTail: () => logText,
  });
}
const entry = { model: 'nvidia/Qwen3.6-35B-A3B-NVFP4', container: 'vllm-node', size_bytes: 24e9, repo: '/spark' };

beforeEach(() => {
  db = openTestDb();
  launched = [];
  exitCbs = [];
  killed = [];
  alivePids = new Set([4242]);
  complete = new Set();
  images = new Set();
  logText = '';
  bytes = 0;
});
afterEach(() => db.close());

describe('log helpers', () => {
  it('keeps only the last frame of a \\r progress bar and masks tokens', () => {
    expect(splitLogLines('Fetching 3 files: 10%\r 40%\r 90%\nhf_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 leaked\n\n')).toEqual(['90%', 'hf_*** leaked']);
  });
  it('turns a 401 into the gated sentence, otherwise the last line', () => {
    expect(explainFailure('download', ['x', '401 Client Error: Unauthorized'])).toContain('HF token');
    expect(explainFailure('download', ['OSError: No space left on device'])).toBe('磁碟空間不足');
    expect(explainFailure('build', ['docker: pull failed', 'exit 1'])).toBe('exit 1');
    expect(explainFailure('build', [])).toContain('建置失敗');
  });
});

describe('scopedCommand', () => {
  it('wraps the job in a transient user scope so a service restart cannot kill it', () => {
    // the first real build died this way: systemctl restart kills the service cgroup, detached or not
    expect(scopedCommand('uvx', ['hf', 'download', 'o/m'], 'loop-local-x', { XDG_RUNTIME_DIR: '/run/user/1000' }, () => true)).toEqual({
      cmd: 'systemd-run',
      args: ['--user', '--scope', '--quiet', '--collect', '--unit=loop-local-x', '--', 'uvx', 'hf', 'download', 'o/m'],
    });
    // no user manager (a plain shell without a session, a container): run it directly
    expect(scopedCommand('uvx', ['x'], 'u', {}, () => true)).toEqual({ cmd: 'uvx', args: ['x'] });
    expect(scopedCommand('uvx', ['x'], 'u', { XDG_RUNTIME_DIR: '/run/user/1000' }, () => false)).toEqual({ cmd: 'uvx', args: ['x'] });
  });
});

describe('LocalJobRunner', () => {
  it('download runs `uvx hf download <model>` (resumable) and registers the recipe when it completes', () => {
    const r = runner();
    const job = r.start('download', 'qwen3.6-35b-a3b-nvfp4', entry);
    expect(job).toMatchObject({ kind: 'download', status: 'running', pid: 4242, size_bytes: 24e9 });
    expect(launched[0]).toMatchObject({ cmd: 'uvx', args: ['hf', 'download', entry.model], cwd: '/spark' });
    expect(launched[0]!.logPath).toMatch(/local-download-qwen3\.6-35b-a3b-nvfp4-\d+\.log$/);
    // persisted, so a restart can find it
    expect(JSON.parse(getSetting(db, 'local_job_json')!)).toMatchObject({ id: job.id, status: 'running' });

    bytes = 12e9;
    logText = 'Fetching 9 files:  50%\r 55%\n';
    expect(r.current()).toMatchObject({ bytes_now: 12e9, last_line: '55%' });

    complete.add(entry.model);
    exitCbs[0]!(0);
    expect(r.current()).toMatchObject({ status: 'done', exit_code: 0, error: null });
    expect(getLocalModel(db, 'qwen36-35b')).toBeTruthy(); // the seed row for this recipe
  });

  it('exit 0 without complete weights is an error, non-zero explains from the log', () => {
    const r = runner();
    r.start('download', 'x', entry);
    exitCbs[0]!(0);
    expect(r.current()).toMatchObject({ status: 'error' });
    expect(r.current()!.error).toContain('不完整');

    const r2 = runner(); // adopts the finished record; a new job can start
    r2.start('download', 'gemma', { ...entry, model: 'google/gemma-4' });
    logText = 'huggingface_hub.errors.GatedRepoError: 401 Client Error\n';
    exitCbs[1]!(1);
    expect(r2.current()).toMatchObject({ status: 'error', exit_code: 1 });
    expect(r2.current()!.error).toContain('gated');
  });

  it('build runs run-recipe.sh --solo --build-only and only one job runs at a time', () => {
    const r = runner();
    r.start('build', 'qwen3-coder-next-int4-autoround', entry);
    expect(launched[0]).toMatchObject({ cmd: 'bash', args: ['/spark/run-recipe.sh', 'qwen3-coder-next-int4-autoround', '--solo', '--build-only'] });
    expect(() => r.start('download', 'y', entry)).toThrow(JobBusyError);
    exitCbs[0]!(0);
    expect(r.current()!.status).toBe('done');
    expect(() => r.start('download', 'y', entry)).not.toThrow();
  });

  it('cancel signals the whole process group and leaves the record resumable', () => {
    const r = runner();
    r.start('download', 'x', entry);
    const j = r.cancel();
    expect(killed).toEqual([[-4242, 'SIGTERM']]);
    expect(j).toMatchObject({ status: 'cancelled' });
    expect(j!.error).toContain('續傳');
    exitCbs[0]!(null); // the late exit event must not flip the status
    expect(r.current()!.status).toBe('cancelled');
    expect(r.cancel()).toBeNull();
  });

  it('after a restart: a live pid is kept, a dead one is settled from disk', () => {
    runner().start('download', 'x', entry);

    // engine restarts, child still pulling
    let r = runner();
    expect(r.current()!.status).toBe('running');

    // child finished while we were down and the weights are complete -> done
    alivePids.clear();
    complete.add(entry.model);
    r = runner();
    expect(r.current()).toMatchObject({ status: 'done' });

    // …or it died halfway -> unknown, with the resume hint
    complete.clear();
    r.start('download', 'x', entry);
    alivePids.clear();
    r = runner();
    expect(r.current()).toMatchObject({ status: 'unknown' });
    expect(r.current()!.error).toContain('續傳');

    // an adopted-but-live job whose pid later disappears is settled by current(), not left running forever
    alivePids.add(4242);
    r.start('build', 'b', entry);
    r = runner();
    alivePids.clear();
    images.add('vllm-node');
    expect(r.current()).toMatchObject({ status: 'done', kind: 'build' });
  });

  it('tail clamps to 1..200 lines', () => {
    const r = runner();
    r.start('build', 'b', entry);
    logText = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    expect(r.tail(0)).toEqual(['line 299']);
    expect(r.tail(1000)).toHaveLength(200);
    expect(r.tail(2)).toEqual(['line 298', 'line 299']);
  });
});
