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
  it('chapter 26d is in the TOC and walks a non-programmer through 新工作 → 驗收 → 交付', () => {
    const manual = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', '操作說明.html'), 'utf8');
    expect(manual).toContain('<section id="operators">');
    expect(manual).toContain('href="#operators"');
    for (const s of [
      '/job.html',
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
      '用新工作重寫',
      '--artifacts',
    ]) {
      expect(manual, s).toContain(s);
    }
  });
});
