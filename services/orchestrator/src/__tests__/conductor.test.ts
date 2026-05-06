import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { Conductor, type ParentContext } from '../conductor.js';
import { ToolRegistry } from '../tools.js';
import type { PolicyConfig } from '@pilot/shared/schemas';
import type { LlmProvider } from '@pilot/shared/llm';
import {
  SubagentRegistry,
  loadDefinitionFile,
  type SubagentDefinition,
} from '@pilot/shared/subagents';
import { SkillRegistry, type SkillDefinition } from '@pilot/shared/skills';

vi.mock('@pilot/db/schema', () => ({
  taskRuns: 'taskRuns',
  evidencePacks: 'evidencePacks',
  agentHandoffs: 'agentHandoffs',
  approvals: 'approvals',
  operatorMemory: 'operatorMemory',
  actions: 'actions',
  toolExecutions: 'toolExecutions',
  evidenceItems: 'evidenceItems',
  auditLog: 'auditLog',
}));

vi.mock('@pilot/shared/schemas', async () => {
  const actual =
    await vi.importActual<typeof import('@pilot/shared/schemas')>('@pilot/shared/schemas');
  return { ...actual, MAX_ITERATION_BUDGET: 200 };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val, op: 'eq' }),
  and: (...args: unknown[]) => ({ args, op: 'and' }),
  desc: (col: unknown) => ({ col, op: 'desc' }),
}));

function makeDef(overrides: Partial<SubagentDefinition> = {}): SubagentDefinition {
  return {
    name: 'scout_x',
    description: 'Scout X',
    version: '1.0.0',
    operatorRole: 'growth',
    maxRiskClass: 'R1',
    budgetWeight: 1,
    execution: 'AUTONOMOUS',
    toolScope: { allowedTools: ['search_knowledge'] },
    skills: [],
    mcpServers: [],
    iterationBudget: 20,
    systemPrompt: 'You are scout X.',
    sourcePath: '/tmp/scout_x.md',
    ...overrides,
  };
}

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: 'test-skill',
    description: 'Test skill',
    version: '1.0.0',
    tools: ['search_knowledge'],
    riskProfile: 'R1',
    permissionRequirements: ['knowledge.read'],
    evalStatus: 'not_evaluated',
    activation: 'auto',
    body: 'Use the test skill.',
    sourcePath: '/tmp/test-skill/SKILL.md',
    ...overrides,
  };
}

function makeMockDb(options: { failInsertTable?: unknown; failUpdateTable?: unknown } = {}) {
  let autoId = 0;
  const db = {
    insert: vi.fn((table: unknown) => {
      if (table === options.failInsertTable) {
        throw new Error(`insert failed for ${String(table)}`);
      }
      return {
        values: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: `row_${++autoId}` }]),
        })),
      };
    }),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => []),
          })),
          limit: vi.fn(async () => []),
        })),
      })),
    })),
    update: vi.fn((table: unknown) => {
      if (table === options.failUpdateTable) {
        throw new Error(`update failed for ${String(table)}`);
      }
      return {
        set: vi.fn(() => ({
          where: vi.fn(async () => []),
        })),
      };
    }),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
  } as any;

  return db;
}

function makeTransactionalSpawnDb(options: { failEvidenceInsert?: boolean } = {}) {
  let autoId = 0;
  const committedInserts: Array<{ table: unknown; row: Record<string, unknown> }> = [];

  const makeFacade = (sink: Array<{ table: unknown; row: Record<string, unknown> }>) => ({
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((row: Record<string, unknown>) => {
        if (table !== 'evidencePacks' && options.failEvidenceInsert) {
          throw new Error('evidence item insert failed');
        }
        sink.push({ table, row });
        return {
          returning: vi.fn(async () => [{ id: `row_${++autoId}` }]),
        };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn(async () => []),
          })),
          limit: vi.fn(async () => []),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(async () => []),
      })),
    })),
  });

  const db = {
    ...makeFacade(committedInserts),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const stagedInserts: Array<{ table: unknown; row: Record<string, unknown> }> = [];
      const result = await callback(makeFacade(stagedInserts));
      committedInserts.push(...stagedInserts);
      return result;
    }),
  } as any;

  return { db, committedInserts };
}

function makePolicy(): PolicyConfig {
  return {
    killSwitch: false,
    budget: {
      dailyTotalMax: 500,
      perTaskMax: 100,
      perOperatorMax: 200,
      emergencyKill: 1000,
      currency: 'EUR',
    },
    toolBlocklist: [],
    contentBans: [],
    connectorAllowlist: [],
    requireApprovalFor: ['gmail_send'],
    failClosed: true,
  };
}

function makeLlm(): LlmProvider {
  return {
    complete: vi.fn(async () =>
      JSON.stringify({ tool: 'finish', input: { summary: 'child done' } }),
    ),
  } as unknown as LlmProvider;
}

const baseCtx: ParentContext = {
  workspaceId: 'ws-1',
  taskId: 't-1',
  parentTaskRunId: 'tr-parent',
  operatorRole: 'conductor',
  policyVersion: 'founder-ops-v1',
  policyDecisionId: 'dec-subagent-spawn',
  helmDocumentVersionPins: { toolAccessPolicy: 'founder-ops-v1' },
  remainingBudgetUsd: 5,
};

describe('opportunity_scout definition', () => {
  it('can persist new candidates before scoring them', () => {
    const def = loadDefinitionFile(
      resolve(process.cwd(), '../../packs/subagents/opportunity_scout.md'),
    );

    expect(def.toolScope.allowedTools).toEqual(
      expect.arrayContaining(['create_opportunity', 'score_opportunity']),
    );
  });
});

describe('Conductor.spawn', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fails fast with a clear message when the subagent name is unknown', async () => {
    const registry = new SubagentRegistry([makeDef({ name: 'known_one' })]);
    const tools = new ToolRegistry(makeMockDb());
    const conductor = new Conductor(makeMockDb(), registry, tools, makePolicy(), makeLlm());

    const result = await conductor.spawn(baseCtx, { name: 'ghost', task: 'x' });
    expect(result.verdict).toBe('failed');
    expect(result.error).toBe('subagent_not_found');
    expect(result.summary).toContain('known_one');
  });

  it('runs the subagent loop end-to-end with a finish signal', async () => {
    const def = makeDef({ name: 'scout_x' });
    const registry = new SubagentRegistry([def]);
    const db = makeMockDb();
    const tools = new ToolRegistry(db);
    const conductor = new Conductor(db, registry, tools, makePolicy(), makeLlm());

    const result = await conductor.spawn(baseCtx, {
      name: 'scout_x',
      task: 'scan market',
    });

    expect(result.verdict).toBe('completed');
    expect(result.summary).toContain('child done');
    expect(result.name).toBe('scout_x');
  });

  it('writes a SUBAGENT_SPAWN evidence pack row during spawn', async () => {
    const def = makeDef();
    const registry = new SubagentRegistry([def]);
    const db = makeMockDb();
    const insertSpy = db.insert;
    const tools = new ToolRegistry(db);
    const conductor = new Conductor(db, registry, tools, makePolicy(), makeLlm());

    await conductor.spawn(baseCtx, { name: 'scout_x', task: 'x' });

    // Every insert call's .values(row) is mocked; collect the row payloads.
    const valuesPayloads: Record<string, unknown>[] = [];
    for (const result of insertSpy.mock.results) {
      const chain = result.value as { values: ReturnType<typeof vi.fn> };
      for (const valCall of chain.values.mock.calls) {
        valuesPayloads.push(valCall[0] as Record<string, unknown>);
      }
    }

    const spawnPack = valuesPayloads.find((p) => p['action'] === 'SUBAGENT_SPAWN');
    expect(spawnPack).toBeDefined();
    expect(spawnPack?.['resource']).toBe('scout_x');
    expect(spawnPack?.['verdict']).toBe('ALLOW');
    expect(String(spawnPack?.['principal'])).toContain('subagent:scout_x:');

    const spawnRun = valuesPayloads.find((p) => p['actionTool'] === 'subagent.spawn');
    expect(spawnRun).toEqual(
      expect.objectContaining({
        parentTaskRunId: 'tr-parent',
        rootTaskRunId: 'tr-parent',
        spawnedByActionId: 'tr-parent',
        lineageKind: 'subagent_spawn',
      }),
    );

    const childActionRun = valuesPayloads.find((p) => p['actionTool'] === 'finish');
    expect(childActionRun).toEqual(
      expect.objectContaining({
        rootTaskRunId: 'tr-parent',
        lineageKind: 'subagent_action',
      }),
    );
    expect(childActionRun?.['parentTaskRunId']).not.toBe('tr-parent');
    expect(childActionRun?.['spawnedByActionId']).toBe(childActionRun?.['parentTaskRunId']);

    const updatePayloads: Record<string, unknown>[] = [];
    for (const result of db.update.mock.results) {
      const chain = result.value as { set: ReturnType<typeof vi.fn> };
      for (const setCall of chain.set.mock.calls) {
        updatePayloads.push(setCall[0] as Record<string, unknown>);
      }
    }
    expect(updatePayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskRunId: childActionRun?.['parentTaskRunId'] }),
      ]),
    );
  });

  it('loads explicit skill bodies into the child prompt and records metadata', async () => {
    const skill = makeSkill({
      name: 'yc-application-writing',
      tools: ['search_knowledge'],
      body: 'Use YC voice and never invent traction.',
    });
    const registry = new SubagentRegistry([
      makeDef({
        name: 'application_writer',
        skills: ['yc-application-writing'],
        toolScope: { allowedTools: ['search_knowledge'] },
      }),
    ]);
    const skillRegistry = new SkillRegistry([skill]);
    const db = makeMockDb();
    const insertSpy = db.insert;
    const llm = makeLlm();
    const tools = new ToolRegistry(db);
    const conductor = new Conductor(
      db,
      registry,
      tools,
      makePolicy(),
      llm,
      undefined,
      skillRegistry,
    );

    await conductor.spawn(baseCtx, {
      name: 'application_writer',
      task: 'Draft YC application sections',
    });

    expect(llm.complete).toHaveBeenCalledWith(expect.stringContaining('Use YC voice'));

    const valuesPayloads: Record<string, unknown>[] = [];
    for (const result of insertSpy.mock.results) {
      const chain = result.value as { values: ReturnType<typeof vi.fn> };
      for (const valCall of chain.values.mock.calls) {
        valuesPayloads.push(valCall[0] as Record<string, unknown>);
      }
    }
    const spawnRun = valuesPayloads.find((p) => p['actionTool'] === 'subagent.spawn');
    expect(spawnRun?.['skillInvocations']).toEqual([
      expect.objectContaining({
        name: 'yc-application-writing',
        version: '1.0.0',
        riskProfile: 'R1',
        evalStatus: 'not_evaluated',
        declaredTools: ['search_knowledge'],
      }),
    ]);

    const skillAction = valuesPayloads.find((p) => p['actionKey'] === 'skill.invoke');
    expect(skillAction).toEqual(
      expect.objectContaining({
        actionType: 'tool',
        riskClass: 'medium',
        policyDecisionId: 'dec-subagent-spawn',
        policyVersion: 'founder-ops-v1',
      }),
    );
    const skillExecution = valuesPayloads.find((p) => p['toolKey'] === 'skill.invoke');
    expect(skillExecution).toEqual(
      expect.objectContaining({
        status: 'running',
        policyDecisionId: 'dec-subagent-spawn',
        policyVersion: 'founder-ops-v1',
        helmDocumentVersionPins: { toolAccessPolicy: 'founder-ops-v1' },
      }),
    );

    const updatePayloads: Record<string, unknown>[] = [];
    for (const result of db.update.mock.results) {
      const chain = result.value as { set: ReturnType<typeof vi.fn> };
      for (const setCall of chain.set.mock.calls) {
        updatePayloads.push(setCall[0] as Record<string, unknown>);
      }
    }
    const skillUpdate = updatePayloads.find((p) => Array.isArray(p['skillInvocations']));
    expect(skillUpdate?.['skillInvocations']).toEqual([
      expect.objectContaining({
        name: 'yc-application-writing',
        instructionHash: expect.stringMatching(/^sha256:/u),
        brokeredInvocation: expect.objectContaining({
          actionId: expect.any(String),
          toolExecutionId: expect.any(String),
          evidenceItemId: expect.any(String),
          status: 'completed',
          inputHash: expect.stringMatching(/^sha256:/u),
          outputHash: expect.stringMatching(/^sha256:/u),
          policyDecisionId: 'dec-subagent-spawn',
          policyVersion: 'founder-ops-v1',
        }),
      }),
    ]);

    const handoff = valuesPayloads.find((p) => p['handoffKind'] === 'subagent_spawn');
    expect(handoff?.['skillInvocations']).toEqual(skillUpdate?.['skillInvocations']);
  });

  it('fails closed when a skill cannot be activated through Tool Broker governance', async () => {
    const skill = makeSkill({
      name: 'yc-application-writing',
      tools: ['search_knowledge'],
      body: 'Use YC voice and never invent traction.',
    });
    const registry = new SubagentRegistry([
      makeDef({
        name: 'application_writer',
        skills: ['yc-application-writing'],
        toolScope: { allowedTools: ['search_knowledge'] },
      }),
    ]);
    const skillRegistry = new SkillRegistry([skill]);
    const db = makeMockDb();
    const llm = makeLlm();
    const tools = new ToolRegistry(db);
    const conductor = new Conductor(
      db,
      registry,
      tools,
      makePolicy(),
      llm,
      undefined,
      skillRegistry,
    );

    const result = await conductor.spawn(
      {
        ...baseCtx,
        policyDecisionId: undefined,
      },
      {
        name: 'application_writer',
        task: 'Draft YC application sections',
      },
    );

    expect(result.verdict).toBe('failed');
    expect(result.error).toBe('subagent_persistence_failed');
    expect(result.summary).toContain('Tool Broker refused elevated tool skill.invoke');
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('fails closed when an explicit skill is not loaded', async () => {
    const registry = new SubagentRegistry([
      makeDef({ name: 'application_writer', skills: ['missing-skill'] }),
    ]);
    const db = makeMockDb();
    const tools = new ToolRegistry(db);
    const conductor = new Conductor(
      db,
      registry,
      tools,
      makePolicy(),
      makeLlm(),
      undefined,
      new SkillRegistry([]),
    );

    const result = await conductor.spawn(baseCtx, {
      name: 'application_writer',
      task: 'Draft YC application sections',
    });

    expect(result.verdict).toBe('failed');
    expect(result.error).toBe('skill_not_loaded');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('fails closed when a matched skill requires tools outside subagent scope', async () => {
    const skill = makeSkill({
      name: 'yc-application-writing',
      tools: ['create_application_draft'],
    });
    const registry = new SubagentRegistry([
      makeDef({
        name: 'application_writer',
        skills: ['yc-application-writing'],
        toolScope: { allowedTools: ['search_knowledge'] },
      }),
    ]);
    const db = makeMockDb();
    const tools = new ToolRegistry(db);
    const conductor = new Conductor(
      db,
      registry,
      tools,
      makePolicy(),
      makeLlm(),
      undefined,
      new SkillRegistry([skill]),
    );

    const result = await conductor.spawn(baseCtx, {
      name: 'application_writer',
      task: 'Draft YC application sections',
    });

    expect(result.verdict).toBe('failed');
    expect(result.error).toBe('skill_tool_scope_denied');
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('skips auto-matched skills that require tools outside subagent scope', async () => {
    const skill = makeSkill({
      name: 'yc-application-writing',
      description: 'Draft YC application sections',
      tools: ['create_application_draft'],
    });
    const registry = new SubagentRegistry([
      makeDef({
        name: 'scout_x',
        toolScope: { allowedTools: ['search_knowledge'] },
      }),
    ]);
    const db = makeMockDb();
    const insertSpy = db.insert;
    const llm = makeLlm();
    const tools = new ToolRegistry(db);
    const conductor = new Conductor(
      db,
      registry,
      tools,
      makePolicy(),
      llm,
      undefined,
      new SkillRegistry([skill]),
    );

    const result = await conductor.spawn(baseCtx, {
      name: 'scout_x',
      task: 'Draft YC application sections from market research',
    });

    expect(result.verdict).toBe('completed');
    expect(llm.complete).not.toHaveBeenCalledWith(expect.stringContaining('Use the test skill'));

    const valuesPayloads: Record<string, unknown>[] = [];
    for (const insertResult of insertSpy.mock.results) {
      const chain = insertResult.value as { values: ReturnType<typeof vi.fn> };
      for (const valCall of chain.values.mock.calls) {
        valuesPayloads.push(valCall[0] as Record<string, unknown>);
      }
    }
    const spawnRun = valuesPayloads.find((p) => p['actionTool'] === 'subagent.spawn');
    expect(spawnRun?.['skillInvocations']).toEqual([]);
  });

  it('fails closed when the durable handoff row cannot be persisted', async () => {
    const registry = new SubagentRegistry([makeDef({ name: 'scout_x' })]);
    const db = makeMockDb({ failInsertTable: 'agentHandoffs' });
    const llm = makeLlm();
    const tools = new ToolRegistry(db);
    const conductor = new Conductor(db, registry, tools, makePolicy(), llm);

    const result = await conductor.spawn(baseCtx, {
      name: 'scout_x',
      task: 'scan market',
    });

    expect(result.verdict).toBe('failed');
    expect(result.error).toBe('subagent_persistence_failed');
    expect(result.summary).toContain('Failed to persist agent handoff');
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('fails closed when durable handoff completion cannot be persisted', async () => {
    const registry = new SubagentRegistry([makeDef({ name: 'scout_x' })]);
    const db = makeMockDb({ failUpdateTable: 'agentHandoffs' });
    const llm = makeLlm();
    const tools = new ToolRegistry(db);
    const conductor = new Conductor(db, registry, tools, makePolicy(), llm);

    await expect(
      conductor.spawn(baseCtx, {
        name: 'scout_x',
        task: 'scan market',
      }),
    ).rejects.toThrow('Failed to complete agent handoff');
    expect(llm.complete).toHaveBeenCalled();
  });

  it('does not commit a spawn evidence pack when spawn evidence item persistence fails', async () => {
    const registry = new SubagentRegistry([makeDef({ name: 'scout_x' })]);
    const { db, committedInserts } = makeTransactionalSpawnDb({ failEvidenceInsert: true });
    const llm = makeLlm();
    const tools = new ToolRegistry(db);
    const conductor = new Conductor(db, registry, tools, makePolicy(), llm);

    const result = await conductor.spawn(baseCtx, {
      name: 'scout_x',
      task: 'scan market',
    });

    expect(result.verdict).toBe('failed');
    expect(result.error).toBe('subagent_persistence_failed');
    expect(result.summary).toContain('Failed to persist SUBAGENT_SPAWN evidence pack');
    expect(committedInserts).toEqual([]);
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('fails closed when the spawn evidence pack cannot be anchored to the subagent run', async () => {
    const registry = new SubagentRegistry([makeDef({ name: 'scout_x' })]);
    const db = makeMockDb({ failUpdateTable: 'evidencePacks' });
    const llm = makeLlm();
    const tools = new ToolRegistry(db);
    const conductor = new Conductor(db, registry, tools, makePolicy(), llm);

    const result = await conductor.spawn(baseCtx, {
      name: 'scout_x',
      task: 'scan market',
    });

    expect(result.verdict).toBe('failed');
    expect(result.error).toBe('subagent_persistence_failed');
    expect(result.summary).toContain('Failed to anchor SUBAGENT_SPAWN evidence');
    expect(llm.complete).not.toHaveBeenCalled();
  });
});

describe('Conductor.parallel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dispatches multiple spawns concurrently and returns one result per request', async () => {
    const registry = new SubagentRegistry([
      makeDef({ name: 'a' }),
      makeDef({ name: 'b' }),
      makeDef({ name: 'c' }),
    ]);
    const db = makeMockDb();
    const tools = new ToolRegistry(db);
    const conductor = new Conductor(db, registry, tools, makePolicy(), makeLlm());

    const results = await conductor.parallel(baseCtx, [
      { name: 'a', task: 'x' },
      { name: 'b', task: 'y' },
      { name: 'c', task: 'z' },
    ]);

    expect(results).toHaveLength(3);
    expect(results.map((r) => r.name).sort()).toEqual(['a', 'b', 'c']);
    expect(results.every((r) => r.verdict === 'completed')).toBe(true);
  });

  it('fails the whole batch when any requested subagent is unknown', async () => {
    const registry = new SubagentRegistry([makeDef({ name: 'a' })]);
    const db = makeMockDb();
    const tools = new ToolRegistry(db);
    const conductor = new Conductor(db, registry, tools, makePolicy(), makeLlm());

    const results = await conductor.parallel(baseCtx, [
      { name: 'a', task: 'x' },
      { name: 'ghost', task: 'y' },
    ]);

    expect(results.some((r) => r.verdict === 'failed')).toBe(true);
    expect(results.find((r) => r.verdict === 'failed')?.error).toBe('subagent_not_found');
  });

  it('concurrent spawns of the same subagent get distinct principal suffixes', async () => {
    const registry = new SubagentRegistry([makeDef({ name: 'twin' })]);
    const db = makeMockDb();
    const insertSpy = db.insert;
    const tools = new ToolRegistry(db);
    const conductor = new Conductor(db, registry, tools, makePolicy(), makeLlm());

    await conductor.parallel(baseCtx, [
      { name: 'twin', task: 'x' },
      { name: 'twin', task: 'y' },
    ]);

    const principals: string[] = [];
    const spawnRuns: Record<string, unknown>[] = [];
    for (const result of insertSpy.mock.results) {
      const chain = result.value as { values: ReturnType<typeof vi.fn> };
      for (const valCall of chain.values.mock.calls) {
        const row = valCall[0] as Record<string, unknown>;
        if (row['action'] === 'SUBAGENT_SPAWN') {
          principals.push(String(row['principal']));
        }
        if (row['actionTool'] === 'subagent.spawn') {
          spawnRuns.push(row);
        }
      }
    }
    expect(principals).toHaveLength(2);
    expect(principals[0]).not.toBe(principals[1]);
    expect(spawnRuns).toHaveLength(2);
    for (const run of spawnRuns) {
      expect(run).toEqual(
        expect.objectContaining({
          parentTaskRunId: 'tr-parent',
          rootTaskRunId: 'tr-parent',
          spawnedByActionId: 'tr-parent',
          lineageKind: 'subagent_spawn',
        }),
      );
    }
  });
});
