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
const SHELL_PAGES = ['board.html', 'flow.html', 'benchmarks.html'];

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
});
