import { describe, expect, it, vi } from 'vitest';
import type { Db } from '@pilot/db/client';
import { artifactVersions, artifacts, auditLog, evidenceItems } from '@pilot/db/schema';
import { createMcpApp } from '../app.js';

// ─── Pilot MCP provider app tests (Phase 14 Track A) ───
//
// Exercises initialize / tools/list / auth errors purely through
// Hono's `app.fetch(new Request(...))` — no real DB, no real port.

const BEARER = 'test-token-1234567890abcdef';
const dbStub = {} as unknown as Db;

function createArtifactMcpDb(options: { failEvidenceInsert?: boolean } = {}) {
  const insertedArtifacts: unknown[] = [];
  const insertedArtifactVersions: unknown[] = [];
  const insertedEvidenceItems: unknown[] = [];
  const insertedAudit: unknown[] = [];
  const updatedAudit: unknown[] = [];
  const transactionInsertOrder: string[] = [];

  const createDbFacade = (
    artifactSink: unknown[],
    artifactVersionSink: unknown[],
    evidenceSink: unknown[],
    auditSink: unknown[],
    auditUpdateSink: unknown[],
  ) => ({
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: unknown) => {
        if (table === artifacts) {
          artifactSink.push(value);
          return {
            returning: vi.fn(async () => [
              {
                id: '00000000-0000-4000-8000-000000000030',
                name: (value as { name: string }).name,
                type: (value as { type: string }).type,
              },
            ]),
          };
        }
        if (table === artifactVersions) {
          transactionInsertOrder.push('artifact_versions');
          artifactVersionSink.push(value);
          return {};
        }
        if (table === auditLog) {
          transactionInsertOrder.push('audit_log');
          auditSink.push(value);
          return {};
        }
        if (table === evidenceItems) {
          transactionInsertOrder.push('evidence_items');
          evidenceSink.push(value);
          return {
            returning: vi.fn(async () => {
              if (options.failEvidenceInsert) throw new Error('evidence ledger unavailable');
              return [
                {
                  id: '00000000-0000-4000-8000-000000000031',
                },
              ];
            }),
          };
        }
        return { returning: vi.fn(async () => []) };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((value: unknown) => {
        if (table === auditLog) auditUpdateSink.push(value);
        return { where: vi.fn(async () => []) };
      }),
    })),
  });

  const db = {
    ...createDbFacade(
      insertedArtifacts,
      insertedArtifactVersions,
      insertedEvidenceItems,
      insertedAudit,
      updatedAudit,
    ),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const stagedArtifacts: unknown[] = [];
      const stagedArtifactVersions: unknown[] = [];
      const stagedEvidenceItems: unknown[] = [];
      const stagedAudit: unknown[] = [];
      const stagedAuditUpdates: unknown[] = [];
      const result = await callback(
        createDbFacade(
          stagedArtifacts,
          stagedArtifactVersions,
          stagedEvidenceItems,
          stagedAudit,
          stagedAuditUpdates,
        ),
      );
      insertedArtifacts.push(...stagedArtifacts);
      insertedArtifactVersions.push(...stagedArtifactVersions);
      insertedEvidenceItems.push(...stagedEvidenceItems);
      insertedAudit.push(...stagedAudit);
      updatedAudit.push(...stagedAuditUpdates);
      return result;
    }),
  };
  return {
    db: db as unknown as Db,
    insertedArtifacts,
    insertedArtifactVersions,
    insertedEvidenceItems,
    insertedAudit,
    updatedAudit,
    transactionInsertOrder,
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://test.local/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('createMcpApp', () => {
  const app = createMcpApp({ db: dbStub, bearerToken: BEARER });

  it('GET /mcp/health returns tool count', async () => {
    const res = await app.fetch(new Request('http://test.local/mcp/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; tools: number };
    expect(body.ok).toBe(true);
    expect(body.tools).toBeGreaterThan(0);
  });

  it('GET /.well-known/oauth-protected-resource returns metadata', async () => {
    const res = await app.fetch(
      new Request('http://test.local/.well-known/oauth-protected-resource'),
    );
    expect(res.status).toBe(200);
    const meta = (await res.json()) as {
      resource: string;
      bearer_methods_supported: string[];
    };
    expect(meta.resource).toMatch(/\/mcp$/);
    expect(meta.bearer_methods_supported).toContain('header');
  });

  it('rejects missing Authorization header with 401', async () => {
    const res = await app.fetch(
      post({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    );
    expect(res.status).toBe(401);
  });

  it('rejects wrong bearer token with 401', async () => {
    const res = await app.fetch(
      post(
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { authorization: 'Bearer wrong-token-1234567890' },
      ),
    );
    expect(res.status).toBe(401);
  });

  it('initialize returns MCP 2025-11-25 server info', async () => {
    const res = await app.fetch(
      post(
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { authorization: `Bearer ${BEARER}` },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe('2025-11-25');
    expect(body.result.serverInfo.name).toBe('pilot-mcp');
  });

  it('tools/list returns the DB-only whitelist', async () => {
    const res = await app.fetch(
      post(
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { authorization: `Bearer ${BEARER}` },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain('list_opportunities');
    expect(names).toContain('search_knowledge');
    expect(names).toContain('get_workspace_context');
    expect(names).toContain('create_task');
    expect(names).toContain('create_artifact');
    expect(names).not.toContain('github_create_repo'); // intentionally excluded
  });

  it('tools/call on unknown tool returns JSON-RPC error -32601', async () => {
    const res = await app.fetch(
      post(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'no_such_tool', arguments: {} },
        },
        { authorization: `Bearer ${BEARER}` },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error.code).toBe(-32601);
  });

  it('tools/call create_artifact indexes the artifact as canonical evidence', async () => {
    const {
      db,
      insertedArtifacts,
      insertedArtifactVersions,
      insertedEvidenceItems,
      insertedAudit,
      updatedAudit,
      transactionInsertOrder,
    } = createArtifactMcpDb();
    const appWithDb = createMcpApp({ db, bearerToken: BEARER });

    const res = await appWithDb.fetch(
      post(
        {
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: {
            name: 'create_artifact',
            arguments: {
              workspaceId: '00000000-0000-4000-8000-000000000001',
              type: 'copy',
              name: 'launch-email.txt',
              description: 'Launch email draft',
              content: 'Pilot is live.',
            },
          },
        },
        { authorization: `Bearer ${BEARER}` },
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    const payload = JSON.parse(body.result.content[0]!.text) as {
      id: string;
      name: string;
      type: string;
      version: number;
      evidenceItemId: string;
    };

    expect(insertedArtifacts[0]).toMatchObject({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      type: 'copy',
      name: 'launch-email.txt',
      description: 'Launch email draft',
      storagePath: 'inline://launch-email.txt',
      mimeType: 'text/plain',
      sizeBytes: 14,
      metadata: { content: 'Pilot is live.' },
    });
    expect(insertedArtifactVersions[0]).toMatchObject({
      artifactId: '00000000-0000-4000-8000-000000000030',
      version: 1,
      storagePath: 'inline://launch-email.txt',
      sizeBytes: 14,
    });
    expect(insertedAudit[0]).toMatchObject({
      id: expect.any(String),
      workspaceId: '00000000-0000-4000-8000-000000000001',
      action: 'ARTIFACT_CREATED',
      actor: 'workspace:00000000-0000-4000-8000-000000000001',
      target: '00000000-0000-4000-8000-000000000030',
      verdict: 'created',
      metadata: expect.objectContaining({
        evidenceType: 'artifact_created',
        replayRef: 'artifact:00000000-0000-4000-8000-000000000030:1',
        artifactId: '00000000-0000-4000-8000-000000000030',
      }),
    });
    expect(insertedEvidenceItems[0]).toMatchObject({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      auditEventId: (insertedAudit[0] as { id: string }).id,
      artifactId: '00000000-0000-4000-8000-000000000030',
      evidenceType: 'artifact_created',
      sourceType: 'mcp_server',
      title: 'Artifact created: launch-email.txt',
      summary: 'Launch email draft',
      redactionState: 'redacted',
      contentHash: expect.stringMatching(/^sha256:/u),
      storageRef: 'inline://launch-email.txt',
      replayRef: 'artifact:00000000-0000-4000-8000-000000000030:1',
    });
    expect(updatedAudit[0]).toMatchObject({
      metadata: expect.objectContaining({
        evidenceItemId: '00000000-0000-4000-8000-000000000031',
      }),
    });
    expect(transactionInsertOrder.indexOf('audit_log')).toBeLessThan(
      transactionInsertOrder.indexOf('evidence_items'),
    );
    expect(payload).toEqual({
      id: '00000000-0000-4000-8000-000000000030',
      name: 'launch-email.txt',
      type: 'copy',
      version: 1,
      evidenceItemId: '00000000-0000-4000-8000-000000000031',
    });
  });

  it('tools/call create_artifact does not commit artifact state when evidence persistence fails', async () => {
    const {
      db,
      insertedArtifacts,
      insertedArtifactVersions,
      insertedEvidenceItems,
      insertedAudit,
      updatedAudit,
    } = createArtifactMcpDb({ failEvidenceInsert: true });
    const appWithDb = createMcpApp({ db, bearerToken: BEARER });

    const res = await appWithDb.fetch(
      post(
        {
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: {
            name: 'create_artifact',
            arguments: {
              workspaceId: '00000000-0000-4000-8000-000000000001',
              type: 'copy',
              name: 'launch-email.txt',
              description: 'Launch email draft',
              content: 'Pilot is live.',
            },
          },
        },
        { authorization: `Bearer ${BEARER}` },
      ),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error).toEqual({
      code: -32603,
      message: 'evidence ledger unavailable',
    });
    expect(insertedArtifacts).toEqual([]);
    expect(insertedArtifactVersions).toEqual([]);
    expect(insertedEvidenceItems).toEqual([]);
    expect(insertedAudit).toEqual([]);
    expect(updatedAudit).toEqual([]);
  });

  it('malformed JSON returns -32700', async () => {
    const res = await app.fetch(
      new Request('http://test.local/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${BEARER}`,
        },
        body: '{not json',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it('unknown method returns -32601', async () => {
    const res = await app.fetch(
      post(
        { jsonrpc: '2.0', id: 9, method: 'resources/list' },
        { authorization: `Bearer ${BEARER}` },
      ),
    );
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });

  it('server with no bearer token configured refuses with 503', async () => {
    const noAuth = createMcpApp({ db: dbStub, bearerToken: undefined });
    const res = await noAuth.fetch(
      post(
        { jsonrpc: '2.0', id: 1, method: 'initialize' },
        { authorization: 'Bearer anything' },
      ),
    );
    expect(res.status).toBe(503);
  });
});
