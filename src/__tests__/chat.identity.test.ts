import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openTestDb, setSetting } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { IdentityError, MANUAL_HEADER, TS_LOGIN_HEADER, TS_NAME_HEADER, decodeHeaderValue, resolveIdentity } from '../server/identity.js';

describe('resolveIdentity', () => {
  it('prefers the Tailscale headers and lowercases the login', () => {
    expect(
      resolveIdentity({ [TS_LOGIN_HEADER]: 'Addis@example.com', [TS_NAME_HEADER]: 'Addis Lu', [MANUAL_HEADER]: '別人' }),
    ).toEqual({ user_key: 'ts:addis@example.com', label: 'Addis Lu', source: 'tailscale' });
  });

  it('falls back to the login itself when no display name is sent', () => {
    expect(resolveIdentity({ [TS_LOGIN_HEADER]: 'a@b.c' }).label).toBe('a@b.c');
  });

  it('uses the manual name only when the Tailscale headers are absent', () => {
    expect(resolveIdentity({ [MANUAL_HEADER]: '  Addis  Lu ' })).toEqual({
      user_key: 'name:addis lu',
      label: 'Addis Lu',
      source: 'manual',
    });
  });

  it('takes the first value when a header repeats', () => {
    expect(resolveIdentity({ [TS_LOGIN_HEADER]: ['first@x', 'second@x'] }).user_key).toBe('ts:first@x');
  });

  it('rejects a manual name that is empty after cleaning, or too long', () => {
    expect(() => resolveIdentity({ [MANUAL_HEADER]: '' })).toThrow(IdentityError);
    expect(() => resolveIdentity({ [MANUAL_HEADER]: 'x'.repeat(41) })).toThrow(IdentityError);
  });

  it('ignores the manual name when the caller asks for tailnet identity only', () => {
    expect(resolveIdentity({ [MANUAL_HEADER]: 'Addis' }, { allowManual: false }).source).toBe('local');
  });

  it('falls back to the shared local workspace when nothing identifies the caller', () => {
    expect(resolveIdentity({})).toEqual({ user_key: 'local', label: '本機', source: 'local' });
  });

  // Documents the trust model deliberately: a caller-supplied Tailscale header IS trusted, which is
  // only safe because the server binds 127.0.0.1 and every external request arrives through
  // `tailscale serve` (which strips and re-injects these headers). See src/server/identity.ts.
  it('trusts the Tailscale header as sent — safe only behind tailscale serve on a loopback bind', () => {
    expect(resolveIdentity({ [TS_LOGIN_HEADER]: 'anyone@example.com' }).source).toBe('tailscale');
  });
});

describe('decodeHeaderValue', () => {
  // All three forms were observed live on the DGX Spark behind `tailscale serve`.
  it('decodes the RFC 2047 encoded-word tailscaled sends for a non-ASCII display name', () => {
    expect(decodeHeaderValue('=?utf-8?q?=E5=91=82=E4=BE=91=E5=84=92?=')).toBe('呂侑儒');
    expect(decodeHeaderValue(`=?utf-8?b?${Buffer.from('呂侑儒', 'utf8').toString('base64')}?=`)).toBe('呂侑儒');
  });

  it('decodes the percent-encoding the page sends', () => {
    expect(decodeHeaderValue(encodeURIComponent('阿德'))).toBe('阿德');
  });

  it('repairs raw UTF-8 bytes that Node read as latin1', () => {
    expect(decodeHeaderValue(Buffer.from('阿德', 'utf8').toString('latin1'))).toBe('阿德');
  });

  it('leaves plain ASCII and undecodable values alone', () => {
    expect(decodeHeaderValue('Addis Lu')).toBe('Addis Lu');
    expect(decodeHeaderValue('100% sure')).toBe('100% sure');
  });
});

describe('GET /api/chat/me', () => {
  let db: Database.Database;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = openTestDb();
    setSetting(db, 'local_models_enabled', 'true');
    app = buildApp({ db, apiToken: null });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('reports the tailnet identity when the proxy injects the headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/chat/me',
      headers: { [TS_LOGIN_HEADER]: 'addis@example.com', [TS_NAME_HEADER]: 'Addis' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user_key: 'ts:addis@example.com', label: 'Addis', source: 'tailscale', needs_name: false });
  });

  it('asks for a name when nothing identifies the caller (localhost)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chat/me' });
    expect(res.json()).toMatchObject({ source: 'local', needs_name: true });
  });

  it('accepts the manual name the page stores, percent-encoded', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/chat/me',
      headers: { [MANUAL_HEADER]: encodeURIComponent('阿德') },
    });
    expect(res.json()).toMatchObject({ user_key: 'name:阿德', source: 'manual', needs_name: false });
  });

  it('shows the tailnet display name decoded, not as an encoded word', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/chat/me',
      headers: { [TS_LOGIN_HEADER]: 'addislyu@gmail.com', [TS_NAME_HEADER]: '=?utf-8?q?=E5=91=82=E4=BE=91=E5=84=92?=' },
    });
    expect(res.json()).toMatchObject({ user_key: 'ts:addislyu@gmail.com', label: '呂侑儒', source: 'tailscale' });
  });

  it('rejects an unusable manual name with 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/chat/me', headers: { [MANUAL_HEADER]: 'x'.repeat(41) } });
    expect(res.statusCode).toBe(400);
  });

  it('404s while local models are disabled', async () => {
    setSetting(db, 'local_models_enabled', 'false');
    expect((await app.inject({ method: 'GET', url: '/api/chat/me' })).statusCode).toBe(404);
  });
});
