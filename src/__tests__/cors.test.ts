import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { openTestDb } from '../db/index.js';
import { buildApp } from '../server/app.js';

let db: Database.Database;
let app: FastifyInstance;

beforeEach(() => {
  db = openTestDb();
});
afterEach(async () => {
  await app?.close();
  db.close();
});

describe('CORS: browser origin whitelist for the SSoT-read API', () => {
  it('allows a whitelisted origin on a preflight OPTIONS request', async () => {
    app = buildApp({ db, corsOrigins: ['https://foo.example'] });
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/rag/search',
      headers: {
        origin: 'https://foo.example',
        'access-control-request-method': 'GET',
      },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://foo.example');
  });

  it('allows a whitelisted origin on a real GET request', async () => {
    app = buildApp({ db, corsOrigins: ['https://foo.example'] });
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { origin: 'https://foo.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBe('https://foo.example');
  });

  it('does not reflect an origin outside the whitelist', async () => {
    app = buildApp({ db, corsOrigins: ['https://foo.example'] });
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { origin: 'https://evil.example' },
    });
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });

  it('zero-impact default: no corsOrigins configured means no CORS headers at all', async () => {
    app = buildApp({ db });
    const res = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { origin: 'https://foo.example' },
    });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
