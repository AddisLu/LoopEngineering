import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// Every page is the same app: the left rail (built by frame.js into <nav id="app-rail">), a top bar
// with "你是 …", and the same scripts in the same order. The share page stays outside on purpose.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(__dirname, '..', '..', 'web');
const read = (f: string) => fs.readFileSync(path.join(WEB, f), 'utf8');
const NAV_KEYS = [...read('frame.js').matchAll(/\['(\w+)', '[^']+', '(\/[^']*)'/g)].map((m) => m[1]!);
const SHELL_PAGES = ['index.html', 'board.html', 'flow.html', 'benchmarks.html', 'plans.html', 'morning.html', 'task.html', 'brain.html'];

describe('the app shell', () => {
  it('frame.js builds the rail into #app-rail, with every page in it', () => {
    const js = read('frame.js');
    expect(js).toContain("document.getElementById('app-rail')");
    expect(NAV_KEYS).toEqual(['chat', 'board', 'flow', 'bench', 'plans', 'brain', 'morning']);
  });

  it.each(SHELL_PAGES)('%s: body.app with a rail item, the rail, 你是, and the scripts in order', (page) => {
    const html = read(page);
    const nav = /<body class="app(?: [\w-]+)*" data-nav="(\w+)"/.exec(html)?.[1];
    expect(nav, 'body.app data-nav').toBeTruthy();
    expect(NAV_KEYS).toContain(nav);
    expect(html).toContain('<nav id="app-rail" class="app-rail">');
    expect(html).toContain('id="ops-who"');
    for (const css of ['/styles.css', '/frame.css']) expect(html).toContain(`href="${css}"`);
    const ops = html.indexOf('<script src="/ops.js"></script>');
    const boot = html.indexOf('<script type="module" src="/frame-boot.js"></script>');
    expect(ops).toBeGreaterThan(0);
    expect(boot).toBeGreaterThan(ops);
  });

  it('the share page stays outside the app (viewers have no token and no navigation)', () => {
    const html = read('share.html');
    expect(html).not.toContain('frame.css');
    expect(html).not.toContain('app-rail');
  });

  it('a page menu survives the pop-up menus, and top bars give way from the middle, never at the right edge', () => {
    const js = read('frame.js');
    // popMenu used to remove every .menu-pop, 總覽's static ⋯ menu included (its button then threw)
    expect(js).toContain("document.querySelectorAll('.menu-pop[data-pop]').forEach((m) => m.remove());");
    expect(js).toContain("h('div.menu-pop', { role: 'menu', 'data-pop': '' })");
    const css = read('frame.css');
    expect(css).toContain('.top-search { flex: 0 1 280px; min-width: 120px;');
    expect(css).toContain('.app-top > .btn, .app-top > .more-wrap, .app-top > .menu-wrap { flex-shrink: 0; }');
    expect(css).toMatch(/@media \(max-width: 1280px\) \{\s*\.hide-md \{ display: none !important; \}/);
    // phones keep the theme toggle in the bottom bar
    expect(js).toContain("h('button.ibtn.theme'");
    expect(css).toContain('.app-rail .ibtn:not(.theme) { display: none; }');
    expect(read('board.html')).toContain('id="local-chip"');
    expect(read('board.html')).toMatch(/class="chip-s hide-md" id="local-chip"/);
  });

  it('pages that record under 你是 show it on phones too', () => {
    for (const page of ['task.html', 'plans.html', 'morning.html', 'index.html']) {
      expect(read(page), page).toContain('<span class="ops-who" id="ops-who"></span>');
    }
  });

  it('drafts follow 你是: 工作流程 carries the open one over, 評比 lists the new person\'s', () => {
    const flow = read('flow.js');
    expect(flow).toContain("document.addEventListener('ops:who'");
    expect(flow).toContain('async function paintRecentDrafts()');
    expect(flow).toMatch(/if \(e\.status !== 404\)[\s\S]{0,200}api\('\/api\/prd\/drafts', 'POST', body\)/);
    expect(read('benchmarks.js')).toMatch(/addEventListener\('ops:who'[\s\S]{0,200}loadDrafts\(\)/);
  });
});
