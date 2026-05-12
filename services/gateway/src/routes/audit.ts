import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq, desc } from 'drizzle-orm';
import { appendEvidenceItem } from '@pilot/db';
import { auditLog, approvals, policyViolations, tasks } from '@pilot/db/schema';
import { type GatewayDeps } from '../index.js';
import { getWorkspaceId, requireWorkspaceRole } from '../lib/workspace.js';

export function auditRoutes(deps: GatewayDeps) {
  const app = new Hono();

  // GET /api/audit?workspaceId=...&limit=50 — Get audit log entries
  app.get('/', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view audit ledger');
    if (roleDenied) return roleDenied;

    const limit = Math.min(parseInt(c.req.query('limit') ?? '50', 10), 200);

    const entries = await deps.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.workspaceId, workspaceId))
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);

    return c.json(entries);
  });

  // GET /api/audit/approvals?workspaceId=...&status=pending — List approvals
  app.get('/approvals', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view approvals');
    if (roleDenied) return roleDenied;

    const status = c.req.query('status');
    const conditions = [eq(approvals.workspaceId, workspaceId)];
    if (status) conditions.push(eq(approvals.status, status));

    const results = await deps.db
      .select()
      .from(approvals)
      .where(and(...conditions))
      .orderBy(desc(approvals.requestedAt))
      .limit(50);

    return c.json(results);
  });

  // PUT /api/audit/approvals/:id — Resolve an approval (approve/reject)
  app.put('/approvals/:id', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'owner', 'resolve approvals');
    if (roleDenied) return roleDenied;

    const { id } = c.req.param();
    const userId = c.get('userId');
    const body = await c.req.json();
    const { status } = body as { status: 'approved' | 'rejected' };

    if (!['approved', 'rejected'].includes(status)) {
      return c.json({ error: 'status must be approved or rejected' }, 400);
    }

    let approvalResolutionProof:
      | { auditEventId: string; evidenceItemId: string; replayRef: string }
      | undefined;

    const updated = await deps.db
      .transaction(async (tx) => {
        const [row] = await tx
          .update(approvals)
          .set({
            status,
            resolvedBy: userId ?? 'unknown',
            resolvedAt: new Date(),
          })
          .where(and(eq(approvals.id, id), eq(approvals.workspaceId, workspaceId)))
          .returning();

        if (!row) return null;

        const auditEventId = randomUUID();
        const replayRef = `approval:${row.id}:resolved:${status}`;
        const evidenceMetadata = {
          approvalId: row.id,
          approvalStatus: status,
          requestedAction: row.action,
          taskId: row.taskId ?? null,
          resolvedBy: userId ?? 'unknown',
        };

        await tx.insert(auditLog).values({
          id: auditEventId,
          workspaceId,
          action: 'WORKSPACE_APPROVAL_RESOLVED',
          actor: `user:${userId ?? 'unknown'}`,
          target: row.id,
          verdict: 'allow',
          metadata: {
            evidenceType: 'workspace_approval_resolved',
            replayRef,
            ...evidenceMetadata,
          },
        });

        const evidenceItemId = await appendEvidenceItem(tx, {
          workspaceId,
          auditEventId,
          evidenceType: 'workspace_approval_resolved',
          sourceType: 'gateway_approval',
          title: `Approval ${status}: ${row.action}`,
          summary: 'Workspace approval was resolved by an owner.',
          redactionState: 'redacted',
          sensitivity: 'internal',
          replayRef,
          metadata: evidenceMetadata,
        });

        await tx
          .update(auditLog)
          .set({
            metadata: {
              evidenceType: 'workspace_approval_resolved',
              replayRef,
              evidenceItemId,
              ...evidenceMetadata,
            },
          })
          .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

        approvalResolutionProof = { auditEventId, evidenceItemId, replayRef };
        return row;
      })
      .catch(() => undefined);

    if (updated === null) return c.json({ error: 'Approval not found' }, 404);
    if (updated === undefined) return c.json({ error: 'Failed to resolve approval' }, 500);

    // If approved, trigger task resume via pg-boss
    if (status === 'approved' && updated.taskId && deps.orchestrator.boss) {
      const [task] = await deps.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.id, updated.taskId), eq(tasks.workspaceId, workspaceId)))
        .limit(1);

      await deps.orchestrator.boss.send('task.resume', {
        taskId: updated.taskId,
        workspaceId: updated.workspaceId,
        operatorId: task?.operatorId ?? undefined,
        context: task?.description ?? `Resumed after approval of: ${updated.action}`,
        requestAuditEventId: approvalResolutionProof?.auditEventId,
        requestEvidenceItemId: approvalResolutionProof?.evidenceItemId,
        requestReplayRef: approvalResolutionProof?.replayRef,
      });
    }

    if (status === 'approved' && !updated.taskId && deps.managedTelegram) {
      try {
        await deps.managedTelegram.sendApprovedMessage(updated.id);
      } catch {
        return c.json({ error: 'Failed to send approved managed Telegram message' }, 502);
      }
    }

    return c.json(updated);
  });

  // GET /api/audit/violations?workspaceId=... — List policy violations
  app.get('/violations', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view policy violations');
    if (roleDenied) return roleDenied;

    const violations = await deps.db
      .select()
      .from(policyViolations)
      .where(eq(policyViolations.workspaceId, workspaceId))
      .orderBy(desc(policyViolations.createdAt))
      .limit(50);

    return c.json(violations);
  });

  return app;
}
