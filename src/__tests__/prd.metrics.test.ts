import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { lintPrd, sectionKey } from '../prd/lint.js';
import { submitPrd } from '../prd/intake.js';
import { getBenchmark } from '../benchmark/store.js';
import { getTask } from '../tasks.js';

let repo: string;
beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-prd-metrics-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# r\n');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
});
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

let db: Database.Database;
beforeEach(() => {
  db = openTestDb();
});
afterEach(() => db.close());

/** An overnight algorithm PRD: dataset on the aoi-gpu sandbox host, engine-checked metrics. */
const prd = (over: Partial<Record<'verify' | 'metrics' | 'protected' | 'dataset', string>> = {}) => `# 亮缺陷判型修正

## 目標 (Goal)
修正 X 區亮缺陷被誤判為暗缺陷的問題，並維持其他缺陷的檢出結果不變。

## 範圍 (Scope)
- ip/src/classify.cu 的亮暗判型門檻

## 非範圍 (Non-goals)
- 不改 recipe 格式

## 驗收標準 (Acceptance)
- [ ] Given 20260615 圖集 When 跑評估 Then 判型正確

## 驗證指令 (Verify)
${over.verify ?? '```bash\nsandbox@aoi-gpu: python3 scripts/eval/run_eval.py --images /datasets/20260615 --golden /golden/20260615\n```'}

## 圖集比對 (Dataset)
${over.dataset ?? '- 主機: aoi-gpu\n- 輸入圖集: /datasets/20260615\n- 期望結果: /golden/20260615\n- 門檻: 見驗收指標'}

## 驗收指標 (Metrics)
${over.metrics ?? '- detection_rate >= 0.98\n- false_positive_rate ≤ 0.01\n- `miss == 0`'}

## 保護路徑 (Protected)
${over.protected ?? '- scripts/eval/**\n- `recipes/*.json`'}

## Repo
- path: ${repo}
- branch: main

## 領域 (Domain)
cuda

## 複雜度 (Complexity)
M
`;

describe('PRD sections for overnight verification', () => {
  it('headings resolve to their own sections, and 驗收標準 still means acceptance', () => {
    expect(sectionKey('驗收指標 (Metrics)')).toBe('metrics');
    expect(sectionKey('保護路徑 (Protected)')).toBe('protected');
    expect(sectionKey('驗收標準 (Acceptance)')).toBe('acceptance');
    expect(sectionKey('人工驗收 (Manual checks)')).toBe('manual');
  });

  it('extracts normalised metrics, protected globs, and a remote dataset host without statting its paths', () => {
    const r = lintPrd(prd());
    expect(r.missing).toEqual([]);
    expect(r.fields.acceptance_metrics).toBe('detection_rate >= 0.98; false_positive_rate <= 0.01; miss == 0');
    expect(r.fields.protected_paths).toEqual(['scripts/eval/**', 'recipes/*.json']);
    expect(r.fields.dataset).toMatchObject({ host: 'aoi-gpu', input: '/datasets/20260615' }); // not on this machine: no "路徑不存在"
    expect(r.fields.verify_steps[0]).toMatch(/^sandbox@aoi-gpu: /);
    expect(r.warnings.join()).not.toContain('sandbox@aoi-gpu');
  });

  it('blocks unreadable metrics, metrics nothing measures, and absolute protected paths; warns about an unused host', () => {
    expect(lintPrd(prd({ metrics: '- 檢出率要高' })).missing.join()).toContain('「驗收指標」看不懂');
    expect(lintPrd(prd({ verify: '', dataset: '- 輸入圖集: /tmp' })).missing.join()).toContain('LOOP_METRICS');
    expect(lintPrd(prd({ protected: '- /etc/passwd' })).missing.join()).toContain('保護路徑');
    const noStep = lintPrd(prd({ verify: '```bash\npython3 scripts/eval/run_eval.py\n```' }));
    expect(noStep.warnings.join()).toContain('sandbox@aoi-gpu:');
    // a local dataset keeps the old existence check
    expect(lintPrd(prd({ dataset: '- 輸入圖集: /definitely/not/here' })).missing.join()).toContain('圖集路徑不存在');
  });

  it('submit carries metrics and protected paths onto the task, without a local gpu requirement for a remote set', async () => {
    const r = await submitPrd(db, prd(), { model: 'local:qwen3-coder-next' });
    expect(r.ok).toBe(true);
    if (!r.ok || r.kind !== 'task') throw new Error('expected a task');
    const t = getTask(db, r.task.id)!;
    expect(t.acceptance_metrics).toBe('detection_rate >= 0.98; false_positive_rate <= 0.01; miss == 0');
    expect(t.protected_paths).toBe('scripts/eval/**,recipes/*.json');
    expect(t.requires).toBeNull();
    expect(t.verify_rubric).toContain('驗收指標（引擎自動檢查）：detection_rate >= 0.98');
    expect(JSON.parse(t.verification_steps)[0]).toMatch(/^sandbox@aoi-gpu: /);
  });

  it('every benchmark arm is held to the same bar', async () => {
    const r = await submitPrd(db, prd(), { benchmark_models: ['local:qwen3-coder-next', 'sonnet'] });
    if (!r.ok || r.kind !== 'benchmark') throw new Error('expected a benchmark');
    const arms = getBenchmark(db, r.benchmark.id)!.arms;
    expect(arms).toHaveLength(2);
    for (const a of arms) expect(getTask(db, a.task_id)!.acceptance_metrics).toContain('miss == 0');
  });
});
