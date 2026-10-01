import { baseOf, codeFiles, depthOf, dirOf, ev, extOf, joinRel, langOf, lineText, under, type RepoCtx } from './context.js';
import { genexValue, parseCMake, parseSln, xmlEls, type CMakeCmd } from './parse.js';
import type { Evidence, ModuleInfo } from './types.js';

/**
 * 架構: the modules of a checkout — Visual Studio / .NET projects, CMake targets, Python
 * packages, and the top-level directories with code nothing else claims — with what each one
 * builds, what it links against and where it starts.
 */

export interface Architecture {
  modules: ModuleInfo[];
  /** the module a file belongs to (longest path; a CMake target that lists the file wins), or null */
  ownerOf(file: string): string | null;
  /** like ownerOf, but all CMake targets of one CMakeLists collapse into its main target (requirements are per build, not per test exe) */
  unitOf(file: string): string | null;
  /** files a module lists explicitly (CMake sources, project items) */
  sources: Map<string, Set<string>>;
  /** CMake project() name per CMakeLists dir */
  cmakeProjects: Map<string, string>;
  /** the CMakeLists.txt files parsed, with their commands */
  cmake: Map<string, CMakeCmd[]>;
}

const MAX_DEPTH = 4;
const MAIN_RE = /\b(?:int|void|auto)\s+(?:w?main|_tmain|w?WinMain|wWinMain)\s*\(/;
const CS_MAIN_RE = /\bstatic\s+(?:async\s+)?(?:void|int|Task(?:<int>)?)\s+Main\s*\(/;
const PY_MAIN_RE = /^if\s+__name__\s*==\s*['"]__main__['"]\s*:/m;

export function hasMain(ctx: RepoCtx, file: string): boolean {
  const t = ctx.read(file)?.text;
  if (!t) return false;
  const e = extOf(file);
  if (e === 'cs') return CS_MAIN_RE.test(t);
  if (e === 'py') return PY_MAIN_RE.test(t) || baseOf(file) === '__main__.py';
  return MAIN_RE.test(t);
}

const filesUnder = (ctx: RepoCtx, dir: string) => ctx.files.filter((f) => under(f, dir));

function dominantLang(files: string[]): string | null {
  const counts = new Map<string, number>();
  for (const f of files) {
    const l = langOf(f);
    if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
  }
  // CUDA projects are C++ projects with kernels; call them cuda only when .cu files are a real share
  const cuda = counts.get('cuda') ?? 0;
  const cpp = counts.get('cpp') ?? 0;
  if (cuda && cpp && cuda < cpp) counts.delete('cuda');
  let best: string | null = null;
  let n = 0;
  for (const [l, c] of counts) if (c > n || (c === n && best !== null && l < best)) [best, n] = [l, c];
  return best;
}

/** `set(VAR …)` / `list(APPEND VAR …)` of one CMakeLists, for expanding `${VAR}` source lists */
export function cmakeVars(cmds: CMakeCmd[]): Map<string, string[]> {
  const vars = new Map<string, string[]>();
  for (const c of cmds) {
    if (c.name === 'set' && c.args.length >= 1) {
      const vals = c.args.slice(1);
      const cacheAt = vals.findIndex((v) => v === 'CACHE' || v === 'PARENT_SCOPE');
      vars.set(c.args[0]!, cacheAt >= 0 ? vals.slice(0, cacheAt) : vals);
    } else if (c.name === 'list' && c.args[0] === 'APPEND' && c.args[1]) {
      vars.set(c.args[1], [...(vars.get(c.args[1]) ?? []), ...c.args.slice(2)]);
    }
  }
  return vars;
}

export function expandArgs(args: string[], vars: Map<string, string[]>, project: string | null): string[] {
  const out: string[] = [];
  for (const a of args) {
    const m = /^\$\{(\w+)\}$/.exec(a);
    if (m && vars.has(m[1]!)) out.push(...vars.get(m[1]!)!);
    else out.push(project ? a.replace(/\$\{PROJECT_NAME\}/g, project) : a);
  }
  return out;
}

const CMAKE_TARGET_KW = new Set(['WIN32', 'MACOSX_BUNDLE', 'EXCLUDE_FROM_ALL', 'STATIC', 'SHARED', 'MODULE', 'OBJECT', 'INTERFACE', 'IMPORTED', 'ALIAS', 'GLOBAL']);
const LINK_KW = new Set(['PRIVATE', 'PUBLIC', 'INTERFACE', 'LINK_PRIVATE', 'LINK_PUBLIC', 'LINK_INTERFACE_LIBRARIES', 'debug', 'optimized', 'general']);

export function analyseArchitecture(ctx: RepoCtx): Architecture {
  const modules: ModuleInfo[] = [];
  const sources = new Map<string, Set<string>>();
  const cmakeProjects = new Map<string, string>();
  const cmake = new Map<string, CMakeCmd[]>();
  const slnEvidence = new Map<string, Evidence>();

  // --- .sln: which project files the solution names (evidence only; the projects parse below)
  for (const sln of ctx.files.filter((f) => extOf(f) === 'sln' && depthOf(f) <= MAX_DEPTH)) {
    const t = ctx.read(sln)?.text;
    if (!t) continue;
    for (const p of parseSln(t)) slnEvidence.set(joinRel(dirOf(sln), p.path), ev(sln, p.line, lineText(ctx, sln, p.line)));
  }

  // --- Visual C++ projects
  for (const f of ctx.files.filter((f) => extOf(f) === 'vcxproj' && depthOf(f) <= MAX_DEPTH)) {
    const t = ctx.read(f)?.text;
    if (!t) continue;
    const dir = dirOf(f);
    const name = baseOf(f).replace(/\.vcxproj$/i, '');
    const items = ['ClCompile', 'ClInclude', 'CudaCompile']
      .flatMap((tag) => xmlEls(t, tag))
      .map((e) => e.attrs.Include)
      .filter((s): s is string => !!s && !s.includes('$('))
      .map((s) => joinRel(dir, s));
    const cfgType = xmlEls(t, 'ConfigurationType')[0]?.value ?? '';
    const sub = xmlEls(t, 'SubSystem')[0]?.value ?? '';
    const output: ModuleInfo['output'] =
      /^Application$/i.test(cfgType) ? (/^Windows$/i.test(sub) ? 'gui_exe' : 'exe') : /^DynamicLibrary$/i.test(cfgType) ? 'dll' : /^StaticLibrary$/i.test(cfgType) ? 'lib' : null;
    const deps = xmlEls(t, 'ProjectReference').map((e) => baseOf((e.attrs.Include ?? '').replace(/\\/g, '/')).replace(/\.\w+proj$/i, '')).filter(Boolean);
    const tracked = items.filter((i) => ctx.fileSet.has(i));
    const evidence = [ev(f, 1, `${name}.vcxproj ${cfgType || ''}`.trim())];
    if (slnEvidence.has(f)) evidence.unshift(slnEvidence.get(f)!);
    sources.set(name, new Set(tracked));
    const all = filesUnder(ctx, dir);
    modules.push({
      name,
      path: dir,
      kind: 'vs_project',
      language: dominantLang(tracked.length ? tracked : all) ?? 'cpp',
      output,
      depends_on: [...new Set(deps)],
      entry_points: (tracked.length ? tracked : all).filter((s) => /\.(c|cc|cpp|cxx|cu)$/i.test(s) && hasMain(ctx, s)),
      files: all.length,
      evidence,
    });
  }

  // --- .NET projects
  for (const f of ctx.files.filter((f) => /^(csproj|vbproj|fsproj)$/.test(extOf(f)) && depthOf(f) <= MAX_DEPTH)) {
    const t = ctx.read(f)?.text;
    if (!t) continue;
    const dir = dirOf(f);
    const name = baseOf(f).replace(/\.\w+proj$/i, '');
    const outType = xmlEls(t, 'OutputType')[0]?.value ?? '';
    const gui = /^WinExe$/i.test(outType);
    const output: ModuleInfo['output'] = gui ? 'gui_exe' : /^Exe$/i.test(outType) ? 'exe' : 'dll';
    const deps = xmlEls(t, 'ProjectReference').map((e) => baseOf((e.attrs.Include ?? '').replace(/\\/g, '/')).replace(/\.\w+proj$/i, '')).filter(Boolean);
    const all = filesUnder(ctx, dir);
    const code = all.filter((s) => extOf(s) === 'cs');
    const entry = code.filter((s) => /^(Program|App\.axaml|App\.xaml)\.cs$/i.test(baseOf(s)) || hasMain(ctx, s));
    const evidence = [ev(f, null, outType ? `<OutputType>${outType}</OutputType>` : name)];
    if (slnEvidence.has(f)) evidence.unshift(slnEvidence.get(f)!);
    const ot = xmlEls(t, 'OutputType')[0];
    if (ot) evidence[evidence.length - 1] = ev(f, ctx.lineAt(f, ot.index), lineText(ctx, f, ctx.lineAt(f, ot.index)));
    modules.push({
      name,
      path: dir,
      kind: 'csproj',
      language: extOf(f) === 'csproj' ? 'csharp' : extOf(f) === 'vbproj' ? 'vb' : 'fsharp',
      output,
      depends_on: [...new Set(deps)],
      entry_points: entry,
      files: all.length,
      evidence,
    });
  }

  // --- CMake targets
  const cmakeFiles = ctx.files.filter((f) => baseOf(f) === 'CMakeLists.txt' && depthOf(f) <= MAX_DEPTH);
  const targetNames = new Set<string>();
  const pendingLinks: Array<{ name: string; items: string[] }> = [];
  for (const f of cmakeFiles) {
    const t = ctx.read(f)?.text;
    if (!t) continue;
    const cmds = parseCMake(t);
    cmake.set(f, cmds);
    const dir = dirOf(f);
    const proj = cmds.find((c) => c.name === 'project')?.args[0] ?? null;
    if (proj) cmakeProjects.set(dir, proj);
    const vars = cmakeVars(cmds);
    for (const c of cmds) {
      if (c.name !== 'add_executable' && c.name !== 'add_library') continue;
      const args = expandArgs(c.args, vars, proj);
      const name = args[0];
      if (!name || name.includes('${') || args.includes('IMPORTED') || args.includes('ALIAS')) continue;
      const rest = args.slice(1);
      const output: ModuleInfo['output'] =
        c.name === 'add_executable' ? (rest.includes('WIN32') ? 'gui_exe' : 'exe') : rest.includes('SHARED') || rest.includes('MODULE') ? 'dll' : 'lib';
      const srcs = rest
        .filter((a) => !CMAKE_TARGET_KW.has(a))
        .map(genexValue)
        .map((a) => a.replace(/^\$\{CMAKE_CURRENT_SOURCE_DIR\}\//, '').replace(/^\$\{CMAKE_CURRENT_LIST_DIR\}\//, ''))
        .filter((a) => a && !a.includes('${'))
        .map((a) => joinRel(dir, a));
      const tracked = srcs.filter((s) => ctx.fileSet.has(s));
      sources.set(name, new Set(tracked));
      targetNames.add(name);
      modules.push({
        name,
        path: dir,
        kind: 'cmake_target',
        language: dominantLang(tracked.length ? tracked : filesUnder(ctx, dir)),
        output,
        depends_on: [],
        entry_points: tracked.filter((s) => !/\.(h|hh|hpp|hxx|cuh)$/i.test(s) && hasMain(ctx, s)),
        files: tracked.length || filesUnder(ctx, dir).length,
        evidence: [ev(f, c.line, lineText(ctx, f, c.line))],
      });
    }
    for (const c of cmds) {
      if (c.name === 'target_sources' && c.args[0]) {
        const set = sources.get(c.args[0]);
        if (set) for (const a of expandArgs(c.args.slice(1), vars, proj).map(genexValue)) if (a && !LINK_KW.has(a)) set.add(joinRel(dir, a));
      }
      if ((c.name === 'target_link_libraries' || c.name === 'add_dependencies') && c.args[0]) {
        pendingLinks.push({ name: expandArgs([c.args[0]], vars, proj)[0]!, items: expandArgs(c.args.slice(1), vars, proj).map(genexValue) });
      }
    }
  }
  for (const { name, items } of pendingLinks) {
    const m = modules.find((x) => x.kind === 'cmake_target' && x.name === name);
    if (!m) continue;
    for (const i of items) if (targetNames.has(i) && i !== name && !m.depends_on.includes(i)) m.depends_on.push(i);
  }

  // --- Python packages: pyproject / setup.py dirs, then top-most __init__.py dirs not under those
  const pyRoots: string[] = [];
  for (const f of ctx.files.filter((f) => (baseOf(f) === 'pyproject.toml' || baseOf(f) === 'setup.py') && depthOf(f) <= MAX_DEPTH)) {
    const dir = dirOf(f);
    if (pyRoots.includes(dir)) continue;
    const t = ctx.read(f)?.text ?? '';
    // a pyproject.toml that only configures tools (ruff/black) is not a package
    if (baseOf(f) === 'pyproject.toml' && !/^\[(project|tool\.poetry)\]/m.test(t)) continue;
    pyRoots.push(dir);
    const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(t)?.[1] ?? (dir === '.' ? baseOf(ctx.dir) : baseOf(dir));
    modules.push(pyModule(ctx, name, dir, ev(f, null, baseOf(f))));
  }
  const inits = ctx.files.filter((f) => baseOf(f) === '__init__.py').map(dirOf);
  const initSet = new Set(inits);
  for (const d of inits) {
    if (d === '.' || initSet.has(dirOf(d)) || pyRoots.some((r) => under(d, r))) continue;
    modules.push(pyModule(ctx, baseOf(d), d, ev(`${d}/__init__.py`, null, null)));
  }

  // --- whatever code is left: one module per top-level directory
  // a root-level project claims the files of its own languages; a nested one claims its whole dir
  const rootLangs = new Set<string>();
  for (const m of modules.filter((m) => m.path === '.')) {
    if (m.kind === 'cmake_target' || m.kind === 'vs_project') ['c', 'cpp', 'cuda'].forEach((l) => rootLangs.add(l));
    else if (m.kind === 'csproj') rootLangs.add('csharp');
    else if (m.kind === 'python_pkg') rootLangs.add('python');
  }
  const allSources = [...sources.values()];
  const claimed = (f: string) =>
    modules.some((m) => m.path !== '.' && under(f, m.path)) || rootLangs.has(langOf(f) ?? '') || allSources.some((s) => s.has(f));
  const leftovers = new Map<string, string[]>();
  for (const f of codeFiles(ctx, new Set(['c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx', 'cu', 'cuh', 'cs', 'py', 'sh', 'ps1', 'js', 'mjs', 'ts', 'go', 'rs', 'java']))) {
    if (claimed(f)) continue;
    const top = f.includes('/') ? f.slice(0, f.indexOf('/')) : '.';
    if (top.startsWith('.') && top !== '.') continue;
    if (!leftovers.has(top)) leftovers.set(top, []);
    leftovers.get(top)!.push(f);
  }
  for (const [top, files] of [...leftovers.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (top === '.' && (modules.length || leftovers.size > 1)) continue; // loose root files next to real modules
    const lang = dominantLang(files);
    const scripty = lang === 'python' || lang === 'shell' || lang === 'powershell' || lang === 'javascript';
    const entry = files.filter((f) => /\.(c|cc|cpp|cxx|cu|cs|py)$/.test(f) && hasMain(ctx, f)).slice(0, 40);
    modules.push({
      name: top === '.' ? baseOf(ctx.dir) : top,
      path: top,
      kind: 'dir',
      language: lang,
      output: scripty ? 'script' : entry.length ? 'exe' : null,
      depends_on: [],
      entry_points: entry,
      files: filesUnder(ctx, top).length,
      evidence: [ev(files[0]!, null, null)],
    });
  }

  // unique names (two projects called "Tests" in different dirs)
  const seen = new Map<string, number>();
  for (const m of modules) seen.set(m.name, (seen.get(m.name) ?? 0) + 1);
  for (const m of modules) {
    if (seen.get(m.name)! > 1 && m.path !== '.') {
      const old = m.name;
      m.name = `${m.name} (${m.path})`;
      if (sources.has(old) && !sources.has(m.name)) sources.set(m.name, sources.get(old)!);
    }
  }

  const ownerOf = (file: string): string | null => {
    const hit = modules.find((m) => sources.get(m.name)?.has(file));
    if (hit) return hit.name;
    let best: ModuleInfo | null = null;
    for (const m of modules) {
      if (!under(file, m.path)) continue;
      const len = m.path === '.' ? 0 : m.path.length;
      const bestLen = best ? (best.path === '.' ? 0 : best.path.length) : -1;
      if (len > bestLen) best = m;
      else if (len === bestLen && best && cmakeProjects.get(m.path) === m.name) best = m;
    }
    return best?.name ?? null;
  };

  // the build unit: every CMake target of one CMakeLists counts as its project's main target
  const primary = new Map<string, string>();
  for (const m of modules.filter((m) => m.kind === 'cmake_target')) {
    const proj = cmakeProjects.get(m.path);
    if (!primary.has(m.path) || m.name === proj) primary.set(m.path, m.name);
  }
  const unitOf = (file: string): string | null => {
    const o = ownerOf(file);
    const m = o ? modules.find((x) => x.name === o) : null;
    return m && m.kind === 'cmake_target' ? (primary.get(m.path) ?? o) : o;
  };

  return { modules, ownerOf, unitOf, sources, cmakeProjects, cmake };
}

function pyModule(ctx: RepoCtx, name: string, dir: string, evidence: Evidence): ModuleInfo {
  const all = filesUnder(ctx, dir);
  const entry = all.filter((f) => extOf(f) === 'py' && hasMain(ctx, f)).slice(0, 40);
  return {
    name,
    path: dir,
    kind: 'python_pkg',
    language: 'python',
    output: entry.length ? 'script' : 'lib',
    depends_on: [],
    entry_points: entry,
    files: all.length,
    evidence: [evidence],
  };
}
