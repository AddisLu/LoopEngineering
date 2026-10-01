import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// 問題單 (/fix.html): the page the four-step engineer flow starts on. It sits in the app frame like
// every other page, renders with textContent only, and reaches the server through one module
// (tickets-api.js) so the /api/tickets contract has a single place to change.
const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const read = (f: string) => fs.readFileSync(path.join(WEB, f), 'utf8');

describe('問題單 page (/fix.html)', () => {
  const html = read('fix.html');
  const js = read('fix.js');
  const api = read('tickets-api.js');
  const css = read('fix.css');

  it('is a page of the app frame: body.app, the rail, 你是, frame.css, scripts in order', () => {
    expect(html).toMatch(/<body class="app(?: [\w-]+)*" data-nav="fix">/);
    expect(html).toContain('<nav id="app-rail" class="app-rail">');
    expect(html).toContain('<span class="ops-who" id="ops-who"></span>');
    expect(html).toContain('/theme-boot.js');
    const [styles, frame, fix] = ['/styles.css', '/frame.css', '/fix.css'].map((c) => html.indexOf(`href="${c}"`));
    expect(styles).toBeGreaterThan(0);
    expect(frame).toBeGreaterThan(styles);
    expect(fix).toBeGreaterThan(frame); // page styles refine the frame, never the other way round
    const ops = html.indexOf('<script src="/ops.js"></script>');
    const page = html.indexOf('<script type="module" src="/fix.js"></script>');
    const boot = html.indexOf('<script type="module" src="/frame-boot.js"></script>');
    expect(ops).toBeGreaterThan(0);
    expect(page).toBeGreaterThan(ops);
    expect(boot).toBeGreaterThan(page);
  });

  it('has every element fix.js paints into', () => {
    for (const id of [
      'title', 'status-pill', 'back-sm', 'page-err', 'summary', 'form-card', 't-title', 't-desc', 'link-row', 'import-card',
      'shots-field', 'thumbs', 'drop', 'drop-title', 'file-input', 'form-foot', 'progress-card', 'failed-card', 'approval-banner',
      'card', 'card-head', 'sec-causes', 'sec-repro', 'sec-checks', 'sec-cond', 'sec-questions', 'foot', 'recent', 'recent-list',
      'fix-cols', 'fix-scroll', 'props', 'props-toggle', 'props-sum', 'props-body', 'p-repo', 'p-repo-note', 'p-branch', 'p-kind',
      'p-kind-note', 'p-machine', 'p-model-row', 'p-model', 'p-priority', 'p-source', 'p-shots', 'plan-scrim', 'plan-drawer', 'plan-md', 'plan-close',
    ]) {
      expect(html, `missing id="${id}"`).toContain(`id="${id}"`);
    }
    const built = new Set(['reject-text', 'cause-path']); // inputs fix.js creates itself
    for (const m of js.matchAll(/\$\('([\w-]+)'\)/g)) if (!built.has(m[1]!)) expect(html, `fix.js paints into #${m[1]}`).toContain(`id="${m[1]}"`);
    for (const id of built) expect(js).toContain(`id: '${id}'`);
  });

  it('renders with textContent only (cheap XSS guard)', () => {
    for (const [f, src] of [['fix.js', js], ['tickets-api.js', api]] as const) {
      for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) expect(src, `${f} uses ${bad}`).not.toContain(bad);
    }
    expect(js).toContain("from './frame.js'"); // h() / fill(): strings become text nodes
  });

  it('reaches the server only through tickets-api.js, which goes through api()', () => {
    expect(js).toContain("from './tickets-api.js'");
    expect(js).not.toMatch(/\bfetch\(/);
    expect(js).not.toContain('/api/');
    expect(js).not.toMatch(/\bapi\(/);
    expect(api).not.toMatch(/\bfetch\(/);
    expect(api).toContain("import { api, withToken } from './frame.js'");
    for (const route of ["'/api/tickets'", '/api/tickets?mine=1', "'/analyse'", "'/start'", "'/approve-start'", "'/reject-start'", "'/cancel'", "'/plan'", '/images/', "'/api/tickets/resolve-link'", "'/api/repos'", "'/api/machines'", "'/api/local/models'"]) {
      expect(api, `tickets-api.js never calls ${route}`).toContain(route);
    }
    // the Repo page opens its import dialog from ?import=, and its checks tab from ?id=&tab=checks
    expect(api).toContain('/repos.html?import=');
    expect(api).toContain('&tab=checks');
  });

  it('says what the design says', () => {
    expect(html).toContain('placeholder="發生什麼事、在哪裡、期望應該怎樣。可以直接貼：錯誤訊息、螢幕截圖（Ctrl+V）、Gitea 的 issue 或 repo 連結。"');
    expect(html).toContain('貼上或拖進截圖');
    for (const copy of [
      '請 Loop 分析', '先存草稿', '描述滿 10 字、repo 匯入後，「請 Loop 分析」才會亮', '這個 repo 還沒匯入 Loop。匯入需要一次（約 1 分鐘）。', '＋ 匯入 Repo…',
      '由 Loop 依領域挑', '可能原因與位置', '重現方式', '有現成的重現指令', '請 Loop 先寫一個會失敗的測試', '修改前必須失敗', '— 正確，可以拿來當紅燈',
      '可能重現不了', '驗收清單', '管理這個 repo 的檢查', '執行條件', 'Loop 還不確定', '回答', '開始修', '送出核可', '取消', '看需求文件',
      '已送出，等主管核可後才會開始', '核可', '退回', '重試', '改成手動填寫', '看進度', '展開', '改一下',
      '請幫這個 repo 加一個命令列入口：給一個圖片資料夾，把判定結果寫成檔案（每張一行：檔名、OK/NG），讓圖資回歸可以自動跑。',
    ]) {
      expect(js, `fix.js lost 「${copy}」`).toContain(copy);
    }
    expect(html).toContain('最近的問題單');
  });

  it('polls every 3 s while Loop analyses, and shrinks up to 6 screenshots to 1600 px like the chat', () => {
    expect(js).toMatch(/const POLL_MS = 3000;/);
    expect(js).toMatch(/const MAX_IMAGES = 6;/);
    expect(js).toMatch(/const MAX_EDGE = 1600;/);
    expect(js).toContain("addEventListener('paste'");
    expect(js).toContain("addEventListener('drop'");
  });

  it('works on a phone and in dark mode', () => {
    expect(js).toContain("matchMedia('(max-width: 820px)')"); // 屬性 moves under the description
    expect(css).toContain('@media (max-width: 820px)');
    expect(css).toMatch(/\.fx-foot \{ position: fixed;[^}]*bottom: 64px;/); // the action bar sits on the tab bar
    // colours come from the styles.css tokens, which [data-mode="dark"] swaps
    expect(css.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('is 問題單 in the rail, in 工作流程\'s place; new work starts here and /flow.html stays', () => {
    const frame = read('frame.js');
    expect(frame).toContain("['fix', '問題單', '/fix.html', 'ticket']");
    expect(frame).not.toContain("['flow', '工作流程'");
    expect(frame).toMatch(/\n {2}ticket: \[/); // its icon
    expect(fs.existsSync(path.join(WEB, 'flow.html'))).toBe(true);
    for (const page of ['index.html', 'board.html']) {
      expect(read(page), page).toContain('href="/fix.html">＋ 新問題單</a>');
      expect(read(page), page).not.toContain('＋ 新工作流程');
    }
    expect(read('morning.js')).toContain("a.href = '/fix.html';");
  });
});

describe('from the chat to a 問題單', () => {
  it('the composer chip and 轉成任務 → 開問題單 hand off through sessionStorage, never the URL', () => {
    const hand = read('fix-handoff.js');
    expect(hand).toContain('sessionStorage.setItem(HANDOFF_KEY');
    expect(hand).toContain("window.open('/fix.html?handoff=1', '_blank')");
    expect(hand).not.toMatch(/window\.open\([^)]*noopener/); // the new tab needs the copy of this tab's sessionStorage
    expect(hand).not.toMatch(/encodeURIComponent\(\s*description/);
    expect(read('index.html')).toContain('id="ticket-chip"');
    expect(read('chat.js')).toContain('openTicket({ description:');
    const actions = read('chat-actions.js');
    expect(actions).toContain("['ticket', '開問題單'");
    expect(actions).not.toContain("fix: '開工作流程 ↗'");
    const fix = read('fix.js');
    expect(fix).toContain("params.get('handoff') ? takeHandoff() : null");
    expect(fix).not.toMatch(/innerHTML/);
  });
});
