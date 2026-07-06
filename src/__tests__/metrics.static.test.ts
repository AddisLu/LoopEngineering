import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', '..', 'web');

describe('metrics page: static assets', () => {
  it('web/metrics.html and web/metrics.js exist', () => {
    expect(fs.existsSync(path.join(WEB_DIR, 'metrics.html'))).toBe(true);
    expect(fs.existsSync(path.join(WEB_DIR, 'metrics.js'))).toBe(true);
  });

  it('metrics.js contains no innerHTML usage (cheap XSS guard)', () => {
    const js = fs.readFileSync(path.join(WEB_DIR, 'metrics.js'), 'utf8');
    expect(js).not.toMatch(/innerHTML/);
  });

  it('metrics.js builds charts with createElementNS (SVG, no innerHTML)', () => {
    const js = fs.readFileSync(path.join(WEB_DIR, 'metrics.js'), 'utf8');
    expect(js).toMatch(/createElementNS/);
  });

  it('metrics.html references /styles.css and /metrics.js, and has its own <main class="metrics">', () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'metrics.html'), 'utf8');
    expect(html).toContain('/styles.css');
    expect(html).toContain('/metrics.js');
    expect(html).toMatch(/<main class="metrics"/);
    expect(html).not.toMatch(/<main[^>]*class="board"/);
  });

  it('index.html and brain.html both link to /metrics.html', () => {
    const index = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
    const brain = fs.readFileSync(path.join(WEB_DIR, 'brain.html'), 'utf8');
    expect(index).toMatch(/href="\/metrics\.html"/);
    expect(brain).toMatch(/href="\/metrics\.html"/);
  });
});
