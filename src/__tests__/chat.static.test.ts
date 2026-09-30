import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', '..', 'web');
const read = (f: string) => fs.readFileSync(path.join(WEB_DIR, f), 'utf8');
const html = () => read('index.html');
/** every script that renders model output or talks to /api/chat */
const scripts = () => ['chat.js', 'chat-md.js', 'shell.js', 'dock.js', 'terminal.js'].filter((f) => fs.existsSync(path.join(WEB_DIR, f)));

describe('模型對話 scripts', () => {
  it('never uses innerHTML (model output and task titles are untrusted text)', () => {
    for (const file of scripts()) {
      expect(read(file), file).not.toMatch(/innerHTML/);
    }
  });

  it('keeps HTML / SVG previews sandboxed without same-origin access', () => {
    const owner = scripts().find((f) => read(f).includes('previewFrame'));
    expect(owner, 'no chat script defines previewFrame').toBeTruthy();
    const js = read(owner as string);
    expect(js).toContain("setAttribute('sandbox', 'allow-scripts')");
    expect(js).not.toMatch(/allow-same-origin/);
    expect(js).toContain('Content-Security-Policy');
  });

  it('carries identity on every call and reads the stored timestamps as UTC', () => {
    const shell = read('shell.js');
    // headers are latin1, so a Chinese name only survives percent-encoded (identity.ts decodes it)
    expect(shell).toContain("'x-loop-user': encodeURIComponent(n)");
    // SQLite stores 'YYYY-MM-DD HH:MM:SS' in UTC with no marker — without the Z every row is off
    expect(shell).toMatch(/replace\(' ', 'T'\)\}Z/);
    // a stored screenshot cannot be an <img src>: the bearer token has to ride along
    expect(read('chat.js')).toMatch(/fetch\(im\.url, \{ headers: \{ \.\.\.authHeaders/);
  });

  it('never lets a failed save break the chat, and caps what is replayed into the model', () => {
    const js = read('chat.js');
    // Every history call sits inside a histSafe(...) callback: a storage failure must degrade to
    // in-memory-only behaviour, never break the answer the user is waiting for.
    expect(js).toContain('async function histSafe');
    const lines = js.split('\n');
    const unguarded = lines.filter((line, i) => {
      if (!/chatApi\([`']\/api\/chat\/(conversations|messages)/.test(line)) return false;
      // the window covers the whole enclosing histSafe callback, the longest of which is saveUserTurn
      return !lines.slice(Math.max(0, i - 14), i + 1).some((l) => l.includes('histSafe('));
    });
    expect(unguarded, `history calls outside histSafe: ${unguarded.join(' | ')}`).toEqual([]);
    expect(js).toContain('function modelHistory');
    expect(js).toContain('contextTurns');
  });

  it('對話操作: the card confirms through the page\'s own request and shows the engine\'s summary; links stay on this site', () => {
    const js = read('chat.js');
    expect(js).toContain('/api/ops/actions/${encodeURIComponent(v.id)}/confirm');
    expect(js).toContain('/api/ops/actions/${encodeURIComponent(v.id)}/cancel');
    expect(js).toContain("el('pre', 'sum', v.summary || '')"); // verbatim, never the model's retelling
    const src = /const SAFE_URL = (\/.+\/i);/.exec(read('chat-md.js'))![1]!;
    const safe = new Function(`return ${src}`)() as RegExp;
    for (const ok of ['https://github.com/x', 'http://127.0.0.1:4711/', '/task.html?id=t_1', '/benchmarks.html#b=b_1']) expect(safe.test(ok), ok).toBe(true);
    for (const bad of ['//evil.example/x', '/\\evil.example', 'javascript:alert(1)', 'data:text/html,x', 'task.html']) expect(safe.test(bad), bad).toBe(false);
  });

  it('remembers each rail state under its loop_shell_* key, in the file that owns that rail', () => {
    expect(read('chat.js')).toContain('loop_shell_rail'); // 對話紀錄
    expect(read('dock.js')).toContain('loop_shell_dock'); // 工作面板
    expect(read('dock.js')).toContain('loop_shell_tab');
  });

  // setText writes ~25 ids once a second inside a try/catch, so a stale id would fail silently
  // forever. This checks every literal lookup in the scripts against the markup instead.
  it('every element id the scripts look up exists in the page', () => {
    const page = html();
    const ids = new Set<string>();
    for (const file of scripts()) {
      const js = read(file);
      for (const m of js.matchAll(/\$\('([\w-]+)'\)/g)) ids.add(m[1] as string);
      for (const m of js.matchAll(/setText\('([\w-]+)'/g)) ids.add(m[1] as string);
    }
    expect(ids.size).toBeGreaterThan(20);
    const missing = [...ids].filter((id) => !page.includes(`id="${id}"`));
    expect(missing, `ids used by chat scripts but absent from index.html: ${missing.join(', ')}`).toEqual([]);
  });

  it('the topbar model chip is painted from the board stream, not only by the stats poll', () => {
    const js = fs.readFileSync(path.join(WEB_DIR, 'chat.js'), 'utf8');
    // refreshStats() is gated on a panel being open, so with the dock collapsed the chip used to
    // keep the placeholder text from index.html forever
    expect(js).toContain('onBoard');
    expect(js).toContain('LOCAL_STATE');
    expect(js).toContain('模型就緒');
    const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
    expect(html).toContain('id="svc-state"');
  });

  it('the help menu is in the topbar and reaches all three guides', () => {
    const html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
    // the guides used to sit at the bottom of the history drawer, under the conversation list
    const head = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    expect(head).toContain('id="help-menu"');
    for (const doc of ['/docs/demo-guide.html', '/docs/操作說明.html', '/docs/前置作業.html']) {
      expect(head, `help menu misses ${doc}`).toContain(doc);
    }
    expect(html.slice(html.indexOf('rail-nav'), html.indexOf('</nav>'))).not.toContain('/docs/');
    expect(fs.readFileSync(path.join(WEB_DIR, 'chat-actions.js'), 'utf8')).toContain('mountHelpMenu');
    expect(fs.readFileSync(path.join(WEB_DIR, 'chat.js'), 'utf8')).toContain('mountHelpMenu()');
  });

  it('the three guides exist, cross-link each other, and the prerequisites one leaks nothing', () => {
    const DOCS = path.join(__dirname, '..', '..', 'docs');
    const quick = fs.readFileSync(path.join(DOCS, 'demo-guide.html'), 'utf8');
    const manual = fs.readFileSync(path.join(DOCS, '操作說明.html'), 'utf8');
    const first = fs.readFileSync(path.join(DOCS, '前置作業.html'), 'utf8');
    for (const [name, doc] of [['quickstart', quick], ['manual', manual]] as const) {
      expect(doc, `${name} does not link the prerequisites guide`).toContain('/docs/前置作業.html');
    }
    // the quickstart drifted from the manual once; every card now names its chapter
    expect(quick.match(/→ 完整說明第/g)?.length ?? 0).toBeGreaterThanOrEqual(8);
    expect(quick).toContain('worktree');
    expect(quick).toContain('轉成任務');
    // every guide can get back to the app; the manual had no way out at all
    expect(quick).toContain('href="/"');
    expect(manual).toContain('href="/"');
    expect(first).toContain('id="back"'); // shown only when served, hidden in an emailed copy
    // it is emailed to people who cannot reach the site yet: no address, no token, standalone
    expect(first).not.toMatch(/ts\.net\/|Bearer |token=[A-Za-z0-9]/);
    expect(first).not.toMatch(/192\.168\.|10\.\d+\.\d+\.\d+/);
    expect(first).not.toContain('/styles.css');
  });

  it('every answer can be saved on its own, in the formats it actually produced', () => {
    const js = fs.readFileSync(path.join(WEB_DIR, 'chat-actions.js'), 'utf8');
    // the ⋯ menu only ever exported the whole conversation
    expect(js).toContain("actionBtn('存檔'");
    expect(js).toContain('openSaveDialog');
    expect(js).toContain('fencedBlocks');
    expect(js).toContain('printDoc'); // 列印／存成 PDF
    expect(js).toContain('image/svg+xml');
    // the deck is the one format the browser cannot make; the row waits for the server to confirm
    expect(js).toContain('/api/chat/export/formats');
    expect(js).toContain('簡報（.pptx）');
    expect(js).toContain('/pptx');
    expect(js).toContain('匯出整段對話（Markdown）');
    expect(fs.readFileSync(path.join(WEB_DIR, 'shell.css'), 'utf8')).toContain('dialog.save-dialog');
  });

  it('the conversation menu cannot double up its own items', () => {
    const js = fs.readFileSync(path.join(WEB_DIR, 'chat-actions.js'), 'utf8');
    // build() awaits mid-way; two quick opens appended 分享／刪除 twice
    expect(js).toContain('buildSeq');
    expect(js).toContain('if (mine !== buildSeq) return;');
  });
});
