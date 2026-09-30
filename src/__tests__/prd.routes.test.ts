import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openTestDb, setSetting } from '../db/index.js';
import { buildApp } from '../server/app.js';

let repo: string;
beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-prd-routes-'));
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# r\n');
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
});

let db: Database.Database;
let app: FastifyInstance;
let review = '{"ok":true,"missing":[],"questions":[],"risk_notes":[]}';

beforeEach(async () => {
  db = openTestDb();
  review = '{"ok":true,"missing":[],"questions":[],"risk_notes":[]}';
  app = buildApp({ db, apiToken: null, prdReviewExec: async () => review });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
});

const PRD = () => `# Add health endpoint

## 目標 (Goal)
Expose GET /healthz returning {"ok":true} so the load balancer can probe the service.

## 範圍 (Scope)
- Add the route in src/server.ts

## 非範圍 (Non-goals)
- No auth changes

## 驗收標準 (Acceptance)
- [ ] GET /healthz returns 200 with {"ok":true}

## 驗證指令 (Verify)
\`\`\`bash
npm test
\`\`\`

## Repo
- path: ${repo}
- branch: main

## 領域 (Domain)
typescript

## 複雜度 (Complexity)
S
`;

describe('/api/prd', () => {
  it('404 while the PRD gate is off', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/prd/template' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/prd/check', payload: { markdown: PRD() } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/prd', payload: { markdown: PRD() } })).statusCode).toBe(404);
  });

  describe('enabled', () => {
    beforeEach(() => setSetting(db, 'prd_gate_enabled', 'true'));

    it('serves the template the linter expects', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/prd/template' });
      expect(res.json().markdown).toContain('## 驗證指令 (Verify)');
    });

    it('check lists what is missing; 400 without markdown', async () => {
      expect((await app.inject({ method: 'POST', url: '/api/prd/check', payload: {} })).statusCode).toBe(400);
      const bad = (await app.inject({ method: 'POST', url: '/api/prd/check', payload: { markdown: '# x\n\n## Goal\nshort' } })).json();
      expect(bad.ok).toBe(false);
      expect(bad.missing.join()).toMatch(/驗證指令/);
      const good = (await app.inject({ method: 'POST', url: '/api/prd/check', payload: { markdown: PRD() } })).json();
      expect(good).toMatchObject({ ok: true, llm: { status: 'ok', ok: true } });
    });

    it('submit: 422 when the reviewer blocks it (nothing created), 201 with a queued task otherwise', async () => {
      review = '{"ok":false,"missing":["沒說 /healthz 要不要經過 auth middleware"]}';
      const blocked = await app.inject({ method: 'POST', url: '/api/prd', payload: { markdown: PRD() } });
      expect(blocked.statusCode).toBe(422);
      expect(blocked.json().check.missing).toEqual(['審查：沒說 /healthz 要不要經過 auth middleware']);
      expect((await app.inject({ method: 'GET', url: '/api/board' })).json().cards).toHaveLength(0);

      review = '{"ok":true}';
      const ok = await app.inject({ method: 'POST', url: '/api/prd', payload: { markdown: PRD(), model: 'local:qwen38-flash' } });
      expect(ok.statusCode).toBe(201);
      expect(ok.json()).toMatchObject({ kind: 'task', task: { status: 'queued', model: 'local:qwen38-flash' }, gate: { ok: true } });
    });

    it('submit: invalid model -> 400; benchmark_models -> a benchmark', async () => {
      expect((await app.inject({ method: 'POST', url: '/api/prd', payload: { markdown: PRD(), model: 'gpt-9' } })).statusCode).toBe(400);
      const r = await app.inject({
        method: 'POST',
        url: '/api/prd',
        payload: { markdown: PRD(), benchmark_models: ['local:qwen38-flash', 'local:qwen3-coder-next'] },
      });
      expect(r.statusCode).toBe(201);
      expect(r.json()).toMatchObject({ kind: 'benchmark', benchmark: { domain: 'typescript' } });
    });
  });
});

describe('PRD pages: static assets', () => {
  const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');
  it('/prd.html forwards to 工作流程 (linked from the chat), and the shared helpers never use innerHTML', () => {
    expect(fs.readFileSync(path.join(WEB, 'prd.html'), 'utf8')).toContain("location.replace('/flow.html'");
    for (const f of ['prd-compose.js', 'prd-kinds.js']) expect(fs.readFileSync(path.join(WEB, f), 'utf8'), f).not.toMatch(/innerHTML/);
    expect(fs.readFileSync(path.join(WEB, 'index.html'), 'utf8')).toMatch(/href="\/flow\.html"/);
  });
});
