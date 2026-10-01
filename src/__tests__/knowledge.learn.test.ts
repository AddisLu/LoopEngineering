import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { createTask, createRun, getTask, updateRun, setStatus } from '../tasks.js';
import { learnFromTask, matchPitfalls, matchPlaybooks, readMeta, recordHits, seenBefore, taskStory, upsertLearned } from '../knowledge/learn.js';
import { writeResumeContext } from '../orchestrator/prompt.js';
import { selectKnowledge } from '../knowledge/context.js';
import { repoScope } from '../knowledge/types.js';

let db: Database.Database;
let repo: string;
beforeEach(() => {
  db = openTestDb();
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'learn-repo-'));
});
afterEach(() => {
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
});

const ANSWER = JSON.stringify({
  pitfalls: [{ title: 'ip/ 的成員變數要用 m_ 前綴', symptom: "error C2065: 'm_width': undeclared identifier", cause: 'config_parser.h 的欄位改名後 kernel 端沒跟著改', avoid: '改 ZoneConfig 欄位時同步改 cuda/zone_kernel.cu', words: ['C2065', 'm_width'], files: ['ip/src/config/config_parser.h'] }],
  playbooks: [{ title: '參數讀不到時先查 config_parser', problem: 'ini 參數沒生效', steps: ['在 config_parser.h 找 key', '確認 section', '跑 ctest -R config'], verify: 'ctest 全綠', files: ['ip/src/config/'] }],
});

function troubledTask() {
  const t = createTask(db, { title: '邊緣參數沒生效', goal: '改 pitch 讀取', coding_tool: 'mock', verification_steps: ['true'], repo_path: repo, base_branch: 'main' });
  const r1 = createRun(db, { task_id: t.id, worktree_path: repo, branch: 'x' });
  updateRun(db, r1.id, { model: 'local:qwen', verify_json: JSON.stringify([{ step: '建置', ok: false, exitCode: 2, timedOut: false, tail: "zone_kernel.cu(41): error C2065: 'm_width': undeclared identifier" }]) });
  db.prepare("UPDATE task_runs SET started_at = datetime('now', '-1 hour') WHERE id = ?").run(r1.id);
  const r2 = createRun(db, { task_id: t.id, worktree_path: repo, branch: 'x' });
  updateRun(db, r2.id, { model: 'local:glm', verify_json: JSON.stringify([{ step: '建置', ok: true, exitCode: 0, timedOut: false, tail: '' }]) });
  return getTask(db, t.id)!;
}

describe('解法與陷阱: learning from a run that did not go right first time', () => {
  it('off by default; a first-time success teaches nothing', async () => {
    const calls: string[] = [];
    const chat = async (_db: unknown, req: { user: string }) => (calls.push(req.user), { ok: true as const, content: ANSWER });
    expect(await learnFromTask(db, troubledTask(), 'merged', { localChat: chat as never })).toBeNull();
    setSetting(db, 'learn_from_runs', 'true');
    const clean = createTask(db, { title: 'x', goal: 'y', coding_tool: 'mock', verification_steps: ['true'], repo_path: repo });
    const r = createRun(db, { task_id: clean.id, worktree_path: repo, branch: 'x' });
    updateRun(db, r.id, { verify_json: JSON.stringify([{ step: 't', ok: true, exitCode: 0, timedOut: false, tail: '' }]) });
    expect(await learnFromTask(db, getTask(db, clean.id)!, 'merged', { localChat: chat as never })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('the history becomes draft pitfalls and playbooks of the repo; the same lesson adds evidence', async () => {
    setSetting(db, 'learn_from_runs', 'true');
    const t = troubledTask();
    const story = taskStory(db, t);
    expect(story.troubled).toBe(true);
    expect(story.lines.join('\n')).toContain("error C2065: 'm_width'");
    expect(story.lines).toContain('換模型：local:qwen → local:glm');
    let prompt = '';
    const chat = async (_db: unknown, req: { user: string }) => ((prompt = req.user), { ok: true as const, content: `好的\n${ANSWER}` });
    expect(await learnFromTask(db, t, 'merged', { localChat: chat as never })).toEqual({ pitfalls: 1, playbooks: 1 });
    expect(prompt).toContain('第 1 次（local:qwen）沒過「建置」');
    const nodes = db.prepare('SELECT * FROM knowledge_nodes ORDER BY kind').all() as Array<{ id: string; kind: string; status: string; source: string; scope: string; facet: string; meta_json: string; body: string }>;
    expect(nodes.map((n) => [n.kind, n.status, n.source, n.facet])).toEqual([
      ['pitfall', 'draft', 'learned', 'pitfall'],
      ['playbook', 'draft', 'learned', 'playbook'],
    ]);
    expect(nodes[0]!.scope).toBe(repoScope(repo));
    expect(nodes[0]!.body).toContain('避免：改 ZoneConfig 欄位時同步改');
    expect(readMeta(nodes[0]!)!.trigger.words).toEqual(['C2065', 'm_width']);
    // a second task with the same lesson: one node, two pieces of evidence
    const t2 = troubledTask();
    await learnFromTask(db, t2, 'returned', { localChat: chat as never });
    const again = db.prepare("SELECT meta_json FROM knowledge_nodes WHERE kind = 'pitfall'").all() as Array<{ meta_json: string }>;
    expect(again).toHaveLength(1);
    expect(readMeta(again[0]!)!.evidence.map((e) => e.task)).toEqual([t.id, t2.id]);
  });

  it('a 退回 note is part of the story', () => {
    const t = createTask(db, { title: 'x', goal: 'y', coding_tool: 'mock', verification_steps: ['true'], repo_path: repo });
    setStatus(db, t.id, 'queued', { detail: '退回修改（王）：命名要照 m_ 前綴' });
    expect(taskStory(db, getTask(db, t.id)!)).toMatchObject({ troubled: true, lines: ['退回修改（王）：命名要照 m_ 前綴'] });
  });
});

describe('using what was learned', () => {
  const scope = () => repoScope(repo);
  function seedApproved() {
    const p = upsertLearned(db, scope(), 'pitfall', 'ip/ 的成員變數要用 m_ 前綴', '會看到：C2065；避免：同步改 kernel', { trigger: { words: ['C2065', 'm_width'], files: ['ip/src/config/'], kinds: ['bugfix'] }, evidence: [{ task: 't_1' }] });
    const other = upsertLearned(db, scope(), 'pitfall', 'grab 端要先停相機', '會看到：MdigProcess timeout', { trigger: { words: ['MdigProcess'], files: ['grab/'], kinds: [] }, evidence: [{ task: 't_2' }] });
    const pb = upsertLearned(db, scope(), 'playbook', '參數讀不到時先查 config_parser', '步驟：1. 找 key', { trigger: { words: [], files: ['ip/src/config/'], kinds: ['bugfix'] }, evidence: [{ task: 't_1' }] });
    db.prepare("UPDATE knowledge_nodes SET status = 'approved'").run();
    return { p: p.id, other: other.id, pb: pb.id };
  }

  it('matches by error words, files and kind; drafts and other repos never match', () => {
    const ids = seedApproved();
    expect(matchPitfalls(db, repo, { text: "zone_kernel.cu(41): error C2065: 'm_width'" }).map((n) => n.id)).toEqual([ids.p]);
    expect(matchPitfalls(db, repo, { text: '相機逾時', files: ['grab/src/camera.cpp'] }).map((n) => n.id)).toEqual([ids.other]);
    expect(matchPlaybooks(db, repo, { text: 'pitch 參數沒生效', files: ['ip/src/config/config_parser.h'], kind: 'bugfix' }).map((n) => n.id)).toEqual([ids.pb]);
    db.prepare("UPDATE knowledge_nodes SET status = 'draft' WHERE id = ?").run(ids.p);
    expect(matchPitfalls(db, repo, { text: 'error C2065' })).toEqual([]);
    expect(matchPitfalls(db, '/somewhere/else', { text: 'MdigProcess' })).toEqual([]);
  });

  it('「這個錯誤以前見過」 goes into LOOP_RESUME_CONTEXT.md only with repo_profile_inject, and counts the showing', () => {
    const ids = seedApproved();
    const t = createTask(db, { title: 'x', goal: 'y', coding_tool: 'mock', verification_steps: ['true'], repo_path: repo });
    expect(seenBefore(db, t, '建置', "error C2065: 'm_width'")).toEqual([]);
    const plain = fs.readFileSync(writeResumeContext(repo, '建置', 'tail'), 'utf8');
    expect(fs.readFileSync(writeResumeContext(repo, '建置', 'tail', {}), 'utf8')).toBe(plain);
    setSetting(db, 'repo_profile_inject', 'true');
    const seen = seenBefore(db, t, '建置', "error C2065: 'm_width'");
    expect(seen).toEqual(['- **ip/ 的成員變數要用 m_ 前綴**：會看到：C2065；避免：同步改 kernel']);
    const body = fs.readFileSync(writeResumeContext(repo, '建置', 'tail', { seen }), 'utf8');
    expect(body).toContain('## 這個錯誤以前見過（這個 repo 學到的陷阱）');
    const meta = readMeta(db.prepare('SELECT meta_json FROM knowledge_nodes WHERE id = ?').get(ids.p) as { meta_json: string })!;
    expect(meta.hits).toEqual({ shown: 1, passed: 0 });
    recordHits(db, [ids.p], true);
    expect(readMeta(db.prepare('SELECT meta_json FROM knowledge_nodes WHERE id = ?').get(ids.p) as { meta_json: string })!.hits).toEqual({ shown: 1, passed: 1 });
  });

  it('facet nodes stay out of the generic Knowledge section', () => {
    seedApproved();
    db.prepare("INSERT INTO knowledge_nodes (id, kind, title, body, scope, status) VALUES ('k_plain', 'fact', 'CF-AOI 用 8160 寬的影像', '寬 8160', ?, 'approved')").run(scope());
    const t = createTask(db, { title: 'C2065 m_width 影像', goal: 'y', coding_tool: 'mock', verification_steps: ['true'], repo_path: repo });
    const sel = selectKnowledge(db, t);
    expect(sel.items.map((i) => i.id)).toEqual(['k_plain']);
  });
});

describe('全覽: links derived from facet nodes', () => {
  it('pitfall → module by directory, pitfall → playbook by shared files', async () => {
    const { facetEdges } = await import('../knowledge/store.js');
    const n = (id: string, kind: string, meta: unknown) => ({ id, kind, facet: kind, scope: 'repo:/r', meta_json: JSON.stringify(meta) }) as never;
    const edges = facetEdges([
      n('k_mod', 'module', { evidence: [{ file: 'ip/src/main.cpp' }] }),
      n('k_grab', 'module', { evidence: [{ file: 'grab/src/main.cpp' }] }),
      n('k_pit', 'pitfall', { trigger: { files: ['ip/src/config/'] } }),
      n('k_book', 'playbook', { trigger: { files: ['ip/src/config/config_parser.h'] } }),
    ]);
    expect(edges).toEqual(
      expect.arrayContaining([
        { src: 'k_pit', dst: 'k_mod', relation: 'applies-to' },
        { src: 'k_book', dst: 'k_mod', relation: 'applies-to' },
        { src: 'k_pit', dst: 'k_book', relation: 'solved-by' },
      ]),
    );
    expect(edges.some((e) => e.dst === 'k_grab')).toBe(false);
  });
});
