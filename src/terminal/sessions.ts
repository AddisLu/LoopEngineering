import fs from 'node:fs';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { getNum, getSetting } from '../db/index.js';

/**
 * Interactive shells behind the chat shell's terminal drawer. One pty per session, owned by the
 * user who opened it; browsers attach and detach (closing the drawer keeps the shell alive), a
 * ring buffer replays recent output on re-attach, and an idle timer reaps forgotten sessions.
 *
 * What is deliberately NOT here: keystroke or output logging (a shell sees passwords), and any
 * command chosen by the browser — a session runs the login shell, or one of the server-side
 * presets below (a log tail). The audit row records who/when/which shell, nothing typed.
 */

export interface PtyLike {
  pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type SpawnPty = (file: string, args: string[], opts: { cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv }) => PtyLike;

export interface TerminalUser {
  user_key: string;
  label: string;
}

export interface TerminalClient {
  send(json: string): void;
}

export interface SessionInfo {
  id: string;
  title: string;
  preset: string | null;
  cols: number;
  rows: number;
  started_at: string;
  clients: number;
  alive: boolean;
  exit_code: number | null;
}

/** Commands a browser may ask for by name — never a free-form command line. */
export type PresetResolver = (db: Database.Database) => { file: string; args: string[]; title: string } | null;

export interface TerminalManagerDeps {
  spawnPty: SpawnPty;
  db: Database.Database;
  presets?: Record<string, PresetResolver>;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export class TerminalError extends Error {
  constructor(
    message: string,
    readonly code: 'max_sessions' | 'bad_preset' | 'not_found' | 'closed',
  ) {
    super(message);
  }
}

interface Session {
  id: string;
  user_key: string;
  title: string;
  preset: string | null;
  cols: number;
  rows: number;
  pty: PtyLike;
  started_at: string;
  scrollback: string[];
  scrollbackBytes: number;
  clients: Set<TerminalClient>;
  alive: boolean;
  exit_code: number | null;
  idle: unknown;
}

const ID = () => `t_${nanoid(10)}`;

export function defaultShell(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHELL || (os.platform() === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

export class TerminalManager {
  private readonly sessions = new Map<string, Session>();
  private readonly db: Database.Database;
  private readonly spawnPty: SpawnPty;
  private readonly presets: Record<string, PresetResolver>;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private readonly env: NodeJS.ProcessEnv;
  private readonly home: string;

  constructor(deps: TerminalManagerDeps) {
    this.db = deps.db;
    this.spawnPty = deps.spawnPty;
    this.presets = deps.presets ?? {};
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
    this.env = deps.env ?? process.env;
    this.home = deps.home ?? os.homedir();
  }

  /**
   * Where a new shell starts: setting `terminal_cwd` (default: this checkout) when it is a real
   * directory, else the home directory. A pty is not a jail — the shell can still cd anywhere the
   * unix user can reach — so this is the landing spot, not a boundary.
   */
  private cwd(): string {
    const want = (getSetting(this.db, 'terminal_cwd') ?? '').trim();
    if (want) {
      try {
        if (fs.statSync(want).isDirectory()) return want;
      } catch {
        /* configured directory is gone — fall back rather than refuse to open a shell */
      }
    }
    return this.home;
  }

  private idleMs(): number {
    return Math.max(1, getNum(this.db, 'terminal_idle_min', 30)) * 60_000;
  }

  private get(id: string, userKey: string): Session {
    const s = this.sessions.get(id);
    if (!s || s.user_key !== userKey) throw new TerminalError('沒有這個終端機', 'not_found');
    return s;
  }

  private touch(s: Session): void {
    if (s.idle) this.clearTimer(s.idle);
    if (!s.alive) return;
    s.idle = this.setTimer(() => {
      this.broadcast(s, { t: 'out', id: s.id, data: '\r\n[閒置太久，終端機已關閉]\r\n' });
      this.kill(s);
    }, this.idleMs());
  }

  private broadcast(s: Session, frame: Record<string, unknown>): void {
    const json = JSON.stringify(frame);
    for (const c of s.clients) {
      try {
        c.send(json);
      } catch {
        s.clients.delete(c);
      }
    }
  }

  private kill(s: Session): void {
    if (!s.alive) return;
    try {
      s.pty.kill('SIGHUP');
    } catch {
      /* already gone */
    }
    this.setTimer(() => {
      if (s.alive) {
        try {
          s.pty.kill('SIGKILL');
        } catch {
          /* gone */
        }
      }
    }, 3000);
  }

  open(o: { user: TerminalUser; cols?: number; rows?: number; preset?: string | null; title?: string | null }): SessionInfo {
    const mine = [...this.sessions.values()].filter((s) => s.user_key === o.user.user_key && s.alive);
    const max = Math.max(1, getNum(this.db, 'terminal_max_sessions', 4));
    if (mine.length >= max) throw new TerminalError(`最多 ${max} 個終端機`, 'max_sessions');
    const cols = Math.min(500, Math.max(10, Math.round(o.cols ?? 100)));
    const rows = Math.min(200, Math.max(3, Math.round(o.rows ?? 30)));

    let file = defaultShell(this.env);
    let args = ['-l'];
    let title = o.title?.trim().slice(0, 40) || `shell ${mine.length + 1}`;
    if (o.preset) {
      const resolve = this.presets[o.preset];
      const cmd = resolve ? resolve(this.db) : null;
      if (!cmd) throw new TerminalError(`沒有這個預設指令：${o.preset}`, 'bad_preset');
      file = cmd.file;
      args = cmd.args;
      title = o.title?.trim().slice(0, 40) || cmd.title;
    }
    // the bearer token must not leak into an interactive shell's environment
    const { LOOP_API_TOKEN: _t, LOOP_READONLY_TOKEN: _r, ...clean } = this.env;
    const cwd = this.cwd();
    const env: NodeJS.ProcessEnv = { ...clean, TERM: 'xterm-256color', COLORTERM: 'truecolor', LOOP_TERMINAL: '1', PWD: cwd };

    const pty = this.spawnPty(file, args, { cols, rows, cwd, env });
    const id = ID();
    const s: Session = {
      id,
      user_key: o.user.user_key,
      title,
      preset: o.preset ?? null,
      cols,
      rows,
      pty,
      started_at: new Date(this.now()).toISOString(),
      scrollback: [],
      scrollbackBytes: 0,
      clients: new Set(),
      alive: true,
      exit_code: null,
      idle: null,
    };
    this.sessions.set(id, s);
    this.db
      .prepare(
        `INSERT INTO terminal_sessions (id, user_key, user_label, pid, shell, preset, cols, rows, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, o.user.user_key, o.user.label, pty.pid, file, o.preset ?? null, cols, rows, s.started_at);

    const cap = Math.max(16, getNum(this.db, 'terminal_scrollback_kb', 256)) * 1024;
    pty.onData((data) => {
      s.scrollback.push(data);
      s.scrollbackBytes += Buffer.byteLength(data);
      while (s.scrollbackBytes > cap && s.scrollback.length > 1) {
        s.scrollbackBytes -= Buffer.byteLength(s.scrollback.shift()!);
      }
      this.broadcast(s, { t: 'out', id, data });
      this.touch(s);
    });
    pty.onExit(({ exitCode }) => {
      s.alive = false;
      s.exit_code = exitCode;
      if (s.idle) this.clearTimer(s.idle);
      this.db.prepare(`UPDATE terminal_sessions SET ended_at = ?, exit_code = ? WHERE id = ?`).run(new Date(this.now()).toISOString(), exitCode, id);
      this.broadcast(s, { t: 'exit', id, code: exitCode });
    });
    this.touch(s);
    return this.info(s);
  }

  private info(s: Session): SessionInfo {
    return { id: s.id, title: s.title, preset: s.preset, cols: s.cols, rows: s.rows, started_at: s.started_at, clients: s.clients.size, alive: s.alive, exit_code: s.exit_code };
  }

  list(userKey: string): SessionInfo[] {
    return [...this.sessions.values()].filter((s) => s.user_key === userKey).map((s) => this.info(s));
  }

  /** Attach a browser; it gets the scrollback as one frame, then live output. */
  attach(id: string, userKey: string, client: TerminalClient): SessionInfo {
    const s = this.get(id, userKey);
    s.clients.add(client);
    if (s.scrollback.length) client.send(JSON.stringify({ t: 'out', id, data: s.scrollback.join('') }));
    if (!s.alive) client.send(JSON.stringify({ t: 'exit', id, code: s.exit_code }));
    return this.info(s);
  }

  detach(client: TerminalClient): void {
    for (const s of this.sessions.values()) s.clients.delete(client);
  }

  write(id: string, userKey: string, data: string): void {
    const s = this.get(id, userKey);
    if (!s.alive) throw new TerminalError('終端機已結束', 'closed');
    s.pty.write(data);
    this.touch(s);
  }

  resize(id: string, userKey: string, cols: number, rows: number): void {
    const s = this.get(id, userKey);
    const c = Math.min(500, Math.max(10, Math.round(cols)));
    const r = Math.min(200, Math.max(3, Math.round(rows)));
    if (c === s.cols && r === s.rows) return;
    s.cols = c;
    s.rows = r;
    if (s.alive) s.pty.resize(c, r);
  }

  rename(id: string, userKey: string, title: string): SessionInfo {
    const s = this.get(id, userKey);
    s.title = title.trim().slice(0, 40) || s.title;
    return this.info(s);
  }

  close(id: string, userKey: string): void {
    const s = this.get(id, userKey);
    this.kill(s);
    this.sessions.delete(id);
    if (s.idle) this.clearTimer(s.idle);
    this.broadcast(s, { t: 'exit', id, code: s.exit_code });
  }

  closeAll(): void {
    for (const s of this.sessions.values()) {
      this.kill(s);
      if (s.idle) this.clearTimer(s.idle);
    }
    this.sessions.clear();
  }
}
