import { randomUUID } from 'node:crypto';
import { type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { appendEvidenceItem } from '@pilot/db';
import { type Db } from '@pilot/db/client';
import { auditLog, operators, workspaceMembers } from '@pilot/db/schema';
import { WorkspaceRoleSchema, type WorkspaceRole } from '@pilot/shared/schemas';

const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> = {
  member: 1,
  partner: 2,
  owner: 3,
};

export function getWorkspaceId(c: Context): string | undefined {
  return (c.get('workspaceId') as string | undefined) ?? undefined;
}

export function requireWorkspaceId(c: Context): string {
  const workspaceId = getWorkspaceId(c);
  if (!workspaceId) {
    throw new Error('workspaceId required');
  }
  return workspaceId;
}

export function getWorkspaceRole(c: Context): WorkspaceRole | undefined {
  const parsed = WorkspaceRoleSchema.safeParse(c.get('workspaceRole'));
  return parsed.success ? parsed.data : undefined;
}

export function requireWorkspaceRole(
  c: Context,
  minimumRole: WorkspaceRole,
  action = 'perform this action',
): Response | null {
  const workspaceId = getWorkspaceId(c);
  if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);

  const role = getWorkspaceRole(c);
  if (!role || WORKSPACE_ROLE_RANK[role] < WORKSPACE_ROLE_RANK[minimumRole]) {
    return c.json(
      {
        error: 'insufficient workspace role',
        action,
        requiredRole: minimumRole,
        currentRole: role ?? null,
      },
      403,
    );
  }

  return null;
}

export function workspaceIdMismatch(c: Context, candidate: unknown): boolean {
  const workspaceId = getWorkspaceId(c);
  return typeof candidate === 'string' && !!workspaceId && candidate !== workspaceId;
}

export async function workspaceOperatorBelongsToWorkspace(
  db: Db,
  workspaceId: string,
  operatorId?: string | null,
): Promise<boolean> {
  if (!operatorId) return true;
  const [operator] = await db
    .select({ id: operators.id })
    .from(operators)
    .where(and(eq(operators.id, operatorId), eq(operators.workspaceId, workspaceId)))
    .limit(1);
  return Boolean(operator);
}

export async function requireWorkspaceOperator(
  db: Db,
  c: Context,
  workspaceId: string,
  operatorId?: string | null,
): Promise<Response | null> {
  if (await workspaceOperatorBelongsToWorkspace(db, workspaceId, operatorId)) return null;
  const proof = await persistWorkspaceOperatorScopeRejection(db, {
    workspaceId,
    requestedOperatorId: operatorId ?? 'unknown',
    actor: `user:${(c.get('userId') as string | undefined) ?? 'unknown'}`,
    sourceType: 'gateway_operator_scope',
    surface: `gateway:${c.req.path}`,
    target: operatorId ?? null,
  });
  if (!proof) {
    return c.json({ error: 'operator scope rejection evidence persistence failed' }, 500);
  }
  return c.json(
    {
      error: 'operatorId does not belong to authenticated workspace',
      evidenceItemId: proof.evidenceItemId,
    },
    403,
  );
}

export async function workspaceUserBelongsToWorkspace(
  db: Db,
  workspaceId: string,
  userId?: string | null,
): Promise<boolean> {
  if (!userId) return true;
  const [member] = await db
    .select({ id: workspaceMembers.id })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), eq(workspaceMembers.workspaceId, workspaceId)))
    .limit(1);
  return Boolean(member);
}

type OperatorScopeRejectionProofInput = {
  workspaceId: string;
  requestedOperatorId: string;
  actor: string;
  sourceType: 'gateway_operator_scope' | 'orchestrator_operator_scope';
  surface: string;
  target?: string | null;
};

export async function persistWorkspaceOperatorScopeRejection(
  db: Db,
  input: OperatorScopeRejectionProofInput,
): Promise<{ auditEventId: string; evidenceItemId: string } | null> {
  return db
    .transaction(async (tx) => {
      const auditEventId = randomUUID();
      const replayRef = `operator-scope:${input.workspaceId}:${input.sourceType}:${auditEventId}`;
      const metadata = {
        requestedOperatorId: input.requestedOperatorId,
        surface: input.surface,
        reason: 'operatorId_not_in_workspace',
        evidenceContract: 'operator_scope_denial_evidence_required',
        credentialBoundary: 'no_raw_credentials_or_session_payloads_in_evidence',
        replayRef,
      };

      await tx.insert(auditLog).values({
        id: auditEventId,
        workspaceId: input.workspaceId,
        action: 'WORKSPACE_OPERATOR_SCOPE_REJECTED',
        actor: input.actor,
        target: input.target ?? input.requestedOperatorId,
        verdict: 'deny',
        reason: 'operatorId does not belong to authenticated workspace',
        metadata,
      });

      const evidenceItemId = await appendEvidenceItem(tx, {
        workspaceId: input.workspaceId,
        auditEventId,
        evidenceType: 'workspace_operator_scope_rejected',
        sourceType: input.sourceType,
        title: 'Workspace operator scope rejected',
        summary:
          'Pilot rejected a requested operatorId before execution because it is not owned by the authenticated workspace.',
        redactionState: 'redacted',
        sensitivity: 'internal',
        replayRef,
        metadata,
      });

      await tx
        .update(auditLog)
        .set({ metadata: { ...metadata, evidenceItemId } })
        .where(and(eq(auditLog.workspaceId, input.workspaceId), eq(auditLog.id, auditEventId)));

      return { auditEventId, evidenceItemId };
    })
    .catch(() => null);
}
