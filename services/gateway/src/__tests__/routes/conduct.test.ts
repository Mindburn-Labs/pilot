import { describe, it, expect, vi } from 'vitest';
import { auditLog, evidenceItems } from '@pilot/db/schema';
import { conductRoutes } from '../../routes/conduct.js';
import { createMockDeps, expectJson, testApp } from '../helpers.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const wsHeader = { 'X-Workspace-Id': workspaceId };
const taskId = '00000000-0000-4000-8000-000000000010';

function createConductProofDb(options: { failEvidence?: boolean } = {}) {
  const inserts: Array<{ table: unknown; value: Record<string, unknown> }> = [];
  const updates: Array<{ table: unknown; value: Record<string, unknown> }> = [];

  const createDbFacade = (
    insertSink: Array<{ table: unknown; value: Record<string, unknown> }>,
    updateSink: Array<{ table: unknown; value: Record<string, unknown> }>,
  ) => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ id: taskId }]),
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
              return [{ id: 'evidence-conduct-dispatch-1' }];
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
      const stagedInserts: Array<{ table: unknown; value: Record<string, unknown> }> = [];
      const stagedUpdates: Array<{ table: unknown; value: Record<string, unknown> }> = [];
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

describe('conductRoutes', () => {
  it('rejects conductor runs for member role', async () => {
    const deps = createMockDeps();
    deps.orchestrator.runConduct = vi.fn();
    const { fetch } = testApp(conductRoutes, deps as any);

    const res = await fetch(
      'POST',
      '/conduct',
      {
        taskId,
        context: 'run the mission',
      },
      { ...wsHeader, 'X-Workspace-Role': 'member' },
    );
    const body = await expectJson<{ error: string; requiredRole: string }>(res, 403);

    expect(body.error).toBe('insufficient workspace role');
    expect(body.requiredRole).toBe('partner');
    expect(deps.orchestrator.runConduct).not.toHaveBeenCalled();
  });

  it('rejects foreign workspace operatorId before running conductor', async () => {
    const deps = createMockDeps();
    deps.orchestrator.runConduct = vi.fn();
    const inserts: Array<{ table: unknown; value: Record<string, unknown> }> = [];
    const updates: Array<{ table: unknown; value: Record<string, unknown> }> = [];
    deps.db.insert = vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        inserts.push({ table, value });
        return {
          returning: vi.fn(async () =>
            table === evidenceItems ? [{ id: 'evidence-operator-scope-1' }] : [],
          ),
          then: (resolve: (value: unknown[]) => void) => resolve([]),
        };
      }),
    })) as never;
    deps.db.update = vi.fn((table: unknown) => ({
      set: vi.fn((value: Record<string, unknown>) => {
        updates.push({ table, value });
        return {
          where: vi.fn(async () => []),
        };
      }),
    })) as never;
    const { fetch } = testApp(conductRoutes, deps as any);

    const res = await fetch(
      'POST',
      '/conduct',
      {
        taskId,
        operatorId: '00000000-0000-4000-8000-000000000099',
        context: 'run the mission',
      },
      wsHeader,
    );
    const body = await expectJson<{ error: string }>(res, 403);

    expect(body.error).toBe('operatorId does not belong to authenticated workspace');
    expect(deps.orchestrator.runConduct).not.toHaveBeenCalled();
    expect(inserts.find((insert) => insert.table === auditLog)?.value).toMatchObject({
      workspaceId,
      action: 'WORKSPACE_OPERATOR_SCOPE_REJECTED',
      target: '00000000-0000-4000-8000-000000000099',
      verdict: 'deny',
      metadata: {
        requestedOperatorId: '00000000-0000-4000-8000-000000000099',
        reason: 'operatorId_not_in_workspace',
      },
    });
    expect(inserts.find((insert) => insert.table === evidenceItems)?.value).toMatchObject({
      workspaceId,
      evidenceType: 'workspace_operator_scope_rejected',
      sourceType: 'gateway_operator_scope',
      redactionState: 'redacted',
      sensitivity: 'internal',
      metadata: {
        requestedOperatorId: '00000000-0000-4000-8000-000000000099',
        reason: 'operatorId_not_in_workspace',
      },
    });
    expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
      metadata: { evidenceItemId: 'evidence-operator-scope-1' },
    });
  });

  it('persists redacted dispatch evidence before running conductor', async () => {
    const { db, inserts, updates } = createConductProofDb();
    const deps = createMockDeps({ db: db as never });
    deps.orchestrator.runConduct = vi.fn(async () => ({
      status: 'completed',
      actions: [],
    }));
    const { fetch } = testApp(conductRoutes, deps as any);

    const res = await fetch(
      'POST',
      '/conduct',
      {
        taskId,
        context: 'launch private beta with the founder email list',
        iterationBudget: 3,
      },
      wsHeader,
    );
    const body = await expectJson<{ status: string; evidenceItemId: string }>(res, 200);

    expect(body.status).toBe('completed');
    expect(body.evidenceItemId).toBe('evidence-conduct-dispatch-1');
    expect(deps.orchestrator.runConduct).toHaveBeenCalledOnce();

    const evidenceInsert = inserts.find((insert) => insert.table === evidenceItems);
    expect(evidenceInsert?.value).toMatchObject({
      workspaceId,
      taskId,
      evidenceType: 'conduct_run_dispatched',
      sourceType: 'gateway_conduct_route',
      redactionState: 'redacted',
      sensitivity: 'internal',
    });
    expect(JSON.stringify(evidenceInsert?.value)).not.toContain('launch private beta');
    expect(JSON.stringify(evidenceInsert?.value)).toContain('contextHash');
    expect(inserts.some((insert) => insert.table === auditLog)).toBe(true);
    expect(updates.some((update) => update.table === auditLog)).toBe(true);
  });

  it('fails closed before conductor run when dispatch evidence cannot persist', async () => {
    const { db } = createConductProofDb({ failEvidence: true });
    const deps = createMockDeps({ db: db as never });
    deps.orchestrator.runConduct = vi.fn();
    const { fetch } = testApp(conductRoutes, deps as any);

    const res = await fetch(
      'POST',
      '/conduct',
      {
        taskId,
        context: 'run the mission',
      },
      wsHeader,
    );
    const body = await expectJson<{ error: string }>(res, 500);

    expect(body.error).toBe('Failed to persist conductor dispatch evidence');
    expect(deps.orchestrator.runConduct).not.toHaveBeenCalled();
  });
});
