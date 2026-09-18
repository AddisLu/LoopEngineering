import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { getSetting } from '../db/index.js';
import { createTask, type NewTaskInput } from '../tasks.js';
import type { Task } from '../types.js';
import { slugify } from '../chat/intent.js';

/**
 * 驗證新技術: a fresh git repo under spike_root where a task installs the thing, runs a minimal
 * demo and writes REPORT.md. The engine cuts worktrees from a freshly fetched `origin/<base>`,
 * so every spike repo gets its own bare origin next to it (the same shape the test fixtures
 * use). Nothing here touches an existing project.
 */

export interface SpikeInput {
  name: string;
  goal: string;
  urls: string[];
  owner?: string | null;
  sourceRef: string;
  model?: string | null;
  createdBy?: string;
}

export interface SpikeDeps {
  root?: string;
  git?: (args: string[], cwd: string) => void;
}

export class SpikeError extends Error {}

const defaultGit = (args: string[], cwd: string): void => {
  execFileSync('git', args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], timeout: 20_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
};

export function spikeRoot(db: Database.Database): string {
  const raw = (getSetting(db, 'spike_root') || '').trim() || path.join(os.homedir(), 'Addis', 'spikes');
  return raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
}

function uniqueSlug(root: string, base: string): string {
  let slug = base;
  for (let i = 2; fs.existsSync(path.join(root, slug)) || fs.existsSync(path.join(root, '.origins', `${slug}.git`)); i++) slug = `${base}-${i}`;
  return slug;
}

function readme(name: string, goal: string, urls: string[]): string {
  return [
    `# ${name}`,
    '',
    '驗證用的實驗 repo（由 Loop Engineering 從對話開出來）。',
    '',
    '## 目標',
    goal,
    '',
    urls.length ? '## 來源' : '',
    ...urls.map((u) => `- ${u}`),
    '',
    '## 驗收',
    '- 能在這台機器安裝（或在容器內安裝）並跑起最小的示範',
    '- `REPORT.md` 記錄：安裝方式、實際跑的指令與輸出、量測結果、限制、以及「是否適合導入 CF-AOI、下一步」',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

function plan(name: string, goal: string, urls: string[]): string {
  return [
    `# 驗證 ${name}`,
    '',
    '## 目標',
    goal,
    '',
    '## 步驟',
    '1. 依來源網址取得程式（clone 或 pip/npm 安裝）；只在這個 repo 內操作，不要碰其他目錄。',
    '2. 跑最小可行的示範（README 的 quick start）；需要資料就用公開的小樣本或自己合成。',
    '3. 記錄實際指令、輸出、耗時與資源使用；失敗也照實記。',
    '4. 寫 `REPORT.md`：結論一段、安裝方式、示範結果、限制、是否適合 CF-AOI（收圖／影像處理／判定／Control）與下一步。',
    '',
    '## 來源',
    ...urls.map((u) => `- ${u}`),
    '',
    '## 限制',
    '- 不安裝系統層套件（apt / sudo）；用 venv、npm 或容器。',
    '- 不對外送任何工廠資料。',
    '',
  ].join('\n');
}

/**
 * A fresh git repo with its own bare origin (the engine cuts worktrees from a fetched
 * `origin/<base>`), seeded with `files` and one commit. Shared by spikes and built-in benchmark
 * questions. Cleans up after itself when git fails.
 */
export function initRepo(root: string, slug: string, files: Record<string, string>, commitMsg: string, git: (args: string[], cwd: string) => void = defaultGit): { repo: string; origin: string } {
  fs.mkdirSync(path.join(root, '.origins'), { recursive: true });
  const repo = path.join(root, slug);
  const origin = path.join(root, '.origins', `${slug}.git`);
  try {
    git(['init', '--bare', '-b', 'main', origin], root);
    fs.mkdirSync(repo);
    git(['init', '-b', 'main'], repo);
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(repo, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    git(['add', '-A'], repo);
    git(['-c', 'user.name=Loop Engineering', '-c', 'user.email=loop@local', 'commit', '-q', '-m', commitMsg], repo);
    git(['remote', 'add', 'origin', origin], repo);
    git(['push', '-q', '-u', 'origin', 'main'], repo);
  } catch (err) {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(origin, { recursive: true, force: true });
    const msg = err instanceof Error ? err.message : String(err);
    throw new SpikeError(`建立 repo 失敗：${msg.slice(0, 200)}`);
  }
  return { repo, origin };
}

export function createSpike(db: Database.Database, input: SpikeInput, deps: SpikeDeps = {}): { task: Task; repo_path: string } {
  const root = deps.root ?? spikeRoot(db);
  const git = deps.git ?? defaultGit;
  const name = input.name.trim().slice(0, 60);
  if (!name) throw new SpikeError('name is required');
  if (!input.goal.trim()) throw new SpikeError('goal is required');
  fs.mkdirSync(path.join(root, '.origins'), { recursive: true });
  const slug = uniqueSlug(root, slugify(name));
  const urls = input.urls.filter((u) => /^https?:\/\//.test(u)).slice(0, 8);
  const { repo } = initRepo(
    root,
    slug,
    {
      'README.md': readme(name, input.goal.trim(), urls),
      'PLAN.md': plan(name, input.goal.trim(), urls),
      '.gitignore': 'node_modules/\n.venv/\nvenv/\n__pycache__/\n*.log\ndata/\n',
    },
    `spike: ${name}`,
    git,
  );
  const taskInput: NewTaskInput = {
    title: `驗證：${name}`.slice(0, 120),
    goal: `${input.goal.trim()}\n\n實驗 repo：${repo}\n${urls.map((u) => `- ${u}`).join('\n')}`.trim(),
    plan_ref: path.join(repo, 'PLAN.md'),
    plan_kind: 'md',
    repo_path: repo,
    base_branch: 'main',
    verification_steps: ['test -s REPORT.md'],
    verify_mode: 'command,manual',
    complexity: 'M',
    model: input.model ?? null,
    owner: input.owner ?? null,
    created_by: input.createdBy ?? 'chat',
    source_ref: input.sourceRef,
  };
  const task = createTask(db, taskInput);
  return { task, repo_path: repo };
}
