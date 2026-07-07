import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', '..', 'web');

describe('report page: static assets', () => {
  it('web/report.html and web/report.js exist', () => {
    expect(fs.existsSync(path.join(WEB_DIR, 'report.html'))).toBe(true);
    expect(fs.existsSync(path.join(WEB_DIR, 'report.js'))).toBe(true);
  });

  it('report.js contains no innerHTML usage (cheap XSS guard) — markdown renders via DOM API', () => {
    const js = fs.readFileSync(path.join(WEB_DIR, 'report.js'), 'utf8');
    expect(js).not.toMatch(/innerHTML/);
  });

  it('index.html has a topbar link to /report.html', () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
    expect(html).toMatch(/href="\/report\.html"/);
  });

  it('report.html has a back-to-board link', () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'report.html'), 'utf8');
    expect(html).toMatch(/href="\/"[^>]*>←\s*看板/);
  });

  it('report.html has a description textarea, template dropdown, project field, and generate button', () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'report.html'), 'utf8');
    expect(html).toMatch(/id="f-description"/);
    expect(html).toMatch(/id="f-template"/);
    expect(html).toMatch(/id="f-project"/);
    expect(html).toMatch(/id="gen-btn"/);
  });

  it('report.html has a print/save-PDF button and an @media print rule', () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'report.html'), 'utf8');
    expect(html).toMatch(/id="print-btn"/);
    expect(html).toMatch(/@media print/);
  });

  it('report.js fetches templates from GET /api/report/templates and posts to /api/report', () => {
    const js = fs.readFileSync(path.join(WEB_DIR, 'report.js'), 'utf8');
    expect(js).toMatch(/\/api\/report\/templates/);
    expect(js).toMatch(/\/api\/report/);
  });

  it('report.js calls window.print() from the print button', () => {
    const js = fs.readFileSync(path.join(WEB_DIR, 'report.js'), 'utf8');
    expect(js).toMatch(/window\.print\(\)/);
  });
});
