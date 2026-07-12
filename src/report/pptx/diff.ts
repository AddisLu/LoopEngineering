/**
 * Deterministic week-over-week status-item coloring. Zero I/O, pure functions — the
 * core insight behind the company template's black/blue/red rule: black = carried over
 * from last week, blue = new this week, decided by diffing against last week's
 * *persisted* deck-spec (never an LLM's memory); red = human/agent-marked highlight,
 * the only path that bypasses the diff entirely. See assemble.ts's assembleDeckSpec and
 * weekly.ts's renderWeekly for the two call sites (draft-time coloring, then
 * re-coloring after human edits at render time).
 */
import type { StatusItem } from './spec.js';

export interface StatusCandidate {
  text: string;
  highlight?: boolean;
}

const FUZZY_THRESHOLD = 0.85;
const MAX_STATUS_ITEMS = 2;

/** NFKC-normalize (full/half-width forms collapse together) → strip all whitespace →
 * trim leading/trailing punctuation/symbols → lowercase ASCII, so "Ａ案　已導入" and
 * "A案已導入" compare equal. */
export function normalizeStatusText(s: string): string {
  const collapsed = s.normalize('NFKC').replace(/\s+/g, '');
  const trimmed = collapsed.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
  return trimmed.toLowerCase();
}

/** Plain Levenshtein edit distance, local ~20-line copy rather than an import of
 * opdata.ts's private same-named helper — duplicating this keeps the pptx module from
 * coupling to opdata's internals for what is otherwise a generic string-distance utility. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur.push(Math.min((prev[j] ?? Infinity) + 1, (cur[j - 1] ?? Infinity) + 1, (prev[j - 1] ?? Infinity) + cost));
    }
    prev = cur;
  }
  return prev[b.length] ?? Math.max(a.length, b.length);
}

function fuzzySim(na: string, nb: string): number {
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - editDistance(na, nb) / maxLen;
}

/**
 * Classify each candidate against last week's persisted status texts, in order:
 * 1. `highlight === true` → 'red' (the only path that produces red).
 * 2. Normalized exact match against any prevText → 'black' (carried over verbatim).
 * 3. `fuzzySim >= 0.85` against any prevText → 'black' (same item, wording tweaked).
 * 4. Otherwise → 'blue' (new this week).
 * Preserves input order and clamps to <=2 items (the template only reserves room for
 * that many status lines per project). An empty prevTexts (first week) makes everything
 * blue except explicit highlights.
 */
export function classifyStatusItems(prevTexts: string[], candidates: StatusCandidate[]): StatusItem[] {
  const normPrev = prevTexts.map(normalizeStatusText);
  return candidates.slice(0, MAX_STATUS_ITEMS).map((c): StatusItem => {
    if (c.highlight === true) return { text: c.text, color: 'red' };
    const norm = normalizeStatusText(c.text);
    const carried = normPrev.some((p) => norm === p || fuzzySim(norm, p) >= FUZZY_THRESHOLD);
    return { text: c.text, color: carried ? 'black' : 'blue' };
  });
}
