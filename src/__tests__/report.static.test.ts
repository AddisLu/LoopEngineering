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

  it('report.js only uses innerHTML for the mermaid-render controlled exception, with securityLevel strict', () => {
    const js = fs.readFileSync(path.join(WEB_DIR, 'report.js'), 'utf8');
    const innerHtmlLines = js.split('\n').filter((l) => /innerHTML/.test(l) && !l.trim().startsWith('//'));
    expect(innerHtmlLines).toHaveLength(1);
    expect(innerHtmlLines[0]).toMatch(/target\.innerHTML\s*=\s*svg/);
    expect(js).toMatch(/securityLevel:\s*'strict'/);
  });

  it('mermaid.min.js is vendored locally under web/vendor (no CDN reference in report.js)', () => {
    expect(fs.existsSync(path.join(WEB_DIR, 'vendor', 'mermaid.min.js'))).toBe(true);
    const js = fs.readFileSync(path.join(WEB_DIR, 'report.js'), 'utf8');
    expect(js).toMatch(/\/vendor\/mermaid\.min\.js/);
    expect(js).not.toMatch(/https?:\/\//); // no external script URL of any kind
  });

  it('report.js renders ```mermaid fenced blocks and offers a copy-source button', () => {
    const js = fs.readFileSync(path.join(WEB_DIR, 'report.js'), 'utf8');
    expect(js).toMatch(/mermaid/);
    expect(js).toMatch(/複製 Mermaid 原始碼/);
    expect(js).toMatch(/navigator\.clipboard\.writeText/);
  });

  it('report.html has a save-to-disk checkbox wired to POST /api/report\'s save field', () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'report.html'), 'utf8');
    expect(html).toMatch(/id="f-save"/);
    const js = fs.readFileSync(path.join(WEB_DIR, 'report.js'), 'utf8');
    expect(js).toMatch(/f-save/);
    expect(js).toMatch(/body\.save\s*=\s*true/);
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
