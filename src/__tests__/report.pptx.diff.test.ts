import { describe, it, expect } from 'vitest';
import { normalizeStatusText, editDistance, classifyStatusItems } from '../report/pptx/diff.js';

describe('diff.ts: normalizeStatusText', () => {
  it('collapses full-width/half-width forms via NFKC', () => {
    expect(normalizeStatusText('Ａ案已導入')).toBe(normalizeStatusText('A案已導入'));
  });

  it('strips all whitespace, including internal', () => {
    expect(normalizeStatusText('Ａ案 已導入')).toBe(normalizeStatusText('A案已導入'));
    expect(normalizeStatusText(' a  b\tc\n')).toBe('abc');
  });

  it('trims leading/trailing punctuation but keeps internal punctuation', () => {
    expect(normalizeStatusText('「進度正常」')).toBe(normalizeStatusText('進度正常'));
    expect(normalizeStatusText('...done.')).toBe('done');
  });

  it('lowercases ASCII', () => {
    expect(normalizeStatusText('ABC')).toBe('abc');
  });
});

describe('diff.ts: editDistance', () => {
  it('is 0 for identical strings', () => {
    expect(editDistance('abc', 'abc')).toBe(0);
  });

  it('equals the other length when one side is empty', () => {
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('abc', '')).toBe(3);
  });

  it('counts substitutions', () => {
    expect(editDistance('abcdefghijklmnopqrst', 'xyzdefghijklmnopqrst')).toBe(3);
    expect(editDistance('abcdefghijklmnopqrst', 'wxyzefghijklmnopqrst')).toBe(4);
  });

  it('handles insertions/deletions (classic kitten/sitting case)', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });
});

describe('diff.ts: classifyStatusItems — acceptance scenarios', () => {
  const PREV = ['A案已導入', 'B案評估中'];

  it('exact carried-over text -> black, brand-new text -> blue', () => {
    const result = classifyStatusItems(PREV, [{ text: 'A案已導入' }, { text: 'C案啟動' }]);
    expect(result).toEqual([
      { text: 'A案已導入', color: 'black' },
      { text: 'C案啟動', color: 'blue' },
    ]);
  });

  it('full-width + internal space variant of a carried-over item still normalizes to black', () => {
    const result = classifyStatusItems(PREV, [{ text: 'Ａ案 已導入' }]);
    expect(result).toEqual([{ text: 'Ａ案 已導入', color: 'black' }]);
  });

  it('highlight:true always wins -> red, regardless of similarity to prevTexts', () => {
    const result = classifyStatusItems(PREV, [{ text: 'A案已導入補償演算法', highlight: true }]);
    expect(result).toEqual([{ text: 'A案已導入補償演算法', color: 'red' }]);
  });

  it('first week (no prevTexts) -> everything blue except explicit highlights', () => {
    const result = classifyStatusItems([], [{ text: 'A案已導入' }, { text: 'B案評估中', highlight: true }]);
    expect(result).toEqual([
      { text: 'A案已導入', color: 'blue' },
      { text: 'B案評估中', color: 'red' },
    ]);
  });
});

describe('diff.ts: classifyStatusItems — fuzzy 0.85 boundary', () => {
  const BASE = 'abcdefghijklmnopqrst'; // 20 chars

  it('fuzzySim exactly 0.85 (3/20 edits) -> black (carried, wording tweaked)', () => {
    const variant = 'xyzdefghijklmnopqrst'; // 3 substitutions vs BASE
    expect(editDistance(BASE, variant)).toBe(3);
    const result = classifyStatusItems([BASE], [{ text: variant }]);
    expect(result[0]?.color).toBe('black');
  });

  it('fuzzySim just below 0.85 (4/20 edits) -> blue (new)', () => {
    const variant = 'wxyzefghijklmnopqrst'; // 4 substitutions vs BASE
    expect(editDistance(BASE, variant)).toBe(4);
    const result = classifyStatusItems([BASE], [{ text: variant }]);
    expect(result[0]?.color).toBe('blue');
  });
});

describe('diff.ts: classifyStatusItems — order + clamp', () => {
  it('preserves input order and clamps to <=2 items', () => {
    const result = classifyStatusItems([], [{ text: 'A' }, { text: 'B' }, { text: 'C' }]);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.text)).toEqual(['A', 'B']);
  });
});
