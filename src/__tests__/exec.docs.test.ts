import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { lintPrd } from '../prd/lint.js';

describe('the manual documents the GPU 執行沙盒', () => {
  it('chapter 26b is in the TOC and covers setup, the chat gates, tasks and the verify prefix', () => {
    const manual = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', '操作說明.html'), 'utf8');
    expect(manual).toContain('<section id="sandbox">');
    expect(manual).toContain('href="#sandbox"');
    for (const s of ['loop exec check', 'exec_enabled', 'exec_allowed_users', 'NVreg_RestrictProfilingToAdminUsers=0', 'sandbox: ', '--network none', 'mcp__loop-exec__run']) {
      expect(manual, s).toContain(s);
    }
  });
});

describe('the manual documents the overnight flow', () => {
  it('chapter 26c is in the TOC and covers the remote host, Gitea, metrics, the night window and the morning report', () => {
    const manual = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', '操作說明.html'), 'utf8');
    expect(manual).toContain('<section id="overnight">');
    expect(manual).toContain('href="#overnight"');
    for (const s of [
      'loop exec host add',
      '--work-root',
      'loop exec check --host',
      'NVIDIA Container Toolkit',
      'sandbox@aoi-gpu:',
      'LOOP_METRICS',
      '## 驗收指標 (Metrics)',
      '## 保護路徑 (Protected)',
      'GITEA_TOKEN',
      'gitea_url',
      'local_task_window',
      'morning_report_time',
      '/morning.html',
      'loop morning',
      'exec_default_host',
    ]) {
      expect(manual, s).toContain(s);
    }
  });
});

describe('the PRD example in chapter 26c', () => {
  it('passes the PRD gate as written, with metrics, protected paths and the remote dataset host', () => {
    const manual = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', '操作說明.html'), 'utf8');
    const start = manual.indexOf('<pre><code># 修正 X 區亮缺陷判型');
    expect(start).toBeGreaterThan(0);
    const md = manual
      .slice(start + '<pre><code>'.length, manual.indexOf('</code></pre>', start))
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    const r = lintPrd(md, { exists: (p) => p === '/srv/repos/cf-aoi' });
    expect(r.missing).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.fields.verify_steps).toHaveLength(2);
    expect(r.fields.verify_steps.every((v) => v.startsWith('sandbox@aoi-gpu: '))).toBe(true);
    expect(r.fields.acceptance_metrics).toBe('detection_rate >= 0.98; false_positive_rate <= 0.01; miss == 0');
    expect(r.fields.protected_paths).toEqual(['scripts/eval/**', 'config/judge/**']);
    expect(r.fields.dataset?.host).toBe('aoi-gpu');
    expect(r.fields.base_branch).toBe('feature/bright-defect');
  });
});

describe('the manual documents the operator flow', () => {
  it('chapter 26d is in the TOC and walks a non-programmer through 工作流程 → 驗收 → 交付', () => {
    const manual = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', '操作說明.html'), 'utf8');
    expect(manual).toContain('<section id="operators">');
    expect(manual).toContain('href="#operators"');
    for (const s of [
      '/flow.html#new',
      '/task.html',
      '/plans.html',
      'loop verify-plan add',
      '{dataset}',
      '退回修改',
      '核可',
      '發佈到 Gitea',
      'SHA256SUMS',
      'artifacts_max_mb',
      'exec_allowed_users',
      '用工作流程重寫',
      '--artifacts',
    ]) {
      expect(manual, s).toContain(s);
    }
  });
});

describe('the manual documents 對話操作', () => {
  it('chapter 26e is in the TOC and names every ops setting, the confirmation rules and loop-ops', async () => {
    const { DEFAULT_SETTINGS } = await import('../config.js');
    const manual = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', '操作說明.html'), 'utf8');
    expect(manual).toContain('<section id="chatops">');
    expect(manual).toContain('href="#chatops"');
    const keys = Object.keys(DEFAULT_SETTINGS).filter((k) => k.startsWith('ops_') || k === 'git_clone_root');
    expect(keys.length).toBeGreaterThan(8);
    for (const s of [...keys, '確認 K7Q', 'loop-ops-mcp.mjs', 'LOOP_OPS_USER', '/api/ops/actions/:id/confirm', 'prd_repo_allowlist']) {
      expect(manual, s).toContain(s);
    }
  });
});

describe('the manual documents the one app frame, 模型快篩 and two Sparks', () => {
  const manual = () => fs.readFileSync(path.join(__dirname, '..', '..', 'docs', '操作說明.html'), 'utf8');

  it('chapter 5 describes the frame every page shares and the chat\'s four tabs', () => {
    const m = manual();
    for (const s of ['同一套版面', '你是 ○○', 'Alt+1～4', '需要你處理', '機台狀況', '/plans.html#vp_', '這次拿掉的重複功能']) expect(m, s).toContain(s);
    // the pages it used to describe are gone
    for (const s of ['圖示列第', 'Alt+1～7', '五步引導', '頂欄「＋ 新增 task」']) expect(m, s).not.toContain(s);
  });

  it('chapter 26 covers 模型快篩 (settings, CLI, API) and starting a model across two Sparks', async () => {
    const { DEFAULT_SETTINGS } = await import('../config.js');
    const m = manual();
    for (const k of ['bench_screen_questions', 'bench_screen_budget_min', 'local_spark_nodes']) {
      expect(DEFAULT_SETTINGS, k).toHaveProperty(k);
      expect(m, k).toContain(k);
    }
    for (const s of ['模型快篩', 'loop bench screen', '/api/benchmarks/screen', 'sg_…', '兩台 Spark', 'launch-cluster.sh stop', 'CLUSTER_NODES', 'cluster_only']) expect(m, s).toContain(s);
  });
});
