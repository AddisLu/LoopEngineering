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

  it('the board offers local models and the local chip', () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'board.html'), 'utf8');
    expect(html).toContain('id="local-chip"');
    expect(html).toContain('id="model-local-group"');
    expect(html).toContain('name="local_models_enabled"');
  });
});
