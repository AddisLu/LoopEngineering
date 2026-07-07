import { describe, it, expect } from 'vitest';
import { chunkMarkdown, chunkCode, chunkDocument } from '../knowledge/ingest/chunk.js';

describe('chunkMarkdown', () => {
  it('splits by heading, keeping the title as `section` with correct 1-indexed start/end_line', () => {
    const text = ['# Title', 'intro line', '', '## Section A', 'a1', 'a2', '## Section B', 'b1'].join('\n');
    const pieces = chunkMarkdown(text);
    expect(pieces.map((p) => p.section)).toEqual(['Title', 'Section A', 'Section B']);
    expect(pieces[0]).toMatchObject({ start_line: 1, end_line: 3 });
    expect(pieces[1]).toMatchObject({ start_line: 4, end_line: 6 });
    expect(pieces[2]).toMatchObject({ start_line: 7, end_line: 8 });
    expect(pieces[0]!.text).toBe('# Title\nintro line\n');
    expect(pieces.map((p) => p.ord)).toEqual([0, 1, 2]);
  });

  it('content before the first heading becomes a section: null chunk', () => {
    const text = ['intro no heading', '', '# First', 'body'].join('\n');
    const pieces = chunkMarkdown(text);
    expect(pieces[0]).toMatchObject({ section: null, start_line: 1, end_line: 2 });
    expect(pieces[1]).toMatchObject({ section: 'First', start_line: 3, end_line: 4 });
  });

  it('a headless document becomes one section: null chunk covering the whole text', () => {
    const text = 'just plain\ntext\nno headings';
    const pieces = chunkMarkdown(text);
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toMatchObject({ section: null, start_line: 1, end_line: 3 });
  });

  it('a section far exceeding the size cap is subdivided by line window, keeping its title', () => {
    const bigSection = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    const text = `# Big\n${bigSection}`;
    const pieces = chunkMarkdown(text);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((p) => p.section === 'Big')).toBe(true);
    // consecutive pieces overlap: next start_line <= previous end_line
    for (let i = 1; i < pieces.length; i++) {
      expect(pieces[i]!.start_line).toBeLessThanOrEqual(pieces[i - 1]!.end_line);
    }
    // ordinals are sequential
    expect(pieces.map((p) => p.ord)).toEqual(pieces.map((_, i) => i));
  });

  it('empty/whitespace-only text yields no chunks', () => {
    expect(chunkMarkdown('')).toEqual([]);
    expect(chunkMarkdown('   \n  \n')).toEqual([]);
  });
});

describe('chunkCode', () => {
  it('splits into overlapping line windows with correct start/end_line', () => {
    const lines = Array.from({ length: 130 }, (_, i) => `line ${i}`);
    const pieces = chunkCode(lines.join('\n'));
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces[0]).toMatchObject({ start_line: 1, section: null });
    // every start/end_line is within the document, in increasing order, with overlap
    for (let i = 1; i < pieces.length; i++) {
      expect(pieces[i]!.start_line).toBeGreaterThan(pieces[i - 1]!.start_line);
      expect(pieces[i]!.start_line).toBeLessThanOrEqual(pieces[i - 1]!.end_line);
    }
    expect(pieces.at(-1)!.end_line).toBe(130);
  });

  it('a short file fits in a single chunk', () => {
    const pieces = chunkCode('line1\nline2\nline3');
    expect(pieces).toEqual([{ ord: 0, text: 'line1\nline2\nline3', section: null, start_line: 1, end_line: 3 }]);
  });

  it('empty text yields no chunks', () => {
    expect(chunkCode('')).toEqual([]);
    expect(chunkCode('   ')).toEqual([]);
  });
});

describe('chunkDocument dispatch', () => {
  it('routes md/markdown/mdx to the heading chunker, everything else to line-window', () => {
    const md = '# H\nbody';
    expect(chunkDocument(md, 'md')).toEqual(chunkMarkdown(md));
    expect(chunkDocument(md, 'markdown')).toEqual(chunkMarkdown(md));
    expect(chunkDocument(md, 'mdx')).toEqual(chunkMarkdown(md));

    const code = 'const x = 1;';
    expect(chunkDocument(code, 'ts')).toEqual(chunkCode(code));
    expect(chunkDocument(code, '')).toEqual(chunkCode(code));
  });
});
