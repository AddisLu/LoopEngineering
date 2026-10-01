import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openTestDb } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { createRepo } from '../repo/store.js';
// the page modules are plain ESM that touch no DOM at import time
import { byName, csv, healthOf, machineLabel, normalizeRepoUrl, osLabel, shortRemote } from '../../web/repo-ui.js';
import { baselineText, datasetNameOf, metricsText, parseMetrics, runValues } from '../../web/checks.js';

/**
 * The Repo page (/repos.html, its 檢查 tab from checks.js) and the 機台 page (/machines.html): the
 * one route this link adds, the static structure the pages' scripts depend on, and the pure
 * helpers the pages render with.
 */

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
const read = (f: string) => fs.readFileSync(path.join(WEB, f), 'utf8');

describe('Repo and 機台 pages: static structure', () => {
  const pages = [
    ['repos.html', 'repos.js', 'repos'],
    ['machines.html', 'machines.js', 'machines'],
  ] as const;

  it('sit in the app frame like the other converted pages: rail, top bar, 你是, load order', () => {
    for (const [html, js, nav] of pages) {
      const p = read(html);
      expect(p, html).toContain(`<body class="app" data-nav="${nav}">`);
      expect(p, html).toContain('<nav id="app-rail" class="app-rail">');
      expect(p, html).toContain('<header class="app-top">');
      expect(p, html).toContain('id="ops-who"');
      expect(p, html).toContain('/theme-boot.js');
      // styles.css → frame.css → the pages' own sheet; ops.js before the page module; frame-boot last
      expect(p.indexOf('/styles.css'), html).toBeLessThan(p.indexOf('/frame.css'));
      expect(p.indexOf('/frame.css'), html).toBeLessThan(p.indexOf('/repos.css'));
      expect(p.indexOf('/ops.js'), html).toBeLessThan(p.indexOf(`/${js}`));
      expect(p, html).toMatch(new RegExp(`<script type="module" src="/${js}"></script>\\s*<script type="module" src="/frame-boot.js"></script>`));
      // the rail owns the places to go and the theme toggle
      expect(p, html).not.toContain('theme-btn');
      expect(p, html).not.toContain('ops-nav');
    }
  });

  it('the Repo page: the list, the three-step import dialog and the four tabs', () => {
    const p = read('repos.html');
    for (const id of [
      'view-list', 'list-lead', 'repo-list', 'import-running', 'repo-empty', 'import-btn', 'empty-import-btn',
      'import-dialog', 'imp-steps', 'imp-url', 'imp-progress', 'imp-fail', 'imp-name', 'imp-branch', 'imp-machine', 'imp-detected', 'imp-go', 'imp-bg', 'imp-retry', 'imp-done',
      'view-detail', 'repo-tabs', 'repo-pill', 'tab-settings', 'tab-checks', 'tab-datasets', 'tab-fixes',
      'settings-form', 'set-name', 'set-domain', 'set-remote', 'set-path', 'set-branch', 'set-prbase', 'set-machine', 'set-cloud',
      'set-build', 'set-test', 'set-setup', 'redetect-btn', 'map-btn', 'map-status', 'set-issue-on', 'set-issue-label', 'set-issue-comments', 'delete-btn',
    ]) {
      expect(p, `missing id="${id}"`).toContain(`id="${id}"`);
    }
    // the spec's tab order; 檢查 opens when none is asked for
    expect([...p.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1])).toEqual(['settings', 'checks', 'datasets', 'fixes']);
    for (const step of ['貼上網址', '偵測', '確認']) expect(p).toContain(`<span>${step}</span>`);
    expect(p).toContain('還沒有 repo。貼上 Gitea 的網址就能開始。');
    expect(p).toContain('偵測不到的之後可在 Repo 設定補');
    const js = read('repos.js');
    expect(js).toContain("openTab(TABS.includes(want) ? want : 'checks')");
    for (const route of ["'/api/repos'", "'/api/repos/import'", '/api/repos/import/${', '/redetect`', '/fixes`', "'/api/machines'", "'/api/settings'"]) expect(js, route).toContain(route);
    // the checks tab reads the current row even after a settings save replaced it
    expect(js).toMatch(/get repo\(\) \{\s*return cur;/);
  });

  it('checks.js: five kinds plus 人工, thresholds picked only from a 試跑, the command-line-entry ticket', () => {
    const js = read('checks.js');
    for (const k of ['建置', '測試', '重現腳本', '圖資回歸', '自訂', '人工']) expect(js, k).toContain(`'${k}']`);
    expect(js).toContain('還沒有檢查。先加一個建置或測試檢查；之後每張問題單都會跑它們。');
    expect(js).toContain('用偵測到的指令建立');
    expect(js).toContain('先按「試跑一次」');
    expect(js).toContain('這個 repo 還沒有命令列入口，圖資回歸無法自動跑');
    expect(js).toContain('/fix.html?repo=${enc(repo.id)}&template=cli-entry');
    expect(js).toContain('設為基準');
    expect(js).toContain('＋ 連結圖資 repo');
    // a threshold is a chip from what the run printed — there is no free-text metric-name input
    expect(js).not.toMatch(/placeholder: '[a-z_]+_rate'/);
    // every request goes through the one module the integrator reconciles with the checks routes
    expect(js).not.toMatch(/\bapi\(/);
    expect(js).toContain("from './checks-api.js'");
    const apiJs = read('checks-api.js');
    for (const route of ['/checks`', '/checks/reorder`', '/checks/from-detected`', '/trial`', '/api/check-runs/', '/baseline`', '/runs`', "'/api/datasets'", '/api/datasets/${']) {
      expect(apiJs, route).toContain(route);
    }
  });

  it('the 機台 page: the table, add / edit, the health lines and the collapsed read-only sandbox hosts', () => {
    const p = read('machines.html');
    for (const id of [
      'machine-table', 'machine-rows', 'machine-empty', 'add-btn', 'empty-add-btn', 'machine-detail', 'sandbox-box', 'sandbox-list', 'sandbox-count',
      'machine-dialog', 'machine-form', 'md-name', 'md-ssh', 'md-port', 'md-os', 'md-shell', 'md-root', 'md-labels', 'md-desc', 'md-lines', 'md-check', 'md-save',
    ]) {
      expect(p, `missing id="${id}"`).toContain(`id="${id}"`);
    }
    expect([...p.matchAll(/<th scope="col"[^>]*>([^<]*)</g)].map((m) => m[1]).slice(0, 6)).toEqual(['名稱', 'SSH', '作業系統', '標籤', '狀態', '用它的 repo']);
    expect(p).toContain('還沒有機台。加一台能 SSH 進去、裝了 git 的電腦。');
    expect(p).toContain('GPU 沙盒主機（進階）');
    expect(p).toContain('<details class="mc-sandbox" id="sandbox-box">'); // collapsed until opened
    for (const v of ['auto', 'linux', 'windows', 'bash', 'powershell', 'cmd']) expect(p).toContain(`<option value="${v}">`);
    const js = read('machines.js');
    expect(js).toContain("'/api/machines'");
    expect(js).toContain('/check`');
    expect(js).toContain('checkLine');
  });

  it('the rail: Repo right after 總覽, 機台 as a minor page, each with its icon', () => {
    const frame = read('frame.js');
    expect(frame).toContain("['repos', 'Repo', '/repos.html', 'branch'],");
    expect(frame).toContain("['machines', '機台', '/machines.html', 'server', 'minor'],");
    expect(frame.indexOf("['board',")).toBeLessThan(frame.indexOf("['repos',"));
    expect(frame.indexOf("['repos',")).toBeLessThan(frame.indexOf("['machines',"));
    for (const ic of ['branch', 'server', 'okCircle', 'xCircle', 'warnTri', 'grip']) expect(frame, ic).toMatch(new RegExp(`^\\s*${ic}: \\[`, 'm'));
  });

  it('build every string as text, and colour only with the theme tokens (dark mode follows styles.css)', () => {
    for (const f of ['repos.js', 'checks.js', 'checks-api.js', 'machines.js', 'repo-ui.js']) {
      const src = read(f);
      for (const bad of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) expect(src, `${f} uses ${bad}`).not.toContain(bad);
    }
    const css = read('repos.css').replace(/\/\*[\s\S]*?\*\//g, '');
    // the switch knob, and the log console that is dark in both modes (like ops.css .console)
    expect(new Set([...css.matchAll(/#[0-9a-f]{3,8}\b/gi)].map((m) => m[0].toLowerCase()))).toEqual(new Set(['#fff', '#1f1c18', '#efe8dc', '#9fd6b3']));
    expect(css).toContain('@media (max-width: 820px)'); // the frame's phone width
  });
});

describe('the helpers the pages render with', () => {
  it('turns a Gitea page URL into the repo URL, and leaves anything else as pasted', () => {
    expect(normalizeRepoUrl(' http://gitea.corp:3000/aoi/cf-aoi/issues/12 ')).toBe('http://gitea.corp:3000/aoi/cf-aoi');
    expect(normalizeRepoUrl('http://gitea.corp:3000/aoi/cf-aoi/src/branch/main/src/a.cpp')).toBe('http://gitea.corp:3000/aoi/cf-aoi');
    expect(normalizeRepoUrl('https://gitea.corp/aoi/cf-aoi.git/pulls/3')).toBe('https://gitea.corp/aoi/cf-aoi');
    for (const same of ['http://gitea.corp:3000/aoi/cf-aoi', 'http://gitea.corp:3000/aoi/cf-aoi.git', 'git@gitea.corp:aoi/cf-aoi.git', 'ssh://git@gitea.corp:2222/aoi/cf-aoi']) {
      expect(normalizeRepoUrl(same)).toBe(same);
    }
    expect(shortRemote('http://gitea.corp:3000/aoi/cf-aoi.git')).toBe('aoi/cf-aoi');
    expect(shortRemote('git@gitea.corp:aoi/cf-aoi')).toBe('aoi/cf-aoi');
    expect(csv(' tests/**, datasets/** ,,\n build/*.log ')).toBe('tests/**,datasets/**,build/*.log');
  });

  it('names a machine and its health the way the 機台 table does', () => {
    const at = new Date(Date.now() - 10 * 60_000).toISOString();
    const win = { name: 'aoi-1', os: 'windows', enabled: 1, last_check_ok: 1, last_check_at: at, last_check: [{ ok: true, label: 'SSH 登入', detail: 'aoi@aoi-1（Windows 11，PowerShell 5.1）' }] };
    const down = { name: 'aoi-3', os: 'windows', enabled: 1, last_check_ok: 0, last_check_at: at, last_check: [{ ok: false, label: 'SSH 登入', detail: '無法以金鑰登入' }] };
    const noGit = { name: 'lab-2', os: 'linux', enabled: 1, last_check_ok: 0, last_check_at: at, last_check: [{ ok: true, label: 'SSH 登入', detail: 'loop@lab-2（Linux，bash）' }, { ok: false, label: 'git', detail: '找不到 git' }] };
    const fresh = { name: 'new-1', os: 'auto', enabled: 1, last_check_ok: null, last_check_at: null, last_check: null };
    expect(osLabel(win)).toBe('Windows 11');
    expect(osLabel(noGit)).toBe('Linux');
    expect(osLabel(fresh)).toBe('自動偵測');
    expect(healthOf(win)).toEqual({ state: 'ok', text: '正常', when: '10 分鐘前' });
    expect(healthOf(down)).toMatchObject({ state: 'bad', text: '連不上' });
    expect(healthOf(noGit)).toMatchObject({ state: 'bad', text: '有問題' });
    expect(healthOf(fresh)).toMatchObject({ state: 'none', text: '未檢查' });
    expect(healthOf({ ...win, enabled: 0 })).toMatchObject({ state: 'off', text: '已停用' });
    const machines = byName([win, fresh]);
    expect(machineLabel(null, machines)).toBe('引擎主機（這台 Spark）');
    expect(machineLabel('aoi-1', machines)).toBe('aoi-1（Windows 11）');
    expect(machineLabel('new-1', machines)).toBe('new-1');
    expect(machineLabel('gone', machines)).toBe('gone（找不到這台機台）');
    expect(machineLabel('sandbox:local', machines)).toBe('GPU 沙盒 local（舊版方案）');
  });

  it('reads thresholds, run metrics and baselines the way the check editor shows them', () => {
    expect(parseMetrics('correct_rate >= 0.987; time_ms<=5300\nbogus; x > y')).toEqual([
      { name: 'correct_rate', op: '>=', target: '0.987' },
      { name: 'time_ms', op: '<=', target: '5300' },
    ]);
    expect(metricsText([{ name: 'correct_rate', op: '>=', target: '0.987' }, { name: 'time_ms', op: '<=', target: '' }, { name: 'total', op: '==', target: '1204' }])).toBe('correct_rate >= 0.987; total == 1204');
    expect(runValues({ metrics_json: JSON.stringify({ values: { correct_rate: 0.987, time_ms: 5100 }, pass: true }) })).toEqual({ correct_rate: 0.987, time_ms: 5100 });
    expect(runValues({ metrics_json: '{"total": 1204, "note": "x"}' })).toEqual({ total: 1204 });
    expect(runValues({ metrics_json: 'not json' })).toEqual({});
    // GET /api/check-runs/:id sends metrics_json parsed, as `metrics`
    expect(runValues({ metrics: { values: { correct_rate: 0.99, mismatches: 3 }, pass: true } })).toEqual({ correct_rate: 0.99, mismatches: 3 });
    expect(datasetNameOf('http://gitea.corp:3000/aoi/dataset-2026Q2.git/')).toBe('dataset-2026Q2');
    expect(datasetNameOf('ssh://gitea.corp:2222/aoi/圖資 Q3')).toBe('圖資-Q3');
    expect(baselineText({ sha: '3f2a1c9e', values: { correct_rate: 0.987, time_ms: 5100 } })).toBe('基準：正確率 98.7%，5.1 s（@ 3f2a1c9）');
  });
});

describe('GET /api/repos/:id/fixes (the 過去修法 tab)', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  beforeEach(async () => {
    db = openTestDb();
    app = buildApp({ db, apiToken: null });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  const add = (repoId: string, taskId: string, title: string, outcome: string, at: string, extra: { files?: string; model?: string | null } = {}) =>
    db
      .prepare('INSERT INTO fix_ledger (repo_id, task_id, title, symptom, files, summary, outcome, model, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(repoId, taskId, title, `${title}的症狀`, extra.files ?? '', '', outcome, extra.model ?? null, 1, at);

  it('lists this repo\'s past fixes newest first, with the fields the tab shows', async () => {
    const repo = createRepo(db, { name: 'cf-aoi', remote_url: 'http://gitea.corp:3000/aoi/cf-aoi', local_path: '/srv/repos/cf-aoi' });
    const other = createRepo(db, { name: 'cf-aoi-ui', remote_url: 'http://gitea.corp:3000/aoi/cf-aoi-ui', local_path: '/srv/repos/cf-aoi-ui' });
    add(repo.id, 't_old', '第二次載入 recipe 沒生效', 'returned', '2026-09-01 10:00:00', { model: 'local:glm53-flash' });
    add(repo.id, 't_new', '邊緣檢出漏報', 'merged', '2026-09-20 10:00:00', { files: 'src/edge.cpp\nsrc/edge.h', model: 'local:qwen3-coder-next' });
    add(other.id, 't_ui', '別的 repo 的修法', 'merged', '2026-09-25 10:00:00');

    const res = await app.inject({ method: 'GET', url: `/api/repos/${repo.id}/fixes` });
    expect(res.statusCode).toBe(200);
    const { fixes } = res.json();
    expect(fixes.map((f: { title: string }) => f.title)).toEqual(['邊緣檢出漏報', '第二次載入 recipe 沒生效']);
    expect(fixes[0]).toMatchObject({
      repo_id: repo.id,
      task_id: 't_new',
      outcome: 'merged',
      files: 'src/edge.cpp\nsrc/edge.h',
      model: 'local:qwen3-coder-next',
      symptom: '邊緣檢出漏報的症狀',
      created_at: '2026-09-20 10:00:00',
    });
    // a limit for a long history; nonsense falls back to the default
    expect((await app.inject({ method: 'GET', url: `/api/repos/${repo.id}/fixes?limit=1` })).json().fixes).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: `/api/repos/${repo.id}/fixes?limit=abc` })).json().fixes).toHaveLength(2);
    // a repo with no history is an empty list, not an error
    expect((await app.inject({ method: 'GET', url: `/api/repos/${other.id}/fixes` })).json().fixes).toHaveLength(1);
  });

  it('404s for a repo that is not registered', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/repos/r_nope/fixes' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('沒有這個 repo');
  });
});
