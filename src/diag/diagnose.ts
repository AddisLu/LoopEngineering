import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { logEvent } from '../db/index.js';
import { getRepo, type Repo } from '../repo/store.js';
import { chatLocal } from '../local/chat.js';
import { repoScope } from '../knowledge/types.js';
import { matchPitfalls, renderLearned } from '../knowledge/learn.js';
import { diagSummaryText, iniDiff, parseDiag } from './parse.js';
import type { DiagInput, IniFile, ParsedDiag } from './types.js';

/**
 * 機況診斷: what a production machine produced → events (parse.ts) → code (the repo's 參數與告警
 * index, the src file:line an incident or a stack trace names) → past 機況案例 and learned 陷阱 →
 * the local model sorts the cause into 參數設定 / 環境・硬體 / 程式 bug / 資料 with evidence and
 * may suggest parameter values. Parameter suggestions are advice only: nothing here writes to a
 * machine or a config file. Without a served model the rules below still give a result.
 */

export type DiagCategory = 'param' | 'environment' | 'code' | 'data' | 'unknown';

export interface CodeRef {
  from: string;
  file: string;
  line: number | null;
  text: string | null;
}

export interface ParamChange {
  section: string;
  key: string;
  current: string | null;
  baseline: string | null;
  meaning: string | null;
  where: string[];
  baseline_file: string | null;
}

export interface DiagResult {
  category: DiagCategory;
  confidence: 'high' | 'medium' | 'low';
  summary: string;
  causes: Array<{ category: DiagCategory; title: string; why: string; evidence: string[] }>;
  code_refs: CodeRef[];
  params: ParamChange[];
  suggestions: Array<{ file: string | null; param: string; current: string | null; proposed: string; why: string; risk: string; verify: string }>;
  similar_cases: Array<{ id: string; title: string; body: string; score: number }>;
  pitfalls: Array<{ id: string; title: string; body: string }>;
  model_used: string | null;
}

export interface DiagReport {
  id: string;
  repo_id: string | null;
  source: string;
  created_by: string | null;
  note: string | null;
  inputs: Array<{ name: string; bytes: number }>;
  parsed: ParsedDiag | null;
  result: DiagResult | null;
  signature: string[];
  status: 'pending' | 'running' | 'ready' | 'failed';
  error: string | null;
  case_id: string | null;
  task_id: string | null;
  created_at: string;
}

interface Row {
  id: string;
  repo_id: string | null;
  source: string;
  created_by: string | null;
  inputs_json: string;
  parsed_json: string | null;
  result_json: string | null;
  signature: string | null;
  status: DiagReport['status'];
  case_id: string | null;
  task_id: string | null;
  created_at: string;
}

const MAX_TOTAL = 5 * 1024 * 1024;

function capParsed(p: ParsedDiag): ParsedDiag {
  return { ...p, events: p.events.slice(0, 300), incidents: p.incidents.slice(0, 120), errors: p.errors.slice(0, 120) };
}

function toReport(r: Row): DiagReport {
  const j = <T>(s: string | null, d: T): T => {
    try {
      return s ? (JSON.parse(s) as T) : d;
    } catch {
      return d;
    }
  };
  const inputs = j<{ list?: DiagReport['inputs']; note?: string | null; error?: string | null } | DiagReport['inputs']>(r.inputs_json, []);
  const meta = Array.isArray(inputs) ? { list: inputs, note: null, error: null } : inputs;
  return {
    id: r.id,
    repo_id: r.repo_id,
    source: r.source,
    created_by: r.created_by,
    note: meta.note ?? null,
    inputs: meta.list ?? [],
    parsed: j<ParsedDiag | null>(r.parsed_json, null),
    result: j<DiagResult | null>(r.result_json, null),
    signature: (r.signature ?? '').split(' ').filter(Boolean),
    status: r.status,
    error: meta.error ?? null,
    case_id: r.case_id,
    task_id: r.task_id,
    created_at: r.created_at,
  };
}

export function getReport(db: Database.Database, id: string): DiagReport | null {
  const r = db.prepare('SELECT * FROM diag_reports WHERE id = ?').get(id) as Row | undefined;
  return r ? toReport(r) : null;
}

export function listReports(db: Database.Database, limit = 20): DiagReport[] {
  return (db.prepare('SELECT * FROM diag_reports ORDER BY created_at DESC, rowid DESC LIMIT ?').all(Math.min(100, Math.max(1, limit))) as Row[]).map(toReport);
}

export class DiagError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Parse now (fast, no model) and store; the diagnosis runs after (runDiagnosis). */
export function createReport(db: Database.Database, input: { repo_id?: string | null; note?: string | null; inputs: DiagInput[]; source?: string }, by: string | null): DiagReport {
  const inputs = (input.inputs ?? []).filter((i) => i && typeof i.text === 'string' && i.text.trim()).map((i) => ({ name: String(i.name || '貼上的內容').slice(0, 120), text: i.text }));
  if (!inputs.length) throw new DiagError('沒有內容：貼上 log 或加入檔案');
  const total = inputs.reduce((n, i) => n + i.text.length, 0);
  if (total > MAX_TOTAL) throw new DiagError('內容太大（全部加起來上限 5 MB）', 413);
  if (input.repo_id && !getRepo(db, input.repo_id)) throw new DiagError('沒有這個 repo');
  const parsed = parseDiag(inputs);
  const id = `dg_${nanoid(10)}`;
  db.prepare(
    `INSERT INTO diag_reports (id, repo_id, source, created_by, inputs_json, parsed_json, signature, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(
    id,
    input.repo_id || null,
    input.source ?? 'upload',
    by,
    JSON.stringify({ list: inputs.map((i) => ({ name: i.name, bytes: Buffer.byteLength(i.text) })), note: input.note ? String(input.note).slice(0, 400) : null }),
    JSON.stringify(capParsed(parsed)),
    parsed.signature.join(' '),
  );
  return getReport(db, id)!;
}

// ---- mapping to code ---------------------------------------------------------------------------

function sourceLine(repo: Repo | null, file: string, line: number | null): string | null {
  if (!repo || !line) return null;
  const rel = file.replace(/\\/g, '/').replace(/^\.?\//, '');
  const abs = path.resolve(repo.local_path, rel);
  if (!abs.startsWith(path.resolve(repo.local_path) + path.sep)) return null;
  try {
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    return (lines[line - 1] ?? '').trim().slice(0, 200) || null;
  } catch {
    return null;
  }
}

interface IndexRow {
  kind: string;
  key: string;
  section: string | null;
  file: string;
  line: number | null;
  text: string | null;
  value: string | null;
  meaning: string | null;
}

export function codeRefs(db: Database.Database, repo: Repo | null, p: ParsedDiag): CodeRef[] {
  const out: CodeRef[] = [];
  const seen = new Set<string>();
  const push = (r: CodeRef) => {
    const k = `${r.file}:${r.line}`;
    if (seen.has(k) || out.length >= 40) return;
    seen.add(k);
    out.push(r);
  };
  for (const e of [...p.incidents, ...p.errors]) {
    const label = e.type === 'incident' || e.type === 'incident_suppressed' ? `incident ${e.kind ?? ''}`.trim() : `${e.kind ?? 'log'}：${(e.detail ?? e.raw).slice(0, 60)}`;
    for (const s of e.src.slice(0, 2)) push({ from: label, file: s.file, line: s.line, text: sourceLine(repo, s.file, s.line) });
  }
  if (!repo) return out;
  const q = db.prepare('SELECT kind, key, section, file, line, text, value, meaning FROM code_index WHERE repo_id = ? AND kind = ? AND key = ? LIMIT 3');
  for (const kind of Object.keys(p.summary.incidents_by_kind)) {
    for (const r of q.all(repo.id, 'incident', kind) as IndexRow[]) push({ from: `incident ${kind}（記錄處）`, file: r.file, line: r.line, text: r.text });
  }
  for (const code of Object.keys(p.summary.codes).slice(0, 10)) {
    const sym = code.replace(/^code=/, '');
    for (const r of q.all(repo.id, 'error_code', sym) as IndexRow[]) push({ from: `錯誤碼 ${code}`, file: r.file, line: r.line, text: r.text });
    const byValue = db.prepare("SELECT kind, key, section, file, line, text, value, meaning FROM code_index WHERE repo_id = ? AND kind = 'error_code' AND value = ? LIMIT 2").all(repo.id, sym) as IndexRow[];
    for (const r of byValue) push({ from: `錯誤碼 ${code}（${r.key}）`, file: r.file, line: r.line, text: r.text });
  }
  // log lines: the message text against the index's log strings (trigram full-text)
  const ftsLog = db.prepare(
    "SELECT c.kind, c.key, c.section, c.file, c.line, c.text, c.value, c.meaning FROM code_index_fts f JOIN code_index c ON c.id = f.rowid WHERE code_index_fts MATCH ? AND c.repo_id = ? AND c.kind IN ('log', 'incident') ORDER BY bm25(code_index_fts) LIMIT 2",
  );
  for (const e of p.errors.filter((x) => x.type === 'log').slice(0, 15)) {
    const words = ((e.detail ?? e.raw).match(/[A-Za-z_][A-Za-z0-9_ ]{6,40}|[㐀-鿿]{3,12}/g) ?? []).map((w) => w.trim()).filter((w) => w.length >= 6).slice(0, 3);
    if (!words.length) continue;
    try {
      for (const r of ftsLog.all(words.map((w) => `"${w.replace(/"/g, '')}"`).join(' OR '), repo.id) as IndexRow[]) push({ from: `log：${(e.detail ?? e.raw).slice(0, 50)}`, file: r.file, line: r.line, text: r.text });
    } catch {
      /* unparsable query */
    }
  }
  return out;
}

/** The machine's ini against the repo's config file of the same name, with what each key means and where code reads it. */
export function paramChanges(db: Database.Database, repo: Repo | null, ini: IniFile[]): ParamChange[] {
  if (!repo || !ini.length) return [];
  const out: ParamChange[] = [];
  for (const cur of ini) {
    const base = path.basename(cur.name).toLowerCase();
    const rows = db.prepare("SELECT kind, key, section, file, line, text, value, meaning FROM code_index WHERE repo_id = ? AND kind = 'param'").all(repo.id) as IndexRow[];
    const files = [...new Set(rows.map((r) => r.file))];
    const file = files.find((f) => path.basename(f).toLowerCase() === base) ?? (files.length === 1 ? files[0]! : null);
    if (!file) continue;
    const baseline: IniFile = { name: file, sections: {} };
    for (const r of rows.filter((x) => x.file === file)) ((baseline.sections[r.section ?? ''] ??= {})[r.key] = r.value ?? '');
    // a key the machine's file leaves out falls back to the default in code: only changed / added keys differ
    for (const ch of iniDiff(cur, baseline).filter((c) => c.current !== null).slice(0, 40)) {
      const def = rows.find((r) => r.file === file && r.key === ch.key && (r.section ?? '') === ch.section);
      const uses = db.prepare("SELECT file, line FROM code_index WHERE repo_id = ? AND kind = 'param_use' AND key = ? LIMIT 3").all(repo.id, ch.key) as Array<{ file: string; line: number }>;
      out.push({ ...ch, meaning: def?.meaning ?? null, where: uses.map((u) => `${u.file}:${u.line}`), baseline_file: file });
    }
  }
  return out;
}

/** Recorded 機況案例 whose signature overlaps this one (approved, this repo or global). */
export function similarCases(db: Database.Database, repo: Repo | null, signature: string[], limit = 3): DiagResult['similar_cases'] {
  if (!signature.length) return [];
  const scopes = ['global', ...(repo ? [repoScope(repo.local_path)] : [])];
  const rows = db
    .prepare(`SELECT id, title, body, meta_json FROM knowledge_nodes WHERE kind = 'case' AND status = 'approved' AND invalid_at IS NULL AND scope IN (${scopes.map(() => '?').join(',')})`)
    .all(...scopes) as Array<{ id: string; title: string; body: string; meta_json: string | null }>;
  const mine = new Set(signature);
  return rows
    .map((r) => {
      let sig: string[] = [];
      try {
        sig = ((JSON.parse(r.meta_json ?? '{}') as { signature?: string[] }).signature ?? []).filter(Boolean);
      } catch {
        sig = [];
      }
      const inter = sig.filter((s) => mine.has(s)).length;
      const score = inter / Math.max(1, new Set([...sig, ...signature]).size);
      return { id: r.id, title: r.title, body: r.body, score: Math.round(score * 100) / 100 };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ---- the verdict ---------------------------------------------------------------------------------

const SYSTEM = [
  '你是 CF-AOI 產線的資深維護工程師，負責判斷機況異常的原因。只根據提供的資料（機台事件摘要、對到的程式碼、和預設不同的參數、過去的案例與陷阱）判斷，不要編造沒看到的檔案或參數。',
  '原因分四類：param（參數設定）、environment（環境／硬體：相機、光源、擷取卡、GPU、網路、磁碟）、code（程式 bug）、data（圖資、recipe 內容）；判斷不了用 unknown。',
  '判斷順序：先讀每個 incident／錯誤自己的 detail 與程式位置——它說了什麼（例如 JSON parse error = 收到的輸入不是 JSON，是資料或上游問題，不是參數）。參數差異只有在「讀取處和事件的程式碼有關」或和現象有明確機制時，才能列為原因；標註「讀取處和事件無關」的參數不要拿來解釋那個事件。',
  '不要把同時出現當成因果；incident 的 detail 若自己寫了懷疑方向（例如「第一懷疑：…」），要納入。證據不足時 confidence 用 low，寧可說不確定。',
  '參數建議只能用「和預設不同的參數」或程式碼裡真的出現的參數名稱；這只是建議，工程師會自己決定，不要說已經套用。',
  '用繁體中文。只輸出一個 JSON 物件：',
  '{"category":"param|environment|code|data|unknown","confidence":"high|medium|low","summary":"一兩句話","causes":[{"category":"…","title":"一句話","why":"根據哪些證據","evidence":["事件或程式位置"]}],"suggestions":[{"file":"設定檔或 null","param":"參數","current":"目前值或 null","proposed":"建議值","why":"…","risk":"low|medium|high","verify":"怎麼確認"}]}',
  'causes 最多 3 個，依可能性排序；suggestions 最多 3 個，沒有就給空陣列。',
].join('\n');

/** Without a model: the cause from the shape of the evidence. */
export function rulesVerdict(p: ParsedDiag, refs: CodeRef[], params: ParamChange[]): Pick<DiagResult, 'category' | 'confidence' | 'summary' | 'causes'> {
  const kinds = Object.keys(p.summary.incidents_by_kind);
  // hardware / environment failures, not just a word that mentions a device
  const hw = /camera (?:lost|timeout|error|disconnect)|相機(?:斷線|逾時|錯誤|異常)|grab(?:bing)? (?:timeout|fail|error)|擷取(?:逾時|失敗)|光源(?:異常|錯誤)|out of memory|cudaError|CUDA error|cuda_error|device lost|ECC error|no space left|磁碟(?:已滿|空間不足)|connection (?:refused|reset|timed out)|network (?:error|unreachable)|網路(?:斷線|異常)|MdigProcess|M_ERROR|ERR_GRAB/i;
  const errText = p.errors.map((e) => `${e.kind ?? ''} ${e.detail ?? ''}`).join('\n');
  const causes: DiagResult['causes'] = [];
  if (params.length) causes.push({ category: 'param', title: `${params.length} 個參數和預設不同`, why: params.slice(0, 3).map((x) => `[${x.section}] ${x.key}：${x.baseline ?? '（無）'} → ${x.current ?? '（刪除）'}`).join('；'), evidence: params.slice(0, 3).map((x) => `${x.section}.${x.key}`) });
  if (hw.test(errText)) causes.push({ category: 'environment', title: '錯誤訊息指向硬體或環境', why: (errText.match(hw) ?? []).join('、'), evidence: p.errors.slice(0, 2).map((e) => (e.detail ?? e.raw).slice(0, 80)) });
  if (refs.length) causes.push({ category: 'code', title: `事件出在 ${refs[0]!.file}${refs[0]!.line ? `:${refs[0]!.line}` : ''}`, why: refs.slice(0, 3).map((r) => r.from).join('；'), evidence: refs.slice(0, 3).map((r) => `${r.file}:${r.line ?? ''}`) });
  const top = causes[0];
  return {
    category: top?.category ?? 'unknown',
    confidence: 'low',
    summary: top ? `${top.title}（本地模型沒有回應，只用規則判斷）` : kinds.length ? `incident：${kinds.join('、')}` : '看不出明確原因',
    causes,
  };
}

function parseVerdict(text: string): Partial<DiagResult> | null {
  const m = /\{[\s\S]*\}/.exec(text.replace(/```(?:json)?/g, ''));
  if (!m) return null;
  try {
    const v = JSON.parse(m[0]) as Record<string, unknown>;
    const cat = (x: unknown): DiagCategory => (['param', 'environment', 'code', 'data', 'unknown'].includes(String(x)) ? (String(x) as DiagCategory) : 'unknown');
    const s = (x: unknown, n: number) => String(x ?? '').trim().slice(0, n);
    const arr = (x: unknown) => (Array.isArray(x) ? (x.filter((y) => y && typeof y === 'object') as Array<Record<string, unknown>>) : []);
    return {
      category: cat(v.category),
      confidence: ['high', 'medium', 'low'].includes(String(v.confidence)) ? (String(v.confidence) as DiagResult['confidence']) : 'medium',
      summary: s(v.summary, 400),
      causes: arr(v.causes).slice(0, 3).map((c) => ({ category: cat(c.category), title: s(c.title, 120), why: s(c.why, 400), evidence: Array.isArray(c.evidence) ? c.evidence.map((e) => s(e, 160)).filter(Boolean).slice(0, 5) : [] })),
      suggestions: arr(v.suggestions)
        .slice(0, 3)
        .map((x) => ({ file: x.file ? s(x.file, 200) : null, param: s(x.param, 80), current: x.current == null ? null : s(x.current, 60), proposed: s(x.proposed, 60), why: s(x.why, 300), risk: ['low', 'medium', 'high'].includes(String(x.risk)) ? String(x.risk) : 'medium', verify: s(x.verify, 200) }))
        .filter((x) => x.param && x.proposed),
    };
  } catch {
    return null;
  }
}

export interface DiagnoseDeps {
  localChat?: typeof chatLocal;
}

/** The diagnosis of a stored report (never throws: a failure is stored on the report). */
export async function runDiagnosis(db: Database.Database, id: string, deps: DiagnoseDeps = {}): Promise<DiagReport | null> {
  const rep = getReport(db, id);
  if (!rep || !rep.parsed) return rep;
  db.prepare("UPDATE diag_reports SET status = 'running' WHERE id = ?").run(id);
  try {
    const repo = rep.repo_id ? getRepo(db, rep.repo_id) : null;
    const p = rep.parsed;
    const refs = codeRefs(db, repo, p);
    const params = paramChanges(db, repo, p.ini);
    const cases = similarCases(db, repo, rep.signature);
    const summaryText = diagSummaryText(p, 4000);
    const refFiles = new Set(refs.map((r) => r.file));
    const pits = repo ? matchPitfalls(db, repo.local_path, { text: `${rep.note ?? ''}\n${summaryText}`, files: refs.map((r) => r.file) }, 3) : [];
    const user = [
      rep.note ? `## 工程師描述的現象\n${rep.note}` : '',
      `## 機台事件摘要\n${summaryText}`,
      refs.length ? `## 對到的程式碼\n${refs.slice(0, 15).map((r) => `- ${r.from} → ${r.file}${r.line ? `:${r.line}` : ''}${r.text ? `：${r.text}` : ''}`).join('\n')}` : '',
      params.length
        ? `## 和預設不同的參數（${params[0]!.baseline_file}）\n${params
            .slice(0, 20)
            .map((x) => {
              const near = x.where.some((w) => refFiles.has(w.split(':')[0]!));
              return `- [${x.section}] ${x.key}：預設 ${x.baseline ?? '（無）'} → 機台 ${x.current ?? '（刪除）'}${x.meaning ? `（${x.meaning.replace(/\s+/g, ' ').slice(0, 120)}）` : ''}；程式讀取處：${x.where.join('、') || '找不到'}${refs.length ? (near ? '（和事件的程式碼同一個檔案）' : '（讀取處和事件無關）') : ''}`;
            })
            .join('\n')}`
        : '',
      cases.length ? `## 過去相似的機況案例\n${cases.map((c) => `- ${c.title}：${c.body}`).join('\n')}` : '',
      pits.length ? `## 這個 repo 學到的陷阱\n${renderLearned(pits).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const chat = deps.localChat ?? chatLocal;
    let verdict: Partial<DiagResult> | null = null;
    let model: string | null = null;
    try {
      const r = await chat(db, { system: SYSTEM, user, maxTokens: 1500, thinking: false });
      if (r.ok) {
        verdict = parseVerdict(r.content);
        model = verdict ? 'local' : null;
      }
    } catch {
      verdict = null;
    }
    const rules = rulesVerdict(p, refs, params);
    const result: DiagResult = {
      category: verdict?.category ?? rules.category,
      confidence: verdict?.confidence ?? rules.confidence,
      summary: verdict?.summary || rules.summary,
      causes: verdict?.causes?.length ? verdict.causes : rules.causes,
      code_refs: refs,
      params,
      suggestions: verdict?.suggestions ?? [],
      similar_cases: cases,
      pitfalls: pits.map((n) => ({ id: n.id, title: n.title, body: n.body })),
      model_used: model,
    };
    db.prepare("UPDATE diag_reports SET status = 'ready', result_json = ? WHERE id = ?").run(JSON.stringify(result), id);
  } catch (err) {
    const meta = JSON.parse((db.prepare('SELECT inputs_json FROM diag_reports WHERE id = ?').get(id) as { inputs_json: string }).inputs_json) as Record<string, unknown>;
    db.prepare("UPDATE diag_reports SET status = 'failed', inputs_json = ? WHERE id = ?").run(JSON.stringify({ ...meta, error: (err as Error).message.slice(0, 300) }), id);
  }
  return getReport(db, id);
}

/**
 * 記成案例: the person's confirmed cause and fix become a 機況案例 knowledge node (approved — a
 * person wrote it) carrying this report's signature, so the next report with the same signature
 * finds it first.
 */
export function recordCase(db: Database.Database, id: string, input: { cause: string; resolution?: string | null }, by: string): DiagReport {
  const rep = getReport(db, id);
  if (!rep) throw new DiagError('沒有這份診斷', 404);
  const cause = String(input.cause ?? '').trim().slice(0, 300);
  if (cause.length < 4) throw new DiagError('寫一句確認的原因');
  const resolution = String(input.resolution ?? '').trim().slice(0, 400);
  const repo = rep.repo_id ? getRepo(db, rep.repo_id) : null;
  const kinds = Object.keys(rep.parsed?.summary.incidents_by_kind ?? {});
  const title = `${kinds.length ? `${kinds.join('、')}：` : ''}${cause}`.slice(0, 120);
  const body = [`原因：${cause}`, resolution && `處置：${resolution}`, rep.note && `現象：${rep.note}`, rep.result?.category && `分類：${rep.result.category}`].filter(Boolean).join('；');
  const nodeId = `k_${nanoid(10)}`;
  const files = (rep.result?.code_refs ?? []).map((r) => r.file).slice(0, 6);
  const meta = {
    key: `case:${id}`,
    signature: rep.signature,
    trigger: { words: [...kinds, ...Object.keys(rep.parsed?.summary.codes ?? {})].slice(0, 8), files, kinds: [] },
    evidence: [{ diag: id }],
    hits: { shown: 0, passed: 0 },
    category: rep.result?.category ?? null,
  };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO knowledge_nodes (id, kind, title, body, tags, scope, source, status, weight, facet, meta_json)
       VALUES (?, 'case', ?, ?, ?, ?, 'manual', 'approved', 4, 'case', ?)`,
    ).run(nodeId, title, body, JSON.stringify(meta.trigger.words), repo ? repoScope(repo.local_path) : 'global', JSON.stringify(meta));
    db.prepare('UPDATE diag_reports SET case_id = ? WHERE id = ?').run(nodeId, id);
  })();
  logEvent(db, { kind: 'note', detail: `機況案例：${title} by ${by}` });
  return getReport(db, id)!;
}
