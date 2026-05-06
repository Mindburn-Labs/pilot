import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { appendEvidenceItem } from '@pilot/db';
import { auditLog } from '@pilot/db/schema';
import { YcIntelService } from '@pilot/yc-intel';
import {
  YcPrivateIngestionInput,
  YcPublicIngestionInput,
  YcReplayIngestionInput,
} from '@pilot/shared/schemas';
import { type GatewayDeps } from '../index.js';
import { getWorkspaceId, requireWorkspaceRole } from '../lib/workspace.js';

type YcIngestionProofInput = {
  workspaceId: string;
  actorUserId?: string;
  action: string;
  evidenceType: string;
  title: string;
  summary: string;
  replayRef: string;
  metadata: Record<string, unknown>;
};

async function persistYcIngestionProof(
  db: GatewayDeps['db'],
  input: YcIngestionProofInput,
): Promise<{ auditEventId: string; evidenceItemId: string }> {
  const auditEventId = randomUUID();

  const evidenceItemId = await db.transaction(async (tx) => {
    await tx.insert(auditLog).values({
      id: auditEventId,
      workspaceId: input.workspaceId,
      action: input.action,
      actor: `user:${input.actorUserId ?? 'unknown'}`,
      target: input.workspaceId,
      verdict: 'allow',
      metadata: {
        evidenceType: input.evidenceType,
        replayRef: input.replayRef,
        queued: false,
        ...input.metadata,
      },
    });

    const createdEvidenceItemId = await appendEvidenceItem(tx, {
      workspaceId: input.workspaceId,
      auditEventId,
      evidenceType: input.evidenceType,
      sourceType: 'gateway_yc_route',
      title: input.title,
      summary: input.summary,
      redactionState: 'redacted',
      sensitivity: 'internal',
      replayRef: input.replayRef,
      metadata: input.metadata,
    });

    await tx
      .update(auditLog)
      .set({
        metadata: {
          evidenceType: input.evidenceType,
          replayRef: input.replayRef,
          queued: false,
          evidenceItemId: createdEvidenceItemId,
          ...input.metadata,
        },
      })
      .where(and(eq(auditLog.workspaceId, input.workspaceId), eq(auditLog.id, auditEventId)));

    return createdEvidenceItemId;
  });

  return { auditEventId, evidenceItemId };
}

export function ycRoutes(deps: GatewayDeps) {
  const yc = new YcIntelService(deps.db);
  const app = new Hono();

  // GET /api/yc/companies?q=...&limit=...
  app.get('/companies', async (c) => {
    const q = c.req.query('q') ?? '';
    const limit = Number(c.req.query('limit') ?? '20');
    const results = await yc.searchCompanies(q, Math.min(limit, 100));
    return c.json(results);
  });

  // GET /api/yc/companies/:id
  app.get('/companies/:id', async (c) => {
    const result = await yc.getCompany(c.req.param('id'));
    if (!result) return c.json({ error: 'Not found' }, 404);
    return c.json(result);
  });

  // GET /api/yc/batches
  app.get('/batches', async (c) => {
    const batches = await yc.listBatches();
    return c.json(batches);
  });

  // GET /api/yc/advice?q=...
  app.get('/advice', async (c) => {
    const q = c.req.query('q') ?? '';
    const limit = Number(c.req.query('limit') ?? '20');
    const results = await yc.searchAdvice(q, Math.min(limit, 100));
    return c.json(results);
  });

  // GET /api/yc/stats
  app.get('/stats', async (c) => {
    const stats = await yc.getCompanyStats();
    return c.json(stats);
  });

  // GET /api/yc/tags/:tag/advice
  app.get('/tags/:tag/advice', async (c) => {
    const limit = Number(c.req.query('limit') ?? '20');
    const results = await yc.searchAdviceByTag(c.req.param('tag'), Math.min(limit, 100));
    return c.json(results);
  });

  // GET /api/yc/courses/:program
  app.get('/courses/:program', async (c) => {
    const modules = await yc.getCourseModules(c.req.param('program'));
    return c.json(modules);
  });

  // GET /api/yc/ingestion/history
  app.get('/ingestion/history', async (c) => {
    const limit = Number(c.req.query('limit') ?? '50');
    const history = await yc.getIngestionHistory(Math.min(limit, 100));
    return c.json(history);
  });

  app.get('/ingestion/:id', async (c) => {
    const record = await yc.getIngestionRecord(c.req.param('id'));
    if (!record) return c.json({ error: 'Ingestion record not found' }, 404);
    return c.json(record);
  });

  app.post('/ingestion/public', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'queue YC public ingestion');
    if (roleDenied) return roleDenied;
    if (!deps.orchestrator.boss) return c.json({ error: 'Background jobs unavailable' }, 503);

    const raw = await c.req.json().catch(() => ({}));
    const parsed = YcPublicIngestionInput.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const queues = [
      ...(parsed.data.source === 'companies' || parsed.data.source === 'all'
        ? ['pipeline.yc-scrape']
        : []),
      ...(parsed.data.source === 'library' || parsed.data.source === 'all'
        ? ['pipeline.startup-school']
        : []),
    ];
    const replayRef = `yc-ingestion:${workspaceId}:public:${randomUUID()}`;
    const proof = await persistYcIngestionProof(deps.db, {
      workspaceId,
      actorUserId: c.get('userId'),
      action: 'YC_PUBLIC_INGESTION_REQUESTED',
      evidenceType: 'yc_public_ingestion_requested',
      title: 'YC public ingestion requested',
      summary: `YC public ingestion queued for ${parsed.data.source}.`,
      replayRef,
      metadata: {
        source: parsed.data.source,
        batch: parsed.data.batch ?? null,
        limit: parsed.data.limit ?? null,
        queues,
        evidenceContract: 'yc_public_ingestion_request_evidence_required',
      },
    }).catch(() => null);
    if (!proof) return c.json({ error: 'Failed to persist YC public ingestion evidence' }, 500);

    const jobs: Array<{ queue: string; jobId: string | null }> = [];
    if (parsed.data.source === 'companies' || parsed.data.source === 'all') {
      const jobId = await deps.orchestrator.boss.send('pipeline.yc-scrape', {
        workspaceId,
        batch: parsed.data.batch,
        limit: parsed.data.limit,
        auditEventId: proof.auditEventId,
        evidenceItemId: proof.evidenceItemId,
        replayRef,
      });
      jobs.push({ queue: 'pipeline.yc-scrape', jobId: jobId ?? null });
    }

    if (parsed.data.source === 'library' || parsed.data.source === 'all') {
      const jobId = await deps.orchestrator.boss.send('pipeline.startup-school', {
        workspaceId,
        limit: parsed.data.limit,
        auditEventId: proof.auditEventId,
        evidenceItemId: proof.evidenceItemId,
        replayRef,
      });
      jobs.push({ queue: 'pipeline.startup-school', jobId: jobId ?? null });
    }

    await deps.db
      .update(auditLog)
      .set({
        metadata: {
          evidenceType: 'yc_public_ingestion_requested',
          replayRef,
          queued: true,
          jobs,
          evidenceItemId: proof.evidenceItemId,
          source: parsed.data.source,
          batch: parsed.data.batch ?? null,
          limit: parsed.data.limit ?? null,
          queues,
          evidenceContract: 'yc_public_ingestion_request_evidence_required',
        },
      })
      .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, proof.auditEventId)));

    return c.json({ queued: true, jobs, evidenceItemId: proof.evidenceItemId }, 202);
  });

  app.post('/ingestion/private', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'owner', 'queue YC private ingestion');
    if (roleDenied) return roleDenied;
    if (!deps.orchestrator.boss) return c.json({ error: 'Background jobs unavailable' }, 503);
    if (!deps.connectors) return c.json({ error: 'Connectors not configured' }, 503);

    const raw = await c.req.json().catch(() => ({}));
    const parsed = YcPrivateIngestionInput.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const grant = await deps.connectors.getGrantByWorkspaceConnector(workspaceId, 'yc');
    if (!grant || grant.id !== parsed.data.grantId) {
      return c.json({ error: 'Connector grant not found' }, 404);
    }

    const replayRef = `yc-ingestion:${workspaceId}:private:${randomUUID()}`;
    const proof = await persistYcIngestionProof(deps.db, {
      workspaceId,
      actorUserId: c.get('userId'),
      action: 'YC_PRIVATE_INGESTION_REQUESTED',
      evidenceType: 'yc_private_ingestion_requested',
      title: 'YC private ingestion requested',
      summary: 'YC private connector ingestion queued through a workspace grant.',
      replayRef,
      metadata: {
        grantId: parsed.data.grantId,
        action: parsed.data.action,
        limit: parsed.data.limit ?? null,
        queue: 'pipeline.yc-private',
        evidenceContract: 'yc_private_ingestion_request_evidence_required',
      },
    }).catch(() => null);
    if (!proof) return c.json({ error: 'Failed to persist YC private ingestion evidence' }, 500);

    const jobId = await deps.orchestrator.boss.send('pipeline.yc-private', {
      workspaceId,
      grantId: parsed.data.grantId,
      action: parsed.data.action,
      limit: parsed.data.limit,
      auditEventId: proof.auditEventId,
      evidenceItemId: proof.evidenceItemId,
      replayRef,
    });

    await deps.db
      .update(auditLog)
      .set({
        metadata: {
          evidenceType: 'yc_private_ingestion_requested',
          replayRef,
          queued: true,
          jobId: jobId ?? null,
          evidenceItemId: proof.evidenceItemId,
          grantId: parsed.data.grantId,
          action: parsed.data.action,
          limit: parsed.data.limit ?? null,
          queue: 'pipeline.yc-private',
          evidenceContract: 'yc_private_ingestion_request_evidence_required',
        },
      })
      .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, proof.auditEventId)));

    return c.json(
      { queued: true, queue: 'pipeline.yc-private', jobId, evidenceItemId: proof.evidenceItemId },
      202,
    );
  });

  app.post('/ingestion/replay', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'queue YC ingestion replay');
    if (roleDenied) return roleDenied;
    if (!deps.orchestrator.boss) return c.json({ error: 'Background jobs unavailable' }, 503);

    const raw = await c.req.json().catch(() => ({}));
    const parsed = YcReplayIngestionInput.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    let replayPath = parsed.data.replayPath;
    if (!replayPath && parsed.data.ingestionRecordId) {
      const record = await yc.getIngestionRecord(parsed.data.ingestionRecordId);
      replayPath = record?.rawStoragePath ?? undefined;
    }
    if (!replayPath) return c.json({ error: 'Replay source not found' }, 404);

    const queue = parsed.data.source === 'companies' ? 'pipeline.yc-scrape' : 'pipeline.startup-school';
    const replayRef = `yc-ingestion:${workspaceId}:replay:${randomUUID()}`;
    const proof = await persistYcIngestionProof(deps.db, {
      workspaceId,
      actorUserId: c.get('userId'),
      action: 'YC_INGESTION_REPLAY_REQUESTED',
      evidenceType: 'yc_ingestion_replay_requested',
      title: 'YC ingestion replay requested',
      summary: `YC ingestion replay queued for ${parsed.data.source}.`,
      replayRef,
      metadata: {
        source: parsed.data.source,
        queue,
        ingestionRecordId: parsed.data.ingestionRecordId ?? null,
        replayPathPresent: true,
        evidenceContract: 'yc_ingestion_replay_request_evidence_required',
      },
    }).catch(() => null);
    if (!proof) return c.json({ error: 'Failed to persist YC replay evidence' }, 500);

    const jobId = await deps.orchestrator.boss.send(queue, {
      workspaceId,
      replayPath,
      auditEventId: proof.auditEventId,
      evidenceItemId: proof.evidenceItemId,
      replayRef,
    });
    await deps.db
      .update(auditLog)
      .set({
        metadata: {
          evidenceType: 'yc_ingestion_replay_requested',
          replayRef,
          queued: true,
          jobId: jobId ?? null,
          evidenceItemId: proof.evidenceItemId,
          source: parsed.data.source,
          queue,
          ingestionRecordId: parsed.data.ingestionRecordId ?? null,
          replayPathPresent: true,
          evidenceContract: 'yc_ingestion_replay_request_evidence_required',
        },
      })
      .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, proof.auditEventId)));

    return c.json(
      { queued: true, queue, jobId, replayPath, evidenceItemId: proof.evidenceItemId },
      202,
    );
  });

  return app;
}
