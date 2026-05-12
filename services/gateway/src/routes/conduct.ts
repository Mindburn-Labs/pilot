import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { appendEvidenceItem } from '@pilot/db';
import { auditLog, tasks } from '@pilot/db/schema';
import { type GatewayDeps } from '../index.js';
import {
  getWorkspaceId,
  requireWorkspaceOperator,
  requireWorkspaceRole,
} from '../lib/workspace.js';

/**
 * Conductor route (Phase 12).
 *
 * POST /api/orchestrator/conduct
 *   Run an agent loop with subagent.spawn / subagent.parallel enabled.
 *   Body: { taskId, context, iterationBudget?, operatorId? }
 *
 * GET  /api/orchestrator/subagents
 *   List available subagent definitions loaded from packs/subagents/*.md.
 */
export function conductRoutes(deps: GatewayDeps) {
  const app = new Hono();

  app.get('/subagents', async (c) => {
    if (!deps.orchestrator.conductor) {
      return c.json({ subagents: [], error: 'no_registry_configured' }, 200);
    }
    const list = deps.orchestrator.conductor.list().map((def) => ({
      name: def.name,
      description: def.description,
      version: def.version,
      operatorRole: def.operatorRole,
      maxRiskClass: def.maxRiskClass,
      execution: def.execution,
      allowedTools: def.toolScope.allowedTools,
      iterationBudget: def.iterationBudget,
    }));
    return c.json({ subagents: list });
  });

  app.post('/conduct', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'run conductor missions');
    if (roleDenied) return roleDenied;

    const body = (await c.req.json().catch(() => ({}))) as {
      taskId?: string;
      operatorId?: string;
      context?: string;
      iterationBudget?: number;
    };

    if (!body.taskId || typeof body.taskId !== 'string') {
      return c.json({ error: 'taskId is required' }, 400);
    }
    if (!body.context || typeof body.context !== 'string') {
      return c.json({ error: 'context is required' }, 400);
    }
    const operatorDenied = await requireWorkspaceOperator(deps.db, c, workspaceId, body.operatorId);
    if (operatorDenied) return operatorDenied;

    // Verify the task belongs to this workspace (tenancy gate).
    const [task] = await deps.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, body.taskId), eq(tasks.workspaceId, workspaceId)))
      .limit(1);
    if (!task) {
      return c.json({ error: 'Task not found in this workspace' }, 404);
    }

    const proof = await persistConductDispatchProof(deps, {
      workspaceId,
      taskId: body.taskId,
      operatorId: body.operatorId ?? null,
      context: body.context,
      iterationBudget: body.iterationBudget ?? null,
      actor: `user:${c.get('userId') ?? 'unknown'}`,
    });
    if (!proof) {
      return c.json({ error: 'Failed to persist conductor dispatch evidence' }, 500);
    }

    try {
      const result = await deps.orchestrator.runConduct({
        taskId: body.taskId,
        workspaceId,
        operatorId: body.operatorId,
        context: body.context,
        iterationBudget: body.iterationBudget,
      });
      return c.json({ ...result, evidenceItemId: proof.evidenceItemId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Conduct run failed';
      return c.json({ error: message }, 500);
    }
  });

  return app;
}

type ConductDispatchProofInput = {
  workspaceId: string;
  taskId: string;
  operatorId: string | null;
  context: string;
  iterationBudget: number | null;
  actor: string;
};

async function persistConductDispatchProof(
  deps: GatewayDeps,
  input: ConductDispatchProofInput,
): Promise<{ auditEventId: string; evidenceItemId: string } | null> {
  const contextHash = hashConductValue(input.context);
  const auditMetadata = {
    taskId: input.taskId,
    workspaceId: input.workspaceId,
    operatorId: input.operatorId,
    iterationBudget: input.iterationBudget,
    contextHash,
    contextLength: input.context.length,
    evidenceContract: 'conduct_dispatch_evidence_required',
  };

  return deps.db
    .transaction(async (tx) => {
      const auditEventId = randomUUID();
      await tx.insert(auditLog).values({
        id: auditEventId,
        workspaceId: input.workspaceId,
        action: 'CONDUCT_RUN_DISPATCHED',
        actor: input.actor,
        target: input.taskId,
        verdict: 'allow',
        metadata: auditMetadata,
      });

      const evidenceItemId = await appendEvidenceItem(tx, {
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        auditEventId,
        evidenceType: 'conduct_run_dispatched',
        sourceType: 'gateway_conduct_route',
        title: 'Conductor run dispatched',
        summary:
          'Gateway conductor dispatch accepted after workspace role, operator, and task tenancy checks.',
        redactionState: 'redacted',
        sensitivity: 'internal',
        replayRef: `conduct:${input.taskId}:dispatch:${auditEventId}`,
        metadata: auditMetadata,
      });

      await tx
        .update(auditLog)
        .set({ metadata: { ...auditMetadata, evidenceItemId } })
        .where(and(eq(auditLog.workspaceId, input.workspaceId), eq(auditLog.id, auditEventId)));

      return { auditEventId, evidenceItemId };
    })
    .catch(() => null);
}

function hashConductValue(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
}
