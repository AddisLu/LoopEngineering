import type Database from 'better-sqlite3';
import { getNum } from '../db/index.js';
import { getTask } from '../tasks.js';
import { armIterations, type IterationSummary } from '../benchmark/attempts.js';
import type { Task } from '../types.js';

/**
 * A task's run history for the 工作流程 canvas: every attempt (with what its verification found and
 * how long each part took), the task's event log, and where each stage of the lifecycle stands —
 * 需求 → 準備環境 → AI 實作 → 驗證 → 驗收門檻 → 人工核可 → 合併 → 結案, the order runTask walks.
 */

export type StageKey = 'trigger' | 'setup' | 'implement' | 'verify' | 'gate' | 'approve' | 'merge' | 'done';
/** idle: not reached · active: happening now · ok: done · fail: stopped here · warn: waiting on something · skip: not part of this task */
export type StageState = 'idle' | 'active' | 'ok' | 'fail' | 'warn' | 'skip';

export interface TaskEventRow {
  id: number;
  run_id: string | null;
  kind: string;
  from_status: string | null;
  to_status: string | null;
  detail: string | null;
  created_at: string;
}

export interface TaskHistory {
  task: Pick<
    Task,
    'id' | 'title' | 'status' | 'merge_status' | 'verify_mode' | 'model' | 'coding_tool' | 'benchmark_id' | 'depends_on' | 'pr_url' | 'approved_at' | 'resume_count' | 'setup_cmd'
  >;
  iterations: IterationSummary;
  /** oldest first, the latest 300 */
  events: TaskEventRow[];
  stages: Record<StageKey, StageState>;
  /** the stage a person should look at: where it runs, or where it stopped */
  focus: StageKey;
  /** the 自動續跑 budget the gate's fail edge spends (the global max_resumes) */
  retry: { used: number; max: number };
  /** a run in flight right now (its started_at), null when idle */
  active_run: { id: string; started_at: string } | null;
  /** the last status change's reason ("verify failed at: …", "watchdog timeout", …) */
  last_detail: string | null;
  /** an epic's subtasks (the chain its planner made), in order; empty for any other task */
  children: Array<Pick<Task, 'id' | 'title' | 'status' | 'merge_status'>>;
}

const manualMode = (t: Pick<Task, 'verify_mode'>) =>
  String(t.verify_mode || '')
    .split(',')
    .map((m) => m.trim())
    .includes('manual');

/** Which stage an 'attention' / 'failed' reason points at. */
export function failedStage(detail: string | null): StageKey {
  const d = detail ?? '';
  if (/^setup_cmd failed|workspace error/i.test(d)) return 'setup';
  if (/^verify failed|protected|保護路徑|驗收指標/i.test(d)) return 'gate';
  if (/merge|conflict|衝突/i.test(d)) return 'merge';
  return 'implement';
}

/**
 * Where each stage stands, read off the task's status, its last status reason and whether a run is
 * in flight. Pure, so the canvas and the tests agree on one reading.
 */
export function stagesFor(
  t: Pick<Task, 'status' | 'merge_status' | 'verify_mode' | 'approved_at' | 'setup_cmd' | 'coding_tool'>,
  lastDetail: string | null,
  runActive: boolean,
): { stages: Record<StageKey, StageState>; focus: StageKey } {
  const st: Record<StageKey, StageState> = {
    trigger: 'ok',
    setup: 'idle',
    implement: 'idle',
    verify: 'idle',
    gate: 'idle',
    approve: manualMode(t) ? 'idle' : 'skip',
    merge: t.coding_tool === 'generic' ? 'skip' : 'idle',
    done: 'idle',
  };
  const upTo = (key: StageKey, state: StageState = 'ok') => {
    for (const k of ORDER) {
      if (k === key) break;
      if (st[k] !== 'skip') st[k] = 'ok';
    }
    if (st[key] !== 'skip') st[key] = state;
  };
  let focus: StageKey = 'trigger';
  switch (t.status) {
    case 'draft':
      st.trigger = 'warn';
      break;
    case 'queued':
    case 'ready':
      if (runActive) {
        upTo('setup', 'active');
        focus = 'setup';
      } else st.trigger = 'warn'; // waiting for its turn (usage, window, an upstream task)
      break;
    case 'running':
      upTo('implement', 'active');
      focus = 'implement';
      break;
    case 'verifying':
      upTo('verify', 'active');
      focus = 'verify';
      break;
    case 'blocked': {
      // sent back by the gate (自動續跑) or paused by the usage breaker / window / pause
      if (/^verify failed/i.test(lastDetail ?? '')) {
        upTo('gate', 'fail');
        st.implement = 'warn';
        focus = 'gate';
      } else {
        upTo('implement', 'warn');
        focus = 'implement';
      }
      break;
    }
    case 'attention':
    case 'failed': {
      const where = t.status === 'failed' && /aborted/i.test(lastDetail ?? '') ? 'implement' : failedStage(lastDetail);
      upTo(where, 'fail');
      focus = where;
      break;
    }
    case 'review': {
      upTo('gate');
      if (st.approve !== 'skip') st.approve = t.approved_at ? 'ok' : 'active';
      if (st.merge !== 'skip') {
        st.merge = t.merge_status === 'merged' ? 'ok' : t.merge_status === 'conflict' ? 'fail' : 'warn';
      }
      focus = st.approve === 'active' ? 'approve' : st.merge === 'fail' || st.merge === 'warn' ? 'merge' : 'done';
      if (focus === 'done') st.done = 'warn'; // merged; 結案 releases what depends on it
      break;
    }
    case 'closed':
      for (const k of ORDER) if (st[k] !== 'skip') st[k] = 'ok';
      if (st.approve !== 'skip' && !t.approved_at) st.approve = 'skip';
      focus = 'done';
      break;
  }
  return { stages: st, focus };
}

const ORDER: StageKey[] = ['trigger', 'setup', 'implement', 'verify', 'gate', 'approve', 'merge', 'done'];

export function taskHistory(db: Database.Database, id: string): TaskHistory | null {
  const t = getTask(db, id);
  if (!t) return null;
  const events = (
    db
      .prepare('SELECT id, run_id, kind, from_status, to_status, detail, created_at FROM task_events WHERE task_id = ? ORDER BY id DESC LIMIT 300')
      .all(id) as TaskEventRow[]
  ).reverse();
  const lastStatus = [...events].reverse().find((e) => e.kind === 'status' && e.detail);
  const active = db
    .prepare('SELECT id, started_at FROM task_runs WHERE task_id = ? AND finished_at IS NULL ORDER BY started_at DESC, rowid DESC LIMIT 1')
    .get(id) as { id: string; started_at: string } | undefined;
  const lastDetail = lastStatus?.detail?.split('\n')[0]?.slice(0, 300) ?? null;
  const { stages, focus } = stagesFor(t, lastDetail, !!active);
  return {
    task: {
      id: t.id,
      title: t.title,
      status: t.status,
      merge_status: t.merge_status,
      verify_mode: t.verify_mode,
      model: t.model,
      coding_tool: t.coding_tool,
      benchmark_id: t.benchmark_id,
      depends_on: t.depends_on,
      pr_url: t.pr_url,
      approved_at: t.approved_at,
      resume_count: t.resume_count,
      setup_cmd: t.setup_cmd,
    },
    iterations: armIterations(db, id),
    events,
    stages,
    focus,
    retry: { used: t.resume_count ?? 0, max: getNum(db, 'max_resumes', 2) },
    active_run: active ?? null,
    last_detail: lastDetail,
    children:
      t.coding_tool === 'plan'
        ? (db.prepare('SELECT id, title, status, merge_status FROM tasks WHERE parent_id = ? ORDER BY created_at, rowid').all(id) as TaskHistory['children'])
        : [],
  };
}
