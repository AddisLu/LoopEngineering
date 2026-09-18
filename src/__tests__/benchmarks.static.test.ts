import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', '..', 'web');

describe('benchmarks page + local model board wiring: static assets', () => {
  it('web/benchmarks.html and web/benchmarks.js exist and are linked from the board', () => {
    expect(fs.existsSync(path.join(WEB_DIR, 'benchmarks.html'))).toBe(true);
    expect(fs.existsSync(path.join(WEB_DIR, 'benchmarks.js'))).toBe(true);
    const html = fs.readFileSync(path.join(WEB_DIR, 'benchmarks.html'), 'utf8');
    expect(html).toContain('/styles.css');
    expect(html).toContain('/benchmarks.js');
    expect(fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8')).toMatch(/href="\/benchmarks\.html"/);
  });

  it('benchmarks.js never uses innerHTML (cheap XSS guard)', () => {
    expect(fs.readFileSync(path.join(WEB_DIR, 'benchmarks.js'), 'utf8')).not.toMatch(/innerHTML/);
  });

  it('the page has the three views and everything the create flow needs', () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'benchmarks.html'), 'utf8');
    for (const id of [
      'view-list', 'view-detail', 'view-new',
      'running-box', 'records', 'matrix', 'bench-list', 'filter-status',
      'detail-title', 'detail-chips', 'detail-arms', 'detail-judges', 'rejudge-btn', 'back-btn',
      'source-tabs', 'src-builtin', 'src-task', 'src-draft', 'src-manual',
      'builtin-list', 'task-select', 'draft-select', 'model-picks', 'judge-picks', 'estimate', 'bench-submit',
    ]) {
      expect(html, `missing id="${id}"`).toContain(`id="${id}"`);
    }
    // the flex-column body would otherwise shrink the page to its content width
    expect(html).toMatch(/main\.bench \{ width: 100%/);
    const js = fs.readFileSync(path.join(WEB_DIR, 'benchmarks.js'), 'utf8');
    for (const route of ['/api/benchmarks/summary', '/api/benchmarks/builtin', '/api/benchmarks/matrix', '/api/local/catalog']) {
      expect(js, `never calls ${route}`).toContain(route);
    }
  });

  it('every dock panel opens its full page from a button row at the top', () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
    // the links used to sit at the bottom of the scrolling panel, below the content
    expect(html).not.toContain('pane-foot');
    for (const pane of ['pane-tasks', 'pane-tune', 'pane-kb', 'pane-prd', 'pane-bench']) {
      const start = html.indexOf(`id="${pane}"`);
      const slice = html.slice(start, html.indexOf('<div class="dock-pane"', start + 1));
      expect(slice, `${pane} has no top button row`).toContain('class="pane-top"');
    }
    expect(fs.readFileSync(path.join(WEB_DIR, 'shell.css'), 'utf8')).toContain('.pane-top');
  });

  it('the benchmark task picker mirrors the board', () => {
    const js = fs.readFileSync(path.join(WEB_DIR, 'benchmarks.js'), 'utf8');
    expect(js).toContain("api('/api/board')");
    // it used to hide the benchmark arms, so the picker showed fewer tasks than the board
    expect(js).not.toMatch(/filter\(\(c\) => !c\.title\.startsWith/);
    expect(js).toContain('評比用');
  });

  it('the dock shows the dashboard in Chinese, not raw enum values', () => {
    const dock = fs.readFileSync(path.join(WEB_DIR, 'dock.js'), 'utf8');
    expect(dock).toContain('/api/benchmarks/summary');
    expect(dock).toContain("judged: '已評分'");
    // b.status used to be rendered straight into a chip
    expect(dock).not.toMatch(/chip', b\.status/);
    expect(dock).toContain('評比使用中');
    const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
    for (const id of ['bench-running', 'bench-models', 'bench-list', 'bench-new']) expect(html).toContain(`id="${id}"`);
  });

  it('the PRD wizard can send a PRD to a benchmark instead of one task', () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'prd.html'), 'utf8');
    expect(html).toContain('id="bench-pick"');
    expect(html).toContain('id="bench-models"');
    expect(html).toContain('id="bench-judges"');
    const js = fs.readFileSync(path.join(WEB_DIR, 'prd.js'), 'utf8');
    expect(js).toContain('benchmark_models');
    expect(js).toContain('judge_models');
    // the old code read r.task.id unconditionally and threw on a benchmark response
    expect(js).toContain('if (r.benchmark)');
    expect(js).not.toMatch(/innerHTML/);
  });

  it('the board offers local models and the local chip', () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'board.html'), 'utf8');
    expect(html).toContain('id="local-chip"');
    expect(html).toContain('id="model-local-group"');
    expect(html).toContain('name="local_models_enabled"');
  });
});
