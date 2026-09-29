import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runSandbox, type SandboxDeps, type SandboxRequest, type SandboxResult, type SandboxSettings } from './sandbox.js';
import { ensureWorkspace } from './workspace.js';

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

export type HostExec = (cmd: string, args: string[], timeoutMs: number) => Promise<{ code: number | null; out: string }>;

/** code null = the binary does not exist; any failure to finish cleanly is a non-zero code. */
const realHostExec: HostExec = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ?? ''}`.trim();
      if (!err) return resolve({ code: 0, out });
      const code = (err as { code?: unknown }).code;
      if (code === 'ENOENT') return resolve({ code: null, out });
      resolve({ code: typeof code === 'number' ? code : 1, out: out || err.message });
    });
  });

export interface CheckDeps {
  host?: HostExec;
  run?: (s: SandboxSettings, req: SandboxRequest, deps?: SandboxDeps) => Promise<SandboxResult>;
}

/** Everything the probe container prints, one marked section per question. */
export const PROBE_COMMAND = [
  'echo "== gpu"; (nvidia-smi -L 2>&1 || echo "nvidia-smi: unavailable") | head -8',
  'echo "== nvcc"; (command -v nvcc >/dev/null && nvcc --version 2>&1 | tail -1) || echo "nvcc: not found"',
  'echo "== ncu"; (command -v ncu >/dev/null && ncu --version 2>&1 | tail -1) || echo "ncu: not found"',
  'echo "== net"; (getent hosts example.com >/dev/null 2>&1 && echo "net: reachable") || echo "net: none"',
  'echo "== work"; (touch /work/.loop-exec-probe && rm -f /work/.loop-exec-probe && echo "work: writable") || echo "work: read-only"',
].join('; ');

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
  s: SandboxSettings,
  workDir: string,
  opts: { profile?: boolean } = {},
  deps: CheckDeps = {},
): Promise<CheckLine[]> {
  const host = deps.host ?? realHostExec;
  const run = deps.run ?? runSandbox;
  const lines: CheckLine[] = [];

  const ver = await host('docker', ['version', '--format', '{{.Server.Version}}'], 15_000);
  if (ver.code !== 0) {
    lines.push({
      ok: false,
      label: 'Docker',
      detail: ver.code === null ? '找不到 docker 指令：請安裝 Docker 與 NVIDIA Container Toolkit' : `連不到 Docker daemon：${ver.out.slice(0, 200)}`,
    });
    return lines;
  }
  lines.push({ ok: true, label: 'Docker', detail: `server ${ver.out.split('\n')[0]}` });

  const img = await host('docker', ['image', 'inspect', '--format', '{{.Architecture}} {{.Size}}', s.image], 15_000);
  if (img.code !== 0) {
    lines.push({ ok: false, label: '映像', detail: `沒有 ${s.image}：先執行 docker pull ${s.image}（或把 exec_image 改成已有的映像）` });
    return lines;
  }
  const [arch, size] = img.out.split(/\s+/);
  lines.push({ ok: true, label: '映像', detail: `${s.image}（${arch ?? '?'}，${size ? `${(Number(size) / 1e9).toFixed(1)} GB` : '?'}）` });

  const dir = ensureWorkspace(workDir);
  const probe = await run(s, { workdir: dir, command: PROBE_COMMAND, timeoutSec: 120, scope: 'check' });
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
  lines.push({ ok: workOk, label: '/work', detail: workOk ? '可寫入' : '工作目錄不可寫入：檢查資料夾權限（容器以引擎的 uid 執行）' });

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
