import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, getTask } from '../tasks.js';
import { writeTaskFile } from '../orchestrator/prompt.js';
import { attachmentsFor, machineLinesFor, repoMapFor, similarFixesFor } from '../intake/context.js';
import { buildProposePrompt } from '../intake/analyse.js';
import { machineBoxLines } from '../intake/context.js';

let db: Database.Database;
let dir: string;

beforeEach(() => {
  db = openTestDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-ctx-'));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const base = { title: '第二次載入沒生效', goal: 'bypass_edge_x 第二次載入沒套用', plan_ref: 'https://example.com/p.md', coding_tool: 'mock', verification_steps: ['true', 'check:ck_1'] };

describe('LOOP_TASK.md for a ticket', () => {
  it('a task that is not a ticket gets exactly the same file as before', () => {
    const t = createTask(db, { ...base, verification_steps: ['true'] });
    const plain = fs.readFileSync(writeTaskFile(dir, t), 'utf8');
    const withNulls = fs.readFileSync(
      writeTaskFile(dir, t, { attachments: attachmentsFor(t), repoMap: repoMapFor(db, t), similarFixes: similarFixesFor(db, t), reproBefore: null, checks: null, machines: machineLinesFor(db, t) }),
      'utf8',
    );
    expect(withNulls).toBe(plain);
    expect(plain).not.toContain('## 附件');
  });

  it('adds screenshots, the repo map (flag), past fixes (flag), repro output and the checks', () => {
    const img = path.join(dir, 'shot.png');
    fs.writeFileSync(img, 'png');
    const map = path.join(dir, 'r_1.md');
    fs.writeFileSync(map, `# Repo 地圖 — cf-aoi @ abc\n\n- 語言：C++ 62%\n${'- src/x.cpp: f():1\n'.repeat(400)}`);
    db.prepare("INSERT INTO repos (id, name, remote_url, local_path, map_path) VALUES ('r_1', 'cf-aoi', 'http://g/aoi/cf-aoi', '/tmp/x', ?)").run(map);
    db.prepare("INSERT INTO fix_ledger (repo_id, task_id, title, symptom, files, summary, outcome) VALUES ('r_1', 't_old', '載入沒生效的舊問題', 'bypass_edge_x', 'src/control/recipe_loader.cpp', 'guard removed', 'merged')").run();
    const t0 = createTask(db, base);
    db.prepare('UPDATE tasks SET repo_id = ?, images_json = ? WHERE id = ?').run('r_1', JSON.stringify([{ file: img, text: 'LOAD_RECIPE OK' }, { file: '/nope.png' }]), t0.id);
    const t = getTask(db, t0.id)!;

    expect(repoMapFor(db, t)).toBeNull(); // flags off
    expect(similarFixesFor(db, t)).toBeNull();
    setSetting(db, 'repo_map_inject', 'true');
    setSetting(db, 'fix_ledger_inject', 'true');
    setSetting(db, 'repo_map_budget_chars', '2000');
    const mapText = repoMapFor(db, t)!;
    expect(mapText.length).toBeLessThan(2100);
    expect(mapText).toContain('…（其餘省略）');

    const body = fs.readFileSync(
      writeTaskFile(dir, t, {
        attachments: attachmentsFor(t),
        repoMap: mapText,
        similarFixes: similarFixesFor(db, t),
        reproBefore: 'FAILED tests/test_recipe_reload.py::test_second_load',
        checks: ['- [必過] 單元測試：`ctest --test-dir build`（在 aoi-1，引擎代跑）'],
      }),
      'utf8',
    );
    expect(body).toContain('## 附件（截圖）');
    expect(body).toContain(img);
    expect(body).not.toContain('/nope.png'); // a missing file is not offered
    expect(body).toContain('LOAD_RECIPE OK');
    expect(body).toContain('## Repo 地圖（引擎產生');
    expect(body).not.toContain('# Repo 地圖 — cf-aoi'); // its own title line is dropped
    expect(body).toContain('## 這個 repo 過去類似的修法');
    expect(body).toContain('載入沒生效的舊問題（已合併）');
    expect(body).toContain('## 重現輸出（修改前');
    expect(body).toContain('FAILED tests/test_recipe_reload.py::test_second_load');
    // checks replace the raw check:<id> line; plain steps stay
    expect(body).toContain('- [必過] 單元測試：`ctest --test-dir build`（在 aoi-1，引擎代跑）');
    expect(body).toContain('- `true`');
    expect(body).not.toContain('check:ck_1');
    expect(body).toContain('驗收檢查由引擎執行');
  });
});

describe('機台與環境: the boxes the checks run on, for the model', () => {
  const spark = { os: 'Ubuntu 24.04.3 LTS', arch: 'aarch64', cpu: 'Cortex-A725/Cortex-X925', cores: 20, threads: 20, ram_gb: 119.7, disk_total_gb: 3755, disk_free_gb: 2547.4, gpus: [{ name: 'NVIDIA GB10', vram_gb: null }], driver: '580.95.05', cuda_driver: '13.0', cuda_toolkit: '13.0', tools: { python: '3.12.3', gcc: '13.3.0' }, kernel: null, at: '2026-10-01T00:00:00Z' };
  const aoi = { os: 'Microsoft Windows 11 專業版 (10.0.22631)', arch: 'AMD64', cpu: 'Intel(R) Core(TM) i7-12700', cores: 12, threads: 20, ram_gb: 32, disk_total_gb: 931.5, disk_free_gb: 212, gpus: [{ name: 'NVIDIA RTX A4000', vram_gb: 16 }], driver: '552.22', cuda_driver: '12.4', cuda_toolkit: null, tools: { msvc: 'Visual Studio Professional 2022', cmake: '3.29.2' }, kernel: null, at: '2026-10-01T00:00:00Z' };
  const snap = (id: string, name: string, kind: string, machine: string | null) => ({ id, repo_id: 'r_1', name, kind, machine, command: kind === 'manual' ? null : 'x', pass_rule: 'exit0', metrics: null, thresholds: null, baseline: null, baseline_tol: 0.1, dataset: null, test_globs: [], red_on_base: false, timeout_min: null, required: true, ord: 0, protected_paths: [], artifacts: [], manual_text: kind === 'manual' ? '看 GUI' : null, metric_prefix: null });

  it('lists where the agent works and every machine with its 規格, software and description', () => {
    db.prepare("INSERT INTO host_specs (name, specs_json, software) VALUES ('local', ?, 'TensorRT 10.3')").run(JSON.stringify(spark));
    db.prepare("INSERT INTO machines (name, ssh_target, os, shell, work_root, description, software, specs_json) VALUES ('aoi-1', 'aoi@aoi-1', 'windows', 'auto', 'C:\\loop', '產線 A 的 AOI 主機', 'Halcon 23.11\nBasler pylon 7.4', ?)").run(JSON.stringify(aoi));
    const t0 = createTask(db, base);
    db.prepare('UPDATE tasks SET checks_json = ? WHERE id = ?').run(JSON.stringify([snap('ck_b', '建置', 'build', null), snap('ck_t', '單元測試', 'test', 'aoi-1'), snap('ck_g', 'GUI', 'manual', 'aoi-1')]), t0.id);
    const t = getTask(db, t0.id)!;
    const lines = machineLinesFor(db, t)!;
    expect(lines).toEqual([
      '- 引擎主機（你現在所在的環境）；跑：建置',
      '  - 規格：Ubuntu 24.04.3 LTS（aarch64） · 20 核 · RAM 120 GB · NVIDIA GB10 · CUDA 13.0',
      '  - CPU：Cortex-A725/Cortex-X925',
      '  - 磁碟：可用 2547 GB / 共 3755 GB',
      '  - CUDA：CUDA Toolkit 13.0，驅動支援到 CUDA 13.0，驅動 580.95.05',
      '  - 已裝工具：Python 3.12.3、GCC 13.3.0',
      '  - 其他軟體（使用者填的）：TensorRT 10.3',
      '- aoi-1（Windows，PowerShell，引擎透過 SSH 代跑）；跑：單元測試',
      '  - 規格：Microsoft Windows 11 專業版 (10.0.22631)（AMD64） · 12 核／20 緒 · RAM 32 GB · NVIDIA RTX A4000 16 GB · CUDA（驅動）12.4',
      '  - CPU：Intel(R) Core(TM) i7-12700',
      '  - 磁碟：可用 212 GB / 共 932 GB',
      '  - CUDA：沒有 CUDA Toolkit（nvcc），驅動支援到 CUDA 12.4，驅動 552.22',
      '  - 已裝工具：Visual Studio Professional 2022、CMake 3.29.2',
      '  - 其他軟體（使用者填的）：Halcon 23.11；Basler pylon 7.4',
      '  - 說明：產線 A 的 AOI 主機',
    ]);
    const body = fs.readFileSync(writeTaskFile(dir, t, { checks: ['- 建置：`x`'], machines: lines }), 'utf8');
    expect(body).toContain('## 機台與環境（驗收檢查在這些地方跑）');
    expect(body).toContain('Windows 用 PowerShell／cmd 語法和反斜線路徑');
    expect(body.indexOf('## 機台與環境')).toBeGreaterThan(body.indexOf('## Verification steps'));
  });

  it('a box nobody has read yet says how to read it; a task without checks gets no section', () => {
    const t0 = createTask(db, base);
    db.prepare('UPDATE tasks SET checks_json = ? WHERE id = ?').run(JSON.stringify([snap('ck_b', '建置', 'build', 'sandbox:gpu2')]), t0.id);
    expect(machineLinesFor(db, getTask(db, t0.id)!)).toEqual([
      '- 引擎主機（你現在所在的環境）',
      '  - 規格：還沒讀過（機台頁按「檢查」或「讀取規格」）',
      '- GPU 沙盒 gpu2（Docker 容器，沒有網路）；跑：建置',
      '  - 規格：還沒讀過（機台頁按「檢查」或「讀取規格」）',
    ]);
    expect(machineLinesFor(db, createTask(db, base))).toBeNull();
    expect(machineBoxLines(db, 'gone')).toEqual(['- gone（找不到這台機台）']);
  });

  it('the analysis prompt names the verification machine, so the repro command fits it', () => {
    const p = buildProposePrompt({ description: 'x', imageTexts: [], clues: { errors: [], identifiers: [], paths: [], labels: [] } as never, candidates: [], mapMarkdown: '', similar: [], repo: { name: 'cf-aoi', build_cmd: null, test_cmd: null }, kindHint: null, machine: ['- aoi-1（Windows，PowerShell）：…'] });
    expect(p).toContain('## 驗證機台（重現指令要能在這台跑');
    expect(p).toContain('- aoi-1（Windows，PowerShell）');
  });
});
