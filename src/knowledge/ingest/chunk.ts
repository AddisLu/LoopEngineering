export interface ChunkPiece {
  ord: number;
  text: string;
  section: string | null;
  /** 1-indexed, inclusive line range in the ORIGINAL (pre-chunk) document text. */
  start_line: number;
  end_line: number;
}

// Any single heading-delimited markdown section, or a code file overall, larger than
// this many lines is further subdivided by line window so one chunk never balloons.
const MAX_SECTION_LINES = 120;
const WINDOW_LINES = 60;
const OVERLAP_LINES = 10;

/** Splits `lines` into overlapping windows, offsetting start/end_line by `lineOffset`
 * (the 0-indexed position of `lines[0]` within the original document). */
function windowLines(lines: string[], lineOffset: number, section: string | null, ordStart: number): ChunkPiece[] {
  const out: ChunkPiece[] = [];
  let i = 0;
  let ord = ordStart;
  while (i < lines.length) {
    const end = Math.min(i + WINDOW_LINES, lines.length);
    out.push({
      ord: ord++,
      text: lines.slice(i, end).join('\n'),
      section,
      start_line: lineOffset + i + 1,
      end_line: lineOffset + end,
    });
    if (end >= lines.length) break;
    i = end - OVERLAP_LINES;
  }
  return out;
}

/** Code chunker: fixed line windows with a small overlap (no AST/function parsing —
 * language-agnostic by design). */
export function chunkCode(text: string): ChunkPiece[] {
  if (!text.trim()) return [];
  return windowLines(text.split('\n'), 0, null, 0);
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** Markdown chunker: splits at each heading line (any level); a section larger than
 * MAX_SECTION_LINES is further subdivided by line window, keeping its heading as
 * `section` across the split pieces. Content before the first heading (or the whole
 * document, if it has none) becomes a section with `section: null`. */
export function chunkMarkdown(text: string): ChunkPiece[] {
  if (!text.trim()) return [];
  const lines = text.split('\n');

  const sections: { title: string | null; start: number; end: number }[] = [];
  let curTitle: string | null = null;
  let curStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i] ?? '');
    if (!m) continue;
    if (i > curStart) sections.push({ title: curTitle, start: curStart, end: i });
    curTitle = (m[2] ?? '').trim();
    curStart = i;
  }
  sections.push({ title: curTitle, start: curStart, end: lines.length });

  const out: ChunkPiece[] = [];
  let ord = 0;
  for (const s of sections) {
    const sectionLines = lines.slice(s.start, s.end);
    if (sectionLines.length <= MAX_SECTION_LINES) {
      out.push({
        ord: ord++,
        text: sectionLines.join('\n'),
        section: s.title,
        start_line: s.start + 1,
        end_line: s.end,
      });
    } else {
      const pieces = windowLines(sectionLines, s.start, s.title, ord);
      ord += pieces.length;
      out.push(...pieces);
    }
  }
  return out;
}

/** docKind 'md'/'markdown'/'mdx' -> heading-based chunking; anything else -> line-window.
 * `title` (the owning document's title) is optional and, when given, is prefixed onto
 * every piece's `text` — the field that both the embedder and chunks_fts index — so a
 * term that only ever appears in the title (never in the body) is still reachable
 * through vector and keyword search (see plan-RAG-title-recall.md). start_line/end_line
 * keep referring to the original document text; only the embeddable/indexed `text`
 * gains the prefix. */
export function chunkDocument(text: string, docKind: string, title?: string): ChunkPiece[] {
  const pieces =
    docKind === 'md' || docKind === 'markdown' || docKind === 'mdx' ? chunkMarkdown(text) : chunkCode(text);
  const trimmedTitle = title?.trim();
  if (!trimmedTitle) return pieces;
  return pieces.map((p) => ({ ...p, text: `${trimmedTitle}\n\n${p.text}` }));
}
