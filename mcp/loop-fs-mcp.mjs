#!/usr/bin/env node
// Read-only filesystem MCP server for Loop Engineering.
//
// Exposes list / read / search over a fixed set of roots (LOOP_FS_ROOTS, CSV of absolute paths —
// Loop fills it from the registered knowledge sources + prd_repo_allowlist). Every path is
// realpath'd and must stay inside a root, so symlinks cannot walk out. There is deliberately no
// write, delete or exec tool in this file.
//
//   LOOP_FS_ROOTS   comma-separated absolute directories the model may read
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const ROOTS = (process.env.LOOP_FS_ROOTS || '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s && path.isAbsolute(s))
  .flatMap((s) => {
    try {
      return [fs.realpathSync(s)];
    } catch {
      return [];
    }
  });

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.venv', 'venv']);
const MAX_READ = 64 * 1024;
const MAX_HITS = 200;

class Denied extends Error {}

/** Resolve a user path against the roots; throws Denied when it escapes or the root list is empty. */
function inside(p) {
  if (!ROOTS.length) throw new Denied('沒有可讀的目錄（LOOP_FS_ROOTS 是空的）');
  const abs = path.isAbsolute(p) ? p : path.join(ROOTS[0], p);
  let real;
  try {
    real = fs.realpathSync(abs);
  } catch {
    throw new Denied(`找不到：${p}`);
  }
  const ok = ROOTS.some((r) => real === r || real.startsWith(r + path.sep));
  if (!ok) throw new Denied(`不在允許的目錄內：${p}`);
  return real;
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });
const guard = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    return fail(err instanceof Denied ? err.message : `錯誤：${String(err.message || err).slice(0, 200)}`);
  }
};

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

const server = new McpServer({ name: 'loop-fs', version: '1.0.0' });

server.registerTool(
  'resolve_roots',
  { description: '列出這個 server 允許讀取的目錄（其他工具的路徑都必須在這些目錄內）。', inputSchema: {} },
  guard(async () => text(ROOTS.length ? ROOTS.join('\n') : '（沒有允許的目錄）')),
);

server.registerTool(
  'list_dir',
  {
    description: '列出目錄內容（唯讀）。回傳每一項的類型與大小；depth 最多 2。跳過 node_modules／.git 等。',
    inputSchema: { path: z.string().describe('絕對路徑，或相對於第一個允許目錄'), depth: z.number().int().min(1).max(2).optional(), include_hidden: z.boolean().optional() },
  },
  guard(async ({ path: p, depth = 1, include_hidden = false }) => {
    const root = inside(p);
    const lines = [];
    const walk = (dir, level) => {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch (err) {
        lines.push(`${dir}: ${err.code || err.message}`);
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (!include_hidden && e.name.startsWith('.')) continue;
        if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
        const rel = path.relative(root, path.join(dir, e.name)) || e.name;
        if (e.isDirectory()) {
          lines.push(`${rel}/`);
          if (level < depth) walk(path.join(dir, e.name), level + 1);
        } else {
          let size = '';
          try {
            size = ` (${fs.statSync(path.join(dir, e.name)).size} B)`;
          } catch {
            /* unreadable */
          }
          lines.push(`${rel}${size}`);
        }
        if (lines.length >= 2000) {
          lines.push('…（超過 2000 項，已截斷）');
          return;
        }
      }
    };
    const st = fs.statSync(root);
    if (!st.isDirectory()) return fail(`不是目錄：${p}`);
    walk(root, 1);
    return text(`${root}\n${lines.join('\n') || '（空目錄）'}`);
  }),
);

server.registerTool(
  'read_file',
  {
    description: '讀取一個文字檔（唯讀，最多 64 KB；二進位檔會拒絕）。可用 start_line / max_lines 只看一段。',
    inputSchema: {
      path: z.string(),
      start_line: z.number().int().min(1).optional(),
      max_lines: z.number().int().min(1).max(2000).optional(),
    },
  },
  guard(async ({ path: p, start_line = 1, max_lines = 400 }) => {
    const file = inside(p);
    const st = fs.statSync(file);
    if (st.isDirectory()) return fail(`是目錄，不是檔案：${p}（用 list_dir）`);
    const fd = fs.openSync(file, 'r');
    let buf;
    try {
      buf = Buffer.alloc(Math.min(st.size, MAX_READ));
      fs.readSync(fd, buf, 0, buf.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    if (isBinary(buf)) return fail(`二進位檔，不讀：${p}`);
    const all = buf.toString('utf8').split('\n');
    const slice = all.slice(start_line - 1, start_line - 1 + max_lines);
    const numbered = slice.map((l, i) => `${String(start_line + i).padStart(5)}| ${l}`).join('\n');
    const note = st.size > MAX_READ ? `\n…（檔案 ${st.size} B，只讀了前 64 KB）` : all.length > start_line - 1 + max_lines ? `\n…（還有 ${all.length - (start_line - 1 + max_lines)} 行）` : '';
    return text(`${file}\n${numbered}${note}`);
  }),
);

server.registerTool(
  'search_text',
  {
    description: '在允許的目錄裡用字串／正規式搜尋（唯讀，grep -rn）。回傳 檔案:行號: 內容，最多 200 筆。',
    inputSchema: {
      query: z.string().min(1),
      path: z.string().optional().describe('限制在這個子目錄；預設第一個允許目錄'),
      glob: z.string().optional().describe('檔名樣式，例如 *.cpp'),
      max_hits: z.number().int().min(1).max(MAX_HITS).optional(),
      regex: z.boolean().optional(),
    },
  },
  guard(async ({ query, path: p, glob, max_hits = 100, regex = false }) => {
    const dir = inside(p || ROOTS[0]);
    const args = ['-rn', '-I', '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=dist', '--exclude-dir=build'];
    args.push(regex ? '-E' : '-F');
    if (glob) args.push(`--include=${glob}`);
    args.push('--', query, dir);
    const out = await new Promise((resolve) => {
      execFile('grep', args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(stdout || (err && err.code === 1 ? '' : stdout)));
    });
    const lines = String(out).split('\n').filter(Boolean);
    const shown = lines.slice(0, max_hits).map((l) => l.replace(dir + path.sep, ''));
    return text(shown.length ? `${shown.join('\n')}${lines.length > max_hits ? `\n…（共 ${lines.length} 筆，只列 ${max_hits}）` : ''}` : '（沒有符合的內容）');
  }),
);

await server.connect(new StdioServerTransport());
