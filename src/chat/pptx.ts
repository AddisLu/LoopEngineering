import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getSetting } from '../db/index.js';
import { paths } from '../config.js';

/**
 * 一則回答 → 一份簡報.
 *
 * The weekly-report deck (src/report/pptx/*) fills a fixed company template and never invents
 * layout; that contract cannot carry an arbitrary answer. So this is a second, much smaller path:
 * the markdown an answer produced is sliced into slides here (pure, testable, no python), and
 * scripts/answer_pptx.py draws them with python-pptx's default 16:9 canvas.
 *
 * Everything is bounded — a model that emits 400 bullets must not produce a 400-slide file.
 */

export interface DeckSlide {
  kind: 'title' | 'bullets' | 'code' | 'image' | 'table';
  title?: string;
  bullets?: string[];
  code?: string;
  lang?: string;
  /** raw <svg> markup; the renderer rasterises it */
  svg?: string;
  table?: { header: string[]; rows: string[][] };
  note?: string;
}

export interface AnswerDeck {
  title: string;
  subtitle?: string;
  footer?: string;
  slides: DeckSlide[];
}

export const DECK_LIMITS = {
  slides: 40,
  bulletsPerSlide: 7,
  bulletChars: 160,
  codeLines: 22,
  codeChars: 2400,
  tableRows: 12,
  tableCols: 6,
  cellChars: 60,
};

const clamp = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Markdown emphasis/links/code ticks are noise on a slide; keep the words. */
export function plainText(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*]+)\*/g, '$1$2')
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const isTableRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isDivider = (l: string) => /^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/.test(l) && l.includes('-');

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => clamp(plainText(c), DECK_LIMITS.cellChars));
}

/** One answer's markdown → the slides that answer actually contains. Never throws. */
export function answerToDeck(markdown: string, opts: { title?: string; subtitle?: string; footer?: string } = {}): AnswerDeck {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const slides: DeckSlide[] = [];
  let heading = '';
  let bullets: string[] = [];
  let figures = 0;

  const flush = () => {
    while (bullets.length) {
      const take = bullets.splice(0, DECK_LIMITS.bulletsPerSlide);
      slides.push({ kind: 'bullets', title: slides.some((s) => s.title === heading && s.kind === 'bullets') ? `${heading}（續）` : heading || '重點', bullets: take });
    }
  };
  const push = (s: DeckSlide) => {
    flush();
    slides.push(s);
  };

  for (let i = 0; i < lines.length && slides.length < DECK_LIMITS.slides; i++) {
    const line = lines[i] ?? '';

    // fenced block: svg → picture, anything else → code
    const fence = /^\s*```([^\n`]*)\s*$/.exec(line);
    if (fence) {
      const lang = (fence[1] || '').trim().toLowerCase().split(/\s+/)[0] ?? '';
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && !/^\s*```/.test(lines[j] ?? ''); j++) body.push(lines[j] ?? '');
      i = j;
      const code = body.join('\n');
      const isSvg = lang === 'svg' || ((lang === '' || lang === 'xml') && /^\s*<svg[\s>]/i.test(code));
      if (isSvg) {
        figures += 1;
        push({ kind: 'image', title: heading || `圖 ${figures}`, svg: code });
      } else {
        const kept = code.split('\n').slice(0, DECK_LIMITS.codeLines).join('\n');
        push({ kind: 'code', title: heading || (lang ? `${lang} 程式碼` : '程式碼'), code: clamp(kept, DECK_LIMITS.codeChars), lang });
      }
      continue;
    }

    // a bare <svg> (no fence) is common enough to be worth catching
    if (/^\s*<svg[\s>]/i.test(line)) {
      const body: string[] = [];
      let j = i;
      for (; j < lines.length; j++) {
        body.push(lines[j] ?? '');
        if (/<\/svg>/i.test(lines[j] ?? '')) break;
      }
      i = j;
      figures += 1;
      push({ kind: 'image', title: heading || `圖 ${figures}`, svg: body.join('\n') });
      continue;
    }

    // markdown table → a real table slide (調參建議 answers are mostly tables)
    if (isTableRow(line) && isTableRow(lines[i + 1] ?? '') && isDivider(lines[i + 1] ?? '')) {
      const header = splitRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      for (; j < lines.length && isTableRow(lines[j] ?? ''); j++) {
        if (rows.length < DECK_LIMITS.tableRows) rows.push(splitRow(lines[j] ?? ''));
      }
      i = j - 1;
      push({
        kind: 'table',
        title: heading || '表格',
        table: { header: header.slice(0, DECK_LIMITS.tableCols), rows: rows.map((r) => r.slice(0, DECK_LIMITS.tableCols)) },
        note: rows.length >= DECK_LIMITS.tableRows ? '（表格過長，只放前幾列）' : undefined,
      });
      continue;
    }

    const h = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
    if (h) {
      flush();
      heading = clamp(plainText(h[2] ?? ''), 80);
      continue;
    }

    const text = plainText(line.replace(/^\s*([-*+]|\d+\.)\s+/, ''));
    if (!text) continue;
    if (/^\s*[-*+=_]{3,}\s*$/.test(line)) continue; // horizontal rule
    bullets.push(clamp(text, DECK_LIMITS.bulletChars));
  }
  flush();

  const title = clamp(plainText(opts.title || slides.find((s) => s.title)?.title || '對話回答'), 90);
  const deck: AnswerDeck = {
    title,
    subtitle: opts.subtitle ? clamp(plainText(opts.subtitle), 120) : undefined,
    footer: opts.footer ? clamp(plainText(opts.footer), 120) : undefined,
    slides: slides.slice(0, DECK_LIMITS.slides),
  };
  if (!deck.slides.length) deck.slides.push({ kind: 'bullets', title: '（這則回答沒有可放進投影片的內容）', bullets: [] });
  return deck;
}

/**
 * The python that has python-pptx. Chain: office_python → report_pptx_python → the office-venv in
 * the data dir (how this box is set up) → python3.
 */
export function officePython(db: Database.Database): string {
  const explicit = (getSetting(db, 'office_python') ?? '').trim();
  if (explicit) return explicit;
  const report = (getSetting(db, 'report_pptx_python') ?? '').trim();
  if (report) return report;
  const venv = path.join(paths.dataDir, 'office-venv', 'bin', 'python');
  if (fs.existsSync(venv)) return venv;
  return 'python3';
}

export const ANSWER_PPTX_SCRIPT = 'scripts/answer_pptx.py';
