// Every call the Repo page makes to 檢查 and 圖資 (src/server/checkRoutes.ts). Kept in one small
// module so the page and the routes are reconciled in one place: each function returns the plain
// value the page uses. The routes answer a check / a dataset as the bare row (plus, for a check,
// `baseline` parsed and `last_run`), lists inside {checks} / {runs} / {datasets}, and a run as
// the bare run with `running`, `discovered` (metric names) and `metrics` (parsed metrics_json).
import { api } from './frame.js';

const enc = encodeURIComponent;
/** `{check: row}` or the row itself → the row */
const one = (key) => (r) => (r && typeof r === 'object' && r[key] && typeof r[key] === 'object' ? r[key] : r);
/** `{checks: [...]}` or a bare array → the array */
const many = (key) => (r) => (Array.isArray(r) ? r : r && Array.isArray(r[key]) ? r[key] : []);

// ---- 檢查 ------------------------------------------------------------------------------------

/** GET /api/repos/:id/checks → [{id, repo_id, name, kind, machine, command, pass_rule, metrics, baseline_json, baseline, baseline_tol, dataset_id, test_globs, red_on_base, timeout_min, required, ord, protected_paths, artifacts, manual_text, enabled, last_run: run | null}] */
export const listChecks = (repoId) => api(`/api/repos/${enc(repoId)}/checks`).then(many('checks'));

/** POST /api/repos/:id/checks — body: the editor's fields (see checks.js collect()) → the new row */
export const createCheck = (repoId, body) => api(`/api/repos/${enc(repoId)}/checks`, 'POST', body).then(one('check'));

/** PATCH /api/checks/:id — only the keys given change → the row */
export const updateCheck = (id, patch) => api(`/api/checks/${enc(id)}`, 'PATCH', patch).then(one('check'));

/** DELETE /api/checks/:id */
export const deleteCheck = (id) => api(`/api/checks/${enc(id)}`, 'DELETE');

/** POST /api/repos/:id/checks/reorder {ids} — the whole list, top to bottom */
export const reorderChecks = (repoId, ids) => api(`/api/repos/${enc(repoId)}/checks/reorder`, 'POST', { ids });

/** POST /api/repos/:id/checks/from-detected — 建置 / 測試 from the repo's detected commands → {created: [rows], skipped: [names]} (409 when nothing was detected) */
export const checksFromDetected = (repoId) =>
  api(`/api/repos/${enc(repoId)}/checks/from-detected`, 'POST', {}).then((r) => ({ created: many('created')(r), skipped: (r && Array.isArray(r.skipped) && r.skipped) || [] }));

/** POST /api/checks/:id/trial → 202 {run_id}: the run to poll (試跑 on the default branch) */
export const startTrial = (id) => api(`/api/checks/${enc(id)}/trial`, 'POST', {}).then((r) => (r && (r.run_id || (r.run && r.run.id))) || null);

/** GET /api/check-runs/:id → the run {id, kind, machine, head_sha, ok, exit_code, timed_out, ms, output_tail, metrics, started_at, finished_at, running, discovered} → {run, discovered} */
export const getCheckRun = (runId) =>
  api(`/api/check-runs/${enc(runId)}`).then((r) => {
    const run = (r && r.run) || r || null;
    return { run, discovered: (run && Array.isArray(run.discovered) && run.discovered) || (r && Array.isArray(r.discovered) && r.discovered) || [] };
  });

/** POST /api/checks/:id/baseline {run_id} → the check with its new baseline (null if the answer carries no row) */
export const setBaseline = (id, runId) =>
  api(`/api/checks/${enc(id)}/baseline`, 'POST', { run_id: runId }).then((r) => {
    const row = one('check')(r);
    return row && row.id ? row : null;
  });

/** GET /api/checks/:id/runs → the check's runs, newest first (without output) */
export const listCheckRuns = (id) => api(`/api/checks/${enc(id)}/runs`).then(many('runs'));

// ---- 圖資 ------------------------------------------------------------------------------------

/** GET /api/datasets → [{id, name, remote_url, images_dir, answer_file, answer_format, cases}] */
export const listDatasets = () => api('/api/datasets').then(many('datasets'));

/** POST /api/datasets {name, remote_url, images_dir?, answer_file?, answer_format?} → the new row (defaults: images, answers.json, auto) */
export const createDataset = (body) => api('/api/datasets', 'POST', body).then(one('dataset'));

/** PATCH /api/datasets/:id → the row */
export const updateDataset = (id, patch) => api(`/api/datasets/${enc(id)}`, 'PATCH', patch).then(one('dataset'));

/** DELETE /api/datasets/:id */
export const deleteDataset = (id) => api(`/api/datasets/${enc(id)}`, 'DELETE');
