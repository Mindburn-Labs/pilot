import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLoop, computeActionHash } from '../agent-loop.js';

vi.mock('@pilot/db/schema', () => ({
  taskRuns: 'taskRuns',
  approvals: {
    workspaceId: 'approvals.workspaceId',
    taskId: 'approvals.taskId',
    status: 'approvals.status',
    actionHash: 'approvals.actionHash',
  },
  operatorMemory: 'operatorMemory',
  evidencePacks: 'evidencePacks',
  actions: 'actions',
  toolExecutions: 'toolExecutions',
  auditLog: 'auditLog',
}));

vi.mock('@pilot/shared/schemas', () => ({
  MAX_ITERATION_BUDGET: 200,
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ left, right })),
}));

const mockDb = {
  insert: vi.fn(() => ({
    values: vi.fn(() => ({
      returning: vi.fn(async () => [{ id: 'row-1' }]),
      then: (r: any) => r([]),
      catch: vi.fn(),
    })),
  })),
  update: vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn(async () => []),
    })),
  })),
  transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(mockDb)),
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => ({
          then: (r: any) => r([]),
        })),
        then: (r: any) => r([]),
      })),
      then: (r: any) => r([]),
    })),
  })),
} as any;

const mockTrust = {
  evaluate: vi.fn(() => ({ verdict: 'allow' })),
  policyFingerprint: vi.fn(() => 'local:policy-v1'),
} as any;

const mockLlm = {
  complete: vi.fn(async () => '{"tool":"finish","input":{"summary":"done"}}'),
} as any;

const mockTools = {
  execute: vi.fn(async () => ({ result: 'ok' })),
  listTools: vi.fn(() => [{ name: 'search', description: 'Search' }]),
  listToolsForMode: vi.fn(() => [{ name: 'search', description: 'Search' }]),
} as any;

function baseParams() {
  return {
    taskId: 'task-1',
    workspaceId: 'ws-1',
    context: 'Test task',
    iterationBudget: 50,
  };
}

describe('AgentLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTrust.evaluate.mockReturnValue({ verdict: 'allow' });
    mockTrust.policyFingerprint.mockReturnValue('local:policy-v1');
  });

  it('execute() returns completed with 0 iterations when no LLM is set', async () => {
    const loop = new AgentLoop(mockDb, mockTrust);
    // Do NOT call setLlm

    const result = await loop.execute(baseParams());

    expect(result.status).toBe('completed');
    expect(result.iterationsUsed).toBe(0);
    expect(result.actions).toEqual([]);
    expect(result.error).toBe('No LLM configured');
  });

  it('execute() runs loop until finish tool is called', async () => {
    const loop = new AgentLoop(mockDb, mockTrust);
    loop.setLlm(mockLlm);
    loop.setTools(mockTools);

    mockLlm.complete.mockResolvedValueOnce('{"tool":"finish","input":{"summary":"done"}}');
    mockTrust.evaluate.mockReturnValue({ verdict: 'allow' });

    const result = await loop.execute(baseParams());

    expect(result.status).toBe('completed');
    expect(result.iterationsUsed).toBe(1);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.tool).toBe('finish');
    expect(result.actions[0]!.verdict).toBe('allow');
  });

  it('execute() respects iteration budget and returns budget_exhausted', async () => {
    const loop = new AgentLoop(mockDb, mockTrust);
    loop.setLlm(mockLlm);
    loop.setTools(mockTools);

    // LLM always returns a non-finish tool
    mockLlm.complete.mockResolvedValue('{"tool":"search","input":{}}');
    mockTrust.evaluate.mockReturnValue({ verdict: 'allow' });

    const result = await loop.execute({ ...baseParams(), iterationBudget: 3 });

    expect(result.status).toBe('budget_exhausted');
    expect(result.iterationsUsed).toBe(3);
    expect(result.actions).toHaveLength(3);
    expect(mockLlm.complete).toHaveBeenCalledTimes(3);
  });

  it('fails closed when required long-run checkpoint persistence fails', async () => {
    let updateCount = 0;
    const db = {
      ...mockDb,
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: 'task-run-1' }]),
        })),
      })),
      update: vi.fn(() => {
        updateCount++;
        if (updateCount === 1) {
          throw new Error('checkpoint store unavailable');
        }
        return {
          set: vi.fn(() => ({
            where: vi.fn(async () => []),
          })),
        };
      }),
    } as any;
    const llm = {
      complete: vi.fn(async () => '{"tool":"search","input":{}}'),
    } as any;
    const loop = new AgentLoop(db, mockTrust);
    loop.setLlm(llm);
    loop.setTools(mockTools);
    mockTrust.evaluate.mockReturnValue({ verdict: 'allow' });

    await expect(loop.execute({ ...baseParams(), iterationBudget: 10 })).rejects.toThrow(
      'Checkpoint persistence failed for task run task-run-1: checkpoint store unavailable',
    );
    expect(llm.complete).toHaveBeenCalledTimes(10);
    expect(mockTools.execute).toHaveBeenCalledTimes(10);
  });

  it('execute() stops on trust deny and returns blocked', async () => {
    const loop = new AgentLoop(mockDb, mockTrust);
    loop.setLlm(mockLlm);
    loop.setTools(mockTools);

    mockLlm.complete.mockResolvedValueOnce('{"tool":"dangerous_action","input":{}}');
    mockTrust.evaluate.mockReturnValue({ verdict: 'deny', reason: 'blocked by policy' });

    const result = await loop.execute(baseParams());

    expect(result.status).toBe('blocked');
    expect(result.error).toBe('blocked by policy');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.verdict).toBe('deny');
  });

  it('execute() pauses on require_approval and creates approval record', async () => {
    const loop = new AgentLoop(mockDb, mockTrust);
    loop.setLlm(mockLlm);
    loop.setTools(mockTools);

    mockLlm.complete.mockResolvedValueOnce('{"tool":"deploy_production","input":{}}');
    mockTrust.evaluate.mockReturnValue({ verdict: 'require_approval', reason: 'needs human' });

    const result = await loop.execute(baseParams());

    expect(result.status).toBe('awaiting_approval');
    expect(result.error).toBe('needs human');
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]!.verdict).toBe('require_approval');
    // Approval record inserted (one persistAction + one createApprovalRecord = 2 insert calls
    // plus the saveOperatorMemory call may or may not fire depending on operatorId)
    expect(mockDb.insert).toHaveBeenCalled();
  });

  it('fails closed when action task_run persistence fails', async () => {
    const db = {
      ...mockDb,
      insert: vi.fn((table: unknown) => {
        if (table === 'taskRuns') {
          return {
            values: vi.fn(() => ({
              returning: vi.fn(async () => {
                throw new Error('task_run persistence unavailable');
              }),
            })),
          };
        }
        return mockDb.insert(table);
      }),
    } as any;
    const loop = new AgentLoop(db, mockTrust);
    loop.setLlm(mockLlm);
    loop.setTools(mockTools);

    mockLlm.complete.mockResolvedValueOnce('{"tool":"dangerous_action","input":{}}');
    mockTrust.evaluate.mockReturnValue({ verdict: 'deny', reason: 'blocked by policy' });

    await expect(loop.execute(baseParams())).rejects.toThrow('task_run persistence unavailable');
    expect(mockTools.execute).not.toHaveBeenCalled();
  });

  it('fails closed when approval record persistence fails', async () => {
    const db = {
      ...mockDb,
      insert: vi.fn((table: unknown) => {
        if (table === 'taskRuns') {
          return {
            values: vi.fn(() => ({
              returning: vi.fn(async () => [{ id: 'task-run-1' }]),
            })),
          };
        }
        return {
          values: vi.fn(() => ({
            returning: vi.fn(async () => {
              throw new Error('approval persistence unavailable');
            }),
          })),
        };
      }),
    } as any;
    const loop = new AgentLoop(db, mockTrust);
    loop.setLlm(mockLlm);
    loop.setTools(mockTools);

    mockLlm.complete.mockResolvedValueOnce('{"tool":"deploy_production","input":{}}');
    mockTrust.evaluate.mockReturnValue({ verdict: 'require_approval', reason: 'needs human' });

    await expect(loop.execute(baseParams())).rejects.toThrow('approval persistence unavailable');
    expect(mockTools.execute).not.toHaveBeenCalled();
  });

  it('pre-persists a parent task_run anchor before executing a subagent tool', async () => {
    const rows: unknown[] = [];
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn((row: unknown) => {
          rows.push(row);
          return {
            returning: vi.fn(async () => [{ id: 'parent-run-1' }]),
          };
        }),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(async () => []),
        })),
      })),
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => []),
          })),
        })),
      })),
    } as any;
    const llm = {
      complete: vi
        .fn()
        .mockResolvedValueOnce('{"tool":"subagent.spawn","input":{"name":"scout","task":"scan"}}')
        .mockResolvedValueOnce('{"tool":"finish","input":{"summary":"done"}}'),
    } as any;
    const tools = {
      execute: vi.fn(async (tool: string, _input: unknown, context: unknown) => {
        if (tool === 'subagent.spawn') {
          expect(context).toEqual(expect.objectContaining({ parentTaskRunId: 'parent-run-1' }));
        }
        return { name: 'scout', verdict: 'completed' };
      }),
      listTools: vi.fn(() => [{ name: 'subagent.spawn', description: 'Spawn' }]),
      listToolsForMode: vi.fn(() => [{ name: 'subagent.spawn', description: 'Spawn' }]),
    } as any;
    const helmClient = {
      evaluate: vi.fn(async () => ({
        receipt: {
          decisionId: 'dec-subagent-1',
          verdict: 'ALLOW',
          policyVersion: 'founder-ops-v1',
          receivedAt: new Date(),
          action: 'TOOL_USE',
          resource: 'subagent.spawn',
          principal: 'workspace:ws-1/operator:agent',
        },
      })),
    } as any;
    const loop = new AgentLoop(db, mockTrust, helmClient);
    loop.setLlm(llm);
    loop.setTools(tools);

    const result = await loop.execute(baseParams());

    expect(result.status).toBe('completed');
    expect(helmClient.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TOOL_USE',
        resource: 'subagent.spawn',
        effectLevel: 'E3',
      }),
    );
    expect(rows[0]).toEqual(expect.objectContaining({ actionTool: 'subagent.spawn' }));
    expect(db.update).toHaveBeenCalledWith('taskRuns');
  });

  it('blocks elevated tool execution when no HELM client is configured', async () => {
    const loop = new AgentLoop(mockDb, mockTrust);
    const llm = {
      complete: vi
        .fn()
        .mockResolvedValueOnce('{"tool":"subagent.spawn","input":{"name":"scout","task":"scan"}}'),
    } as any;
    const tools = {
      execute: vi.fn(async () => ({ name: 'scout', verdict: 'completed' })),
      listTools: vi.fn(() => [{ name: 'subagent.spawn', description: 'Spawn' }]),
      listToolsForMode: vi.fn(() => [{ name: 'subagent.spawn', description: 'Spawn' }]),
    } as any;
    loop.setLlm(llm);
    loop.setTools(tools);

    const result = await loop.execute(baseParams());

    expect(result.status).toBe('blocked');
    expect(result.error).toBe('HELM governance client is required for elevated tool execution');
    expect(tools.execute).not.toHaveBeenCalled();
  });

  it('execute() saves operator memory after run when operatorId is provided', async () => {
    const loop = new AgentLoop(mockDb, mockTrust);
    loop.setLlm(mockLlm);
    loop.setTools(mockTools);

    mockLlm.complete.mockResolvedValueOnce('{"tool":"finish","input":{"summary":"done"}}');
    mockTrust.evaluate.mockReturnValue({ verdict: 'allow' });

    await loop.execute({ ...baseParams(), operatorId: 'op-1' });

    // Broker/action rows and task_runs are also inserted; assert the memory
    // write itself rather than an exact global insert count.
    expect(mockDb.insert).toHaveBeenCalledWith('operatorMemory');
  });

  it('resume() returns completed without LLM', async () => {
    const loop = new AgentLoop(mockDb, mockTrust);
    // Do NOT call setLlm

    const result = await loop.resume({
      ...baseParams(),
      priorActions: [
        { tool: 'search', input: {}, output: { result: 'ok' }, verdict: 'allow', iteration: 1 },
      ],
    });

    expect(result.status).toBe('completed');
    expect(result.iterationsUsed).toBe(0);
    expect(result.error).toBe('No LLM configured');
  });

  it('resume() blocks a paused action without a matching approved action receipt', async () => {
    const loop = new AgentLoop(mockDb, mockTrust);
    loop.setLlm(mockLlm);
    loop.setTools(mockTools);

    const result = await loop.resume({
      ...baseParams(),
      priorActions: [
        {
          tool: 'search',
          input: { workspaceId: 'ws-1' },
          output: null,
          verdict: 'require_approval',
          iteration: 1,
        },
      ],
    });

    expect(result.status).toBe('blocked');
    expect(result.error).toBe(
      'No approved action receipt matched this task, workspace, and action hash',
    );
    expect(mockTools.execute).not.toHaveBeenCalled();
  });

  it('resume() blocks an approved action when the local policy fingerprint changed', async () => {
    const action = {
      tool: 'search',
      input: { workspaceId: 'ws-1', query: 'pricing' },
      output: null,
      verdict: 'require_approval',
      iteration: 1,
    };
    const actionHash = computeActionHash(action);
    const db = {
      ...mockDb,
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [
              {
                id: 'approval-1',
                action: 'search',
                actionHash,
                policyVersion: 'local:policy-v0',
                expiresAt: new Date(Date.now() + 60_000),
              },
            ]),
          })),
        })),
      })),
    } as any;
    mockTrust.policyFingerprint.mockReturnValue('local:policy-v1');
    const loop = new AgentLoop(db, mockTrust);
    loop.setLlm(mockLlm);
    loop.setTools(mockTools);

    const result = await loop.resume({
      ...baseParams(),
      priorActions: [{ ...action, actionHash }],
    });

    expect(result.status).toBe('blocked');
    expect(result.error).toBe('Local policy changed after approval was granted');
    expect(mockTools.execute).not.toHaveBeenCalled();
  });
});
