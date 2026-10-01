import type { MachineSpecs } from '../exec/specs.js';

/**
 * 機台適配: a repo's requirements (Repo 檔案 → 需求環境) against what each machine is (規格 + the
 * software a person listed). Each requirement comes out ok / bad / unknown with a reason, so an
 * engineer can tell at a glance which box can build and run this repo — and which cannot, and why.
 * Software the probe cannot see (MIL, Halcon, a camera SDK, a licence) is looked up in the
 * person's own text; not mentioned = unknown, never a guess.
 */

export interface FitRequirement {
  kind: string;
  name: string;
  version: string | null;
  note?: string | null;
  module?: string | null;
}

export interface FitBox {
  name: string;
  /** 'machine' | 'engine' (this Spark) | 'sandbox' */
  where: string;
  specs: MachineSpecs | null;
  /** software + description, as the person wrote them */
  text: string;
}

export type FitState = 'ok' | 'bad' | 'unknown';
export interface FitItem {
  requirement: string;
  state: FitState;
  why: string;
}
export interface FitResult {
  name: string;
  where: string;
  ok: number;
  bad: number;
  unknown: number;
  items: FitItem[];
}

/** Compute capability by GPU name (rough, for 最低 GPU 架構); null = not known. */
export function computeCapability(gpu: string): number | null {
  const g = gpu.toUpperCase();
  if (/GB10\b/.test(g)) return 121;
  if (/RTX\s*50\d0|B[0-9]{3}\b|BLACKWELL/.test(g)) return 120;
  if (/RTX\s*40\d0|L4\b|L40|RTX\s*(2000|4000|4500|5000|6000)\s*ADA/.test(g)) return 89;
  if (/H100|H200|GH200/.test(g)) return 90;
  if (/RTX\s*30\d0|RTX\s*A\d{4}|A10\b|A40\b|A2\b/.test(g)) return 86;
  if (/A100|A30\b/.test(g)) return 80;
  if (/RTX\s*20\d0|TITAN RTX|QUADRO RTX|T4\b|GTX\s*16\d0/.test(g)) return 75;
  if (/V100|TITAN V/.test(g)) return 70;
  if (/GTX\s*10\d0|P100|P40|P4\b|QUADRO P/.test(g)) return 61;
  return null;
}

const ver = (s: string | null | undefined): number[] => (s ?? '').match(/\d+/g)?.map(Number) ?? [];
function atLeast(have: string | null | undefined, want: string | null | undefined): boolean | null {
  const h = ver(have);
  const w = ver(want);
  if (!h.length || !w.length) return null;
  for (let i = 0; i < Math.max(h.length, w.length); i++) {
    const a = h[i] ?? 0;
    const b = w[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

const mentions = (text: string, ...names: string[]) => names.some((n) => n && text.toLowerCase().includes(n.toLowerCase()));

/** One requirement against one box. */
export function fitOne(r: FitRequirement, box: FitBox): FitItem {
  const s = box.specs;
  const label = `${r.name}${r.version ? ` ${r.version}` : ''}`;
  const unknown = (why: string): FitItem => ({ requirement: label, state: 'unknown', why });
  const yes = (why: string): FitItem => ({ requirement: label, state: 'ok', why });
  const no = (why: string): FitItem => ({ requirement: label, state: 'bad', why });
  const os = (s?.os ?? '').toLowerCase();
  const arch = (s?.arch ?? '').toLowerCase();
  const name = r.name.toLowerCase();
  switch (r.kind) {
    case 'os': {
      if (!s?.os) return unknown('還沒讀過規格');
      const wantWin = /windows/.test(name);
      const isWin = /windows/.test(os);
      if (wantWin === isWin) return yes(s.os);
      return wantWin || /linux|ubuntu/.test(name) ? no(`這台是 ${s.os}`) : unknown(s.os);
    }
    case 'arch': {
      if (!s?.arch) return unknown('還沒讀過規格');
      const want = /arm|aarch64/.test(name) ? 'arm' : /x64|x86_64|amd64/.test(name) ? 'x64' : /win32|x86/.test(name) ? 'x86' : null;
      const have = /aarch64|arm/.test(arch) ? 'arm' : /x86_64|amd64|x64/.test(arch) ? 'x64' : /x86|i686/.test(arch) ? 'x86' : null;
      if (!want || !have) return unknown(s.arch);
      return want === have || (want === 'x86' && have === 'x64') ? yes(s.arch) : no(`這台是 ${s.arch}`);
    }
    case 'gpu': {
      if (!s) return unknown('還沒讀過規格');
      if (!s.gpus.length) return no('沒有 NVIDIA GPU');
      const want = Number(/sm_?(\d+)/i.exec(`${r.name} ${r.version ?? ''}`)?.[1] ?? NaN);
      const cc = Math.max(...s.gpus.map((g) => computeCapability(g.name) ?? 0));
      if (!Number.isFinite(want)) return yes(s.gpus.map((g) => g.name).join('、'));
      if (!cc) return unknown(`${s.gpus[0]!.name}：不確定是哪一代`);
      return cc >= want ? yes(`${s.gpus[0]!.name}（sm_${cc}）`) : no(`${s.gpus[0]!.name} 是 sm_${cc}，要 sm_${want} 以上`);
    }
    case 'toolchain': {
      if (/visual studio|msvc|v14\d/.test(name)) {
        const vs = s?.tools.msvc ?? '';
        if (!s) return unknown('還沒讀過規格');
        if (!/windows/.test(os)) return no('Visual Studio 只在 Windows');
        if (!vs) return mentions(box.text, 'visual studio', 'vs20') ? yes('使用者註明有 Visual Studio') : no('沒有偵測到 Visual Studio');
        const want = /20\d\d/.exec(r.name)?.[0];
        return !want || vs.includes(want) ? yes(vs) : no(`這台是 ${vs}`);
      }
      if (/cmake/.test(name)) {
        const have = s?.tools.cmake;
        if (!have) return s ? no('沒有偵測到 CMake') : unknown('還沒讀過規格');
        const ok = atLeast(have, r.version);
        return ok === false ? no(`CMake ${have} 太舊`) : yes(`CMake ${have}`);
      }
      if (/gcc|g\+\+/.test(name)) return s?.tools.gcc ? yes(`GCC ${s.tools.gcc}`) : s ? no('沒有偵測到 GCC') : unknown('還沒讀過規格');
      if (/c\+\+\s*\d+/.test(name)) return s?.tools.gcc || s?.tools.msvc ? yes(s.tools.gcc ? `GCC ${s.tools.gcc}` : s.tools.msvc!) : unknown('看不出編譯器版本');
      return unknown('沒有可比對的資料');
    }
    case 'sdk':
    case 'runtime':
    case 'library':
    case 'hardware':
    case 'license': {
      if (/^cuda/.test(name)) {
        if (!s) return unknown('還沒讀過規格');
        if (!s.gpus.length && !s.cuda_driver) return no('沒有 NVIDIA GPU／驅動');
        if (!s.cuda_toolkit) return r.kind === 'runtime' && s.cuda_driver ? yes(`驅動支援到 CUDA ${s.cuda_driver}`) : no(`沒有 CUDA Toolkit（驅動支援到 ${s.cuda_driver ?? '?'}）`);
        const ok = atLeast(s.cuda_toolkit, r.version);
        return ok === false ? no(`Toolkit ${s.cuda_toolkit} 比 ${r.version} 舊`) : yes(`Toolkit ${s.cuda_toolkit}`);
      }
      if (/^python/.test(name)) {
        const have = s?.tools.python;
        if (!have) return s ? no('沒有偵測到 Python') : unknown('還沒讀過規格');
        const ok = atLeast(have, r.version?.replace(/[<>=~^ ]/g, '') || null);
        return ok === false ? no(`Python ${have} 太舊`) : yes(`Python ${have}`);
      }
      if (/docker/.test(name)) return s?.tools.docker ? yes(`Docker ${s.tools.docker}`) : s ? no('沒有偵測到 Docker') : unknown('還沒讀過規格');
      if (/\.net/.test(name) && /windows/.test(os) === false && /framework/.test(name)) return no('.NET Framework 只在 Windows');
      // everything the probe cannot see: the person's own text decides
      const words = [r.name, r.name.replace(/\s*\(.*\)$/, ''), r.name.split(/[\s（(]/)[0]!].filter((w) => w.length >= 2);
      if (mentions(box.text, ...words)) return yes('使用者註明有');
      return unknown(r.kind === 'hardware' || r.kind === 'license' ? '機台頁的「其他軟體」沒寫到；請到機台補上' : '沒有偵測到，也沒寫在「其他軟體」');
    }
    default:
      return unknown('沒有可比對的資料');
  }
}

/** Every box against every requirement, best fit first (fewest bad, then most ok). */
export function machineFit(reqs: FitRequirement[], boxes: FitBox[]): FitResult[] {
  return boxes
    .map((b) => {
      const items = reqs.map((r) => fitOne(r, b));
      return {
        name: b.name,
        where: b.where,
        ok: items.filter((i) => i.state === 'ok').length,
        bad: items.filter((i) => i.state === 'bad').length,
        unknown: items.filter((i) => i.state === 'unknown').length,
        items,
      };
    })
    .sort((a, b) => a.bad - b.bad || b.ok - a.ok || a.name.localeCompare(b.name));
}
