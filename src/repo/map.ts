import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { paths } from '../config.js';
import { detectSetup, detectVerify } from '../chatops/verify.js';

/**
 * Repo 地圖: what an implementation model needs to know about a repo before it reads a single
 * file — languages, the directory shape, entry points, how to build and test, and a symbol index
 * (functions / classes with file:line) built with plain regexes. Deterministic and fast (a 5k-file
 * repo in about a second); no model, no network. Rendered once as Markdown, injected into
 * LOOP_TASK.md behind `repo_map_inject` and used by the 分析 step to place a problem.
 */

export type GitExec = (args: string[], cwd: string) => string;

export interface RepoSymbol {
  file: string;
  name: string;
  line: number;
  kind: 'function' | 'class';
}

export interface RepoMap {
  sha: string | null;
  files: number;
  /** language → share of files, 0..1, descending */
  languages: Record<string, number>;
  dirs: { name: string; files: number }[];
  entryPoints: string[];
  build: string[];
  setup: string | null;
  symbols: RepoSymbol[];
  truncated: boolean;
}

const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'output', '__pycache__', 'target', 'bin', 'obj', 'vendor', '.git', 'third_party', 'external']);
const MAX_FILE_BYTES = 512 * 1024;

const LANG_BY_EXT: Record<string, string> = {
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.h': 'cpp', '.inl': 'cpp',
  '.c': 'c',
  '.cu': 'cuda', '.cuh': 'cuda',
  '.cs': 'csharp',
  '.py': 'python',
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
  '.sh': 'shell', '.ps1': 'powershell',
  '.cmake': 'cmake',
};
const CODE_LANGS = new Set(['cpp', 'c', 'cuda', 'csharp', 'python', 'typescript', 'javascript', 'go', 'rust', 'java', 'kotlin']);

function defaultGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** Tracked files, or a directory walk when the folder is not a git repo. */
export function listRepoFiles(repoPath: string, git: GitExec = defaultGit): string[] {
  try {
    const out = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], repoPath);
    const files = out.split('\0').filter(Boolean);
    if (files.length) return files.filter((f) => !f.split('/').some((seg) => SKIP_DIRS.has(seg)));
  } catch {
    /* not a git repo: walk */
  }
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else if (e.isFile()) out.push(r);
      if (out.length > 20_000) return;
    }
  };
  walk(repoPath, '');
  return out;
}

function langOf(file: string): string | null {
  const name = path.basename(file);
  if (name === 'CMakeLists.txt') return 'cmake';
  return LANG_BY_EXT[path.extname(file).toLowerCase()] ?? null;
}

/** Entry points a reader would open first: build manifests and mains. */
function findEntryPoints(repoPath: string, files: string[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    const base = path.basename(f);
    const depth = f.split('/').length;
    if (depth <= 2 && ['package.json', 'CMakeLists.txt', 'pyproject.toml', 'setup.py', 'Makefile', 'go.mod', 'Cargo.toml', 'requirements.txt'].includes(base)) out.add(f);
    if (depth <= 3 && /\.(sln|csproj)$/.test(base)) out.add(f);
    if (/^(main|app|index|program|server|cli)\.(py|ts|js|cpp|cc|cs|go|rs)$/i.test(base)) out.add(f);
  }
  // add_executable targets name the real programs of a CMake repo
  const cmake = files.find((f) => f === 'CMakeLists.txt');
  if (cmake) {
    try {
      const text = fs.readFileSync(path.join(repoPath, cmake), 'utf8');
      for (const m of text.matchAll(/add_executable\s*\(\s*([\w.-]+)/g)) out.add(`CMakeLists.txt: add_executable(${m[1]})`);
    } catch {
      /* unreadable */
    }
  }
  return [...out].sort().slice(0, 40);
}

const IDENT = '([A-Za-z_][A-Za-z0-9_]*)';
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'return', 'else', 'catch', 'sizeof', 'defined', 'foreach', 'using', 'lock', 'new', 'delete']);

/** Function / class definitions in one file, by a regex per language (approximate, never wrong about the line). */
export function scanSymbols(file: string, text: string, lang: string): RepoSymbol[] {
  const out: RepoSymbol[] = [];
  const lines = text.split('\n');
  const push = (name: string, line: number, kind: RepoSymbol['kind']): void => {
    if (!name || CONTROL.has(name)) return;
    out.push({ file, name, line, kind });
  };
  const re: { fn: RegExp[]; cls: RegExp[] } = { fn: [], cls: [] };
  switch (lang) {
    case 'python':
      re.fn.push(new RegExp(`^\\s*(?:async\\s+)?def\\s+${IDENT}\\s*\\(`));
      re.cls.push(new RegExp(`^\\s*class\\s+${IDENT}\\b`));
      break;
    case 'typescript':
    case 'javascript':
      re.fn.push(new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${IDENT}\\s*[(<]`));
      re.fn.push(new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${IDENT}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_]\\w*)\\s*(?::[^=]+)?=>`));
      re.cls.push(new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+${IDENT}\\b`));
      break;
    case 'go':
      re.fn.push(new RegExp(`^func\\s+(?:\\([^)]*\\)\\s*)?${IDENT}\\s*\\(`));
      re.cls.push(new RegExp(`^type\\s+${IDENT}\\s+(?:struct|interface)\\b`));
      break;
    case 'rust':
      re.fn.push(new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?fn\\s+${IDENT}\\b`));
      re.cls.push(new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:struct|enum|trait)\\s+${IDENT}\\b`));
      break;
    case 'csharp':
      re.fn.push(new RegExp(`^\\s*(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|unsafe|extern|new|partial)\\s+)+[\\w<>\\[\\],.?]+\\s+${IDENT}\\s*\\([^;]*$`));
      re.cls.push(new RegExp(`^\\s*(?:(?:public|private|protected|internal|static|sealed|abstract|partial)\\s+)*(?:class|struct|interface|enum|record)\\s+${IDENT}\\b`));
      break;
    case 'java':
    case 'kotlin':
      re.fn.push(new RegExp(`^\\s*(?:(?:public|private|protected|static|final|synchronized|abstract|override|fun)\\s+)+[\\w<>\\[\\],.?]*\\s*${IDENT}\\s*\\(`));
      re.cls.push(new RegExp(`^\\s*(?:(?:public|private|protected|static|final|abstract|data|sealed)\\s+)*(?:class|interface|enum|object)\\s+${IDENT}\\b`));
      break;
    case 'cpp':
    case 'c':
    case 'cuda': {
      // a definition: starts at the margin (or one indent for members), has a return type or a
      // class qualifier, its parameter list closes on this line and the body opens here or next line
      re.fn.push(new RegExp(`^(?:[A-Za-z_][\\w:<>,~*&\\s]*\\s+[*&]*\\s*)?(?:[A-Za-z_][\\w<>]*::)*(~?${IDENT.slice(1, -1)})\\s*\\([^;{}]*\\)\\s*(?:const\\s*)?(?:noexcept\\s*)?(?:override\\s*)?(?:final\\s*)?(?:\\{\\s*)?$`));
      re.cls.push(new RegExp(`^\\s*(?:template\\s*<[^>]*>\\s*)?(?:class|struct)\\s+(?:\\w+\\s+)?${IDENT}\\s*(?::|\\{|$)`));
      break;
    }
    default:
      return out;
  }
  const cLike = lang === 'cpp' || lang === 'c' || lang === 'cuda';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 400) continue;
    for (const r of re.cls) {
      const m = r.exec(line);
      if (m) {
        push(m[1]!, i + 1, 'class');
        break;
      }
    }
    for (const r of re.fn) {
      const m = r.exec(line);
      if (!m) continue;
      if (cLike) {
        const t = line.trim();
        if (/^(?:return|else|if|for|while|switch)\b/.test(t) || /^#/.test(t) || /;\s*$/.test(t)) break;
        // body must open here or on the next line, else it is a declaration or a call
        const next = (lines[i + 1] ?? '').trim();
        if (!/\{\s*$/.test(t) && !next.startsWith('{')) break;
        if (/\b(?:if|for|while|switch|catch)\s*\(/.test(t)) break;
      }
      push(m[1]!, i + 1, 'function');
      break;
    }
  }
  return out;
}

export interface BuildMapOptions {
  git?: GitExec;
  maxSymbols?: number;
  maxScanFiles?: number;
}

export function buildRepoMap(repoPath: string, opts: BuildMapOptions = {}): RepoMap {
  const git = opts.git ?? defaultGit;
  const maxSymbols = opts.maxSymbols ?? 3000;
  const maxScan = opts.maxScanFiles ?? 5000;
  let sha: string | null = null;
  try {
    sha = git(['rev-parse', '--short', 'HEAD'], repoPath).trim() || null;
  } catch {
    sha = null;
  }
  const files = listRepoFiles(repoPath, git);
  const langCount = new Map<string, number>();
  const dirCount = new Map<string, number>();
  for (const f of files) {
    const l = langOf(f);
    if (l) langCount.set(l, (langCount.get(l) ?? 0) + 1);
    const top = f.includes('/') ? f.slice(0, f.indexOf('/')) + '/' : '(root)';
    dirCount.set(top, (dirCount.get(top) ?? 0) + 1);
  }
  const codeTotal = [...langCount.entries()].filter(([l]) => CODE_LANGS.has(l)).reduce((a, [, n]) => a + n, 0) || 1;
  const languages: Record<string, number> = {};
  for (const [l, n] of [...langCount.entries()].filter(([l]) => CODE_LANGS.has(l)).sort((a, b) => b[1] - a[1])) {
    languages[l] = Math.round((n / codeTotal) * 100) / 100;
  }
  const dirs = [...dirCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([name, n]) => ({ name, files: n }));

  const symbols: RepoSymbol[] = [];
  let scanned = 0;
  let truncated = false;
  for (const f of files) {
    const lang = langOf(f);
    if (!lang || !CODE_LANGS.has(lang)) continue;
    if (scanned++ >= maxScan) {
      truncated = true;
      break;
    }
    let text: string;
    try {
      const st = fs.statSync(path.join(repoPath, f));
      if (st.size > MAX_FILE_BYTES) continue;
      text = fs.readFileSync(path.join(repoPath, f), 'utf8');
    } catch {
      continue;
    }
    for (const s of scanSymbols(f, text, lang)) {
      if (symbols.length >= maxSymbols) {
        truncated = true;
        break;
      }
      symbols.push(s);
    }
    if (symbols.length >= maxSymbols) break;
  }
  symbols.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
  return {
    sha,
    files: files.length,
    languages,
    dirs,
    entryPoints: findEntryPoints(repoPath, files),
    build: detectBuild(repoPath, files),
    setup: detectSetup(repoPath),
    symbols,
    truncated,
  };
}

/** Build/test commands: the chatops detector plus the C++/C#/CUDA stacks it does not know. */
export function detectBuild(repoPath: string, files: string[]): string[] {
  // the root manifest decides: a C++/C# repo with a tests/ folder is still built with cmake/dotnet
  if (files.includes('CMakeLists.txt')) return ['cmake -S . -B build && cmake --build build -j', 'ctest --test-dir build --output-on-failure'];
  if (files.some((f) => /^[^/]+\.sln$/.test(f) || /^[^/]+\/[^/]+\.csproj$/.test(f) || /^[^/]+\.csproj$/.test(f))) return ['dotnet build', 'dotnet test'];
  return detectVerify(repoPath);
}

const LANG_LABEL: Record<string, string> = { cpp: 'C++', c: 'C', cuda: 'CUDA', csharp: 'C#', python: 'Python', typescript: 'TypeScript', javascript: 'JavaScript', go: 'Go', rust: 'Rust', java: 'Java', kotlin: 'Kotlin' };

/** The Markdown the model reads. `budget` caps the symbol section (whole lines only). */
export function renderRepoMap(name: string, map: RepoMap, budget = 8000): string {
  const langs = Object.entries(map.languages).map(([l, s]) => `${LANG_LABEL[l] ?? l} ${Math.round(s * 100)}%`).join(' · ') || '（沒有辨識出程式語言）';
  const head = [
    `# Repo 地圖 — ${name}${map.sha ? ` @ ${map.sha}` : ''}`,
    '',
    `- 語言：${langs}（${map.files} 個檔案）`,
    `- 建置／測試：${map.build.length ? map.build.map((c) => `\`${c}\``).join('；') : '（偵測不到）'}`,
    `- 前置：${map.setup ? `\`${map.setup}\`` : '（無）'}`,
    '',
    '## 目錄',
    ...map.dirs.map((d) => `- ${d.name}（${d.files} 檔）`),
    '',
    '## 進入點',
    ...(map.entryPoints.length ? map.entryPoints.map((e) => `- ${e}`) : ['- （偵測不到）']),
    '',
    `## 符號索引${map.truncated ? '（已截斷）' : ''}`,
  ];
  const byFile = new Map<string, RepoSymbol[]>();
  for (const s of map.symbols) {
    const list = byFile.get(s.file) ?? [];
    list.push(s);
    byFile.set(s.file, list);
  }
  const lines: string[] = [];
  for (const [file, syms] of byFile) {
    lines.push(`- ${file}: ${syms.map((s) => `${s.name}${s.kind === 'class' ? '{}' : '()'}:${s.line}`).join(', ')}`);
  }
  let out = head.join('\n') + '\n';
  for (const line of lines) {
    if (out.length + line.length + 1 > budget) {
      out += '- …（其餘省略）\n';
      break;
    }
    out += line + '\n';
  }
  return out;
}

/** Writes the rendered map under <dataDir>/repo-maps/<repoId>.md and returns its path. */
export function saveRepoMap(repoId: string, markdown: string, dir = paths.repoMapsDir): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${repoId.replace(/[^\w.-]+/g, '_')}.md`);
  fs.writeFileSync(file, markdown);
  return file;
}
