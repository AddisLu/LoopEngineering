import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { currentRevision, hubDir, repoDir } from './weights.js';

/**
 * Two Sparks: the head downloads a model's weights; the other nodes need the same files before a
 * two-node recipe can start (vLLM runs with HF_HUB_OFFLINE=1, and a node without them never joins —
 * the head then waits 10 minutes and the machine ends up serving nothing). The worker addresses come
 * from the vLLM repo's .env (CLUSTER_NODES, what launch-cluster.sh reads), minus this host.
 */

export type ClusterExec = (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; out: string }>;

export const realClusterExec: ClusterExec = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const raw = err ? (err as { code?: number | string }).code : 0;
      resolve({ code: typeof raw === 'number' ? raw : err ? 1 : 0, out: `${stdout ?? ''}${stderr ?? ''}` });
    });
  });

function localAddresses(): Set<string> {
  const out = new Set<string>(['127.0.0.1', 'localhost', os.hostname()]);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) out.add(a.address);
  return out;
}

/** CLUSTER_NODES from <vllm repo>/.env, without this host's own addresses. */
export function clusterWorkers(vllmRepo: string, local: Set<string> = localAddresses()): string[] {
  let text = '';
  try {
    text = fs.readFileSync(path.join(vllmRepo, '.env'), 'utf8');
  } catch {
    return [];
  }
  const m = /^\s*CLUSTER_NODES\s*=\s*["']?([^"'\n]+)["']?/m.exec(text);
  if (!m) return [];
  return m[1]!
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !local.has(s));
}

/** How many weight files the served revision has here (links followed). */
export function localWeightCount(servedId: string, dir = hubDir()): number {
  const repo = repoDir(servedId, dir);
  const rev = currentRevision(repo);
  if (!rev) return 0;
  const snap = path.join(repo, 'snapshots', rev);
  let n = 0;
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(safetensors|bin|gguf|pt|pth)$/i.test(e.name)) {
        try {
          if (fs.statSync(p).isFile()) n += 1; // follows the link: a dangling one does not count
        } catch {
          /* dangling */
        }
      }
    }
  };
  try {
    walk(snap);
  } catch {
    return 0;
  }
  return n;
}

export interface WorkerWeights {
  worker: string;
  ok: boolean;
  /** weight files found there vs here */
  have: number | null;
  want: number;
  reason?: string;
}

/** Does every worker have the same weight files as this host? One ssh `find -L` per worker. */
export async function workerWeights(servedId: string, workers: string[], exec: ClusterExec = realClusterExec, dir = hubDir()): Promise<WorkerWeights[]> {
  const want = localWeightCount(servedId, dir);
  const repo = repoDir(servedId, dir);
  const rev = currentRevision(repo);
  const rel = `.cache/huggingface/hub/${path.basename(repo)}/snapshots/${rev ?? 'none'}`;
  const out: WorkerWeights[] = [];
  for (const w of workers) {
    const r = await exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', w, `find -L ${rel} -type f \\( -name '*.safetensors' -o -name '*.bin' -o -name '*.gguf' -o -name '*.pt' -o -name '*.pth' \\) 2>/dev/null | wc -l`], 30_000);
    if (r.code === 255 || r.code === null) {
      out.push({ worker: w, ok: false, have: null, want, reason: `連不上 ${w}` });
      continue;
    }
    const have = Number(r.out.trim().split('\n').pop());
    const n = Number.isFinite(have) ? have : 0;
    out.push({ worker: w, ok: want > 0 && n >= want, have: n, want, reason: n >= want ? undefined : `${w} 只有 ${n}/${want} 個權重檔` });
  }
  return out;
}
