import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, asc, eq } from 'drizzle-orm';
import { appendEvidenceItem } from '@pilot/db';
import { a2aMessages, a2aThreads, auditLog, tasks as tasksTable } from '@pilot/db/schema';
import {
  buildPilotAgentCard,
  type A2AMessage,
  type Task,
  type TaskState,
  type TaskSendRequest,
} from '@pilot/shared/a2a';
import { type GatewayDeps } from '../index.js';

// ─── A2A server routes (Phase 15 Track J) ───
//
// Pilot-as-server half of the A2A protocol. Exposes:
//   GET  /.well-known/agent-card.json  — public discovery doc
//   POST /a2a                          — JSON-RPC 2.0 task lifecycle
//
// Auth: requires `PILOT_A2A_TOKEN` env var set. Constant-time compare
// against the bearer header. Refuses all calls when the var is unset.

export function a2aRoutes(deps: GatewayDeps) {
  const app = new Hono();

  app.get('/.well-known/agent-card.json', (c) => {
    const publicBase = process.env['PILOT_A2A_PUBLIC_URL'] ?? 'http://localhost:3100';
    const card = buildPilotAgentCard({
      url: `${publicBase}/a2a`,
      version: process.env['PILOT_VERSION'] ?? '1.2.0',
      organization: process.env['PILOT_A2A_ORGANIZATION'] ?? undefined,
      organizationUrl: process.env['PILOT_A2A_ORGANIZATION_URL'] ?? undefined,
    });
    return c.json(card);
  });

  app.post('/a2a', async (c) => {
    const expected = process.env['PILOT_A2A_TOKEN'];
    if (!expected) {
      return c.json(
        {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'A2A not configured (no token)' },
          id: null,
        },
        503,
      );
    }
    const auth = c.req.header('authorization') ?? '';
    if (!auth.toLowerCase().startsWith('bearer ')) {
      return rpcError(c, null, -32001, 'Unauthorized', 401);
    }
    const presented = Buffer.from(auth.slice(7));
    const expectedBuf = Buffer.from(expected);
    const ok = presented.length === expectedBuf.length && timingSafeEqual(presented, expectedBuf);
    if (!ok) return rpcError(c, null, -32001, 'Unauthorized', 401);

    let body: {
      jsonrpc?: string;
      id?: number | string | null;
      method?: string;
      params?: unknown;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return rpcError(c, null, -32700, 'Parse error', 400);
    }
    if (!body || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return rpcError(c, body?.id ?? null, -32600, 'Invalid Request', 400);
    }
    const id = body.id ?? null;

    try {
      switch (body.method) {
        case 'tasks/send': {
          const req = (body.params ?? {}) as TaskSendRequest;
          if (!req.message || !Array.isArray(req.message.parts)) {
            return rpcError(c, id, -32602, 'message.parts required');
          }
          const workspaceId = process.env['PILOT_A2A_WORKSPACE_ID'];
          if (!workspaceId) {
            return rpcError(
              c,
              id,
              -32000,
              'PILOT_A2A_WORKSPACE_ID not configured; cannot dispatch',
            );
          }
          const taskId = req.id ?? `task-${randomUUID()}`;
          const text = extractText(req.message);
          if (!text) {
            return rpcError(c, id, -32602, 'message requires a text part');
          }

          // 1. Persist the task row and redacted dispatch proof before conductor execution.
          const dispatchProof = await persistA2aDispatchProof(deps, {
            workspaceId,
            externalTaskId: taskId,
            text,
            jsonrpcId: id,
          });
          if (!dispatchProof) {
            return rpcError(c, id, -32603, 'A2A dispatch evidence persistence failed', 500);
          }
          const { pilotTaskId, evidenceItemId } = dispatchProof;

          // 2. Dispatch through the governed orchestrator.
          let result: { status: string; actions?: Array<{ tool: string; input?: unknown }> };
          try {
            result = (await deps.orchestrator.runConduct({
              taskId: pilotTaskId,
              workspaceId,
              context: text,
            })) as typeof result;
          } catch (err) {
            const failed: Task = {
              id: taskId,
              status: {
                state: 'failed',
                timestamp: new Date().toISOString(),
                message: agentText(
                  `Pilot failed to dispatch: ${err instanceof Error ? err.message : String(err)}`,
                ),
              },
              history: [req.message],
            };
            await persistA2aTask(deps, {
              workspaceId,
              externalTaskId: taskId,
              pilotTaskId,
              state: 'failed',
              userMessage: req.message,
              agentMessage: failed.status.message,
              metadata: {
                jsonrpcId: id,
                error: err instanceof Error ? err.message : String(err),
                dispatchEvidenceItemId: evidenceItemId,
              },
            });
            return c.json({ jsonrpc: '2.0', id, result: { task: failed } });
          }

          // 3. Map AgentRunResult → A2A TaskState + build reply.
          const state: Task['status']['state'] =
            result.status === 'completed'
              ? 'completed'
              : result.status === 'awaiting_approval'
                ? 'input-required'
                : 'failed';
          const finish = (result.actions ?? [])
            .slice()
            .reverse()
            .find((a) => a.tool === 'finish');
          const summary =
            finish && typeof finish.input === 'object' && finish.input !== null
              ? String(
                  (finish.input as { summary?: unknown }).summary ??
                    `Conduct finished with status=${result.status}.`,
                )
              : `Conduct finished with status=${result.status}.`;

          const task: Task = {
            id: taskId,
            status: {
              state,
              timestamp: new Date().toISOString(),
              message: agentText(summary),
            },
            history: [req.message],
          };
          await persistA2aTask(deps, {
            workspaceId,
            externalTaskId: taskId,
            pilotTaskId,
            state,
            userMessage: req.message,
            agentMessage: task.status.message,
            metadata: {
              jsonrpcId: id,
              conductStatus: result.status,
              dispatchEvidenceItemId: evidenceItemId,
            },
          });
          return c.json({ jsonrpc: '2.0', id, result: { task } });
        }
        case 'tasks/get': {
          const params = (body.params ?? {}) as { id?: string };
          if (typeof params.id !== 'string') {
            return rpcError(c, id, -32602, 'params.id required');
          }
          const workspaceId = process.env['PILOT_A2A_WORKSPACE_ID'];
          if (!workspaceId) {
            return rpcError(
              c,
              id,
              -32000,
              'PILOT_A2A_WORKSPACE_ID not configured; cannot dispatch',
            );
          }
          const task = await loadA2aTask(deps, workspaceId, params.id);
          if (!task) return rpcError(c, id, -32004, 'task_not_found');
          return c.json({ jsonrpc: '2.0', id, result: { task } });
        }
        case 'tasks/cancel': {
          const params = (body.params ?? {}) as { id?: string };
          if (typeof params.id !== 'string') {
            return rpcError(c, id, -32602, 'params.id required');
          }
          const workspaceId = process.env['PILOT_A2A_WORKSPACE_ID'];
          if (!workspaceId) {
            return rpcError(
              c,
              id,
              -32000,
              'PILOT_A2A_WORKSPACE_ID not configured; cannot dispatch',
            );
          }
          const task = await loadA2aTask(deps, workspaceId, params.id);
          if (!task) return rpcError(c, id, -32004, 'task_not_found');
          const canceledAt = new Date();
          await deps.db
            .update(a2aThreads)
            .set({ status: 'canceled', updatedAt: canceledAt, completedAt: canceledAt })
            .where(
              and(
                eq(a2aThreads.workspaceId, workspaceId),
                eq(a2aThreads.externalTaskId, params.id),
              ),
            );
          return c.json({
            jsonrpc: '2.0',
            id,
            result: {
              task: {
                ...task,
                status: { state: 'canceled', timestamp: canceledAt.toISOString() },
              },
            },
          });
        }
        default:
          return rpcError(c, id, -32601, `Method not found: ${body.method}`);
      }
    } catch (err) {
      return rpcError(c, id, -32603, err instanceof Error ? err.message : 'Internal error');
    }
  });

  return app;
}

function rpcError(
  c: Context,
  id: number | string | null,
  code: number,
  message: string,
  httpStatus?: 400 | 401 | 500 | 503,
) {
  const body = { jsonrpc: '2.0', id, error: { code, message } };
  return httpStatus ? c.json(body, httpStatus) : c.json(body);
}

type A2aDispatchProofInput = {
  workspaceId: string;
  externalTaskId: string;
  text: string;
  jsonrpcId: number | string | null;
};

async function persistA2aDispatchProof(
  deps: GatewayDeps,
  input: A2aDispatchProofInput,
): Promise<{ pilotTaskId: string; auditEventId: string; evidenceItemId: string } | null> {
  const textHash = hashA2aValue(input.text);

  return deps.db
    .transaction(async (tx) => {
      const db = tx as unknown as typeof deps.db;
      const [taskRow] = await db
        .insert(tasksTable)
        .values({
          workspaceId: input.workspaceId,
          title: input.text.slice(0, 60),
          description: input.text,
          mode: 'a2a',
          status: 'pending',
          priority: 0,
          metadata: { a2a: { taskId: input.externalTaskId } },
        })
        .returning({ id: tasksTable.id });
      const pilotTaskId = taskRow?.id;
      if (!pilotTaskId) {
        throw new Error('A2A task persistence failed');
      }

      const auditEventId = randomUUID();
      const auditMetadata = {
        workspaceId: input.workspaceId,
        externalTaskId: input.externalTaskId,
        pilotTaskId,
        jsonrpcId: input.jsonrpcId,
        textHash,
        textLength: input.text.length,
        evidenceContract: 'a2a_dispatch_evidence_required',
      };

      await db.insert(auditLog).values({
        id: auditEventId,
        workspaceId: input.workspaceId,
        action: 'A2A_TASK_SEND_DISPATCHED',
        actor: 'a2a:bearer',
        target: pilotTaskId,
        verdict: 'allow',
        metadata: auditMetadata,
      });

      const evidenceItemId = await appendEvidenceItem(db, {
        workspaceId: input.workspaceId,
        taskId: pilotTaskId,
        auditEventId,
        evidenceType: 'a2a_task_dispatched',
        sourceType: 'gateway_a2a_route',
        title: 'A2A task dispatched',
        summary:
          'Gateway A2A tasks/send accepted bearer auth, created a task row, and persisted redacted dispatch proof before conductor execution.',
        redactionState: 'redacted',
        sensitivity: 'internal',
        replayRef: `a2a:${input.externalTaskId}:dispatch:${auditEventId}`,
        metadata: auditMetadata,
      });

      await db
        .update(auditLog)
        .set({ metadata: { ...auditMetadata, evidenceItemId } })
        .where(and(eq(auditLog.workspaceId, input.workspaceId), eq(auditLog.id, auditEventId)));

      return { pilotTaskId, auditEventId, evidenceItemId };
    })
    .catch(() => null);
}

function extractText(user: A2AMessage): string {
  const firstText = user.parts.find((p) => p.type === 'text');
  return firstText?.type === 'text' ? firstText.text : '';
}

function agentText(text: string): A2AMessage {
  return { role: 'agent', parts: [{ type: 'text', text }] };
}

async function persistA2aTask(
  deps: GatewayDeps,
  params: {
    workspaceId: string;
    externalTaskId: string;
    pilotTaskId: string;
    state: TaskState;
    userMessage: A2AMessage;
    agentMessage?: A2AMessage;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  const completedAt =
    params.state === 'completed' || params.state === 'failed' || params.state === 'canceled'
      ? new Date()
      : null;
  await deps.db.transaction(async (tx) => {
    const db = tx as unknown as typeof deps.db;
    const [thread] = await db
      .insert(a2aThreads)
      .values({
        workspaceId: params.workspaceId,
        externalTaskId: params.externalTaskId,
        pilotTaskId: params.pilotTaskId || null,
        status: params.state,
        metadata: params.metadata,
        completedAt,
      })
      .returning({ id: a2aThreads.id });

    if (!thread?.id) {
      throw new Error('A2A thread persistence failed');
    }

    const messages = [
      {
        threadId: thread.id,
        workspaceId: params.workspaceId,
        role: params.userMessage.role,
        parts: params.userMessage.parts,
        sequence: 1,
      },
    ];
    if (params.agentMessage) {
      messages.push({
        threadId: thread.id,
        workspaceId: params.workspaceId,
        role: params.agentMessage.role,
        parts: params.agentMessage.parts,
        sequence: 2,
      });
    }
    await db.insert(a2aMessages).values(messages);
  });
}

async function loadA2aTask(
  deps: GatewayDeps,
  workspaceId: string,
  externalTaskId: string,
): Promise<Task | null> {
  const [thread] = await deps.db
    .select()
    .from(a2aThreads)
    .where(
      and(eq(a2aThreads.workspaceId, workspaceId), eq(a2aThreads.externalTaskId, externalTaskId)),
    )
    .limit(1);
  if (!thread) return null;

  const rows = await deps.db
    .select()
    .from(a2aMessages)
    .where(and(eq(a2aMessages.workspaceId, workspaceId), eq(a2aMessages.threadId, thread.id)))
    .orderBy(asc(a2aMessages.sequence));

  const history = rows.map((row) => ({
    role: row.role === 'agent' ? 'agent' : 'user',
    parts: Array.isArray(row.parts) ? row.parts : [],
  })) as A2AMessage[];
  const agentMessage = [...history].reverse().find((message) => message.role === 'agent');
  const timestamp = (
    thread.completedAt ??
    thread.updatedAt ??
    thread.createdAt ??
    new Date()
  ).toISOString();

  return {
    id: thread.externalTaskId,
    status: {
      state: coerceTaskState(thread.status),
      timestamp,
      ...(agentMessage ? { message: agentMessage } : {}),
    },
    history,
  };
}

function coerceTaskState(state: string): TaskState {
  if (
    state === 'submitted' ||
    state === 'working' ||
    state === 'input-required' ||
    state === 'completed' ||
    state === 'canceled' ||
    state === 'failed'
  ) {
    return state;
  }
  return 'failed';
}

/** Test hook retained for backward-compatible tests; A2A state is DB-backed. */
export function __resetA2aTasks(): void {
  // no-op
}

function hashA2aValue(value: unknown): string {
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
