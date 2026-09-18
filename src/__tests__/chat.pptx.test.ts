import { describe, it, expect } from 'vitest';
import { answerToDeck, plainText, DECK_LIMITS } from '../chat/pptx.js';

describe('answerToDeck', () => {
  it('slices an answer into slides: headings, bullets, tables, code and figures', () => {
    const md = [
      '# TGV 檢測',
      '這是**重點**說明，含 `code` 與 [連結](https://x)。',
      '- 第一點',
      '- 第二點',
      '',
      '## 參數',
      '| 檔案 | 參數 | 目前 |',
      '| --- | --- | --- |',
      '| a.ini | thr | 120 |',
      '| b.ini | edge | 4 |',
      '',
      '## 驗證',
      '```bash',
      'npm test',
      '```',
      '```svg',
      '<svg viewBox="0 0 10 10"><circle r="4"/></svg>',
      '```',
    ].join('\n');
    const deck = answerToDeck(md, { title: '對話標題', subtitle: 'x', footer: 'y' });
    expect(deck.title).toBe('對話標題');
    expect(deck.slides.map((s) => s.kind)).toEqual(['bullets', 'table', 'code', 'image']);
    const [b, t, c, img] = deck.slides;
    expect(b!.title).toBe('TGV 檢測');
    // markdown decoration is stripped, the words survive
    expect(b!.bullets).toEqual(['這是重點說明，含 code 與 連結。', '第一點', '第二點']);
    expect(t!.table).toEqual({ header: ['檔案', '參數', '目前'], rows: [['a.ini', 'thr', '120'], ['b.ini', 'edge', '4']] });
    expect(c!.code).toBe('npm test');
    expect(c!.lang).toBe('bash');
    expect(img!.svg).toContain('<circle');
    expect(img!.title).toBe('驗證');
  });

  it('catches a bare <svg>, keeps a title for it, and never returns an empty deck', () => {
    const deck = answerToDeck('看圖：\n<svg viewBox="0 0 4 4"><rect/></svg>\n後續說明');
    expect(deck.slides.map((s) => s.kind)).toEqual(['bullets', 'image', 'bullets']);
    expect(answerToDeck('').slides).toHaveLength(1);
    expect(answerToDeck('   ').slides[0]!.bullets).toEqual([]);
  });

  it('bounds everything a runaway model can produce', () => {
    const many = Array.from({ length: 300 }, (_, i) => `- 第 ${i} 點 ${'長'.repeat(300)}`).join('\n');
    const deck = answerToDeck(`# 很多\n${many}`);
    expect(deck.slides.length).toBeLessThanOrEqual(DECK_LIMITS.slides);
    for (const s of deck.slides) {
      expect((s.bullets ?? []).length).toBeLessThanOrEqual(DECK_LIMITS.bulletsPerSlide);
      for (const b of s.bullets ?? []) expect(b.length).toBeLessThanOrEqual(DECK_LIMITS.bulletChars);
    }
    // a continued section says so instead of repeating the same title
    expect(deck.slides[1]!.title).toContain('（續）');
    const long = answerToDeck(`\`\`\`python\n${Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n')}\n\`\`\``);
    expect((long.slides[0]!.code ?? '').split('\n').length).toBeLessThanOrEqual(DECK_LIMITS.codeLines);
    expect(plainText('## **粗體** `碼`')).toBe('粗體 碼');
  });
});
