import { describe, it, expect, vi, beforeEach } from 'vitest';
import { auditLog, evidenceItems, taskRuns, tasks } from '@pilot/db/schema';
import { taskRoutes } from '../../routes/task.js';
import { createMockDeps, testApp, expectJson, mockTask } from '../helpers.js';

const VALID_UUID = '00000000-0000-0000-0000-000000000001';
const wsHeader = { 'X-Workspace-Id': VALID_UUID };

function createTaskStatusDb(options: { failEvidence?: boolean; existingTask?: unknown } = {}) {
  const existingTask =
    options.existingTask ??
    mockTask({
      id: 'task-1',
      workspaceId: VALID_UUID,
      title: 'Build MVP',
      status: 'pending',
    });
  const inserts: Array<{ table: unknown; value: unknown }> = [];
  const updates: Array<{ table: unknown; value: unknown }> = [];

  const createDbFacade = (
    insertSink: Array<{ table: unknown; value: unknown }>,
    updateSink: Array<{ table: unknown; value: unknown }>,
  ) => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => (existingTask ? [existingTask] : [])),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertSink.push({ table, value });
        return {
          returning: vi.fn(async () => {
            if (table === evidenceItems) {
              if (options.failEvidence) throw new Error('evidence unavailable');
              return [{ id: 'evidence-task-status-1' }];
            }
            return [];
          }),
          then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
            Promise.resolve([]).then(resolve, reject),
          catch: (reject: (reason: unknown) => void) => Promise.resolve([]).catch(reject),
        };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((value: Record<string, unknown>) => {
        updateSink.push({ table, value });
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => {
              if (table === tasks && existingTask) {
                return [{ ...(existingTask as Record<string, unknown>), ...value }];
              }
              return [];
            }),
            then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
              Promise.resolve([]).then(resolve, reject),
            catch: (reject: (reason: unknown) => void) => Promise.resolve([]).catch(reject),
          })),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => []),
    })),
    execute: vi.fn(async () => [{ '?column?': 1 }]),
  });

  const db = {
    ...createDbFacade(inserts, updates),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const stagedInserts: Array<{ table: unknown; value: unknown }> = [];
      const stagedUpdates: Array<{ table: unknown; value: unknown }> = [];
      const tx = createDbFacade(stagedInserts, stagedUpdates);
      const result = await callback(tx);
      inserts.push(...stagedInserts);
      updates.push(...stagedUpdates);
      return result;
    }),
    _setResult: vi.fn(),
    _reset: vi.fn(),
  };

  return { db, inserts, updates };
}

function orderByColumnName(value: unknown): string | undefined {
  return (value as { queryChunks?: Array<{ name?: string }> })?.queryChunks?.[1]?.name;
}

describe('taskRoutes', () => {
  // ─── GET / ───

  describe('GET /', () => {
    it('returns 400 when workspaceId query param is missing', async () => {
      const { fetch } = testApp(taskRoutes);
      const res = await fetch('GET', '/');
      const json = await expectJson(res, 400);
      expect(json).toHaveProperty('error', 'workspaceId required');
    });

    it('returns array of tasks on success', async () => {
      const { fetch, deps } = testApp(taskRoutes);
      const tasks = [mockTask(), mockTask({ id: 'task-2', title: 'Second task' })];
      deps.db._setResult(tasks);

      const res = await fetch('GET', '/', undefined, wsHeader);
      const json = await expectJson<unknown[]>(res, 200);
      expect(Array.isArray(json)).toBe(true);
      expect(json).toHaveLength(2);
    });
  });

  // ─── POST / ───

  describe('POST /', () => {
    it('returns 400 when body fails Zod validation', async () => {
      const { fetch } = testApp(taskRoutes);
      // Missing required fields
      const res = await fetch('POST', '/', { title: '' }, wsHeader);
      const json = await expectJson(res, 400);
      expect(json).toHaveProperty('error', 'Validation failed');
      expect(json).toHaveProperty('details');
    });

    it('returns 400 when only body workspaceId is provided', async () => {
      const { fetch } = testApp(taskRoutes);
      const res = await fetch('POST', '/', {
        workspaceId: VALID_UUID,
        title: 'Body-only workspace',
        mode: 'build',
      });
      const json = await expectJson(res, 400);
      expect(json).toHaveProperty('error', 'workspaceId required');
    });

    it('returns 403 when body workspaceId mismatches the bound workspace', async () => {
      const { fetch } = testApp(taskRoutes);
      const res = await fetch(
        'POST',
        '/',
        {
          workspaceId: '00000000-0000-0000-0000-000000000002',
          title: 'Mismatched workspace',
          mode: 'build',
        },
        wsHeader,
      );
      const json = await expectJson(res, 403);
      expect(json).toHaveProperty('error', 'workspaceId does not match authenticated workspace');
    });

    it('returns 400 for invalid mode', async () => {
      const { fetch } = testApp(taskRoutes);
      const res = await fetch(
        'POST',
        '/',
        {
          workspaceId: VALID_UUID,
          title: 'Test',
          mode: 'invalid',
        },
        wsHeader,
      );
      const json = await expectJson(res, 400);
      expect(json).toHaveProperty('error', 'Validation failed');
    });

    it('rejects operatorId from another workspace before task creation', async () => {
      const deps = createMockDeps();
      const { fetch } = testApp(taskRoutes, deps as any);
      const res = await fetch(
        'POST',
        '/',
        {
          workspaceId: VALID_UUID,
          operatorId: '00000000-0000-0000-0000-000000000099',
          title: 'Foreign operator task',
          mode: 'build',
        },
        wsHeader,
      );
      const json = await expectJson<{ error: string }>(res, 403);

      expect(json.error).toBe('operatorId does not belong to authenticated workspace');
      expect(deps.db.insert).not.toHaveBeenCalled();
    });

    it('returns 201 on successful creation', async () => {
      const deps = createMockDeps();
      const created = mockTask({ workspaceId: VALID_UUID, title: 'Build MVP' });
      const inserts: Array<{ table: unknown; value: unknown }> = [];
      deps.db.insert = vi.fn((table: unknown) => ({
        values: vi.fn((value: unknown) => {
          inserts.push({ table, value });
          return {
            returning: vi.fn(async () =>
              table === tasks
                ? [created]
                : table === evidenceItems
                  ? [{ id: 'evidence-task-1' }]
                  : [],
            ),
            onConflictDoNothing: vi.fn(() => ({ returning: vi.fn(async () => [created]) })),
            onConflictDoUpdate: vi.fn(() => ({ returning: vi.fn(async () => [created]) })),
            then: (r: any) => r([]),
          };
        }),
      })) as any;

      const { fetch } = testApp(taskRoutes, deps as any);
      const res = await fetch(
        'POST',
        '/',
        {
          workspaceId: VALID_UUID,
          title: 'Build MVP',
          mode: 'build',
        },
        wsHeader,
      );
      const json = await expectJson<{ id: string; title: string }>(res, 201);
      expect(json.id).toBe('task-1');
      expect(json.title).toBe('Build MVP');
      expect(inserts.findIndex((insert) => insert.table === auditLog)).toBeLessThan(
        inserts.findIndex((insert) => insert.table === evidenceItems),
      );
      const auditInsert = inserts.find((insert) => insert.table === auditLog);
      const evidenceInsert = inserts.find((insert) => insert.table === evidenceItems);
      expect(auditInsert?.value).toMatchObject({
        workspaceId: VALID_UUID,
        action: 'TASK_CREATED',
        target: 'task-1',
        metadata: expect.objectContaining({
          taskId: 'task-1',
          evidenceContract: 'task_create_evidence_required',
        }),
      });
      expect(evidenceInsert?.value).toMatchObject({
        workspaceId: VALID_UUID,
        taskId: 'task-1',
        auditEventId: (auditInsert?.value as { id?: string } | undefined)?.id,
        evidenceType: 'task_created',
        sourceType: 'gateway_task_route',
        replayRef: 'task:task-1:created',
      });
    });

    it('fails task creation when task evidence cannot be persisted', async () => {
      const deps = createMockDeps();
      const created = mockTask({ workspaceId: VALID_UUID, title: 'Build MVP' });
      deps.db.insert = vi.fn((table: unknown) => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => {
            if (table === tasks) return [created];
            if (table === evidenceItems) throw new Error('evidence unavailable');
            return [];
          }),
          then: (r: any) => r([]),
        })),
      })) as any;

      const { fetch } = testApp(taskRoutes, deps as any);
      const res = await fetch(
        'POST',
        '/',
        {
          workspaceId: VALID_UUID,
          title: 'Build MVP',
          mode: 'build',
        },
        wsHeader,
      );

      expect(res.status).toBe(500);
    });

    it('calls orchestrator.runTask when autoRun is true', async () => {
      const deps = createMockDeps();
      const created = mockTask({ workspaceId: VALID_UUID, title: 'Auto task' });

      // Mock insert to return the task for both insert calls (task + taskRun)
      deps.db.insert = vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [created]),
          onConflictDoNothing: vi.fn(() => ({ returning: vi.fn(async () => [created]) })),
          onConflictDoUpdate: vi.fn(() => ({ returning: vi.fn(async () => [created]) })),
          then: (r: any) => r([created]),
        })),
      })) as any;

      const { fetch } = testApp(taskRoutes, deps as any);
      const res = await fetch(
        'POST',
        '/',
        {
          workspaceId: VALID_UUID,
          title: 'Auto task',
          mode: 'discover',
          autoRun: true,
        },
        wsHeader,
      );
      await expectJson(res, 201);
      expect(deps.orchestrator.runTask).toHaveBeenCalledTimes(1);
      expect(deps.orchestrator.runTask).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: 'task-1', workspaceId: VALID_UUID }),
      );
    });
  });

  describe('PUT /:id/status', () => {
    it('denies members from mutating task status', async () => {
      const { fetch, deps } = testApp(taskRoutes);
      const res = await fetch(
        'PUT',
        '/task-1/status',
        { status: 'completed' },
        { ...wsHeader, 'X-Workspace-Role': 'member' },
      );
      const json = await expectJson<{ error: string; requiredRole: string }>(res, 403);

      expect(json.error).toBe('insufficient workspace role');
      expect(json.requiredRole).toBe('partner');
      expect(deps.db.update).not.toHaveBeenCalled();
    });

    it('writes audit-linked evidence on status mutation', async () => {
      const { db, inserts, updates } = createTaskStatusDb();
      const deps = createMockDeps({ db: db as never });
      const { fetch } = testApp(taskRoutes, deps);
      const res = await fetch('PUT', '/task-1/status', { status: 'completed' }, wsHeader);
      const json = await expectJson<{ id: string; status: string }>(res, 200);

      expect(json).toMatchObject({ id: 'task-1', status: 'completed' });
      expect(updates.map((update) => update.table)).toEqual([tasks, auditLog]);
      expect(inserts.map((insert) => insert.table)).toEqual([auditLog, evidenceItems]);
      expect(updates.find((update) => update.table === tasks)?.value).toMatchObject({
        status: 'completed',
        completedAt: expect.any(Date),
      });
      const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
        id: string;
      };
      expect(auditInsert).toMatchObject({
        workspaceId: VALID_UUID,
        action: 'TASK_STATUS_UPDATED',
        actor: 'user:user-1',
        target: 'task-1',
        verdict: 'allow',
        metadata: {
          evidenceType: 'task_status_updated',
          replayRef: 'task:task-1:status:pending->completed',
          taskId: 'task-1',
          previousStatus: 'pending',
          status: 'completed',
          completed: true,
          evidenceContract: 'task_status_update_evidence_required',
        },
      });
      expect(inserts.find((insert) => insert.table === evidenceItems)?.value).toMatchObject({
        workspaceId: VALID_UUID,
        taskId: 'task-1',
        auditEventId: auditInsert.id,
        evidenceType: 'task_status_updated',
        sourceType: 'gateway_task_route',
        replayRef: 'task:task-1:status:pending->completed',
        metadata: {
          taskId: 'task-1',
          previousStatus: 'pending',
          status: 'completed',
          completed: true,
          evidenceContract: 'task_status_update_evidence_required',
        },
      });
      expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
        metadata: {
          evidenceItemId: 'evidence-task-status-1',
        },
      });
    });

    it('fails closed without committing task status when evidence persistence fails', async () => {
      const { db, inserts, updates } = createTaskStatusDb({ failEvidence: true });
      const deps = createMockDeps({ db: db as never });
      const { fetch } = testApp(taskRoutes, deps);
      const res = await fetch('PUT', '/task-1/status', { status: 'completed' }, wsHeader);
      const json = await expectJson<{ error: string }>(res, 500);

      expect(json.error).toContain('Failed to update task status evidence');
      expect(inserts).toEqual([]);
      expect(updates).toEqual([]);
    });
  });

  // ─── GET /:id/runs ───

  describe('GET /:id/runs', () => {
    it('returns array of runs', async () => {
      const { fetch, deps } = testApp(taskRoutes);
      const runs = [
        {
          id: 'run-1',
          taskId: 'task-1',
          status: 'completed',
          iterationsUsed: 3,
          iterationBudget: 50,
        },
      ];
      let selectCall = 0;
      const origSelect = deps.db.select;
      deps.db.select = vi.fn(() => {
        selectCall++;
        deps.db._setResult(
          selectCall === 1 ? [mockTask({ id: 'task-1', workspaceId: VALID_UUID })] : runs,
        );
        return origSelect();
      }) as any;

      const res = await fetch('GET', '/task-1/runs', undefined, wsHeader);
      const json = await expectJson<unknown[]>(res, 200);
      expect(Array.isArray(json)).toBe(true);
      expect(json).toHaveLength(1);
    });

    it('returns empty array when no runs exist', async () => {
      const deps = createMockDeps();
      let selectCall = 0;
      const origSelect = deps.db.select;
      deps.db.select = vi.fn(() => {
        selectCall++;
        deps.db._setResult(
          selectCall === 1 ? [mockTask({ id: 'task-1', workspaceId: VALID_UUID })] : [],
        );
        return origSelect();
      }) as any;

      const { fetch } = testApp(taskRoutes, deps);
      // Default mock returns []
      const res = await fetch('GET', '/task-1/runs', undefined, wsHeader);
      const json = await expectJson<unknown[]>(res, 200);
      expect(json).toEqual([]);
    });

    it('orders run history deterministically when timestamps tie', async () => {
      const orderByCalls: unknown[][] = [];
      const runs = [
        {
          id: 'run-2',
          taskId: 'task-1',
          status: 'completed',
          runSequence: 2,
          startedAt: new Date('2026-05-05T09:00:00Z'),
        },
        {
          id: 'run-1',
          taskId: 'task-1',
          status: 'completed',
          runSequence: 1,
          startedAt: new Date('2026-05-05T09:00:00Z'),
        },
      ];
      const deps = createMockDeps();
      deps.db.select = vi.fn(() => ({
        from: vi.fn((table: unknown) => {
          if (table === tasks) {
            return {
              where: vi.fn(() => ({
                limit: vi.fn(async () => [mockTask({ id: 'task-1', workspaceId: VALID_UUID })]),
              })),
            };
          }
          if (table === taskRuns) {
            return {
              where: vi.fn(() => ({
                orderBy: vi.fn((...columns: unknown[]) => {
                  orderByCalls.push(columns);
                  return Promise.resolve(runs);
                }),
              })),
            };
          }
          throw new Error('unexpected table');
        }),
      })) as any;

      const { fetch } = testApp(taskRoutes, deps);
      const res = await fetch('GET', '/task-1/runs', undefined, wsHeader);
      const json = await expectJson<unknown[]>(res, 200);

      expect(json).toEqual(
        runs.map((run) => ({ ...run, startedAt: run.startedAt.toISOString() })),
      );
      expect(orderByCalls).toHaveLength(1);
      expect(orderByCalls[0]).toHaveLength(3);
      expect(orderByColumnName(orderByCalls[0]?.[0])).toBe('started_at');
      expect(orderByColumnName(orderByCalls[0]?.[1])).toBe('run_sequence');
      expect(orderByColumnName(orderByCalls[0]?.[2])).toBe('id');
    });

    it('returns 404 before reading runs when task is outside the bound workspace', async () => {
      const { fetch, deps } = testApp(taskRoutes);
      deps.db._setResult([]);

      const res = await fetch('GET', '/task-foreign/runs', undefined, wsHeader);
      const json = await expectJson<{ error: string }>(res, 404);

      expect(json.error).toBe('Task not found');
    });
  });
});
