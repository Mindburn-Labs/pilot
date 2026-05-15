import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { type Db } from '@pilot/db/client';
import { type MemoryService } from '@pilot/memory';
import { findMcpTool, mcpToolDescriptors } from './tools.js';

// ─── Pilot-as-MCP-provider Hono app (Phase 14 Track A) ───
//
// Single POST /mcp endpoint speaking JSON-RPC 2.0 per MCP 2025-11-25.
// Bearer-token auth (constant-time compare) — no anonymous calls. The
// DB-only tool whitelist in ./tools.ts is mounted verbatim; HELM
// governance wraps each handler when the caller sets `HELM_EVALUATE_*`
// env vars upstream (deferred until helm-ai-kernel v0.3.1 merges #43).
//
// OAuth 2.0 resource metadata stub at /.well-known/oauth-protected-resource
// mirrors the shape helm-ai-kernel uses so Claude Desktop / Cursor / Gemini CLI
// can auto-discover the auth scheme.

export interface McpAppConfig {
  db: Db;
  memory?: MemoryService | undefined;
  /**
   * Shared-secret bearer token. When unset the app rejects every call
   * with HTTP 503 — NEVER run anonymously.
   */
  bearerToken?: string | undefined;
  /**
   * Base URL this server is externally reachable at. Used to build the
   * OAuth 2.0 resource metadata document. Default: `http://pilot-mcp:3200`.
   */
  publicBaseUrl?: string | undefined;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export function createMcpApp(cfg: McpAppConfig) {
  const app = new Hono();

  app.get('/mcp/health', (c) =>
    c.json({ ok: true, tools: mcpToolDescriptors().length }),
  );

  app.get('/.well-known/oauth-protected-resource', (c) => {
    const base = cfg.publicBaseUrl ?? 'http://pilot-mcp:3200';
    return c.json({
      resource: `${base}/mcp`,
      authorization_servers: [],
      bearer_methods_supported: ['header'],
      resource_documentation: 'https://modelcontextprotocol.io',
    });
  });

  app.post('/mcp', async (c) => {
    if (!cfg.bearerToken) {
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'MCP server not configured (no bearer token)' },
          id: null,
        },
        503,
      );
    }

    const auth = c.req.header('authorization') ?? '';
    if (!auth.toLowerCase().startsWith('bearer ')) {
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized' },
          id: null,
        },
        401,
      );
    }
    const presented = Buffer.from(auth.slice(7));
    const expected = Buffer.from(cfg.bearerToken);
    const ok =
      presented.length === expected.length &&
      timingSafeEqual(presented, expected);
    if (!ok) {
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Unauthorized' },
          id: null,
        },
        401,
      );
    }

    let body: JsonRpcRequest;
    try {
      body = (await c.req.json()) as JsonRpcRequest;
    } catch {
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error' },
          id: null,
        },
        400,
      );
    }
    if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Invalid Request' },
          id: body?.id ?? null,
        },
        400,
      );
    }

    const id = body.id ?? null;

    try {
      switch (body.method) {
        case 'initialize':
          return c.json({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'pilot-mcp', version: '0.1.0' },
            },
          });

        case 'tools/list':
          return c.json({
            jsonrpc: '2.0',
            id,
            result: { tools: mcpToolDescriptors() },
          });

        case 'tools/call': {
          const params = body.params ?? {};
          const name = params['name'];
          if (typeof name !== 'string') {
            return c.json({
              jsonrpc: '2.0',
              id,
              error: { code: -32602, message: 'params.name required' },
            });
          }
          const tool = findMcpTool(name);
          if (!tool) {
            return c.json({
              jsonrpc: '2.0',
              id,
              error: { code: -32601, message: `Unknown tool: ${name}` },
            });
          }
          const args =
            typeof params['arguments'] === 'object' && params['arguments'] !== null
              ? (params['arguments'] as Record<string, unknown>)
              : {};
          const result = await tool.handler(args, {
            db: cfg.db,
            memory: cfg.memory,
          });
          return c.json({ jsonrpc: '2.0', id, result });
        }

        default:
          return c.json({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${body.method}` },
          });
      }
    } catch (err) {
      return c.json({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : 'Internal error',
        },
      });
    }
  });

  return app;
}
