import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', '..', 'web');

describe('brain page: static assets', () => {
  it('web/brain.html and web/brain.js exist', () => {
    expect(fs.existsSync(path.join(WEB_DIR, 'brain.html'))).toBe(true);
    expect(fs.existsSync(path.join(WEB_DIR, 'brain.js'))).toBe(true);
  });

  it('brain.js contains no innerHTML usage (cheap XSS guard)', () => {
    const js = fs.readFileSync(path.join(WEB_DIR, 'brain.js'), 'utf8');
    expect(js).not.toMatch(/innerHTML/);
  });

  it('brain.html references /styles.css and /brain.js, and has its own <main class="brain">', () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'brain.html'), 'utf8');
    expect(html).toContain('/styles.css');
    expect(html).toContain('/brain.js');
    expect(html).toMatch(/<main class="brain"/);
    expect(html).not.toMatch(/<main[^>]*class="board"/);
  });

  it('index.html contains the 知識庫 nav link to /brain.html', () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
    expect(html).toMatch(/href="\/brain\.html"/);
    expect(html).toContain('知識庫');
  });
});
