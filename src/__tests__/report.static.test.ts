import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', '..', 'web');
const read = (p: string) => fs.readFileSync(path.join(WEB_DIR, p), 'utf8');

describe('report deck page: static assets', () => {
  it('report.html / report.js / report.css exist', () => {
    for (const f of ['report.html', 'report.js', 'report.css']) {
      expect(fs.existsSync(path.join(WEB_DIR, f))).toBe(true);
    }
  });

  it('is self-contained: report.html links report.css and does NOT depend on the shared styles.css', () => {
    const html = read('report.html');
    expect(html).toMatch(/href="\/report\.css"/);
    expect(html).not.toMatch(/href="\/styles\.css"/);
  });

  // ---- security invariant: textContent-only rendering, one controlled innerHTML ----
  it('report.js uses innerHTML exactly once — the sanitized mermaid SVG', () => {
    const js = read('report.js');
    const innerHtmlLines = js.split('\n').filter((l) => /innerHTML/.test(l) && !l.trim().startsWith('//'));
    expect(innerHtmlLines).toHaveLength(1);
    expect(innerHtmlLines[0]).toMatch(/target\.innerHTML\s*=\s*svg/);
    expect(js).toMatch(/securityLevel:\s*'strict'/);
  });

  it('report.js loads no external resources — every http(s) literal is a w3.org XML namespace, scripts come from /vendor', () => {
    const js = read('report.js');
    const urls = js.match(/https?:\/\/\S+/g) || [];
    for (const u of urls) expect(u).toMatch(/w3\.org/); // xmlns identifiers only, never fetched
    expect(js).toMatch(/\/vendor\/mermaid\.min\.js/);
    expect(js).toMatch(/\/vendor\/pptxgen\.bundle\.js/);
    // no CDN-style loads
    expect(js).not.toMatch(/src\s*[:=]\s*["'`]https?:/);
    expect(js).not.toMatch(/fetch\(\s*["'`]https?:/);
  });

  it('vendored libs are present locally (mermaid + pptxgenjs), no CDN', () => {
    expect(fs.existsSync(path.join(WEB_DIR, 'vendor', 'mermaid.min.js'))).toBe(true);
    expect(fs.existsSync(path.join(WEB_DIR, 'vendor', 'pptxgen.bundle.js'))).toBe(true);
  });

  // ---- form controls the generate flow needs ----
  it('report.html has the description, template, project, save, and generate controls', () => {
    const html = read('report.html');
    for (const id of ['f-description', 'f-template', 'f-project', 'f-save', 'gen-btn']) {
      expect(html).toMatch(new RegExp(`id="${id}"`));
    }
  });

  it('report.js posts to /api/report, lists templates from /api/report/templates, and wires the save flag', () => {
    const js = read('report.js');
    expect(js).toMatch(/\/api\/report\/templates/);
    expect(js).toMatch(/\/api\/report/);
    expect(js).toMatch(/f-save/);
    expect(js).toMatch(/body\.save\s*=\s*true/);
  });

  // ---- staged progress + client timeout (kept from the classic report page) ----
  it('report.js shows an elapsed-seconds counter with staged progress hints while generating', () => {
    const js = read('report.js');
    expect(js).toMatch(/setInterval/);
    expect(js).toMatch(/已等待/);
    expect(js).toMatch(/STAGE_HINTS/);
  });

  it('report.js aborts past a client-side timeout and shows an error instead of hanging', () => {
    const js = read('report.js');
    expect(js).toMatch(/AbortController/);
    expect(js).toMatch(/CLIENT_TIMEOUT_MS/);
    expect(js).toMatch(/逾時/);
  });

  // ---- 16:9 deck + exports ----
  it('report.css defines a 1920×1080 deck canvas and a print rule sizing each slide to a 1920×1080 page', () => {
    const css = read('report.css');
    expect(css).toMatch(/\.deck-canvas/);
    expect(css).toMatch(/width:\s*1920px/);
    expect(css).toMatch(/height:\s*1080px/);
    expect(css).toMatch(/@media print/);
    expect(css).toMatch(/size:\s*1920px 1080px/);
  });

  it('report.html exposes the four export buttons (PDF / PNG / HTML / PPTX)', () => {
    const html = read('report.html');
    for (const id of ['print-btn', 'png-btn', 'html-btn', 'pptx-btn']) {
      expect(html).toMatch(new RegExp(`id="${id}"`));
    }
  });

  it('report.js drives PDF via window.print(), and builds standalone-HTML + PPTX exports', () => {
    const js = read('report.js');
    expect(js).toMatch(/window\.print\(\)/);
    expect(js).toMatch(/exportHTML/);
    expect(js).toMatch(/exportPPTX/);
    expect(js).toMatch(/writeFile/); // pptxgenjs
  });

  it('report.js renders a boss-specific persona (plant / manager / pm) onto the deck', () => {
    const js = read('report.js');
    expect(js).toMatch(/data-persona/);
    expect(js).toMatch(/resolvePersona/);
  });

  // ---- navigation links ----
  it('report.html has a back-to-board link and index.html links to the report page', () => {
    expect(read('report.html')).toMatch(/href="\/"[^>]*>←\s*看板/);
    expect(read('index.html')).toMatch(/href="\/report\.html"/);
  });
});
