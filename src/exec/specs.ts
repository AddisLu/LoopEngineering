import type Database from 'better-sqlite3';
import { getExecHost, sshArgs, LOCAL_HOST, type HostExec } from './hosts.js';
import { paths } from '../config.js';

/**
 * 規格: what a box is, the way a VM listing says it — OS, CPU, RAM, disk, GPU, driver / CUDA and
 * the build tools that matter here — so an engineer can tell at a glance whether a 機台 (or a GPU
 * 沙盒 host) can reproduce a problem. Collected by the health check's one probe run (machines)
 * or by its own run (沙盒 hosts: this Spark locally, the others over ssh). Software the probe
 * cannot see (Halcon, a camera SDK, a licence) is the person's own text (`software`).
 * Every probe line is optional: a missing tool just leaves its field empty.
 */

export interface GpuSpec {
  name: string;
  /** null = the driver does not report it (a unified-memory GPU such as the GB10) */
  vram_gb: number | null;
}

export interface MachineSpecs {
  os: string | null;
  kernel: string | null;
  arch: string | null;
  cpu: string | null;
  cores: number | null;
  threads: number | null;
  ram_gb: number | null;
  /** the disk holding the work root (machines) or the data dir (this Spark) */
  disk_total_gb: number | null;
  disk_free_gb: number | null;
  gpus: GpuSpec[];
  driver: string | null;
  /** the highest CUDA the driver supports (nvidia-smi's header) */
  cuda_driver: string | null;
  /** the installed toolkit (nvcc) */
  cuda_toolkit: string | null;
  /** python / gcc / msvc / cmake / docker versions that were found */
  tools: Record<string, string>;
  at: string;
}

export const SPEC_TOOLS = ['python', 'gcc', 'msvc', 'cmake', 'docker'] as const;

const bq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const pq = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** bash: `== specs` then key=value lines; `root` is the directory whose disk is reported. */
export function linuxSpecsScript(root: string): string {
  return [
    'echo "== specs"',
    '( . /etc/os-release 2>/dev/null && echo "os=$PRETTY_NAME" )',
    'echo "kernel=$(uname -r 2>/dev/null)"',
    'echo "arch=$(uname -m 2>/dev/null)"',
    `echo "cpu=$(lscpu 2>/dev/null | sed -n 's/^Model name:[[:space:]]*//p' | sort -u | paste -sd '/' -)"`,
    'echo "threads=$(nproc --all 2>/dev/null)"',
    // cores = threads / threads-per-core (core ids repeat across clusters on big.LITTLE parts)
    `echo "tpc=$(lscpu 2>/dev/null | sed -n 's/^Thread(s) per core:[[:space:]]*//p' | head -n 1)"`,
    `echo "mem_kb=$(awk '/^MemTotal/{print $2}' /proc/meminfo 2>/dev/null)"`,
    `df -Pk ${bq(root)} 2>/dev/null | tail -n 1 | awk '{print "disk_total_kb=" $2; print "disk_free_kb=" $4}'`,
    `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits 2>/dev/null | sed 's/^/gpu=/'`,
    `echo "cuda_driver=$(nvidia-smi 2>/dev/null | grep -o 'CUDA Version: [0-9.]*' | head -n 1 | awk '{print $3}')"`,
    `echo "cuda_toolkit=$( (nvcc --version 2>/dev/null || /usr/local/cuda/bin/nvcc --version 2>/dev/null) | sed -n 's/.*release \\([0-9.]*\\).*/\\1/p' | head -n 1)"`,
    `echo "python=$(python3 --version 2>/dev/null | awk '{print $2}')"`,
    'echo "gcc=$(gcc -dumpfullversion 2>/dev/null || gcc -dumpversion 2>/dev/null)"',
    `echo "cmake=$(cmake --version 2>/dev/null | head -n 1 | awk '{print $3}')"`,
    `echo "docker=$(docker --version 2>/dev/null | sed -n 's/^Docker version \\([^,]*\\).*/\\1/p')"`,
  ].join('; ');
}

/** PowerShell: the same lines; `root` is the work root whose drive is reported. */
export function windowsSpecsScript(root: string): string {
  const drive = /^[A-Za-z]:/.test(root) ? root.slice(0, 1) : 'C';
  const vswhere = '(Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\\Installer\\vswhere.exe")';
  return [
    '"== specs"',
    'try { $o = Get-CimInstance Win32_OperatingSystem; "os=" + $o.Caption.Trim() + " (" + $o.Version + ")"; "kernel=" + $o.Version; "mem_kb=" + [math]::Floor($o.TotalVisibleMemorySize) } catch {}',
    '"arch=" + $env:PROCESSOR_ARCHITECTURE',
    'try { $c = @(Get-CimInstance Win32_Processor); "cpu=" + ((@($c | ForEach-Object { $_.Name.Trim() }) | Select-Object -Unique) -join "/"); "cores=" + ($c | Measure-Object NumberOfCores -Sum).Sum; "threads=" + ($c | Measure-Object NumberOfLogicalProcessors -Sum).Sum } catch {}',
    `try { $d = Get-PSDrive -Name ${pq(drive)}; "disk_total_kb=" + [math]::Floor(($d.Used + $d.Free) / 1024); "disk_free_kb=" + [math]::Floor($d.Free / 1024) } catch {}`,
    'try { nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits 2>$null | ForEach-Object { "gpu=" + $_ } } catch { try { Get-CimInstance Win32_VideoController | ForEach-Object { "gpu=" + $_.Name + ",," + $_.DriverVersion } } catch {} }',
    'try { $s = nvidia-smi 2>$null | Select-String "CUDA Version: ([\\d.]+)"; if ($s) { "cuda_driver=" + $s.Matches[0].Groups[1].Value } } catch {}',
    'try { $v = nvcc --version 2>$null | Select-String "release ([\\d.]+)"; if ($v) { "cuda_toolkit=" + $v.Matches[0].Groups[1].Value } } catch { if ($env:CUDA_PATH) { "cuda_toolkit=" + (Split-Path $env:CUDA_PATH -Leaf) } }',
    'try { $p = (python --version 2>&1) -join " "; if ($p -match "Python ([\\d.]+)") { "python=" + $Matches[1] } } catch {}',
    `try { $vs = & ${vswhere} -latest -property displayName 2>$null; if ($vs) { "msvc=" + $vs } } catch {}`,
    'try { $m = (cmake --version 2>$null) -join " "; if ($m -match "version ([\\d.]+)") { "cmake=" + $Matches[1] } } catch {}',
    'try { $k = (docker --version 2>$null) -join " "; if ($k -match "version ([^,]+)") { "docker=" + $Matches[1] } } catch {}',
  ].join('\n');
}

const num = (s: string | undefined): number | null => {
  const n = Number(String(s ?? '').trim());
  return s !== undefined && String(s).trim() !== '' && Number.isFinite(n) ? n : null;
};
const gbOfKb = (kb: number | null): number | null => (kb && kb > 0 ? Math.round((kb / 1024 / 1024) * 10) / 10 : null);
const clean = (s: string | undefined, max = 200): string | null => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v ? v.slice(0, max) : null;
};

/** The `== specs` section's key=value lines → MachineSpecs (null when nothing useful came back). */
export function parseSpecs(text: string | undefined, now: Date = new Date()): MachineSpecs | null {
  if (!text?.trim()) return null;
  const kv = new Map<string, string>();
  const gpuLines: string[] = [];
  for (const raw of text.split('\n')) {
    const m = /^\s*([a-z_]+)=(.*)$/.exec(raw);
    if (!m) continue;
    if (m[1] === 'gpu') gpuLines.push(m[2]!);
    else if (!kv.has(m[1]!)) kv.set(m[1]!, m[2]!.trim());
  }
  const gpus: GpuSpec[] = [];
  let driver: string | null = null;
  for (const g of gpuLines) {
    const [name, mem, drv] = g.split(',').map((x) => x.trim());
    if (!name || /not found|failed|no devices|couldn't communicate/i.test(name)) continue;
    const mib = num(mem);
    gpus.push({ name: name.slice(0, 120), vram_gb: mib && mib > 0 ? Math.round(mib / 1024) : null });
    driver ??= clean(drv, 40);
  }
  const ver = (k: string) => {
    const v = clean(kv.get(k), 80);
    return v && /\d/.test(v) ? v : null;
  };
  const tools: Record<string, string> = {};
  for (const t of SPEC_TOOLS) {
    const v = t === 'msvc' ? clean(kv.get(t), 80) : ver(t);
    if (v) tools[t] = v;
  }
  const specs: MachineSpecs = {
    os: clean(kv.get('os')),
    kernel: clean(kv.get('kernel'), 80),
    arch: clean(kv.get('arch'), 40),
    cpu: clean(kv.get('cpu')),
    cores: num(kv.get('cores')) || (num(kv.get('threads')) && num(kv.get('tpc')) ? Math.round(num(kv.get('threads'))! / num(kv.get('tpc'))!) : null),
    threads: num(kv.get('threads')) || null,
    ram_gb: gbOfKb(num(kv.get('mem_kb'))),
    disk_total_gb: gbOfKb(num(kv.get('disk_total_kb'))),
    disk_free_gb: gbOfKb(num(kv.get('disk_free_kb'))),
    gpus,
    driver,
    cuda_driver: ver('cuda_driver'),
    cuda_toolkit: ver('cuda_toolkit'),
    tools,
    at: now.toISOString(),
  };
  return specs.os || specs.cpu || specs.ram_gb || gpus.length ? specs : null;
}

const fmtGb = (g: number) => (g >= 10 ? `${Math.round(g)} GB` : `${g} GB`);

/** One line for a table cell: 「Ubuntu 24.04 · 20 核 · 128 GB · NVIDIA GB10 · CUDA 13.0」. */
export function specsSummary(s: MachineSpecs | null): string | null {
  if (!s) return null;
  const parts = [
    s.os ? `${s.os}${s.arch ? `（${s.arch}）` : ''}` : s.arch,
    s.cores || s.threads ? `${s.cores ?? s.threads} 核${s.threads && s.cores && s.threads !== s.cores ? `／${s.threads} 緒` : ''}` : null,
    s.ram_gb ? `RAM ${fmtGb(s.ram_gb)}` : null,
    s.gpus.length ? s.gpus.map((g) => `${g.name}${g.vram_gb ? ` ${g.vram_gb} GB` : ''}`).join('、') : '沒有 NVIDIA GPU',
    s.cuda_toolkit ? `CUDA ${s.cuda_toolkit}` : s.cuda_driver ? `CUDA（驅動）${s.cuda_driver}` : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

export function readSpecs(json: string | null | undefined): MachineSpecs | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as MachineSpecs;
    return v && typeof v === 'object' && Array.isArray(v.gpus) ? v : null;
  } catch {
    return null;
  }
}

// ---- GPU 沙盒 hosts: this Spark, or an exec_hosts box over ssh ----------------------------------

export interface HostSpecsRow {
  name: string;
  specs_json: string | null;
  software: string | null;
  checked_at: string | null;
}

export function getHostSpecs(db: Database.Database, name: string): HostSpecsRow | null {
  return (db.prepare('SELECT * FROM host_specs WHERE name = ?').get(name) as HostSpecsRow | undefined) ?? null;
}

export function setHostSoftware(db: Database.Database, name: string, software: string | null): HostSpecsRow {
  db.prepare(
    `INSERT INTO host_specs (name, software) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET software = excluded.software`,
  ).run(name, software);
  return getHostSpecs(db, name)!;
}

/** Probe a 沙盒 host's specs and store them; an error names what failed (nothing is stored then). */
export async function probeHostSpecs(db: Database.Database, name: string, exec: HostExec): Promise<{ specs: MachineSpecs | null; error: string | null }> {
  let out: { code: number | null; out: string };
  if (name === LOCAL_HOST) {
    out = await exec('bash', ['-c', linuxSpecsScript(paths.dataDir)], 30_000);
  } else {
    const h = getExecHost(db, name);
    if (!h) return { specs: null, error: `沒有這台沙盒主機：${name}` };
    out = await exec('ssh', [...sshArgs(h), h.ssh_target, `bash -c ${bq(linuxSpecsScript(h.work_root))}`], 40_000);
    if (out.code === 255) return { specs: null, error: `連不上 ${h.ssh_target}：${out.out.trim().split('\n').pop()?.slice(0, 200) ?? ''}` };
  }
  if (out.code === null) return { specs: null, error: '找不到 bash／ssh' };
  const section = out.out.split('== specs')[1];
  const specs = parseSpecs(section);
  if (!specs) return { specs: null, error: `讀不到規格：${out.out.trim().slice(-200)}` };
  db.prepare(
    `INSERT INTO host_specs (name, specs_json, checked_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(name) DO UPDATE SET specs_json = excluded.specs_json, checked_at = excluded.checked_at`,
  ).run(name, JSON.stringify(specs));
  return { specs, error: null };
}

// ---- for the model (LOOP_TASK.md, the analysis prompt) -----------------------------------------

const TOOL_NAMES: Record<string, string> = { python: 'Python', gcc: 'GCC', msvc: 'Visual Studio', cmake: 'CMake', docker: 'Docker' };

/**
 * One box for a model to plan around: a head line (who it is · what it is), then the details a
 * command or a build depends on — CUDA toolkit vs driver, the tools, the person's own software.
 */
export function describeBox(head: string, s: MachineSpecs | null, o: { software?: string | null; description?: string | null } = {}): string[] {
  const lines = [`- ${head}`, `  - 規格：${specsSummary(s) ?? '還沒讀過（機台頁按「檢查」或「讀取規格」）'}`];
  if (s) {
    if (s.cpu) lines.push(`  - CPU：${s.cpu}`);
    if (s.disk_free_gb) lines.push(`  - 磁碟：可用 ${fmtGb(s.disk_free_gb)}${s.disk_total_gb ? ` / 共 ${fmtGb(s.disk_total_gb)}` : ''}`);
    if (s.gpus.length || s.cuda_driver) {
      const cuda = [s.cuda_toolkit ? `CUDA Toolkit ${s.cuda_toolkit}` : '沒有 CUDA Toolkit（nvcc）', s.cuda_driver ? `驅動支援到 CUDA ${s.cuda_driver}` : null, s.driver ? `驅動 ${s.driver}` : null];
      lines.push(`  - CUDA：${cuda.filter(Boolean).join('，')}`);
    }
    const tools = Object.entries(s.tools).map(([k, v]) => (k === 'msvc' && /^Visual Studio/.test(v) ? v : `${TOOL_NAMES[k] ?? k} ${v}`));
    lines.push(`  - 已裝工具：${tools.length ? tools.join('、') : '（沒有偵測到 Python／GCC／Visual Studio／CMake／Docker）'}`);
  }
  if (o.software?.trim()) lines.push(`  - 其他軟體（使用者填的）：${o.software.trim().replace(/\s*\n\s*/g, '；')}`);
  if (o.description?.trim()) lines.push(`  - 說明：${o.description.trim().replace(/\s*\n\s*/g, '；')}`);
  return lines;
}
