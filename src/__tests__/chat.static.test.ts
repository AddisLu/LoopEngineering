import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', '..', 'web');
const read = (f: string) => fs.readFileSync(path.join(WEB_DIR, f), 'utf8');
const html = () => read('index.html');
/** every script that renders model output or talks to /api/chat */
const scripts = () => ['chat.js', 'chat-md.js', 'shell.js', 'dock.js', 'terminal.js'].filter((f) => fs.existsSync(path.join(WEB_DIR, f)));

describe('模型對話 scripts', () => {
  it('never uses innerHTML (model output and task titles are untrusted text)', () => {
    for (const file of scripts()) {
      expect(read(file), file).not.toMatch(/innerHTML/);
    }
  });

  it('keeps HTML / SVG previews sandboxed without same-origin access', () => {
    const owner = scripts().find((f) => read(f).includes('previewFrame'));
    expect(owner, 'no chat script defines previewFrame').toBeTruthy();
    const js = read(owner as string);
    expect(js).toContain("setAttribute('sandbox', 'allow-scripts')");
    expect(js).not.toMatch(/allow-same-origin/);
    expect(js).toContain('Content-Security-Policy');
  });

  it('carries identity on every call and reads the stored timestamps as UTC', () => {
    const shell = read('shell.js');
    // headers are latin1, so a Chinese name only survives percent-encoded (identity.ts decodes it)
    expect(shell).toContain("'x-loop-user': encodeURIComponent(n)");
    // SQLite stores 'YYYY-MM-DD HH:MM:SS' in UTC with no marker — without the Z every row is off
    expect(shell).toMatch(/replace\(' ', 'T'\)\}Z/);
    // a stored screenshot cannot be an <img src>: the bearer token has to ride along
    expect(read('chat.js')).toMatch(/fetch\(im\.url, \{ headers: \{ \.\.\.authHeaders/);
  });

  it('never lets a failed save break the chat, and caps what is replayed into the model', () => {
    const js = read('chat.js');
    // Every history call sits inside a histSafe(...) callback: a storage failure must degrade to
    // in-memory-only behaviour, never break the answer the user is waiting for.
    expect(js).toContain('async function histSafe');
    const lines = js.split('\n');
    const unguarded = lines.filter((line, i) => {
      if (!/chatApi\([`']\/api\/chat\/(conversations|messages)/.test(line)) return false;
      // the window covers the whole enclosing histSafe callback, the longest of which is saveUserTurn
      return !lines.slice(Math.max(0, i - 14), i + 1).some((l) => l.includes('histSafe('));
    });
    expect(unguarded, `history calls outside histSafe: ${unguarded.join(' | ')}`).toEqual([]);
    expect(js).toContain('function modelHistory');
    expect(js).toContain('contextTurns');
  });

  it('remembers each rail state under its loop_shell_* key, in the file that owns that rail', () => {
    expect(read('chat.js')).toContain('loop_shell_rail'); // 對話紀錄
    expect(read('dock.js')).toContain('loop_shell_dock'); // 工作面板
    expect(read('dock.js')).toContain('loop_shell_tab');
  });

  // setText writes ~25 ids once a second inside a try/catch, so a stale id would fail silently
  // forever. This checks every literal lookup in the scripts against the markup instead.
  it('every element id the scripts look up exists in the page', () => {
    const page = html();
    const ids = new Set<string>();
    for (const file of scripts()) {
      const js = read(file);
      for (const m of js.matchAll(/\$\('([\w-]+)'\)/g)) ids.add(m[1] as string);
      for (const m of js.matchAll(/setText\('([\w-]+)'/g)) ids.add(m[1] as string);
    }
    expect(ids.size).toBeGreaterThan(20);
    const missing = [...ids].filter((id) => !page.includes(`id="${id}"`));
    expect(missing, `ids used by chat scripts but absent from index.html: ${missing.join(', ')}`).toEqual([]);
  });
});
