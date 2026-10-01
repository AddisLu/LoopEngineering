import { baseOf, depthOf, ev, extOf, HEADER_EXT, langOf, lineText, under, type FileEncoding, type RepoCtx } from './context.js';
import type { Evidence, StyleProfile } from './types.js';

/**
 * 程式風格: what the code already looks like — encoding, line endings, indentation, braces,
 * naming, header guards, comment language, error handling, logging and string types — so a
 * local model can write code that fits in. Sampled (≤ maxStyleFiles files), repo-wide plus one
 * profile per top-level directory.
 */

const STYLE_EXT = new Set(['c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx', 'inl', 'cu', 'cuh', 'cs', 'py', 'ts', 'js', 'mjs', 'java']);
const C_LIKE = new Set(['c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx', 'inl', 'cu', 'cuh', 'cs', 'ts', 'js', 'mjs', 'java']);
const LANG_LABEL: Record<string, string> = { cpp: 'C++', c: 'C', cuda: 'CUDA', csharp: 'C#', python: 'Python', typescript: 'TypeScript', javascript: 'JavaScript', java: 'Java' };

type Counter = Map<string, { n: number; ex: string | null }>;

interface Stats {
  files: number;
  enc: Record<'utf8' | 'utf8_bom' | 'big5' | 'other', number>;
  crlf: number;
  lf: number;
  tab: number;
  space: number;
  d2: number;
  d4: number;
  same: number;
  next: number;
  pragma: number;
  ifndef: number;
  zh: number;
  en: number;
  /** naming: key = `${lang}|${what}|${style}` */
  naming: Counter;
  err: Counter;
  log: Counter;
  str: Counter;
  langs: Set<string>;
}

const newStats = (): Stats => ({
  files: 0,
  enc: { utf8: 0, utf8_bom: 0, big5: 0, other: 0 },
  crlf: 0,
  lf: 0,
  tab: 0,
  space: 0,
  d2: 0,
  d4: 0,
  same: 0,
  next: 0,
  pragma: 0,
  ifndef: 0,
  zh: 0,
  en: 0,
  naming: new Map(),
  err: new Map(),
  log: new Map(),
  str: new Map(),
  langs: new Set(),
});

const bump = (c: Counter, key: string, ex: string | null = null, n = 1) => {
  const cur = c.get(key);
  if (cur) cur.n += n;
  else c.set(key, { n, ex });
};

function merge(into: Stats, s: Stats): void {
  into.files += s.files;
  for (const k of Object.keys(into.enc) as Array<keyof Stats['enc']>) into.enc[k] += s.enc[k];
  for (const k of ['crlf', 'lf', 'tab', 'space', 'd2', 'd4', 'same', 'next', 'pragma', 'ifndef', 'zh', 'en'] as const) into[k] += s[k];
  for (const k of ['naming', 'err', 'log', 'str'] as const) for (const [key, v] of s[k]) bump(into[k], key, v.ex, v.n);
  for (const l of s.langs) into.langs.add(l);
}

const CJK = /[㐀-鿿豈-﫿]/;
const KEYWORDS = new Set(['return', 'if', 'while', 'for', 'switch', 'else', 'case', 'new', 'delete', 'throw', 'using', 'typedef', 'sizeof', 'catch', 'do', 'goto', 'co_return', 'co_await', 'static_assert', 'decltype', 'operator', 'template', 'namespace', 'define']);

function caseStyle(name: string): 'snake' | 'camel' | 'pascal' | null {
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(name)) return 'snake';
  if (/^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(name)) return 'camel';
  if (/^[A-Z][a-z0-9]+[A-Za-z0-9]*$/.test(name) && /[a-z]/.test(name)) return 'pascal';
  return null;
}

const ERR_RULES: Array<[string, RegExp, 'c' | 'py' | 'any']> = [
  ['例外（throw/try）', /\bthrow\b|\btry\s*\{|\bcatch\s*\(/, 'c'],
  ['例外（raise/except）', /\braise\b|^\s*try\s*:|^\s*except\b/, 'py'],
  ['回傳錯誤碼（return -1／false）', /\breturn\s+(?:-1|false|nullptr|NULL|E_\w+|ERR_\w+|S_FALSE)\s*;/, 'c'],
  ['HRESULT／FAILED()', /\bFAILED\s*\(|\bSUCCEEDED\s*\(|\bHRESULT\b/, 'c'],
  ['MIL：MappGetError 檢查', /\bMappGetError\w*\s*\(|MappControl\s*\([^)]*M_ERROR/, 'any'],
  ['CUDA：cudaGetLastError／錯誤檢查巨集', /\bcudaGetLastError\s*\(|\bCUDA_CHECK\w*\s*\(|\bcheckCuda\w*\s*\(|\bcudaError_t\b/, 'c'],
  ['回傳 std::optional／expected', /std::(optional|expected)\s*</, 'c'],
  ['assert 斷言', /\bassert\s*\(/, 'any'],
  ['errno／perror', /\berrno\b|\bperror\s*\(/, 'c'],
];

const LOG_RULES: Array<[string, RegExp]> = [
  ['std::cerr', /std::cerr\b/],
  ['std::cout', /std::cout\b/],
  ['printf', /\bf?printf\s*\(/],
  ['fmt::print', /\bfmt::print\s*\(/],
  ['spdlog', /\bspdlog::/],
  ['OutputDebugString', /\bOutputDebugString[AW]?\s*\(/],
  ['TRACE', /\bTRACE\d?\s*\(/],
  ['Console.WriteLine', /\bConsole\.Write(?:Line)?\s*\(/],
  ['ILogger', /\bILogger\b|_logger\.Log\w*\s*\(/],
  ['Debug.WriteLine', /\b(?:Debug|Trace)\.WriteLine\s*\(/],
  ['Serilog', /\bLog\.(?:Information|Warning|Error|Debug|Fatal|Verbose)\s*\(/],
  ['logging', /\blogging\.(?:debug|info|warning|error|exception|critical|getLogger|basicConfig)\s*\(/],
  ['print()', /^\s*print\s*\(/],
  ['qDebug', /\bq(?:Debug|Warning|Critical)\s*\(/],
  ['glog LOG()', /\bLOG\s*\(\s*(?:INFO|WARNING|ERROR|FATAL)\s*\)/],
];

const STR_RULES: Array<[string, RegExp]> = [
  ['std::string', /std::string\b(?!_view)/],
  ['std::string_view', /std::string_view\b/],
  ['std::wstring', /std::wstring\b/],
  ['CString', /\bCString[AW]?\b/],
  ['QString', /\bQString\b/],
  ['TCHAR／LPCTSTR', /\b(?:TCHAR|LPCTSTR|LPTSTR|_T\s*\()\b/],
  ['const char*', /\bconst\s+char\s*\*/],
];

function fileStats(text: string, encoding: FileEncoding, file: string): Stats {
  const s = newStats();
  s.files = 1;
  if (encoding !== 'ascii') s.enc[encoding]++;
  const ext = extOf(file);
  const lang = langOf(file);
  if (lang) s.langs.add(lang === 'c' ? 'cpp' : lang);
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const nl = (text.match(/\n/g) ?? []).length;
  if (nl) {
    if (crlf * 2 >= nl) s.crlf++;
    else s.lf++;
  }
  const cLike = C_LIKE.has(ext);
  const isPy = ext === 'py';
  const isCs = ext === 'cs';
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  let prevSpaces = 0;
  let inBlock = false;
  let prevCode = '';
  const nameLang = isCs ? 'csharp' : isPy ? 'python' : ext === 'cu' || ext === 'cuh' ? 'cuda' : cLike ? 'cpp' : (lang ?? 'other');
  const seenIds = new Set<string>();

  for (const raw of lines) {
    const line = raw;
    const trimmed = line.trim();
    if (!trimmed) continue;

    // comments
    const comments: string[] = [];
    if (cLike) {
      if (inBlock) {
        const end = line.indexOf('*/');
        comments.push(end >= 0 ? line.slice(0, end) : line);
        if (end >= 0) inBlock = false;
      } else {
        const lc = /(^|[^:"'])\/\/(.*)$/.exec(line);
        if (lc) comments.push(lc[2]!);
        const bs = line.indexOf('/*');
        if (bs >= 0 && (!lc || bs < (lc.index ?? 0))) {
          const be = line.indexOf('*/', bs + 2);
          comments.push(be >= 0 ? line.slice(bs + 2, be) : line.slice(bs + 2));
          if (be < 0) inBlock = true;
        }
      }
    } else if (isPy) {
      const pc = /^\s*#(.*)$|\s#\s(.*)$/.exec(line);
      if (pc) comments.push(pc[1] ?? pc[2] ?? '');
    }
    for (const c of comments) {
      if (CJK.test(c)) s.zh++;
      else if (/[A-Za-z]{3,}/.test(c)) s.en++;
    }

    // indentation (skip block-comment continuation lines)
    const lead = /^[ \t]*/.exec(line)![0];
    if (lead && !/^\*/.test(trimmed)) {
      if (lead.startsWith('\t')) s.tab++;
      else {
        s.space++;
        const d = lead.length - prevSpaces;
        if (d === 2) s.d2++;
        else if (d === 4) s.d4++;
      }
    }
    if (!lead.startsWith('\t')) prevSpaces = lead.length;

    if (cLike && !inBlock && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
      // braces
      if (trimmed === '{') {
        if (prevCode && !/[;,{}=]$/.test(prevCode) && !prevCode.startsWith('#')) s.next++;
      } else if (/(?:\)|\belse|\btry|\bdo|\b(?:class|struct|namespace|enum)\b[^;=()]*)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?\{\s*(?:\/\/.*)?$/.test(trimmed) && !/=\s*\{/.test(trimmed)) {
        s.same++;
      }
      prevCode = trimmed.replace(/\s*\/\/.*$/, '');

      // naming — members / fields
      for (const m of line.matchAll(/\bm_[A-Za-z]\w*/g)) if (!seenIds.has(m[0])) (seenIds.add(m[0]), bump(s.naming, `${nameLang}|member|m_`, m[0]));
      const tr = /^\s+(?:const\s+|static\s+|mutable\s+)*[A-Za-z_][\w:<>,*& ]*[\s*&]+([a-z][a-z0-9]*(?:_[a-z0-9]+)*_)\s*(?:=[^=]|;|\{)/.exec(line);
      if (tr && !isCs) bump(s.naming, `${nameLang}|member|trailing_`, tr[1]!);
      if (isCs) {
        const cf = /^\s*(?:private|protected|internal)?\s*(?:readonly\s+|static\s+)*[\w<>[\],.?]+\s+(_[a-z]\w*)\s*(?:=|;)/.exec(line);
        if (cf) bump(s.naming, `${nameLang}|member|_camel`, cf[1]!);
      }
      // naming — types
      const cl = /(?<!enum\s)\b(?:class|struct|interface|record)\s+([A-Za-z_]\w*)/.exec(line);
      if (cl && !/^(?:enum)\b/.test(trimmed)) {
        const st = caseStyle(cl[1]!);
        if (st) bump(s.naming, `${nameLang}|type|${st}`, cl[1]!);
      }
      // naming — functions / methods
      let fn: string | null = null;
      if (isCs) {
        fn = /^\s*(?:(?:public|private|protected|internal|static|virtual|override|async|sealed|abstract|new|partial)\s+)+[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\(/.exec(line)?.[1] ?? null;
      } else {
        const fm = /^\s*(?:(?:static|inline|virtual|explicit|constexpr|extern|__global__|__device__|__host__|__forceinline__|friend)\s+)*(?:[A-Za-z_][\w:<>,]*[\s*&]+)+(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)\s*\([^;]*$/.exec(line);
        const first = /^\s*([A-Za-z_]\w*)/.exec(line)?.[1] ?? '';
        if (fm && !KEYWORDS.has(first) && !KEYWORDS.has(fm[1]!) && !line.slice(0, line.indexOf('(')).includes('=') && !/^\s*#/.test(line)) fn = fm[1]!;
      }
      if (fn && fn !== 'main') {
        const st = caseStyle(fn);
        if (st) bump(s.naming, `${nameLang}|func|${st}`, fn);
      }
      const k = /\b(k[A-Z][A-Za-z0-9]+)\s*=/.exec(line);
      if (k && /\b(const|constexpr|static)\b/.test(line)) bump(s.naming, `${nameLang}|const|k`, k[1]!);
    } else if (isPy) {
      const d = /^\s*def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
      if (d && !d[1]!.startsWith('__')) {
        const st = caseStyle(d[1]!.replace(/^_+/, ''));
        if (st) bump(s.naming, `python|func|${st}`, d[1]!);
      }
      const c = /^\s*class\s+([A-Za-z_]\w*)/.exec(line);
      if (c) {
        const st = caseStyle(c[1]!);
        if (st) bump(s.naming, `python|type|${st}`, c[1]!);
      }
    }

    for (const [label, re, scope] of ERR_RULES) {
      if (scope === 'c' && !cLike) continue;
      if (scope === 'py' && !isPy) continue;
      if (re.test(line)) bump(s.err, label);
    }
    for (const [label, re] of LOG_RULES) {
      if (label === 'print()' && !isPy) continue;
      if (re.test(line)) bump(s.log, label);
    }
    if (cLike && !isCs) for (const [label, re] of STR_RULES) if (re.test(line)) bump(s.str, label);
  }

  if (HEADER_EXT.has(ext)) {
    if (/^\s*#\s*pragma\s+once\b/m.test(text)) s.pragma++;
    else if (/^\s*#\s*ifndef\s+(\w+)\s*\r?\n\s*#\s*define\s+\1\b/m.test(text)) s.ifndef++;
  }
  return s;
}

const pick = <T extends string>(a: number, b: number, ka: T, kb: T, min = 1): T | 'mixed' | null => {
  const t = a + b;
  if (t < min) return null;
  if (a / t >= 0.8) return ka;
  if (b / t >= 0.8) return kb;
  return 'mixed';
};

const STYLE_WORD: Record<string, string> = { snake: 'snake_case', camel: 'camelCase', pascal: 'PascalCase' };

function namingPhrases(c: Counter, langs: Set<string>): string[] {
  const out: string[] = [];
  const multi = new Set([...c.keys()].map((k) => k.split('|')[0])).size > 1 || langs.size > 1;
  const prefix = (lang: string) => (multi ? `${LANG_LABEL[lang] ?? lang} ` : '');
  const byLangWhat = new Map<string, Array<[string, { n: number; ex: string | null }]>>();
  for (const [k, v] of c) {
    const [lang, what, style] = k.split('|') as [string, string, string];
    if (what === 'member' || what === 'const') {
      if (v.n < 3) continue;
      const label =
        style === 'm_' ? `成員變數 m_ 前綴（${v.ex}）` : style === 'trailing_' ? `成員變數 _ 後綴（${v.ex}）` : style === '_camel' ? `私有欄位 _camelCase（${v.ex}）` : `常數 k 前綴（${v.ex}）`;
      out.push(prefix(lang) + label);
      continue;
    }
    const key = `${lang}|${what}`;
    if (!byLangWhat.has(key)) byLangWhat.set(key, []);
    byLangWhat.get(key)!.push([style, v]);
  }
  for (const [key, styles] of [...byLangWhat.entries()].sort()) {
    const [lang, what] = key.split('|') as [string, string];
    const noun = what === 'type' ? '類別' : lang === 'csharp' ? '方法' : '函式';
    const total = styles.reduce((a, [, v]) => a + v.n, 0);
    if (total < 2) continue;
    styles.sort((a, b) => b[1].n - a[1].n);
    const [top, tv] = styles[0]!;
    if (tv.n / total >= 0.7) out.push(`${prefix(lang)}${noun} ${STYLE_WORD[top]}（${tv.ex}）`);
    else out.push(`${prefix(lang)}${noun}命名混用（${styles.map(([st, v]) => `${STYLE_WORD[st]} ${v.n}`).join('／')}）`);
  }
  return out;
}

const ranked = (c: Counter, min: number): string[] =>
  [...c.entries()]
    .filter(([, v]) => v.n >= min)
    .sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
    .map(([k]) => k);

function profile(module: string, s: Stats, langCounts: Map<string, number>, configs: Evidence[]): StyleProfile {
  const encTotal = s.enc.utf8 + s.enc.utf8_bom + s.enc.big5 + s.enc.other;
  let dominant: StyleProfile['encoding']['dominant'] = null;
  if (encTotal) {
    const top = (Object.entries(s.enc) as Array<[keyof Stats['enc'], number]>).sort((a, b) => b[1] - a[1])[0]!;
    dominant = top[1] / encTotal >= 0.8 && top[0] !== 'other' ? top[0] : 'mixed';
  }
  const ws = pick(s.tab, s.space, 'tab', 'space', 5);
  const indent: StyleProfile['indent'] = ws === 'tab' ? 'tab' : ws === 'space' ? (s.d2 > s.d4 ? '2' : s.d4 ? '4' : null) : ws === 'mixed' ? 'mixed' : null;
  const zhShare = s.zh + s.en >= 3 ? s.zh / (s.zh + s.en) : null;
  return {
    module,
    files_sampled: s.files,
    languages: [...langCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([l]) => l),
    encoding: { ...s.enc, dominant },
    eol: pick(s.crlf, s.lf, 'crlf', 'lf'),
    indent,
    brace: pick(s.same, s.next, 'same_line', 'next_line', 3),
    naming: namingPhrases(s.naming, s.langs),
    header_guard: pick(s.pragma, s.ifndef, 'pragma_once', 'ifndef'),
    comment_lang: zhShare === null ? null : zhShare >= 0.6 ? 'zh' : zhShare <= 0.2 ? 'en' : 'mixed',
    // a single MappGetError / cudaGetLastError / FAILED() is already a convention worth naming
    error_handling: ranked(s.err, 1).filter((k) => s.err.get(k)!.n >= 2 || /^(MIL|CUDA|HRESULT)/.test(k)),
    logging: ranked(s.log, 2),
    strings: ranked(s.str, 2),
    configs,
  };
}

const CONFIG_FILES = new Set([
  '.clang-format', '_clang-format', '.clang-tidy', '.editorconfig', 'stylecop.json', '.ruff.toml', 'ruff.toml', '.flake8', '.pylintrc', 'pylintrc',
  '.prettierrc', '.prettierrc.json', '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', 'eslint.config.js', 'eslint.config.mjs', '.globalconfig', '.isort.cfg',
]);

function styleConfigs(ctx: RepoCtx): Evidence[] {
  const out: Evidence[] = [];
  for (const f of ctx.files.filter((f) => depthOf(f) <= 4)) {
    const b = baseOf(f);
    if (CONFIG_FILES.has(b)) {
      const first = (ctx.read(f)?.lines ?? []).findIndex((l) => l.trim() && !/^\s*[#;]/.test(l));
      out.push(ev(f, first >= 0 ? first + 1 : null, first >= 0 ? lineText(ctx, f, first + 1) : b));
    } else if (b === 'pyproject.toml' || b === 'setup.cfg' || b === 'tox.ini') {
      (ctx.read(f)?.lines ?? []).forEach((l, i) => {
        if (/^\[(tool\.(ruff|black|isort|pylint|flake8|mypy)[\].]|flake8\]|pycodestyle\]|isort\]|mypy\])/.test(l.trim())) out.push(ev(f, i + 1, l));
      });
    }
  }
  return out;
}

export function analyseStyle(ctx: RepoCtx, maxFiles = 300): StyleProfile[] {
  const code = ctx.files.filter((f) => STYLE_EXT.has(extOf(f)));
  // evenly spread sample over the sorted list so every directory is represented
  const sample: string[] = [];
  if (code.length <= maxFiles) sample.push(...code);
  else for (let i = 0; i < maxFiles; i++) sample.push(code[Math.floor((i * code.length) / maxFiles)]!);

  const topOf = (f: string) => (f.includes('/') ? f.slice(0, f.indexOf('/')) : '');
  const per = new Map<string, Stats>();
  const all = newStats();
  for (const f of sample) {
    const fc = ctx.read(f);
    if (!fc) continue;
    const s = fileStats(fc.text, fc.encoding, f);
    merge(all, s);
    const top = topOf(f);
    if (!top) continue;
    if (!per.has(top)) per.set(top, newStats());
    merge(per.get(top)!, s);
  }
  const langCount = (filter: (f: string) => boolean) => {
    const m = new Map<string, number>();
    for (const f of code.filter(filter)) {
      const l = langOf(f);
      if (l) m.set(l, (m.get(l) ?? 0) + 1);
    }
    return m;
  };
  const configs = styleConfigs(ctx);
  const out = [profile('', all, langCount(() => true), configs)];
  for (const [top, s] of [...per.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (per.size === 1 && !code.some((f) => !topOf(f))) break; // a single dir = the repo-wide profile
    out.push(profile(top, s, langCount((f) => under(f, top)), configs.filter((c) => under(c.file, top) || !c.file.includes('/'))));
  }
  return out;
}
