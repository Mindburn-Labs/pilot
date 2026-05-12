import { Hono } from 'hono';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { appendEvidenceItem, appendTenantDeletionReceipt } from '@pilot/db';
import {
  auditLog,
  opportunities,
  policyViolations,
  workspaces,
  workspaceMembers,
  workspaceDeletions,
  workspaceSettings,
  users,
} from '@pilot/db/schema';
import { type GatewayDeps } from '../index.js';

/**
 * Platform-admin surface.
 *
 * All endpoints here are explicitly PLATFORM-SCOPED — they operate across
 * tenants and so are exempt from the workspace-scoping lint (see
 * scripts/lint-tenancy.ts). Access control:
 *   - PILOT_ADMIN_API_KEY is required as `Authorization: Bearer <key>`.
 *   - If unset, every admin route returns 503. Production must configure it.
 *
 * The queries here deliberately span workspaces; this is the only route
 * file where that is allowed.
 */
export function adminRoutes(deps: GatewayDeps) {
  const app = new Hono();

  const adminKey = process.env['PILOT_ADMIN_API_KEY'];

  // Gate every admin route. We want a hard 503 when the key isn't set —
  // this is a "you haven't configured it" signal rather than a 401 which
  // would hide the feature.
  app.use('*', async (c, next) => {
    if (!adminKey)
      return c.json({ error: 'admin surface disabled — set PILOT_ADMIN_API_KEY' }, 503);
    const auth = c.req.header('Authorization');
    if (auth !== `Bearer ${adminKey}`) return c.json({ error: 'forbidden' }, 403);
    await next();
  });

  // POST /api/admin/tenants
  //
  // Platform-issued workspace creation. Body:
  //   { name: string, ownerUserId: uuid }
  // Creates the workspace + owner membership row. Does NOT seed operator
  // roles / sample opportunities — those are bootstrapped in the onboarding
  // flow on first founder login, not here (keeps this endpoint surgical).
  app.post('/tenants', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      name?: string;
      ownerUserId?: string;
    } | null;
    if (!body || typeof body.name !== 'string' || body.name.trim().length === 0) {
      return c.json({ error: 'name (string, non-empty) is required' }, 400);
    }
    if (typeof body.ownerUserId !== 'string') {
      return c.json({ error: 'ownerUserId (uuid) is required' }, 400);
    }
    const workspaceName = body.name.trim();
    const ownerUserId = body.ownerUserId;

    // Confirm the owner user exists — fail fast rather than create an
    // orphan workspace whose FK will break on the membership insert.
    // lint-tenancy: ok — platform-admin cross-tenant read by design.
    const [owner] = await deps.db.select().from(users).where(eq(users.id, ownerUserId)).limit(1);
    if (!owner) return c.json({ error: 'ownerUserId does not match any user' }, 404);

    const created = await deps.db
      .transaction(async (tx) => {
        const [workspace] = await tx
          .insert(workspaces)
          .values({ name: workspaceName, ownerId: ownerUserId })
          .returning();
        if (!workspace) throw new Error('failed to create workspace');

        await tx
          .insert(workspaceMembers)
          .values({ workspaceId: workspace.id, userId: ownerUserId, role: 'owner' });

        await tx.insert(workspaceSettings).values({ workspaceId: workspace.id });

        const auditEventId = randomUUID();
        const replayRef = `admin-tenant:${workspace.id}:created`;
        const evidenceMetadata = {
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          ownerUserId,
          adminCredentialStoredInEvidence: false,
        };

        await tx.insert(auditLog).values({
          id: auditEventId,
          workspaceId: workspace.id,
          action: 'ADMIN_TENANT_CREATED',
          actor: 'platform-admin',
          target: workspace.id,
          verdict: 'allow',
          metadata: {
            evidenceType: 'admin_tenant_created',
            replayRef,
            ...evidenceMetadata,
          },
        });

        const evidenceItemId = await appendEvidenceItem(tx, {
          workspaceId: workspace.id,
          auditEventId,
          evidenceType: 'admin_tenant_created',
          sourceType: 'gateway_admin',
          title: `Admin tenant created: ${workspace.name}`,
          summary: 'Platform admin created a workspace, owner membership, and default settings.',
          redactionState: 'redacted',
          sensitivity: 'restricted',
          replayRef,
          metadata: evidenceMetadata,
        });

        await tx
          .update(auditLog)
          .set({
            metadata: {
              evidenceType: 'admin_tenant_created',
              replayRef,
              evidenceItemId,
              ...evidenceMetadata,
            },
          })
          .where(and(eq(auditLog.workspaceId, workspace.id), eq(auditLog.id, auditEventId)));

        return { workspace, evidenceItemId };
      })
      .catch(() => null);

    if (!created) return c.json({ error: 'failed to persist tenant creation evidence' }, 500);

    return c.json(created, 201);
  });

  // DELETE /api/admin/tenants/:id
  //
  // Soft-delete with a 30-day recovery window. Body is optional and can
  // supply `{ reason: string, graceDays: number }` (default graceDays=30).
  // Issuing a second DELETE extends the grace window rather than hard-
  // deleting — the hard delete only happens via the `tenant:hard-delete`
  // pg-boss cron once `hard_delete_after` passes.
  app.delete('/tenants/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      reason?: string;
      graceDays?: number;
    };
    const graceDays = Math.max(0, Math.min(365, Number(body.graceDays ?? 30)));
    const hardDeleteAfter = new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000);

    // Confirm the workspace exists (platform-admin can read any).
    // lint-tenancy: ok — cross-tenant read is the entire point of admin.ts.
    const [workspace] = await deps.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .limit(1);
    if (!workspace) return c.json({ error: 'workspace not found' }, 404);

    const softDeleted = await deps.db
      .transaction(async (tx) => {
        // Upsert: a second DELETE extends the window.
        const [existing] = await tx
          .select()
          .from(workspaceDeletions)
          .where(eq(workspaceDeletions.workspaceId, id))
          .limit(1);

        const reason = body.reason ?? existing?.reason ?? null;
        if (existing) {
          await tx
            .update(workspaceDeletions)
            .set({ hardDeleteAfter, reason })
            .where(eq(workspaceDeletions.workspaceId, id));
        } else {
          await tx.insert(workspaceDeletions).values({
            workspaceId: id,
            reason,
            hardDeleteAfter,
          });
        }

        const auditEventId = randomUUID();
        const replayRef = `admin-tenant:${id}:soft-delete`;
        const evidenceMetadata = {
          workspaceId: id,
          workspaceName: workspace.name,
          hardDeleteAfter: hardDeleteAfter.toISOString(),
          reason,
          existingSoftDelete: Boolean(existing),
          adminCredentialStoredInEvidence: false,
        };

        await tx.insert(auditLog).values({
          id: auditEventId,
          workspaceId: id,
          action: 'ADMIN_TENANT_SOFT_DELETED',
          actor: 'platform-admin',
          target: id,
          verdict: 'allow',
          metadata: {
            evidenceType: 'admin_tenant_soft_deleted',
            replayRef,
            ...evidenceMetadata,
          },
        });

        const evidenceItemId = await appendEvidenceItem(tx, {
          workspaceId: id,
          auditEventId,
          evidenceType: 'admin_tenant_soft_deleted',
          sourceType: 'gateway_admin',
          title: `Admin tenant soft-delete marked: ${workspace.name}`,
          summary: 'Platform admin marked a workspace for delayed hard deletion.',
          redactionState: 'redacted',
          sensitivity: 'restricted',
          replayRef,
          metadata: evidenceMetadata,
        });

        await tx
          .update(auditLog)
          .set({
            metadata: {
              evidenceType: 'admin_tenant_soft_deleted',
              replayRef,
              evidenceItemId,
              ...evidenceMetadata,
            },
          })
          .where(and(eq(auditLog.workspaceId, id), eq(auditLog.id, auditEventId)));

        return { evidenceItemId };
      })
      .catch(() => null);

    if (!softDeleted) {
      return c.json({ error: 'failed to persist tenant soft-delete evidence' }, 500);
    }

    return c.json({
      softDeleted: true,
      workspaceId: id,
      hardDeleteAfter: hardDeleteAfter.toISOString(),
      evidenceItemId: softDeleted.evidenceItemId,
    });
  });

  // POST /api/admin/tenants/:id/restore
  //
  // Undoes a soft-delete. 404 if the workspace wasn't soft-deleted. Once
  // the cleanup cron has hard-deleted, the workspace row is gone and this
  // endpoint returns 404 (restore from backup instead).
  app.post('/tenants/:id/restore', async (c) => {
    const id = c.req.param('id');
    const restored = await deps.db
      .transaction(async (tx) => {
        const result = await tx
          .delete(workspaceDeletions)
          .where(eq(workspaceDeletions.workspaceId, id))
          .returning();
        if (result.length === 0) return null;

        const auditEventId = randomUUID();
        const replayRef = `admin-tenant:${id}:restore`;
        const evidenceMetadata = {
          workspaceId: id,
          restoredDeletionIds: result.map((row) => row.id),
          adminCredentialStoredInEvidence: false,
        };

        await tx.insert(auditLog).values({
          id: auditEventId,
          workspaceId: id,
          action: 'ADMIN_TENANT_RESTORED',
          actor: 'platform-admin',
          target: id,
          verdict: 'allow',
          metadata: {
            evidenceType: 'admin_tenant_restored',
            replayRef,
            ...evidenceMetadata,
          },
        });

        const evidenceItemId = await appendEvidenceItem(tx, {
          workspaceId: id,
          auditEventId,
          evidenceType: 'admin_tenant_restored',
          sourceType: 'gateway_admin',
          title: `Admin tenant restored: ${id}`,
          summary: 'Platform admin removed a pending tenant soft-delete marker.',
          redactionState: 'redacted',
          sensitivity: 'restricted',
          replayRef,
          metadata: evidenceMetadata,
        });

        await tx
          .update(auditLog)
          .set({
            metadata: {
              evidenceType: 'admin_tenant_restored',
              replayRef,
              evidenceItemId,
              ...evidenceMetadata,
            },
          })
          .where(and(eq(auditLog.workspaceId, id), eq(auditLog.id, auditEventId)));

        return { restored: true, workspaceId: id, evidenceItemId };
      })
      .catch(() => undefined);
    if (restored === undefined) {
      return c.json({ error: 'failed to persist tenant restore evidence' }, 500);
    }
    if (restored === null) return c.json({ error: 'workspace is not soft-deleted' }, 404);
    return c.json(restored);
  });

  // GET /api/admin/tenants/deletions
  //
  // Lists pending soft-deletes so operators can see what's about to be
  // hard-deleted and intervene if needed. Filters out rows already hard-
  // deleted.
  app.get('/tenants/deletions', async (c) => {
    const rows = await deps.db
      .select()
      .from(workspaceDeletions)
      .where(isNull(workspaceDeletions.hardDeletedAt));
    return c.json({ deletions: rows });
  });

  // POST /api/admin/tenants/cleanup
  //
  // Manually trigger the hard-delete sweep. Used by the scheduled pg-boss
  // job (which calls the same helper) and by operators running an incident
  // drill. Processes at most `limit` rows per call (default 50) so one
  // runaway sweep can't spike the DB.
  app.post('/tenants/cleanup', async (c) => {
    const limit = Math.max(1, Math.min(500, Number(c.req.query('limit') ?? '50')));
    const hardDeletedAt = new Date();
    const toHardDelete = await deps.db
      .select()
      .from(workspaceDeletions)
      .where(
        and(
          isNull(workspaceDeletions.hardDeletedAt),
          lt(workspaceDeletions.hardDeleteAfter, new Date()),
        ),
      )
      .limit(limit);

    const receiptIds: string[] = [];
    try {
      for (const row of toHardDelete) {
        receiptIds.push(
          await appendTenantDeletionReceipt(deps.db, {
            workspaceId: row.workspaceId,
            deletionId: row.id,
            source: 'gateway_admin',
            actor: 'platform-admin',
            reason: row.reason,
            softDeletedAt: row.softDeletedAt,
            hardDeleteAfter: row.hardDeleteAfter,
            hardDeletedAt,
            replayRef: `tenant-hard-delete:${row.workspaceId}:${row.id}:gateway-admin`,
            metadata: {
              trigger: 'manual_admin_cleanup',
              limit,
              retainedAfterWorkspaceDelete: true,
              workspaceScopedLedgerRowsDeleted: true,
            },
          }),
        );
      }
    } catch {
      return c.json({ error: 'failed to persist tenant hard-delete receipt' }, 500);
    }

    let hardDeleted = 0;
    for (const row of toHardDelete) {
      await hardDeleteWorkspaceRows(deps.db, row.workspaceId);
      hardDeleted++;
    }

    return c.json({
      hardDeleted,
      remaining: Math.max(0, toHardDelete.length - hardDeleted),
      receiptIds,
    });
  });

  return app;
}

async function hardDeleteWorkspaceRows(db: GatewayDeps['db'], workspaceId: string): Promise<void> {
  // These workspace-scoped tables intentionally do not cascade in the
  // original schema. A retained tenant_deletion_receipts row is persisted
  // before this point so the hard-delete proof survives the tenant teardown.
  // lint-tenancy: ok — platform-admin hard-delete after retained receipt.
  await db.delete(auditLog).where(eq(auditLog.workspaceId, workspaceId));
  // lint-tenancy: ok — platform-admin hard-delete after retained receipt.
  await db.delete(policyViolations).where(eq(policyViolations.workspaceId, workspaceId));
  // lint-tenancy: ok — platform-admin hard-delete after retained receipt.
  await db.delete(opportunities).where(eq(opportunities.workspaceId, workspaceId));
  // Cascade: workspace_id is FK'd with onDelete: cascade across most
  // workspace-scoped tables, so this tears down the rest of the tenant.
  // lint-tenancy: ok — platform-admin hard-delete, the ONLY caller allowed
  //   to cross-tenant-delete.
  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
}
