// Every server call the 問題單 page (web/fix.js) makes, in one place: the /api/tickets contract
// (src/server/ticketRoutes.ts) and the registries the page reads (repos, machines, local models),
// plus the links into the Repo page and the 結果頁. When a route or a field changes, this module is
// the one to adjust. Tickets come back normalised, so fix.js can trust every array to be there.
import { api, withToken } from './frame.js';

const enc = encodeURIComponent;
const T = (id, rest = '') => `/api/tickets/${enc(id)}${rest}`;
const arr = (v) => (Array.isArray(v) ? v : []);

/** A TicketView with every list present, whatever the server left out. */
export function normalizeTicket(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const a = t.analysis && typeof t.analysis === 'object' ? t.analysis : null;
  return {
    ...t,
    title: t.title || '',
    description: t.description || '',
    priority: Number(t.priority) || 2,
    model: t.model || '',
    branch: t.branch || (t.repo && t.repo.default_branch) || '',
    images: arr(t.images),
    kind: t.kind || null,
    issue: t.issue || null,
    analysis_status: t.analysis_status || null,
    approval_mode: t.approval_mode === 'manager' ? 'manager' : 'self',
    approval_state: t.approval_state || null,
    can_approve: Boolean(t.can_approve),
    // not in the contract yet: whether the caller may start without a manager (a manager may);
    // without it, manager mode always offers 送出核可 and the server queues a manager's ticket anyway
    is_manager: Boolean(t.is_manager ?? t.can_approve),
    analysis: a && {
      ...a,
      steps: arr(a.steps),
      causes: arr(a.causes).map((c) => ({ ...c, evidence: arr(c && c.evidence), recent: arr(c && c.recent) })),
      repro: a.repro || null,
      checks: arr(a.checks),
      conditions: a.conditions || null,
      questions: arr(a.questions).map((q) => String(q && typeof q === 'object' ? q.text ?? q.question ?? '' : q)).filter(Boolean),
      error: a.error || null,
    },
  };
}

const one = (r) => normalizeTicket(r && r.ticket);

export const tickets = {
  /** {title?, description, repo_id, branch?, priority?, model?, kind?, images?: data URLs, issue_url?, analyse?} */
  create: (body) => api('/api/tickets', 'POST', body).then(one),
  /** the caller's own tickets, newest first (TicketSummary[]) */
  list: (limit = 20) => api(`/api/tickets?mine=1&limit=${limit}`).then((r) => arr(r && r.tickets)),
  get: (id) => api(T(id)).then(one),
  /** any of {title, description, kind, model, priority, branch, causes, repro, checks_off, answers} */
  patch: (id, body) => api(T(id), 'PATCH', body).then(one),
  analyse: (id) => api(T(id, '/analyse'), 'POST', {}).then(one),
  start: (id) => api(T(id, '/start'), 'POST', {}).then(one),
  approve: (id) => api(T(id, '/approve-start'), 'POST', {}).then(one),
  reject: (id, reason) => api(T(id, '/reject-start'), 'POST', { reason }).then(one),
  cancel: (id) => api(T(id, '/cancel'), 'POST', {}),
  /** the composed PRD (plan_ref), read-only */
  plan: (id) => api(T(id, '/plan')).then((r) => String((r && r.markdown) || '')),
  /** an <img src>: a plain link cannot send the bearer, so the token rides as ?token= */
  imageUrl: (id, n) => withToken(T(id, `/images/${enc(n)}`)),
  /** {kind: repo|issue|pr|null, remote_url, owner, repo_name, repo: {id, name}|null, issue|null, error?} */
  resolveLink: (url) => api('/api/tickets/resolve-link', 'POST', { url }),
};

export const registry = {
  /** imported repos (with the detected stack) for the Repo select */
  repos: () => api('/api/repos').then((r) => arr(r && r.repos)),
  /** machines for the OS and the health dot; the page works without them */
  machines: () =>
    api('/api/machines')
      .then((r) => arr(r && r.machines))
      .catch(() => []),
  /** enabled local models for the 模型 select; null = none to offer (the select hides) */
  localModels: () =>
    api('/api/local/models')
      .then((r) => {
        if (!r || r.enabled === false) return null;
        const list = arr(r.models).filter((m) => m && m.id && m.enabled);
        return list.length ? list : null;
      })
      .catch(() => null),
};

export const links = {
  newTicket: () => '/fix.html',
  ticket: (id) => `/fix.html?id=${enc(id)}`,
  /** the Repo page opens its import dialog from ?import= (empty = a blank dialog) */
  importRepo: (url) => `/repos.html?import=${enc(url || '')}`,
  repoChecks: (repoId) => `/repos.html?id=${enc(repoId)}&tab=checks`,
  task: (id) => `/task.html?id=${enc(id)}`,
};
