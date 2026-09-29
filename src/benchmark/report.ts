import type Database from 'better-sqlite3';
import { getNum } from '../db/index.js';
import { parseAcceptance } from '../orchestrator/acceptance.js';
import { getPlan } from '../plans/store.js';
import { benchmarkMatrix, getBenchmark, type BenchmarkArmView } from './store.js';
import { describeAttempt, missedChecks, type FinalMeasurement, type IterationSummary } from './attempts.js';

/**
 * One benchmark as a Markdown report: the verdict, one row per arm with the measured bar and how
 * the model got there, each arm's attempts and the judges' notes, and how the models stand on this
 * kind of software across every benchmark so far. Served by GET /api/benchmarks/:id/report.md and
 * `loop bench report`.
 */

const DOMAIN: Record<string, string> = { cuda: 'CUDA／GPU', cv: '影像處理', cpp: 'C++', csharp: 'C#', typescript: 'TypeScript', python: 'Python', other: '其他' };
const STATUS: Record<string, string> = { running: '進行中', judging: '評審中', judged: '已評分', judge_failed: '評審失敗', cancelled: '已取消' };
const OUTCOME: Record<string, string> = { pass: '通過', functional: '功能沒過', metrics: '指標未達', protected: '改了保護路徑', unverified: '沒跑到驗證' };

const cell = (v: unknown) => String(v ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const num = (v: unknown) => (typeof v === 'number' ? String(Math.round(v * 1000) / 1000) : v == null ? '—' : String(v));
const pct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const dur = (s: number | null | undefined) => (s == null ? '—' : s >= 3600 ? `${(s / 3600).toFixed(1)} 小時` : s >= 60 ? `${Math.round(s / 60)} 分` : `${s} 秒`);
const table = (head: string[], rows: unknown[][]) =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');

function parse<T>(s: string | null | undefined): T | null {
  try {
    return s ? (JSON.parse(s) as T) : null;
  } catch {
    return null;
  }
}

function finalCell(f: FinalMeasurement | null, own: string | null): string {
  if (f) return f.outcome === 'pass' ? '✅ 通過' : `❌ ${OUTCOME[f.outcome] ?? f.outcome}${f.outcome === 'metrics' ? `：${missedChecks(f.checks)}` : f.failed_step ? `（${f.failed_step}）` : ''}`;
  if (own === 'pass') return '✅ 通過（自己的驗證）';
  if (own === 'manual') return '需人工驗證';
  return own ? '❌ 沒通過（自己的驗證）' : '—';
}

export function benchmarkReport(db: Database.Database, id: string): string | null {
  const detail = getBenchmark(db, id);
  if (!detail) return null;
  const { benchmark: b, arms, judgements } = detail;
  let steps: string[] = [];
  try {
    steps = JSON.parse(b.verification_steps);
  } catch {
    /* ignore */
  }
  let specs: string[] = [];
  try {
    specs = parseAcceptance(b.acceptance_metrics).map((s) => s.name);
  } catch {
    /* shown as written */
  }
  const plan = b.verify_plan_id ? getPlan(db, b.verify_plan_id) : null;
  const ranked = [...arms].sort((x, y) => (x.judge_rank ?? 99) - (y.judge_rank ?? 99));
  const label = (a: BenchmarkArmView) => a.model_label || a.model;
  const final = (a: BenchmarkArmView) => parse<FinalMeasurement>(a.final_json);
  const iters = (a: BenchmarkArmView) => parse<IterationSummary>(a.attempts_json);
  const passed = ranked.filter((a) => a.verify_outcome === 'pass');
  const winner = arms.find((a) => a.model === b.winner);
  const out: string[] = [];

  out.push(`# 評比報告：${b.title}`, '');
  out.push(
    table(
      ['項目', '內容'],
      [
        ['評比', `\`${b.id}\` · ${DOMAIN[b.domain] ?? b.domain} · ${STATUS[b.status] ?? b.status}`],
        ['時間', `${b.created_at} 建立${b.judged_at ? ` → ${b.judged_at} 評審完成` : ''}`],
        ['評審模型', `${(b.judge_models || b.judge_model).split(',').join('、')}${b.consensus ? `（${b.consensus === 'unanimous' ? '意見一致' : b.consensus === 'split' ? '意見分歧' : '單一評審'}）` : ''}`],
        ['原始碼', b.repo_path ? `\`${b.repo_path}\` @ \`${b.base_branch ?? 'main'}\`` : '—'],
        ['驗證指令', steps.map((s) => `\`${s}\``).join('、') || '—'],
        ['驗收門檻', b.acceptance_metrics ? `\`${b.acceptance_metrics}\`` : '（沒有，只看驗證指令有沒有過）'],
        ['保護路徑', b.protected_paths ? b.protected_paths.split(',').map((s) => `\`${s}\``).join('、') : '—'],
        ['驗證方案', plan ? `${plan.name}（\`${plan.id}\`）` : '—'],
      ],
    ),
    '',
  );

  out.push('## 結論', '');
  if (b.status !== 'judged') out.push(`- 評比還沒評完（${STATUS[b.status] ?? b.status}）${b.error ? `：${b.error}` : ''}`);
  out.push(`- 勝出：${winner ? `**${label(winner)}**（\`${winner.model}\`）` : b.status === 'judged' ? '沒有（沒有參賽組通過門檻）' : '—'}`);
  out.push(`- 通過門檻：${passed.length}／${arms.length} 組${passed.length ? `（${passed.map(label).join('、')}）` : ''}`);
  if (b.summary) out.push('', b.summary.trim());
  out.push('');

  out.push('## 總表', '');
  out.push(
    table(
      ['名次', '模型', '最終量測', ...specs, '迭代', '評分', '輸出 token', '耗時'],
      ranked.map((a) => {
        const f = final(a);
        const values = f?.metrics ?? iters(a)?.attempts.at(-1)?.metrics ?? null;
        return [
          a.judge_rank ?? '—',
          `${label(a)}${a.model.startsWith('local:') ? '（本地）' : '（雲端）'}`,
          finalCell(f, a.verify_outcome),
          ...specs.map((s) => num(values?.[s])),
          iters(a)?.label ?? '—',
          a.judge_score ?? '—',
          a.tokens_out ?? '—',
          dur(a.duration_s),
        ];
      }),
    ),
    '',
  );

  out.push('## 各組細節', '');
  for (const a of ranked) {
    const f = final(a);
    const it = iters(a);
    out.push(`### ${a.judge_rank ?? '—'}. ${label(a)}（\`${a.model}\`）`, '');
    out.push(`- 最終量測：${finalCell(f, a.verify_outcome)}${f ? `（${f.measured_at}）` : ''}`);
    if (f?.metrics) {
      out.push('', table(['指標', '數值', '門檻'], Object.entries(f.metrics).map(([k, v]) => {
        const c = f.checks?.find((x) => x.name === k);
        return [k, num(v), c ? `${c.op} ${c.target} ${c.pass ? '✅' : '❌'}` : ''];
      })), '');
    }
    if (it?.attempts.length) {
      out.push(`- 迭代：${it.label}`, '');
      out.push(
        table(
          ['第幾次', '結果', '量到的指標', '自己試跑', '用 ncu'],
          it.attempts.map((t) => [
            t.attempt,
            describeAttempt(t),
            t.metrics ? Object.entries(t.metrics).map(([k, v]) => `${k}=${num(v)}`).join(', ') : '—',
            t.self_runs,
            t.profiler ? '有' : '沒有',
          ]),
        ),
        '',
      );
    }
    const scores = parse<{ mean?: Record<string, number> }>(a.scores_json)?.mean;
    if (scores) out.push(`- 評分：${a.judge_score ?? '—'}（正確性 ${scores.correctness}、完整度 ${scores.completeness}、程式品質 ${scores.code_quality}、遵循規格 ${scores.adherence}）`);
    if (a.notes) out.push(`- 評語：${a.notes.replace(/\n/g, ' ')}`);
    out.push(`- 用量：輸出 ${a.tokens_out ?? '—'} token，耗時 ${dur(a.duration_s)}；任務 \`${a.task_id}\`，分支 \`loop/${a.task_id}\``);
    if (a.diff_stat) out.push('', '```', a.diff_stat.trim(), '```');
    out.push('');
  }
  const failedJudges = judgements.filter((j) => j.error);
  if (failedJudges.length) out.push(`評審失敗：${failedJudges.map((j) => `${j.judge_model}（${j.error}）`).join('；')}`, '');

  const matrix = benchmarkMatrix(db, { domain: b.domain });
  if (matrix.length) {
    out.push(`## ${DOMAIN[b.domain] ?? b.domain} 類工作的累積戰績（所有已評分的評比）`, '');
    out.push(
      table(
        ['模型', '場數', '通過率', '一次就過', '平均第幾次過', '用 ncu', '平均分', '勝率'],
        matrix.map((m) => [
          `${m.model_label ?? m.model}${m.local ? '（本地）' : '（雲端）'}`,
          m.n,
          pct(m.verify_pass_rate),
          pct(m.first_try_rate),
          m.avg_passed_at ?? '—',
          pct(m.profiler_rate),
          m.avg_score ?? '—',
          pct(m.win_rate),
        ]),
      ),
      '',
    );
  }

  const tries = getNum(db, 'max_resumes', 2) + 1;
  out.push('## 量測方式', '');
  out.push(`- 每一組是同一個題目的獨立任務，由不同模型各做一次；結果不會合併回 base。`);
  out.push(`- 驗證沒過時，引擎會把失敗原因（含沒達標的指標）送回給模型再試，最多 ${tries} 次；「迭代」欄記錄第幾次才通過，以及是功能沒過還是指標沒達標。`);
  out.push('- 「自己試跑」是模型工作時自己在 GPU 沙盒執行程式的次數，「用 ncu」表示它自己跑過 Nsight Compute／nsys 來分析。');
  out.push('- 「最終量測」：所有參賽組都結束後，引擎用同一套驗證指令，依序一組一組重新量一次，避免某一組自己量的時候剛好和其他組的編譯或本地模型搶 GPU。排名以它為準，沒通過門檻的組不會排在通過的組前面。');
  out.push('- 評分是評審模型看過需求、各組 diff 與上述量測後給的 0–10 分（正確性、完整度、程式品質、遵循規格的平均）。');
  out.push('');
  return out.join('\n');
}
