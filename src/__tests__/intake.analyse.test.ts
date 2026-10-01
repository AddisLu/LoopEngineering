import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { getTask } from '../tasks.js';
import { createRepo, getRepo, type Repo } from '../repo/store.js';
import { createCheck } from '../checks/store.js';
import type { chatLocal, LocalChatRequest } from '../local/chat.js';
import { createTicket, ticketView } from '../intake/ticket.js';
import {
  analyseTicket,
  analysisInFlight,
  awaitAnalysis,
  parseProposal,
  PROPOSE_SYSTEM,
  readAnalysis,
  renderTicket,
  symbolsFromMap,
  type AnalyseDeps,
  type TicketChecks,
} from '../intake/analyse.js';
import { TICKET_REPRO_CHECK_ID } from '../intake/checks.js';
import { renderRepoMap, buildRepoMap } from '../repo/map.js';

/** 分析: a fixture repo registered in repos, a local model faked through localChat — zero tokens, zero network. */

const LOADER = `#include "recipe_loader.h"
namespace control {

void apply_recipe(const Recipe& r, bool recipe_changed)
{
  if (!recipe_changed) return;
  set_param("bypass_edge_x", r.bypass_edge_x);
  log_info("LOAD_RECIPE OK");
}

}  // namespace control
`;

let db: Database.Database;
let root: string;
let repo: Repo;
const who = { user_key: 'name:addis', label: 'Addis' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
const DESC = '連續兩次 LOAD_RECIPE 後第二次的 bypass_edge_x 沒生效；apply_recipe 好像直接跳過了。應該每次都套用最新值。';

beforeEach(() => {
  db = openTestDb();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loop-analyse-')));
  const dir = path.join(root, 'cf-aoi');
  fs.mkdirSync(path.join(dir, 'src', 'control'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'CMakeLists.txt'), 'project(cfaoi)\nadd_executable(cfaoi_ip src/main.cpp)\n');
  fs.writeFileSync(path.join(dir, 'src', 'main.cpp'), 'int main(int argc, char** argv)\n{\n  return 0;\n}\n');
  fs.writeFileSync(path.join(dir, 'src', 'control', 'recipe_loader.cpp'), LOADER);
  fs.writeFileSync(path.join(dir, 'tests', 'test_recipe_reload.py'), 'def test_second_load():\n    assert True\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fix(control): recipe loader');
  repo = createRepo(db, { name: 'cf-aoi', remote_url: 'http://gitea.corp/aoi/cf-aoi.git', gitea_owner: 'aoi', gitea_repo: 'cf-aoi', local_path: dir, domain: 'cpp', build_cmd: 'echo build', test_cmd: 'echo test' });
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const PROPOSAL = {
  kind: 'bugfix',
  title: '第二次載入配方沒有套用新值',
  symptom: '第二次 LOAD_RECIPE 後 bypass_edge_x 還是舊值',
  expected: '每次 LOAD_RECIPE 都套用最新值',
  causes: [
    { file: 'src/control/recipe_loader.cpp', symbol: 'apply_recipe()', why: 'recipe_changed 判斷讓第二次載入直接 return' },
    { file: 'src/control/invented.cpp', symbol: null, why: '模型編的檔案' },
  ],
  repro: { mode: 'command', command: 'python3 -m pytest tests/test_recipe_reload.py', test_file: null, description: '跑重現測試' },
  complexity: 'S',
  questions: ['舊格式的配方也要支援嗎？'],
};

/** propose → the proposal; the PRD review → one question */
function fakeModel(o: { onPropose?: () => void; proposal?: unknown } = {}): { chat: typeof chatLocal; calls: LocalChatRequest[] } {
  const calls: LocalChatRequest[] = [];
  const chat: typeof chatLocal = async (_db, req) => {
    calls.push(req);
    if (req.system === PROPOSE_SYSTEM) {
      o.onPropose?.();
      return { ok: true, content: '```json\n' + JSON.stringify(o.proposal ?? PROPOSAL) + '\n```' };
    }
    return { ok: true, content: '{"ok":true,"missing":[],"questions":["新測試要放在 tests/ 底下嗎？"],"risk_notes":[]}' };
  };
  return { chat, calls };
}
const noModel: typeof chatLocal = async () => ({ ok: false, reason: 'not_ready', detail: 'no local model ready' });
const NO_CHECKS: AnalyseDeps = { checks: null };

async function analysed(desc = DESC, deps: AnalyseDeps = {}, input: Record<string, unknown> = {}) {
  const t = createTicket(db, { description: desc, repo_id: repo.id, ...input }, who);
  await analyseTicket(db, t.id, deps);
  return getTask(db, t.id)!;
}

describe('分析 with a local model', () => {
  it('proposes causes, repro and kind, picks checks, composes and applies the PRD', async () => {
    setSetting(db, 'local_model_loaded', 'qwen38-flash');
    const steps: string[] = [];
    const m = fakeModel({
      onPropose: () => {
        const tk = db.prepare('SELECT analysis_json, analysis_status FROM tasks').get() as { analysis_json: string; analysis_status: string };
        const a = JSON.parse(tk.analysis_json) as { steps: { key: string; state: string }[] };
        steps.push(tk.analysis_status, ...a.steps.map((s) => `${s.key}:${s.state}`));
      },
    });
    const t = await analysed(DESC, { ...NO_CHECKS, localChat: m.chat });
    // progress is written as it goes: the page sees map/locate done while the model is asked
    expect(steps).toEqual(['running', 'map:done', 'vision:skipped', 'locate:done', 'propose:running', 'repro:todo', 'checks:todo', 'review:todo']);

    expect(t.analysis_status).toBe('ready');
    const v = ticketView(db, t, who);
    const a = v.analysis!;
    expect(v.kind).toBe('bugfix');
    expect(v.title).toBe('第二次載入配方沒有套用新值'); // nobody typed a title: Loop names it
    expect(a.model_used).toBe('local:qwen38-flash');
    expect(a.causes).toHaveLength(1); // the invented file is dropped
    expect(a.causes[0]).toMatchObject({ file: 'src/control/recipe_loader.cpp', symbol: 'apply_recipe', why: expect.stringContaining('recipe_changed') });
    expect(a.causes[0]!.evidence.some((e) => e.text.includes('bypass_edge_x'))).toBe(true);
    expect(a.causes[0]!.recent[0]).toMatch(/fix\(control\): recipe loader/);
    expect(a.repro).toMatchObject({ mode: 'command', command: 'python3 -m pytest tests/test_recipe_reload.py', before: null });
    // no checks module: the repo's detected commands + the repro command, each required, exit 0
    expect(a.checks).toEqual([
      { id: 'build', name: '建置', kind: 'build', machine: null, command: 'echo build', required: true, on: true, rule: 'exit 0' },
      { id: 'test', name: '測試', kind: 'test', machine: null, command: 'echo test', required: true, on: true, rule: 'exit 0' },
      { id: 'repro', name: '重現', kind: 'repro', machine: null, command: 'python3 -m pytest tests/test_recipe_reload.py', required: true, on: true, rule: 'exit 0' },
    ]);
    expect(a.questions).toEqual(expect.arrayContaining(['舊格式的配方也要支援嗎？', '新測試要放在 tests/ 底下嗎？']));
    expect(a.conditions).toMatchObject({ machine: null, model: { id: 'sonnet', reason: '預設模型（default_model）' }, estimate: { complexity: 'S', minutes: 15, window: null }, ladder: { attempts: null, next: [] } });
    expect(a.steps.map((s) => `${s.key}:${s.state}`)).toEqual(['map:done', 'vision:skipped', 'locate:done', 'propose:done', 'repro:skipped', 'checks:done', 'review:done']);
    expect(a.error).toBeNull();
    expect(a.took_ms).toBeGreaterThanOrEqual(0);

    // the task is runnable: plan file, steps, rubric, size, domain
    expect(fs.readFileSync(t.plan_ref!, 'utf8')).toContain('`src/control/recipe_loader.cpp`：可能原因：apply_recipe，');
    expect(JSON.parse(t.verification_steps)).toEqual(['echo build', 'echo test', 'python3 -m pytest tests/test_recipe_reload.py']);
    expect(t).toMatchObject({ complexity: 'S', domain: 'cpp', plan_kind: 'md', verify_mode: 'command', goal: DESC, repo_path: repo.local_path, base_branch: 'main' });
    expect(t.verify_rubric).toContain('修正後照同樣步驟執行');
    expect(t.checks_json).toBeNull();
    // the repo map was built and recorded
    const r = getRepo(db, repo.id)!;
    expect(r.map_sha).toMatch(/^[0-9a-f]{7,}$/);
    expect(fs.readFileSync(r.map_path!, 'utf8')).toContain('apply_recipe():4');
  });

  it('without a model it falls back to rules: heuristic kind, top candidates, no repro', async () => {
    const t = await analysed('第二次 LOAD_RECIPE 後 bypass_edge_x 判錯（誤判），apply_recipe 好像沒跑到', { ...NO_CHECKS, localChat: noModel });
    const a = ticketView(db, t, who).analysis!;
    expect(t.analysis_status).toBe('ready');
    expect(a.model_used).toBeNull();
    expect(a.repro).toBeNull();
    expect(a.causes[0]).toMatchObject({ file: 'src/control/recipe_loader.cpp', symbol: 'apply_recipe' });
    expect(readAnalysis(t)!.kind).toBe('algo'); // 誤判 → an algorithm fix by the keyword rules
    expect(a.steps.find((s) => s.key === 'propose')!.detail).toContain('規則分析（本地模型未載入）');
    expect(a.steps.find((s) => s.key === 'review')).toMatchObject({ state: 'skipped', detail: '本地模型沒有載入，略過複核' });
    expect(JSON.parse(t.verification_steps)).toEqual(['echo build', 'echo test']);
  });

  it('a repo without any command asks how to verify instead of failing', async () => {
    db.prepare('UPDATE repos SET build_cmd = NULL, test_cmd = NULL WHERE id = ?').run(repo.id);
    const t = await analysed(DESC, { ...NO_CHECKS, localChat: noModel });
    expect(t.analysis_status).toBe('ready');
    expect(ticketView(db, t, who).analysis!.questions[0]).toContain('沒有偵測到建置或測試指令');
  });

  it('failing_first: a repro the person typed is dry-run through runRepro; off, or proposed by the model, it is skipped', async () => {
    const m = fakeModel();
    const ran: string[] = [];
    const runRepro: AnalyseDeps['runRepro'] = async (_db, _t, _r, repro) => {
      ran.push(repro.command!);
      return { ok: false, exit_code: 1, ms: 2300, tail: 'FAILED test_second_load' };
    };
    // flag off
    let t = await analysed(DESC, { ...NO_CHECKS, localChat: m.chat, runRepro });
    expect(ticketView(db, t, who).analysis!.steps.find((s) => s.key === 'repro')!.detail).toContain('failing_first');
    setSetting(db, 'failing_first', 'true');
    // the model's own command: not run before a person confirms it
    t = await analysed(DESC, { ...NO_CHECKS, localChat: m.chat, runRepro });
    expect(ticketView(db, t, who).analysis!.steps.find((s) => s.key === 'repro')).toMatchObject({ state: 'skipped', detail: expect.stringContaining('Loop 提的') });
    expect(ran).toEqual([]);
    // typed by the person
    t = await analysed(`${DESC}\n重現：\`python3 -m pytest tests/test_recipe_reload.py\``, { ...NO_CHECKS, localChat: m.chat, runRepro });
    const a = ticketView(db, t, who).analysis!;
    expect(ran).toEqual(['python3 -m pytest tests/test_recipe_reload.py']);
    expect(a.repro!.before).toEqual({ ok: false, exit_code: 1, ms: 2300, tail: 'FAILED test_second_load' });
    expect(a.steps.find((s) => s.key === 'repro')).toMatchObject({ state: 'done', detail: expect.stringContaining('正確') });
    // no runner wired yet: skipped
    t = await analysed(`${DESC}\n\`python3 -m pytest tests/test_recipe_reload.py\``, { ...NO_CHECKS, localChat: m.chat });
    expect(ticketView(db, t, who).analysis!.steps.find((s) => s.key === 'repro')!.detail).toContain('還沒接上');
  });

  it('an injected checks.select decides the steps and the frozen copy', async () => {
    const seen: unknown[] = [];
    const checks: TicketChecks = {
      select(_db, r, o) {
        seen.push({ repo: r.id, ...o });
        return {
          snapshot: [{ id: 'ck_unit', name: '單元測試' }],
          fields: { verification_steps: ['check:ck_unit'], acceptance_metrics: 'correct_rate >= 0.98', protected_paths: 'tests/golden/**', artifacts: null, manual_checks: [], verify_mode: 'command', requires: null },
          view: [{ id: 'ck_unit', name: '單元測試', kind: 'test', machine: 'aoi-1', command: 'ctest', required: true, on: true, rule: 'exit 0' }],
        };
      },
    };
    const t = await analysed(DESC, { checks, localChat: fakeModel().chat });
    expect(seen).toEqual([{ repo: repo.id, kind: 'bugfix', repro: expect.objectContaining({ mode: 'command' }), off: [] }]);
    expect(JSON.parse(t.checks_json!)).toEqual([{ id: 'ck_unit', name: '單元測試' }]);
    expect(JSON.parse(t.verification_steps)).toEqual(['check:ck_unit']);
    expect(t).toMatchObject({ acceptance_metrics: 'correct_rate >= 0.98', protected_paths: 'tests/golden/**' });
    expect(ticketView(db, t, who).analysis!.checks.map((c) => c.id)).toEqual(['ck_unit']);
  });

  it("by default the repo's 檢查: required + ticked optional ones, a ticket-only 重現, manual ones in the rubric", async () => {
    const unit = createCheck(db, repo.id, { name: '單元測試', kind: 'test', command: 'ctest --test-dir build' });
    const lint = createCheck(db, repo.id, { name: '風格檢查', kind: 'custom', command: 'clang-format --dry-run src/*.cpp', required: false });
    createCheck(db, repo.id, { name: '看畫面', kind: 'manual', manual_text: '在機台上載入兩次配方看數值' });
    const t0 = createTicket(db, { description: DESC, repo_id: repo.id }, who);
    db.prepare('UPDATE tasks SET analysis_json = ? WHERE id = ?').run(JSON.stringify({ checks_off: [lint.id] }), t0.id);
    await analyseTicket(db, t0.id, { localChat: fakeModel().chat });
    const t = getTask(db, t0.id)!;
    const a = ticketView(db, t, who).analysis!;
    expect(a.checks.map((c) => [c.name, c.required, c.on, c.rule])).toEqual([
      ['單元測試', true, true, 'exit 0'],
      ['風格檢查', false, false, 'exit 0'],
      ['看畫面', true, true, '人工確認'],
      ['重現', true, true, '修改前失敗、修改後通過'],
    ]);
    expect(JSON.parse(t.verification_steps)).toEqual([`check:${unit.id}`, `check:${TICKET_REPRO_CHECK_ID}`]);
    const snap = JSON.parse(t.checks_json!) as { id: string; command: string | null }[];
    expect(snap.map((s) => s.id)).toEqual([unit.id, expect.stringMatching(/^ck_/), TICKET_REPRO_CHECK_ID]);
    expect(snap.at(-1)!.command).toBe('python3 -m pytest tests/test_recipe_reload.py');
    expect(t.verify_mode).toBe('command,manual');
    expect(t.verify_rubric).toContain('人工驗收：');
    expect(t.verify_rubric).toContain('在機台上載入兩次配方看數值');

    // 改一下: tick the optional one back on → re-rendered without asking the model
    const state = readAnalysis(t)!;
    state.checks_off = [];
    db.prepare('UPDATE tasks SET analysis_json = ? WHERE id = ?').run(JSON.stringify(state), t.id);
    const r = await renderTicket(db, t.id, {});
    expect(JSON.parse(r.verification_steps)).toEqual([`check:${unit.id}`, `check:${lint.id}`, `check:${TICKET_REPRO_CHECK_ID}`]);
    expect(r.plan_ref).not.toBe(t.plan_ref);
    expect(fs.existsSync(t.plan_ref!)).toBe(false); // the old plan file is replaced, not left behind
  });
});

describe('the job itself', () => {
  it('one analysis in flight per ticket: a second call asks for one more run after it', async () => {
    let n = 0;
    let p2: Promise<void> | null = null;
    const t = createTicket(db, { description: DESC, repo_id: repo.id }, who);
    const chat: typeof chatLocal = async (_db, req) => {
      if (req.system === PROPOSE_SYSTEM) {
        n += 1;
        // the description changes while the first run is asking the model
        if (n === 1) p2 = analyseTicket(db, t.id, { checks: null, localChat: chat });
      }
      return { ok: false, reason: 'not_ready', detail: 'x' };
    };
    const p1 = analyseTicket(db, t.id, { checks: null, localChat: chat });
    expect(getTask(db, t.id)!.analysis_status).toBe('pending'); // at once, before any work
    // asked again before the work began: the one run reads the latest anyway
    expect(analyseTicket(db, t.id, { checks: null, localChat: chat })).toBe(p1);
    expect(analysisInFlight(t.id)).toBe(true);
    await awaitAnalysis(t.id);
    expect(p2).toBe(p1);
    expect(n).toBe(2);
    expect(analysisInFlight(t.id)).toBe(false);
  });

  it('never throws: a missing clone or a model that throws ends as failed / rules', async () => {
    const boom: typeof chatLocal = async () => {
      throw new Error('socket hang up');
    };
    const t = await analysed(DESC, { checks: null, localChat: boom });
    expect(t.analysis_status).toBe('ready');
    expect(ticketView(db, t, who).analysis!.steps.find((s) => s.key === 'propose')!.detail).toContain('規則分析');

    fs.rmSync(repo.local_path, { recursive: true, force: true });
    const t2 = createTicket(db, { description: DESC, repo_id: repo.id }, who);
    await analyseTicket(db, t2.id, { checks: null, localChat: noModel });
    const v = ticketView(db, getTask(db, t2.id)!, who);
    expect(v.analysis_status).toBe('failed');
    expect(v.analysis!.error).toContain('本機複本不見了');
  });

  it('a ticket whose analysis died with the engine reads as failed', () => {
    const t = createTicket(db, { description: DESC, repo_id: repo.id }, who);
    db.prepare("UPDATE tasks SET analysis_status = 'running', analysis_json = ? WHERE id = ?").run(JSON.stringify({ heartbeat_at: '2026-01-01T00:00:00.000Z', steps: [{ key: 'map', state: 'running' }] }), t.id);
    const v = ticketView(db, getTask(db, t.id)!, who);
    expect(v.analysis_status).toBe('failed');
    expect(v.analysis!.error).toContain('重試');
    expect(v.analysis!.steps[0]!.state).toBe('failed');
  });
});

describe('parsing the proposal', () => {
  it('takes JSON with prose around it, drops what is invented, and nulls what is missing', () => {
    const cands = [{ file: 'src/a.cpp', score: 3, clues: ['x'], evidence: [{ line: 3, text: 'x()', clue: 'x' }], recent: ['abc fix'] }];
    const p = parseProposal(`好的，分析如下：\n${JSON.stringify({ kind: 'nope', causes: [{ file: './src/a.cpp:3', why: 'w' }, { file: '/etc/passwd' }, { file: '../x' }], repro: { mode: 'command', command: '', test_file: 'tests/t.py', description: 'd' } })}\n以上。`, { repoPath: '/nonexistent', candidates: cands });
    expect(p).toMatchObject({ kind: null, title: null, complexity: null, questions: [] });
    expect(p!.causes).toEqual([{ file: 'src/a.cpp', symbol: null, why: 'w', evidence: [{ line: 3, text: 'x()' }], recent: ['abc fix'] }]);
    expect(p!.repro).toEqual({ mode: 'new_test', command: null, test_file: 'tests/t.py', description: 'd', before: null }); // a command mode without a command
    expect(parseProposal('no json here', { repoPath: '/x', candidates: [] })).toBeNull();
  });

  it('reads the symbol index back out of a saved map', () => {
    const md = renderRepoMap('cf-aoi', buildRepoMap(repo.local_path), 200_000);
    expect(symbolsFromMap(md)).toContainEqual({ file: 'src/control/recipe_loader.cpp', name: 'apply_recipe', line: 4, kind: 'function' });
  });
});

describe('typedReproCommand', () => {
  it('reads a 「重現：」 line the person typed, and nothing that reads like a sentence', async () => {
    const { typedReproCommand } = await import('../intake/analyse.js');
    expect(typedReproCommand('會當掉。\n重現：./repro.sh')).toBe('./repro.sh');
    expect(typedReproCommand('重現指令: `python3 -m pytest tests/test_x.py -k zero`')).toBe('python3 -m pytest tests/test_x.py -k zero');
    expect(typedReproCommand('- repro: make check')).toBe('make check');
    expect(typedReproCommand('重現：開啟程式後按下開始')).toBeNull();
    expect(typedReproCommand('沒有重現指令')).toBeNull();
  });
});
