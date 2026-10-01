// 機況 parser — turns what a CF-AOI production machine produced (flight-recorder jsonl,
// incident_*.json, INI files, free-form text logs / OCR text) into structured events.
// Pure: no I/O, no model calls, no DB. Never throws on bad input; problems become warnings.

import type {
  DiagEvent,
  DiagEventType,
  DiagInput,
  DiagSession,
  IniChange,
  IniFile,
  ParsedDiag,
  SrcRef,
} from './types.js';

export type * from './types.js';

const MAX_EVENTS = 2000;
const MAX_LIST = 500; // errors / incidents lists
const MAX_WARNINGS = 50;
const MAX_TOTAL_CHARS = 5 * 1024 * 1024;
const MAX_DETAIL = 1000;
const MAX_RAW = 2000;
const SCAN_CHARS = 4000; // regex scanning window of one text line
const MAX_FRAMES = 40;
const MAX_SIGNATURE = 30;
const JSON_BLOCK_LINES = 200; // a pretty-printed JSON object inside a paste
const JSON_BLOCK_CHARS = 200_000;

/** Log levels counted as errors (besides incidents). */
const ERROR_LEVELS = new Set(['FATAL', 'EXCEPTION', 'ERROR', 'ALARM']);
const LEVEL_RANK: Record<string, number> = { FATAL: 0, EXCEPTION: 1, ERROR: 2, ALARM: 3, WARN: 4 };

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

function fmtNum(v: unknown): string {
  if (typeof v !== 'number') return JSON.stringify(v) ?? String(v);
  return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(4)));
}

// ---------------------------------------------------------------- timestamps

const RE_TS_ISO = /\b(\d{4}-\d{2}-\d{2}[T ]\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?)/;
const RE_TS_SLASH = /\b(\d{4}\/\d{1,2}\/\d{1,2}\s+(?:(?:上午|下午|AM|PM)\s*)?\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,6})?(?:\s?(?:AM|PM)\b)?)/i;
const RE_TS_TIME = /(?<![\d:.])(\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,6})?)(?![\d:])/;

function findTs(line: string): string | null {
  const m = RE_TS_ISO.exec(line) ?? RE_TS_SLASH.exec(line) ?? RE_TS_TIME.exec(line);
  return m ? m[1]! : null;
}

/** Sortable key for a timestamp as written; `dated` false for a bare HH:MM:SS. */
function tsKey(ts: string): { key: string; dated: boolean } | null {
  const d = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(ts);
  const t = /(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d{1,6}))?/.exec(d ? ts.slice(d.index + d[0].length) : ts);
  if (!t) return null;
  let h = Number(t[1]);
  if (/下午|PM/i.test(ts) && h < 12) h += 12;
  if (/上午|AM/i.test(ts) && h === 12) h = 0;
  const frac = (t[4] ?? '').padEnd(6, '0');
  const time = `${String(h).padStart(2, '0')}:${t[2]}:${t[3]}.${frac}`;
  if (!d) return { key: time, dated: false };
  return { key: `${d[1]}-${d[2]!.padStart(2, '0')}-${d[3]!.padStart(2, '0')}T${time}`, dated: true };
}

// ---------------------------------------------------------------- codes

const RE_CODE_ERR = /\bERR_\w+/g;
const RE_CODE_E = /\bE\d{3,5}\b/g;
const RE_CODE_HEX = /\b0x[0-9A-Fa-f]{4,8}\b/g;
const RE_CODE_ALM = /\bALM\d+\b/gi;
const RE_CODE_ALARM = /\balarm\s*[#:]?\s*(\d+)\b/gi;
const RE_CODE_MIL = /\bMIL\b[^\n]*?\bcode\s*[:=#]?\s*(-?\d+)/i;
const RE_CODE_GENERIC = /\bcode\s*[=:#]?\s*(-?\d+)\b/gi;

function extractCodes(s: string): string[] {
  const out = new Set<string>();
  for (const m of s.matchAll(RE_CODE_ERR)) out.add(m[0]);
  for (const m of s.matchAll(RE_CODE_E)) out.add(m[0]);
  for (const m of s.matchAll(RE_CODE_HEX)) out.add('0x' + m[0].slice(2).toUpperCase());
  for (const m of s.matchAll(RE_CODE_ALM)) out.add(m[0].toUpperCase());
  for (const m of s.matchAll(RE_CODE_ALARM)) out.add(`ALARM ${m[1]}`);
  const mil = RE_CODE_MIL.exec(s);
  if (mil) out.add(`MIL:${mil[1]}`);
  else for (const m of s.matchAll(RE_CODE_GENERIC)) out.add(`code=${m[1]}`);
  return [...out];
}

// ---------------------------------------------------------------- source references

const EXT = '(?:cpp|cxx|cc|c|hpp|hxx|hh|h|inl|cuh|cu|cs|pyx|py|mjs|cjs|js|tsx|ts|java|kt|go|rs|vb)';
const RE_SRC_CS = /\bat\s+([^\s(]+)\([^)]*\)\s+in\s+(.+?):line\s+(\d+)/g;
const RE_SRC_PY = /File\s+"([^"]+)",\s+line\s+(\d+)(?:,\s+in\s+(\S+))?/g;
const RE_SRC_JAVA = /\bat\s+([\w$.<>]+)\(([\w$.-]+\.(?:java|kt|scala|groovy)):(\d+)\)/g;
const RE_SRC_GDB = /#\d+\s+(?:0x[0-9a-fA-F]+\s+in\s+)?([^\s(]+)\s*\([^)]*\)\s+at\s+([^\s:]+):(\d+)/g;
const RE_SRC_MSVC = new RegExp(`((?:[A-Za-z]:)?[\\w./\\\\-]*\\w\\.${EXT})\\((\\d+)\\)`, 'g');
const RE_SRC_GEN = new RegExp(`((?:[A-Za-z]:)?[\\w./\\\\-]*\\w\\.${EXT}):(\\d+)\\b`, 'g');
const RE_SRC_HINT = new RegExp(`\\.${EXT}\\b|File "|#\\d+\\s`);

const normFile = (f: string): string => f.trim().replace(/\\/g, '/');

function ref(file: string, line: string | number | null | undefined, func: string | null | undefined): SrcRef {
  const n = line == null || line === '' ? null : Number(line);
  return { file: normFile(file), line: n != null && Number.isFinite(n) ? n : null, func: func || null };
}

function extractSrc(s: string): SrcRef[] {
  if (!RE_SRC_HINT.test(s)) return [];
  const out: SrcRef[] = [];
  for (const m of s.matchAll(RE_SRC_CS)) out.push(ref(m[2]!, m[3], m[1]));
  for (const m of s.matchAll(RE_SRC_PY)) out.push(ref(m[1]!, m[2], m[3]));
  for (const m of s.matchAll(RE_SRC_JAVA)) out.push(ref(m[2]!, m[3], m[1]));
  for (const m of s.matchAll(RE_SRC_GDB)) out.push(ref(m[2]!, m[3], m[1]));
  if (out.length) return out;
  for (const m of s.matchAll(RE_SRC_MSVC)) out.push(ref(m[1]!, m[2], null));
  for (const m of s.matchAll(RE_SRC_GEN)) out.push(ref(m[1]!, m[2], null));
  return out;
}

/** "ip/src/control_server.cpp:407" → SrcRef. */
function parseSrcString(s: string): SrcRef | null {
  const t = s.trim();
  if (!t) return null;
  const found = extractSrc(t);
  if (found.length) return found[0]!;
  const m = /^(.+?):(\d+)(?::\d+)?$/.exec(t);
  return m ? ref(m[1]!, m[2], null) : ref(t, null, null);
}

function stackRefs(stack: unknown): SrcRef[] {
  const out: SrcRef[] = [];
  const add = (r: SrcRef | null): void => {
    if (r && out.length < MAX_FRAMES) out.push(r);
  };
  if (typeof stack === 'string') {
    for (const l of stack.split(/\r?\n/)) for (const r of extractSrc(l.slice(0, SCAN_CHARS))) add(r);
  } else if (Array.isArray(stack)) {
    for (const f of stack) {
      if (typeof f === 'string') {
        const found = extractSrc(f.slice(0, SCAN_CHARS));
        if (found.length) found.forEach(add);
        else if (/^[^\s]+:\d+$/.test(f.trim())) add(parseSrcString(f));
      } else if (isObj(f) && typeof f.file === 'string') {
        add(ref(f.file, num(f.line), str(f.func) ?? str(f.function)));
      }
    }
  }
  return out;
}

function sameRef(a: SrcRef, b: SrcRef): boolean {
  return a.file === b.file && a.line === b.line && a.func === b.func;
}

// ---------------------------------------------------------------- log levels

/** Cheap superset filter: a line that fails this is never an event. */
const RE_KEY =
  /err|fatal|critical|panic|warn|exception|traceback|fail|alarm|\balm\d|time[ d-]?out|錯誤|失敗|異常|逾時|超時|告警|警報|警告|致命|例外/i;
const RE_LVL_EXPLICIT = /\b(FATAL|CRITICAL|PANIC|ERROR|ERR|EXCEPTION|ALARM|WARNING|WARN)\b/;
const RE_LVL_FATAL = /\b(?:fatal|critical|panic)\b|致命/i;
const RE_LVL_EXC = /Exception\b|\bexception\b|Traceback \(most recent call last\)|未處理的例外|例外狀況/;
const RE_LVL_ERROR =
  /\b(?:error|err|failed|failure|fail)\b|M_ERROR|\bERR_\w|錯誤|失敗|異常|逾時|超時|\btime(?:d)?[ -]?out\b/i;
const RE_LVL_ALARM = /\balarm\b|\bALM\d+|告警|警報/i;
const RE_LVL_WARN = /\bwarn(?:ing)?\b|警告/i;

function levelOf(s: string): string | null {
  const ex = RE_LVL_EXPLICIT.exec(s);
  if (ex) {
    const t = ex[1]!;
    if (t === 'FATAL' || t === 'CRITICAL' || t === 'PANIC') return 'FATAL';
    if (t === 'ERROR' || t === 'ERR') return 'ERROR';
    if (t === 'WARNING' || t === 'WARN') return 'WARN';
    return t; // EXCEPTION / ALARM
  }
  if (RE_LVL_FATAL.test(s)) return 'FATAL';
  if (RE_LVL_EXC.test(s)) return 'EXCEPTION';
  if (RE_LVL_ALARM.test(s)) return 'ALARM';
  if (RE_LVL_ERROR.test(s)) return 'ERROR';
  if (RE_LVL_WARN.test(s)) return 'WARN';
  return null;
}

const RE_EXC_NAME = /((?:[A-Za-z_]\w*\.)*[A-Z]\w*(?:Exception|Error))\b(?=\s*:|\s*$)/;

function exceptionName(s: string | null): string | null {
  if (!s) return null;
  const m = RE_EXC_NAME.exec(s);
  return m ? m[1]! : null;
}

// ---------------------------------------------------------------- INI

const RE_INI_SECTION = /^\[([^\[\]]+)\]$/;
const RE_INI_KV = /^[^=\[\]{}"]+=/;

export function parseIni(name: string, text: string): IniFile {
  const sections: Record<string, Record<string, string>> = {};
  let cur = '';
  for (const rawLine of normalize(text).split('\n')) {
    const t = rawLine.trim();
    if (!t || t[0] === '#' || t[0] === ';') continue;
    const sec = RE_INI_SECTION.exec(t);
    if (sec) {
      cur = sec[1]!.trim();
      if (cur === '__proto__') cur = '_proto_';
      sections[cur] ??= {};
      continue;
    }
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (!key || key === '__proto__') continue;
    const value = t.slice(eq + 1).replace(/\s+[;#].*$/, '').trim();
    (sections[cur] ??= {})[key] = value;
  }
  return { name, sections };
}

function looksIni(lines: string[], name: string): boolean {
  let sec = 0;
  let kv = 0;
  let other = 0;
  for (const l of lines) {
    const t = l.trim();
    if (!t || t[0] === '#' || t[0] === ';') continue;
    if (RE_INI_SECTION.test(t)) sec++;
    else if (RE_INI_KV.test(t)) kv++;
    else if (t[0] === '{') return false;
    else other++;
  }
  if (sec < 1 || kv < 1) return false;
  return /\.(ini|cfg|conf)$/i.test(name) || other <= 0.1 * (sec + kv);
}

const RE_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

function sameIniValue(a: string, b: string): boolean {
  const x = a.trim().replace(/^"(.*)"$/, '$1');
  const y = b.trim().replace(/^"(.*)"$/, '$1');
  if (x === y) return true;
  return RE_NUMBER.test(x) && RE_NUMBER.test(y) && Number(x) === Number(y);
}

/** Keys compared case-insensitively (Windows INI semantics); current spelling wins in the output. */
export function iniDiff(current: IniFile, baseline: IniFile): IniChange[] {
  const index = (f: IniFile): Map<string, { name: string; keys: Map<string, { key: string; value: string }> }> => {
    const m = new Map<string, { name: string; keys: Map<string, { key: string; value: string }> }>();
    for (const [sec, kv] of Object.entries(f.sections)) {
      const s = m.get(sec.toLowerCase()) ?? { name: sec, keys: new Map() };
      for (const [k, v] of Object.entries(kv)) s.keys.set(k.toLowerCase(), { key: k, value: v });
      m.set(sec.toLowerCase(), s);
    }
    return m;
  };
  const cur = index(current);
  const base = index(baseline);
  const out: IniChange[] = [];
  for (const [sk, s] of cur) {
    const b = base.get(sk);
    for (const [kk, { key, value }] of s.keys) {
      const bv = b?.keys.get(kk);
      if (!bv) out.push({ section: s.name, key, current: value, baseline: null });
      else if (!sameIniValue(value, bv.value)) out.push({ section: s.name, key, current: value, baseline: bv.value });
    }
  }
  for (const [sk, b] of base) {
    const s = cur.get(sk);
    for (const [kk, { key, value }] of b.keys) {
      if (!s?.keys.has(kk)) out.push({ section: s?.name ?? b.name, key, current: null, baseline: value });
    }
  }
  return out;
}

// ---------------------------------------------------------------- JSON events

function sessionOf(o: Record<string, unknown>, ts: string | null): DiagSession {
  const g = isObj(o.gpu) ? o.gpu : null;
  return {
    ts,
    ip_name: str(o.ip_name),
    mode: str(o.mode),
    ini: str(o.ini),
    recipe: str(o.recipe),
    gpu: g ? { name: str(g.name), sm: num(g.sm), free_mb: num(g.free_mb), total_mb: num(g.total_mb) } : null,
    ai_active: bool(o.ai_active),
  };
}

function sessionDetail(s: DiagSession): string {
  const parts: string[] = [];
  if (s.ip_name) parts.push(s.ip_name);
  if (s.mode) parts.push(`mode=${s.mode}`);
  if (s.ini) parts.push(`ini=${s.ini}`);
  if (s.recipe) parts.push(`recipe=${s.recipe}`);
  if (s.gpu) {
    const g = s.gpu;
    parts.push(
      `GPU=${g.name ?? '?'}${g.sm != null ? ` sm${g.sm}` : ''}${
        g.free_mb != null || g.total_mb != null ? ` ${g.free_mb ?? '?'}/${g.total_mb ?? '?'}MB` : ''
      }`,
    );
  }
  if (s.ai_active != null) parts.push(`ai=${s.ai_active ? 'on' : 'off'}`);
  return parts.join(' ');
}

function recipeDetail(o: Record<string, unknown>): string {
  const parts: string[] = [str(o.label) ?? str(o.name) ?? '(recipe)'];
  const zones = Array.isArray(o.zones) ? o.zones : [];
  for (const z of zones.slice(0, 4)) {
    if (!isObj(z)) continue;
    const bits: string[] = [];
    if (Array.isArray(z.pitch)) bits.push(`pitch=${z.pitch.map(fmtNum).join('x')}`);
    for (const k of ['BTH', 'DTH', 'algo_mode', 'multiscale']) if (k in z) bits.push(`${k}=${fmtNum(z[k])}`);
    if (Array.isArray(z.blob)) bits.push(`blob=[${z.blob.map(fmtNum).join(',')}]`);
    if (Array.isArray(z.roi) && z.roi.some((v) => v !== -1)) bits.push(`roi=[${z.roi.map(fmtNum).join(',')}]`);
    parts.push(`z${fmtNum(z.zone_index ?? zones.indexOf(z))}: ${bits.join(' ')}`);
  }
  if (zones.length > 4) parts.push(`(+${zones.length - 4} zones)`);
  return parts.join('；');
}

function otherDetail(o: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (k === 'type' || k === 'ts') continue;
    parts.push(`${k}=${typeof v === 'object' && v !== null ? clip(JSON.stringify(v), 80) : fmtNum(v)}`);
  }
  return parts.join(' ');
}

function jsonEvent(o: Record<string, unknown>, input: string, line: number, raw: string): DiagEvent {
  const t = str(o.type);
  let type: DiagEventType;
  if (t === 'session' || t === 'recipe' || t === 'incident' || t === 'incident_suppressed') type = t;
  else if (!t && typeof o.kind === 'string' && (typeof o.detail === 'string' || typeof o.src === 'string'))
    type = 'incident';
  else if (!t && 'ip_name' in o && 'mode' in o) type = 'session';
  else type = 'other';
  const ts = str(o.ts) ?? str(o.time) ?? str(o.timestamp);
  let kind: string | null = null;
  let detail: string | null = null;
  const src: SrcRef[] = [];
  let codes: string[] = [];
  if (type === 'incident' || type === 'incident_suppressed') {
    kind = str(o.kind);
    detail = str(o.detail);
    const s = typeof o.src === 'string' ? parseSrcString(o.src) : null;
    if (s) src.push(s);
    for (const r of stackRefs(o.stack)) if (!src.some((x) => sameRef(x, r))) src.push(r);
    const stackText = typeof o.stack === 'string' ? o.stack : Array.isArray(o.stack) ? o.stack.join('\n') : '';
    codes = extractCodes(`${detail ?? ''}\n${stackText}`.slice(0, SCAN_CHARS * 4));
  } else if (type === 'session') {
    detail = sessionDetail(sessionOf(o, ts));
  } else if (type === 'recipe') {
    detail = recipeDetail(o);
  } else {
    kind = t;
    detail = otherDetail(o);
  }
  return {
    type,
    ts,
    kind,
    detail: detail == null ? null : clip(detail, MAX_DETAIL),
    src,
    codes,
    input,
    line,
    raw: clip(raw, MAX_RAW),
    data: o,
  };
}

/** Index of the line that closes a JSON object opened on `lines[start]`, or -1. */
function jsonBlockEnd(lines: string[], start: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  let chars = 0;
  const stop = Math.min(lines.length, start + JSON_BLOCK_LINES);
  for (let i = start; i < stop; i++) {
    const l = lines[i]!;
    chars += l.length;
    if (chars > JSON_BLOCK_CHARS) return -1;
    for (let j = 0; j < l.length; j++) {
      const c = l[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) return j === l.trimEnd().length - 1 ? i : -1;
        if (depth < 0) return -1;
      }
    }
  }
  return -1;
}

function normalize(text: string): string {
  let t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (t.includes('\r')) t = t.replace(/\r\n?/g, '\n');
  if (t.includes('\u0000')) t = t.replace(/\u0000/g, '');
  return t;
}

// ---------------------------------------------------------------- collector

interface Pending {
  ev: DiagEvent;
  mode: 'py' | 'stack';
  rawLines: string[];
}

const RE_FRAME_STACK = /^\s+at\s|^\s*--- End of|^\s*---> |^\s*Caused by:|^\s+\.\.\. \d+ more|^\s*#\d+\s+0x/;
const RE_FRAME_ORPHAN = /^\s+at\s+\S+\(/;
const RE_PY_HEADER = /Traceback \(most recent call last\):?/;
const RE_NEW_LOG_LINE = /^\[?\d{1,4}[-/:]\d/;
const RE_PY_CONT = /^(During handling of the above exception|The above exception was the direct cause|Traceback \(most recent call last\))/;

class Collector {
  events: DiagEvent[] = [];
  errors: DiagEvent[] = [];
  incidents: DiagEvent[] = [];
  sessions: DiagSession[] = [];
  ini: IniFile[] = [];
  warnings: string[] = [];
  dropped = { events: 0, errors: 0, incidents: 0, warnings: 0 };
  incidentsByKind: Record<string, number> = {};
  codes: Record<string, number> = {};
  srcFiles: Record<string, number> = {};
  levels: Record<string, number> = {};
  private first: { key: string; ts: string } | null = null;
  private last: { key: string; ts: string } | null = null;
  private firstT: { key: string; ts: string } | null = null;
  private lastT: { key: string; ts: string } | null = null;
  private sessionKeys = new Map<string, DiagSession>();
  private globalIncidents = new Map<string, DiagEvent>();
  private localIncidents = new Map<string, DiagEvent>();
  private suppressedRuns = new Map<string, number>();

  warn(msg: string): void {
    if (this.warnings.length < MAX_WARNINGS) this.warnings.push(msg);
    else this.dropped.warnings++;
  }

  beginInput(): void {
    this.localIncidents.clear();
    this.suppressedRuns.clear();
  }

  endInput(): void {
    for (const [kind, n] of this.suppressedRuns) this.bumpKind(kind, n);
    this.suppressedRuns.clear();
  }

  get firstTs(): string | null {
    return (this.first ?? this.firstT)?.ts ?? null;
  }
  get lastTs(): string | null {
    return (this.last ?? this.lastT)?.ts ?? null;
  }

  addIni(f: IniFile): void {
    this.ini.push(f);
  }

  addSession(s: DiagSession): void {
    const key = JSON.stringify({ ...s, ts: null, gpu: s.gpu ? { ...s.gpu, free_mb: null } : null });
    const prev = this.sessionKeys.get(key);
    if (prev) {
      if (!prev.ts && s.ts) prev.ts = s.ts;
      return;
    }
    this.sessionKeys.set(key, s);
    this.sessions.push(s);
  }

  emit(ev: DiagEvent): void {
    if (ev.ts) this.trackTs(ev.ts);
    for (const c of ev.codes) this.codes[c] = (this.codes[c] ?? 0) + 1;
    for (const r of ev.src) this.srcFiles[r.file] = (this.srcFiles[r.file] ?? 0) + 1;
    if (ev.type === 'log' && ev.kind) this.levels[ev.kind] = (this.levels[ev.kind] ?? 0) + 1;
    if (this.events.length < MAX_EVENTS) this.events.push(ev);
    else this.dropped.events++;
    if (ev.type === 'log' && ev.kind && ERROR_LEVELS.has(ev.kind)) this.pushError(ev);
    if (ev.type === 'session' && ev.data) this.addSession(sessionOf(ev.data, ev.ts));
    if ((ev.type === 'incident' || ev.type === 'incident_suppressed') && ev.data) {
      if (isObj(ev.data.session)) this.addSession(sessionOf(ev.data.session, null));
      this.incident(ev);
    }
  }

  private pushError(ev: DiagEvent): void {
    if (this.errors.length < MAX_LIST) this.errors.push(ev);
    else this.dropped.errors++;
  }

  private bumpKind(kind: string, n: number): void {
    if (n > 0) this.incidentsByKind[kind] = (this.incidentsByKind[kind] ?? 0) + n;
  }

  private trackTs(ts: string): void {
    const k = tsKey(ts);
    if (!k) return;
    const e = { key: k.key, ts };
    if (k.dated) {
      if (!this.first || k.key < this.first.key) this.first = e;
      if (!this.last || k.key > this.last.key) this.last = e;
    } else {
      if (!this.firstT || k.key < this.firstT.key) this.firstT = e;
      if (!this.lastT || k.key > this.lastT.key) this.lastT = e;
    }
  }

  /**
   * Counting: a full incident counts 1; `incident_suppressed` lines carry a running counter
   * (written at 1, 101, 201, … within one throttle window) so a run counts its maximum, closed
   * by the next full incident of that kind (whose `suppressed_since_last` is exact when present).
   * The same incident seen twice (jsonl line + its incident_*.json: same kind, src, ts, detail) counts once.
   */
  private incident(ev: DiagEvent): void {
    const data = ev.data!;
    const kind = ev.kind ?? '(unknown)';
    const s0 = ev.src[0];
    const srcKey = s0 ? `${s0.file}:${s0.line ?? ''}` : '';
    if (ev.type === 'incident') {
      const run = this.suppressedRuns.get(kind) ?? 0;
      this.suppressedRuns.delete(kind);
      const ssl = num(data.suppressed_since_last) ?? 0;
      const gkey = `${kind}|${srcKey}|${ev.ts ?? ''}|${ev.detail ?? ''}`;
      const dup = ev.ts ? this.globalIncidents.get(gkey) : undefined;
      if (dup) {
        // the first copy already counted its suppressed_since_last; otherwise this run is new
        if (run > 0 && num(dup.data?.suppressed_since_last) == null) this.bumpKind(kind, run);
        // merge the two copies: the jsonl index line names the file/panel, the incident file
        // carries session/current_frame/recent_frames/stack
        dup.data = { ...(dup.data ?? {}), ...data };
        for (const r of ev.src) if (!dup.src.some((x) => sameRef(x, r))) dup.src.push(r);
        return;
      }
      this.globalIncidents.set(gkey, ev);
      this.bumpKind(kind, 1 + (ssl > 0 ? ssl : run));
    } else {
      const n = Math.max(1, num(data.suppressed) ?? 1);
      const prev = this.suppressedRuns.get(kind) ?? 0;
      if (prev > 0 && n <= prev) this.bumpKind(kind, prev); // counter restarted → a new run
      this.suppressedRuns.set(kind, n);
    }
    const lkey = `${kind}|${srcKey}|${ev.detail ?? ''}`;
    const seen = this.localIncidents.get(lkey);
    if (seen) {
      if (seen.type === 'incident_suppressed' && ev.type === 'incident') {
        const i = this.incidents.indexOf(seen);
        if (i >= 0) this.incidents[i] = ev;
        const j = this.errors.indexOf(seen);
        if (j >= 0) this.errors[j] = ev;
        this.localIncidents.set(lkey, ev);
      }
      return;
    }
    this.localIncidents.set(lkey, ev);
    if (this.incidents.length < MAX_LIST) this.incidents.push(ev);
    else this.dropped.incidents++;
    this.pushError(ev);
  }
}

// ---------------------------------------------------------------- per-input parsing

function parseLines(c: Collector, name: string, lines: string[]): void {
  let pending: Pending | null = null;
  let prevText = '';
  let prevLineNo = 0;

  const flush = (): void => {
    if (!pending) return;
    const { ev, rawLines } = pending;
    ev.raw = clip(rawLines.join('\n'), MAX_RAW);
    if (ev.kind === 'EXCEPTION' || ev.codes.length === 0) {
      const extra = extractCodes(rawLines.slice(1).join('\n').slice(0, SCAN_CHARS));
      for (const x of extra) if (!ev.codes.includes(x)) ev.codes.push(x);
    }
    c.emit(ev);
    pending = null;
  };
  const addFrames = (p: Pending, line: string, front: boolean): void => {
    for (const r of extractSrc(line.slice(0, SCAN_CHARS))) {
      if (p.ev.src.length >= MAX_FRAMES) break;
      if (front) p.ev.src.unshift(r);
      else p.ev.src.push(r);
    }
    if (p.rawLines.length < 60) p.rawLines.push(line);
  };
  const logEvent = (line: string, lineNo: number, level: string): DiagEvent => {
    const scan = line.length > SCAN_CHARS ? line.slice(0, SCAN_CHARS) : line;
    return {
      type: 'log',
      ts: findTs(scan),
      kind: level,
      detail: clip(line.trim(), MAX_DETAIL),
      src: extractSrc(scan),
      codes: extractCodes(scan),
      input: name,
      line: lineNo,
      raw: clip(line, MAX_RAW),
      data: null,
    };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;

    // ---- JSON line (jsonl) or a pretty-printed JSON object inside a paste
    const lead = line.trimStart();
    if (lead[0] === '{') {
      let obj: unknown = undefined;
      let end = i;
      try {
        obj = JSON.parse(line);
      } catch {
        const e = jsonBlockEnd(lines, i);
        if (e > i) {
          try {
            obj = JSON.parse(lines.slice(i, e + 1).join('\n'));
            end = e;
          } catch {
            /* falls through to the warning */
          }
        }
      }
      if (isObj(obj)) {
        flush();
        c.emit(jsonEvent(obj, name, lineNo, lines.slice(i, end + 1).join('\n')));
        i = end;
        prevText = '';
        continue;
      }
      if (lead.trimEnd().endsWith('}')) c.warn(`${name}:${lineNo} JSON 解析失敗，當一般文字處理`);
    }

    // ---- continuation of a stack trace
    if (pending) {
      const p: Pending = pending;
      if (p.mode === 'py') {
        if (/^\s+File "/.test(line)) {
          addFrames(p, line, true); // innermost frame first
          continue;
        }
        if (!line.trim() || /^\s/.test(line)) {
          if (line.trim() && p.rawLines.length < 60) p.rawLines.push(line);
          continue;
        }
        if (RE_PY_CONT.test(line)) {
          if (p.rawLines.length < 60) p.rawLines.push(line);
          continue;
        }
        if (!RE_NEW_LOG_LINE.test(line)) {
          // the exception line closes the traceback
          p.ev.detail = clip(line.trim(), MAX_DETAIL);
          if (!p.ev.ts) p.ev.ts = findTs(line.slice(0, SCAN_CHARS));
          for (const x of extractCodes(line.slice(0, SCAN_CHARS))) if (!p.ev.codes.includes(x)) p.ev.codes.push(x);
          p.rawLines.push(line);
          flush();
          prevText = line;
          prevLineNo = lineNo;
          continue;
        }
        flush(); // a truncated traceback: this line is the next log line, not the exception
      } else if (RE_FRAME_STACK.test(line)) {
        addFrames(p, line, false);
        if (/^\s*(?:Caused by:|---> )/.test(line) && !exceptionName(p.ev.detail)) {
          p.ev.detail = clip(`${p.ev.detail ?? ''} | ${line.trim()}`, MAX_DETAIL);
        }
        continue;
      } else flush();
    }

    // ---- a stack frame whose header had no level keyword
    if (RE_FRAME_ORPHAN.test(line)) {
      const header = prevText.trim() ? prevText : line;
      const ev = logEvent(header, prevText.trim() ? prevLineNo : lineNo, 'EXCEPTION');
      pending = { ev, mode: 'stack', rawLines: header === line ? [] : [header] };
      addFrames(pending, line, false);
      continue;
    }

    if (!line.trim()) continue;
    const scan = line.length > SCAN_CHARS ? line.slice(0, SCAN_CHARS) : line;
    if (!RE_KEY.test(scan)) {
      prevText = line;
      prevLineNo = lineNo;
      continue;
    }
    const level = levelOf(scan);
    if (!level) {
      prevText = line;
      prevLineNo = lineNo;
      continue;
    }
    const ev = logEvent(line, lineNo, level);
    pending = { ev, mode: RE_PY_HEADER.test(scan) ? 'py' : 'stack', rawLines: [line] };
    prevText = line;
    prevLineNo = lineNo;
  }
  flush();
}

function parseOne(c: Collector, input: DiagInput): void {
  const name = String(input.name ?? 'pasted') || 'pasted';
  const text = normalize(typeof input.text === 'string' ? input.text : '');
  if (!text.trim()) {
    c.warn(`${name}：內容是空的`);
    return;
  }
  const trimmed = text.trim();

  // ---- the whole input is one JSON document (incident_*.json, or an array of events)
  if (trimmed[0] === '{' || trimmed[0] === '[') {
    let doc: unknown;
    try {
      doc = JSON.parse(trimmed);
    } catch {
      doc = undefined;
    }
    if (isObj(doc)) {
      c.emit(jsonEvent(doc, name, 1, trimmed));
      return;
    }
    if (Array.isArray(doc)) {
      doc.forEach((o, i) => {
        if (isObj(o)) c.emit(jsonEvent(o, name, i + 1, JSON.stringify(o)));
      });
      return;
    }
  }

  const lines = text.split('\n');
  if (looksIni(lines, name)) {
    c.addIni(parseIni(name, text));
    return;
  }
  parseLines(c, name, lines);
}

// ---------------------------------------------------------------- public API

export function parseDiag(inputs: DiagInput[]): ParsedDiag {
  const c = new Collector();
  let budget = MAX_TOTAL_CHARS;
  const list = Array.isArray(inputs) ? inputs : [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    let input = raw;
    const len = typeof raw.text === 'string' ? raw.text.length : 0;
    if (budget <= 0) {
      c.warn(`${raw.name}：超過總量上限（${MAX_TOTAL_CHARS} 字元），略過`);
      continue;
    }
    if (len > budget) {
      c.warn(`${raw.name}：超過總量上限，只讀前 ${budget} 字元`);
      input = { name: raw.name, text: raw.text.slice(0, budget) };
    }
    budget -= Math.min(len, budget);
    c.beginInput();
    try {
      parseOne(c, input);
    } catch (e) {
      c.warn(`${raw.name}：解析中斷（${e instanceof Error ? e.message : String(e)}）`);
    }
    c.endInput();
  }
  if (c.dropped.events) c.warn(`事件超過 ${MAX_EVENTS} 筆，另有 ${c.dropped.events} 筆未列出（統計仍含）`);
  if (c.dropped.errors) c.warn(`錯誤超過 ${MAX_LIST} 筆，另有 ${c.dropped.errors} 筆未列出（統計仍含）`);
  if (c.dropped.incidents) c.warn(`事故超過 ${MAX_LIST} 筆，另有 ${c.dropped.incidents} 筆未列出（統計仍含）`);
  if (c.dropped.warnings) c.warnings.push(`另有 ${c.dropped.warnings} 則警告未列出`);

  const parsed: ParsedDiag = {
    events: c.events,
    sessions: c.sessions,
    incidents: c.incidents,
    ini: c.ini,
    errors: c.errors,
    summary: {
      inputs: list.length,
      first_ts: c.firstTs,
      last_ts: c.lastTs,
      incidents_by_kind: c.incidentsByKind,
      codes: c.codes,
      src_files: c.srcFiles,
      levels: c.levels,
    },
    signature: [],
    warnings: c.warnings,
  };
  parsed.signature = signatureOf(parsed);
  return parsed;
}

/**
 * Stable keys for matching past cases, most specific first when trimming to 30:
 * incident kinds (with source file), exception types, codes by frequency, primary source lines.
 */
export function signatureOf(p: ParsedDiag): string[] {
  const picked: string[] = [];
  const add = (k: string): void => {
    if (!picked.includes(k)) picked.push(k);
  };
  for (const inc of p.incidents) {
    const kind = inc.kind ?? '(unknown)';
    const s = inc.src[0];
    add(s ? `incident:${kind}@${s.file}` : `incident:${kind}`);
  }
  for (const e of p.errors) {
    if (e.type !== 'log' || e.kind !== 'EXCEPTION') continue;
    const n = exceptionName(e.detail);
    if (n) add(`exc:${n}`);
  }
  const codes = Object.entries(p.summary.codes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [code] of codes) add(`code:${code}`);
  const srcCount = new Map<string, number>();
  for (const e of [...p.incidents, ...p.errors]) {
    const s = e.src[0];
    if (!s) continue;
    const k = `src:${s.file}${s.line != null ? `:${s.line}` : ''}`;
    srcCount.set(k, (srcCount.get(k) ?? 0) + 1);
  }
  for (const [k] of [...srcCount].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) add(k);
  return picked.slice(0, MAX_SIGNATURE).sort();
}

function refText(r: SrcRef | undefined): string {
  if (!r) return '';
  return `${r.file}${r.line != null ? `:${r.line}` : ''}${r.func ? ` (${r.func})` : ''}`;
}

/** Compact Chinese plain-text digest for a model prompt (≤ max chars). */
export function diagSummaryText(p: ParsedDiag, max = 4000): string {
  const build = (nErr: number, dLen: number, nRecipe: number): string => {
    const out: string[] = [];
    const s = p.summary;
    const names = [...new Set([...p.events.map((e) => e.input), ...p.ini.map((f) => f.name)])];
    const levelTotal = Object.values(s.levels).reduce((a, b) => a + b, 0);
    out.push(
      `機況摘要：${s.inputs} 個輸入${names.length ? `（${clip(names.join('、'), 300)}）` : ''}` +
        (s.first_ts ? `；時間 ${s.first_ts}${s.last_ts && s.last_ts !== s.first_ts ? ` ～ ${s.last_ts}` : ''}` : '') +
        `；事件 ${p.events.length} 筆、日誌異常行 ${levelTotal} 筆`,
    );

    if (p.sessions.length) {
      out.push('機台（session）：');
      for (const ses of p.sessions.slice(0, 4)) {
        const g = ses.gpu;
        const bits = [
          `IP ${ses.ip_name ?? '?'}`,
          `模式 ${ses.mode ?? '?'}`,
          `ini ${ses.ini ?? '?'}`,
          `recipe ${ses.recipe ?? '?'}`,
        ];
        if (g) {
          const mem =
            g.free_mb != null || g.total_mb != null ? `，可用 ${g.free_mb ?? '?'}/${g.total_mb ?? '?'} MB` : '';
          bits.push(`GPU ${g.name ?? '?'}（SM ${g.sm ?? '?'}${mem}）`);
        }
        if (ses.ai_active != null) bits.push(`AI ${ses.ai_active ? '開' : '關'}`);
        if (ses.ts) bits.push(`開始 ${ses.ts}`);
        out.push(`- ${bits.join('｜')}`);
      }
      if (p.sessions.length > 4) out.push(`- …另 ${p.sessions.length - 4} 個 session`);
    }

    const recipes = p.events.filter((e) => e.type === 'recipe');
    if (recipes.length && nRecipe > 0) {
      out.push(`Recipe（${recipes.length} 次載入）：`);
      for (const r of recipes.slice(-nRecipe)) out.push(`- ${r.ts ?? ''} ${clip(r.detail ?? '', dLen)}`.trimEnd());
    }

    const kinds = Object.entries(s.incidents_by_kind).sort((a, b) => b[1] - a[1]);
    if (kinds.length) {
      out.push('事故（incident，含節流抑制的次數）：');
      for (const [kind, n] of kinds.slice(0, 10)) {
        const first = p.incidents.find((e) => (e.kind ?? '(unknown)') === kind);
        const where = first?.src[0] ? ` @ ${refText(first.src[0])}` : '';
        const when = first?.ts ? `（首次 ${first.ts}）` : '';
        out.push(`- ${kind} ×${n}${where}${when}${first?.detail ? `：${clip(first.detail, dLen)}` : ''}`);
      }
    }

    const others = new Map<string, DiagEvent>();
    const otherCount: Record<string, number> = {};
    for (const e of p.events) {
      if (e.type !== 'other') continue;
      const k = e.kind ?? 'other';
      others.set(k, e);
      otherCount[k] = (otherCount[k] ?? 0) + 1;
    }
    if (others.size) {
      out.push('其他紀錄（最新一筆）：');
      for (const [k, e] of [...others].slice(0, 5)) {
        out.push(`- ${k} ×${otherCount[k]}${e.ts ? ` ${e.ts}` : ''}：${clip(e.detail ?? '', dLen)}`);
      }
    }

    const levels = Object.entries(s.levels).sort((a, b) => (LEVEL_RANK[a[0]] ?? 9) - (LEVEL_RANK[b[0]] ?? 9));
    if (levels.length) out.push(`日誌層級：${levels.map(([k, n]) => `${k} ${n}`).join('、')}`);

    const logErrors = p.errors.filter((e) => e.type === 'log');
    if (logErrors.length && nErr > 0) {
      const groups = new Map<string, { ev: DiagEvent; n: number }>();
      for (const e of logErrors) {
        const key = `${e.kind}|${(e.detail ?? '').replace(/\d+/g, '#')}`;
        const g = groups.get(key);
        if (g) g.n++;
        else groups.set(key, { ev: e, n: 1 });
      }
      const top = [...groups.values()].sort(
        (a, b) => (LEVEL_RANK[a.ev.kind ?? ''] ?? 9) - (LEVEL_RANK[b.ev.kind ?? ''] ?? 9) || b.n - a.n,
      );
      out.push('主要錯誤行：');
      for (const { ev, n } of top.slice(0, nErr)) {
        const where = ev.src[0] ? ` → ${refText(ev.src[0])}` : '';
        const loc = `${ev.input}${ev.line != null ? `:${ev.line}` : ''}`;
        let d = ev.detail ?? '';
        if (ev.ts && d.includes(ev.ts)) d = d.replace(ev.ts, '').replace(/^\s*\[\]\s*|^\s+/, '');
        out.push(
          `- ${ev.ts ? `[${ev.ts}] ` : ''}${d.slice(0, 16).toUpperCase().includes(ev.kind ?? '') ? '' : `${ev.kind} `}${clip(d, dLen)}${n > 1 ? ` ×${n}` : ''}${where}（${loc}）`,
        );
      }
      if (top.length > nErr) out.push(`- …另 ${top.length - nErr} 種錯誤行`);
    }

    const codes = Object.entries(s.codes).sort((a, b) => b[1] - a[1]);
    if (codes.length) out.push(`錯誤碼：${codes.slice(0, 15).map(([k, n]) => `${k} ×${n}`).join('、')}`);
    const files = Object.entries(s.src_files).sort((a, b) => b[1] - a[1]);
    if (files.length) out.push(`程式位置：${files.slice(0, 10).map(([k, n]) => `${k} ×${n}`).join('、')}`);

    if (p.ini.length) {
      const parts = p.ini.map((f) => {
        const secs = Object.keys(f.sections);
        const keys = secs.reduce((a, k) => a + Object.keys(f.sections[k]!).length, 0);
        return `${f.name}（${secs.length} 個區段、${keys} 個鍵）`;
      });
      out.push(`INI：${parts.join('、')}`);
    }
    if (p.signature.length) out.push(`特徵：${p.signature.join(' ')}`);
    if (p.warnings.length) out.push(`解析警告 ${p.warnings.length} 則：${clip(p.warnings.slice(0, 3).join('；'), 300)}`);
    return out.join('\n');
  };

  const cap = Math.max(1, Math.floor(max));
  for (const [nErr, dLen, nRecipe] of [
    [10, 240, 3],
    [8, 160, 3],
    [5, 120, 2],
    [3, 80, 1],
    [1, 60, 1],
    [0, 40, 0],
  ] as const) {
    const t = build(nErr, dLen, nRecipe);
    if (t.length <= cap) return t;
  }
  return clip(build(0, 40, 0), cap);
}
