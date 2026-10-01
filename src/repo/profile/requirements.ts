import type { Architecture } from './architecture.js';
import { baseOf, codeFiles, CPP_EXT, depthOf, dirOf, ev, extOf, lineText, type RepoCtx } from './context.js';
import { parseCMake, xmlEls, type CMakeCmd } from './parse.js';
import type { Evidence, Requirement, RequirementKind } from './types.js';

/**
 * 需求: what a machine must have to build and run this checkout — OS, architecture, toolchain,
 * SDKs, libraries, runtimes, GPU generation, capture hardware and licenses — each with the
 * file:line it was read from. Deterministic, regex/XML level; nothing is executed.
 */

const MAX_DEPTH = 4;
const MAX_EVIDENCE = 3;
const KIND_ORDER: RequirementKind[] = ['os', 'arch', 'toolchain', 'sdk', 'runtime', 'gpu', 'hardware', 'license', 'library'];

class ReqSet {
  private map = new Map<string, Requirement>();
  add(kind: RequirementKind, name: string, version: string | null, note: string | null, module: string | null, evidence: Evidence | Evidence[]): Requirement {
    const key = `${kind}\u0000${name.toLowerCase()}\u0000${module ?? ''}`;
    const evs = Array.isArray(evidence) ? evidence : [evidence];
    let r = this.map.get(key);
    if (!r) {
      r = { kind, name, version, note, module, evidence: [] };
      this.map.set(key, r);
    } else {
      if (!r.version && version) r.version = version;
      if (note && r.note !== note && !(r.note ?? '').includes(note)) r.note = r.note ? `${r.note}；${note}`.slice(0, 240) : note;
    }
    for (const e of evs) {
      if (r.evidence.length >= MAX_EVIDENCE) break;
      if (!r.evidence.some((x) => x.file === e.file && x.line === e.line)) r.evidence.push(e);
    }
    return r;
  }
  list(): Requirement[] {
    return [...this.map.values()].sort(
      (a, b) =>
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        (a.module ?? '').localeCompare(b.module ?? '') ||
        a.name.localeCompare(b.name),
    );
  }
}

// ---- shared knowledge ---------------------------------------------------------------------------

/** the lowest consumer GPU generation that runs code built for sm_XX */
export function gpuNote(sm: number): string {
  if (sm >= 121) return 'DGX Spark（GB10）';
  if (sm >= 120) return 'RTX 50 系列以上';
  if (sm >= 100) return 'Blackwell 資料中心 GPU（B200）以上';
  if (sm >= 90) return 'Hopper（H100）以上';
  if (sm >= 89) return 'RTX 40 系列以上';
  if (sm >= 87) return 'Jetson Orin';
  if (sm >= 86) return 'RTX 30 系列以上';
  if (sm >= 80) return 'A100 以上';
  if (sm >= 75) return 'RTX 20 / GTX 16 系列以上';
  if (sm >= 70) return 'Volta（V100）以上';
  if (sm >= 60) return 'GTX 10 系列以上';
  return 'Maxwell（GTX 900）以上';
}

interface LibHit {
  kind: RequirementKind;
  name: string;
  version: string | null;
  note?: string | null;
}

const WIN_SYSTEM_LIBS = new Set(
  'kernel32 user32 gdi32 winspool comdlg32 advapi32 shell32 ole32 oleaut32 uuid odbc32 odbccp32 ws2_32 winmm shlwapi version comctl32 setupapi dbghelp psapi iphlpapi wsock32 opengl32 glu32 dxgi d3d11 d3d12 d3dcompiler bcrypt crypt32 secur32 netapi32 userenv mpr imm32 rpcrt4 wininet winhttp'.split(' '),
);

/** a linked library (`opencv_world480.lib`, `-lonnxruntime`, `mil`) → what it is */
export function libFromName(raw: string): LibHit | null {
  const n = raw.replace(/\\/g, '/').split('/').pop()!.replace(/\.(lib|a|so|dylib|dll)$/i, '').replace(/^lib(?=[a-z])/, '');
  const l = n.toLowerCase();
  if (!l || WIN_SYSTEM_LIBS.has(l) || l.startsWith('%(')) return null;
  let m = /^opencv_(?:world|core)(\d)(\d+?)(\d)d?$/.exec(l);
  if (m) return { kind: 'library', name: 'OpenCV', version: `${m[1]}.${Number(m[2])}.${m[3]}` };
  if (l.startsWith('opencv_')) return { kind: 'library', name: 'OpenCV', version: null };
  if (l === 'mil' || /^mil[a-z]*$/.test(l) && ['milblob', 'milpat', 'milmod', 'milim', 'milmeas', 'milcode', 'milocr', 'milcal', 'milreg', 'milstr', 'milcol', 'miledge', 'milmet', 'milgra'].includes(l))
    return { kind: 'library', name: 'MIL', version: null };
  if (/^halcon(cpp)?$/.test(l)) return { kind: 'library', name: 'Halcon', version: null };
  if (/^(cudart|cuda|cublas|cublaslt|cufft|curand|cusparse|cusolver|nppc|nppi\w*|nvrtc)(_static)?\d*$/.test(l)) return { kind: 'sdk', name: 'CUDA', version: null };
  if (/^nvinfer/.test(l) || /^nvonnxparser/.test(l)) return { kind: 'library', name: 'TensorRT', version: null };
  m = /^pylonbase(?:_v(\d+)_(\d+))?/.exec(l);
  if (m) return { kind: 'library', name: 'Basler pylon', version: m[1] ? `${m[1]}.${m[2]}` : null };
  if (/^(pylonc|pylonutility|gcbase|genapi)/.test(l)) return { kind: 'library', name: 'Basler pylon', version: null };
  if (l === 'mvcameracontrol') return { kind: 'library', name: 'Hikrobot MVS', version: null };
  if (l === 'onnxruntime') return { kind: 'library', name: 'ONNX Runtime', version: null };
  if (l === 'ibverbs') return { kind: 'library', name: 'libibverbs', version: null, note: 'RDMA（InfiniBand / RoCE）' };
  if (l === 'rdmacm') return { kind: 'library', name: 'librdmacm', version: null, note: 'RDMA 連線管理' };
  if (/^(torch|c10|torch_cuda|torch_cpu)$/.test(l)) return { kind: 'library', name: 'LibTorch', version: null };
  m = /^qt(\d)\w*$/.exec(l);
  if (m) return { kind: 'library', name: 'Qt', version: m[1]! };
  if (l === 'pthread' || l === 'm' || l === 'dl' || l === 'rt' || l === 'stdc++fs') return null;
  return { kind: 'library', name: n, version: null };
}

/** include path → library (prefix match on '/' paths, exact for single headers) */
const HEADER_MAP: Array<[RegExp, LibHit]> = [
  [/^halconcpp\/halconcpp\.h$|^halconcpp\.h$/i, { kind: 'library', name: 'Halcon', version: null }],
  [/^pylon\//, { kind: 'library', name: 'Basler pylon', version: null }],
  [/^opencv2?\//, { kind: 'library', name: 'OpenCV', version: null }],
  [/^onnxruntime(_cxx_api|_c_api)\.h$|^onnxruntime\//, { kind: 'library', name: 'ONNX Runtime', version: null }],
  [/^NvInfer\w*\.h$/, { kind: 'library', name: 'TensorRT', version: null }],
  [/^MvCameraControl\.h$/i, { kind: 'library', name: 'Hikrobot MVS', version: null }],
  [/^(cuda_runtime(_api)?|cuda|cublas_v2|cufft|curand|cusparse|cooperative_groups|cuda_fp16|mma)\.h$/, { kind: 'sdk', name: 'CUDA', version: null }],
  [/^nlohmann\/json(_fwd)?\.hpp$/, { kind: 'library', name: 'nlohmann_json', version: null }],
  [/^fmt\//, { kind: 'library', name: 'fmt', version: null }],
  [/^spdlog\//, { kind: 'library', name: 'spdlog', version: null }],
  [/^infiniband\/verbs\.h$/, { kind: 'library', name: 'libibverbs', version: null, note: 'RDMA（InfiniBand / RoCE）' }],
  [/^rdma\/rdma_cma\.h$/, { kind: 'library', name: 'librdmacm', version: null, note: 'RDMA 連線管理' }],
  [/^Eigen\//, { kind: 'library', name: 'Eigen', version: null }],
  [/^boost\//, { kind: 'library', name: 'Boost', version: null }],
  [/^gtest\//, { kind: 'library', name: 'GTest', version: null }],
  [/^catch2\//i, { kind: 'library', name: 'Catch2', version: null }],
  [/^torch\//, { kind: 'library', name: 'LibTorch', version: null }],
  [/^Q(Application|Widget|MainWindow|Object|String|Core|Gui|Widgets|tCore|tWidgets|tGui)\b/, { kind: 'library', name: 'Qt', version: null }],
];

export function libFromHeader(h: string): LibHit | null {
  for (const [re, hit] of HEADER_MAP) if (re.test(h)) return hit;
  return null;
}

const ENV_MACROS: Record<string, string> = {
  MIL_PATH: 'MIL',
  OPENCV_DIR: 'OpenCV',
  OPENCV_PATH: 'OpenCV',
  HALCONROOT: 'Halcon',
  CUDA_PATH: 'CUDA',
  PYLON_DEV_DIR: 'Basler pylon',
  PYLON_ROOT: 'Basler pylon',
  MVCAM_COMMON_RUNENV: 'Hikrobot MVS',
  TENSORRT_DIR: 'TensorRT',
  TENSORRT_ROOT: 'TensorRT',
};

const TOOLSETS: Record<string, string> = {
  v145: 'Visual Studio 2026',
  v143: 'Visual Studio 2022',
  v142: 'Visual Studio 2019',
  v141: 'Visual Studio 2017',
  v140: 'Visual Studio 2015',
  v120: 'Visual Studio 2013',
  v110: 'Visual Studio 2012',
  v100: 'Visual Studio 2010',
};

// ---- analyzers ----------------------------------------------------------------------------------

function vcxproj(ctx: RepoCtx, arch: Architecture, out: ReqSet): void {
  for (const f of ctx.files.filter((f) => extOf(f) === 'vcxproj' && depthOf(f) <= MAX_DEPTH)) {
    const t = ctx.read(f)?.text;
    if (!t) continue;
    const mod = arch.unitOf(f) ?? baseOf(f).replace(/\.vcxproj$/i, '');
    const at = (i: number): Evidence => {
      const n = ctx.lineAt(f, i);
      return ev(f, n, lineText(ctx, f, n));
    };

    const sub = xmlEls(t, 'SubSystem')[0];
    const osNote = sub && /^Windows$/i.test(sub.value) ? 'GUI 程式（SubSystem Windows），需要有桌面的 Windows 機台' : 'MSVC 專案，需在 Windows 建置';
    out.add('os', 'Windows', null, osNote, mod, sub ? at(sub.index) : ev(f, 1, null));

    for (const e of xmlEls(t, 'PlatformToolset')) {
      const v = e.value.toLowerCase();
      const vs = TOOLSETS[v];
      out.add('toolchain', vs ? `${vs} (${v})` : e.value, e.value, vs ? `MSVC 工具組 ${v}` : null, mod, at(e.index));
    }
    for (const e of xmlEls(t, 'WindowsTargetPlatformVersion')) {
      if (e.value) out.add('sdk', 'Windows SDK', e.value === '10.0' ? '10.0（最新）' : e.value, null, mod, at(e.index));
    }
    for (const e of xmlEls(t, 'ProjectConfiguration')) {
      const plat = /\|(\w+)$/.exec(e.attrs.Include ?? '')?.[1];
      if (plat) out.add('arch', plat, null, plat === 'Win32' ? '32 位元 x86' : null, mod, at(e.index));
    }
    const re = /BuildCustomizations\\CUDA (\d+\.\d+)\.(?:props|targets)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) out.add('sdk', 'CUDA', m[1]!, `CUDA Toolkit ${m[1]}（Visual Studio 整合）`, mod, at(m.index));
    const sms: Array<{ sm: number; e: Evidence }> = [];
    for (const e of xmlEls(t, 'CodeGeneration')) {
      for (const s of e.value.matchAll(/sm_(\d+)/g)) sms.push({ sm: Number(s[1]), e: at(e.index) });
    }
    if (sms.length) {
      const min = sms.reduce((a, b) => (b.sm < a.sm ? b : a));
      out.add('gpu', `最低 GPU 架構 sm_${min.sm}`, `${Math.floor(min.sm / 10)}.${min.sm % 10}`, gpuNote(min.sm), mod, min.e);
    }
    for (const e of xmlEls(t, 'AdditionalDependencies')) {
      for (const lib of e.value.split(';').map((s) => s.trim()).filter((s) => /\.lib$/i.test(s))) {
        const hit = libFromName(lib);
        if (hit) out.add(hit.kind, hit.name, hit.version, hit.note ?? `連結 ${lib}`, mod, at(e.index));
      }
    }
    const mre = /\$\((\w+)\)/g;
    while ((m = mre.exec(t))) {
      const v = m[1]!;
      const cudaV = /^CUDA_PATH_V(\d+)_(\d+)$/.exec(v);
      const name = cudaV ? 'CUDA' : ENV_MACROS[v];
      if (!name) continue;
      out.add(name === 'CUDA' ? 'sdk' : 'library', name, cudaV ? `${cudaV[1]}.${cudaV[2]}` : null, `需設定環境變數 ${v}`, mod, at(m.index));
    }
  }
}

function cmakeOptional(text: string, c: CMakeCmd, varName: string | null): boolean {
  if (c.args.includes('REQUIRED')) return false;
  if (varName) {
    // `if(NOT X_LIB …) message(FATAL_ERROR …)` makes a plain find_library required after all
    const re = new RegExp(`if\\s*\\(\\s*NOT\\s+[^)]*\\b${varName.replace(/[^\w]/g, '')}\\b[^)]*\\)`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const tail = text.slice(m.index, m.index + 600);
      const end = tail.search(/\b(endif|else)\s*\(/);
      if (/FATAL_ERROR/.test(end >= 0 ? tail.slice(0, end) : tail)) return false;
    }
  }
  return true;
}

const PKG_MAP: Record<string, LibHit | null> = {
  cudatoolkit: { kind: 'sdk', name: 'CUDA', version: null },
  cuda: { kind: 'sdk', name: 'CUDA', version: null },
  opencv: { kind: 'library', name: 'OpenCV', version: null },
  threads: null,
  pkgconfig: null,
  python: { kind: 'runtime', name: 'Python', version: null },
  python3: { kind: 'runtime', name: 'Python', version: null },
  pythoninterp: { kind: 'runtime', name: 'Python', version: null },
  pythonlibs: { kind: 'runtime', name: 'Python', version: null },
  qt5: { kind: 'library', name: 'Qt', version: '5' },
  qt6: { kind: 'library', name: 'Qt', version: '6' },
  pylon: { kind: 'library', name: 'Basler pylon', version: null },
  tensorrt: { kind: 'library', name: 'TensorRT', version: null },
  onnxruntime: { kind: 'library', name: 'ONNX Runtime', version: null },
  eigen3: { kind: 'library', name: 'Eigen', version: null },
  gtest: { kind: 'library', name: 'GTest', version: null },
  googletest: { kind: 'library', name: 'GTest', version: null },
  torch: { kind: 'library', name: 'LibTorch', version: null },
};

function cmakeReqs(ctx: RepoCtx, arch: Architecture, out: ReqSet): void {
  for (const f of ctx.files.filter((f) => baseOf(f) === 'CMakeLists.txt' && depthOf(f) <= MAX_DEPTH)) {
    const t = ctx.read(f)?.text;
    if (!t) continue;
    const cmds = arch.cmake.get(f) ?? parseCMake(t);
    const mod = arch.unitOf(f);
    const at = (c: CMakeCmd) => ev(f, c.line, lineText(ctx, f, c.line));
    let cxxStd = 0;
    let cxxEv: Evidence | null = null;
    const std = (n: number, e: Evidence) => {
      if (n > cxxStd) [cxxStd, cxxEv] = [n, e];
    };
    for (const c of cmds) {
      const a = c.args;
      switch (c.name) {
        case 'cmake_minimum_required': {
          const i = a.indexOf('VERSION');
          const v = i >= 0 ? a[i + 1]?.split('...')[0] : null;
          if (v) out.add('toolchain', 'CMake', v, `CMake ≥ ${v}`, mod, at(c));
          break;
        }
        case 'project':
        case 'enable_language':
          if (a.slice(c.name === 'project' ? 1 : 0).includes('CUDA')) out.add('sdk', 'CUDA', null, 'CMake 啟用 CUDA 語言（需要 nvcc）', mod, at(c));
          break;
        case 'find_package': {
          const name = a[0];
          if (!name) break;
          const mapped = name.toLowerCase() in PKG_MAP ? PKG_MAP[name.toLowerCase()] : { kind: 'library' as const, name, version: null };
          if (!mapped) break;
          const ver = a[1] && /^\d+(\.\d+)*$/.test(a[1]) ? a[1] : mapped.version;
          const ci = a.findIndex((x) => x === 'COMPONENTS' || x === 'REQUIRED');
          const comps = ci >= 0 ? a.slice(ci + 1).filter((x) => /^[\w-]+$/.test(x) && !/^(REQUIRED|COMPONENTS|QUIET|CONFIG|MODULE|OPTIONAL_COMPONENTS)$/.test(x)) : [];
          const optional = cmakeOptional(t, c, `${name}_FOUND`);
          const notes = [optional ? '選用（找不到時停用相關功能）' : null, comps.length ? `元件：${comps.join(', ')}` : null].filter(Boolean);
          out.add(mapped.kind, mapped.name, ver, notes.length ? notes.join('；') : null, mod, at(c));
          break;
        }
        case 'find_library': {
          const ni = a.indexOf('NAMES');
          const names = ni >= 0 ? a.slice(ni + 1).filter((x) => !/^[A-Z_]+$/.test(x) || x === x.toLowerCase()) : a.slice(1, 2);
          const lib = names[0];
          if (!lib) break;
          const hit = libFromName(lib);
          if (!hit) break;
          const optional = a.includes('QUIET') || cmakeOptional(t, c, a[0] ?? null);
          out.add(hit.kind, hit.name, hit.version, [hit.note, optional ? '選用（找不到時停用相關功能）' : null].filter(Boolean).join('；') || null, mod, at(c));
          break;
        }
        case 'find_path': {
          const ni = a.indexOf('NAMES');
          const h = ni >= 0 ? a[ni + 1] : a[1];
          const hit = h ? libFromHeader(h) : null;
          if (!hit) break;
          const optional = a.includes('QUIET') || cmakeOptional(t, c, a[0] ?? null);
          out.add(hit.kind, hit.name, hit.version, [hit.note, optional ? '選用（找不到時停用相關功能）' : null].filter(Boolean).join('；') || null, mod, at(c));
          break;
        }
        case 'set':
        case 'set_property':
        case 'set_target_properties': {
          if (c.name === 'set' && a[0] === 'CMAKE_CXX_STANDARD' && /^\d+$/.test(a[1] ?? '')) std(Number(a[1]), at(c));
          const ai = c.name === 'set' ? (a[0] === 'CMAKE_CUDA_ARCHITECTURES' ? 0 : -1) : a.indexOf('CUDA_ARCHITECTURES');
          if (ai >= 0) {
            const sms = a
              .slice(ai + 1)
              .flatMap((x) => x.split(';'))
              .map((x) => /^(\d+)(-real|-virtual)?$/.exec(x)?.[1])
              .filter((x): x is string => !!x)
              .map(Number);
            if (sms.length) {
              const min = Math.min(...sms);
              out.add('gpu', `最低 GPU 架構 sm_${min}`, `${Math.floor(min / 10)}.${min % 10}`, gpuNote(min), mod, at(c));
            } else if (a.slice(ai + 1).some((x) => /\$\{|native|all/.test(x))) {
              out.add('sdk', 'CUDA', null, 'GPU 架構於建置時依本機 GPU 決定（CUDA_ARCHITECTURES）', mod, at(c));
            }
          }
          break;
        }
        case 'target_compile_features':
          for (const x of a) {
            const s = /^cxx_std_(\d+)$/.exec(x);
            if (s) std(Number(s[1]), at(c));
          }
          break;
        case 'target_compile_options':
        case 'add_compile_options':
          for (const x of a) {
            const s = /-std=(?:c|gnu)\+\+(\d+)/.exec(x);
            if (s) std(Number(s[1]), at(c));
          }
          break;
      }
    }
    if (cxxStd && cxxEv) out.add('toolchain', `C++${cxxStd}`, String(cxxStd), `編譯器需支援 C++${cxxStd}`, mod, cxxEv);
  }
}

const MIL_CALL_RE = /\bM(app|sys|dig|buf|disp|im|blob|pat|mod|meas|code|ocr|cal|gra|reg|str|col|edge|met|seq)[A-Z]\w*\s*\(/g;
const MIL_BOARD_RE = /^M_SYSTEM_(RAPIXO|RADIENT|SOLIOS|CONCORD|GIGE_VISION|USB3_VISION|CLARITY|MORPHIS|IRIS|GENTL|HOST_?CXP|INDIO|ORION)/;
const MIL_LICENSED: Record<string, string> = {
  blob: 'Blob 分析',
  pat: 'Pattern Matching',
  mod: 'Model Finder',
  meas: 'Measurement',
  code: 'Code Reader',
  ocr: 'OCR',
  cal: 'Calibration',
  reg: 'Registration',
  str: 'String Reader',
  col: 'Color',
  edge: 'Edge Finder',
  met: 'Metrology',
};

interface MilUse {
  include: Evidence[];
  calls: Map<string, { n: number; e: Evidence }>;
  systems: Map<string, Evidence>;
  dig: Evidence | null;
  getError: Evidence | null;
}

function milReqs(ctx: RepoCtx, arch: Architecture, out: ReqSet): void {
  const files = codeFiles(ctx, new Set(['c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx', 'cs', 'cu']));
  const use = new Map<string, MilUse>();
  let version: string | null = null;
  let versionEv: Evidence | null = null;
  for (const f of files) {
    const fc = ctx.read(f);
    if (!fc || !/\bM(?:app|sys|dig|buf|disp|im|blob|pat|mod|meas|code|ocr|cal|gra|reg|str|col|edge|met|seq)[A-Z]|[Mm][Ii][Ll]\.h|MatroxImagingLibrary|M_SYSTEM_/.test(fc.text)) continue;
    const key = arch.unitOf(f) ?? '';
    const u = (): MilUse => {
      if (!use.has(key)) use.set(key, { include: [], calls: new Map(), systems: new Map(), dig: null, getError: null });
      return use.get(key)!;
    };
    fc.lines.forEach((line, i) => {
      if (/#\s*include\s*[<"](?:.*\/)?mil\.h[>"]/i.test(line) || /^\s*using\s+Matrox\.MatroxImagingLibrary/.test(line)) {
        u().include.push(ev(f, i + 1, line));
        const hint = /mil\s*(x|10)\b/i.exec(line);
        if (hint && !version) version = hint[1]!.toUpperCase();
      }
      const vm = /\b(?:M_MIL_CURRENT_VERSION|MIL_VERSION)\s+([\d.]+)/.exec(line);
      if (vm && /#\s*define/.test(line)) [version, versionEv] = [vm[1]!, ev(f, i + 1, line)];
      // calls in comments (「同 MimRemap 的做法」) are not MIL use
      const t = line.trim();
      if (t.startsWith('*') || t.startsWith('/*')) return;
      const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      if (!/\bM[a-z]/.test(code) && !code.includes('M_SYSTEM_')) return;
      for (const m of code.matchAll(MIL_CALL_RE)) {
        const p = m[1]!;
        const c = u().calls.get(p);
        if (c) c.n++;
        else u().calls.set(p, { n: 1, e: ev(f, i + 1, line) });
        if (/^MdigAlloc\b/.test(m[0]) && !u().dig) u().dig = ev(f, i + 1, line);
        if (/^MappGetError\b/.test(m[0]) && !u().getError) u().getError = ev(f, i + 1, line);
      }
      for (const s of code.matchAll(/\bM_SYSTEM_[A-Z0-9_]+/g)) if (!u().systems.has(s[0])) u().systems.set(s[0], ev(f, i + 1, line));
    });
  }
  // install-path hints (C:\Program Files\Matrox Imaging\MIL X) in the project files
  if (!version) {
    for (const f of ctx.files.filter((f) => extOf(f) === 'vcxproj' || extOf(f) === 'csproj')) {
      const h = /Matrox Imaging\\?(?:\\|\/)?\s*Mil\s*(X|10)?/i.exec(ctx.read(f)?.text ?? '') ?? /\bMIL\s?(X|10)\b/.exec(ctx.read(f)?.text ?? '');
      if (h?.[1]) {
        version = h[1].toUpperCase();
        break;
      }
    }
  }
  const dcf = ctx.files.filter((f) => extOf(f) === 'dcf');

  for (const [key, u] of use) {
    const total = [...u.calls.values()].reduce((a, c) => a + c.n, 0);
    if (!u.include.length && total < 2) continue;
    const mod = key || null;
    const prefixes = [...u.calls.entries()].sort((a, b) => b[1].n - a[1].n);
    const boards = [...u.systems.keys()].filter((s) => MIL_BOARD_RE.test(s));
    const hostOnly = !boards.length && [...u.systems.keys()].every((s) => s === 'M_SYSTEM_HOST' || s === 'M_SYSTEM_DEFAULT') && u.systems.has('M_SYSTEM_HOST');
    const notes = [prefixes.length ? `使用模組：${prefixes.map(([p]) => 'M' + p).join('、')}` : null, hostOnly ? '可在沒有擷取卡的機台跑（M_SYSTEM_HOST）' : null];
    const evs = [...u.include.slice(0, 1), ...prefixes.slice(0, 2).map(([, c]) => c.e)];
    if (versionEv) evs.push(versionEv);
    out.add('library', 'MIL', version, notes.filter(Boolean).join('；') || null, mod, evs);

    const licensed = prefixes.map(([p]) => MIL_LICENSED[p]).filter((x): x is string => !!x);
    for (const b of boards) out.add('hardware', `Matrox 擷取卡（${b}）`, null, '需要 Matrox 擷取卡與 MIL runtime 授權', mod, u.systems.get(b)!);
    if (boards.length || licensed.length) {
      const name = licensed.length ? `MIL runtime 授權（含 ${licensed.join('、')}）` : 'MIL runtime 授權';
      const lev = [...boards.map((b) => u.systems.get(b)!), ...prefixes.filter(([p]) => MIL_LICENSED[p]).map(([, c]) => c.e)];
      out.add('license', name, version, boards.length ? '擷取卡機台需安裝 MIL runtime 並啟用授權' : '影像分析模組需要 MIL runtime 授權', mod, lev);
    }
    if (u.dig) {
      const myDcf = dcf.filter((d) => (arch.unitOf(d) ?? '') === key || !mod);
      out.add('hardware', '相機', null, `需要相機（MdigAlloc）${myDcf.length ? `；相機設定檔：${myDcf.map(baseOf).join('、')}` : ''}`, mod, [u.dig, ...myDcf.slice(0, 2).map((d) => ev(d, null, null))]);
    }
  }
  // camera config files without any MdigAlloc seen
  for (const d of dcf) {
    const mod = arch.unitOf(d);
    const has = use.get(mod ?? '')?.dig;
    if (!has) out.add('hardware', '相機', null, `相機設定檔：${baseOf(d)}`, mod, ev(d, null, null));
  }
}

function tfmInfo(tfm: string): { name: string; version: string; windows: boolean } | null {
  const t = tfm.trim().toLowerCase();
  let m = /^net(\d)(\d)(\d)?$/.exec(t);
  if (m) return { name: '.NET Framework', version: `${m[1]}.${m[2]}${m[3] ? '.' + m[3] : ''}`, windows: true };
  m = /^v(\d+(?:\.\d+)+)$/.exec(t);
  if (m) return { name: '.NET Framework', version: m[1]!, windows: true };
  m = /^netcoreapp(\d+\.\d+)$/.exec(t);
  if (m) return { name: '.NET Core', version: m[1]!, windows: false };
  m = /^netstandard(\d+\.\d+)$/.exec(t);
  if (m) return { name: '.NET Standard', version: m[1]!, windows: false };
  m = /^net(\d+\.\d+)(-(\w+))?/.exec(t);
  if (m) return { name: '.NET', version: m[1]!, windows: m[3] === 'windows' };
  return null;
}

const PKG_FAMILIES = ['Avalonia', 'Microsoft.Extensions', 'OpenCvSharp4', 'OpenCvSharp', 'Emgu.CV', 'CommunityToolkit', 'xunit', 'NUnit', 'MSTest', 'Serilog', 'NLog', 'Microsoft.ML.OnnxRuntime'];

function csprojReqs(ctx: RepoCtx, arch: Architecture, out: ReqSet): void {
  for (const f of ctx.files.filter((f) => /^(csproj|vbproj|fsproj)$/.test(extOf(f)) && depthOf(f) <= MAX_DEPTH)) {
    const t = ctx.read(f)?.text;
    if (!t) continue;
    const mod = arch.unitOf(f) ?? baseOf(f).replace(/\.\w+proj$/, '');
    const at = (i: number) => {
      const n = ctx.lineAt(f, i);
      return ev(f, n, lineText(ctx, f, n));
    };
    const outType = xmlEls(t, 'OutputType')[0];
    const winExe = !!outType && /^WinExe$/i.test(outType.value);
    for (const tag of ['TargetFramework', 'TargetFrameworks', 'TargetFrameworkVersion']) {
      for (const e of xmlEls(t, tag)) {
        for (const tfm of e.value.split(';').filter(Boolean)) {
          const info = tfmInfo(tfm);
          if (!info) continue;
          const major = info.version.replace(/\.0$/, '');
          out.add('runtime', info.name, info.version, `${info.name} ${major} 執行環境`, mod, at(e.index));
          if (info.windows) out.add('os', 'Windows', null, `目標框架 ${tfm} 只能在 Windows 執行`, mod, at(e.index));
        }
      }
    }
    for (const tag of ['PlatformTarget', 'Platforms']) {
      for (const e of xmlEls(t, tag)) for (const p of e.value.split(';')) if (/^(x64|x86|ARM64)$/i.test(p.trim())) out.add('arch', p.trim(), null, null, mod, at(e.index));
    }
    for (const tag of ['RuntimeIdentifier', 'RuntimeIdentifiers']) {
      for (const e of xmlEls(t, tag)) {
        for (const rid of e.value.split(';')) {
          const m = /^(win|linux|osx)-(x64|x86|arm64)$/.exec(rid.trim());
          if (!m) continue;
          out.add('os', m[1] === 'win' ? 'Windows' : m[1] === 'linux' ? 'Linux' : 'macOS', null, `發行目標 ${rid.trim()}`, mod, at(e.index));
          out.add('arch', m[2] === 'arm64' ? 'ARM64' : m[2]!, null, null, mod, at(e.index));
        }
      }
    }
    for (const [tag, name] of [['UseWindowsForms', 'WinForms'], ['UseWPF', 'WPF']] as const) {
      const e = xmlEls(t, tag).find((x) => /^true$/i.test(x.value));
      if (e) {
        out.add('library', name, null, 'Windows GUI 框架', mod, at(e.index));
        out.add('os', 'Windows', null, `${name} 只能在 Windows 執行`, mod, at(e.index));
      }
    }
    for (const e of xmlEls(t, 'PackageReference')) {
      const inc = e.attrs.Include ?? e.attrs.Update;
      if (!inc) continue;
      const version = e.attrs.Version ?? (/<Version>([^<]+)<\/Version>/.exec(e.body)?.[1] ?? null);
      const fam = PKG_FAMILIES.find((p) => inc === p || inc.startsWith(p + '.')) ?? inc;
      const note = fam === 'Avalonia' ? `GUI 框架（跨平台）${winExe ? '，需要桌面環境' : ''}` : fam !== inc ? `NuGet ${fam}.*` : null;
      out.add('library', fam, version, note, mod, at(e.index));
    }
    for (const e of xmlEls(t, 'Reference')) {
      const inc = (e.attrs.Include ?? '').split(',')[0]!.trim();
      if (!inc || !/<HintPath>/i.test(e.body)) continue;
      if (/^Matrox\.MatroxImagingLibrary/i.test(inc)) out.add('library', 'MIL', null, 'MIL .NET 參考（Matrox.MatroxImagingLibrary）', mod, at(e.index));
      else if (!/^(System|Microsoft)\b/.test(inc)) out.add('library', inc, null, '以 HintPath 參考的 DLL', mod, at(e.index));
    }
  }
  for (const f of ctx.files.filter((f) => baseOf(f).toLowerCase() === 'packages.config')) {
    const t = ctx.read(f)?.text ?? '';
    const mod = arch.unitOf(f);
    for (const m of t.matchAll(/<package\s+id="([^"]+)"\s+version="([^"]+)"/g)) {
      const n = ctx.lineAt(f, m.index!);
      const fam = PKG_FAMILIES.find((p) => m[1] === p || m[1]!.startsWith(p + '.')) ?? m[1]!;
      out.add('library', fam, m[2]!, null, mod, ev(f, n, lineText(ctx, f, n)));
    }
  }
}

const PY_IMPORT_MAP: Record<string, string> = {
  cv2: 'opencv-python',
  numpy: 'numpy',
  onnxruntime: 'onnxruntime',
  torch: 'torch',
  torchvision: 'torchvision',
  tensorflow: 'tensorflow',
  scipy: 'scipy',
  pandas: 'pandas',
  matplotlib: 'matplotlib',
  PIL: 'Pillow',
  serial: 'pyserial',
  yaml: 'PyYAML',
  sklearn: 'scikit-learn',
  requests: 'requests',
  skimage: 'scikit-image',
  pypylon: 'pypylon',
  harvesters: 'harvesters',
  aravis: 'aravis',
  zmq: 'pyzmq',
  flask: 'Flask',
  fastapi: 'fastapi',
  pytest: 'pytest',
};
const PY_NOTES: Record<string, string> = {
  'opencv-python': 'OpenCV Python 套件',
  'opencv-python-headless': 'OpenCV Python 套件（無 GUI）',
  'opencv-contrib-python': 'OpenCV Python 套件（含 contrib）',
};

function pyReqLine(line: string): { name: string; version: string | null } | null {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*((?:===|==|>=|<=|~=|!=|>|<)\s*[^;#\s,]+(?:\s*,\s*(?:===|==|>=|<=|~=|!=|>|<)\s*[^;#\s,]+)*)?/.exec(line);
  if (!m) return null;
  const spec = m[3]?.replace(/\s+/g, '') ?? null;
  const version = spec ? (/^==([^,]+)$/.exec(spec)?.[1] ?? spec) : null;
  return { name: m[1]!, version };
}

function cudaFromTorch(s: string): string | null {
  const m = /\bcu(\d{2,3})\b/.exec(s);
  if (!m) return null;
  const d = m[1]!;
  return `${d.slice(0, d.length - 1)}.${d.slice(-1)}`;
}

function pythonReqs(ctx: RepoCtx, arch: Architecture, out: ReqSet): void {
  const manifestDirs = new Set<string>();
  const pyVersion = new Map<string | null, { v: string | null; e: Evidence }>();
  const addDep = (f: string, n: number, line: string, name: string, version: string | null) => {
    const mod = arch.unitOf(f);
    const e = ev(f, n, line);
    out.add('library', name, version, PY_NOTES[name.toLowerCase()] ?? null, mod, e);
    const cu = /^torch/i.test(name) ? cudaFromTorch(line) : null;
    if (cu) out.add('sdk', 'CUDA', cu, `PyTorch CUDA ${cu} 版`, mod, e);
  };
  for (const f of ctx.files.filter((f) => depthOf(f) <= MAX_DEPTH)) {
    const b = baseOf(f);
    if (/^requirements[\w.-]*\.(txt|in)$/i.test(b) || (/\.txt$/i.test(b) && baseOf(dirOf(f)) === 'requirements')) {
      manifestDirs.add(dirOf(f));
      (ctx.read(f)?.lines ?? []).forEach((l, i) => {
        const s = l.trim();
        if (!s || s.startsWith('#')) return;
        if (s.startsWith('-')) {
          const cu = /index-url/.test(s) ? cudaFromTorch(s) : null;
          if (cu) out.add('sdk', 'CUDA', cu, `PyTorch CUDA ${cu} 版`, arch.unitOf(f), ev(f, i + 1, s));
          return;
        }
        const r = pyReqLine(s);
        if (r) addDep(f, i + 1, s, r.name, r.version);
      });
    } else if (b === 'pyproject.toml') {
      const fc = ctx.read(f);
      if (!fc) continue;
      manifestDirs.add(dirOf(f));
      let inDeps = false;
      let section = '';
      fc.lines.forEach((l, i) => {
        const s = l.trim();
        const sec = /^\[([^\]]+)\]/.exec(s);
        if (sec) {
          section = sec[1]!;
          inDeps = false;
          return;
        }
        const rp = /^requires-python\s*=\s*["']([^"']+)["']/.exec(s);
        if (rp) pyVersion.set(arch.unitOf(f), { v: rp[1]!, e: ev(f, i + 1, s) });
        if (section === 'tool.poetry.dependencies') {
          const pm = /^([\w.-]+)\s*=\s*["']([^"']+)["']/.exec(s);
          if (pm && pm[1] === 'python') pyVersion.set(arch.unitOf(f), { v: pm[2]!, e: ev(f, i + 1, s) });
          else if (pm) addDep(f, i + 1, s, pm[1]!, pm[2]!);
          return;
        }
        if (section === 'project' && /^dependencies\s*=\s*\[/.test(s)) inDeps = true;
        if (inDeps) {
          for (const q of s.matchAll(/["']([^"']+)["']/g)) {
            const r = pyReqLine(q[1]!);
            if (r) addDep(f, i + 1, s, r.name, r.version);
          }
          if (s.includes(']')) inDeps = false;
        }
      });
    } else if (b === 'setup.py') {
      const fc = ctx.read(f);
      if (!fc) continue;
      manifestDirs.add(dirOf(f));
      const ir = /install_requires\s*=\s*\[([^\]]*)\]/s.exec(fc.text);
      if (ir) {
        for (const q of ir[1]!.matchAll(/["']([^"']+)["']/g)) {
          const r = pyReqLine(q[1]!);
          const n = ctx.lineAt(f, ir.index + ir[0].indexOf(q[0]));
          if (r) addDep(f, n, lineText(ctx, f, n), r.name, r.version);
        }
      }
      const pr = /python_requires\s*=\s*["']([^"']+)["']/.exec(fc.text);
      if (pr) {
        const n = ctx.lineAt(f, pr.index);
        pyVersion.set(arch.unitOf(f), { v: pr[1]!, e: ev(f, n, lineText(ctx, f, n)) });
      }
    } else if (/^environment\.ya?ml$/.test(b)) {
      const fc = ctx.read(f);
      if (!fc) continue;
      manifestDirs.add(dirOf(f));
      fc.lines.forEach((l, i) => {
        const m = /^\s*-\s+([A-Za-z0-9][\w.-]*)\s*(?:(==?|>=|<=)\s*([\w.*]+))?\s*$/.exec(l);
        if (!m) return;
        const name = m[1]!;
        const v = m[3] ?? null;
        if (name === 'python') pyVersion.set(arch.unitOf(f), { v, e: ev(f, i + 1, l) });
        else if (/^(cudatoolkit|cuda-toolkit|cuda-version)$/.test(name)) out.add('sdk', 'CUDA', v, 'conda 環境的 CUDA', arch.unitOf(f), ev(f, i + 1, l));
        else if (name !== 'pip') addDep(f, i + 1, l.trim(), name, v);
      });
    }
  }

  // a Python runtime per module with .py files; imports stand in for a missing manifest
  const py = codeFiles(ctx, new Set(['py']));
  const runtimeSeen = new Set<string | null>();
  const hasManifest = (f: string) => {
    for (let d = dirOf(f); ; d = dirOf(d)) {
      if (manifestDirs.has(d)) return true;
      if (d === '.') return false;
    }
  };
  for (const f of py) {
    const mod = arch.unitOf(f);
    if (!runtimeSeen.has(mod)) {
      runtimeSeen.add(mod);
      const pv = pyVersion.get(mod) ?? pyVersion.get(null);
      out.add('runtime', 'Python', pv?.v ?? null, null, mod, pv?.e ?? ev(f, null, null));
    }
    if (hasManifest(f)) continue;
    const fc = ctx.read(f);
    if (!fc) continue;
    fc.lines.forEach((l, i) => {
      const m = /^\s*(?:import|from)\s+([A-Za-z_]\w*)/.exec(l);
      const pkg = m ? PY_IMPORT_MAP[m[1]!] : undefined;
      if (pkg) out.add('library', pkg, null, `${PY_NOTES[pkg] ? PY_NOTES[pkg] + '；' : ''}由 import 推得（沒有 requirements）`, mod, ev(f, i + 1, l));
    });
  }
}

function includeReqs(ctx: RepoCtx, arch: Architecture, out: ReqSet): void {
  for (const f of codeFiles(ctx, CPP_EXT)) {
    const mod = arch.unitOf(f);
    if (extOf(f) === 'cu' || extOf(f) === 'cuh') out.add('sdk', 'CUDA', null, 'CUDA 原始碼（需要 nvcc 與 NVIDIA GPU）', mod, ev(f, null, null));
    const fc = ctx.read(f);
    if (!fc || !fc.text.includes('#')) continue;
    const winGuarded = /\b_WIN32\b|\b_MSC_VER\b/.test(fc.text);
    const seen = new Set<string>();
    fc.lines.forEach((l, i) => {
      const m = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/.exec(l);
      if (!m) return;
      const h = m[1]!;
      if (/^windows\.h$/i.test(h)) {
        if (!winGuarded) out.add('os', 'Windows', null, '使用 Win32 API（windows.h）', mod, ev(f, i + 1, l));
        return;
      }
      const hit = libFromHeader(h);
      if (!hit || seen.has(hit.name)) return;
      seen.add(hit.name);
      out.add(hit.kind, hit.name, hit.version, hit.note ?? null, mod, ev(f, i + 1, l));
    });
  }
}

export function analyseRequirements(ctx: RepoCtx, arch: Architecture): Requirement[] {
  const out = new ReqSet();
  const steps: Array<[string, (c: RepoCtx, a: Architecture, o: ReqSet) => void]> = [
    ['vcxproj', vcxproj],
    ['cmake', cmakeReqs],
    ['csproj', csprojReqs],
    ['mil', milReqs],
    ['python', pythonReqs],
    ['includes', includeReqs],
  ];
  for (const [name, fn] of steps) {
    try {
      fn(ctx, arch, out);
    } catch (e) {
      ctx.warnings.push(`需求分析（${name}）失敗：${(e as Error).message}`);
    }
  }
  return out.list();
}
