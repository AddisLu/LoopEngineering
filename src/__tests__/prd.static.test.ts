import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', '..', 'web');
const read = (f: string) => fs.readFileSync(path.join(WEB_DIR, f), 'utf8');

/**
 * The PRD helpers 工作流程 and 對話操作 share (the five-step 精靈 page is gone; /prd.html opens
 * 工作流程). Same rules as the chat shell: nothing is rendered as markup, and the composer stays a
 * pure module.
 */
describe('PRD helpers (prd-compose / prd-kinds)', () => {
  it('render nothing as markup and keep the composer free of the DOM', () => {
    for (const f of ['prd-compose.js', 'prd-kinds.js']) expect(read(f), f).not.toMatch(/innerHTML/);
    const compose = read('prd-compose.js');
    expect(compose).not.toMatch(/\bdocument\b|\bwindow\b|\bfetch\(/);
    // the one sentence every image set travels with
    expect(compose).toContain('僅引用路徑，禁止複製');
  });

  it('the chat only links into 工作流程 — no second form or draft list to drift', () => {
    const index = read('index.html');
    expect(index).toContain('href="/flow.html#new"'); // ＋ 新工作流程 in 需要你處理
    expect(index).not.toContain('id="prd-drafts"'); // 工作流程 lists (and deletes) the drafts
    expect(read('frame.js')).toContain("'/flow.html'"); // the app rail
    // old links (chat answers, bookmarks) still land somewhere: /prd.html forwards to 工作流程, ?draft= kept
    expect(read('prd.html')).toContain("location.replace('/flow.html' + location.search + location.hash)");
    expect(read('prd.html')).not.toContain('prd-classic');
    expect(read('job.html')).not.toContain('job-classic');
    const dock = read('dock.js');
    expect(dock).not.toContain("$('prd-md')");
    expect(dock).not.toContain('/api/prd/drafts');
  });
});
