import { describe, expect, it, vi } from 'vitest';
import { auditLog, evidenceItems } from '@pilot/db/schema';
import type { PolicyConfig } from '@pilot/shared/schemas';
import { Orchestrator } from '../index.js';

function makePolicy(): PolicyConfig {
  return {
    killSwitch: false,
    budget: {
      dailyTotalMax: 500,
      perTaskMax: 100,
      perOperatorMax: 200,
      emergencyKill: 1500,
      currency: 'EUR',
    },
    toolBlocklist: [],
    contentBans: [],
    connectorAllowlist: [],
    requireApprovalFor: [],
    failClosed: true,
  };
}

function makeDb(selectResults: unknown[][]) {
  const queue = [...selectResults];
  const inserts: Array<{ table: unknown; value: Record<string, unknown> }> = [];
  const updates: Array<{ table: unknown; value: Record<string, unknown> }> = [];
  const createDbFacade = () => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => queue.shift() ?? []),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        inserts.push({ table, value });
        return {
          returning: vi.fn(async () =>
            table === evidenceItems ? [{ id: 'evidence-runtime-operator-scope-1' }] : [],
          ),
          then: (resolve: (value: unknown[]) => void) => resolve([]),
        };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((value: Record<string, unknown>) => {
        updates.push({ table, value });
        return {
          where: vi.fn(async () => []),
        };
      }),
    })),
  });
  const facade = createDbFacade();
  return {
    ...facade,
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(createDbFacade()),
    ),
    _inserts: inserts,
    _updates: updates,
  } as any;
}

describe('Orchestrator operator scoping', () => {
  it('rejects operatorId that is not owned by the workspace before agent execution', async () => {
    const db = makeDb([[{ currentMode: 'build' }], [], []]);
    const orchestrator = new Orchestrator({
      db,
      policy: makePolicy(),
    });

    await expect(
      orchestrator.runTask({
        taskId: 'task-1',
        workspaceId: 'ws-1',
        operatorId: 'op-foreign',
        context: 'do work',
      }),
    ).rejects.toThrow(/operatorId does not belong to workspace/u);
    expect(db._inserts.find((insert: any) => insert.table === auditLog)?.value).toMatchObject({
      workspaceId: 'ws-1',
      action: 'WORKSPACE_OPERATOR_SCOPE_REJECTED',
      target: 'op-foreign',
      verdict: 'deny',
      metadata: {
        requestedOperatorId: 'op-foreign',
        surface: 'orchestrator.resolveRuntime',
        reason: 'operatorId_not_in_workspace',
      },
    });
    expect(db._inserts.find((insert: any) => insert.table === evidenceItems)?.value).toMatchObject({
      workspaceId: 'ws-1',
      evidenceType: 'workspace_operator_scope_rejected',
      sourceType: 'orchestrator_operator_scope',
      redactionState: 'redacted',
      sensitivity: 'internal',
      metadata: {
        requestedOperatorId: 'op-foreign',
        surface: 'orchestrator.resolveRuntime',
        reason: 'operatorId_not_in_workspace',
      },
    });
  });
});
