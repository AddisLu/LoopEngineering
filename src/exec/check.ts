import fs from 'node:fs';
import path from 'node:path';
import { runSandbox, settingsForHost, type SandboxDeps, type SandboxRequest, type SandboxResult, type SandboxSettings } from './sandbox.js';
import { ensureWorkspace } from './workspace.js';
import { dockerHostUrl, parseDataMounts, realHostExec, sshArgs, type ExecHost, type HostExec } from './hosts.js';

/**
 * `loop exec check`: is this machine ready for the GPU 執行沙盒? Docker reachable, image present,
 * GPU visible inside the container, nvcc / ncu available, the container really has no network,
 * /work writable — and with --profile, whether Nsight Compute may read GPU counters.
 */

export interface CheckLine {
  /** true = fine, false = broken, null = worth knowing (e.g. no ncu in the image) */
  ok: boolean | null;
  label: string;
  detail: string;
}

export type { HostExec };

export interface CheckDeps {
  host?: HostExec;
  run?: (s: SandboxSettings, req: SandboxRequest, deps?: SandboxDeps) => Promise<SandboxResult>;
}

export interface CheckOptions {
  profile?: boolean;
  /** check this registered machine instead of the local one */
  remote?: ExecHost;
  /** called with the remote account's ids once ssh works (the CLI stores them on the host row) */
  onRemoteIds?: (uid: number, gid: number) => void;
}

/** Everything the probe container prints, one marked section per question. */
export function probeCommand(dataTargets: string[] = []): string {
  const parts = [
    'echo "== gpu"; (nvidia-smi -L 2>&1 || echo "nvidia-smi: unavailable") | head -8',
    'echo "== nvcc"; (command -v nvcc >/dev/null && nvcc --version 2>&1 | tail -1) || echo "nvcc: not found"',
    'echo "== ncu"; (command -v ncu >/dev/null && ncu --version 2>&1 | tail -1) || echo "ncu: not found"',
    'echo "== net"; (getent hosts example.com >/dev/null 2>&1 && echo "net: reachable") || echo "net: none"',
    'echo "== work"; (touch /work/.loop-exec-probe && rm -f /work/.loop-exec-probe && echo "work: writable") || echo "work: read-only"',
  ];
  if (dataTargets.length) {
    // every data mount must be readable and must refuse writes
    const probes = dataTargets.map((t) => `(test -r ${t} && ((touch ${t}/.loop-exec-probe 2>/dev/null && rm -f ${t}/.loop-exec-probe && echo "rw ${t}") || echo "ro ${t}")) || echo "missing ${t}"`);
    parts.push(`echo "== data"; ${probes.join('; ')}`);
  }
  return parts.join('; ');
}
export const PROBE_COMMAND = probeCommand();

/** Split the probe's output into its `== name` sections. */
export function parseProbe(output: string): Record<string, string> {
  const out: Record<string, string> = {};
  let cur: string | null = null;
  for (const line of output.split('\n')) {
    const m = /^== (\w+)\s*$/.exec(line.trim());
    if (m) {
      cur = m[1]!;
      out[cur] = '';
      continue;
    }
    if (cur) out[cur] = `${out[cur]}${out[cur] ? '\n' : ''}${line}`.trim();
  }
  return out;
}

export const PROFILE_PROBE_CU = `#include <cstdio>
__global__ void add(const float* a, const float* b, float* c, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) c[i] = a[i] + b[i];
}
int main() {
  const int n = 1 << 20;
  float *a, *b, *c;
  cudaMallocManaged(&a, n * sizeof(float));
  cudaMallocManaged(&b, n * sizeof(float));
  cudaMallocManaged(&c, n * sizeof(float));
  for (int i = 0; i < n; i++) { a[i] = 1.0f; b[i] = 2.0f; }
  add<<<(n + 255) / 256, 256>>>(a, b, c, n);
  cudaDeviceSynchronize();
  int bad = 0;
  for (int i = 0; i < n; i++) if (c[i] != 3.0f) bad++;
  printf("mismatches=%d\\n", bad);
  return bad ? 1 : 0;
}
`;

export async function checkSandbox(
  s0: SandboxSettings,
  workDir: string,
  opts: CheckOptions = {},
  deps: CheckDeps = {},
): Promise<CheckLine[]> {
  const host = deps.host ?? realHostExec;
  const run = deps.run ?? runSandbox;
  const lines: CheckLine[] = [];
  const remote = opts.remote ?? null;
  let s = s0;
  const hostArgs: string[] = [];

  if (remote) {
    try {
      s = settingsForHost(s0, remote);
    } catch (err) {
      lines.push({ ok: false, label: '主機設定', detail: (err as Error).message });
      return lines;
    }
    const probe = await host(
      'ssh',
      [...sshArgs(remote), remote.ssh_target, 'echo LOOP_OK; id -u; id -g; command -v rsync >/dev/null && echo rsync:yes || echo rsync:no'],
      20_000,
    );
    const out = probe.out.split('\n').map((l) => l.trim());
    if (probe.code !== 0 || out[0] !== 'LOOP_OK') {
      lines.push({
        ok: false,
        label: 'SSH',
        detail: `無法以金鑰登入 ${remote.ssh_target}：${probe.out.slice(-300) || `exit ${probe.code}`}。在 Spark 上以引擎的使用者執行 ssh-copy-id ${remote.ssh_target}，並先 ssh 一次接受 host key。`,
      });
      return lines;
    }
    const uid = Number(out[1]);
    const gid = Number(out[2]);
    if (Number.isInteger(uid) && Number.isInteger(gid)) opts.onRemoteIds?.(uid, gid);
    lines.push({ ok: true, label: 'SSH', detail: `${remote.ssh_target}（uid ${out[1]}）` });
    const localRsync = await host('rsync', ['--version'], 10_000);
    if (localRsync.code !== 0 || out[3] !== 'rsync:yes') {
      lines.push({ ok: false, label: 'rsync', detail: `${localRsync.code !== 0 ? 'Spark' : remote.name} 上沒有 rsync：請安裝（apt install rsync）` });
      return lines;
    }
    lines.push({ ok: true, label: 'rsync', detail: '兩邊都有' });
    hostArgs.push('-H', dockerHostUrl(remote));
  }

  const ver = await host('docker', [...hostArgs, 'version', '--format', '{{.Server.Version}}'], 30_000);
  if (ver.code !== 0) {
    lines.push({
      ok: false,
      label: 'Docker',
      detail:
        ver.code === null
          ? '找不到 docker 指令：請安裝 Docker 與 NVIDIA Container Toolkit'
          : remote
            ? `連不到 ${remote.name} 的 Docker：${ver.out.slice(0, 200)}（遠端帳號要在 docker 群組）`
            : `連不到 Docker daemon：${ver.out.slice(0, 200)}`,
    });
    return lines;
  }
  lines.push({ ok: true, label: 'Docker', detail: `server ${ver.out.split('\n')[0]}${remote ? `（${remote.name}）` : ''}` });

  const img = await host('docker', [...hostArgs, 'image', 'inspect', '--format', '{{.Architecture}} {{.Size}}', s.image], 30_000);
  if (img.code !== 0) {
    lines.push({ ok: false, label: '映像', detail: `${remote ? `${remote.name} 上` : ''}沒有 ${s.image}：先執行 docker pull ${s.image}（或改 exec_image／主機的 --image）` });
    return lines;
  }
  const [arch, size] = img.out.split(/\s+/);
  lines.push({ ok: true, label: '映像', detail: `${s.image}（${arch ?? '?'}，${size ? `${(Number(size) / 1e9).toFixed(1)} GB` : '?'}）` });

  const dir = ensureWorkspace(workDir);
  const reqRemote = remote ? { host: remote, key: 'check' } : null;
  let dataTargets: string[] = [];
  try {
    dataTargets = (remote ? parseDataMounts(remote.data_mounts) : s.dataMounts).map((m) => m.target);
  } catch {
    dataTargets = [];
  }
  const probe = await run(s, { workdir: dir, command: probeCommand(dataTargets), timeoutSec: 120, scope: 'check', remote: reqRemote });
  if (probe.infra || probe.timedOut) {
    lines.push({ ok: false, label: '啟動容器', detail: `${probe.error ?? (probe.timedOut ? '逾時' : '失敗')}${probe.hint ? `；${probe.hint}` : ''}\n${probe.output.slice(-600)}` });
    return lines;
  }
  const p = parseProbe(probe.output);
  const gpuOk = !!p.gpu && /^GPU \d/m.test(p.gpu);
  lines.push({
    ok: s.gpus ? gpuOk : null,
    label: 'GPU',
    detail: s.gpus ? (gpuOk ? p.gpu! : `容器裡看不到 GPU：${(p.gpu || '').slice(0, 200)}`) : '未啟用（exec_gpus 為空）',
  });
  const nvccOk = !!p.nvcc && !/not found/.test(p.nvcc);
  lines.push({ ok: nvccOk, label: 'nvcc', detail: nvccOk ? p.nvcc! : '映像裡沒有 nvcc：請改用 CUDA 的 -devel 映像' });
  const ncuOk = !!p.ncu && !/not found/.test(p.ncu);
  lines.push({ ok: ncuOk ? true : null, label: 'ncu', detail: ncuOk ? p.ncu! : '映像裡沒有 Nsight Compute（ncu）：需要量測時請自建含 cuda-nsight-compute 的映像' });
  const netNone = p.net === 'net: none';
  lines.push({ ok: netNone, label: '網路隔離', detail: netNone ? '容器連不到網路（正確）' : '容器竟然有網路——請檢查 docker 設定' });
  const workOk = p.work === 'work: writable';
  lines.push({ ok: workOk, label: '/work', detail: workOk ? '可寫入' : '工作目錄不可寫入：檢查資料夾權限（容器以引擎／遠端帳號的 uid 執行）' });
  for (const t of dataTargets) {
    const row = (p.data ?? '').split('\n').find((l) => l.endsWith(` ${t}`)) ?? `missing ${t}`;
    const state = row.split(' ')[0];
    lines.push({
      ok: state === 'ro',
      label: `資料 ${t}`,
      detail: state === 'ro' ? '唯讀可讀（正確）' : state === 'rw' ? '竟然可以寫入——請回報' : '讀不到：來源資料夾不存在或權限不足',
    });
  }

  if (opts.profile) {
    if (!nvccOk || !ncuOk) {
      lines.push({ ok: null, label: 'ncu 權限', detail: '略過：需要 nvcc 與 ncu' });
    } else {
      fs.writeFileSync(path.join(dir, 'probe.cu'), PROFILE_PROBE_CU);
      const prof = await run(s, {
        workdir: dir,
        command: 'nvcc -O2 -o probe probe.cu && ./probe && ncu --metrics sm__cycles_elapsed.avg ./probe',
        timeoutSec: Math.min(s.maxTimeoutSec, 300),
        scope: 'check',
        remote: reqRemote,
      });
      const denied = /ERR_NVGPUCTRPERM/.test(prof.output);
      const measured = prof.exitCode === 0 && /sm__cycles_elapsed/.test(prof.output);
      lines.push({
        ok: measured,
        label: 'ncu 權限',
        detail: measured
          ? '可以讀 GPU 效能計數器'
          : denied
            ? prof.hint ?? '沒有讀 GPU 效能計數器的權限（ERR_NVGPUCTRPERM）'
            : `量測沒成功（${prof.error ?? `exit ${prof.exitCode}`}）：${prof.output.slice(-400)}`,
      });
    }
  }
  return lines;
}

export function formatCheck(lines: CheckLine[]): string {
  return lines.map((l) => `${l.ok === true ? '✅' : l.ok === false ? '❌' : '⚠️'} ${l.label}：${l.detail}`).join('\n');
}
