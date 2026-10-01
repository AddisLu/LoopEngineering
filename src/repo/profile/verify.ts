import fs from 'node:fs';
import path from 'node:path';
import { detectVerify } from '../../chatops/verify.js';
import type { RepoProbe } from '../../prd/repo.js';
import { suggestCommands } from '../import.js';
import type { RepoStack } from '../store.js';
import type { Architecture } from './architecture.js';
import { baseOf, CPP_EXT, codeFiles, depthOf, dirOf, ev, extOf, lineText, type RepoCtx } from './context.js';
import { xmlEls } from './parse.js';
import type { Evidence, ModuleInfo, VerifyProfile } from './types.js';

/**
 * 驗證: how this checkout proves itself — test frameworks, test dirs, build / test commands,
 * which modules run headless (and how) versus GUI-only, and the eval scripts / answer files a
 * coding agent must not touch.
 */

const SCRIPT_EXT = new Set(['py', 'sh', 'ps1', 'bat', 'cmd', 'js', 'mjs', 'rb', 'pl']);
const NON_DATA_EXT = new Set([...SCRIPT_EXT, ...CPP_EXT, 'cs', 'ts', 'md', 'txt', 'json5', 'cmake', 'vcxproj', 'csproj', 'sln', 'yml', 'yaml', 'toml']);
const TEST_DIR_RE = /^(tests?|__tests__|unittests?|spec|testing)$|\.Tests?$|Tests$/i;

const CLI_RE: Record<string, RegExp> = {
  cpp: /\bargc\s*[<>=!]|\bargv\s*\[|\bgetopt(?:_long)?\s*\(|\bCLI::App\b|\bcxxopts::|\bprogram_options\b|\b__argc\b|\bCommandLineToArgvW\b/,
  cs: /\bargs\s*\.\s*(?:Length|Contains|Any|FirstOrDefault|Count|Skip)\b|\bargs\s*\[|\bin\s+args\b|Array\.IndexOf\s*\(\s*args\b|GetCommandLineArgs\s*\(|System\.CommandLine/,
  py: /\bargparse\b|\bsys\.argv\b|\bclick\.(?:command|option)|\btyper\./,
};

function cliIn(ctx: RepoCtx, file: string): { e: Evidence; flags: string[] } | null {
  const fc = ctx.read(file);
  if (!fc) return null;
  const ext = extOf(file);
  const re = ext === 'cs' ? CLI_RE.cs! : ext === 'py' ? CLI_RE.py! : CLI_RE.cpp!;
  const i = fc.lines.findIndex((l) => re.test(l));
  if (i < 0) return null;
  const flags = [...new Set([...fc.text.matchAll(/["'](--[a-zA-Z][\w-]+)["']/g)].map((m) => m[1]!))].slice(0, 6);
  return { e: ev(file, i + 1, fc.lines[i]), flags };
}

const GUI_PKG_RE = /<PackageReference\s+Include="(Avalonia|Avalonia\.Desktop)"|<UseWindowsForms>\s*true|<UseWPF>\s*true/i;

export function analyseVerify(ctx: RepoCtx, arch: Architecture): VerifyProfile {
  const fw = new Map<string, { name: string; module: string | null; evidence: Evidence[] }>();
  const addFw = (name: string, file: string, line: number | null, text: string | null) => {
    const module = arch.ownerOf(file);
    const key = `${name}\u0000${module ?? ''}`;
    if (!fw.has(key)) fw.set(key, { name, module, evidence: [] });
    const f = fw.get(key)!;
    if (f.evidence.length < 3) f.evidence.push(ev(file, line, text));
  };

  // C / C++ test frameworks
  for (const f of codeFiles(ctx, CPP_EXT)) {
    const fc = ctx.read(f);
    if (!fc || !fc.text.includes('#include')) continue;
    fc.lines.forEach((l, i) => {
      if (/#\s*include\s*[<"]gtest\/gtest\.h[>"]/.test(l)) addFw('gtest', f, i + 1, l);
      else if (/#\s*include\s*[<"](catch2\/|catch\.hpp)/.test(l)) addFw('catch2', f, i + 1, l);
    });
  }
  for (const [f, cmds] of arch.cmake) {
    for (const c of cmds) {
      const text = lineText(ctx, f, c.line);
      if (c.name === 'find_package' && /^GTest$/i.test(c.args[0] ?? '')) addFw('gtest', f, c.line, text);
      if (c.name === 'find_package' && /^Catch2$/i.test(c.args[0] ?? '')) addFw('catch2', f, c.line, text);
      if (c.name === 'target_link_libraries' && c.args.some((a) => /^GTest::/.test(a))) addFw('gtest', f, c.line, text);
      if (c.name === 'enable_testing' || c.name === 'add_test' || c.name === 'gtest_discover_tests') addFw('ctest', f, c.line, text);
    }
  }
  // Python
  for (const f of ctx.files) {
    const b = baseOf(f);
    if (b === 'conftest.py' || b === 'pytest.ini') addFw('pytest', f, null, b);
    else if ((b === 'pyproject.toml' || b === 'setup.cfg' || b === 'tox.ini') && depthOf(f) <= 4) {
      const i = (ctx.read(f)?.lines ?? []).findIndex((l) => /^\[(tool\.pytest|tool:pytest|pytest)/.test(l.trim()));
      if (i >= 0) addFw('pytest', f, i + 1, lineText(ctx, f, i + 1));
    } else if (extOf(f) === 'py') {
      const fc = ctx.read(f);
      if (!fc) continue;
      const isTestName = /^test_.*\.py$|_test\.py$/.test(b);
      const pi = fc.lines.findIndex((l) => /^\s*import\s+pytest\b|^\s*from\s+pytest\b/.test(l));
      const ti = fc.lines.findIndex((l) => /^\s*def\s+test_\w*\s*\(/.test(l));
      if (pi >= 0) addFw('pytest', f, pi + 1, fc.lines[pi]!);
      else if (isTestName && ti >= 0) addFw('pytest', f, ti + 1, fc.lines[ti]!);
      const ui = fc.lines.findIndex((l) => /\bunittest\.TestCase\b/.test(l));
      if (ui >= 0) addFw('unittest', f, ui + 1, fc.lines[ui]!);
    }
  }
  // .NET / JS
  for (const f of ctx.files.filter((f) => /^(csproj|vbproj|fsproj)$/.test(extOf(f)))) {
    const t = ctx.read(f)?.text ?? '';
    for (const e of xmlEls(t, 'PackageReference')) {
      const inc = e.attrs.Include ?? '';
      const name = /^xunit\b/i.test(inc) ? 'xunit' : /^NUnit\b/i.test(inc) ? 'nunit' : /^MSTest\b/i.test(inc) ? 'mstest' : null;
      if (name) {
        const n = ctx.lineAt(f, e.index);
        addFw(name, f, n, lineText(ctx, f, n));
      }
    }
  }
  for (const f of ctx.files.filter((f) => baseOf(f) === 'package.json' && depthOf(f) <= 3)) {
    const t = ctx.read(f)?.text ?? '';
    for (const name of ['vitest', 'jest', 'mocha']) {
      const i = (ctx.read(f)?.lines ?? []).findIndex((l) => l.includes(`"${name}"`));
      if (i >= 0 && t) addFw(name, f, i + 1, lineText(ctx, f, i + 1));
    }
  }

  // test dirs: the top-most dir named like a test dir, plus the dirs of python test files
  const dirs = new Set<string>();
  for (const f of ctx.files) {
    const parts = f.split('/');
    const idx = parts.slice(0, -1).findIndex((p) => TEST_DIR_RE.test(p));
    if (idx >= 0) dirs.add(parts.slice(0, idx + 1).join('/'));
  }
  for (const v of fw.values()) for (const e of v.evidence) if (/^test_.*\.py$|_test\.py$/.test(baseOf(e.file))) dirs.add(dirOf(e.file));
  const test_dirs = [...dirs].filter((d) => ![...dirs].some((o) => o !== d && d.startsWith(o + '/'))).sort();

  // commands
  const commands: VerifyProfile['commands'] = [];
  const addCmd = (label: string, command: string, module: string | null) => {
    if (!commands.some((c) => c.command === command)) commands.push({ label, command, module });
  };
  try {
    for (const c of detectVerify(ctx.dir)) addCmd(c, c, null);
    const has = (f: string) => fs.existsSync(path.join(ctx.dir, f));
    const stack: RepoStack = { languages: {}, dirs: [], files: ctx.files.length, entry_points: ctx.files.filter((f) => /\.(sln|csproj|fsproj)$/i.test(f) && depthOf(f) <= 2) };
    const probe = { presets: { cmake: has('CMakeLists.txt'), npm_test: false, pytest: false, verify_scripts: [] } } as unknown as RepoProbe;
    const s = suggestCommands(ctx.dir, probe, stack);
    // .NET fallback runs only from the root when the root holds the solution / project
    const dotnetAtRoot = ctx.files.some((f) => /\.(sln|csproj|fsproj)$/i.test(f) && !f.includes('/'));
    if (s.build_cmd && !(s.build_cmd === 'dotnet build' && !dotnetAtRoot)) addCmd('建置', s.build_cmd, null);
    if (s.test_cmd && !(s.test_cmd === 'dotnet test' && !dotnetAtRoot)) addCmd('測試', s.test_cmd, null);
  } catch (e) {
    ctx.warnings.push(`驗證指令偵測失敗：${(e as Error).message}`);
  }
  const cmakeDirs = [...arch.cmake.keys()].map(dirOf);
  for (const d of cmakeDirs.sort()) {
    if (d === '.' || cmakeDirs.some((o) => o !== d && (o === '.' || d.startsWith(o + '/')))) continue;
    const proj = arch.cmakeProjects.get(d) ?? baseOf(d);
    const mod = arch.ownerOf(`${d}/CMakeLists.txt`);
    addCmd(`建置 ${proj}（CMake）`, `cmake -S ${d} -B ${d}/build && cmake --build ${d}/build -j`, mod);
    const tree = [...arch.cmake.entries()].filter(([f]) => dirOf(f) === d || f.startsWith(d + '/'));
    if (tree.some(([, cmds]) => cmds.some((c) => c.name === 'enable_testing' || c.name === 'add_test'))) addCmd(`測試 ${proj}（CTest）`, `ctest --test-dir ${d}/build --output-on-failure`, mod);
  }
  for (const f of ctx.files.filter((f) => extOf(f) === 'sln' && depthOf(f) <= 4)) {
    const vcx = ctx.files.filter((p) => extOf(p) === 'vcxproj').map((p) => ctx.read(p)?.text ?? '');
    const plat = vcx.some((t) => /\|x64"/.test(t)) ? 'x64' : vcx.some((t) => /\|Win32"/.test(t)) ? 'Win32' : null;
    const cmd = vcx.length ? `msbuild "${f}" /p:Configuration=Release${plat ? ` /p:Platform=${plat}` : ''}` : `dotnet build "${f}"`;
    addCmd(`建置 ${baseOf(f)}`, cmd, null);
  }
  for (const m of arch.modules.filter((m) => m.kind === 'csproj')) {
    const proj = projFile(ctx, m);
    if (!proj) continue;
    const isTest = [...fw.values()].some((v) => v.module === m.name && /^(xunit|nunit|mstest)$/.test(v.name));
    addCmd(`${isTest ? '測試' : '建置'} ${m.name}（.NET）`, `dotnet ${isTest ? 'test' : 'build'} ${proj}`, m.name);
  }
  const pytestDirs = new Set<string>();
  for (const v of fw.values()) if (v.name === 'pytest') for (const e of v.evidence) pytestDirs.add(dirOf(e.file));
  if (pytestDirs.size && !commands.some((c) => /pytest/.test(c.command))) {
    const top = [...pytestDirs].filter((d) => ![...pytestDirs].some((o) => o !== d && (o === '.' || d.startsWith(o + '/'))));
    for (const d of top.sort()) addCmd(`測試 ${d === '.' ? '' : d}（pytest）`.replace('  ', ' '), d === '.' ? 'python3 -m pytest' : `python3 -m pytest ${d}`, arch.ownerOf(`${d}/x.py`));
  }

  // eval scripts / answer files
  const eval_scripts = ctx.files.filter((f) => SCRIPT_EXT.has(extOf(f)) && /eval|verify|bench|score/i.test(baseOf(f)));
  for (const f of eval_scripts.filter((f) => /^verify_[\w一-鿿-]*\.py$/i.test(baseOf(f)))) addCmd(baseOf(f), `python3 ${f}`, arch.ownerOf(f));
  const answer_files = ctx.files.filter((f) => {
    const b = baseOf(f);
    if (NON_DATA_EXT.has(extOf(f))) return false;
    return /^answers?\./i.test(b) || /golden/i.test(b) || /ground_?truth/i.test(b) || /\.gt\./i.test(b) || /(^|\/)(golden|ground_?truth|answers|expected)\//i.test(f);
  });
  const prot = new Set<string>([...eval_scripts, ...answer_files]);
  for (const f of answer_files) {
    const m = /^(.*?(?:^|\/)(?:golden|ground_?truth|answers|expected))\//i.exec(f);
    if (m) prot.add(m[1] + '/');
  }
  const protected_suggestions = [...prot].filter((p) => ![...prot].some((o) => o !== p && o.endsWith('/') && p.startsWith(o))).sort();

  // headless vs GUI-only
  const headless: VerifyProfile['headless'] = [];
  const gui_only: string[] = [];
  for (const m of arch.modules) {
    if (!m.output || m.output === 'lib' || m.output === 'dll') continue;
    const entries = m.entry_points.length ? m.entry_points : [];
    const projText = m.kind === 'csproj' ? ctx.read(projFile(ctx, m) ?? '')?.text ?? '' : '';
    const guiFramework = GUI_PKG_RE.test(projText);
    const isGui = m.output === 'gui_exe' || guiFramework;
    if (m.output === 'script' || m.language === 'python') {
      const clis = entries.filter((f) => extOf(f) === 'py').map((f) => ({ f, c: cliIn(ctx, f) }));
      const withCli = clis.filter((x) => x.c);
      if (!clis.length) continue;
      const names = (withCli.length ? withCli : clis).map((x) => baseOf(x.f));
      const shown = names.slice(0, 6).join('、') + (names.length > 6 ? ` 等 ${names.length} 支` : '');
      headless.push({
        module: m.name,
        how: withCli.length ? `Python 腳本 CLI（argparse／sys.argv）：${shown}` : `python3 執行：${shown}`,
        evidence: (withCli.length ? withCli.map((x) => x.c!.e) : clis.map((x) => ev(x.f, null, null))).slice(0, 3),
      });
      continue;
    }
    const bin = m.kind === 'dir' ? null : m.name;
    const clis = entries.map((f) => ({ f, c: cliIn(ctx, f) })).filter((x) => x.c);
    if (clis.length) {
      const flags = [...new Set(clis.flatMap((x) => x.c!.flags))];
      const name = bin ?? clis.map((x) => baseOf(x.f).replace(/\.\w+$/, '')).slice(0, 4).join('／');
      const how = isGui
        ? `${name} ${flags.length ? flags.join(' ') : '（命令列參數）'}（GUI 程式的命令列模式，不開視窗）`
        : `${name} CLI${flags.length ? `（${flags.join(', ')}）` : '（argv）'}`;
      headless.push({ module: m.name, how, evidence: clis.slice(0, 3).map((x) => x.c!.e) });
    } else if (isGui) {
      gui_only.push(m.name);
    } else if (entries.length && m.output === 'exe') {
      const f = entries[0]!;
      const i = (ctx.read(f)?.lines ?? []).findIndex((l) => /\b(?:int|void|auto)\s+w?main\s*\(|\bstatic\s+.*\bMain\s*\(/.test(l));
      headless.push({ module: m.name, how: `${bin ?? baseOf(f)}（console 程式，無參數）`, evidence: [i >= 0 ? ev(f, i + 1, lineText(ctx, f, i + 1)) : ev(f, null, null)] });
    }
  }

  return {
    frameworks: [...fw.values()].sort((a, b) => a.name.localeCompare(b.name) || (a.module ?? '').localeCompare(b.module ?? '')),
    test_dirs,
    commands,
    headless,
    gui_only,
    eval_scripts,
    answer_files,
    protected_suggestions,
  };
}

function projFile(ctx: RepoCtx, m: ModuleInfo): string | null {
  return ctx.files.find((f) => dirOf(f) === m.path && /\.(csproj|vbproj|fsproj)$/.test(f) && baseOf(f).replace(/\.\w+$/, '') === m.name.split(' (')[0]) ?? null;
}
