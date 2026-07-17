// Shared helpers for the Loop Engineering MCP servers (stdio full-access + HTTP read-only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---- resolve config from env vars, falling back to the deploy env file ----
export function readEnvFile() {
  const p = path.join(os.homedir(), '.config', 'loop-engineering', 'env');
  const out = {};
  try {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch { /* no env file — use defaults */ }
  return out;
}

const ENVF = readEnvFile();
const PORT = process.env.LOOP_PORT || ENVF.LOOP_PORT || '4711';
export const BASE = (process.env.LOOP_API_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, '');

/** Build a fetch-based REST client bound to one base URL + bearer token. */
export function createApi({ base, token }) {
  function headers(json) {
    const h = {};
    if (token) h.Authorization = `Bearer ${token}`;
    if (json) h['content-type'] = 'application/json';
    return h;
  }
  return async function api(pathname, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(base + pathname, {
        method,
        headers: headers(!!body),
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error(`cannot reach Loop API at ${base} (${e.message}). Is the service running? ` +
        `Check: systemctl --user status loop-engineering`);
    }
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      const hint = res.status === 401 ? ' (401 — token missing/wrong; MCP reads LOOP_API_TOKEN from ~/.config/loop-engineering/env)' : '';
      throw new Error(`${method} ${pathname} -> HTTP ${res.status}${hint}: ${text.slice(0, 300)}`);
    }
    return json;
  };
}
