// Every call the Repo page makes to 檢查 and 圖資 (src/server/checkRoutes.ts, built by its own
// link). Kept in one small module so the page and the routes can be reconciled in one place:
// each function returns the plain value the page uses, whatever envelope the route answers with.
import { api } from './frame.js';

const enc = encodeURIComponent;
/** `{check: row}` or the row itself → the row */
const one = (key) => (r) => (r && typeof r === 'object' && r[key] && typeof r[key] === 'object' ? r[key] : r);
/** `{checks: [...]}` or a bare array → the array */
const many = (key) => (r) => (Array.isArray(r) ? r : r && Array.isArray(r[key]) ? r[key] : []);

// ---- 檢查 ------------------------------------------------------------------------------------

/** GET /api/repos/:id/checks → [{id, repo_id, name, kind, machine, command, pass_rule, metrics, baseline_json, baseline_tol, dataset_id, test_globs, red_on_base, timeout_min, required, ord, protected_paths, artifacts, manual_text, enabled, last_run?: {ok, started_at}}] */
export const listChecks = (repoId) => api(`/api/repos/${enc(repoId)}/checks`).then(many('checks'));

/** POST /api/repos/:id/checks — body: the editor's fields (see checks.js collect()) → the new row */
export const createCheck = (repoId, body) => api(`/api/repos/${enc(repoId)}/checks`, 'POST', body).then(one('check'));

/** PATCH /api/checks/:id — only the keys given change → the row */
export const updateCheck = (id, patch) => api(`/api/checks/${enc(id)}`, 'PATCH', patch).then(one('check'));

/** DELETE /api/checks/:id */
export const deleteCheck = (id) => api(`/api/checks/${enc(id)}`, 'DELETE');

/** POST /api/repos/:id/checks/reorder {ids} — the whole list, top to bottom */
export const reorderChecks = (repoId, ids) => api(`/api/repos/${enc(repoId)}/checks/reorder`, 'POST', { ids });

/** POST /api/repos/:id/checks/from-detected — 建置 / 測試 checks from the repo's detected commands */
export const checksFromDetected = (repoId) => api(`/api/repos/${enc(repoId)}/checks/from-detected`, 'POST', {}).then(many('checks'));

/** POST /api/checks/:id/trial → the run id to poll (試跑 on the default branch) */
export const startTrial = (id) => api(`/api/checks/${enc(id)}/trial`, 'POST', {}).then((r) => (r && (r.run_id || (r.run && r.run.id))) || null);

/** GET /api/check-runs/:id → {run: {id, ok, exit_code, timed_out, ms, output_tail, metrics_json, finished_at, …}, discovered: [metric names]} */
export const getCheckRun = (runId) =>
  api(`/api/check-runs/${enc(runId)}`).then((r) => ({ run: (r && r.run) || r || null, discovered: (r && Array.isArray(r.discovered) && r.discovered) || [] }));

/** POST /api/checks/:id/baseline {run_id} → the check with its new baseline_json (or null when the route sends only ok) */
export const setBaseline = (id, runId) =>
  api(`/api/checks/${enc(id)}/baseline`, 'POST', { run_id: runId }).then((r) => {
    const row = one('check')(r);
    return row && row.id ? row : null;
  });

/** GET /api/checks/:id/runs → the check's runs, newest first */
export const listCheckRuns = (id) => api(`/api/checks/${enc(id)}/runs`).then(many('runs'));

// ---- 圖資 ------------------------------------------------------------------------------------

/** GET /api/datasets → [{id, name, remote_url, images_dir, answer_file, answer_format, cases}] */
export const listDatasets = () => api('/api/datasets').then(many('datasets'));

/** POST /api/datasets {remote_url, name?} → the new row with what was detected (images_dir, answer_file, answer_format, cases) */
export const createDataset = (body) => api('/api/datasets', 'POST', body).then(one('dataset'));

/** PATCH /api/datasets/:id → the row */
export const updateDataset = (id, patch) => api(`/api/datasets/${enc(id)}`, 'PATCH', patch).then(one('dataset'));

/** DELETE /api/datasets/:id */
export const deleteDataset = (id) => api(`/api/datasets/${enc(id)}`, 'DELETE');
