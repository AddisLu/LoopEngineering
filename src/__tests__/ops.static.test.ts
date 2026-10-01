import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const read = (f: string) => fs.readFileSync(path.join(WEB, f), 'utf8');

describe('operator pages: 驗收 / 驗證方案 / 晨報', () => {
  const pages = [
    ['task.html', 'task.js'],
    ['plans.html', 'plans.js'],
    ['morning.html', 'morning.js'],
  ] as const;

  it('the verdict banner kinds are not classes the board stylesheet owns (.progress is a 4px bar)', () => {
    const m = read('task.js').match(/const kind = \{([^}]*)\}\[b\.verdict\]/);
    expect(m).not.toBeNull();
    const kinds = [...m![1].matchAll(/:\s*'([a-z-]+)'/g)].map((x) => x[1]);
    expect(kinds).toHaveLength(4);
    const styles = read('styles.css');
    for (const k of kinds) expect(styles, k).not.toMatch(new RegExp(`(^|[,}]\\s*)\\.${k}(?![\\w-])`, 'm'));
    expect(styles).toMatch(/^\.progress \{/m); // the guard would catch the old 'progress' kind
  });

  it('render with textContent only (cheap XSS guard) and share ops.js / ops.css inside the app frame', () => {
    for (const js of ['ops.js', 'task.js', 'plans.js', 'morning.js']) expect(read(js), js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    for (const [html, js] of pages) {
      const h = read(html);
      expect(h, html).toContain('/theme-boot.js');
      // content styles load after the frame, so a page can refine a frame piece — never the other way round
      expect(h.indexOf('/styles.css'), html).toBeLessThan(h.indexOf('/frame.css'));
      expect(h.indexOf('/frame.css'), html).toBeLessThan(h.indexOf('/ops.css'));
      expect(h.indexOf('/ops.js'), html).toBeLessThan(h.indexOf(`/${js}`));
      // the places to go are the rail's (frame.js), not a nav of each page's own
      expect(h, html).not.toContain('ops-nav');
      expect(h, html).not.toContain('theme-btn');
    }
    // 驗收 is part of 總覽: the rail marks it, the top bar leads back
    expect(read('task.html')).toContain('data-nav="board"');
    expect(read('task.html')).toContain('<a class="crumb hide-sm" href="/board.html">總覽</a>');
  });

  it('ops.css only styles content: the frame owns the chrome, the view switch, toasts and .checks', () => {
    const css = read('ops.css').replace(/\/\*[\s\S]*?\*\//g, ''); // rules, not the comments naming them
    for (const sel of ['body.ops', '.ops-top', '.ops-nav', '.ops-brand', '.icon-btn', '.toast', '.seg', '.checks ']) expect(css, sel).not.toContain(sel);
    expect(css).not.toMatch(/^\.card\b/m); // the board owns .card (status rail); operator pages use .panel
    // the task checklist has its own name, so the flow's .checks in frame.css cannot restyle it
    expect(read('task.html')).toContain('class="checklist" id="checks"');
    expect(css).toContain('.checklist label');
  });

  it('/plans.html#vp_… opens that plan (the chat links there) and says so when it is gone', () => {
    const js = read('plans.js');
    expect(js).toMatch(/location\.hash/);
    expect(js).toContain('vp_');
    expect(js).toContain("addEventListener('hashchange'");
    expect(js).toContain('找不到驗證方案');
    // the chat's 查看 link points at exactly this
    expect(fs.readFileSync(path.join(WEB, '..', 'src', 'chatops', 'format.ts'), 'utf8')).toContain('/plans.html#');
  });

  it('are reachable from the app rail, the chat, the board and the morning report', () => {
    const index = read('index.html');
    // new work starts at 問題單; /job.html still forwards old links to 工作流程 with their prefill
    expect(index).toMatch(/href="\/fix\.html"/);
    expect(read('frame.js')).toContain("'/plans.html'");
    expect(read('board.html')).toMatch(/href="\/fix\.html"/);
    const job = read('job.html');
    expect(job).toContain("location.replace('/flow.html'");
    expect(job).toContain("'#new'");
    expect(job).toContain("q.get('token')"); // ?token= stays a real query; only the prefill rides in the hash
    const app = read('app.js');
    expect(app).toContain('/task.html?id=');
    expect(app).toContain('用工作流程重寫');
    expect(app).toMatch(/c\.status === 'failed'[\s\S]{0,500}\/restart/); // 重來 for failed, which the API always allowed
    expect(read('morning.js')).toContain('/task.html?id=');
  });

  it('downloads carry the token (a plain link cannot send the bearer) and the viewer name is URI-encoded', () => {
    const ops = read('ops.js');
    expect(ops).toContain('token=${encodeURIComponent(TOKEN)}');
    expect(ops).toContain("h['x-loop-user'] = encodeURIComponent(n)");
    expect(read('task.js')).toContain("withToken(`/api/tasks/${encodeURIComponent(id)}/artifacts.zip`)");
  });

  it('結果頁: a 問題單 reads like a PR, built with frame.js h()/fill(), and everything else renders as before', () => {
    const html = read('task.html');
    for (const id of ['review-card', 'checks-card', 'check-list', 'dataset-card', 'datasets', 'attempts-card', 'action-bar', 'act-merge', 'act-changes', 'act-owner', 'act-escalate', 'merge-dialog', 'close-issue', 'owner-dialog', 'log-drawer', 'case-drawer', 'analysis-card', 'images-card', 'prd-drawer']) {
      expect(html, id).toContain(`id="${id}"`);
    }
    // the new sections start hidden: a task without their data shows today's page
    for (const id of ['review-card', 'checks-card', 'dataset-card', 'attempts-card', 'action-bar', 'analysis-card', 'images-card']) {
      expect(html, id).toMatch(new RegExp(`id="${id}"[^>]*hidden`));
    }
    expect(html).toContain('<script type="module" src="/task.js"></script>');
    for (const copy of ['嘗試記錄', 'Loop 的自評', '交給同事…', '再試一次（換模型）', '退回修改…']) expect(html, copy).toContain(copy);
    const js = read('task.js');
    expect(js).toContain("import { h, fill } from './frame.js';");
    expect(js).toContain('if (!ticket) return; // anything else keeps today\'s layout exactly');
    // 看紀錄 reads the check run in one place; pictures come from the run's own files route
    expect(js.match(/\/api\/check-runs\/\$\{encodeURIComponent\(runId\)\}`/g)).toHaveLength(1);
    expect(js).toContain('/files/${ref.path.split(\'/\').map(encodeURIComponent).join(\'/\')}');
    for (const route of ['/approve', '/owner', '/escalate', '/request-changes']) expect(js, route).toContain(route);
    expect(js).toContain('close_issue');
    for (const copy of ['只看變化', '看紀錄', '看每張', '變好', '變差', '沒輸出', '在 Gitea 留言並關閉 issue #']) expect(js, copy).toContain(copy);
  });

  it('a hidden panel stays hidden even though panels set display (frame.css)', () => {
    expect(read('frame.css')).toMatch(/body\.app \[hidden\] \{ display: none !important; \}/);
    for (const [html] of pages) expect(read(html), html).toMatch(/<body class="app"/);
  });
});
