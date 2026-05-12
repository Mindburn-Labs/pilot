import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { appendEvidenceItem } from '@pilot/db';
import { auditLog, tasks, taskRuns } from '@pilot/db/schema';
import { CreateTaskInput, TaskStatusSchema } from '@pilot/shared/schemas';
import { type GatewayDeps } from '../index.js';
import {
  getWorkspaceId,
  requireWorkspaceOperator,
  requireWorkspaceRole,
  workspaceIdMismatch,
} from '../lib/workspace.js';

export function taskRoutes(deps: GatewayDeps) {
  const app = new Hono();

  app.get('/', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);

    const limit = Math.min(Number(c.req.query('limit') ?? '100'), 200);
    const rows = await deps.db
      .select()
      .from(tasks)
      .where(eq(tasks.workspaceId, workspaceId))
      .orderBy(desc(tasks.createdAt))
      .limit(limit);

    return c.json(rows);
  });

  app.post('/', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'create workspace tasks');
    if (roleDenied) return roleDenied;
    const raw = await c.req.json();
    if (workspaceIdMismatch(c, raw.workspaceId)) {
      return c.json({ error: 'workspaceId does not match authenticated workspace' }, 403);
    }
    const parsed = CreateTaskInput.safeParse({
      ...raw,
      workspaceId,
    });

    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const body = parsed.data;
    const operatorDenied = await requireWorkspaceOperator(deps.db, c, workspaceId, body.operatorId);
    if (operatorDenied) return operatorDenied;

    const task = await deps.db
      .transaction(async (tx) => {
        const [created] = await tx
          .insert(tasks)
          .values({
            workspaceId: body.workspaceId,
            operatorId: body.operatorId,
            title: body.title,
            description: body.description,
            mode: body.mode,
            priority: 0,
          })
          .returning();

        if (!created) return null;

        const auditEventId = randomUUID();
        const auditMetadata = {
          taskId: created.id,
          workspaceId,
          operatorId: created.operatorId ?? null,
          mode: created.mode,
          autoRun: Boolean(body.autoRun),
          evidenceContract: 'task_create_evidence_required',
        };
        await tx.insert(auditLog).values({
          id: auditEventId,
          workspaceId,
          action: 'TASK_CREATED',
          actor: `user:${c.get('userId') ?? 'unknown'}`,
          target: created.id,
          verdict: 'allow',
          metadata: auditMetadata,
        });

        const evidenceItemId = await appendEvidenceItem(tx, {
          workspaceId,
          taskId: created.id,
          auditEventId,
          evidenceType: 'task_created',
          sourceType: 'gateway_task_route',
          title: `Task created: ${created.title}`,
          summary: 'Workspace task created through the gateway task API.',
          redactionState: 'redacted',
          sensitivity: 'internal',
          replayRef: `task:${created.id}:created`,
          metadata: auditMetadata,
        });

        await tx
          .update(auditLog)
          .set({ metadata: { ...auditMetadata, evidenceItemId } })
          .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

        return created;
      })
      .catch(() => null);

    if (!task) return c.json({ error: 'Failed to create task' }, 500);

    if (body.autoRun) {
      const dispatchProof = await persistTaskRunDispatchProof(deps, {
        workspaceId: task.workspaceId,
        taskId: task.id,
        operatorId: task.operatorId ?? null,
        actor: `user:${c.get('userId') ?? 'unknown'}`,
        trigger: 'auto',
        previousStatus: task.status,
        context: task.description,
        iterationBudget: body.iterationBudget,
      });
      if (!dispatchProof) {
        return c.json({ error: 'Task run dispatch evidence persistence failed', task }, 500);
      }
      const runResult = await executeTaskRun(deps, task.id, {
        workspaceId: task.workspaceId,
        operatorId: task.operatorId ?? undefined,
        context: task.description,
        iterationBudget: body.iterationBudget,
      });
      return c.json({ ...task, status: runResult.status }, 201);
    }

    return c.json(task, 201);
  });

  app.put('/:id/status', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'mutate workspace task status');
    if (roleDenied) return roleDenied;

    const { id } = c.req.param();
    const raw = (await c.req.json()) as { status?: string };
    const parsed = TaskStatusSchema.safeParse(raw.status);
    if (!parsed.success) {
      return c.json({ error: 'Invalid status', allowed: TaskStatusSchema.options }, 400);
    }

    // Both the SELECT and UPDATE compose taskId with workspaceId so a caller
    // cannot read or mutate another tenant's tasks by id-guess.
    const [existing] = await deps.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId)))
      .limit(1);

    if (!existing) return c.json({ error: 'Task not found' }, 404);

    const updated = await deps.db
      .transaction(async (tx) => {
        const [updatedTask] = await tx
          .update(tasks)
          .set({
            status: parsed.data,
            updatedAt: new Date(),
            completedAt: parsed.data === 'completed' ? new Date() : null,
          })
          .where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId)))
          .returning();

        if (!updatedTask) throw new Error('failed to update task status');

        const auditEventId = randomUUID();
        const replayRef = `task:${id}:status:${existing.status}->${parsed.data}`;
        const auditMetadata = {
          taskId: id,
          previousStatus: existing.status,
          status: parsed.data,
          completed: parsed.data === 'completed',
          evidenceContract: 'task_status_update_evidence_required',
        };

        await tx.insert(auditLog).values({
          id: auditEventId,
          workspaceId,
          action: 'TASK_STATUS_UPDATED',
          actor: `user:${c.get('userId') ?? 'unknown'}`,
          target: id,
          verdict: 'allow',
          metadata: {
            evidenceType: 'task_status_updated',
            replayRef,
            ...auditMetadata,
          },
        });

        const evidenceItemId = await appendEvidenceItem(tx, {
          workspaceId,
          taskId: id,
          auditEventId,
          evidenceType: 'task_status_updated',
          sourceType: 'gateway_task_route',
          title: `Task status updated: ${updatedTask.title}`,
          summary: `Task status changed from ${existing.status} to ${parsed.data}.`,
          redactionState: 'none',
          sensitivity: 'internal',
          replayRef,
          metadata: auditMetadata,
        });

        await tx
          .update(auditLog)
          .set({
            metadata: {
              evidenceType: 'task_status_updated',
              replayRef,
              evidenceItemId,
              ...auditMetadata,
            },
          })
          .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

        return updatedTask;
      })
      .catch(() => null);

    if (!updated) return c.json({ error: 'Failed to update task status evidence' }, 500);
    return c.json(updated);
  });

  app.post('/:id/run', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'run workspace tasks');
    if (roleDenied) return roleDenied;

    const { id } = c.req.param();
    const [task] = await deps.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId)))
      .limit(1);

    if (!task) return c.json({ error: 'Task not found' }, 404);

    const body = (await c.req.json().catch(() => ({}))) as {
      context?: string;
      iterationBudget?: number;
    };
    const runContext = body.context ?? task.description;

    const dispatchProof = await persistTaskRunDispatchProof(deps, {
      workspaceId: task.workspaceId,
      taskId: task.id,
      operatorId: task.operatorId ?? null,
      actor: `user:${c.get('userId') ?? 'unknown'}`,
      trigger: 'manual',
      previousStatus: task.status,
      context: runContext,
      iterationBudget: body.iterationBudget,
    });
    if (!dispatchProof) {
      return c.json({ error: 'Task run dispatch evidence persistence failed' }, 500);
    }

    const result = await executeTaskRun(deps, id, {
      workspaceId: task.workspaceId,
      operatorId: task.operatorId ?? undefined,
      context: runContext,
      iterationBudget: body.iterationBudget,
    });

    const [updatedTask] = await deps.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId)))
      .limit(1);

    return c.json({
      task: updatedTask ?? task,
      run: result,
    });
  });

  app.get('/:id/runs', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);

    const { id } = c.req.param();
    const [task] = await deps.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.workspaceId, workspaceId)))
      .limit(1);
    if (!task) return c.json({ error: 'Task not found' }, 404);

    const runs = await deps.db
      .select()
      .from(taskRuns)
      .where(eq(taskRuns.taskId, id))
      .orderBy(desc(taskRuns.startedAt), desc(taskRuns.runSequence), desc(taskRuns.id));
    return c.json(runs);
  });

  return app;
}

type TaskRunDispatchProofInput = {
  workspaceId: string;
  taskId: string;
  operatorId: string | null;
  actor: string;
  trigger: 'auto' | 'manual';
  previousStatus: string;
  context: string;
  iterationBudget?: number;
};

async function persistTaskRunDispatchProof(
  deps: GatewayDeps,
  input: TaskRunDispatchProofInput,
): Promise<{ auditEventId: string; evidenceItemId: string } | null> {
  return deps.db
    .transaction(async (tx) => {
      const db = tx as unknown as typeof deps.db;
      const auditEventId = randomUUID();
      const replayRef = `task:${input.taskId}:run:${input.trigger}:${auditEventId}`;
      const auditMetadata = {
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        operatorId: input.operatorId,
        trigger: input.trigger,
        previousStatus: input.previousStatus,
        iterationBudget: input.iterationBudget ?? null,
        contextHash: createHash('sha256').update(input.context).digest('hex'),
        contextLength: input.context.length,
        evidenceContract: 'task_run_dispatch_evidence_required',
      };

      await db.insert(auditLog).values({
        id: auditEventId,
        workspaceId: input.workspaceId,
        action: 'TASK_RUN_DISPATCHED',
        actor: input.actor,
        target: input.taskId,
        verdict: 'allow',
        metadata: {
          evidenceType: 'task_run_dispatched',
          replayRef,
          ...auditMetadata,
        },
      });

      const evidenceItemId = await appendEvidenceItem(db, {
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        auditEventId,
        evidenceType: 'task_run_dispatched',
        sourceType: 'gateway_task_route',
        title: `Task run dispatched: ${input.taskId}`,
        summary:
          'Gateway task route accepted a run request and persisted redacted dispatch proof before orchestrator execution.',
        redactionState: 'redacted',
        sensitivity: 'internal',
        replayRef,
        metadata: auditMetadata,
      });

      await db
        .update(auditLog)
        .set({
          metadata: {
            evidenceType: 'task_run_dispatched',
            replayRef,
            evidenceItemId,
            ...auditMetadata,
          },
        })
        .where(and(eq(auditLog.workspaceId, input.workspaceId), eq(auditLog.id, auditEventId)));

      return { auditEventId, evidenceItemId };
    })
    .catch(() => null);
}

async function executeTaskRun(
  deps: GatewayDeps,
  taskId: string,
  input: {
    workspaceId: string;
    operatorId?: string;
    context: string;
    iterationBudget?: number;
  },
) {
  await deps.db
    .update(tasks)
    .set({
      status: 'running',
      updatedAt: new Date(),
      completedAt: null,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, input.workspaceId)));

  const result = await deps.orchestrator.runTask({
    taskId,
    workspaceId: input.workspaceId,
    operatorId: input.operatorId,
    context: input.context,
    iterationBudget: input.iterationBudget,
  });

  await deps.db
    .update(tasks)
    .set({
      status: mapRunStatusToTaskStatus(result.status),
      updatedAt: new Date(),
      completedAt: result.status === 'completed' ? new Date() : null,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, input.workspaceId)));

  return result;
}

function mapRunStatusToTaskStatus(
  status: 'completed' | 'budget_exhausted' | 'blocked' | 'awaiting_approval' | 'stalled',
) {
  if (status === 'completed') return 'completed';
  if (status === 'awaiting_approval') return 'awaiting_approval';
  return 'failed';
}
