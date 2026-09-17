#!/usr/bin/env node
// GitHub MCP server for Loop Engineering: a thin, read-mostly wrapper over the `gh` CLI, so the
// model can look at PRs / issues / checks with whatever login the operator already has.
//
//   LOOP_DEFAULT_REPO     owner/name used when a tool is called without `repo`
//   LOOP_GH_ALLOW_WRITE   set to 1 to also register pr_create (off by default)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const DEFAULT_REPO = process.env.LOOP_DEFAULT_REPO || '';

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true });

function gh(args) {
  return new Promise((resolve) => {
    execFile('gh', args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message).trim();
        if (/not logged|auth login|authentication/i.test(msg)) resolve({ ok: false, out: 'gh 未登入：請在主機執行 gh auth login' });
        else if (err.code === 'ENOENT') resolve({ ok: false, out: 'gh CLI 未安裝' });
        else resolve({ ok: false, out: msg.slice(0, 500) || `gh 失敗（${err.code}）` });
      } else resolve({ ok: true, out: String(stdout).trim() });
    });
  });
}

const repoArg = (repo) => {
  const r = repo || DEFAULT_REPO;
  if (!r) throw new Error('缺少 repo（owner/name），且 LOOP_DEFAULT_REPO 未設定');
  if (!REPO_RE.test(r)) throw new Error(`repo 格式錯誤：${r}`);
  return ['--repo', r];
};
const guard = (fn) => async (args) => {
  try {
    const r = await fn(args);
    return r;
  } catch (err) {
    return fail(String(err.message || err).slice(0, 300));
  }
};
const run = async (args) => {
  const r = await gh(args);
  return r.ok ? text(r.out || '（沒有結果）') : fail(r.out);
};

const server = new McpServer({ name: 'loop-gh', version: '1.0.0' });
const repoSchema = z.string().regex(REPO_RE).optional().describe('owner/name；省略則用預設 repo');

server.registerTool(
  'repo_view',
  { description: '看 GitHub repo 的基本資料（描述、預設分支、star）。', inputSchema: { repo: repoSchema } },
  guard(({ repo }) => run(['repo', 'view', ...repoArg(repo).slice(1), '--json', 'name,description,defaultBranchRef,stargazerCount,url'])),
);
server.registerTool(
  'pr_list',
  { description: '列出 PR（預設 open，最多 30）。', inputSchema: { repo: repoSchema, state: z.enum(['open', 'closed', 'merged', 'all']).optional(), limit: z.number().int().min(1).max(30).optional() } },
  guard(({ repo, state = 'open', limit = 10 }) => run(['pr', 'list', ...repoArg(repo), '--state', state, '--limit', String(limit), '--json', 'number,title,state,author,updatedAt,url'])),
);
server.registerTool(
  'pr_view',
  { description: '看一個 PR 的標題、內容、分支、狀態與檔案。', inputSchema: { number: z.number().int().min(1), repo: repoSchema } },
  guard(({ number, repo }) => run(['pr', 'view', String(number), ...repoArg(repo), '--json', 'number,title,body,state,author,baseRefName,headRefName,mergeable,url,files'])),
);
server.registerTool(
  'pr_checks',
  { description: '看一個 PR 的 CI 狀態。', inputSchema: { number: z.number().int().min(1), repo: repoSchema } },
  guard(({ number, repo }) => run(['pr', 'checks', String(number), ...repoArg(repo)])),
);
server.registerTool(
  'issue_list',
  { description: '列出 issue（預設 open，最多 30）。', inputSchema: { repo: repoSchema, state: z.enum(['open', 'closed', 'all']).optional(), limit: z.number().int().min(1).max(30).optional() } },
  guard(({ repo, state = 'open', limit = 10 }) => run(['issue', 'list', ...repoArg(repo), '--state', state, '--limit', String(limit), '--json', 'number,title,state,author,updatedAt,url'])),
);
server.registerTool(
  'issue_view',
  { description: '看一個 issue 的內容與留言。', inputSchema: { number: z.number().int().min(1), repo: repoSchema } },
  guard(({ number, repo }) => run(['issue', 'view', String(number), ...repoArg(repo), '--json', 'number,title,body,state,author,url,comments'])),
);
if (process.env.LOOP_GH_ALLOW_WRITE === '1') {
  server.registerTool(
    'pr_create',
    { description: '開一個 PR（只有 LOOP_GH_ALLOW_WRITE=1 時才有這個工具）。', inputSchema: { title: z.string().min(1), body: z.string(), base: z.string().min(1), head: z.string().min(1), repo: repoSchema } },
    guard(({ title, body, base, head, repo }) => run(['pr', 'create', ...repoArg(repo), '--title', title, '--body', body, '--base', base, '--head', head])),
  );
}

await server.connect(new StdioServerTransport());
