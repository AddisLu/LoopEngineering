import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { openTestDb, setSetting } from '../db/index.js';
import { paths } from '../config.js';
import { getTask } from '../tasks.js';
import { createRepo, updateRepo, type Repo } from '../repo/store.js';
import type { GiteaClient } from '../git/gitea.js';
import { analyseTicket, readAnalysis } from '../intake/analyse.js';
import { approvalMode, isManager } from '../intake/roles.js';
import {
  appendAnswers,
  approveStart,
  cancelTicket,
  createTicket,
  listTickets,
  patchTicket,
  rejectStart,
  startTicket,
  TicketError,
  ticketFromIssue,
  ticketView,
  withdrawStart,
} from '../intake/ticket.js';
import { boardState } from '../server/board.js';

/** 問題單 core: create (screenshots on disk), validation, cancel, and who may start it. */

let db: Database.Database;
let root: string;
let repo: Repo;
const eng = { user_key: 'name:eng', label: 'Eng' };
const boss = { user_key: 'ts:boss@corp', label: 'Boss' };
const DESC = '第二次載入配方後 bypass_edge_x 沒有套用新值，畫面上還是舊的。';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const png = `data:image/png;base64,${PNG.toString('base64')}`;
const jpg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]).toString('base64')}`;
const noModel = async () => ({ ok: false as const, reason: 'not_ready' as const, detail: 'x' });
const count = () => (db.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n;

beforeEach(() => {
  db = openTestDb();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loop-ticket-')));
  const dir = path.join(root, 'cf-aoi');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'loader.cpp'), 'void apply_recipe() {\n}\n');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  repo = createRepo(db, { name: 'cf-aoi', remote_url: 'http://gitea.corp/aoi/cf-aoi.git', gitea_owner: 'aoi', gitea_repo: 'cf-aoi', local_path: dir, domain: 'cpp', build_cmd: 'echo build', test_cmd: 'echo test' });
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function ready(by = eng): Promise<string> {
  const t = createTicket(db, { description: DESC, repo_id: repo.id }, by);
  await analyseTicket(db, t.id, { checks: null, localChat: noModel });
  expect(getTask(db, t.id)!.analysis_status).toBe('ready');
  return t.id;
}

describe('createTicket', () => {
  it('a draft task with the intake, the repo fields and the screenshots on disk', () => {
    const t = createTicket(db, { description: `${DESC}\n第二行補充`, repo_id: repo.id, priority: 3, kind: 'bugfix', images: [png, { data_url: jpg, name: 'C:\\shots\\畫面.jpg' }] }, eng);
    expect(t).toMatchObject({
      status: 'draft',
      title: DESC.slice(0, 60),
      goal: `${DESC}\n第二行補充`,
      repo_id: repo.id,
      repo_path: repo.local_path,
      base_branch: 'main',
      domain: 'cpp',
      priority: 3,
      owner: 'name:eng',
      created_by: 'name:eng',
      analysis_status: 'pending',
      coding_tool: 'claude-code',
    });
    expect(JSON.parse(t.intake_json!)).toMatchObject({ description: `${DESC}\n第二行補充`, kind_hint: 'bugfix', from: 'ui', title: null, created_label: 'Eng' });
    const imgs = JSON.parse(t.images_json!) as { file: string; name: string; mime: string; bytes: number }[];
    expect(imgs.map((i) => [path.relative(paths.taskImagesDir, i.file), i.name, i.mime, i.bytes])).toEqual([
      [path.join(t.id, '0.png'), '截圖 1.png', 'image/png', PNG.length],
      [path.join(t.id, '1.jpg'), '畫面.jpg', 'image/jpeg', 6],
    ]);
    expect(fs.readFileSync(imgs[0]!.file)).toEqual(PNG);
    const v = ticketView(db, t, eng);
    expect(v.images).toEqual([
      { n: 0, name: '截圖 1.png', mime: 'image/png', text: '', via: 'none' },
      { n: 1, name: '畫面.jpg', mime: 'image/jpeg', text: '', via: 'none' },
    ]);
    expect(v).toMatchObject({ kind: 'bugfix', analysis_status: 'pending', approval_mode: 'self', approval_state: null, can_approve: false, repo: { id: repo.id, name: 'cf-aoi' }, branch: 'main', issue: null });
    expect(v.analysis!.steps.every((s) => s.state === 'todo')).toBe(true);
    expect(listTickets(db, { mine: 'name:eng' }).map((s) => [s.id, s.repo_name])).toEqual([[t.id, 'cf-aoi']]);
    expect(listTickets(db, { mine: 'name:other' })).toEqual([]);
  });

  it('refuses bad input with a 400 and writes nothing', () => {
    const bad = (input: Record<string, unknown>, msg: RegExp) => {
      let err: unknown;
      try {
        createTicket(db, { description: DESC, repo_id: repo.id, ...input }, eng);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TicketError);
      expect((err as TicketError).status).toBe(400);
      expect((err as TicketError).message).toMatch(msg);
    };
    bad({ description: '太短了' }, /至少 10/);
    bad({ repo_id: 'r_nope' }, /沒有這個 repo/);
    bad({ priority: 5 }, /優先/);
    bad({ kind: 'epic' }, /類型/);
    bad({ model: 'local:nope' }, /本地模型/);
    bad({ branch: '--force' }, /分支/);
    bad({ title: 'x'.repeat(200) }, /標題太長/);
    bad({ images: ['data:image/svg+xml;base64,PHN2Zz4='] }, /PNG/);
    bad({ images: Array(7).fill(png) }, /最多 6/);
    bad({ images: [`data:image/png;base64,${Buffer.alloc(4 * 1024 * 1024 + 10).toString('base64')}`] }, /超過 4 MB/);
    updateRepo(db, repo.id, { enabled: false });
    bad({}, /停用/);
    expect(count()).toBe(0);
  });

  it('cancel removes the task, its plan and its screenshots — only before it started', async () => {
    const t = createTicket(db, { description: DESC, repo_id: repo.id, images: [png] }, eng);
    const dir = path.dirname((JSON.parse(t.images_json!) as { file: string }[])[0]!.file);
    expect(fs.existsSync(dir)).toBe(true);
    cancelTicket(db, t.id, eng);
    expect(getTask(db, t.id)).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(false);

    const id = await ready();
    const plan = getTask(db, id)!.plan_ref!;
    startTicket(db, id, eng);
    expect(() => cancelTicket(db, id, eng)).toThrow(/已經開始/);
    expect(fs.existsSync(plan)).toBe(true);
  });
});

describe('roles', () => {
  it('manager_users matches like ops_allowed_users: whole entries, any case', () => {
    expect(approvalMode(db)).toBe('self');
    setSetting(db, 'manager_users', 'ts:Boss@corp, name:lead,local');
    expect(isManager(db, 'ts:boss@corp')).toBe(true);
    expect(isManager(db, 'name:LEAD')).toBe(true);
    expect(isManager(db, 'local')).toBe(true);
    expect(isManager(db, 'name:lea')).toBe(false);
    expect(isManager(db, null)).toBe(false);
    setSetting(db, 'approval_mode', 'manager');
    expect(approvalMode(db)).toBe('manager');
  });

  it('self mode: whoever opened it starts it; it must be analysed first', async () => {
    const t = createTicket(db, { description: DESC, repo_id: repo.id }, eng);
    expect(() => startTicket(db, t.id, eng)).toThrow(/分析/);
    const id = await ready();
    const started = startTicket(db, id, eng);
    expect(started.status).toBe('queued');
    expect(started.approval_state).toBeNull();
    expect(() => approveStart(db, id, eng)).toThrow(TicketError);
  });

  it('manager mode: a request waits for a manager, who approves or sends it back', async () => {
    setSetting(db, 'approval_mode', 'manager');
    setSetting(db, 'manager_users', 'ts:boss@corp');
    const id = await ready();
    let t = startTicket(db, id, eng);
    expect(t).toMatchObject({ status: 'draft', approval_state: 'awaiting' });
    expect(ticketView(db, t, eng).can_approve).toBe(false);
    expect(ticketView(db, t, boss).can_approve).toBe(true);
    // the inbox gets 待核可（開工）: who asked
    expect(boardState(db).cards.find((c) => c.id === id)).toMatchObject({ approval_state: 'awaiting', requested_by: 'Eng', ticket: true });

    let err: unknown;
    try {
      approveStart(db, id, eng);
    } catch (e) {
      err = e;
    }
    expect((err as TicketError).status).toBe(403);

    t = rejectStart(db, id, boss, '先確認是不是配方檔本身的問題');
    expect(t).toMatchObject({ status: 'draft', approval_state: 'rejected' });
    expect(ticketView(db, t, eng).analysis!.questions[0]).toBe('主管退回（Boss）：先確認是不是配方檔本身的問題');

    t = startTicket(db, id, eng); // sent again
    expect(t.approval_state).toBe('awaiting');
    expect(readAnalysis(t)!.rejection).toBeNull();
    t = withdrawStart(db, id, eng);
    expect(t.approval_state).toBeNull();
    startTicket(db, id, eng);
    t = approveStart(db, id, boss);
    expect(t).toMatchObject({ status: 'queued', approval_state: 'approved', start_approved_by: 'Boss' });
    expect(t.start_approved_at).toBeTruthy();
    expect(t.approved_by ?? null).toBeNull(); // 驗收核可 is a different thing

    // a manager starting one directly approves it themselves
    const id2 = await ready(boss);
    expect(startTicket(db, id2, boss)).toMatchObject({ status: 'queued', approval_state: 'approved', start_approved_by: 'Boss' });
  });

  it('the gate still decides: a ticket that cannot run is refused with the reasons', async () => {
    db.prepare('UPDATE repos SET build_cmd = NULL, test_cmd = NULL WHERE id = ?').run(repo.id);
    const id = await ready();
    let err: unknown;
    try {
      startTicket(db, id, eng);
    } catch (e) {
      err = e;
    }
    expect((err as TicketError).status).toBe(409);
    expect((err as TicketError).message).toContain('沒有可以自動跑的驗證');
    expect(getTask(db, id)!.status).toBe('draft');
  });
});

describe('edits', () => {
  it('a new description or answers re-run the analysis; card edits re-render; nothing after it started', async () => {
    const id = await ready();
    const t = getTask(db, id)!;
    expect(patchTicket(db, id, { priority: 1, model: '' }, eng).next).toBeNull();
    expect(patchTicket(db, id, { causes: [{ file: 'src/loader.cpp', symbol: 'apply_recipe', why: '我覺得是這裡' }] }, eng).next).toBe('render');
    expect(readAnalysis(getTask(db, id)!)!.causes).toEqual([{ file: 'src/loader.cpp', symbol: 'apply_recipe', why: '我覺得是這裡', evidence: [], recent: [expect.stringContaining('init')] }]);
    expect(() => patchTicket(db, id, { causes: [{ file: 'src/nope.cpp', why: 'x' }] }, eng)).toThrow(/沒有這個檔案/);
    expect(() => patchTicket(db, id, { repro: { mode: 'command', command: '' } }, eng)).toThrow(/要填指令/);
    const r = patchTicket(db, id, { repro: { mode: 'command', command: 'make repro', description: '跑一次' } }, eng);
    expect(readAnalysis(r.task)!.repro_by).toBe('person');
    const answered = patchTicket(db, id, { answers: ['只有新格式'] }, eng);
    expect(answered.next).toBe('analyse');
    expect(answered.task.goal).toBe(`${t.goal}\n\n（回答 Loop 的問題）\n補充：只有新格式`);
    expect(appendAnswers('d', ['a', ''], ['q1', 'q2'])).toBe('d\n\n（回答 Loop 的問題）\n問：q1\n答：a');
    startTicket(db, id, eng);
    expect(() => patchTicket(db, id, { priority: 2 }, eng)).toThrow(/已經開始/);
  });
});

describe('Gitea issue → 問題單', () => {
  const fakeClient = (calls: string[]): GiteaClient =>
    ({
      async getIssue(owner: string, name: string, n: number) {
        calls.push(`${owner}/${name}#${n}`);
        return {
          ok: true,
          data: {
            number: n,
            title: '配方第二次載入沒生效',
            body: '步驟：載入兩次 recipe A',
            state: 'open',
            html_url: `http://gitea.corp/${owner}/${name}/issues/${n}`,
            labels: [],
            user: 'eng',
            assets: [
              { id: 1, name: 'shot.png', size: PNG.length, browser_download_url: 'http://gitea.corp/attachments/1' },
              { id: 2, name: 'log.txt', size: 10, browser_download_url: 'http://gitea.corp/attachments/2' },
            ],
            created_at: null,
            updated_at: null,
          },
        };
      },
      async downloadAsset() {
        return { ok: true, data: PNG };
      },
    }) as unknown as GiteaClient;

  it('one ticket per issue, with the body as description and the pictures as screenshots', async () => {
    const calls: string[] = [];
    const r = await ticketFromIssue(db, { owner: 'aoi', repo: 'cf-aoi', number: 12 }, eng, { client: fakeClient(calls) });
    expect(r.created).toBe(true);
    expect(r.task).toMatchObject({ title: '配方第二次載入沒生效', source_ref: 'gitea:aoi/cf-aoi#12', repo_id: repo.id });
    const v = ticketView(db, r.task, eng);
    expect(v.description).toBe('配方第二次載入沒生效\n\n步驟：載入兩次 recipe A');
    expect(v.issue).toEqual({ number: 12, url: 'http://gitea.corp/aoi/cf-aoi/issues/12' });
    expect(v.images.map((i) => i.name)).toEqual(['shot.png']);
    expect(JSON.parse(r.task.intake_json!).from).toBe('issue');
    expect(db.prepare('SELECT owner, repo, number FROM issue_links WHERE task_id = ?').get(r.task.id)).toEqual({ owner: 'aoi', repo: 'cf-aoi', number: 12 });

    const again = await ticketFromIssue(db, { owner: 'aoi', repo: 'cf-aoi', number: 12 }, eng, { client: fakeClient(calls) });
    expect(again).toMatchObject({ created: false, task: { id: r.task.id } });
    expect(calls).toEqual(['aoi/cf-aoi#12']); // the second time never asks Gitea

    await expect(ticketFromIssue(db, { owner: 'aoi', repo: 'other', number: 1 }, eng, { client: fakeClient(calls) })).rejects.toMatchObject({ status: 409 });
  });
});
