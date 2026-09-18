import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', '..', 'web');
const read = (f: string) => fs.readFileSync(path.join(WEB_DIR, f), 'utf8');

/**
 * The PRD wizard page. Same rules as the chat shell: every id a script looks up exists, nothing
 * is rendered as markup, and the composer stays a pure module.
 */
describe('PRD 精靈 page', () => {
  it('is a module page on the shared shell, with a way back to the conversation', () => {
    const page = read('prd.html');
    expect(page).toContain('/theme-boot.js');
    expect(page).toContain('/styles.css');
    expect(page).toContain('/shell.css');
    expect(page).toMatch(/type="module" src="\/prd\.js"/);
    expect(page).toContain('回到對話');
    expect(page).toContain('/board.html');
    for (const n of [1, 2, 3, 4, 5]) expect(page).toContain(`id="step-${n}"`);
  });

  it('every element id prd.js looks up exists in prd.html', () => {
    const page = read('prd.html');
    const js = read('prd.js');
    const ids = new Set<string>();
    for (const m of js.matchAll(/\$\('([\w-]+)'\)/g)) ids.add(m[1] as string);
    for (const m of js.matchAll(/setText\('([\w-]+)'/g)) ids.add(m[1] as string);
    expect(ids.size).toBeGreaterThan(40);
    const missing = [...ids].filter((id) => !page.includes(`id="${id}"`));
    expect(missing, `ids used by prd.js but absent from prd.html: ${missing.join(', ')}`).toEqual([]);
  });

  it('renders nothing as markup and keeps the composer free of the DOM', () => {
    for (const f of ['prd.js', 'prd-compose.js', 'prd-kinds.js']) expect(read(f), f).not.toMatch(/innerHTML/);
    const compose = read('prd-compose.js');
    expect(compose).not.toMatch(/\bdocument\b|\bwindow\b|\bfetch\(/);
    // the one sentence every image set travels with
    expect(compose).toContain('僅引用路徑，禁止複製');
    expect(read('prd.html')).toContain('禁止複製');
  });

  it('the chat shell only links into the wizard and lists drafts — no second form to drift', () => {
    const index = read('index.html');
    expect(index).toContain('id="prd-new"');
    expect(index).toContain('id="prd-drafts"');
    expect(index).toContain('href="/prd.html"');
    const dock = read('dock.js');
    expect(dock).not.toContain("$('prd-md')");
    expect(dock).not.toContain("$('prd-check')");
    expect(dock).toContain("api('/api/prd/drafts");
  });

  it('an untitled draft is named after what it is about', () => {
    const js = fs.readFileSync(path.join(WEB_DIR, 'prd.js'), 'utf8');
    // every draft used to be saved as "未命名 PRD", so three of them looked identical in the dock
    expect(js).toContain('function draftTitle()');
    expect(js).toContain('title: draftTitle()');
  });
});
