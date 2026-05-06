import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { appendEvidenceItem } from '@pilot/db';
import { auditLog, milestones, plans } from '@pilot/db/schema';
import { ProductFactory } from '@pilot/product-factory';
import { type GatewayDeps } from '../index.js';
import { getWorkspaceId, requireWorkspaceRole } from '../lib/workspace.js';

export function productRoutes(deps: GatewayDeps) {
  const factory = new ProductFactory(deps.db);
  const app = new Hono();

  // GET /api/product/plans?workspaceId=...
  app.get('/plans', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const plans = await factory.listPlans(workspaceId);
    return c.json(plans);
  });

  // GET /api/product/plans/:id
  app.get('/plans/:id', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const plan = await factory.getPlan(c.req.param('id'), workspaceId);
    if (!plan) return c.json({ error: 'Not found' }, 404);
    return c.json(plan);
  });

  // POST /api/product/plans
  app.post('/plans', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'create product plans');
    if (roleDenied) return roleDenied;
    const body = (await c.req.json().catch(() => null)) as {
      title?: unknown;
      description?: unknown;
    } | null;
    if (!body || typeof body.title !== 'string' || body.title.trim().length === 0) {
      return c.json({ error: 'title (string, non-empty) is required' }, 400);
    }
    const title = body.title.trim();
    const description = typeof body.description === 'string' ? body.description : undefined;

    const created = await deps.db
      .transaction(async (tx) => {
        const [plan] = await tx
          .insert(plans)
          .values({ workspaceId, title, description })
          .returning();
        if (!plan) throw new Error('failed to create product plan');

        const auditEventId = randomUUID();
        const replayRef = `product-plan:${workspaceId}:${plan.id}:created`;
        const evidenceMetadata = {
          planId: plan.id,
          title,
          descriptionPresent: Boolean(description),
        };

        await tx.insert(auditLog).values({
          id: auditEventId,
          workspaceId,
          action: 'PRODUCT_PLAN_CREATED',
          actor: `user:${(c.get('userId') as string | undefined) ?? 'unknown'}`,
          target: plan.id,
          verdict: 'allow',
          metadata: {
            evidenceType: 'product_plan_created',
            replayRef,
            ...evidenceMetadata,
          },
        });

        const evidenceItemId = await appendEvidenceItem(tx, {
          workspaceId,
          auditEventId,
          evidenceType: 'product_plan_created',
          sourceType: 'gateway_product',
          title: `Product plan created: ${title}`,
          summary: description ?? 'Workspace product plan was created.',
          redactionState: 'none',
          sensitivity: 'internal',
          replayRef,
          metadata: evidenceMetadata,
        });

        await tx
          .update(auditLog)
          .set({
            metadata: {
              evidenceType: 'product_plan_created',
              replayRef,
              evidenceItemId,
              ...evidenceMetadata,
            },
          })
          .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

        return { plan, evidenceItemId };
      })
      .catch(() => null);

    if (!created) return c.json({ error: 'failed to persist product plan evidence' }, 500);
    return c.json({ ...created.plan, evidenceItemId: created.evidenceItemId }, 201);
  });

  // POST /api/product/plans/:id/milestones
  app.post('/plans/:id/milestones', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'create product milestones');
    if (roleDenied) return roleDenied;
    const planId = c.req.param('id');
    const [plan] = await deps.db
      .select()
      .from(plans)
      .where(and(eq(plans.id, planId), eq(plans.workspaceId, workspaceId)))
      .limit(1);
    if (!plan) return c.json({ error: 'Not found' }, 404);
    const body = (await c.req.json().catch(() => null)) as {
      title?: unknown;
      description?: unknown;
    } | null;
    if (!body || typeof body.title !== 'string' || body.title.trim().length === 0) {
      return c.json({ error: 'title (string, non-empty) is required' }, 400);
    }
    const title = body.title.trim();
    const description = typeof body.description === 'string' ? body.description : undefined;

    const created = await deps.db
      .transaction(async (tx) => {
        const existingMilestones = await tx
          .select({ id: milestones.id })
          .from(milestones)
          .where(eq(milestones.planId, planId));

        const sortOrder = existingMilestones.length;
        const [milestone] = await tx
          .insert(milestones)
          .values({ planId, title, description, sortOrder })
          .returning();
        if (!milestone) throw new Error('failed to create product milestone');

        const auditEventId = randomUUID();
        const replayRef = `product-plan:${workspaceId}:${planId}:milestone:${milestone.id}:created`;
        const evidenceMetadata = {
          planId,
          milestoneId: milestone.id,
          title,
          descriptionPresent: Boolean(description),
          sortOrder,
          evidenceContract: 'product_milestone_create_evidence_required',
        };

        await tx.insert(auditLog).values({
          id: auditEventId,
          workspaceId,
          action: 'PRODUCT_MILESTONE_CREATED',
          actor: `user:${(c.get('userId') as string | undefined) ?? 'unknown'}`,
          target: milestone.id,
          verdict: 'allow',
          metadata: {
            evidenceType: 'product_milestone_created',
            replayRef,
            ...evidenceMetadata,
          },
        });

        const evidenceItemId = await appendEvidenceItem(tx, {
          workspaceId,
          auditEventId,
          evidenceType: 'product_milestone_created',
          sourceType: 'gateway_product',
          title: `Product milestone created: ${title}`,
          summary: 'Workspace product milestone was created.',
          redactionState: 'none',
          sensitivity: 'internal',
          replayRef,
          metadata: evidenceMetadata,
        });

        await tx
          .update(auditLog)
          .set({
            metadata: {
              evidenceType: 'product_milestone_created',
              replayRef,
              evidenceItemId,
              ...evidenceMetadata,
            },
          })
          .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

        return { milestone, evidenceItemId };
      })
      .catch(() => null);

    if (!created) return c.json({ error: 'failed to persist product milestone evidence' }, 500);
    return c.json({ ...created.milestone, evidenceItemId: created.evidenceItemId }, 201);
  });

  // GET /api/product/summary?workspaceId=...
  app.get('/summary', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const summary = await factory.getWorkspaceSummary(workspaceId);
    return c.json(summary);
  });

  return app;
}
