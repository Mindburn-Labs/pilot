import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { appendEvidenceItem } from '@pilot/db';
import { auditLog } from '@pilot/db/schema';
import { CreateKnowledgePageInput, CreateTimelineEntryInput } from '@pilot/shared/schemas';
import { type GatewayDeps } from '../index.js';
import { getWorkspaceId, requireWorkspaceRole, workspaceIdMismatch } from '../lib/workspace.js';

export function knowledgeRoutes(deps: GatewayDeps) {
  const app = new Hono();

  // GET /api/knowledge/search?q=...&type=...&limit=... — Hybrid search
  app.get('/search', async (c) => {
    const query = c.req.query('q');
    if (!query) return c.json({ error: 'q parameter required' }, 400);

    const types = c.req.query('type')?.split(',');
    const limit = Math.min(Number(c.req.query('limit') ?? '20'), 100);
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);

    const results = await deps.memory.search(query, { types, limit, workspaceId });
    return c.json(results);
  });

  // POST /api/knowledge/pages — Create knowledge page
  app.post('/pages', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'mutate workspace knowledge');
    if (roleDenied) return roleDenied;

    const raw = await c.req.json();
    if (workspaceIdMismatch(c, raw.workspaceId)) {
      return c.json({ error: 'workspaceId does not match authenticated workspace' }, 403);
    }
    const parsed = CreateKnowledgePageInput.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }
    const body = parsed.data;
    const contentHash = hashKnowledgeValue({
      type: body.type,
      title: body.title,
      compiledTruth: body.compiledTruth ?? null,
      tags: body.tags ?? [],
      content: body.content ?? null,
    });
    const proof = await persistKnowledgeMutationProof(deps, {
      workspaceId,
      actor: `user:${c.get('userId') ?? 'unknown'}`,
      action: 'KNOWLEDGE_PAGE_UPSERTED',
      target: `knowledge_page:${contentHash.replace(/^sha256:/, '').slice(0, 16)}`,
      evidenceType: 'knowledge_page_upserted',
      title: `Knowledge page upsert requested: ${body.title}`,
      summary: 'Gateway knowledge API accepted a workspace memory page update.',
      replayRef: `knowledge:page:${contentHash.replace(/^sha256:/, '').slice(0, 16)}`,
      contentHash,
      metadata: {
        type: body.type,
        title: body.title,
        tagCount: body.tags?.length ?? 0,
        hasCompiledTruth: Boolean(body.compiledTruth),
        contentHash,
        evidenceContract: 'knowledge_memory_update_evidence_required',
      },
    });
    if (!proof) return c.json({ error: 'Failed to persist knowledge evidence' }, 500);

    const pageId = await deps.memory.upsertPage({
      workspaceId,
      type: body.type,
      title: body.title,
      compiledTruth: body.compiledTruth,
      tags: body.tags,
      content: body.content,
    });
    return c.json({ id: pageId, evidenceItemId: proof.evidenceItemId }, 201);
  });

  // POST /api/knowledge/pages/:pageId/timeline — Add timeline entry
  app.post('/pages/:pageId/timeline', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'mutate workspace knowledge timeline');
    if (roleDenied) return roleDenied;

    const { pageId } = c.req.param();
    const page = await deps.memory.getPage(pageId);
    if (!page || page.workspaceId !== workspaceId) {
      return c.json({ error: 'Page not found' }, 404);
    }

    const raw = await c.req.json();
    const parsed = CreateTimelineEntryInput.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }
    const body = parsed.data;
    const contentHash = hashKnowledgeValue({
      pageId,
      eventType: body.eventType,
      source: body.source,
      content: body.content,
    });
    const proof = await persistKnowledgeMutationProof(deps, {
      workspaceId,
      actor: `user:${c.get('userId') ?? 'unknown'}`,
      action: 'KNOWLEDGE_TIMELINE_APPENDED',
      target: pageId,
      evidenceType: 'knowledge_timeline_appended',
      title: `Knowledge timeline entry requested: ${body.eventType}`,
      summary: 'Gateway knowledge API accepted a workspace memory timeline update.',
      replayRef: `knowledge:page:${pageId}:timeline:${contentHash.replace(/^sha256:/, '').slice(0, 16)}`,
      contentHash,
      metadata: {
        pageId,
        eventType: body.eventType,
        source: body.source,
        contentHash,
        evidenceContract: 'knowledge_memory_timeline_evidence_required',
      },
    });
    if (!proof) return c.json({ error: 'Failed to persist knowledge evidence' }, 500);

    await deps.memory.addTimeline(pageId, {
      eventType: body.eventType,
      content: body.content,
      source: body.source,
    });
    return c.json({ ok: true, evidenceItemId: proof.evidenceItemId }, 201);
  });

  return app;
}

interface KnowledgeMutationProofInput {
  workspaceId: string;
  actor: string;
  action: string;
  target: string;
  evidenceType: string;
  title: string;
  summary: string;
  replayRef: string;
  contentHash: string;
  metadata: Record<string, unknown>;
}

async function persistKnowledgeMutationProof(
  deps: GatewayDeps,
  input: KnowledgeMutationProofInput,
): Promise<{ auditEventId: string; evidenceItemId: string } | null> {
  try {
    return await deps.db.transaction(async (tx) => {
      const auditEventId = randomUUID();
      const auditMetadata = {
        ...input.metadata,
        replayRef: input.replayRef,
        redactionState: 'redacted',
      };

      await tx.insert(auditLog).values({
        id: auditEventId,
        workspaceId: input.workspaceId,
        action: input.action,
        actor: input.actor,
        target: input.target,
        verdict: 'allow',
        metadata: auditMetadata,
      });

      const evidenceItemId = await appendEvidenceItem(tx, {
        workspaceId: input.workspaceId,
        auditEventId,
        evidenceType: input.evidenceType,
        sourceType: 'gateway_knowledge_route',
        title: input.title,
        summary: input.summary,
        redactionState: 'redacted',
        sensitivity: 'internal',
        contentHash: input.contentHash,
        replayRef: input.replayRef,
        metadata: auditMetadata,
      });

      await tx
        .update(auditLog)
        .set({ metadata: { ...auditMetadata, evidenceItemId } })
        .where(and(eq(auditLog.workspaceId, input.workspaceId), eq(auditLog.id, auditEventId)));

      return { auditEventId, evidenceItemId };
    });
  } catch {
    return null;
  }
}

function hashKnowledgeValue(value: unknown) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
