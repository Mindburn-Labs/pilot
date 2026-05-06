import { describe, expect, it, vi } from 'vitest';
import { actions, auditLog, evidenceItems, toolExecutions } from '@pilot/db/schema';
import { ToolBroker } from '../tool-broker.js';
import { ToolRegistry } from '../tools.js';

function createBrokerDb(
  opts: { failEvidenceInsert?: boolean; failFallbackAuditInsert?: boolean } = {},
) {
  const insertedActions: unknown[] = [];
  const insertedExecutions: unknown[] = [];
  const insertedEvidenceItems: unknown[] = [];
  const insertedAudit: unknown[] = [];
  const updates: Array<{ table: unknown; value: unknown; where?: unknown }> = [];
  const transactionInsertOrder: string[] = [];
  let transactionCount = 0;

  const captureInsert = (evidenceSink: unknown[], auditSink: unknown[], failAuditInsert: boolean) =>
    vi.fn((table: unknown) => ({
      values: vi.fn((value: unknown) => {
        if (table === evidenceItems) {
          transactionInsertOrder.push('evidence_items');
          evidenceSink.push(value);
          return {
            returning: vi.fn(async () => {
              if (opts.failEvidenceInsert) throw new Error('evidence sink unavailable');
              return [{ id: 'evidence-item-1' }];
            }),
          };
        }
        if (table === auditLog) {
          transactionInsertOrder.push('audit_log');
          if (failAuditInsert) throw new Error('fallback audit sink unavailable');
          auditSink.push(value);
          return Promise.resolve([]);
        }
        return { returning: vi.fn(async () => []) };
      }),
    }));
  const captureUpdate = (sink: Array<{ table: unknown; value: unknown; where?: unknown }>) =>
    vi.fn((table: unknown) => ({
      set: vi.fn((value: unknown) => {
        const update: { table: unknown; value: unknown; where?: unknown } = { table, value };
        sink.push(update);
        return {
          where: vi.fn(async (where: unknown) => {
            update.where = where;
            return [];
          }),
        };
      }),
    }));
  const db = {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: unknown) => {
        if (table === actions) {
          insertedActions.push(value);
          return { returning: vi.fn(async () => [{ id: 'action-1' }]) };
        }
        if (table === toolExecutions) {
          insertedExecutions.push(value);
          return { returning: vi.fn(async () => [{ id: 'tool-exec-1' }]) };
        }
        if (table === auditLog) {
          insertedAudit.push(value);
          return Promise.resolve([]);
        }
        return { returning: vi.fn(async () => []) };
      }),
    })),
    update: captureUpdate(updates),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      transactionCount += 1;
      const stagedEvidenceItems: unknown[] = [];
      const stagedAudit: unknown[] = [];
      const stagedUpdates: unknown[] = [];
      const tx = {
        insert: captureInsert(
          stagedEvidenceItems,
          stagedAudit,
          Boolean(opts.failFallbackAuditInsert && transactionCount > 1),
        ),
        update: captureUpdate(stagedUpdates),
      };
      const result = await callback(tx);
      insertedEvidenceItems.push(...stagedEvidenceItems);
      insertedAudit.push(...stagedAudit);
      updates.push(...stagedUpdates);
      return result;
    }),
  };

  return {
    db,
    insertedActions,
    insertedExecutions,
    insertedEvidenceItems,
    insertedAudit,
    updates,
    transactionInsertOrder,
  };
}

function queryChunkColumnNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(queryChunkColumnNames);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  const record = value as { columnType?: unknown; name?: unknown; queryChunks?: unknown };
  const ownName =
    typeof record.name === 'string' && typeof record.columnType === 'string' ? [record.name] : [];
  return [...ownName, ...queryChunkColumnNames(record.queryChunks)];
}

describe('ToolBroker', () => {
  it('persists action, tool execution, hashes, idempotency, policy, and audit rows', async () => {
    const {
      db,
      insertedActions,
      insertedExecutions,
      insertedEvidenceItems,
      insertedAudit,
      updates,
      transactionInsertOrder,
    } = createBrokerDb();
    const registry = new ToolRegistry(db as never, undefined, { skipBuiltins: true });
    registry.register({
      name: 'echo_tool',
      description: 'Echo a value',
      manifest: {
        key: 'echo_tool',
        version: 'test:v1',
        riskClass: 'low',
        effectLevel: 'E1',
        requiredEvidence: ['tool_result'],
        permissionRequirements: ['tool:echo_tool:execute'],
        outputSensitivity: 'internal',
      },
      execute: async (input) => ({
        received: input,
        governance: { evidencePackId: '00000000-0000-4000-8000-000000000004' },
      }),
    });
    const broker = new ToolBroker(db as never);

    const result = await broker.execute(
      registry,
      'echo_tool',
      { value: 42 },
      {
        workspaceId: '00000000-0000-4000-8000-000000000001',
        taskId: '00000000-0000-4000-8000-000000000002',
        operatorId: '00000000-0000-4000-8000-000000000003',
        policyDecisionId: 'dec-1',
        policyVersion: 'founder-ops-v1',
        helmDocumentVersionPins: {
          founderOpsPolicy: 'founder-ops-v1',
          riskTaxonomy: 'risk-taxonomy-v1',
        },
        actionHash: 'sha256:action',
      },
    );

    expect(result).toMatchObject({
      actionId: 'action-1',
      toolExecutionId: 'tool-exec-1',
      status: 'completed',
      evidenceItemId: 'evidence-item-1',
    });
    expect(result.inputHash).toMatch(/^sha256:/u);
    expect(result.outputHash).toMatch(/^sha256:/u);
    expect(result.output).toMatchObject({
      received: {
        value: 42,
        workspaceId: '00000000-0000-4000-8000-000000000001',
        taskId: '00000000-0000-4000-8000-000000000002',
        operatorId: '00000000-0000-4000-8000-000000000003',
        policyDecisionId: 'dec-1',
      },
    });
    expect(insertedActions[0]).toMatchObject({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      actionKey: 'echo_tool',
      policyDecisionId: 'dec-1',
      policyVersion: 'founder-ops-v1',
      helmDocumentVersionPins: {
        founderOpsPolicy: 'founder-ops-v1',
        riskTaxonomy: 'risk-taxonomy-v1',
      },
      inputHash: result.inputHash,
      metadata: expect.objectContaining({
        policyPin: expect.objectContaining({
          documentVersionPins: {
            founderOpsPolicy: 'founder-ops-v1',
            riskTaxonomy: 'risk-taxonomy-v1',
          },
        }),
      }),
    });
    expect(insertedExecutions[0]).toMatchObject({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      actionId: 'action-1',
      toolKey: 'echo_tool',
      status: 'running',
      inputHash: result.inputHash,
      sanitizedInput: { value: 42 },
      policyDecisionId: 'dec-1',
      policyVersion: 'founder-ops-v1',
      helmDocumentVersionPins: {
        founderOpsPolicy: 'founder-ops-v1',
        riskTaxonomy: 'risk-taxonomy-v1',
      },
    });
    expect((insertedExecutions[0] as { idempotencyKey: string }).idempotencyKey).toContain(
      'tool-broker-v1:00000000-0000-4000-8000-000000000001',
    );
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: toolExecutions,
          value: expect.objectContaining({
            status: 'completed',
            outputHash: result.outputHash,
            evidenceIds: ['00000000-0000-4000-8000-000000000004', 'evidence-item-1'],
            completedAt: expect.any(Date),
          }),
        }),
        expect.objectContaining({
          table: actions,
          value: expect.objectContaining({
            status: 'completed',
            outputHash: result.outputHash,
            completedAt: expect.any(Date),
          }),
        }),
        expect.objectContaining({
          table: auditLog,
          value: expect.objectContaining({
            metadata: expect.objectContaining({
              evidenceItemId: 'evidence-item-1',
              evidenceIds: ['00000000-0000-4000-8000-000000000004', 'evidence-item-1'],
              toolExecutionId: 'tool-exec-1',
            }),
          }),
        }),
      ]),
    );
    const auditUpdate = updates.find((update) => update.table === auditLog);
    expect(queryChunkColumnNames(auditUpdate?.where)).toEqual(
      expect.arrayContaining(['workspace_id', 'id']),
    );
    expect(insertedAudit[0]).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
      workspaceId: '00000000-0000-4000-8000-000000000001',
      action: 'TOOL_EXECUTION',
      target: 'echo_tool',
      verdict: 'allow',
      metadata: expect.objectContaining({
        evidenceIds: ['00000000-0000-4000-8000-000000000004'],
        toolExecutionId: 'tool-exec-1',
      }),
    });
    expect(transactionInsertOrder.indexOf('audit_log')).toBeLessThan(
      transactionInsertOrder.indexOf('evidence_items'),
    );
    const auditEventId = (insertedAudit[0] as { id: string }).id;
    expect(insertedEvidenceItems[0]).toMatchObject({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      taskId: '00000000-0000-4000-8000-000000000002',
      actionId: 'action-1',
      toolExecutionId: 'tool-exec-1',
      auditEventId,
      evidenceType: 'tool_execution_completed',
      sourceType: 'tool_broker',
      redactionState: 'redacted',
      sensitivity: 'internal',
      contentHash: result.outputHash,
      replayRef: 'tool:tool-exec-1',
      metadata: expect.objectContaining({
        broker: 'tool_broker_v1',
        toolKey: 'echo_tool',
        actionId: 'action-1',
        toolExecutionId: 'tool-exec-1',
        status: 'completed',
        riskClass: 'low',
        effectLevel: 'E1',
        manifestVersion: 'test:v1',
        inputHash: result.inputHash,
        outputHash: result.outputHash,
        evidenceIds: ['00000000-0000-4000-8000-000000000004'],
        policyDecisionId: 'dec-1',
        policyVersion: 'founder-ops-v1',
        helmDocumentVersionPins: {
          founderOpsPolicy: 'founder-ops-v1',
          riskTaxonomy: 'risk-taxonomy-v1',
        },
        credentialBoundary: 'sanitized_input_output_only',
      }),
    });
  });

  it('records failed tool audit rows before linked evidence', async () => {
    const { db, insertedEvidenceItems, insertedAudit, transactionInsertOrder } = createBrokerDb();
    const registry = new ToolRegistry(db as never, undefined, { skipBuiltins: true });
    registry.register({
      name: 'failing_tool',
      description: 'Return a structured tool failure',
      manifest: {
        key: 'failing_tool',
        version: 'test:v1',
        riskClass: 'medium',
        effectLevel: 'E2',
        requiredEvidence: ['tool_result'],
        permissionRequirements: ['tool:failing_tool:execute'],
        outputSensitivity: 'sensitive',
      },
      execute: async () => ({ error: 'blocked by external service' }),
    });
    const broker = new ToolBroker(db as never);

    const result = await broker.execute(
      registry,
      'failing_tool',
      {},
      {
        workspaceId: '00000000-0000-4000-8000-000000000001',
        taskId: '00000000-0000-4000-8000-000000000002',
        policyDecisionId: 'dec-1',
        policyVersion: 'founder-ops-v1',
      },
    );

    expect(result).toMatchObject({
      status: 'failed',
      evidenceItemId: 'evidence-item-1',
    });
    expect(insertedEvidenceItems[0]).toMatchObject({
      evidenceType: 'tool_execution_failed',
      sourceType: 'tool_broker',
      sensitivity: 'sensitive',
      metadata: expect.objectContaining({
        toolKey: 'failing_tool',
        status: 'failed',
        riskClass: 'medium',
        policyDecisionId: 'dec-1',
        policyVersion: 'founder-ops-v1',
      }),
    });
    expect(insertedAudit[0]).toMatchObject({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
      verdict: 'error',
      reason: JSON.stringify({ error: 'blocked by external service' }),
    });
    expect(transactionInsertOrder.indexOf('audit_log')).toBeLessThan(
      transactionInsertOrder.indexOf('evidence_items'),
    );
    expect(insertedEvidenceItems[0]).toMatchObject({
      auditEventId: (insertedAudit[0] as { id: string }).id,
    });
  });

  it('pins a local policy version for low-risk brokered actions without HELM decisions', async () => {
    const { db, insertedActions, insertedExecutions, insertedEvidenceItems, insertedAudit } =
      createBrokerDb();
    const registry = new ToolRegistry(db as never, undefined, { skipBuiltins: true });
    registry.register({
      name: 'read_status',
      description: 'Read local status',
      manifest: {
        key: 'read_status',
        version: 'test:v2',
        riskClass: 'low',
        effectLevel: 'E1',
        requiredEvidence: ['tool_result'],
        permissionRequirements: ['tool:read_status:execute'],
        outputSensitivity: 'internal',
      },
      execute: async () => ({ ok: true }),
    });
    const broker = new ToolBroker(db as never);

    await broker.execute(
      registry,
      'read_status',
      {},
      {
        workspaceId: '00000000-0000-4000-8000-000000000001',
        taskId: '00000000-0000-4000-8000-000000000002',
      },
    );

    const expectedPolicyVersion = 'local:tool-broker:test:v2:E1';
    expect(insertedActions[0]).toMatchObject({
      policyDecisionId: null,
      policyVersion: expectedPolicyVersion,
      helmDocumentVersionPins: { toolAccessPolicy: expectedPolicyVersion },
      metadata: expect.objectContaining({
        policyPin: {
          policyDecisionId: null,
          policyVersion: expectedPolicyVersion,
          decisionRequired: false,
          documentVersionPins: { toolAccessPolicy: expectedPolicyVersion },
        },
      }),
    });
    expect(insertedExecutions[0]).toMatchObject({
      policyDecisionId: null,
      policyVersion: expectedPolicyVersion,
      helmDocumentVersionPins: { toolAccessPolicy: expectedPolicyVersion },
    });
    expect(insertedEvidenceItems[0]).toMatchObject({
      metadata: expect.objectContaining({
        policyVersion: expectedPolicyVersion,
        policyPin: expect.objectContaining({
          policyVersion: expectedPolicyVersion,
          decisionRequired: false,
        }),
      }),
    });
    expect(insertedAudit[0]).toMatchObject({
      metadata: expect.objectContaining({
        policyVersion: expectedPolicyVersion,
        policyPin: expect.objectContaining({
          policyVersion: expectedPolicyVersion,
          documentVersionPins: { toolAccessPolicy: expectedPolicyVersion },
        }),
      }),
    });
  });

  it('does not mark low-risk tool completion when evidence persistence fails', async () => {
    const {
      db,
      insertedActions,
      insertedExecutions,
      insertedEvidenceItems,
      insertedAudit,
      updates,
    } = createBrokerDb({ failEvidenceInsert: true });
    const registry = new ToolRegistry(db as never, undefined, { skipBuiltins: true });
    const execute = vi.fn(async () => ({ ok: true }));
    registry.register({
      name: 'read_status',
      description: 'Read local status',
      manifest: {
        key: 'read_status',
        version: 'test:v2',
        riskClass: 'low',
        effectLevel: 'E1',
        requiredEvidence: ['tool_result'],
        permissionRequirements: ['tool:read_status:execute'],
        outputSensitivity: 'internal',
      },
      execute,
    });
    const broker = new ToolBroker(db as never);

    await expect(
      broker.execute(
        registry,
        'read_status',
        {},
        {
          workspaceId: '00000000-0000-4000-8000-000000000001',
          taskId: '00000000-0000-4000-8000-000000000002',
        },
      ),
    ).rejects.toThrow('Tool Broker blocked read_status completion: evidence sink unavailable');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(insertedActions).toHaveLength(1);
    expect(insertedExecutions).toHaveLength(1);
    expect(insertedEvidenceItems).toEqual([]);
    expect(insertedAudit).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('fails closed before tool execution when action persistence fails', async () => {
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({ returning: vi.fn(async () => []) })),
      })),
      update: vi.fn(),
    };
    const registry = new ToolRegistry(db as never, undefined, { skipBuiltins: true });
    const execute = vi.fn(async () => ({ ok: true }));
    registry.register({
      name: 'side_effect_tool',
      description: 'Should not execute without ledger persistence',
      execute,
    });
    const broker = new ToolBroker(db as never);

    await expect(
      broker.execute(
        registry,
        'side_effect_tool',
        {},
        {
          workspaceId: '00000000-0000-4000-8000-000000000001',
          taskId: '00000000-0000-4000-8000-000000000002',
        },
      ),
    ).rejects.toThrow('Tool Broker could not persist action');
    expect(execute).not.toHaveBeenCalled();
  });

  it('fails elevated tool completion closed when evidence persistence fails', async () => {
    const { db, insertedAudit, insertedEvidenceItems, updates } = createBrokerDb({
      failEvidenceInsert: true,
    });
    const registry = new ToolRegistry(db as never, undefined, { skipBuiltins: true });
    const execute = vi.fn(async () => ({ ok: true }));
    registry.register({
      name: 'operator.browser_read',
      description: 'Read from a governed browser session',
      manifest: {
        key: 'operator.browser_read',
        version: 'test:v1',
        riskClass: 'medium',
        effectLevel: 'E2',
        requiredEvidence: ['browser_observation', 'helm_receipt'],
        permissionRequirements: ['tool:operator.browser_read:execute'],
        outputSensitivity: 'sensitive',
      },
      execute,
    });
    const broker = new ToolBroker(db as never);

    await expect(
      broker.execute(
        registry,
        'operator.browser_read',
        {},
        {
          workspaceId: '00000000-0000-4000-8000-000000000001',
          taskId: '00000000-0000-4000-8000-000000000002',
          policyDecisionId: 'dec-1',
          policyVersion: 'founder-ops-v1',
        },
      ),
    ).rejects.toThrow('Tool Broker blocked elevated operator.browser_read completion');

    expect(execute).toHaveBeenCalledTimes(1);
    expect(insertedEvidenceItems).toEqual([]);
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: toolExecutions,
          value: expect.objectContaining({
            status: 'failed',
            error: expect.stringContaining('evidence persistence failed'),
          }),
        }),
        expect.objectContaining({
          table: actions,
          value: expect.objectContaining({
            status: 'failed',
          }),
        }),
      ]),
    );
    expect(updates).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: toolExecutions,
          value: expect.objectContaining({ status: 'completed' }),
        }),
      ]),
    );
    expect(insertedAudit[0]).toMatchObject({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      action: 'TOOL_EXECUTION',
      target: 'operator.browser_read',
      verdict: 'error',
      reason: expect.stringContaining('evidence persistence failed'),
      metadata: expect.objectContaining({
        riskClass: 'medium',
        effectLevel: 'E2',
        evidenceRequired: true,
        evidencePersistenceRequired: 'fail_closed_for_elevated_actions',
        policyDecisionId: 'dec-1',
        policyVersion: 'founder-ops-v1',
      }),
    });
  });

  it('does not commit elevated failure state when fallback audit persistence fails', async () => {
    const { db, insertedAudit, insertedEvidenceItems, updates } = createBrokerDb({
      failEvidenceInsert: true,
      failFallbackAuditInsert: true,
    });
    const registry = new ToolRegistry(db as never, undefined, { skipBuiltins: true });
    const execute = vi.fn(async () => ({ ok: true }));
    registry.register({
      name: 'operator.browser_read',
      description: 'Read from a governed browser session',
      manifest: {
        key: 'operator.browser_read',
        version: 'test:v1',
        riskClass: 'medium',
        effectLevel: 'E2',
        requiredEvidence: ['browser_observation', 'helm_receipt'],
        permissionRequirements: ['tool:operator.browser_read:execute'],
        outputSensitivity: 'sensitive',
      },
      execute,
    });
    const broker = new ToolBroker(db as never);

    await expect(
      broker.execute(
        registry,
        'operator.browser_read',
        {},
        {
          workspaceId: '00000000-0000-4000-8000-000000000001',
          taskId: '00000000-0000-4000-8000-000000000002',
          policyDecisionId: 'dec-1',
          policyVersion: 'founder-ops-v1',
        },
      ),
    ).rejects.toThrow(
      'Tool Broker could not persist elevated operator.browser_read evidence-failure audit',
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(insertedEvidenceItems).toEqual([]);
    expect(insertedAudit).toEqual([]);
    expect(updates).toEqual([]);
  });

  it('fails closed before elevated tool execution without HELM policy metadata', async () => {
    const { db } = createBrokerDb();
    const registry = new ToolRegistry(db as never, undefined, { skipBuiltins: true });
    const execute = vi.fn(async () => ({ ok: true }));
    registry.register({
      name: 'medium_tool',
      description: 'Requires a HELM decision before execution',
      manifest: {
        key: 'medium_tool',
        version: 'test:v1',
        riskClass: 'medium',
        effectLevel: 'E2',
        requiredEvidence: ['tool_result', 'helm_receipt'],
        permissionRequirements: ['tool:medium_tool:execute'],
        outputSensitivity: 'internal',
      },
      execute,
    });
    const broker = new ToolBroker(db as never);

    await expect(
      broker.execute(
        registry,
        'medium_tool',
        {},
        {
          workspaceId: '00000000-0000-4000-8000-000000000001',
          taskId: '00000000-0000-4000-8000-000000000002',
        },
      ),
    ).rejects.toThrow('HELM policy decision metadata is required');

    expect(execute).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('fails closed when elevated tool policy metadata is incomplete', async () => {
    const { db } = createBrokerDb();
    const registry = new ToolRegistry(db as never, undefined, { skipBuiltins: true });
    const execute = vi.fn(async () => ({ ok: true }));
    registry.register({
      name: 'high_tool',
      description: 'Requires complete HELM decision metadata before execution',
      manifest: {
        key: 'high_tool',
        version: 'test:v1',
        riskClass: 'high',
        effectLevel: 'E3',
        requiredEvidence: ['tool_result', 'helm_receipt'],
        permissionRequirements: ['tool:high_tool:execute'],
        outputSensitivity: 'sensitive',
      },
      execute,
    });
    const broker = new ToolBroker(db as never);

    await expect(
      broker.execute(
        registry,
        'high_tool',
        {},
        {
          workspaceId: '00000000-0000-4000-8000-000000000001',
          taskId: '00000000-0000-4000-8000-000000000002',
          policyDecisionId: 'dec-1',
        },
      ),
    ).rejects.toThrow('HELM policy decision metadata is required');

    expect(execute).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
});
