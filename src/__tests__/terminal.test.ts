import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { openTestDb, setSetting } from '../db/index.js';
import { buildApp } from '../server/app.js';
import { TerminalError, TerminalManager, defaultShell, type PtyLike, type SpawnPty } from '../terminal/sessions.js';
import { parseAllowedUsers, terminalAccess } from '../terminal/access.js';
import type { FastifyRequest } from 'fastify';
import { WebSocket as WsClient } from 'ws';

/** A pty that echoes input back and reports resizes — enough to drive the manager and the socket. */
function fakePty(): { spawn: SpawnPty; spawned: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; pty: FakePty }> } {
  const spawned: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; pty: FakePty }> = [];
  const spawn: SpawnPty = (file, args, o) => {
    const p = new FakePty(o.cols, o.rows);
    spawned.push({ file, args, env: o.env, cwd: o.cwd, pty: p });
    return p;
  };
  return { spawn, spawned };
}
class FakePty implements PtyLike {
  pid = 4242;
  data: ((d: string) => void)[] = [];
  exit: ((e: { exitCode: number }) => void)[] = [];
  written: string[] = [];
  killed: string[] = [];
  constructor(
    public cols: number,
    public rows: number,
  ) {}
  onData(cb: (d: string) => void) {
    this.data.push(cb);
  }
  onExit(cb: (e: { exitCode: number }) => void) {
    this.exit.push(cb);
  }
  write(d: string) {
    this.written.push(d);
    for (const cb of this.data) cb(`echo:${d}`);
  }
  resize(c: number, r: number) {
    this.cols = c;
    this.rows = r;
  }
  kill(sig?: string) {
    this.killed.push(sig ?? 'SIGTERM');
    for (const cb of this.exit) cb({ exitCode: 129 });
  }
  emit(d: string) {
    for (const cb of this.data) cb(d);
  }
}

const USER = { user_key: 'ts:addis@example.com', label: 'Addis' };
const OTHER = { user_key: 'ts:bob@example.com', label: 'Bob' };

describe('TerminalManager', () => {
  let db: Database.Database;
  let timers: Array<{ fn: () => void; ms: number }> = [];
  beforeEach(() => {
    db = openTestDb();
    timers = [];
  });
  afterEach(() => db.close());
  const manager = (spawn: SpawnPty, presets = {}) =>
    new TerminalManager({
      spawnPty: spawn,
      db,
      presets,
      now: () => Date.parse('2026-09-18T00:00:00Z'),
      setTimer: (fn, ms) => {
        const t = { fn, ms };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        timers = timers.filter((x) => x !== t);
      },
      env: { SHELL: '/bin/zsh', LOOP_API_TOKEN: 'secret', LOOP_READONLY_TOKEN: 'ro', PATH: '/usr/bin' },
      home: '/home/x',
    });

  it('opens a login shell without the bearer token in its environment, and records an audit row', () => {
    const f = fakePty();
    const m = manager(f.spawn);
    const s = m.open({ user: USER, cols: 120, rows: 40 });
    expect(s).toMatchObject({ title: 'shell 1', cols: 120, rows: 40, alive: true, preset: null });
    expect(f.spawned[0]).toMatchObject({ file: '/bin/zsh', args: ['-l'] });
    expect(f.spawned[0]!.env).toMatchObject({ TERM: 'xterm-256color', PATH: '/usr/bin', LOOP_TERMINAL: '1' });
    expect(f.spawned[0]!.env.LOOP_API_TOKEN).toBeUndefined();
    expect(f.spawned[0]!.env.LOOP_READONLY_TOKEN).toBeUndefined();
    const row = db.prepare('SELECT * FROM terminal_sessions WHERE id = ?').get(s.id) as { user_key: string; shell: string; pid: number; ended_at: string | null };
    expect(row).toMatchObject({ user_key: USER.user_key, shell: '/bin/zsh', pid: 4242, ended_at: null });
    expect(defaultShell({})).toMatch(/\/bin\/(bash|zsh)/);
  });

  it('a shell starts in terminal_cwd (the Loop checkout), and falls back when it is gone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term-cwd-'));
    try {
      setSetting(db, 'terminal_cwd', dir);
      const f = fakePty();
      const m = manager(f.spawn);
      m.open({ user: USER });
      expect(f.spawned[0]).toMatchObject({ cwd: dir });
      expect(f.spawned[0]!.env.PWD).toBe(dir);
      // a directory that no longer exists must not stop anyone opening a shell
      setSetting(db, 'terminal_cwd', path.join(dir, 'gone'));
      m.open({ user: USER });
      expect(f.spawned[1]).toMatchObject({ cwd: '/home/x' });
      setSetting(db, 'terminal_cwd', '');
      m.open({ user: USER });
      expect(f.spawned[2]).toMatchObject({ cwd: '/home/x' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replays scrollback on attach, forwards input/output, and marks exit in the audit row', () => {
    const f = fakePty();
    const m = manager(f.spawn);
    const s = m.open({ user: USER });
    f.spawned[0]!.pty.emit('$ ');
    const got: string[] = [];
    m.attach(s.id, USER.user_key, { send: (j) => got.push(j) });
    expect(JSON.parse(got[0]!)).toEqual({ t: 'out', id: s.id, data: '$ ' });
    m.write(s.id, USER.user_key, 'ls\r');
    expect(f.spawned[0]!.pty.written).toEqual(['ls\r']);
    expect(JSON.parse(got[1]!)).toEqual({ t: 'out', id: s.id, data: 'echo:ls\r' });
    m.resize(s.id, USER.user_key, 80, 24);
    expect(f.spawned[0]!.pty).toMatchObject({ cols: 80, rows: 24 });
    // the shell exits: clients hear it, the row is closed, writes refuse
    f.spawned[0]!.pty.kill('SIGHUP');
    expect(JSON.parse(got.at(-1)!)).toEqual({ t: 'exit', id: s.id, code: 129 });
    expect((db.prepare('SELECT exit_code, ended_at FROM terminal_sessions WHERE id = ?').get(s.id) as { exit_code: number; ended_at: string })).toMatchObject({ exit_code: 129 });
    expect(() => m.write(s.id, USER.user_key, 'x')).toThrow(TerminalError);
    expect(m.list(USER.user_key)[0]).toMatchObject({ alive: false, exit_code: 129 });
  });

  it('caps the scrollback, the session count per user, and hides sessions from other users', () => {
    setSetting(db, 'terminal_scrollback_kb', '16');
    setSetting(db, 'terminal_max_sessions', '2');
    const f = fakePty();
    const m = manager(f.spawn);
    const s = m.open({ user: USER });
    for (let i = 0; i < 40; i++) f.spawned[0]!.pty.emit('x'.repeat(1024));
    const got: string[] = [];
    m.attach(s.id, USER.user_key, { send: (j) => got.push(j) });
    expect((JSON.parse(got[0]!) as { data: string }).data.length).toBeLessThanOrEqual(16 * 1024);
    m.open({ user: USER });
    expect(() => m.open({ user: USER })).toThrow(/最多 2/);
    expect(m.list(OTHER.user_key)).toEqual([]);
    expect(() => m.attach(s.id, OTHER.user_key, { send: () => {} })).toThrow(TerminalError);
    expect(() => m.write(s.id, OTHER.user_key, 'rm -rf')).toThrow(TerminalError);
    expect(f.spawned[0]!.pty.written).toEqual([]);
  });

  it('reaps an idle session and only accepts server-side presets', () => {
    setSetting(db, 'terminal_idle_min', '1');
    const f = fakePty();
    const m = manager(f.spawn, { joblog: () => ({ file: 'tail', args: ['-f', '/x.log'], title: 'log' }), none: () => null });
    const s = m.open({ user: USER });
    const idle = timers.find((t) => t.ms === 60_000)!;
    expect(idle).toBeTruthy();
    m.write(s.id, USER.user_key, 'a'); // activity replaces the timer
    expect(timers.filter((t) => t.ms === 60_000)).toHaveLength(1);
    expect(timers.find((t) => t.ms === 60_000)).not.toBe(idle);
    timers.find((t) => t.ms === 60_000)!.fn();
    expect(f.spawned[0]!.pty.killed).toEqual(['SIGHUP']);
    expect(m.list(USER.user_key)[0]!.alive).toBe(false);

    const log = m.open({ user: USER, preset: 'joblog' });
    expect(log.title).toBe('log');
    expect(f.spawned[1]).toMatchObject({ file: 'tail', args: ['-f', '/x.log'] });
    expect(() => m.open({ user: USER, preset: 'none' })).toThrow(/預設指令/);
    expect(() => m.open({ user: USER, preset: 'rm' })).toThrow(TerminalError);
    m.closeAll();
    expect(m.list(USER.user_key)).toEqual([]);
  });
});

describe('terminalAccess', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openTestDb();
  });
  afterEach(() => db.close());
  const req = (headers: Record<string, string>) => ({ headers, query: {} }) as unknown as FastifyRequest;

  it('is off by default, then keyed on the allowlist', () => {
    expect(terminalAccess(req({}), db)).toMatchObject({ allowed: false, code: 404 });
    setSetting(db, 'terminal_enabled', 'true');
    expect(terminalAccess(req({}), db)).toMatchObject({ allowed: false, code: 403 });
    setSetting(db, 'terminal_allowed_users', 'ts:Addis@Example.com, local');
    expect(terminalAccess(req({}), db)).toMatchObject({ allowed: true, user: { user_key: 'local' } });
    expect(terminalAccess(req({ 'tailscale-user-login': 'addis@example.com' }), db)).toMatchObject({ allowed: true });
    expect(terminalAccess(req({ 'tailscale-user-login': 'bob@example.com' }), db)).toMatchObject({ allowed: false, code: 403 });
    expect(terminalAccess(req({ 'x-loop-user': 'bob' }), db)).toMatchObject({ allowed: false, code: 403 });
    expect(parseAllowedUsers(' ts:A ,, local')).toEqual(new Set(['ts:a', 'local']));
  });
});

describe('/api/terminal over a real socket', () => {
  let db: Database.Database;
  let app: FastifyInstance;
  let url = '';
  const f = fakePty();
  beforeEach(async () => {
    db = openTestDb();
    setSetting(db, 'terminal_enabled', 'true');
    setSetting(db, 'terminal_allowed_users', 'ts:addis@example.com');
    app = buildApp({ db, apiToken: 'tok', terminalSpawnPty: f.spawn });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as { port: number };
    url = `127.0.0.1:${addr.port}`;
  });
  afterEach(async () => {
    await app.close();
    db.close();
  });

  // the `ws` client (a dependency of @fastify/websocket) can send the Tailscale header; the
  // global WebSocket cannot set headers at all
  const frames = (sock: WsClient) => {
    const q: unknown[] = [];
    const waiters: Array<(v: unknown) => void> = [];
    sock.on('message', (data) => {
      const v = JSON.parse(String(data));
      const w = waiters.shift();
      if (w) w(v);
      else q.push(v);
    });
    return () => (q.length ? Promise.resolve(q.shift()) : new Promise<unknown>((r) => waiters.push(r)));
  };

  it('opens a shell, echoes input, lists sessions, and refuses the wrong user', async () => {
    // REST: allowed user sees the (empty) list; unknown token is 401 from the bearer hook
    const res = await app.inject({ method: 'GET', url: '/api/terminal/sessions', headers: { authorization: 'Bearer tok', 'tailscale-user-login': 'addis@example.com' } });
    expect(res.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/terminal/sessions', headers: { authorization: 'Bearer tok', 'tailscale-user-login': 'bob@example.com' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/terminal/access', headers: { authorization: 'Bearer tok' } })).json()).toMatchObject({ allowed: false });
    expect((await app.inject({ method: 'GET', url: '/api/terminal/sessions' })).statusCode).toBe(401);

    const sock = new WsClient(`ws://${url}/api/terminal/ws?token=tok`, { headers: { 'tailscale-user-login': 'addis@example.com' } });
    const next = frames(sock);
    await new Promise<void>((resolve, reject) => {
      sock.on('open', () => resolve());
      sock.on('error', (e) => reject(e));
    });
    expect(await next()).toMatchObject({ t: 'hello', user_label: 'addis@example.com', sessions: [] });
    sock.send(JSON.stringify({ t: 'open', cols: 90, rows: 25, title: 'demo' }));
    const opened = (await next()) as { t: string; session: { id: string; title: string } };
    expect(opened.t).toBe('opened');
    expect(opened.session.title).toBe('demo');
    sock.send(JSON.stringify({ t: 'in', id: opened.session.id, data: 'uname\r' }));
    expect(await next()).toEqual({ t: 'out', id: opened.session.id, data: 'echo:uname\r' });
    sock.send(JSON.stringify({ t: 'list' }));
    expect(await next()).toMatchObject({ t: 'list', sessions: [{ id: opened.session.id, clients: 1 }] });
    sock.send(JSON.stringify({ t: 'attach', id: 't_nope' }));
    expect(await next()).toMatchObject({ t: 'error' });
    sock.close();

    // a second socket as a different user: refused after the upgrade with a 4403 close
    const bob = new WsClient(`ws://${url}/api/terminal/ws?token=tok`, { headers: { 'tailscale-user-login': 'bob@example.com' } });
    const code = await new Promise<number>((resolve) => bob.on('close', (c) => resolve(c)));
    expect(code).toBe(4403);
    // no token at all: the bearer hook refuses the upgrade before any terminal code runs
    const anon = new WsClient(`ws://${url}/api/terminal/ws`);
    const refused = await new Promise<string>((resolve) => anon.on('error', (e) => resolve(e.message)));
    expect(refused).toMatch(/401/);
  });
});
