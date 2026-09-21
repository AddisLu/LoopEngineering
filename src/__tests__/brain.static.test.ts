import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', '..', 'web');

describe('brain page: static assets', () => {
  it('web/brain.html, web/brain.js, and web/graph-layout.js exist', () => {
    expect(fs.existsSync(path.join(WEB_DIR, 'brain.html'))).toBe(true);
    expect(fs.existsSync(path.join(WEB_DIR, 'brain.js'))).toBe(true);
    expect(fs.existsSync(path.join(WEB_DIR, 'graph-layout.js'))).toBe(true);
  });

  it('brain.js and graph-layout.js contain no innerHTML usage (cheap XSS guard)', () => {
    expect(fs.readFileSync(path.join(WEB_DIR, 'brain.js'), 'utf8')).not.toMatch(/innerHTML/);
    expect(fs.readFileSync(path.join(WEB_DIR, 'graph-layout.js'), 'utf8')).not.toMatch(/innerHTML/);
  });

  it('graph-layout.js is DOM-free (no document/window/canvas references) so it stays hermetically testable', () => {
    const js = fs.readFileSync(path.join(WEB_DIR, 'graph-layout.js'), 'utf8');
    expect(js).not.toMatch(/\bdocument\./);
    expect(js).not.toMatch(/\bwindow\./);
    expect(js).not.toMatch(/getContext/);
  });

  it('brain.js is an ES module that imports graph-layout.js and renders the knowledge graph on <canvas> (SSoT Phase 3, no CDN/library)', () => {
    const js = fs.readFileSync(path.join(WEB_DIR, 'brain.js'), 'utf8');
    expect(js).toMatch(/from ['"]\/graph-layout\.js['"]/);
    expect(js).toMatch(/getContext\(['"]2d['"]\)/);
    expect(js).toMatch(/requestAnimationFrame/);
    // pan/zoom/drag/expand interactions
    expect(js).toMatch(/addEventListener\(\s*['"]wheel['"]/);
    expect(js).toMatch(/addEventListener\(\s*['"]mousedown['"]/);
    expect(js).toMatch(/expandVertex/);
  });

  it('brain.html loads brain.js as a module and has a canvas-based graph panel, not the old SVG relation view', () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'brain.html'), 'utf8');
    expect(html).toMatch(/<script type="module" src="\/brain\.js">/);
    expect(html).toMatch(/<canvas id="graph-canvas"/);
    expect(html).not.toContain('relation-svg');
  });

  it('brain.html references /styles.css and /brain.js, and is the full-screen immersive graph stage (G5)', () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'brain.html'), 'utf8');
    expect(html).toContain('/styles.css');
    expect(html).toContain('/brain.js');
    // graph-first: a full-viewport <main class="graph-stage"> holds the canvas; the curated
    // node list lives in a slide-in management drawer, not a narrow centered column.
    expect(html).toMatch(/<main[^>]*class="[^"]*graph-stage/);
    expect(html).toMatch(/id="manage-drawer"/);
    expect(html).toMatch(/id="graph-legend"/);
    expect(html).not.toMatch(/<main[^>]*class="board"/);
  });

  it('index.html contains the 知識庫 nav link to /brain.html', () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
    expect(html).toMatch(/href="\/brain\.html"/);
    expect(html).toContain('知識庫');
  });

  it('the galaxy renderer draws edges additively and keeps node cores small', () => {
    const js = fs.readFileSync(path.join(WEB_DIR, 'brain.js'), 'utf8');
    // the old pass drew fat beads with source-over halos, so the graph read as confetti:
    // structure came from nothing. Edges carry it now, and they only glow when summed.
    expect(js).toContain("globalCompositeOperation = 'lighter'");
    expect(js).toContain("globalCompositeOperation = 'source-over'"); // always restored
    expect(js).toContain('coreMin');
    expect(js).toContain('haloScale');
    expect(js).toContain('haloColor');
    expect(js).not.toContain('beadColor(v)'); // the glass-bead pass is gone
    // additive must never escape onto the page itself — it only works on the dark canvas
    expect(js.match(/globalCompositeOperation = 'lighter'/g)?.length).toBe(
      js.match(/globalCompositeOperation = 'source-over'/g)?.length,
    );
  });
});
