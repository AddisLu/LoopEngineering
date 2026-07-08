#!/usr/bin/env node
// Loop Engineering read-only SSoT MCP server (Streamable HTTP transport).
// For non-local MCP clients (tailnet). Exposes ONLY loop_search / loop_recall / loop_sources
// and the ssot://sources, ssot://graph resources — no task/deploy/schedule mutation surface.
// Authenticates with LOOP_READONLY_TOKEN, both at the HTTP layer and via the REST calls it makes.
//
// Config (auto-detected; override via env if needed):
//   LOOP_API_URL          base URL of the board API        (default http://127.0.0.1:<port>)
//   LOOP_READONLY_TOKEN    bearer token for /api/* GET reads (default: read from the deploy env file)
//   LOOP_MCP_PORT          HTTP port to listen on            (default 4713)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import http from 'node:http';
import { readEnvFile, BASE, createApi } from './lib.mjs';

const RO = process.env.LOOP_READONLY_TOKEN || readEnvFile().LOOP_READONLY_TOKEN || '';
const api = createApi({ base: BASE, token: RO });

// Stateless Streamable HTTP: the SDK's Protocol only accepts one transport per
// connect() call, so each request gets its own McpServer + transport pair.
function buildServer() {
  const server = new McpServer({ name: 'loop-engineering-ssot', version: '1.0.0' });

  server.registerTool('loop_sources', {
    title: 'List SSoT ingestion sources',
    description:
      'List registered SSoT ingestion sources (git repos / folders / Obsidian vaults): id, kind, uri, enabled, ' +
      'last_ingested_at.',
    inputSchema: {},
  }, async () => {
    try {
      const { sources } = await api('/api/sources');
      if (!sources?.length) return { content: [{ type: 'text', text: '(no sources registered)' }] };
      const rows = sources.map((s) =>
        `${s.id}  [${s.kind}] ${s.enabled ? 'on ' : 'off'}  ${s.uri}  last=${s.last_ingested_at ?? '-'}`);
      return { content: [{ type: 'text', text: rows.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Could not list sources: ${e.message}` }] };
    }
  });

  server.registerTool('loop_search', {
    title: 'Hybrid RAG search over the SSoT corpus',
    description:
      '混合語義+全文檢索 SSoT 語料庫（documents/chunks，由 loop_ingest 擷取）— FTS5 trigram 全文與向量 KNN 語意檢索以 RRF ' +
      '(Reciprocal Rank Fusion) 融合排序，回傳帶引用（來源路徑/行號/分數）的片段。用於「這段程式碼/決策在哪裡」之類的問題。' +
      '若伺服器 rag_enabled 設定為 false（向量嵌入未啟用），自動退回純 FTS 全文檢索，仍可用。',
    inputSchema: {
      q: z.string().describe('REQUIRED. Search query (keywords or a natural-language question).'),
      scope: z.string().optional().describe('Restrict to one ingested source/repo — an absolute path prefix matching a registered source uri (see loop_sources).'),
      kind: z.string().optional().describe('Restrict to one document kind, e.g. "md" or "ts" (the file extension recorded at ingest time).'),
      top_k: z.number().int().optional().describe('Max results (default: the server rag_top_k setting, usually 8).'),
    },
  }, async (a) => {
    try {
      const qs = new URLSearchParams({ q: a.q });
      if (a.scope) qs.set('scope', a.scope);
      if (a.kind) qs.set('kind', a.kind);
      if (a.top_k != null) qs.set('topK', String(a.top_k));
      const { results } = await api(`/api/rag/search?${qs.toString()}`);
      if (!results?.length) return { content: [{ type: 'text', text: `(no chunks match "${a.q}")` }] };
      const lines = results.map((r) => {
        const lineRef = r.start_line != null ? `:${r.start_line}-${r.end_line ?? r.start_line}` : '';
        const excerpt = String(r.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
        return `${r.path}${lineRef}  (score ${Number(r.score).toFixed(3)})\n  ${excerpt}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Search failed: ${e.message}` }] };
    }
  });

  server.registerTool('loop_recall', {
    title: 'Recall facts from the Loop knowledge base',
    description:
      '回想 — full-text search the Loop knowledge base for facts/preferences/constraints/environment notes relevant to the current ' +
      'task or conversation.',
    inputSchema: {
      q: z.string().describe('REQUIRED. Search query (keywords or phrase).'),
      kind: z.string().optional().describe('optional kind filter: environment|project|constraint|preference|tech|fact|person|repo.'),
      limit: z.number().int().optional().describe('max results (default 10).'),
    },
  }, async (a) => {
    try {
      const qs = new URLSearchParams({ q: a.q });
      if (a.kind) qs.set('kind', a.kind);
      const res = await api(`/api/knowledge?${qs.toString()}`);
      let nodes = Array.isArray(res.nodes) ? res.nodes : [];
      const limit = a.limit ?? 10;
      nodes = nodes.slice(0, limit);
      if (!nodes.length) return { content: [{ type: 'text', text: `(no knowledge nodes match "${a.q}")` }] };
      const lines = nodes.map((n) => {
        const body = String(n.body ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
        return `${n.id}  [${n.kind}] ${n.scope}  ${n.title}${body ? ' — ' + body : ''}`;
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Could not recall: ${e.message}` }] };
    }
  });

  server.registerResource(
    'ssot-sources',
    'ssot://sources',
    {
      title: 'SSoT ingestion sources',
      description: '已登錄的 SSoT 擷取來源（git/folder/vault）— 治理 walker 的輸入清單，含啟用狀態與最近擷取時間。',
      mimeType: 'application/json',
    },
    async (uri) => {
      const { sources } = await api('/api/sources');
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(sources ?? [], null, 2) }] };
    },
  );

  server.registerResource(
    'ssot-graph',
    'ssot://graph',
    {
      title: 'SSoT curated knowledge graph',
      description: '策展知識圖譜（knowledge_nodes/edges）— 人工核可、會注入任務 prompt 的小量知識，與語料層 documents/chunks 分開。',
      mimeType: 'application/json',
    },
    async (uri) => {
      const graph = await api('/api/knowledge/graph');
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(graph ?? {}, null, 2) }] };
    },
  );

  return server;
}

const PORT = Number(process.env.LOOP_MCP_PORT || 4713);

const httpServer = http.createServer(async (req, res) => {
  if (RO && req.headers.authorization !== 'Bearer ' + RO) {
    res.writeHead(401).end('unauthorized');
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/mcp') {
    res.writeHead(404).end('not found');
    return;
  }

  let parsedBody;
  if (req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw) {
      try {
        parsedBody = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
        return;
      }
    }
  }

  const mcpServer = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    transport.close();
    mcpServer.close();
  });
  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null }));
    }
  }
});

httpServer.listen(PORT, '127.0.0.1', () => {
  const authNote = RO ? '' : ' (WARNING: no LOOP_READONLY_TOKEN set — unauthenticated)';
  console.error(`loop-ssot-mcp: read-only SSoT MCP listening on http://127.0.0.1:${PORT}/mcp${authNote}`);
});
