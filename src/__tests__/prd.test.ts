import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { lintPrd } from '../prd/lint.js';
import { parsePrdReview } from '../prd/review.js';
import { checkPrd, submitPrd, PrdInputError } from '../prd/intake.js';
import { chatLocal } from '../local/chat.js';
import { getBenchmark } from '../benchmark/store.js';

let repo: string;
beforeAll(() => {
  // a real (local, no-network) git repo so the task gate's repo/branch checks pass
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-prd-repo-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# r\n');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
});

const prd = (over: Partial<Record<'title' | 'goal' | 'scope' | 'non' | 'acc' | 'verify' | 'repo' | 'domain' | 'cx', string>> = {}) => `# ${over.title ?? 'Add slugify helper'}

## 目標 (Goal)
${over.goal ?? 'Implement slugify(str) in src/slugify.ts so URLs for article titles are stable and readable.'}

## 範圍 (Scope)
${over.scope ?? '- Add src/slugify.ts exporting slugify\n- Add tests in test/slugify.test.ts'}

## 非範圍 (Non-goals)
${over.non ?? '- No changes to the router'}

## 驗收標準 (Acceptance)
${over.acc ?? '- [ ] slugify("Hello World") returns "hello-world"\n- [ ] accents are stripped'}

## 驗證指令 (Verify)
${over.verify ?? '```bash\nnpm test\n```'}

## Repo
${over.repo ?? `- path: ${repo}\n- branch: main`}

## 領域 (Domain)
${over.domain ?? 'typescript'}

## 複雜度 (Complexity)
${over.cx ?? 'S'}
`;

describe('lintPrd', () => {
  it('accepts a complete PRD and extracts the task fields', () => {
    const r = lintPrd(prd());
    expect(r.missing).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.fields).toMatchObject({
      title: 'Add slugify helper',
      scope: ['Add src/slugify.ts exporting slugify', 'Add tests in test/slugify.test.ts'],
      non_goals: ['No changes to the router'],
      acceptance: ['slugify("Hello World") returns "hello-world"', 'accents are stripped'],
      verify_steps: ['npm test'],
      repo_path: repo,
      base_branch: 'main',
      domain: 'typescript',
      complexity: 'S',
    });
  });

  it('the untouched template is blocked on every section', () => {
    const tpl = fs.readFileSync(new URL('../../seed/prd-template.md', import.meta.url), 'utf8');
    const r = lintPrd(tpl);
    expect(r.ok).toBe(false);
    const all = r.missing.join('\n');
    for (const label of ['標題', '範圍', '非範圍', '驗收標準', '驗證指令', 'Repo', '領域']) expect(all).toContain(label);
  });

  it('blocks each structural gap with a section-specific message', () => {
    expect(lintPrd(prd({ verify: 'run the tests' })).missing.join()).toMatch(/驗證指令/);
    expect(lintPrd(prd({ non: '' })).missing.join()).toMatch(/非範圍/);
    expect(lintPrd(prd({ acc: 'it should work' })).missing.join()).toMatch(/驗收標準/);
    expect(lintPrd(prd({ goal: 'fix it' })).missing.join()).toMatch(/目標/);
    expect(lintPrd(prd({ repo: '- path: /definitely/not/here' })).missing.join()).toMatch(/Repo 路徑不存在/);
    expect(lintPrd(prd({ domain: 'cobol' })).missing.join()).toMatch(/領域/);
    expect(lintPrd(prd({ scope: '- TODO' })).missing.join()).toMatch(/範圍」還有未填/);
  });

  it('defaults branch/complexity with warnings, accepts English headings and bullet commands', () => {
    const md = prd({ repo: `- path: ${repo}`, cx: '' })
      .replace('## 目標 (Goal)', '## Goal')
      .replace('## 驗證指令 (Verify)', '## Verification')
      .replace('```bash\nnpm test\n```', '- `npm run typecheck`\n- `npm test`');
    const r = lintPrd(md);
    expect(r.ok).toBe(true);
    expect(r.fields.verify_steps).toEqual(['npm run typecheck', 'npm test']);
    expect(r.warnings.join()).toMatch(/branch/);
    expect(r.warnings.join()).toMatch(/複雜度/);
  });
});

describe('parsePrdReview', () => {
  it('parses strict or fenced/wrapped JSON and rejects anything without a boolean ok', () => {
    expect(parsePrdReview('{"ok":false,"missing":["缺少輸出格式"],"questions":[],"risk_notes":[]}')).toEqual({
      ok: false, missing: ['缺少輸出格式'], questions: [], risk_notes: [],
    });
    expect(parsePrdReview('好的：\n```json\n{"ok":true}\n```')?.ok).toBe(true);
    expect(parsePrdReview('here you go {"ok": true, "risk_notes": ["x"]} thanks')).toMatchObject({ ok: true, risk_notes: ['x'] });
    expect(parsePrdReview('looks fine')).toBeNull();
  });
});

describe('PRD intake', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openTestDb();
  });
  afterEach(() => db.close());

  const okReview = async () => '{"ok":true,"missing":[],"questions":["要支援中文嗎？"],"risk_notes":[]}';

  it('check: a structural gap blocks before the model is even asked', async () => {
    let asked = false;
    const r = await checkPrd(db, prd({ verify: '' }), { exec: async () => ((asked = true), '{"ok":true}') });
    expect(r.ok).toBe(false);
    expect(r.llm.status).toBe('skipped');
    expect(asked).toBe(false);
  });

  it('check: the local reviewer can block a structurally valid PRD', async () => {
    const r = await checkPrd(db, prd(), { exec: async () => '{"ok":false,"missing":["沒寫輸出要不要保留數字"],"questions":["數字怎麼處理？"]}' });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['審查：沒寫輸出要不要保留數字']);
    expect(r.llm).toMatchObject({ status: 'ok', ok: false, questions: ['數字怎麼處理？'] });
  });

  it('check: no local model -> passes on lint alone unless prd_require_llm', async () => {
    const none = async () => null;
    expect((await checkPrd(db, prd(), { exec: none })).ok).toBe(true);
    setSetting(db, 'prd_require_llm', 'true');
    const r = await checkPrd(db, prd(), { exec: none });
    expect(r.ok).toBe(false);
    expect(r.missing.join()).toMatch(/prd_require_llm/);
  });

  it('check: a failing model (truncated / garbage) is an error, not "no model" — warns, blocks only with prd_require_llm', async () => {
    const boom = async () => {
      throw new Error('reply cut off at max_tokens=4096 before any answer');
    };
    const r = await checkPrd(db, prd(), { exec: boom });
    expect(r).toMatchObject({ ok: true, llm: { status: 'error', error: 'reply cut off at max_tokens=4096 before any answer' } });
    expect(r.warnings.join()).toMatch(/本地模型審查失敗/);

    const garbage = await checkPrd(db, prd(), { exec: async () => 'Sure! The PRD looks fine.' });
    expect(garbage.llm).toMatchObject({ status: 'error', error: expect.stringMatching(/unparseable/) });

    setSetting(db, 'prd_require_llm', 'true');
    const strict = await checkPrd(db, prd(), { exec: boom });
    expect(strict.ok).toBe(false);
    expect(strict.missing.join()).toMatch(/審查失敗（prd_require_llm=true）/);
  });

  it('submit: refuses a blocked PRD without writing anything', async () => {
    const r = await submitPrd(db, prd({ acc: '' }), { exec: okReview });
    expect(r.ok).toBe(false);
    expect((db.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n).toBe(0);
  });

  it('submit: creates a queued local-model task with the PRD as its plan and acceptance as rubric', async () => {
    setSetting(db, 'prd_default_model', 'local:qwen38-flash');
    const r = await submitPrd(db, prd(), { exec: okReview });
    if (!r.ok || r.kind !== 'task') throw new Error('expected a task');
    expect(r.gate.ok).toBe(true);
    expect(r.task).toMatchObject({
      status: 'queued',
      model: 'local:qwen38-flash',
      plan_kind: 'md',
      repo_path: repo,
      base_branch: 'main',
      complexity: 'S',
      created_by: 'prd',
    });
    expect(JSON.parse(r.task.verification_steps)).toEqual(['npm test']);
    expect(r.task.verify_rubric).toContain('accents are stripped');
    expect(r.task.domain).toBe('typescript'); // the PRD's 領域 is kept for domain_routing
    expect(fs.readFileSync(r.plan_ref, 'utf8')).toContain('## 非範圍 (Non-goals)');
  });

  it('submit: model resolution — explicit > prd_default_model > local default_model > inherit', async () => {
    setSetting(db, 'default_model', 'local:qwen3-coder-next');
    const a = await submitPrd(db, prd(), { exec: okReview, queue: false });
    expect(a.ok && a.kind === 'task' && a.task.model).toBe('local:qwen3-coder-next');
    expect(a.ok && a.kind === 'task' && a.task.status).toBe('draft');
    const b = await submitPrd(db, prd(), { exec: okReview, model: 'sonnet' });
    expect(b.ok && b.kind === 'task' && b.task.model).toBe('sonnet');
    await expect(submitPrd(db, prd(), { exec: okReview, model: 'gpt-9' })).rejects.toBeInstanceOf(PrdInputError);
  });

  it('submit: benchmark_models turns the PRD into a benchmark in the PRD domain', async () => {
    const r = await submitPrd(db, prd(), { exec: okReview, benchmark_models: ['local:qwen38-flash', 'local:qwen3-coder-next'] });
    if (!r.ok || r.kind !== 'benchmark') throw new Error('expected a benchmark');
    expect(r.benchmark).toMatchObject({ domain: 'typescript', plan_ref: r.plan_ref, complexity: 'S' });
    expect(getBenchmark(db, r.benchmark.id)!.arms.map((x) => x.model)).toEqual(['local:qwen38-flash', 'local:qwen3-coder-next']);
  });
});

describe('chatLocal', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openTestDb();
  });
  afterEach(() => db.close());

  it('only talks to a READY local model, with thinking off, and says why it could not answer', async () => {
    const calls: { url: string; body: any }[] = [];
    let reply: unknown = { choices: [{ finish_reason: 'stop', message: { content: '<think>hmm</think>{"ok":true}' } }] };
    const fake = async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => reply };
    };
    expect(await chatLocal(db, { system: 's', user: 'u' }, fake)).toMatchObject({ ok: false, reason: 'disabled' });
    setSetting(db, 'local_models_enabled', 'true');
    expect(await chatLocal(db, { system: 's', user: 'u' }, fake)).toMatchObject({ ok: false, reason: 'not_ready' });
    setSetting(db, 'local_model_loaded', 'qwen38-flash');
    setSetting(db, 'local_model_status', 'ready');
    expect(await chatLocal(db, { system: 's', user: 'u' }, fake)).toEqual({ ok: true, content: '{"ok":true}' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:8000/v1/chat/completions');
    expect(calls[0]!.body).toMatchObject({
      model: 'local-inference-lab/Qwen3.8-Flash-Next-NVFP4',
      temperature: 0,
      chat_template_kwargs: { enable_thinking: false },
    });

    // the failure seen on the Spark: every token spent reasoning, no answer
    reply = { choices: [{ finish_reason: 'length', message: { content: null } }] };
    expect(await chatLocal(db, { system: 's', user: 'u' }, fake)).toMatchObject({ ok: false, reason: 'truncated' });
  });
});

describe('PRD intake: verification the wizard sections ask for', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openTestDb();
    setSetting(db, 'prd_gate_enabled', 'true');
  });
  afterEach(() => db.close());
  const noLlm = { exec: async () => null };

  const withSections = (extra: string, over: Parameters<typeof prd>[0] = {}) => `${prd(over)}\n${extra}`;

  it('derives verify_mode from what is present: commands → command, a checklist → +manual', async () => {
    const md = withSections(`## 人工驗收 (Manual checks)\n- Given 一片板 When 跑完 Then 清單可排序\n`);
    const r = await submitPrd(db, md, { ...noLlm, queue: false });
    expect(r.ok && r.kind === 'task').toBe(true);
    if (!r.ok || r.kind !== 'task') return;
    expect(r.task.verify_mode).toBe('command,manual');
    expect(r.task.verify_rubric).toContain('人工驗收：');
    expect(r.task.verify_rubric).toContain('- Given 一片板 When 跑完 Then 清單可排序');
    expect(r.task.requires).toBeNull();
    expect(r.task.setup_cmd).toBeNull();
  });

  it('a checklist-only PRD (no commands) is accepted and runs as manual', async () => {
    const md = withSections(`## 人工驗收 (Manual checks)\n- 目視確認排序\n`, { verify: '（無）' });
    const r = await submitPrd(db, md, { ...noLlm, queue: false });
    expect(r.ok && r.kind === 'task').toBe(true);
    if (!r.ok || r.kind !== 'task') return;
    expect(r.task.verify_mode).toBe('manual');
    expect(JSON.parse(r.task.verification_steps)).toEqual([]);
    expect(r.gate.ok).toBe(true); // validateTask's manual-only rule agrees with the linter
  });

  it('圖集比對 implies gpu; an explicit 需求能力 / 驗證方式 wins; 前置指令 becomes setup_cmd', async () => {
    const md = withSections(
      [
        '## 圖集比對 (Dataset)',
        `- 輸入圖集: ${repo}（僅引用路徑，禁止複製）`,
        '- 配方: DEFAULT',
        '- 門檻: 誤判率 ≤ 1%；漏檢 = 0',
        '',
        '## 前置指令 (Setup)',
        '```bash',
        'cmake -S ip -B ip/build',
        'cmake --build ip/build -j8',
        '```',
        '',
      ].join('\n'),
    );
    const implied = await submitPrd(db, md, { ...noLlm, queue: false });
    expect(implied.ok && implied.kind === 'task').toBe(true);
    if (!implied.ok || implied.kind !== 'task') return;
    expect(implied.task.requires).toBe('gpu');
    expect(implied.task.setup_cmd).toBe('cmake -S ip -B ip/build && cmake --build ip/build -j8');
    expect(implied.task.verify_mode).toBe('command');

    const explicit = await submitPrd(db, `${md}\n## 需求能力 (Requires)\ncamera, os:linux\n\n## 驗證方式 (Verify mode)\ncommand, llm\n`, {
      ...noLlm,
      queue: false,
    });
    expect(explicit.ok && explicit.kind === 'task').toBe(true);
    if (!explicit.ok || explicit.kind !== 'task') return;
    expect(explicit.task.requires).toBe('camera,os:linux');
    expect(explicit.task.verify_mode).toBe('command,llm');
  });

  it('the verify_llm option adds the cloud judge without touching the PRD', async () => {
    const r = await submitPrd(db, prd(), { ...noLlm, queue: false, verify_llm: true });
    expect(r.ok && r.kind === 'task' && r.task.verify_mode).toBe('command,llm');
  });

  it('blocks the wizard sections when they are wrong, with a message per section', () => {
    expect(lintPrd(withSections('## 驗證方式 (Verify mode)\nyolo\n'), { exists: () => true }).missing).toContain(
      '「驗證方式」只能是 command / llm / manual（可用逗號並列）',
    );
    expect(lintPrd(withSections('## 圖集比對 (Dataset)\n- 配方: X\n'), { exists: () => true }).missing).toContain('「圖集比對」缺少「輸入圖集」的路徑');
    expect(lintPrd(withSections('## 圖集比對 (Dataset)\n- 輸入圖集: /nope\n'), { exists: (p) => p !== '/nope' }).missing).toContain('圖集路徑不存在：/nope');
    expect(lintPrd(withSections('## 前置指令 (Setup)\n```bash\n<npm install>\n```\n'), { exists: () => true }).missing).toContain('「前置指令」還有未填的佔位符');
    expect(lintPrd(withSections('## 需求能力 (Requires)\ngpu, 相機\n'), { exists: () => true }).missing[0]).toContain('「需求能力」');
    // and a plain old PRD is exactly as acceptable as before
    expect(lintPrd(prd(), { exists: () => true }).missing).toEqual([]);
  });
});
