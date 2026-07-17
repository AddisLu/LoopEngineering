#!/usr/bin/env node
// Minimal read-only Node client for the Loop Engineering SSoT API.
//
// Read-only: only calls GET /api/rag/search, /api/knowledge, /api/knowledge/graph,
// /api/sources -- the same whitelist the server's LOOP_READONLY_TOKEN accepts (writes
// get 403; see READONLY_PREFIXES in src/server/app.ts). The token is never hard-coded
// here -- it is read from the LOOP_READONLY_TOKEN environment variable or from
// ~/.config/loop-engineering/env; if neither has it set, this exits with an error
// instead of silently proceeding unauthenticated.
//
// Usage: node clients/ssot_client.mjs {search|recall|sources|graph} [query]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENV_FILE = path.join(os.homedir(), '.config', 'loop-engineering', 'env');

function readEnvFile() {
  const out = {};
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
  } catch { /* no env file -- use defaults */ }
  return out;
}

function config() {
  const envFile = readEnvFile();
  const base = (process.env.LOOP_API_URL || envFile.LOOP_API_URL || 'http://127.0.0.1:4711').replace(/\/$/, '');
  const token = process.env.LOOP_READONLY_TOKEN || envFile.LOOP_READONLY_TOKEN;
  if (!token) {
    console.error(
      `error: LOOP_READONLY_TOKEN not set (env var or ${ENV_FILE}). Refusing to call the SSoT API unauthenticated.`,
    );
    process.exit(1);
  }
  return { base, token };
}

/** Read-only client for the Loop Engineering SSoT REST API. */
export class SsotClient {
  constructor({ base, token } = {}) {
    if (!base || !token) {
      const defaults = config();
      base = base || defaults.base;
      token = token || defaults.token;
    }
    this.base = base.replace(/\/$/, '');
    this.token = token;
  }

  async _get(pathname, params = {}) {
    const url = new URL(this.base + pathname);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    } catch (e) {
      throw new Error(`cannot reach ${this.base} (${e.message})`);
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`GET ${pathname} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : {};
  }

  /** Hybrid RAG search over the SSoT corpus (documents/chunks). */
  search(q, topK) {
    return this._get('/api/rag/search', { q, topK });
  }

  /** Full-text search the curated knowledge base. */
  recall(q) {
    return this._get('/api/knowledge', { q });
  }

  /** List registered SSoT ingestion sources. */
  sources() {
    return this._get('/api/sources');
  }

  /** Fetch the curated knowledge graph (nodes/edges). */
  graph() {
    return this._get('/api/knowledge/graph');
  }
}

async function main() {
  const [, , action, query] = process.argv;
  if (!['search', 'recall', 'sources', 'graph'].includes(action)) {
    console.error('usage: node clients/ssot_client.mjs {search|recall|sources|graph} [query]');
    process.exit(1);
  }
  if ((action === 'search' || action === 'recall') && !query) {
    console.error(`error: ${action} requires a query argument`);
    process.exit(1);
  }

  const client = new SsotClient();
  try {
    const result = await client[action](query);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main();
}
