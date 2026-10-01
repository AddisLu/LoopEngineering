/**
 * Small, forgiving parsers shared by the analyzers: CMake commands, MSBuild XML elements and
 * .sln project lines. They read what a person would read and never throw on odd input.
 */

export interface CMakeCmd {
  /** lower-cased command name */
  name: string;
  args: string[];
  /** 1-based line of the command name */
  line: number;
}

/** Blank out `#` comments (outside quotes) keeping every newline so offsets keep their line. */
function stripCMakeComments(text: string): string {
  let out = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' && text[i - 1] !== '\\') inQ = !inQ;
    if (c === '#' && !inQ) {
      while (i < text.length && text[i] !== '\n') {
        out += ' ';
        i++;
      }
      if (i < text.length) out += '\n';
      continue;
    }
    if (c === '\n') inQ = false;
    out += c;
  }
  return out;
}

function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|([^\s"]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1] : m[2]!);
  return out;
}

export function parseCMake(text: string): CMakeCmd[] {
  const src = stripCMakeComments(text);
  const out: CMakeCmd[] = [];
  const re = /^[ \t]*([A-Za-z_]\w*)[ \t]*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    let inQ = false;
    for (; i < src.length && depth > 0; i++) {
      const c = src[i];
      if (c === '"' && src[i - 1] !== '\\') inQ = !inQ;
      else if (!inQ && c === '(') depth++;
      else if (!inQ && c === ')') depth--;
    }
    const body = src.slice(re.lastIndex, i - 1);
    let line = 1;
    for (let k = 0; k < m.index + m[0].indexOf(m[1]!); k++) if (src.charCodeAt(k) === 10) line++;
    out.push({ name: m[1]!.toLowerCase(), args: tokenize(body), line });
    re.lastIndex = i;
  }
  return out;
}

export interface XmlEl {
  /** inner text (for leaf elements), trimmed */
  value: string;
  attrs: Record<string, string>;
  /** the element's own body (between open and close tags), '' when self-closing */
  body: string;
  index: number;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]!] = m[2]!;
  return out;
}

/** Every `<tag …>…</tag>` / `<tag … />` in an MSBuild-ish XML text. */
export function xmlEls(text: string, tag: string): XmlEl[] {
  const out: XmlEl[] = [];
  const re = new RegExp(`<${tag}\\b([^>]*?)(/?)>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const attrs = parseAttrs(m[1] ?? '');
    let body = '';
    if (m[2] !== '/') {
      const close = text.indexOf(`</${tag}>`, re.lastIndex);
      if (close >= 0) body = text.slice(re.lastIndex, close);
    }
    out.push({ value: body.includes('<') ? '' : body.trim(), attrs, body, index: m.index });
  }
  return out;
}

export interface SlnProject {
  name: string;
  /** '/'-separated, relative to the .sln */
  path: string;
  line: number;
}

export function parseSln(text: string): SlnProject[] {
  const out: SlnProject[] = [];
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    const m = /^Project\("\{[^}]+\}"\)\s*=\s*"([^"]+)",\s*"([^"]+)"/.exec(l.trim());
    if (m && /\.(vcxproj|csproj|vbproj|fsproj|vcproj)$/i.test(m[2]!)) out.push({ name: m[1]!, path: m[2]!.replace(/\\/g, '/'), line: i + 1 });
  });
  return out;
}

/** 1-based line of an offset in a text */
export function lineOfIndex(text: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** strip a CMake generator expression down to its value: `$<$<BOOL:x>:src/a.cpp>` → `src/a.cpp` */
export function genexValue(arg: string): string {
  let a = arg;
  while (a.startsWith('$<')) {
    const colon = a.lastIndexOf(':');
    if (colon < 0) return '';
    a = a.slice(colon + 1).replace(/>+$/, '');
  }
  return a;
}
