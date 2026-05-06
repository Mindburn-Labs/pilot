import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { appendEvidenceItem } from '@pilot/db';
import {
  auditLog,
  opportunities,
  opportunityClusters,
  opportunityClusterMembers,
  opportunityScores,
  opportunityTags,
} from '@pilot/db/schema';
import { CreateOpportunityInput } from '@pilot/shared/schemas';
import { getCapabilityRecord } from '@pilot/shared/capabilities';
import { type GatewayDeps } from '../index.js';
import { getWorkspaceId, requireWorkspaceRole, workspaceIdMismatch } from '../lib/workspace.js';

export function opportunityRoutes(deps: GatewayDeps) {
  const app = new Hono();

  app.get('/', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);

    const limit = Number(c.req.query('limit') ?? '50');
    const rows = await deps.db
      .select()
      .from(opportunities)
      .where(eq(opportunities.workspaceId, workspaceId))
      .orderBy(desc(opportunities.discoveredAt))
      .limit(Math.min(limit, 100));

    return c.json(rows);
  });

  app.get('/:id', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const { id } = c.req.param();

    const [opp] = await deps.db
      .select()
      .from(opportunities)
      .where(and(eq(opportunities.id, id), eq(opportunities.workspaceId, workspaceId)))
      .limit(1);

    if (!opp) {
      return c.json({ error: 'Not found' }, 404);
    }

    const scores = await deps.db
      .select()
      .from(opportunityScores)
      .where(eq(opportunityScores.opportunityId, id));

    const tags = await deps.db
      .select()
      .from(opportunityTags)
      .where(eq(opportunityTags.opportunityId, id));

    return c.json({ ...opp, scores, tags });
  });

  app.post('/', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'create opportunities');
    if (roleDenied) return roleDenied;
    const raw = await c.req.json();
    if (workspaceIdMismatch(c, raw.workspaceId)) {
      return c.json({ error: 'workspaceId does not match authenticated workspace' }, 403);
    }
    const parsed = CreateOpportunityInput.safeParse({
      ...raw,
      workspaceId,
    });

    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const body = parsed.data;
    const created = await deps.db
      .transaction(async (tx) => {
        const [opp] = await tx
          .insert(opportunities)
          .values({
            source: body.source,
            sourceUrl: body.sourceUrl,
            title: body.title,
            description: body.description,
            workspaceId: body.workspaceId,
            status: 'discovered',
          })
          .returning();

        if (!opp) throw new Error('failed to create opportunity');

        const auditEventId = randomUUID();
        const replayRef = `opportunity:${workspaceId}:${opp.id}:created`;
        const auditMetadata = {
          opportunityId: opp.id,
          source: body.source,
          sourceUrlPresent: Boolean(body.sourceUrl),
          title: body.title,
          descriptionLength: body.description.length,
          status: 'discovered',
          evidenceContract: 'opportunity_create_evidence_required',
        };

        await tx.insert(auditLog).values({
          id: auditEventId,
          workspaceId,
          action: 'OPPORTUNITY_CREATED',
          actor: `user:${c.get('userId') ?? 'unknown'}`,
          target: opp.id,
          verdict: 'allow',
          metadata: {
            evidenceType: 'opportunity_created',
            replayRef,
            ...auditMetadata,
          },
        });

        const evidenceItemId = await appendEvidenceItem(tx, {
          workspaceId,
          auditEventId,
          evidenceType: 'opportunity_created',
          sourceType: 'gateway_opportunity_route',
          title: `Opportunity created: ${body.title}`,
          summary:
            'Workspace opportunity record was created; description is not stored in evidence metadata.',
          redactionState: 'redacted',
          sensitivity: 'internal',
          replayRef,
          metadata: auditMetadata,
        });

        await tx
          .update(auditLog)
          .set({
            metadata: {
              evidenceType: 'opportunity_created',
              replayRef,
              evidenceItemId,
              ...auditMetadata,
            },
          })
          .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

        return { opp, evidenceItemId };
      })
      .catch(() => null);

    if (!created) return c.json({ error: 'Failed to persist opportunity evidence' }, 500);
    return c.json({ ...created.opp, evidenceItemId: created.evidenceItemId }, 201);
  });

  // ─── Batch score — enqueue scoring for all unscored opportunities ───
  app.post('/batch-score', async (c) => {
    const capability = getCapabilityRecord('opportunity_scoring');
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'queue opportunity batch scoring');
    if (roleDenied) return roleDenied;
    const boss = deps.orchestrator.boss;
    if (!boss) {
      return c.json({ error: 'Background job system unavailable', capability }, 503);
    }

    const unscored = await deps.db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(
        and(eq(opportunities.workspaceId, workspaceId), eq(opportunities.status, 'discovered')),
      );

    const auditEventId = randomUUID();
    const opportunityIds = unscored.map(({ id }) => id);
    const replayRef = `opportunity:${workspaceId}:batch-score:${auditEventId}`;
    const auditMetadata = {
      opportunityCount: opportunityIds.length,
      opportunityIdsPreview: opportunityIds.slice(0, 50),
      capabilityKey: capability?.key ?? 'opportunity_scoring',
      capabilityState: capability?.state ?? 'blocked',
      evidenceContract: 'opportunity_batch_score_request_evidence_required',
    };

    const evidenceItemId = await deps.db
      .transaction(async (tx) => {
        await tx.insert(auditLog).values({
          id: auditEventId,
          workspaceId,
          action: 'OPPORTUNITY_BATCH_SCORE_REQUESTED',
          actor: `user:${c.get('userId') ?? 'unknown'}`,
          target: workspaceId,
          verdict: 'allow',
          metadata: {
            evidenceType: 'opportunity_batch_score_requested',
            replayRef,
            queued: false,
            ...auditMetadata,
          },
        });

        const createdEvidenceItemId = await appendEvidenceItem(tx, {
          workspaceId,
          auditEventId,
          evidenceType: 'opportunity_batch_score_requested',
          sourceType: 'gateway_opportunity_route',
          title: 'Opportunity batch scoring requested',
          summary: `Batch scoring requested for ${opportunityIds.length} discovered opportunities.`,
          redactionState: 'redacted',
          sensitivity: 'internal',
          replayRef,
          metadata: auditMetadata,
        });

        await tx
          .update(auditLog)
          .set({
            metadata: {
              evidenceType: 'opportunity_batch_score_requested',
              replayRef,
              queued: false,
              evidenceItemId: createdEvidenceItemId,
              ...auditMetadata,
            },
          })
          .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

        return createdEvidenceItemId;
      })
      .catch(() => null);

    if (!evidenceItemId) {
      return c.json({ error: 'Failed to persist opportunity batch scoring evidence' }, 500);
    }

    let enqueued = 0;
    const jobIds: unknown[] = [];
    for (const { id } of unscored) {
      const jobId = await boss.send('opportunity.score', {
        opportunityId: id,
        auditEventId,
        evidenceItemId,
        replayRef,
      });
      jobIds.push(jobId ?? null);
      enqueued++;
    }

    await deps.db
      .update(auditLog)
      .set({
        metadata: {
          evidenceType: 'opportunity_batch_score_requested',
          replayRef,
          queued: true,
          enqueued,
          jobIds,
          evidenceItemId,
          ...auditMetadata,
        },
      })
      .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

    return c.json({ enqueued, total: unscored.length, jobIds, evidenceItemId, capability }, 202);
  });

  // ─── Trigger cluster rebuild for the workspace ───
  app.post('/cluster', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'queue opportunity cluster rebuild');
    if (roleDenied) return roleDenied;
    const boss = deps.orchestrator.boss;
    if (!boss) return c.json({ error: 'Background job system unavailable' }, 503);

    const auditEventId = randomUUID();
    const replayRef = `opportunity:${workspaceId}:cluster:${auditEventId}`;
    const auditMetadata = {
      workspaceId,
      queue: 'pipeline.cluster',
      evidenceContract: 'opportunity_cluster_request_evidence_required',
    };

    const evidenceItemId = await deps.db
      .transaction(async (tx) => {
        await tx.insert(auditLog).values({
          id: auditEventId,
          workspaceId,
          action: 'OPPORTUNITY_CLUSTER_REBUILD_REQUESTED',
          actor: `user:${c.get('userId') ?? 'unknown'}`,
          target: workspaceId,
          verdict: 'allow',
          metadata: {
            evidenceType: 'opportunity_cluster_rebuild_requested',
            replayRef,
            queued: false,
            ...auditMetadata,
          },
        });

        const createdEvidenceItemId = await appendEvidenceItem(tx, {
          workspaceId,
          auditEventId,
          evidenceType: 'opportunity_cluster_rebuild_requested',
          sourceType: 'gateway_opportunity_route',
          title: 'Opportunity cluster rebuild requested',
          summary: 'Workspace opportunity cluster rebuild was requested through the gateway API.',
          redactionState: 'redacted',
          sensitivity: 'internal',
          replayRef,
          metadata: auditMetadata,
        });

        await tx
          .update(auditLog)
          .set({
            metadata: {
              evidenceType: 'opportunity_cluster_rebuild_requested',
              replayRef,
              queued: false,
              evidenceItemId: createdEvidenceItemId,
              ...auditMetadata,
            },
          })
          .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

        return createdEvidenceItemId;
      })
      .catch(() => null);

    if (!evidenceItemId) {
      return c.json({ error: 'Failed to persist opportunity cluster evidence' }, 500);
    }

    const jobId = await boss.send('pipeline.cluster', {
      workspaceId,
      auditEventId,
      evidenceItemId,
      replayRef,
    });
    await deps.db
      .update(auditLog)
      .set({
        metadata: {
          evidenceType: 'opportunity_cluster_rebuild_requested',
          replayRef,
          queued: true,
          jobId: jobId ?? null,
          evidenceItemId,
          ...auditMetadata,
        },
      })
      .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

    return c.json({ queued: true, jobId, evidenceItemId }, 202);
  });

  // ─── List clusters for the workspace ───
  app.get('/clusters', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);

    const clusters = await deps.db
      .select()
      .from(opportunityClusters)
      .where(eq(opportunityClusters.workspaceId, workspaceId))
      .orderBy(desc(opportunityClusters.avgScore));

    return c.json(clusters);
  });

  // ─── List cluster members with their opportunities ───
  app.get('/clusters/:clusterId/members', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);

    const { clusterId } = c.req.param();
    const [cluster] = await deps.db
      .select()
      .from(opportunityClusters)
      .where(
        and(
          eq(opportunityClusters.id, clusterId),
          eq(opportunityClusters.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (!cluster) return c.json({ error: 'Cluster not found' }, 404);

    const members = await deps.db
      .select()
      .from(opportunityClusterMembers)
      .where(eq(opportunityClusterMembers.clusterId, clusterId));

    // Hydrate with opportunity data
    const oppIds = members.map((m) => m.opportunityId);
    const opps =
      oppIds.length > 0
        ? await deps.db
            .select()
            .from(opportunities)
            .where(eq(opportunities.workspaceId, workspaceId))
        : [];

    const oppMap = new Map(opps.map((o) => [o.id, o]));

    const hydrated = members.map((m) => ({
      ...m,
      opportunity: oppMap.get(m.opportunityId) ?? null,
    }));

    return c.json({ cluster, members: hydrated });
  });

  app.post('/:id/score', async (c) => {
    const capability = getCapabilityRecord('opportunity_scoring');
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'queue opportunity scoring');
    if (roleDenied) return roleDenied;
    const boss = deps.orchestrator.boss;
    if (!boss) {
      return c.json({ error: 'Background job system unavailable', capability }, 503);
    }

    const { id } = c.req.param();
    const [opp] = await deps.db
      .select()
      .from(opportunities)
      .where(and(eq(opportunities.id, id), eq(opportunities.workspaceId, workspaceId)))
      .limit(1);

    if (!opp) {
      return c.json({ error: 'Opportunity not found' }, 404);
    }

    const auditEventId = randomUUID();
    const replayRef = `opportunity:${workspaceId}:${id}:score-requested`;
    const auditMetadata = {
      opportunityId: id,
      previousStatus: opp.status ?? null,
      requestedStatus: 'scoring',
      capabilityKey: capability?.key ?? 'opportunity_scoring',
      capabilityState: capability?.state ?? 'blocked',
      evidenceContract: 'opportunity_score_request_evidence_required',
    };

    const evidenceItemId = await deps.db
      .transaction(async (tx) => {
        await tx.insert(auditLog).values({
          id: auditEventId,
          workspaceId,
          action: 'OPPORTUNITY_SCORE_REQUESTED',
          actor: `user:${c.get('userId') ?? 'unknown'}`,
          target: id,
          verdict: 'allow',
          metadata: {
            evidenceType: 'opportunity_score_requested',
            replayRef,
            queued: false,
            ...auditMetadata,
          },
        });

        const createdEvidenceItemId = await appendEvidenceItem(tx, {
          workspaceId,
          auditEventId,
          evidenceType: 'opportunity_score_requested',
          sourceType: 'gateway_opportunity_route',
          title: `Opportunity score requested: ${opp.title}`,
          summary: 'Workspace opportunity scoring was requested through the gateway API.',
          redactionState: 'redacted',
          sensitivity: 'internal',
          replayRef,
          metadata: auditMetadata,
        });

        await tx
          .update(auditLog)
          .set({
            metadata: {
              evidenceType: 'opportunity_score_requested',
              replayRef,
              queued: false,
              evidenceItemId: createdEvidenceItemId,
              ...auditMetadata,
            },
          })
          .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

        return createdEvidenceItemId;
      })
      .catch(() => null);

    if (!evidenceItemId) {
      return c.json({ error: 'Failed to persist opportunity scoring evidence' }, 500);
    }

    const jobId = await boss.send('opportunity.score', {
      opportunityId: id,
      auditEventId,
      evidenceItemId,
      replayRef,
    });
    const updated = await deps.db
      .transaction(async (tx) => {
        await tx
          .update(opportunities)
          .set({ status: 'scoring' })
          .where(and(eq(opportunities.id, id), eq(opportunities.workspaceId, workspaceId)));

        await tx
          .update(auditLog)
          .set({
            metadata: {
              evidenceType: 'opportunity_score_requested',
              replayRef,
              queued: true,
              jobId: jobId ?? null,
              status: 'scoring',
              evidenceItemId,
              ...auditMetadata,
            },
          })
          .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

        return true;
      })
      .catch(() => false);

    if (!updated) {
      return c.json({ error: 'Failed to persist opportunity scoring queue state' }, 500);
    }

    return c.json(
      { queued: true, opportunityId: id, status: 'scoring', jobId, evidenceItemId, capability },
      202,
    );
  });

  return app;
}
