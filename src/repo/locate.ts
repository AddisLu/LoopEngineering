import { execFileSync } from 'node:child_process';
import type { GitExec, RepoSymbol } from './map.js';

/**
 * 問題定位: from what a person wrote (and what a screenshot said), find the files most likely
 * involved. Pure text work over `git grep`: error strings, identifiers, paths and UI labels become
 * clues, each clue votes for the files it appears in, and the top files come back with evidence
 * lines and their recent commits. No model; the 分析 step hands the result to one.
 */

export interface Clues {
  errors: string[];
  identifiers: string[];
  paths: string[];
  labels: string[];
}

export interface Evidence {
  line: number;
  text: string;
  clue: string;
}

export interface Candidate {
  file: string;
  score: number;
  clues: string[];
  evidence: Evidence[];
  recent: string[];
}

const STOP = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'when', 'then', 'after', 'before', 'should', 'would', 'could', 'error', 'errors',
  'failed', 'failure', 'exception', 'expected', 'actual', 'result', 'value', 'values', 'issue', 'problem', 'second', 'first',
  'function', 'return', 'string', 'number', 'object', 'undefined', 'null', 'true', 'false', 'loop', 'gitea', 'issue',
]);
const UI_NOUNS = '(?:按鈕|視窗|頁面|畫面|欄位|訊息|選單|分頁|對話框|標籤|模式)';

function uniq(list: string[]): string[] {
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))];
}

/** Clues from free text: the more specific a token, the more it is worth. */
export function extractClues(text: string): Clues {
  const errors: string[] = [];
  const identifiers: string[] = [];
  const paths: string[] = [];
  const labels: string[] = [];
  const cleaned = text.replace(/\r/g, '');

  for (const raw of cleaned.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/\b(?:error|exception|traceback|fatal|assert(?:ion)?|failed|panic)\b|錯誤|例外|失敗|當機|閃退/i.test(line) && line.length <= 200) {
      // the message itself, not the prose around it: keep from the keyword on
      const m = /(?:[A-Z]\w*(?:Error|Exception)\b[^\n]*|\berror\b[^\n]*|\bfatal\b[^\n]*|錯誤[^\n]*|失敗[^\n]*)/i.exec(line);
      const msg = (m ? m[0] : line).replace(/^[\s:：-]+/, '').slice(0, 120);
      if (msg.length >= 6) errors.push(msg);
    }
  }
  // quoted fragments: "…", '…', `…`, 「…」, 『…』, “…”
  for (const m of cleaned.matchAll(/["'`“「『]([^"'`”」』\n]{3,80})["'`”」』]/g)) {
    const q = m[1]!.trim();
    if (/[一-鿿]/.test(q)) labels.push(q);
    else if (/[A-Za-z]/.test(q)) errors.push(q);
  }
  // paths and file names
  for (const m of cleaned.matchAll(/(?:[\w.-]+\/)*[\w.-]+\.(?:cpp|cc|cxx|hpp|hh|h|cu|cuh|cs|py|ts|tsx|js|mjs|go|rs|java|json|ya?ml|xml|ini|toml|cmake|txt)\b/g)) {
    const p = m[0];
    if (!/^\d/.test(p) && p.length >= 4) paths.push(p);
  }
  // identifiers: snake_case, CamelCase, SCREAMING_CASE, Class::method, obj.method
  for (const m of cleaned.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*)*/g)) {
    const tok = m[0];
    const qualified = tok.includes('::'); // Class::method is code even when both halves are plain words
    for (const part of tok.split('::')) {
      if (STOP.has(part.toLowerCase())) continue;
      if (qualified && part.length >= 3) {
        identifiers.push(part);
        continue;
      }
      if (part.length < 5) continue;
      const snake = part.includes('_');
      const camel = /[a-z][A-Z]/.test(part);
      const scream = /^[A-Z][A-Z0-9_]{4,}$/.test(part);
      if (snake || camel || scream) identifiers.push(part);
    }
  }
  // Chinese UI labels next to a UI noun: 「重新載入」按鈕 → 重新載入
  for (const m of cleaned.matchAll(new RegExp(`([\\u4e00-\\u9fff]{2,10})${UI_NOUNS}`, 'g'))) labels.push(m[1]!);

  return {
    errors: uniq(errors).slice(0, 12),
    identifiers: uniq(identifiers).slice(0, 24),
    paths: uniq(paths).slice(0, 12),
    labels: uniq(labels).slice(0, 12),
  };
}

const WEIGHT = { path: 4, error: 3, identifier: 2, label: 1.5 } as const;
const SKIP_PATHSPEC = [':!node_modules', ':!build', ':!dist', ':!vendor', ':!third_party', ':!*.min.js', ':!*.lock', ':!package-lock.json'];

function defaultGit(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    // git grep exits 1 for "no match" — that is an empty result, not a failure
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1) return e.stdout ?? '';
    throw err;
  }
}

export interface LocateOptions {
  git?: GitExec;
  /** how many files to return (default 8) */
  top?: number;
  /** the repo map's symbols: a clue that names a symbol pulls its file up */
  symbols?: RepoSymbol[];
  /** the revision to search (default: the working tree) */
  rev?: string;
}

/** Files most likely involved, best first. */
export function locateIssue(repoPath: string, clues: Clues, opts: LocateOptions = {}): Candidate[] {
  const git = opts.git ?? defaultGit;
  const top = opts.top ?? 8;
  const hits = new Map<string, { score: number; clues: Set<string>; evidence: Evidence[] }>();
  const bump = (file: string, clue: string, weight: number, ev: Evidence | null): void => {
    const h = hits.get(file) ?? { score: 0, clues: new Set<string>(), evidence: [] };
    if (!h.clues.has(clue)) {
      h.clues.add(clue);
      h.score += weight;
    } else {
      h.score += weight * 0.15; // repeats in the same file count a little
    }
    if (ev && h.evidence.length < 3 && !h.evidence.some((e) => e.line === ev.line)) h.evidence.push(ev);
    hits.set(file, h);
  };

  let tracked: string[] | null = null;
  const files = (): string[] => {
    if (tracked) return tracked;
    try {
      tracked = git(['ls-files'], repoPath).split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      tracked = [];
    }
    return tracked;
  };

  // a path clue that names a real file is the strongest signal there is
  for (const p of clues.paths) {
    const base = p.split('/').pop()!;
    for (const f of files()) {
      if (f === p || f.endsWith('/' + p) || (f.endsWith('/' + base) || f === base)) bump(f, p, WEIGHT.path * (f.endsWith(p) ? 1 : 0.6), null);
    }
  }
  // symbol names from the map
  if (opts.symbols?.length) {
    const byName = new Map<string, RepoSymbol[]>();
    for (const s of opts.symbols) byName.set(s.name, [...(byName.get(s.name) ?? []), s]);
    for (const id of clues.identifiers) {
      for (const s of byName.get(id) ?? []) bump(s.file, id, WEIGHT.identifier * 1.5, { line: s.line, text: `${s.kind === 'class' ? 'class' : 'function'} ${s.name}`, clue: id });
    }
  }
  const grep = (clue: string, weight: number): void => {
    let out = '';
    try {
      const args = ['grep', '-n', '-I', '-F', '--max-depth=-1', '-e', clue];
      if (opts.rev) args.push(opts.rev);
      args.push('--', '.', ...SKIP_PATHSPEC);
      out = git(args, repoPath);
    } catch {
      return;
    }
    let n = 0;
    for (const line of out.split('\n')) {
      if (!line) continue;
      // [rev:]file:line:text
      const m = /^(?:[^:]+:)?(.+?):(\d+):(.*)$/.exec(opts.rev ? line.replace(/^[^:]+:/, '') : line);
      if (!m) continue;
      bump(m[1]!, clue, weight, { line: Number(m[2]), text: m[3]!.trim().slice(0, 160), clue });
      if (++n > 400) break; // a clue that matches everything is not a clue
    }
  };
  for (const e of clues.errors) grep(e, WEIGHT.error);
  for (const id of clues.identifiers) grep(id, WEIGHT.identifier);
  for (const l of clues.labels) grep(l, WEIGHT.label);

  const ranked = [...hits.entries()]
    .filter(([file]) => !/\.(png|jpe?g|gif|bmp|svg|pdf|bin|dat)$/i.test(file))
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
    .slice(0, top);
  return ranked.map(([file, h]) => {
    let recent: string[] = [];
    try {
      recent = git(['log', '-3', '--format=%h %s (%cr)', '--', file], repoPath).split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      recent = [];
    }
    return { file, score: Math.round(h.score * 100) / 100, clues: [...h.clues], evidence: h.evidence.sort((a, b) => a.line - b.line), recent };
  });
}
