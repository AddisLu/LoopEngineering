import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { ROLES } from '../local/catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', '..', 'web');
const read = (f: string) => fs.readFileSync(path.join(WEB_DIR, f), 'utf8');

const exists = (f: string) => fs.existsSync(path.join(WEB_DIR, f));

/**
 * The chat-first shell: / is the conversation, everything else is a rail, a dock tab or a link
 * out. These assertions pin the structure the scripts and the demo script depend on.
 */

describe('chat-first shell', () => {
  it('index.html is the conversation, with both collapsible rails and the dock tabs', () => {
    const page = read('index.html');
    for (const id of [
      'shell-main',
      'rail',
      'rail-inner',
      'rail-toggle',
      'conv-list',
      'conv-search',
      'new-chat-btn',
      'conv-title',
      'who-label',
      'who-form',
      'who-name',
      'convo',
      'log',
      'empty',
      'composer',
      'prompt',
      'kb-box',
      'think-box',
      'tools-box',
      'file-input',
      'file-btn',
      'stop-btn',
      'send-btn',
      'dock',
      'dock-toggle',
      'activity-bar',
      'act-tasks',
      'act-tune',
      'act-kb',
      'act-prd',
      'act-model',
      'act-status',
      'act-bench',
      'pane-tasks',
      'pane-tune',
      'tune-form',
      'tune-symptom',
      'tune-scope',
      'tune-submit',
      'tune-status',
      'tune-latest',
      'tune-to-task',
      'tune-show',
      'tune-history',
      'tune-refresh',
      'pane-kb',
      'pane-prd',
      'pane-model',
      'model-switch',
      'switch-state',
      'model-job',
      'model-job-bar',
      'model-job-cancel',
      'model-image-notice',
      'model-image-build',
      'model-reco-list',
      'model-all',
      'model-list',
      'pane-status',
      'pane-bench',
      'svc-state',
      'theme-btn',
      'term-toggle',
      'term-drawer',
      'term-handle',
      'term-tabs',
      'term-new',
      'term-close',
      'term-panes',
      'model-job-log',
      'chat-drawer',
      'drawer-body',
      'drawer-close',
      'drawer-scrim',
    ]) {
      expect(page, `missing id="${id}"`).toContain(`id="${id}"`);
    }
    expect(page).toContain('/theme-boot.js');
    expect(page).toContain('/styles.css');
    expect(page).toContain('/shell.css');
    expect(page).toMatch(/type="module" src="\/chat\.js"/);
    expect(page).toMatch(/type="module" src="\/dock\.js"/);
  });

  it('hands the width back to the answer: collapsible grid tracks and no capped reading column', () => {
    const css = read('shell.css');
    expect(css).toContain('grid-template-columns: var(--rail-w) minmax(0, 1fr) var(--dock-w) var(--act-w)');
    expect(css).toContain('main.shell.rail-collapsed');
    expect(css).toContain('main.shell.dock-collapsed');
    // the old chat page squeezed the conversation between a fixed cap and two永久欄
    expect(css).not.toContain('max-width: 1680px');
    expect(css).toContain('@media (max-width: 720px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('lets the hidden attribute win, and starts with the sample questions out of the way', () => {
    // .samples/.attach/.params are all shown with a class that sets `display`, and a class beats
    // the UA sheet's [hidden]{display:none} — without this reset, hiding them in JS does nothing.
    expect(read('shell.css')).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
    const js = read('chat.js');
    expect(js).toContain("stored('loop_shell_samples') === 'open'"); // hidden until asked for
    expect(js).toContain('loop_shell_samples');
  });

  it('says plainly that history is a workspace split, not privacy isolation', () => {
    expect(read('index.html')).toContain('工作區分隔');
  });

  it('links every kept page from the rail, and the manual from /docs/', () => {
    const page = read('index.html');
    for (const href of ['/board.html', '/brain.html', '/prd.html', '/benchmarks.html', '/docs/操作說明.html']) {
      expect(page, `rail does not link ${href}`).toContain(`href="${href}"`);
    }
  });

  it('keeps the old /chat.html bookmark working without duplicating the page', () => {
    const stub = read('chat.html');
    expect(stub).toContain('location.replace');
    expect(stub).toContain('location.search'); // a plain meta-refresh would drop ?token=
    expect(stub).not.toContain('/chat.js');
    expect(stub.length).toBeLessThan(1200);
  });

  it('the board moved to /board.html and offers one way back', () => {
    const board = read('board.html');
    for (const id of ['board', 'new-dialog', 'settings-dialog', 'prune-dialog', 'detail-dialog', 'local-chip']) {
      expect(board, `board lost id="${id}"`).toContain(`id="${id}"`);
    }
    expect(board).toContain('回到對話');
    // the chat shell deep-links into the board instead of re-implementing the task detail
    expect(read('app.js')).toContain("h.startsWith('task=')");
    expect(read('app.js')).toContain('openDetail(');
  });

  it('every kept secondary page returns to the conversation', () => {
    for (const page of ['brain.html', 'prd.html', 'benchmarks.html']) {
      expect(read(page), page).toContain('回到對話');
    }
  });

  it('offers the per-message actions and the conversation menu', () => {
    const page = read('index.html');
    expect(page).toContain('id="conv-menu"');
    expect(page).toContain('id="tune-box"');
    // the page must say, in the page, that a tuning suggestion is only a suggestion
    expect(page).toContain('只產生建議，不會改機台');
    const actions = read('chat-actions.js');
    for (const label of ['重答', '編輯重問', '存進知識庫', '轉成任務', '請雲端複核', '建立分享連結', '存檔', '匯出整段對話（Markdown）']) {
      expect(actions, `action bar lost ${label}`).toContain(label);
    }
  });

  it('keeps the way back to every panel on screen, whatever the panel is doing', () => {
    const page = read('index.html');
    // outside aside#dock on purpose: neither collapsing the panel (--dock-w: 0) nor lending
    // .dock-inner to the phone drawer can take the icons away
    const dockEnd = page.indexOf('</aside>', page.indexOf('id="dock"'));
    expect(page.indexOf('id="activity-bar"')).toBeGreaterThan(dockEnd);
    for (const tab of ['tasks', 'tune', 'kb', 'prd', 'model', 'bench']) {
      expect(page).toMatch(new RegExp(`id="act-${tab}"[^>]*role="tab"`));
      expect(page).toMatch(new RegExp(`id="act-${tab}"[^>]*aria-controls="pane-${tab}"`));
    }
    expect(page).toContain('aria-orientation="vertical"');
    const css = read('shell.css');
    expect(css).toContain('--act-w: 44px');
    expect(css).not.toContain('.dock-tab'); // the text tab strip is gone
  });

  it('keeps the dock collapsible on every tab, and initialises the dock after its state exists', () => {
    const css = read('shell.css');
    // .dock-wide (任務 tab) and .dock-collapsed coexist; the collapsed rule must come later or it
    // loses the cascade and the dock can never be closed while on 任務
    expect(css.lastIndexOf('main.shell.dock-collapsed')).toBeGreaterThan(css.indexOf('main.shell.dock-wide'));
    expect(css).not.toContain('.dock-open'); // a class no script ever set — the dock could not open below 1200px
    const js = read('dock.js');
    // the first paint reads `let` state declared throughout the module; calling it any earlier is a
    // temporal-dead-zone crash that silently disables every handler after it
    for (const decl of ['let benchTimer', 'let switching', 'let jobTimer', 'let catalogData', 'let benchBusy', 'let tuneLatest', 'let tuneBusy', 'let dockRail']) {
      expect(js.lastIndexOf('paintTabs();'), decl).toBeGreaterThan(js.indexOf(decl));
    }
    // Alt+digit types a symbol on macOS — the shortcut must read e.code
    expect(js).toContain('e.code');
    expect(js).toContain('Digit([1-7])'); // seven panels since 模型／機台 split
    // one owner for the panel: selection and open/closed both live here now
    expect(js).toContain('loop_shell_dock');
    // one drawer owner: both rails borrow shell.js's drawer, nobody moves nodes by hand
    expect(read('shell.js')).toContain('export const drawer');
    expect(js).not.toContain('drawer-body');
    expect(read('chat.js')).not.toContain("$('drawer-body')");
  });

  it('keeps model switching and machine status on separate icons', () => {
    const page = read('index.html');
    const slice = (id: string) => {
      const start = page.indexOf(`id="${id}"`);
      const end = page.indexOf('<div class="dock-pane"', start + 1);
      return page.slice(start, end === -1 ? undefined : end);
    };
    // the response/memory/GPU tiles live under 機台 now, not under the switcher
    expect(slice('pane-status')).toContain('id="r-ttft"');
    expect(slice('pane-status')).toContain('id="mem-bar"');
    expect(slice('pane-model')).not.toContain('id="r-ttft"');
    expect(page).toContain('title="機台狀況（Alt+6）"');
    expect(page).toContain('title="Benchmark（Alt+7）"');
    // chat.js polls /api/chat/stats only while a panel that shows it is open — 機台 (tiles) or
    // 知識庫 (documents/chunks/sources); leaving 知識庫 out stuck its counters on “–”
    const chat = read('chat.js');
    expect(chat).toContain("paneOpen('pane-status')");
    expect(chat).toContain("paneOpen('pane-kb')");
    expect(chat).not.toContain("'pane-model'");
    // the switcher is built on the catalog (every recipe on disk), with background jobs
    const dock = read('dock.js');
    expect(dock).toContain('/api/local/catalog');
    expect(dock).toContain('/api/local/jobs');
    expect(dock).not.toContain("api('/api/local/models')");
    expect(page).toContain('切換會重新啟動 vLLM');
    // every role the server can emit needs wording here, or a row shows a blank badge
    const css = read('shell.css');
    for (const role of ROLES) {
      expect(dock, role).toMatch(new RegExp(`${role}: '`));
      expect(css, role).toContain(`.reco-tag.${role}`);
    }
  });

  it('ships the terminal drawer without a CDN and only for the allowlist', () => {
    const page = read('index.html');
    // no external scripts: xterm is committed under web/lib (this box is Wi-Fi only)
    expect(page).not.toMatch(/<script[^>]+src="https?:/);
    for (const f of ['xterm.js', 'xterm.css', 'addon-fit.js', 'LICENSE']) {
      expect(fs.existsSync(path.join(WEB_DIR, 'lib', 'xterm', f)), f).toBe(true);
    }
    const term = read('terminal.js');
    expect(term).toContain('/lib/xterm/xterm.js');
    expect(term).toContain('/api/terminal/ws');
    expect(term).toContain("e.code !== 'Backquote'");
    // the button starts hidden and the module is only imported after the access check
    expect(page).toMatch(/id="term-toggle" hidden/);
    expect(read('shell.js')).toContain("api('/api/terminal/access')");
    expect(read('shell.js')).toContain("import('./terminal.js')");
    expect(page).toContain('/terminal.css');
  });

  it('wires the 智慧調整參數 panel through events, never a cross-import', () => {
    const dock = read('dock.js');
    const chat = read('chat.js');
    expect(dock).toContain("new CustomEvent('loop-ask'");
    expect(chat).toContain("addEventListener('loop-ask'");
    expect(chat).toContain("new CustomEvent('loop-answer'");
    expect(dock).toContain("addEventListener('loop-answer'");
    expect(dock).not.toMatch(/from '\.\/chat\.js'/); // chat.js is a page script, not a library
    // the panel holds the whole answer, so it must pull the fence out before parsing (parseTune
    // itself takes only the JSON — feeding it the markdown silently yields "no suggestion")
    expect(dock).toContain('parseTuneMarkdown');
    // the panel looks the message up right after 'done', so the save must have settled first
    expect(chat).toMatch(/saveAnswer\(a, \{[\s\S]*?\),\s*\)\.then\(\(\) => announce\('done'/);
    expect(read('index.html')).toContain('智慧調整參數');
  });

  it('offers the model switcher, and never switches without asking', () => {
    const page = read('index.html');
    for (const id of ['model-switch', 'model-list', 'switch-state', 'spark-count']) {
      expect(page, `missing id="${id}"`).toContain(`id="${id}"`);
    }
    expect(page).toContain('切換會重新啟動 vLLM');
    const js = read('dock.js');
    expect(js).toContain('window.confirm'); // a switch takes minutes and kills the chat meanwhile
    expect(js).toContain('還有回答正在產生'); // and never mid-answer
    expect(js).toContain("e.action === 'switch'"); // one action per row, decided server-side
  });

  it('only declares a JSON body when it sends one', () => {
    // Fastify answers 400 to a request that says content-type: application/json and carries no
    // body — which is every DELETE this page makes (取消分享, 刪除對話). app.inject does not set
    // the header, so only a browser could catch this; the guard lives here instead.
    const js = read('shell.js');
    expect(js).toMatch(/opts\.body == null \? \{\} : \{ 'content-type': 'application\/json' \}/);
  });

  it('never loses the share link when the clipboard is unavailable', () => {
    const js = read('chat-actions.js');
    // creating the link and copying it are separate steps: a clipboard rejection (no permission,
    // insecure context, headless) must still leave the user holding the URL
    expect(js).toContain('async function copyQuiet');
    expect(js).toMatch(/copied \? '分享連結已建立並複製[^']*' : `分享連結已建立：\$\{r\.url\}`/);
    expect(js).not.toMatch(/await navigator\.clipboard\.writeText\(`\$\{location\.origin\}/);
  });

  it('ships the read-only share page, and it never offers a way to write', () => {
    expect(exists('share.html')).toBe(true);
    const js = read('share.js');
    expect(js).not.toMatch(/innerHTML/);
    expect(js).not.toMatch(/method: 'POST'/);
    expect(js).toContain('location.hash'); // the token travels in the fragment, not the path
    expect(read('share.html')).toContain('noindex');
  });

  it('the pages that are not part of CF-AOI operation are gone, server routes untouched', () => {
    for (const f of ['metrics.html', 'metrics.js', 'pipelines.html', 'pipelines.js', 'report.html', 'report.js', 'report.css', 'voice.html', 'voice.js', 'help.html', 'vendor']) {
      expect(exists(f), `${f} should have been removed`).toBe(false);
    }
  });
});
