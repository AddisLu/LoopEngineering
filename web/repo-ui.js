// Shared by the Repo page (repos.js, checks.js) and the 機台 page (machines.js): relative times,
// how a machine is named and how healthy it looks, one health-check line (✓ / ⚠ / ✗) and the
// shell of a dialog. textContent-only, like frame.js: strings only ever become text nodes.
import { h, fill, icon, tsMs } from './frame.js';

/** 剛剛 · 12 分鐘前 · 3 小時前 · 2 天前 — the wording src/exec/remote.ts uses in its check lines */
export function ago(s) {
  const t = tsMs(s);
  if (!Number.isFinite(t)) return '';
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return '剛剛';
  if (sec < 3600) return `${Math.round(sec / 60)} 分鐘前`;
  if (sec < 48 * 3600) return `${Math.round(sec / 3600)} 小時前`;
  return `${Math.round(sec / 86400)} 天前`;
}

/** 5.1 s · 820 ms · 3 分 12 秒 */
export function secs(ms) {
  const n = Number(ms);
  if (ms == null || !Number.isFinite(n)) return '';
  if (n < 1000) return `${Math.round(n)} ms`;
  const s = n / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  return `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒`;
}

export const ENGINE_LABEL = '引擎主機（這台 Spark）';
export const OS_LABEL = { auto: '自動偵測', linux: 'Linux', windows: 'Windows' };
export const SHELL_LABEL = { auto: '自動', bash: 'bash', powershell: 'PowerShell', cmd: 'cmd' };
export const TRANSPORT_LABEL = { auto: '自動（檢查時決定）', gitea: '機台自己從 Gitea 抓', copy: '由 Spark 傳檔' };

/** name → row, from GET /api/machines */
export const byName = (rows) => new Map((rows || []).map((m) => [m.name, m]));

/** the stored health-check lines of a machine row (GET /api/machines sends them as last_check) */
export const linesOf = (m) => (m && Array.isArray(m.last_check) ? m.last_check : []);

/** "Windows 11" / "Linux": what the last check saw, else what the row says */
export function osLabel(m) {
  if (!m) return '';
  const ssh = linesOf(m).find((l) => l.label === 'SSH 登入' && l.ok);
  const seen = ssh && /（([^，）]+)[，）]/.exec(String(ssh.detail || ''));
  if (seen) return seen[1];
  return OS_LABEL[m.os] || m.os || '';
}

/** { state: ok | bad | none | off, text, when } — the dot and the words of a machine's 狀態 */
export function healthOf(m) {
  if (!m) return { state: 'none', text: '未檢查', when: '' };
  if (!m.enabled) return { state: 'off', text: '已停用', when: '' };
  if (m.last_check_ok == null || !m.last_check_at) return { state: 'none', text: '未檢查', when: '' };
  const when = ago(m.last_check_at);
  if (m.last_check_ok) return { state: 'ok', text: '正常', when };
  const ssh = linesOf(m).find((l) => l.label === 'SSH 登入');
  return { state: 'bad', text: !ssh || ssh.ok === false ? '連不上' : '有問題', when };
}

/** ● ok / ● bad / ○ not checked / ● off */
export const healthDot = (state, title) => h('span.hdot', { 'data-h': state, title: title || null, 'aria-hidden': 'true' });

/**
 * Where a check or a repo runs, as people read it: 引擎主機 / "aoi-1（Windows）" / GPU 沙盒 local.
 * `machines` is byName(); a name that is not registered (any more) is said plainly.
 */
export function machineLabel(name, machines, o = {}) {
  if (!name) return o.short ? '引擎主機' : ENGINE_LABEL;
  const s = String(name);
  if (s.startsWith('sandbox:')) return `GPU 沙盒 ${s.slice(8) || 'local'}（舊版方案）`;
  const m = machines && machines.get(s);
  if (!m) return `${s}（找不到這台機台）`;
  const os = m.os === 'auto' ? '' : osLabel(m);
  return os ? `${s}（${os}）` : s;
}

/** An <option> text for a machine picker: "aoi-1（Windows）● 正常" / "… ● 連不上" / "… ○ 未檢查" */
export function machineOptionText(m) {
  const hl = healthOf(m);
  const mark = hl.state === 'ok' ? '● 正常' : hl.state === 'bad' ? `● ${hl.text}` : hl.state === 'off' ? '（已停用）' : '○ 未檢查';
  const os = m.os === 'auto' ? '' : osLabel(m);
  return `${m.name}${os ? `（${os}）` : ''} ${mark}`;
}

/**
 * Fill a <select> with the enabled machines and the engine host (value '' = the engine host,
 * which the API stores as NULL). A current value that is not an enabled machine stays listed,
 * so opening a form never silently changes it.
 */
export function fillMachineSelect(sel, machines, current, o = {}) {
  const cur = current || '';
  const opts = [];
  for (const m of machines.values()) {
    if (!m.enabled && m.name !== cur) continue;
    opts.push(h('option', { value: m.name }, o.plain ? machineLabel(m.name, machines) : machineOptionText(m)));
  }
  opts.push(h('option', { value: '' }, ENGINE_LABEL));
  if (cur && !machines.has(cur)) opts.unshift(h('option', { value: cur }, machineLabel(cur, machines)));
  fill(sel, opts);
  sel.value = cur;
}

/** One health-check line (src/exec/check.ts CheckLine): ✓ ok / ⚠ worth knowing / ✗ broken */
export function checkLine(l) {
  const kind = l.ok === true ? 'ok' : l.ok === false ? 'bad' : 'warn';
  const ic = icon(kind === 'ok' ? 'okCircle' : kind === 'bad' ? 'xCircle' : 'warnTri', { size: 18, sw: 2 });
  return h(`div.cline.${kind}`, null, ic, h('span.tx', null, h('span.rp-sr', null, kind === 'ok' ? '通過：' : kind === 'bad' ? '失敗：' : '注意：'), h('b', null, l.label), l.detail || ''));
}

/** "a, b,,c\n d" → "a,b,c" (the CSV globs checks store) */
export const csv = (s) =>
  String(s || '')
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(',');

/** "a,b" → "a, b" for an input people read */
export const csvShow = (s) => csv(s).split(',').filter(Boolean).join(', ');

/**
 * A Gitea page URL copied from the address bar (…/aoi/cf-aoi/issues/12, …/src/branch/main)
 * → the repo's own URL. Anything else is left exactly as pasted: the server validates it.
 */
export function normalizeRepoUrl(raw) {
  const s = String(raw || '').trim();
  const m = /^(https?:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+?)(?:\.git)?\/(?:src|issues|pulls|commits|commit|branches|tags|releases|wiki|activity|settings|tree|blob|compare|milestones|labels|projects|actions)(?:[/?#].*)?$/i.exec(s);
  return m ? m[1] : s;
}

/** "http://gitea:3000/aoi/cf-aoi.git" / "git@host:aoi/cf-aoi" → "aoi/cf-aoi" */
export function shortRemote(url) {
  const parts = String(url || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .filter(Boolean);
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : String(url || '');
}

/**
 * A modal <dialog> the module builds itself (created once, refilled each time): head with the
 * title, a sub line and a close button; a scrolling body; a footer. Returns the parts.
 */
export function dialogShell(id, { wide = false } = {}) {
  let dlg = document.getElementById(id);
  if (!dlg) {
    dlg = h(`dialog.rp-dialog${wide ? '.wide' : ''}`, { id, 'aria-labelledby': `${id}-title` });
    document.body.appendChild(dlg);
  }
  const title = h('h2', { id: `${id}-title` });
  const sub = h('span.dlg-sub');
  const body = h('div.dlg-body');
  const foot = h('div.dlg-foot');
  const close = h('button.btn.icon', { type: 'button', 'aria-label': '關閉', onclick: () => dlg.close() }, icon('x', { size: 16 }));
  fill(dlg, h('div.dlg-head', null, title, sub, h('span.grow'), close), body, foot);
  return { dlg, title, sub, body, foot };
}
