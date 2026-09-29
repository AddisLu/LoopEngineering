import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const read = (f: string) => fs.readFileSync(path.join(WEB, f), 'utf8');

describe('operator pages: 新工作 / 驗收 / 驗證方案', () => {
  const pages = [
    ['job-classic.html', 'job.js'],
    ['task.html', 'task.js'],
    ['plans.html', 'plans.js'],
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

  it('render with textContent only (cheap XSS guard) and share ops.js / ops.css', () => {
    for (const js of ['ops.js', 'job.js', 'task.js', 'plans.js']) expect(read(js), js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
    for (const [html, js] of pages) {
      const h = read(html);
      expect(h, html).toContain('/theme-boot.js');
      expect(h, html).toContain('/styles.css');
      expect(h, html).toContain('/ops.css');
      expect(h.indexOf('/ops.js'), html).toBeLessThan(h.indexOf(`/${js}`));
      // every page offers the same four places
      for (const href of ['/flow.html#new', '/morning.html', '/board.html', '/plans.html']) expect(h, `${html} → ${href}`).toContain(`href="${href}"`);
    }
  });

  it('are reachable from the chat rail, the board and the morning report', () => {
    const index = read('index.html');
    // 新工作 is the start of 工作流程 now; /job.html forwards there with its prefill
    expect(index).toMatch(/href="\/flow\.html#new"/);
    expect(index).toMatch(/href="\/plans\.html"/);
    expect(read('board.html')).toMatch(/href="\/flow\.html#new"/);
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

  it('a hidden panel stays hidden even though panels set display (styles.css / ops.css)', () => {
    const css = read('ops.css');
    expect(css).toMatch(/body\.ops \[hidden\] \{ display: none !important; \}/);
    expect(css).not.toMatch(/^\.card\b/m); // the board owns .card (status rail); operator pages use .panel
    expect(css).toMatch(/body\.ops \{[^}]*display: block/);
  });
});
