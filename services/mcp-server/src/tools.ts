import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { appendEvidenceItem } from '@pilot/db';
import { auditLog } from '@pilot/db/schema';
import { type Db } from '@pilot/db/client';
import { type MemoryService } from '@pilot/memory';
import type { McpTool, McpToolCallResult } from '@pilot/shared/mcp';
import { getCapabilityRecord } from '@pilot/shared/capabilities';

// ─── Pilot-as-MCP-server tool surface (Phase 14 Track A) ───
//
// DB-only whitelist. NO connector-backed tools here — the provider
// can't safely re-use a founder's Gmail/Drive/GitHub token for an
// external MCP client without an explicit per-session grant (tracked
// in Phase 15 Track I). Every tool terminates in a Drizzle query the
// caller has already been authenticated against via the bearer token.

export interface ExposedTool extends McpTool {
  handler: (
    args: Record<string, unknown>,
    ctx: { db: Db; memory?: MemoryService | undefined },
  ) => Promise<McpToolCallResult>;
}

function text(s: unknown): McpToolCallResult {
  return {
    content: [
      {
        type: 'text',
        text: typeof s === 'string' ? s : JSON.stringify(s, null, 2),
      },
    ],
  };
}

function err(message: string): McpToolCallResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

export const PILOT_MCP_TOOLS: ExposedTool[] = [
  {
    name: 'list_opportunities',
    description:
      'List startup opportunities for a workspace. Returns up to 20 rows ordered by creation time desc.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['workspaceId'],
    },
    async handler(args, { db }) {
      const workspaceId = args['workspaceId'];
      if (typeof workspaceId !== 'string') return err('workspaceId is required');
      const limit = Math.max(1, Math.min(50, Number(args['limit'] ?? 20)));
      const { opportunities } = await import('@pilot/db/schema');
      const { eq, desc } = await import('drizzle-orm');
      const rows = await db
        .select()
        .from(opportunities)
        .where(eq(opportunities.workspaceId, workspaceId))
        .orderBy(desc(opportunities.createdAt))
        .limit(limit);
      return text(rows);
    },
  },

  {
    name: 'score_opportunity',
    description:
      'Score an opportunity through Pilot. This MCP surface is intentionally unavailable because autonomous scoring must run through the orchestrator Tool Broker.',
    inputSchema: {
      type: 'object',
      properties: { opportunityId: { type: 'string' } },
      required: ['opportunityId'],
    },
    async handler(args) {
      const opportunityId = args['opportunityId'];
      if (typeof opportunityId !== 'string') return err('opportunityId required');
      return text({
        error: 'score_opportunity is only available through the governed orchestrator Tool Broker',
        opportunityId,
        capability: getCapabilityRecord('opportunity_scoring'),
      });
    },
  },

  {
    name: 'search_knowledge',
    description:
      'Semantic + keyword search across the pgvector knowledge layer. Returns ranked pages.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        workspaceId: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
    async handler(args, { memory }) {
      if (!memory) return err('memory service not available');
      const query = args['query'];
      if (typeof query !== 'string') return err('query required');
      const workspaceId = typeof args['workspaceId'] === 'string' ? args['workspaceId'] : undefined;
      const limit = Math.max(1, Math.min(20, Number(args['limit'] ?? 5)));
      const results = await memory.search(query, { limit, workspaceId });
      return text(results);
    },
  },

  {
    name: 'get_workspace_context',
    description: 'Return a workspace overview (name, mode, member count, active tasks).',
    inputSchema: {
      type: 'object',
      properties: { workspaceId: { type: 'string' } },
      required: ['workspaceId'],
    },
    async handler(args, { db }) {
      const workspaceId = args['workspaceId'];
      if (typeof workspaceId !== 'string') return err('workspaceId required');
      const { workspaces, workspaceMembers, tasks } = await import('@pilot/db/schema');
      const { eq, and, count } = await import('drizzle-orm');
      const [ws] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);
      if (!ws) return err('workspace not found');
      const [memberResult] = await db
        .select({ count: count() })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, workspaceId));
      const [taskResult] = await db
        .select({ count: count() })
        .from(tasks)
        .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, 'pending')));
      return text({
        id: ws.id,
        name: ws.name,
        currentMode: ws.currentMode,
        memberCount: memberResult?.count ?? 0,
        activeTaskCount: taskResult?.count ?? 0,
      });
    },
  },

  {
    name: 'create_task',
    description: 'Create a task inside a workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        mode: { type: 'string' },
        priority: { type: 'number' },
      },
      required: ['workspaceId', 'title'],
    },
    async handler(args, { db }) {
      const workspaceId = args['workspaceId'];
      const title = args['title'];
      if (typeof workspaceId !== 'string' || typeof title !== 'string') {
        return err('workspaceId and title required');
      }
      const description = typeof args['description'] === 'string' ? args['description'] : '';
      const mode = typeof args['mode'] === 'string' ? args['mode'] : 'build';
      const priority = Number(args['priority'] ?? 0);
      const { tasks } = await import('@pilot/db/schema');
      const [row] = await db
        .insert(tasks)
        .values({
          workspaceId,
          title,
          description,
          mode,
          status: 'pending',
          priority,
        })
        .returning();
      return row
        ? text({ id: row.id, title: row.title, status: row.status })
        : err('insert failed');
    },
  },

  {
    name: 'create_artifact',
    description:
      'Create a workspace artifact (document, code, design, copy). Content stored inline.',
    inputSchema: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string' },
        type: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['workspaceId', 'type', 'name'],
    },
    async handler(args, { db }) {
      const workspaceId = args['workspaceId'];
      const atype = args['type'];
      const name = args['name'];
      if (
        typeof workspaceId !== 'string' ||
        typeof atype !== 'string' ||
        typeof name !== 'string'
      ) {
        return err('workspaceId, type, name required');
      }
      const description = typeof args['description'] === 'string' ? args['description'] : '';
      const content = typeof args['content'] === 'string' ? args['content'] : '';
      const { artifacts, artifactVersions } = await import('@pilot/db/schema');
      const storagePath = `inline://${name}`;
      return await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(artifacts)
          .values({
            workspaceId,
            type: atype,
            name,
            description,
            storagePath,
            mimeType: 'text/plain',
            sizeBytes: content.length,
            metadata: content ? { content } : {},
          })
          .returning();
        if (!row) return err('insert failed');
        await tx.insert(artifactVersions).values({
          artifactId: row.id,
          version: 1,
          storagePath,
          sizeBytes: content.length,
          changelog: 'Initial version',
        });
        const auditEventId = randomUUID();
        const replayRef = `artifact:${row.id}:1`;
        const evidenceMetadata = {
          artifactType: atype,
          version: 1,
          mimeType: 'text/plain',
          sizeBytes: content.length,
          storageMode: 'inline_artifact_metadata',
          tool: 'create_artifact',
        };
        const auditMetadata = {
          evidenceType: 'artifact_created',
          replayRef,
          artifactId: row.id,
          ...evidenceMetadata,
        };
        await tx.insert(auditLog).values({
          id: auditEventId,
          workspaceId,
          action: 'ARTIFACT_CREATED',
          actor: `workspace:${workspaceId}`,
          target: row.id,
          verdict: 'created',
          reason: description || `Created ${atype} artifact`,
          metadata: auditMetadata,
        });
        const evidenceItemId = await appendEvidenceItem(tx, {
          workspaceId,
          auditEventId,
          artifactId: row.id,
          evidenceType: 'artifact_created',
          sourceType: 'mcp_server',
          title: `Artifact created: ${row.name}`,
          summary: description || `Created ${atype} artifact`,
          redactionState: 'redacted',
          sensitivity: 'internal',
          contentHash: content ? hashText(content) : null,
          storageRef: storagePath,
          replayRef,
          metadata: evidenceMetadata,
        });
        await tx
          .update(auditLog)
          .set({
            metadata: {
              ...auditMetadata,
              evidenceItemId,
            },
          })
          .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));
        return text({ id: row.id, name: row.name, type: row.type, version: 1, evidenceItemId });
      });
    },
  },
];

export function mcpToolDescriptors(): McpTool[] {
  return PILOT_MCP_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

export function findMcpTool(name: string): ExposedTool | undefined {
  return PILOT_MCP_TOOLS.find((t) => t.name === name);
}

function hashText(text: string) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}
