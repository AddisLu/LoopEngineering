import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', '..', 'web');

describe('voice page: static assets', () => {
  it('web/voice.html and web/voice.js exist', () => {
    expect(fs.existsSync(path.join(WEB_DIR, 'voice.html'))).toBe(true);
    expect(fs.existsSync(path.join(WEB_DIR, 'voice.js'))).toBe(true);
  });

  it('voice.js contains no innerHTML usage (cheap XSS guard) — clarify/chips render via DOM API', () => {
    const js = fs.readFileSync(path.join(WEB_DIR, 'voice.js'), 'utf8');
    expect(js).not.toMatch(/innerHTML/);
  });

  it('index.html has an independent, larger voice-cta button pointing at /voice.html', () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
    expect(html).toMatch(/class="btn primary voice-cta"[^>]*href="\/voice\.html"/);
  });

  it('styles.css defines .voice-cta', () => {
    const css = fs.readFileSync(path.join(WEB_DIR, 'styles.css'), 'utf8');
    expect(css).toMatch(/\.btn\.voice-cta/);
  });

  it('voice.html has a big, full-width mic button with status/timer elements', () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'voice.html'), 'utf8');
    expect(html).toMatch(/id="mic-btn"/);
    expect(html).toMatch(/id="mic-label"/);
    expect(html).toMatch(/id="mic-timer"/);
  });

  it('voice.html has a glossary "加入詞表" input wired to POST /api/knowledge', () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'voice.html'), 'utf8');
    expect(html).toMatch(/id="glossary-term"/);
    expect(html).toMatch(/id="glossary-add-btn"/);
    const js = fs.readFileSync(path.join(WEB_DIR, 'voice.js'), 'utf8');
    expect(js).toMatch(/\/api\/knowledge/);
    expect(js).toMatch(/glossary/);
  });
});
