import { baseOf, codeFiles, extOf, skipPath, type RepoCtx } from './context.js';
import type { IndexEntry } from './types.js';

/**
 * 程式索引 (code index): the strings a machine shows a person — config keys with their default
 * and comment, where the code reads each key, log / format messages, incident kinds and error
 * codes — each pinned to file:line, so a log line, an ini param or an alarm maps back to code.
 */

export const MAX_INDEX = 20_000;
const MAX_USES_PER_KEY = 20;
const GREP_BATCH = 120;
const PARAM_STOP = new Set(
  'name type value mode enable enabled width height id data path file size count index level min max key on off true false default version debug format url port host user password timeout list items item info text title description label tags type_ mode_ source target output input result results status state'.split(
    ' ',
  ),
);
const USE_EXT = ['c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'hxx', 'cu', 'cuh', 'cs', 'py'];
const LOG_EXT = new Set(USE_EXT);
const JSON_SKIP = /^(package(-lock)?|tsconfig.*|jsconfig.*|composer|launch|tasks|c_cpp_properties|settings|extensions|\.mcp|.*\.code-workspace|rf_metadata)\.json$/i;
const YAML_SKIP = /^(docker-compose.*|environment|\.gitlab-ci|mkdocs|pnpm-.*|action|codecov|\.pre-commit-config|conda.*|meta|pubspec|openapi.*|swagger.*)\.ya?ml$/i;

const clip = (s: string, n = 200) => s.trim().slice(0, n);

interface Param {
  key: string;
  section: string | null;
}

function iniParams(ctx: RepoCtx, f: string, out: IndexEntry[], params: Param[]): void {
  const lines = ctx.read(f)?.lines ?? [];
  let section: string | null = null;
  let comments: string[] = [];
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (!t) {
      comments = [];
      return;
    }
    if (/^[#;]/.test(t)) {
      const c = t.replace(/^[#;]+\s?/, '').trim();
      if (c && !/^[=\-*#~_+ ]+$/.test(c)) comments.push(c);
      return;
    }
    const sec = /^\[([^\]]+)\]/.exec(t);
    if (sec) {
      section = sec[1]!.trim();
      comments = [];
      return;
    }
    const kv = /^([^=:\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(t);
    if (!kv) {
      comments = [];
      return;
    }
    const key = kv[1]!.trim();
    const value = kv[2]!.replace(/\s+[;#].*$/, '').trim();
    out.push({ kind: 'param', key, section, file: f, line: i + 1, text: clip(t), value, meaning: comments.length ? comments.join(' ').slice(0, 300) : null });
    params.push({ key, section });
    comments = [];
  });
}

const fmtValue = (v: unknown): string | null => {
  if (v === null) return 'null';
  if (typeof v === 'string') return v.slice(0, 200);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v).slice(0, 120);
  } catch {
    return null;
  }
};

function jsonParams(ctx: RepoCtx, f: string, out: IndexEntry[], params: Param[]): void {
  const fc = ctx.read(f);
  if (!fc) return;
  let data: unknown;
  try {
    data = JSON.parse(fc.text);
  } catch {
    try {
      data = JSON.parse(fc.text.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));
    } catch {
      return;
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  const findLine = (key: string, from: number): number => {
    const needle = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`);
    for (let i = from; i < fc.lines.length; i++) if (needle.test(fc.lines[i]!)) return i;
    return -1;
  };
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (/^(_comment|\/\/|\$schema|_doc|_note)/i.test(k)) continue;
    const li = findLine(k, 0);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) {
        const cl = findLine(ck, Math.max(0, li));
        if (cl < 0) continue;
        out.push({ kind: 'param', key: ck, section: k, file: f, line: cl + 1, text: clip(fc.lines[cl]!), value: cv && typeof cv === 'object' ? fmtValue(cv) : fmtValue(cv), meaning: null });
        params.push({ key: ck, section: k });
      }
    } else if (li >= 0) {
      out.push({ kind: 'param', key: k, section: null, file: f, line: li + 1, text: clip(fc.lines[li]!), value: fmtValue(v), meaning: null });
      params.push({ key: k, section: null });
    }
  }
}

function yamlParams(ctx: RepoCtx, f: string, out: IndexEntry[], params: Param[]): void {
  const lines = ctx.read(f)?.lines ?? [];
  let comments: string[] = [];
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) {
      comments = [];
      return;
    }
    if (/^\s*#/.test(line)) {
      if (!/^\s/.test(line)) {
        const c = line.replace(/^#+\s?/, '').trim();
        if (c && !/^[=\-*#~_+ ]+$/.test(c)) comments.push(c);
      }
      return;
    }
    const m = /^([A-Za-z_][\w.-]*)\s*:(?:\s+(.*))?$/.exec(line);
    if (m) {
      const value = (m[2] ?? '').replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim();
      out.push({ kind: 'param', key: m[1]!, section: null, file: f, line: i + 1, text: clip(line), value: value || null, meaning: comments.length ? comments.join(' ').slice(0, 300) : null });
      params.push({ key: m[1]!, section: null });
    }
    if (!/^\s/.test(line)) comments = [];
  });
}

function isJsonConfig(f: string): boolean {
  const b = baseOf(f);
  if (JSON_SKIP.test(b) || f.split('/').some((p) => p === '.vscode' || p === '.github' || p === '.devcontainer')) return false;
  return f.split('/').slice(0, -1).some((p) => /^(config|configs|conf|cfg|settings|params?)$/i.test(p)) || /config|settings|param/i.test(b);
}

function isYamlConfig(f: string): boolean {
  if (YAML_SKIP.test(baseOf(f))) return false;
  return !f.split('/').some((p) => p.startsWith('.') && p.length > 1);
}

function paramUses(ctx: RepoCtx, params: Param[], out: IndexEntry[]): void {
  const sections = new Map<string, Set<string | null>>();
  for (const p of params) {
    if (p.key.length < 3 || PARAM_STOP.has(p.key.toLowerCase()) || !/^[\w.-]+$/.test(p.key)) continue;
    if (!sections.has(p.key)) sections.set(p.key, new Set());
    sections.get(p.key)!.add(p.section);
  }
  const keys = [...sections.keys()].slice(0, 3000);
  const uses = new Map<string, number>();
  for (let b = 0; b < keys.length; b += GREP_BATCH) {
    const batch = keys.slice(b, b + GREP_BATCH);
    let res = '';
    try {
      res = ctx.git(
        ['-c', 'core.quotepath=false', 'grep', '-n', '-I', '--no-color', '-F', ...batch.flatMap((k) => ['-e', `"${k}"`, '-e', `'${k}'`]), '--', ...USE_EXT.map((e) => `*.${e}`)],
        ctx.dir,
      );
    } catch (e) {
      ctx.warnings.push(`git grep 失敗：${(e as Error).message.split('\n')[0]}`);
      return;
    }
    for (const l of res.split('\n')) {
      const m = /^(.+?):(\d+):(.*)$/.exec(l);
      if (!m || skipPath(m[1]!)) continue;
      const text = m[3]!;
      for (const k of batch) {
        if (!text.includes(`"${k}"`) && !text.includes(`'${k}'`)) continue;
        const n = uses.get(k) ?? 0;
        if (n >= MAX_USES_PER_KEY) continue;
        uses.set(k, n + 1);
        const secs = sections.get(k)!;
        out.push({ kind: 'param_use', key: k, section: secs.size === 1 ? [...secs][0]! : null, file: m[1]!, line: Number(m[2]), text: clip(text), value: null, meaning: null });
      }
    }
  }
}

const LOG_HEAD =
  /(std::(?:cerr|cout|clog)\s*<<|\bqDebug\s*\(\s*\)\s*<<|\bf?printf\s*\(|\bfmt::(?:print|format)\s*\(|\bspdlog::\w+\s*\(|\bLOG[A-Z_]*\s*\(|\bTRACE\w*\s*\(|\bConsole\.(?:Error\.)?Write(?:Line)?\s*\(|\b_?[lL]ogger\.\w+\s*\(|\bLog\.\w+\s*\(|\b(?:Debug|Trace)\.WriteLine\s*\(|\blogging\.(?:debug|info|warning|warn|error|exception|critical)\s*\(|\blog\.(?:debug|info|warning|warn|error|exception|critical)\s*\(|(?<![\w.])print\s*\(|\bOutputDebugString\w*\s*\()/;
const LIT = /(?:[fFrRbBuU]{1,2}|\$@?|@\$?|L|u8)?"((?:[^"\\]|\\.)*)"|(?:[fFrRbBuU]{1,2})?'((?:[^'\\]|\\.)*)'/g;

function logKey(rest: string, stream: boolean, py: boolean): string | null {
  const parts: string[] = [];
  let last = -1;
  for (const m of rest.matchAll(LIT)) {
    if (m[2] !== undefined && !py) continue; // C-family 'x' is a char
    const s = (m[1] ?? m[2] ?? '').replace(/\\[nrt]/g, ' ').replace(/\\(["'\\])/g, '$1');
    if (last < 0) {
      // the message must be an argument of this call, not of something after it
      if (!stream && rest.slice(0, m.index).includes(')')) return null;
    } else {
      // stream chains: `"a" << x << "b"` → "a{}b"; calls: only adjacent / `+`-joined literals
      const gap = rest.slice(last, m.index);
      const trivial = !gap.replace(stream ? /<<|\s/g : /\s|\+/g, '');
      if (!stream && !trivial) break;
      if (!trivial) parts.push('{}');
    }
    parts.push(s);
    last = m.index! + m[0].length;
  }
  // `<< "open failed: " << path;` — the value printed after the last literal
  if (stream && last >= 0 && rest.slice(last).replace(/<<|\s|;|std::endl|std::flush|\bendl\b|'\\n'/g, '')) parts.push('{}');
  const key = parts.join('').replace(/\s+/g, ' ').trim();
  if (key.length < 8 || !/[A-Za-z\u3400-\u9fff]/.test(key)) return null;
  return key.slice(0, 160);
}

const INCIDENT_RES = [
  /\brecord_?[iI]ncident\s*\(\s*["']([^"']+)["']/,
  /\b\w*INCIDENT\w*\s*\(\s*["']([^"']+)["']/,
  /\b(?:RaiseAlarm|raise_alarm|SetAlarm|set_alarm|ReportAlarm|report_alarm|Alarm)\s*\(\s*["']([^"']+)["']/,
];

function scanCode(ctx: RepoCtx, logs: IndexEntry[], incidents: IndexEntry[], codes: IndexEntry[]): void {
  for (const f of codeFiles(ctx, LOG_EXT)) {
    const fc = ctx.read(f);
    if (!fc) continue;
    const py = extOf(f) === 'py';
    fc.lines.forEach((raw, i) => {
      const t = raw.trim();
      if (!t || t.startsWith('//') || t.startsWith('*') || (py && t.startsWith('#'))) return;
      if (/^#\s*define\b/.test(t)) {
        const d = /^#\s*define\s+((?:ERR|E|ALM|ALARM|ERROR|EC)_[A-Z0-9_]+)\s+\(?\s*(-?(?:0x[0-9a-fA-F]+|\d+))\b/.exec(t);
        if (d) codes.push({ kind: 'error_code', key: d[1]!, section: null, file: f, line: i + 1, text: clip(t), value: d[2]!, meaning: null });
        return;
      }
      for (const re of INCIDENT_RES) {
        const m = re.exec(t);
        if (m) {
          const call = /\b(\w+)\s*\(/.exec(t.slice(m.index))?.[1] ?? null;
          incidents.push({ kind: 'incident', key: m[1]!, section: call, file: f, line: i + 1, text: clip(t), value: null, meaning: null });
          break;
        }
      }
      const h = LOG_HEAD.exec(t);
      if (h) {
        const key = logKey(t.slice(h.index + h[0].length), h[0].includes('<<'), py);
        if (key) logs.push({ kind: 'log', key, section: null, file: f, line: i + 1, text: clip(t), value: null, meaning: null });
      }
    });
    // error enums
    if (/\benum\b/.test(fc.text)) enumCodes(ctx, f, fc.text, codes);
  }
}

function enumCodes(ctx: RepoCtx, f: string, text: string, out: IndexEntry[]): void {
  const blocks: Array<{ name: string; body: string; at: number }> = [];
  for (const m of text.matchAll(/\benum\s+(?:class\s+|struct\s+)?(\w+)\s*(?::\s*[\w:\s]+?)?\s*\{([^}]*)\}/g)) blocks.push({ name: m[1]!, body: m[2]!, at: m.index! + m[0].indexOf('{') + 1 });
  for (const m of text.matchAll(/\btypedef\s+enum\s*\w*\s*\{([^}]*)\}\s*(\w+)/g)) blocks.push({ name: m[2]!, body: m[1]!, at: m.index! + m[0].indexOf('{') + 1 });
  for (const b of blocks) {
    if (!/err|alarm|code|fault/i.test(b.name)) continue;
    const startLine = ctx.lineAt(f, b.at);
    let next: number | null = 0;
    b.body.split('\n').forEach((rawLine, li) => {
      const line = rawLine.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
      for (const tok of line.split(',')) {
        const m = /^\s*(?:\[[^\]]*\]\s*)?([A-Za-z_]\w*)\s*(?:=\s*(.+?))?\s*$/.exec(tok);
        if (!m) continue;
        let value: string | null;
        if (m[2] !== undefined) {
          const v = m[2].trim();
          const num = /^-?(0x[0-9a-fA-F]+|\d+)[uUlL]*$/.test(v) ? Number(v.replace(/[uUlL]+$/, '')) : NaN;
          value = Number.isFinite(num) ? String(num) : v;
          next = Number.isFinite(num) ? num + 1 : null;
        } else {
          value = next === null ? null : String(next);
          next = next === null ? null : next + 1;
        }
        const n = startLine + li;
        out.push({ kind: 'error_code', key: m[1]!, section: b.name, file: f, line: n, text: clip(rawLine), value, meaning: null });
      }
    });
  }
}

export function buildCodeIndex(ctx: RepoCtx): IndexEntry[] {
  const params: IndexEntry[] = [];
  const keys: Param[] = [];
  for (const f of ctx.files) {
    const e = extOf(f);
    try {
      if (e === 'ini') iniParams(ctx, f, params, keys);
      else if (e === 'json' && isJsonConfig(f)) jsonParams(ctx, f, params, keys);
      else if ((e === 'yaml' || e === 'yml') && isYamlConfig(f)) yamlParams(ctx, f, params, keys);
    } catch (err) {
      ctx.warnings.push(`設定檔解析失敗（${f}）：${(err as Error).message}`);
    }
  }
  const uses: IndexEntry[] = [];
  paramUses(ctx, keys, uses);
  const logs: IndexEntry[] = [];
  const incidents: IndexEntry[] = [];
  const codes: IndexEntry[] = [];
  scanCode(ctx, logs, incidents, codes);
  const all = [...params, ...codes, ...incidents, ...uses, ...logs];
  if (all.length > MAX_INDEX) ctx.warnings.push(`程式索引 ${all.length} 筆，只保留前 ${MAX_INDEX} 筆`);
  return all.slice(0, MAX_INDEX);
}
