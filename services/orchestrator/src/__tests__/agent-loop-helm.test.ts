import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLoop } from '../agent-loop.js';

// Include evidencePacks in the mocked schema so the governance-mirroring path
// has a handle to import.
vi.mock('@pilot/db/schema', () => ({
  taskRuns: 'taskRuns',
  approvals: 'approvals',
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

interface InsertCall {
  table: string;
  values: Record<string, unknown>;
}

function makeMockDb() {
  const inserts: InsertCall[] = [];
  const db = {
    insert: vi.fn((table: string) => ({
      values: vi.fn((row: Record<string, unknown>) => {
        inserts.push({ table, values: row });
        return {
          returning: vi.fn(() => Promise.resolve([{ id: `row-${inserts.length}` }])),
          then: (resolve: (v: unknown[]) => void) => resolve([]),
          catch: vi.fn(),
        };
      }),
    })),
    update: vi.fn((table: string) => ({
      set: vi.fn((row: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          inserts.push({ table: `${table}:update`, values: row });
          return [];
        }),
      })),
    })),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
  } as unknown as {
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
  };
  return { db, inserts };
}

function makeMirrorFailureDb() {
  const inserts: InsertCall[] = [];
  const committedMirrorInserts: InsertCall[] = [];
  let autoId = 0;

  const makeInsert = (sink: InsertCall[], failAfterEvidencePack = false) => {
    let sawEvidencePack = false;
    return vi.fn((table: string) => ({
      values: vi.fn((row: Record<string, unknown>) => {
        if (failAfterEvidencePack && sawEvidencePack && table !== 'evidencePacks') {
          throw new Error('evidence item insert failed');
        }
        if (table === 'evidencePacks') sawEvidencePack = true;
        sink.push({ table, values: row });
        return {
          returning: vi.fn(() => Promise.resolve([{ id: `row-${++autoId}` }])),
          then: (resolve: (v: unknown[]) => void) => resolve([]),
          catch: vi.fn(),
        };
      }),
    }));
  };

  const db = {
    insert: makeInsert(inserts),
    update: vi.fn((table: string) => ({
      set: vi.fn((row: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          inserts.push({ table: `${table}:update`, values: row });
          return [];
        }),
      })),
    })),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const stagedMirrorInserts: InsertCall[] = [];
      const result = await callback({
        insert: makeInsert(stagedMirrorInserts, true),
        update: vi.fn((table: string) => ({
          set: vi.fn((row: Record<string, unknown>) => ({
            where: vi.fn(async () => {
              stagedMirrorInserts.push({ table: `${table}:update`, values: row });
              return [];
            }),
          })),
        })),
      });
      committedMirrorInserts.push(...stagedMirrorInserts);
      return result;
    }),
  } as unknown as {
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    transaction: ReturnType<typeof vi.fn>;
  };

  return { db, inserts, committedMirrorInserts };
}

const mockTrust = {
  evaluate: vi.fn(() => ({ verdict: 'allow' })),
} as any;

const mockTools = {
  execute: vi.fn(async () => ({ result: 'ok' })),
  listTools: vi.fn(() => [{ name: 'search', description: 'Search' }]),
  listToolsForMode: vi.fn(() => [{ name: 'search', description: 'Search' }]),
} as any;

function governedLlm(
  options: { verdict?: 'ALLOW' | 'DENY' | 'ESCALATE'; decisionId?: string } = {},
) {
  const governance = {
    decisionId: options.decisionId ?? 'dec-governed-1',
    verdict: options.verdict ?? 'ALLOW',
    policyVersion: 'founder-ops-v1',
    decisionHash: 'sha256:abc',
    principal: 'workspace:ws-1/operator:engineering',
  };
  return {
    complete: vi.fn(),
    completeWithUsage: vi.fn().mockResolvedValueOnce({
      content: '{"tool":"finish","input":{"summary":"done"}}',
      usage: { tokensIn: 10, tokensOut: 5, model: 'anthropic/claude-sonnet-4' },
      governance,
    }),
  };
}

function baseParams() {
  return {
    taskId: 'task-1',
    workspaceId: 'ws-1',
    context: 'Test task',
    iterationBudget: 50,
  };
}

describe('AgentLoop — HELM governance persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTrust.evaluate.mockReturnValue({ verdict: 'allow' });
  });

  it('persists the HELM decision id + policy version onto the task_runs row', async () => {
    const { db, inserts } = makeMockDb();
    const loop = new AgentLoop(db as never, mockTrust);
    loop.setLlm(governedLlm() as never);
    loop.setTools(mockTools);

    await loop.execute(baseParams());

    const taskRunInserts = inserts.filter((i) => i.table === 'taskRuns');
    expect(taskRunInserts.length).toBeGreaterThanOrEqual(1);
    const first = taskRunInserts[0]!.values;
    expect(first.helmDecisionId).toBe('dec-governed-1');
    expect(first.helmPolicyVersion).toBe('founder-ops-v1');
  });

  it('mirrors the receipt into evidence_packs scoped to the workspace', async () => {
    const { db, inserts } = makeMockDb();
    const loop = new AgentLoop(db as never, mockTrust);
    loop.setLlm(governedLlm() as never);
    loop.setTools(mockTools);

    await loop.execute(baseParams());

    const evidenceInserts = inserts.filter((i) => i.table === 'evidencePacks');
    expect(evidenceInserts).toHaveLength(1);
    const row = evidenceInserts[0]!.values;
    expect(row.workspaceId).toBe('ws-1');
    expect(row.decisionId).toBe('dec-governed-1');
    expect(row.verdict).toBe('ALLOW');
    expect(row.policyVersion).toBe('founder-ops-v1');
    expect(row.principal).toBe('workspace:ws-1/operator:engineering');
    expect(row.action).toBe('LLM_INFERENCE');
  });

  it('fails closed and does not commit mirrored receipt pack when receipt evidence item persistence fails', async () => {
    const { db, committedMirrorInserts } = makeMirrorFailureDb();
    const loop = new AgentLoop(db as never, mockTrust);
    loop.setLlm(governedLlm() as never);
    loop.setTools(mockTools);

    await expect(loop.execute(baseParams())).rejects.toThrow('evidence item insert failed');

    expect(committedMirrorInserts.some((insert) => insert.table === 'evidencePacks')).toBe(false);
  });

  it('does NOT emit evidence_packs rows when the LLM call had no governance', async () => {
    const { db, inserts } = makeMockDb();
    const loop = new AgentLoop(db as never, mockTrust);

    // Non-HELM LLM — only supports the old completeWithUsage without governance
    const plainLlm = {
      complete: vi.fn(),
      completeWithUsage: vi.fn().mockResolvedValue({
        content: '{"tool":"finish","input":{"summary":"done"}}',
        usage: { tokensIn: 10, tokensOut: 5, model: 'gpt-4o-mini' },
        // no governance field
      }),
    } as any;
    loop.setLlm(plainLlm);
    loop.setTools(mockTools);

    await loop.execute(baseParams());

    const evidenceInserts = inserts.filter((i) => i.table === 'evidencePacks');
    expect(evidenceInserts).toHaveLength(0);
    const taskRun = inserts.find((i) => i.table === 'taskRuns');
    expect(taskRun!.values.helmDecisionId).toBeNull();
  });

  it('evaluates non-finish tool execution through HELM and persists TOOL_USE evidence', async () => {
    const { db, inserts } = makeMockDb();
    const helmClient = {
      evaluate: vi.fn(async () => ({
        receipt: {
          decisionId: 'dec-tool-1',
          receiptId: 'rcpt-tool-1',
          verdict: 'ALLOW',
          policyVersion: 'founder-ops-v1',
          decisionHash: 'sha256:tool',
          receivedAt: new Date(),
          action: 'TOOL_USE',
          resource: 'search',
          principal: 'workspace:ws-1/operator:agent',
        },
      })),
    };
    const loop = new AgentLoop(db as never, mockTrust, helmClient as never);
    loop.setLlm({
      complete: vi.fn(),
      completeWithUsage: vi.fn().mockResolvedValueOnce({
        content: '{"tool":"search","input":{"query":"pricing"}}',
        usage: { tokensIn: 10, tokensOut: 5, model: 'anthropic/claude-sonnet-4' },
        governance: {
          decisionId: 'dec-llm-1',
          verdict: 'ALLOW',
          policyVersion: 'founder-ops-v1',
          principal: 'workspace:ws-1/operator:engineering',
        },
      }),
    } as never);
    loop.setTools(mockTools);

    await loop.execute({ ...baseParams(), iterationBudget: 1 });

    expect(helmClient.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TOOL_USE',
        resource: 'search',
        sessionId: 'task-1',
      }),
    );
    const evidence = inserts.find((i) => i.table === 'evidencePacks');
    expect(evidence?.values).toMatchObject({
      decisionId: 'dec-tool-1',
      action: 'TOOL_USE',
      resource: 'search',
    });
    expect(inserts.find((i) => i.table === 'actions')?.values).toMatchObject({
      workspaceId: 'ws-1',
      taskId: 'task-1',
      actionKey: 'search',
      policyDecisionId: 'dec-tool-1',
      policyVersion: 'founder-ops-v1',
    });
    expect(inserts.find((i) => i.table === 'toolExecutions')?.values).toMatchObject({
      workspaceId: 'ws-1',
      taskRunId: null,
      toolKey: 'search',
      policyDecisionId: 'dec-tool-1',
      policyVersion: 'founder-ops-v1',
    });
  });

  it('classifies operator.computer_use as E3 before Tool Broker execution', async () => {
    const { db, inserts } = makeMockDb();
    const helmClient = {
      evaluate: vi.fn(async () => ({
        receipt: {
          decisionId: 'dec-computer-tool',
          receiptId: 'rcpt-computer-tool',
          verdict: 'ALLOW',
          policyVersion: 'founder-ops-v1',
          decisionHash: 'sha256:computer-tool',
          receivedAt: new Date(),
          action: 'TOOL_USE',
          resource: 'operator.computer_use',
          principal: 'workspace:ws-1/operator:agent',
        },
      })),
    };
    const loop = new AgentLoop(db as never, mockTrust, helmClient as never);
    loop.setLlm({
      complete: vi.fn(),
      completeWithUsage: vi.fn().mockResolvedValueOnce({
        content:
          '{"tool":"operator.computer_use","input":{"operation":"terminal_command","objective":"Check repo","command":"pwd"}}',
        usage: { tokensIn: 10, tokensOut: 5, model: 'anthropic/claude-sonnet-4' },
      }),
    } as never);
    loop.setTools(mockTools);

    await loop.execute({ ...baseParams(), iterationBudget: 1 });

    expect(helmClient.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TOOL_USE',
        resource: 'operator.computer_use',
        effectLevel: 'E3',
      }),
    );
    expect(inserts.find((i) => i.table === 'actions')?.values).toMatchObject({
      actionKey: 'operator.computer_use',
      riskClass: 'high',
    });
  });
});
