import type Database from 'better-sqlite3';
import { listChecks, type Check } from '../checks/store.js';
import { assignMetricPrefixes, renderChecks, snapshotCheck, type CheckSnapshot } from '../checks/render.js';
import { parseAcceptance } from '../orchestrator/acceptance.js';
import type { Repo } from '../repo/store.js';
import type { CheckRow, Repro, TicketChecks } from './analyse.js';

/**
 * The 問題單's 驗收清單 from the repo's 檢查 (src/checks/*): every enabled required check, the
 * optional ones the person did not untick, and — when the analysis found an existing repro command
 * and the repo has no 重現 check of its own — a 重現 check made for this ticket only (it lives in the
 * task's frozen copy, never in the repo's table). Null when the repo has no enabled checks: the
 * analysis then falls back to the repo's detected build / test commands.
 */

/** the id of the ticket-only 重現 check (a valid `check:` step id; never a row of `checks`) */
export const TICKET_REPRO_CHECK_ID = 'ck_ticket_repro';

const OP: Record<string, string> = { '>=': '不低於', '<=': '不超過', '==': '等於', '!=': '不等於', '>': '大於', '<': '小於' };
const METRIC_LABEL: Record<string, string> = { correct_rate: '正確率', time_ms: '時間（ms）', mismatches: '不一致', missing: '沒有輸出', total: '總數' };

/** 怎麼算過, in words: 「exit 0」「正確率不低於 0.987、時間（ms）不超過 5300」… */
export function ruleText(s: CheckSnapshot): string {
  if (s.kind === 'manual') return '人工確認';
  if (s.kind === 'repro' && s.red_on_base) return '修改前失敗、修改後通過';
  let specs: ReturnType<typeof parseAcceptance> = [];
  try {
    specs = parseAcceptance(s.thresholds);
  } catch {
    specs = [];
  }
  if (specs.length) return specs.map((sp) => `${METRIC_LABEL[sp.name] ?? sp.name}${OP[sp.op] ?? sp.op} ${sp.target}`).join('、');
  if (s.pass_rule === 'baseline') return '不比基準差（還沒有基準：先試跑一次並設為基準）';
  return 'exit 0';
}

function rowOf(s: CheckSnapshot, on: boolean): CheckRow {
  return { id: s.id, name: s.name, kind: s.kind, machine: s.machine, command: s.command, required: s.required, on, rule: ruleText(s) };
}

function ticketRepro(repo: Repo, repro: Repro, ord: number): CheckSnapshot {
  return {
    id: TICKET_REPRO_CHECK_ID,
    repo_id: repo.id,
    name: '重現',
    kind: 'repro',
    machine: repo.machine,
    command: repro.command,
    pass_rule: 'exit0',
    metrics: null,
    thresholds: null,
    baseline: null,
    baseline_tol: 0.1,
    dataset: null,
    test_globs: [],
    test_files: repro.test_file ? [repro.test_file] : [],
    red_on_base: true,
    timeout_min: null,
    required: true,
    ord,
    protected_paths: [],
    artifacts: [],
    manual_text: null,
    metric_prefix: null,
  };
}

export const repoTicketChecks: TicketChecks = {
  select(db: Database.Database, repo: Repo, o: { kind: string; repro: Repro | null; off: string[] }) {
    const all: Check[] = listChecks(db, repo.id).filter((c) => c.enabled);
    if (!all.length) return null;
    const off = new Set(o.off);
    const chosen = all.filter((c) => c.required || !off.has(c.id));
    let snap = chosen.map((c) => snapshotCheck(db, c));
    // the test file the analysis proposes rides onto base with the repo's own 重現 check
    if (o.repro?.test_file) snap = snap.map((s) => (s.kind === 'repro' ? { ...s, test_files: [...new Set([...(s.test_files ?? []), o.repro!.test_file!])] } : s));
    if (o.repro?.mode === 'command' && o.repro.command && !snap.some((s) => s.kind === 'repro')) {
      snap.push(ticketRepro(repo, o.repro, Math.max(0, ...all.map((c) => c.ord)) + 1));
    }
    snap = assignMetricPrefixes(snap);
    const byId = new Map(snap.map((s) => [s.id, s]));
    const view: CheckRow[] = [
      ...all.map((c) => {
        const s = byId.get(c.id);
        return s ? rowOf(s, true) : rowOf(snapshotCheck(db, c), false);
      }),
      ...snap.filter((s) => s.id === TICKET_REPRO_CHECK_ID).map((s) => rowOf(s, true)),
    ];
    return { snapshot: snap, fields: renderChecks(snap), view };
  },
};
