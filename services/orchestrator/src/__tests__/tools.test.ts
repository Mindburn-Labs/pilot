import { describe, it, expect, vi } from 'vitest';
import {
  artifactVersions,
  artifacts,
  auditLog,
  computerActions,
  evidenceItems,
  opportunities,
  opportunityScores,
} from '@pilot/db/schema';
import { getCapabilityRecord } from '@pilot/shared/capabilities';
import { SkillRegistry, type SkillDefinition } from '@pilot/shared/skills';
import {
  markBrokeredToolContext,
  ToolRegistry,
  type Tool,
  type ToolExecutionContext,
} from '../tools.js';

// Minimal mocks — db is an empty object since built-in tools
// that use db require dynamic imports we don't exercise here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDb = {} as any;

function createRegistry(
  opts: { memory?: unknown; helmClient?: unknown; skillRegistry?: SkillRegistry } = {},
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ToolRegistry(mockDb as any, opts.memory as any, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    helmClient: opts.helmClient as any,
    skillRegistry: opts.skillRegistry,
  });
}

function createRegistryWithDb(
  db: unknown,
  opts: { memory?: unknown; helmClient?: unknown; skillRegistry?: SkillRegistry } = {},
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ToolRegistry(db as any, opts.memory as any, {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    helmClient: opts.helmClient as any,
    skillRegistry: opts.skillRegistry,
  });
}

function brokeredToolContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return markBrokeredToolContext({
    workspaceId: '00000000-0000-4000-8000-000000000001',
    taskId: '00000000-0000-4000-8000-000000000002',
    actionId: '00000000-0000-4000-8000-000000000004',
    policyDecisionId: 'dec-tool-use',
    policyVersion: 'founder-ops-v1',
    ...overrides,
  });
}

function createComputerActionDb(options: { failEvidenceInsert?: boolean } = {}) {
  const insertedComputerActions: unknown[] = [];
  const insertedEvidenceItems: unknown[] = [];
  const insertedAudit: unknown[] = [];
  const updatedComputerActions: unknown[] = [];
  const updatedAudit: unknown[] = [];
  const transactionInsertOrder: string[] = [];
  const originalInsert = vi.fn((table: unknown) => ({
    values: vi.fn((value: unknown) => {
      if (table === computerActions) {
        insertedComputerActions.push(value);
        return {
          returning: vi.fn(async () => [
            {
              id: '00000000-0000-4000-8000-000000000010',
              replayIndex: 0,
              evidencePackId: (value as { evidencePackId?: string | null }).evidencePackId ?? null,
            },
          ]),
        };
      }
      if (table === auditLog) {
        insertedAudit.push(value);
        return {};
      }
      if (table === evidenceItems) {
        insertedEvidenceItems.push(value);
        return {
          returning: vi.fn(async () => [
            {
              id: '00000000-0000-4000-8000-000000000011',
            },
          ]),
        };
      }
      return { returning: vi.fn(async () => []) };
    }),
  }));
  const captureEvidenceInsert = (evidenceSink: unknown[], auditSink: unknown[]) =>
    vi.fn((table: unknown) => ({
      values: vi.fn((value: unknown) => {
        if (table === auditLog) {
          transactionInsertOrder.push('audit_log');
          auditSink.push(value);
          return {};
        }
        if (table === evidenceItems) {
          transactionInsertOrder.push('evidence_items');
          evidenceSink.push(value);
          return {
            returning: vi.fn(async () => {
              if (options.failEvidenceInsert) throw new Error('evidence ledger unavailable');
              return [
                {
                  id: '00000000-0000-4000-8000-000000000011',
                },
              ];
            }),
          };
        }
        return originalInsert(table).values(value);
      }),
    }));
  const captureComputerActionUpdate = (computerActionSink: unknown[], auditSink: unknown[]) =>
    vi.fn((table: unknown) => ({
      set: vi.fn((value: unknown) => {
        if (table === computerActions) computerActionSink.push(value);
        if (table === auditLog) auditSink.push(value);
        return { where: vi.fn(async () => []) };
      }),
    }));
  const db = {
    insert: originalInsert,
    update: captureComputerActionUpdate(updatedComputerActions, updatedAudit),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const stagedEvidenceItems: unknown[] = [];
      const stagedComputerActionUpdates: unknown[] = [];
      const stagedAudit: unknown[] = [];
      const stagedAuditUpdates: unknown[] = [];
      const tx = {
        insert: captureEvidenceInsert(stagedEvidenceItems, stagedAudit),
        update: captureComputerActionUpdate(stagedComputerActionUpdates, stagedAuditUpdates),
      };
      const result = await callback(tx);
      insertedAudit.push(...stagedAudit);
      insertedEvidenceItems.push(...stagedEvidenceItems);
      updatedComputerActions.push(...stagedComputerActionUpdates);
      updatedAudit.push(...stagedAuditUpdates);
      return result;
    }),
  };
  return {
    db,
    insertedComputerActions,
    insertedEvidenceItems,
    insertedAudit,
    updatedComputerActions,
    updatedAudit,
    transactionInsertOrder,
  };
}

function createArtifactDb(options: { failEvidenceInsert?: boolean } = {}) {
  const insertedArtifacts: unknown[] = [];
  const insertedArtifactVersions: unknown[] = [];
  const insertedEvidenceItems: unknown[] = [];
  const insertedAudit: unknown[] = [];
  const updatedAudit: unknown[] = [];
  const transactionInsertOrder: string[] = [];

  const createDbFacade = (
    artifactSink: unknown[],
    artifactVersionSink: unknown[],
    evidenceSink: unknown[],
    auditSink: unknown[],
    auditUpdateSink: unknown[],
  ) => ({
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: unknown) => {
        if (table === artifacts) {
          artifactSink.push(value);
          return {
            returning: vi.fn(async () => [
              {
                id: '00000000-0000-4000-8000-000000000020',
                name: (value as { name: string }).name,
                type: (value as { type: string }).type,
              },
            ]),
          };
        }
        if (table === artifactVersions) {
          transactionInsertOrder.push('artifact_versions');
          artifactVersionSink.push(value);
          return {};
        }
        if (table === auditLog) {
          transactionInsertOrder.push('audit_log');
          auditSink.push(value);
          return {};
        }
        if (table === evidenceItems) {
          transactionInsertOrder.push('evidence_items');
          evidenceSink.push(value);
          return {
            returning: vi.fn(async () => {
              if (options.failEvidenceInsert) throw new Error('evidence ledger unavailable');
              return [
                {
                  id: '00000000-0000-4000-8000-000000000021',
                },
              ];
            }),
          };
        }
        return { returning: vi.fn(async () => []) };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((value: unknown) => {
        if (table === auditLog) auditUpdateSink.push(value);
        return { where: vi.fn(async () => []) };
      }),
    })),
  });

  const db = {
    ...createDbFacade(
      insertedArtifacts,
      insertedArtifactVersions,
      insertedEvidenceItems,
      insertedAudit,
      updatedAudit,
    ),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const stagedArtifacts: unknown[] = [];
      const stagedArtifactVersions: unknown[] = [];
      const stagedEvidenceItems: unknown[] = [];
      const stagedAudit: unknown[] = [];
      const stagedAuditUpdates: unknown[] = [];
      const result = await callback(
        createDbFacade(
          stagedArtifacts,
          stagedArtifactVersions,
          stagedEvidenceItems,
          stagedAudit,
          stagedAuditUpdates,
        ),
      );
      insertedArtifacts.push(...stagedArtifacts);
      insertedArtifactVersions.push(...stagedArtifactVersions);
      insertedEvidenceItems.push(...stagedEvidenceItems);
      insertedAudit.push(...stagedAudit);
      updatedAudit.push(...stagedAuditUpdates);
      return result;
    }),
  };
  return {
    db,
    insertedArtifacts,
    insertedArtifactVersions,
    insertedEvidenceItems,
    insertedAudit,
    updatedAudit,
    transactionInsertOrder,
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

describe('ToolRegistry', () => {
  // ─── Registration ───

  describe('register()', () => {
    it('adds a tool that appears in listTools()', () => {
      const registry = createRegistry();
      const tool: Tool = {
        name: 'custom_tool',
        description: 'A custom tool for testing',
        execute: async () => ({ ok: true }),
      };

      registry.register(tool);

      const tools = registry.listTools();
      const found = tools.find((t) => t.name === 'custom_tool');
      expect(found).toBeDefined();
      expect(found!.description).toBe('A custom tool for testing');
    });

    it('overwrites a tool with the same name', () => {
      const registry = createRegistry();

      registry.register({
        name: 'dup',
        description: 'first',
        execute: async () => ({ v: 1 }),
      });
      registry.register({
        name: 'dup',
        description: 'second',
        execute: async () => ({ v: 2 }),
      });

      const tools = registry.listTools();
      const dups = tools.filter((t) => t.name === 'dup');
      expect(dups).toHaveLength(1);
      expect(dups[0]!.description).toBe('second');
    });
  });

  // ─── Listing ───

  describe('listTools()', () => {
    it('returns tool definitions with name and description', () => {
      const registry = createRegistry();
      const tools = registry.listTools();

      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(typeof tool.name).toBe('string');
        expect(typeof tool.description).toBe('string');
      }
    });

    it('includes all built-in tools', () => {
      const registry = createRegistry();
      const tools = registry.listTools();
      const names = tools.map((t) => t.name);

      // Universal tools
      expect(names).toContain('search_knowledge');
      expect(names).toContain('create_note');
      expect(names).toContain('scrapling_fetch');
      expect(names).toContain('operator.computer_use');
      expect(names).toContain('operator.browser_read');
      expect(names).toContain('draft_text');
      expect(names).toContain('analyze');
      expect(names).toContain('get_workspace_context');
      expect(names).toContain('send_notification');

      // Discover mode tools
      expect(names).toContain('list_opportunities');
      expect(names).toContain('create_opportunity');
      expect(names).toContain('score_opportunity');
      expect(names).toContain('search_yc');

      // Decide mode tools
      expect(names).toContain('get_founder_profile');

      // Build mode tools
      expect(names).toContain('create_task');
      expect(names).toContain('update_task_status');
      expect(names).toContain('list_tasks');
      expect(names).toContain('create_plan');
      expect(names).toContain('create_artifact');

      // Apply mode tools
      expect(names).toContain('create_application_draft');

      expect(names).toContain('skill.invoke');
      expect(names).toContain('slack_workspace_agent_reply');

      // Phase 15 Track I + K plus Workspace Agents: 46 connector tools + 5 core + a2a.delegate
      expect(tools.length).toBe(52);
    });
  });

  // ─── Mode-aware filtering ───

  describe('listToolsForMode()', () => {
    it('discover mode includes universal + discover tools', () => {
      const registry = createRegistry();
      const tools = registry.listToolsForMode('discover');
      const names = tools.map((t) => t.name);

      // Universal (no modes restriction)
      expect(names).toContain('search_knowledge');
      expect(names).toContain('create_note');
      expect(names).toContain('scrapling_fetch');
      expect(names).toContain('operator.computer_use');
      expect(names).toContain('operator.browser_read');
      expect(names).toContain('draft_text');
      expect(names).toContain('analyze');
      expect(names).toContain('get_workspace_context');
      expect(names).toContain('send_notification');

      // Discover-specific
      expect(names).toContain('list_opportunities');
      expect(names).toContain('create_opportunity');
      expect(names).toContain('score_opportunity');
      expect(names).toContain('search_yc');

      // Should NOT include build-only tools
      expect(names).not.toContain('create_task');
      expect(names).not.toContain('update_task_status');
      expect(names).not.toContain('create_plan');
    });

    it('build mode includes universal + build tools', () => {
      const registry = createRegistry();
      const tools = registry.listToolsForMode('build');
      const names = tools.map((t) => t.name);

      expect(names).toContain('create_task');
      expect(names).toContain('update_task_status');
      expect(names).toContain('list_tasks');
      expect(names).toContain('create_plan');
      expect(names).toContain('create_artifact');
      expect(names).toContain('scrapling_fetch');
      expect(names).toContain('operator.computer_use');
      expect(names).toContain('operator.browser_read');
      expect(names).toContain('slack_workspace_agent_reply');

      // Should NOT include discover-only tools
      expect(names).not.toContain('list_opportunities');
      expect(names).not.toContain('create_opportunity');
      expect(names).not.toContain('score_opportunity');
    });

    it('apply mode includes universal + apply + shared tools', () => {
      const registry = createRegistry();
      const tools = registry.listToolsForMode('apply');
      const names = tools.map((t) => t.name);

      expect(names).toContain('create_application_draft');
      expect(names).toContain('search_yc');
      expect(names).toContain('scrapling_fetch');
      expect(names).toContain('operator.computer_use');
      expect(names).toContain('operator.browser_read');
      expect(names).toContain('draft_text');

      // Should NOT include build-only tools
      expect(names).not.toContain('create_task');
    });

    it('decide mode includes universal + decide tools', () => {
      const registry = createRegistry();
      const tools = registry.listToolsForMode('decide');
      const names = tools.map((t) => t.name);

      expect(names).toContain('get_founder_profile');
      expect(names).toContain('search_knowledge');

      // Should NOT include build or discover tools
      expect(names).not.toContain('create_task');
      expect(names).not.toContain('list_opportunities');
    });

    it('launch mode includes universal + launch tools', () => {
      const registry = createRegistry();
      const tools = registry.listToolsForMode('launch');
      const names = tools.map((t) => t.name);

      expect(names).toContain('create_artifact');
      expect(names).toContain('list_tasks');
      expect(names).toContain('scrapling_fetch');
      expect(names).toContain('operator.computer_use');
      expect(names).toContain('operator.browser_read');
      expect(names).toContain('send_notification');

      // Should NOT include discover-only or apply-only tools
      expect(names).not.toContain('list_opportunities');
      expect(names).not.toContain('create_application_draft');
    });
  });

  // ─── Execution dispatch ───

  describe('execute()', () => {
    it('calls the correct tool with the provided input', async () => {
      const registry = createRegistry();
      const executeFn = vi.fn(async (input: unknown) => ({ received: input }));

      registry.register({
        name: 'echo',
        description: 'Echoes input',
        execute: executeFn,
      });

      const result = await registry.execute('echo', { msg: 'hello' });

      expect(executeFn).toHaveBeenCalledOnce();
      expect(executeFn).toHaveBeenCalledWith({ msg: 'hello' });
      expect(result).toEqual({ received: { msg: 'hello' } });
    });

    it('overrides model-supplied workspace/task authority with server context', async () => {
      const registry = createRegistry();
      const executeFn = vi.fn(async (input: unknown) => ({ received: input }));

      registry.register({
        name: 'contextual',
        description: 'Checks bound context',
        execute: executeFn,
      });

      const result = await registry.execute(
        'contextual',
        {
          workspaceId: 'spoofed-ws',
          taskId: 'spoofed-task',
          operatorId: 'spoofed-op',
          value: 1,
        },
        {
          workspaceId: 'server-ws',
          taskId: 'server-task',
          operatorId: 'server-op',
          actionHash: 'sha256:action',
          policyVersion: 'local:policy',
        },
      );

      expect(executeFn).toHaveBeenCalledWith({
        workspaceId: 'server-ws',
        taskId: 'server-task',
        operatorId: 'server-op',
        value: 1,
        actionHash: 'sha256:action',
        policyVersion: 'local:policy',
      });
      expect(result).toEqual({
        received: {
          workspaceId: 'server-ws',
          taskId: 'server-task',
          operatorId: 'server-op',
          value: 1,
          actionHash: 'sha256:action',
          policyVersion: 'local:policy',
        },
      });
    });

    it('returns error object for unregistered tools', async () => {
      const registry = createRegistry();
      const result = await registry.execute('nonexistent_tool', {});

      expect(result).toEqual({ error: 'Unknown tool: nonexistent_tool' });
    });

    it('catches errors from tool.execute and returns error message', async () => {
      const registry = createRegistry();

      registry.register({
        name: 'failing_tool',
        description: 'Always fails',
        execute: async () => {
          throw new Error('Something went wrong');
        },
      });

      const result = await registry.execute('failing_tool', {});
      expect(result).toEqual({ error: 'Something went wrong' });
    });

    it('returns generic message for non-Error throws', async () => {
      const registry = createRegistry();

      registry.register({
        name: 'throws_string',
        description: 'Throws a string',
        execute: async () => {
          throw 'raw string error'; // eslint-disable-line no-throw-literal
        },
      });

      const result = await registry.execute('throws_string', {});
      expect(result).toEqual({ error: 'Tool execution failed' });
    });

    it('rejects stub tools unless explicit demo mode is enabled', async () => {
      const previous = process.env['PILOT_TOOL_DEMO_MODE'];
      delete process.env['PILOT_TOOL_DEMO_MODE'];
      const registry = createRegistry();
      const executeFn = vi.fn(async () => ({ ok: true }));
      registry.register({
        name: 'stub_only',
        description: 'Stub-only test tool',
        stub: true,
        capabilityKey: 'opportunity_scoring',
        execute: executeFn,
      });

      const result = await registry.execute('stub_only', {});

      expect(executeFn).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        error:
          'Tool stub_only is marked as stub-only and is unavailable to autonomous agents outside explicit demo/test mode',
        capability: getCapabilityRecord('opportunity_scoring'),
      });
      if (previous === undefined) delete process.env['PILOT_TOOL_DEMO_MODE'];
      else process.env['PILOT_TOOL_DEMO_MODE'] = previous;
    });

    it('allows stub tools only when explicit demo mode is enabled', async () => {
      const previous = process.env['PILOT_TOOL_DEMO_MODE'];
      process.env['PILOT_TOOL_DEMO_MODE'] = '1';
      const registry = createRegistry();
      registry.register({
        name: 'demo_stub',
        description: 'Demo stub tool',
        stub: true,
        execute: async () => ({ ok: true }),
      });

      const result = await registry.execute('demo_stub', {});

      expect(result).toEqual({ ok: true });
      if (previous === undefined) delete process.env['PILOT_TOOL_DEMO_MODE'];
      else process.env['PILOT_TOOL_DEMO_MODE'] = previous;
    });

    it('blocks elevated tools without brokered HELM context', async () => {
      const registry = createRegistry();
      const executeFn = vi.fn(async () => ({ ok: true }));
      registry.register({
        name: 'danger_write',
        description: 'Writes to an external system',
        manifest: {
          key: 'danger_write',
          version: 'test:v1',
          riskClass: 'high',
          effectLevel: 'E3',
          requiredEvidence: ['tool_result', 'helm_receipt'],
          permissionRequirements: ['tool:danger_write:execute'],
          outputSensitivity: 'sensitive',
        },
        execute: executeFn,
      });

      const result = await registry.execute(
        'danger_write',
        { value: 1 },
        {
          workspaceId: '00000000-0000-4000-8000-000000000001',
          taskId: '00000000-0000-4000-8000-000000000002',
          actionId: '00000000-0000-4000-8000-000000000004',
          policyDecisionId: 'dec-tool-use',
          policyVersion: 'founder-ops-v1',
        },
      );

      expect(executeFn).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        error: 'Tool danger_write requires Tool Broker + HELM context for elevated execution',
        missingContext: ['tool_broker_context'],
        manifest: {
          riskClass: 'high',
          effectLevel: 'E3',
        },
      });
    });

    it('allows elevated tools only when Tool Broker marks the execution context', async () => {
      const registry = createRegistry();
      const executeFn = vi.fn(async (input: unknown) => ({ received: input }));
      registry.register({
        name: 'scrapling_probe',
        description: 'Fetches external page data',
        manifest: {
          key: 'scrapling_probe',
          version: 'test:v1',
          riskClass: 'medium',
          effectLevel: 'E2',
          requiredEvidence: ['source_snapshot', 'helm_receipt'],
          permissionRequirements: ['tool:scrapling_probe:execute'],
          outputSensitivity: 'internal',
        },
        execute: executeFn,
      });

      const result = await registry.execute(
        'scrapling_probe',
        { url: 'https://example.com' },
        brokeredToolContext(),
      );

      expect(executeFn).toHaveBeenCalledWith({
        url: 'https://example.com',
        workspaceId: '00000000-0000-4000-8000-000000000001',
        taskId: '00000000-0000-4000-8000-000000000002',
        policyDecisionId: 'dec-tool-use',
        policyVersion: 'founder-ops-v1',
        actionId: '00000000-0000-4000-8000-000000000004',
      });
      expect(result).toMatchObject({
        received: {
          url: 'https://example.com',
          policyDecisionId: 'dec-tool-use',
          actionId: '00000000-0000-4000-8000-000000000004',
        },
      });
    });
  });

  // ─── Built-in tool behaviors ───

  describe('built-in: skill.invoke', () => {
    it('requires declared skill tools to fit the provided allowed tool scope', async () => {
      const registry = createRegistry({
        skillRegistry: new SkillRegistry([
          makeSkill({ name: 'market-research', tools: ['search_knowledge'] }),
        ]),
      });

      const result = await registry.execute(
        'skill.invoke',
        {
          skillName: 'market-research',
          expectedVersion: '1.0.0',
          task: 'Research a market',
          allowedTools: [],
        },
        brokeredToolContext(),
      );

      expect(result).toMatchObject({
        error: 'Skill market-research requires tool(s) outside allowed scope: search_knowledge',
      });
    });

    it('returns versioned skill metadata and instruction hash when scope permits invocation', async () => {
      const registry = createRegistry({
        skillRegistry: new SkillRegistry([
          makeSkill({ name: 'market-research', tools: ['search_knowledge'] }),
        ]),
      });

      const result = await registry.execute(
        'skill.invoke',
        {
          skillName: 'market-research',
          expectedVersion: '1.0.0',
          task: 'Research a market',
          allowedTools: ['search_knowledge'],
        },
        brokeredToolContext(),
      );

      expect(result).toMatchObject({
        skill: {
          name: 'market-research',
          version: '1.0.0',
          declaredTools: ['search_knowledge'],
        },
        taskHash: expect.stringMatching(/^sha256:/u),
        instructionHash: expect.stringMatching(/^sha256:/u),
        capability: getCapabilityRecord('skill_registry_runtime'),
      });
    });
  });

  describe('built-in: draft_text', () => {
    it('returns purpose, draft, and length', async () => {
      const registry = createRegistry();
      const result = await registry.execute('draft_text', {
        purpose: 'landing page headline',
        draft: 'Ship faster with HELM',
      });

      expect(result).toEqual({
        purpose: 'landing page headline',
        draft: 'Ship faster with HELM',
        length: 21,
      });
    });

    it('calculates length from the draft string', async () => {
      const registry = createRegistry();
      const result = await registry.execute('draft_text', {
        purpose: 'test',
        draft: 'abc',
      });

      expect(result).toEqual({
        purpose: 'test',
        draft: 'abc',
        length: 3,
      });
    });
  });

  describe('built-in: analyze', () => {
    it('returns the input as passthrough', async () => {
      const registry = createRegistry();
      const input = {
        topic: 'Market sizing',
        findings: 'TAM is $5B',
        confidence: 'high',
      };

      const result = await registry.execute('analyze', input);
      expect(result).toEqual(input);
    });

    it('passes through arbitrary input shapes', async () => {
      const registry = createRegistry();
      const input = { arbitrary: true, nested: { value: 42 } };

      const result = await registry.execute('analyze', input);
      expect(result).toEqual(input);
    });
  });

  describe('built-in: create_artifact', () => {
    it('persists the artifact, initial version, and canonical evidence item', async () => {
      const workspaceId = '00000000-0000-4000-8000-000000000001';
      const taskId = '00000000-0000-4000-8000-000000000002';
      const actionId = '00000000-0000-4000-8000-000000000003';
      const {
        db,
        insertedArtifacts,
        insertedArtifactVersions,
        insertedEvidenceItems,
        insertedAudit,
        updatedAudit,
        transactionInsertOrder,
      } = createArtifactDb();
      const registry = createRegistryWithDb(db);

      const result = await registry.execute(
        'create_artifact',
        {
          type: 'landing_page',
          name: 'pilot-homepage-copy.md',
          description: 'Homepage copy draft',
          content: '# Pilot\nAutonomous founder OS',
        },
        { workspaceId, taskId, actionId },
      );

      expect(insertedArtifacts[0]).toMatchObject({
        workspaceId,
        type: 'landing_page',
        name: 'pilot-homepage-copy.md',
        description: 'Homepage copy draft',
        storagePath: 'inline://pilot-homepage-copy.md',
        mimeType: 'text/plain',
        sizeBytes: 29,
        metadata: { content: '# Pilot\nAutonomous founder OS' },
      });
      expect(insertedArtifactVersions[0]).toMatchObject({
        artifactId: '00000000-0000-4000-8000-000000000020',
        version: 1,
        storagePath: 'inline://pilot-homepage-copy.md',
        sizeBytes: 29,
        changelog: 'Initial version',
      });
      expect(insertedAudit[0]).toMatchObject({
        id: expect.any(String),
        workspaceId,
        action: 'ARTIFACT_CREATED',
        actor: `workspace:${workspaceId}`,
        target: '00000000-0000-4000-8000-000000000020',
        verdict: 'created',
        metadata: expect.objectContaining({
          evidenceType: 'artifact_created',
          replayRef: 'artifact:00000000-0000-4000-8000-000000000020:1',
          artifactId: '00000000-0000-4000-8000-000000000020',
          taskId,
          actionId,
        }),
      });
      expect(insertedEvidenceItems[0]).toMatchObject({
        workspaceId,
        taskId,
        actionId,
        auditEventId: (insertedAudit[0] as { id: string }).id,
        artifactId: '00000000-0000-4000-8000-000000000020',
        evidenceType: 'artifact_created',
        sourceType: 'tool_registry',
        title: 'Artifact created: pilot-homepage-copy.md',
        summary: 'Homepage copy draft',
        redactionState: 'redacted',
        sensitivity: 'internal',
        contentHash: expect.stringMatching(/^sha256:/u),
        storageRef: 'inline://pilot-homepage-copy.md',
        replayRef: 'artifact:00000000-0000-4000-8000-000000000020:1',
        metadata: {
          artifactType: 'landing_page',
          version: 1,
          mimeType: 'text/plain',
          sizeBytes: 29,
          storageMode: 'inline_artifact_metadata',
          tool: 'create_artifact',
        },
      });
      expect(updatedAudit[0]).toMatchObject({
        metadata: expect.objectContaining({
          evidenceItemId: '00000000-0000-4000-8000-000000000021',
        }),
      });
      expect(transactionInsertOrder.indexOf('audit_log')).toBeLessThan(
        transactionInsertOrder.indexOf('evidence_items'),
      );
      expect(result).toMatchObject({
        id: '00000000-0000-4000-8000-000000000020',
        name: 'pilot-homepage-copy.md',
        type: 'landing_page',
        version: 1,
        evidenceItemId: '00000000-0000-4000-8000-000000000021',
      });
    });

    it('does not commit artifact state when evidence persistence fails', async () => {
      const workspaceId = '00000000-0000-4000-8000-000000000001';
      const taskId = '00000000-0000-4000-8000-000000000002';
      const actionId = '00000000-0000-4000-8000-000000000003';
      const {
        db,
        insertedArtifacts,
        insertedArtifactVersions,
        insertedEvidenceItems,
        insertedAudit,
        updatedAudit,
      } = createArtifactDb({ failEvidenceInsert: true });
      const registry = createRegistryWithDb(db);

      const result = await registry.execute(
        'create_artifact',
        {
          type: 'landing_page',
          name: 'pilot-homepage-copy.md',
          description: 'Homepage copy draft',
          content: '# Pilot\nAutonomous founder OS',
        },
        { workspaceId, taskId, actionId },
      );

      expect(result).toEqual({ error: 'evidence ledger unavailable' });
      expect(insertedArtifacts).toEqual([]);
      expect(insertedArtifactVersions).toEqual([]);
      expect(insertedEvidenceItems).toEqual([]);
      expect(insertedAudit).toEqual([]);
      expect(updatedAudit).toEqual([]);
    });
  });

  describe('built-in: operator.computer_use', () => {
    const workspaceId = '00000000-0000-4000-8000-000000000001';
    const taskId = '00000000-0000-4000-8000-000000000002';
    const operatorId = '00000000-0000-4000-8000-000000000003';
    const actionId = '00000000-0000-4000-8000-000000000004';
    const evidencePackId = '00000000-0000-4000-8000-000000000005';

    it('fails closed when helm-client is not wired', async () => {
      const registry = createRegistry();
      const result = await registry.execute(
        'operator.computer_use',
        {
          workspaceId,
          operation: 'terminal_command',
          objective: 'Check repository path',
          command: 'pwd',
        },
        brokeredToolContext({ workspaceId, taskId, operatorId, actionId }),
      );

      expect(result).toEqual({
        error:
          'operator.computer_use requires packages/helm-client wiring; refusing to create an out-of-band computer-use path',
        capability: getCapabilityRecord('computer_use'),
      });
    });

    it('requires Tool Broker action lineage before real execution', async () => {
      const helmClient = {
        evaluateOperatorComputerUse: vi.fn(async () => ({
          status: 'approved_for_execution',
          receipt: {
            decisionId: 'dec-1',
            policyVersion: 'founder-ops-v1',
            verdict: 'ALLOW',
            receivedAt: new Date(),
            action: 'OPERATOR_COMPUTER_USE',
            resource: 'pwd',
            principal: `workspace:${workspaceId}/operator:agent`,
          },
        })),
      };
      const registry = createRegistry({ helmClient });

      const result = await registry.execute('operator.computer_use', {
        workspaceId,
        operation: 'terminal_command',
        objective: 'Check repository path',
        command: 'pwd',
      });

      expect(helmClient.evaluateOperatorComputerUse).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        error:
          'Tool operator.computer_use requires Tool Broker + HELM context for elevated execution',
        missingContext: expect.arrayContaining([
          'tool_broker_context',
          'workspaceId',
          'taskId',
          'actionId',
          'policyDecisionId',
          'policyVersion',
        ]),
        manifest: {
          key: 'operator.computer_use',
          riskClass: 'high',
          effectLevel: 'E3',
        },
      });
    });

    it('uses HELM, executes an allowlisted local command, and persists evidence', async () => {
      const {
        db,
        insertedComputerActions,
        insertedEvidenceItems,
        insertedAudit,
        updatedComputerActions,
        updatedAudit,
        transactionInsertOrder,
      } = createComputerActionDb();
      const helmClient = {
        evaluateOperatorComputerUse: vi.fn(async () => ({
          status: 'approved_for_execution',
          evidencePackId,
          receipt: {
            decisionId: 'dec-1',
            policyVersion: 'founder-ops-v1',
            verdict: 'ALLOW',
            receivedAt: new Date(),
            action: 'OPERATOR_COMPUTER_USE',
            resource: 'pwd',
            principal: `workspace:${workspaceId}/operator:${operatorId}`,
          },
          request: {
            workspaceId,
            objective: 'Check repository path',
            environment: 'local',
            operation: 'terminal_command',
            maxSteps: 12,
          },
        })),
      };
      const registry = createRegistryWithDb(db, { helmClient });

      const result = await registry.execute(
        'operator.computer_use',
        {
          operation: 'terminal_command',
          objective: 'Check repository path',
          command: 'pwd',
          cwd: '.',
        },
        brokeredToolContext({ workspaceId, taskId, operatorId, actionId }),
      );

      expect(helmClient.evaluateOperatorComputerUse).toHaveBeenCalledWith(
        expect.objectContaining({
          principal: `workspace:${workspaceId}/operator:${operatorId}`,
          objective: 'Check repository path',
          environment: 'local',
          operation: 'terminal_command',
          command: 'pwd',
          maxSteps: 12,
        }),
      );
      expect(insertedComputerActions[0]).toMatchObject({
        workspaceId,
        taskId,
        toolActionId: actionId,
        operatorId,
        actionType: 'terminal_command',
        status: 'running',
        policyDecisionId: 'dec-1',
        policyVersion: 'founder-ops-v1',
        helmDocumentVersionPins: { computerUsePolicy: 'founder-ops-v1' },
        metadata: {
          helmDocumentVersionPins: { computerUsePolicy: 'founder-ops-v1' },
        },
      });
      expect(updatedComputerActions[0]).toMatchObject({
        status: 'completed',
        exitCode: 0,
        outputHash: expect.stringMatching(/^sha256:/u),
      });
      expect(insertedAudit[0]).toMatchObject({
        id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
        ),
        workspaceId,
        action: 'OPERATOR_COMPUTER_USE',
        actor: `operator:${operatorId}`,
        target: '00000000-0000-4000-8000-000000000010',
        verdict: 'allow',
        metadata: expect.objectContaining({
          computerActionId: '00000000-0000-4000-8000-000000000010',
          operation: 'terminal_command',
          status: 'completed',
          helmDocumentVersionPins: { computerUsePolicy: 'founder-ops-v1' },
        }),
      });
      expect(transactionInsertOrder.indexOf('audit_log')).toBeLessThan(
        transactionInsertOrder.indexOf('evidence_items'),
      );
      const auditEventId = (insertedAudit[0] as { id: string }).id;
      expect(insertedEvidenceItems[0]).toMatchObject({
        workspaceId,
        taskId,
        actionId,
        auditEventId,
        evidencePackId,
        computerActionId: '00000000-0000-4000-8000-000000000010',
        evidenceType: 'computer_action',
        sourceType: 'computer_operator',
        redactionState: 'redacted',
        replayRef: 'computer:00000000-0000-4000-8000-000000000010:0',
        metadata: {
          helmDocumentVersionPins: { computerUsePolicy: 'founder-ops-v1' },
        },
      });
      expect(updatedAudit[0]).toMatchObject({
        metadata: {
          evidenceItemId: '00000000-0000-4000-8000-000000000011',
        },
      });
      expect(result).toMatchObject({
        computerAction: { id: '00000000-0000-4000-8000-000000000010' },
        execution: {
          operation: 'terminal_command',
          environment: 'local',
          status: 'completed',
          command: 'pwd',
        },
        governance: {
          status: 'approved_for_execution',
          decisionId: 'dec-1',
          policyVersion: 'founder-ops-v1',
          helmDocumentVersionPins: { computerUsePolicy: 'founder-ops-v1' },
          evidencePackId,
        },
        evidenceIds: [
          '00000000-0000-4000-8000-000000000010',
          '00000000-0000-4000-8000-000000000011',
          evidencePackId,
        ],
        capability: getCapabilityRecord('computer_use'),
      });
    });

    it('persists denied evidence for destructive commands after HELM approval', async () => {
      const { db, insertedComputerActions, updatedComputerActions } = createComputerActionDb();
      const helmClient = {
        evaluateOperatorComputerUse: vi.fn(async () => ({
          status: 'approved_for_execution',
          evidencePackId,
          receipt: {
            decisionId: 'dec-2',
            policyVersion: 'founder-ops-v1',
            verdict: 'ALLOW',
            receivedAt: new Date(),
            action: 'OPERATOR_COMPUTER_USE',
            resource: 'rm',
            principal: `workspace:${workspaceId}/operator:${operatorId}`,
          },
          request: {
            workspaceId,
            objective: 'Try destructive command',
            environment: 'local',
            operation: 'terminal_command',
            maxSteps: 12,
          },
        })),
      };
      const registry = createRegistryWithDb(db, { helmClient });

      const result = await registry.execute(
        'operator.computer_use',
        {
          operation: 'terminal_command',
          objective: 'Try destructive command',
          command: 'rm',
          args: ['-rf', '.'],
        },
        brokeredToolContext({ workspaceId, taskId, operatorId, actionId }),
      );

      expect(helmClient.evaluateOperatorComputerUse).toHaveBeenCalled();
      expect(insertedComputerActions).toHaveLength(1);
      expect(updatedComputerActions[0]).toMatchObject({
        status: 'denied',
        stderr: 'terminal_command denied destructive executable: rm',
      });
      expect(result).toMatchObject({
        error: 'terminal_command denied destructive executable: rm',
        execution: { status: 'denied' },
        capability: getCapabilityRecord('computer_use'),
      });
    });

    it('denies restricted file paths and records the attempt', async () => {
      const { db, updatedComputerActions } = createComputerActionDb();
      const helmClient = {
        evaluateOperatorComputerUse: vi.fn(async () => ({
          status: 'approved_for_execution',
          evidencePackId,
          receipt: {
            decisionId: 'dec-3',
            policyVersion: 'founder-ops-v1',
            verdict: 'ALLOW',
            receivedAt: new Date(),
            action: 'OPERATOR_COMPUTER_USE',
            resource: '.env',
            principal: `workspace:${workspaceId}/operator:${operatorId}`,
          },
          request: {
            workspaceId,
            objective: 'Read env',
            environment: 'local',
            operation: 'file_read',
            maxSteps: 12,
          },
        })),
      };
      const registry = createRegistryWithDb(db, { helmClient });

      const result = await registry.execute(
        'operator.computer_use',
        {
          operation: 'file_read',
          objective: 'Read env',
          path: '.env',
        },
        brokeredToolContext({ workspaceId, taskId, operatorId, actionId }),
      );

      expect(updatedComputerActions[0]).toMatchObject({
        status: 'denied',
        stderr: expect.stringContaining('restricted environment-file boundary'),
      });
      expect(result).toMatchObject({
        error: expect.stringContaining('restricted environment-file boundary'),
        capability: getCapabilityRecord('computer_use'),
      });
    });

    it('denies restricted path arguments for otherwise allowlisted commands', async () => {
      const { db, updatedComputerActions } = createComputerActionDb();
      const helmClient = {
        evaluateOperatorComputerUse: vi.fn(async () => ({
          status: 'approved_for_execution',
          evidencePackId,
          receipt: {
            decisionId: 'dec-4',
            policyVersion: 'founder-ops-v1',
            verdict: 'ALLOW',
            receivedAt: new Date(),
            action: 'OPERATOR_COMPUTER_USE',
            resource: 'cat',
            principal: `workspace:${workspaceId}/operator:${operatorId}`,
          },
          request: {
            workspaceId,
            objective: 'Read env through cat',
            environment: 'local',
            operation: 'terminal_command',
            maxSteps: 12,
          },
        })),
      };
      const registry = createRegistryWithDb(db, { helmClient });

      const result = await registry.execute(
        'operator.computer_use',
        {
          operation: 'terminal_command',
          objective: 'Read env through cat',
          command: 'cat',
          args: ['.env'],
        },
        brokeredToolContext({ workspaceId, taskId, operatorId, actionId }),
      );

      expect(updatedComputerActions[0]).toMatchObject({
        status: 'denied',
        stderr: expect.stringContaining('restricted environment-file boundary'),
      });
      expect(result).toMatchObject({
        error: expect.stringContaining('restricted environment-file boundary'),
        capability: getCapabilityRecord('computer_use'),
      });
    });

    it('does not mark a computer action complete when final evidence persistence fails', async () => {
      const {
        db,
        insertedComputerActions,
        insertedEvidenceItems,
        insertedAudit,
        updatedComputerActions,
        updatedAudit,
      } = createComputerActionDb({ failEvidenceInsert: true });
      const helmClient = {
        evaluateOperatorComputerUse: vi.fn(async () => ({
          status: 'approved_for_execution',
          evidencePackId,
          receipt: {
            decisionId: 'dec-evidence-fail',
            policyVersion: 'founder-ops-v1',
            verdict: 'ALLOW',
            receivedAt: new Date(),
            action: 'OPERATOR_COMPUTER_USE',
            resource: 'pwd',
            principal: `workspace:${workspaceId}/operator:${operatorId}`,
          },
          request: {
            workspaceId,
            objective: 'Check repository path',
            environment: 'local',
            operation: 'terminal_command',
            maxSteps: 12,
          },
        })),
      };
      const registry = createRegistryWithDb(db, { helmClient });

      const result = await registry.execute(
        'operator.computer_use',
        {
          operation: 'terminal_command',
          objective: 'Check repository path',
          command: 'pwd',
          cwd: '.',
        },
        brokeredToolContext({ workspaceId, taskId, operatorId, actionId }),
      );

      expect(insertedComputerActions).toHaveLength(1);
      expect(updatedComputerActions).toEqual([]);
      expect(insertedEvidenceItems).toEqual([]);
      expect(insertedAudit).toEqual([]);
      expect(updatedAudit).toEqual([]);
      expect(result).toEqual({ error: 'evidence ledger unavailable' });
    });

    it('does not run or persist local action evidence when HELM approval fails', async () => {
      const { db, insertedComputerActions } = createComputerActionDb();
      const helmClient = {
        evaluateOperatorComputerUse: vi.fn(async () => {
          throw new Error('receipt persistence failed');
        }),
      };
      const registry = createRegistryWithDb(db, { helmClient });

      const result = await registry.execute(
        'operator.computer_use',
        {
          operation: 'terminal_command',
          objective: 'Check repository path',
          command: 'pwd',
        },
        brokeredToolContext({ workspaceId, taskId, operatorId, actionId }),
      );

      expect(insertedComputerActions).toHaveLength(0);
      expect(result).toEqual({ error: 'receipt persistence failed' });
    });
  });

  describe('built-in: operator.browser_read', () => {
    const workspaceId = '00000000-0000-4000-8000-000000000001';
    const taskId = '00000000-0000-4000-8000-000000000002';
    const sessionId = '00000000-0000-4000-8000-000000000003';
    const grantId = '00000000-0000-4000-8000-000000000004';
    const actionId = '00000000-0000-4000-8000-000000000006';

    function createBrowserReadDb(options: { failEvidenceInsert?: boolean } = {}) {
      const selectResults = [
        [{ id: sessionId, allowedOrigins: ['https://www.ycombinator.com'] }],
        [
          {
            id: grantId,
            allowedOrigins: ['https://www.ycombinator.com'],
            grantedToType: 'agent',
            grantedToId: null,
          },
        ],
      ];
      const inserted: unknown[] = [];
      const captureInsert = (sink: unknown[]) =>
        vi.fn(() => ({
          values: vi.fn((value: unknown) => {
            const isBrowserAction =
              typeof value === 'object' &&
              value !== null &&
              'actionType' in (value as Record<string, unknown>);
            const isEvidenceItem =
              typeof value === 'object' &&
              value !== null &&
              'evidenceType' in (value as Record<string, unknown>);
            sink.push(value);
            return {
              returning: vi.fn(async () => {
                if (isEvidenceItem && options.failEvidenceInsert) {
                  throw new Error('browser evidence unavailable');
                }
                return [
                  isBrowserAction
                    ? {
                        id: 'browser-action-1',
                        replayIndex: 0,
                        evidencePackId: (value as { evidencePackId?: string }).evidencePackId,
                      }
                    : isEvidenceItem
                      ? {
                          id: 'evidence-item-1',
                        }
                      : {
                          id: 'obs-1',
                          domHash: (value as { domHash?: string }).domHash,
                          evidencePackId: (value as { evidencePackId?: string }).evidencePackId,
                        },
                ];
              }),
            };
          }),
        }));
      const db: any = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => selectResults.shift() ?? []),
            })),
          })),
        })),
        insert: captureInsert(inserted),
        transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
          const staged: unknown[] = [];
          const tx = { insert: captureInsert(staged) };
          const result = await callback(tx);
          inserted.push(...staged);
          return result;
        }),
      };
      return { db, inserted };
    }

    it('fails closed when helm-client is not wired', async () => {
      const registry = createRegistry();
      const result = await registry.execute(
        'operator.browser_read',
        {
          workspaceId,
          sessionId,
          grantId,
          url: 'https://www.ycombinator.com/account',
          domSnapshot: '<main>account</main>',
        },
        brokeredToolContext({ workspaceId, taskId, actionId }),
      );

      expect(result).toEqual({
        error:
          'operator.browser_read requires packages/helm-client wiring; refusing to create an out-of-band browser read path',
        capability: getCapabilityRecord('browser_execution'),
      });
    });

    it('uses HELM, redacts sensitive values, and persists the browser observation', async () => {
      const { db, inserted } = createBrowserReadDb();
      const helmClient = {
        evaluateOperatorBrowserRead: vi.fn(async () => ({
          status: 'approved_for_read',
          receipt: { decisionId: 'dec-browser', policyVersion: 'founder-ops-v1' },
          evidencePackId: '00000000-0000-4000-8000-000000000005',
        })),
      };
      const registry = createRegistryWithDb(db, { helmClient });

      const result = await registry.execute(
        'operator.browser_read',
        {
          workspaceId,
          taskId,
          sessionId,
          grantId,
          url: 'https://www.ycombinator.com/account',
          title: 'YC Account',
          domSnapshot: '<input name="password" value="super-secret">',
          extractedData: {
            company: 'Pilot',
            sessionToken: 'should-not-persist',
          },
          metadata: {
            authorization: 'Bearer abc123',
          },
        },
        brokeredToolContext({ workspaceId, taskId, actionId }),
      );

      expect(helmClient.evaluateOperatorBrowserRead).toHaveBeenCalledWith(
        expect.objectContaining({
          principal: `workspace:${workspaceId}/browser:${sessionId}`,
          sessionId,
          grantId,
          url: 'https://www.ycombinator.com/account',
        }),
      );
      expect(result).toMatchObject({
        browserAction: {
          id: 'browser-action-1',
          evidencePackId: '00000000-0000-4000-8000-000000000005',
        },
        observation: {
          id: 'obs-1',
          evidencePackId: '00000000-0000-4000-8000-000000000005',
        },
        governance: {
          decisionId: 'dec-browser',
          policyVersion: 'founder-ops-v1',
          helmDocumentVersionPins: { browserReadPolicy: 'founder-ops-v1' },
        },
        evidenceItemId: 'evidence-item-1',
        capability: getCapabilityRecord('browser_execution'),
      });
      expect(inserted[0]).toMatchObject({
        workspaceId,
        sessionId,
        grantId,
        actionType: 'read_extract',
        origin: 'https://www.ycombinator.com',
        policyDecisionId: 'dec-browser',
        helmDocumentVersionPins: { browserReadPolicy: 'founder-ops-v1' },
      });
      expect(inserted[1]).toMatchObject({
        workspaceId,
        sessionId,
        grantId,
        browserActionId: 'browser-action-1',
        origin: 'https://www.ycombinator.com',
        redactedDomSnapshot: '<input name="password" value="[REDACTED]">',
        extractedData: {
          company: 'Pilot',
          sessionToken: '[REDACTED]',
        },
        metadata: {
          authorization: '[REDACTED]',
          helmDecisionId: 'dec-browser',
          helmPolicyVersion: 'founder-ops-v1',
          helmDocumentVersionPins: { browserReadPolicy: 'founder-ops-v1' },
          credentialBoundary: 'read_only_no_cookie_or_password_export',
        },
      });
      expect((inserted[1] as { domHash?: string }).domHash).toMatch(/^sha256:/u);
      expect(inserted[2]).toMatchObject({
        workspaceId,
        taskId,
        evidencePackId: '00000000-0000-4000-8000-000000000005',
        browserObservationId: 'obs-1',
        evidenceType: 'browser_observation',
        sourceType: 'browser_operator',
        redactionState: 'redacted',
        contentHash: expect.stringMatching(/^sha256:/u),
        replayRef: `browser:${sessionId}:0`,
        metadata: {
          helmDocumentVersionPins: { browserReadPolicy: 'founder-ops-v1' },
        },
      });
    });

    it('does not commit browser action or observation when final evidence persistence fails', async () => {
      const { db, inserted } = createBrowserReadDb({ failEvidenceInsert: true });
      const helmClient = {
        evaluateOperatorBrowserRead: vi.fn(async () => ({
          status: 'approved_for_read',
          receipt: { decisionId: 'dec-browser', policyVersion: 'founder-ops-v1' },
          evidencePackId: '00000000-0000-4000-8000-000000000005',
        })),
      };
      const registry = createRegistryWithDb(db, { helmClient });

      const result = await registry.execute(
        'operator.browser_read',
        {
          workspaceId,
          taskId,
          sessionId,
          grantId,
          url: 'https://www.ycombinator.com/account',
          title: 'YC Account',
          domSnapshot: '<main>company</main>',
          extractedData: { company: 'Pilot' },
        },
        brokeredToolContext({ workspaceId, taskId, actionId }),
      );

      expect(inserted).toEqual([]);
      expect(result).toEqual({ error: 'browser evidence unavailable' });
    });
  });

  describe('built-in: score_opportunity', () => {
    it('returns an evidence-backed scorecard and persists score rows', async () => {
      const insertValues = vi.fn(async () => []);
      const updateWhere = vi.fn(async () => []);
      const updateSet = vi.fn(() => ({ where: updateWhere }));
      const db = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [
                {
                  id: 'opp-1',
                  title: 'AI compliance workflow for finance teams',
                  description:
                    'Finance teams have urgent, manual, expensive compliance workflows with clear ROI and paid budget.',
                  source: 'yc',
                  sourceUrl: 'https://example.com/source',
                  rawData: { quote: 'manual process is slow' },
                  aiFriendlyOk: true,
                },
              ]),
            })),
          })),
        })),
        insert: vi.fn(() => ({ values: insertValues })),
        update: vi.fn(() => ({ set: updateSet })),
      };
      Object.assign(db, {
        transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
      });
      const registry = createRegistryWithDb(db);

      const result = await registry.execute('score_opportunity', {
        opportunityId: 'opp-1',
        founderSignals: ['finance automation', 'compliance'],
        citations: [{ url: 'https://example.com/source', title: 'Source' }],
        policyDecisionId: 'dec-score-tool',
        policyVersion: 'local:tool-broker:evidence_v1:E1',
        helmDocumentVersionPins: { toolAccessPolicy: 'local:tool-broker:evidence_v1:E1' },
      });

      expect(result).toMatchObject({
        opportunityId: 'opp-1',
        method: 'evidence_v1',
        capability: getCapabilityRecord('opportunity_scoring'),
        dimensions: {
          marketPain: expect.any(Number),
          urgency: expect.any(Number),
          icpClarity: expect.any(Number),
          monetization: expect.any(Number),
          channelAccessibility: expect.any(Number),
          competition: expect.any(Number),
          founderFit: expect.any(Number),
          technicalFeasibility: expect.any(Number),
          evidenceQuality: expect.any(Number),
          confidence: expect.any(Number),
        },
      });
      expect((result as { overall: number }).overall).toBeGreaterThan(0);
      expect((result as { assumptions: string[] }).assumptions.length).toBeGreaterThan(0);
      expect((result as { citations: unknown[] }).citations).toHaveLength(1);
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          opportunityId: 'opp-1',
          scoringMethod: 'evidence_v1',
          policyDecisionId: 'dec-score-tool',
          policyVersion: 'local:tool-broker:evidence_v1:E1',
          helmDocumentVersionPins: { toolAccessPolicy: 'local:tool-broker:evidence_v1:E1' },
          modelUsage: {},
        }),
      );
      expect(updateSet).toHaveBeenCalledWith({ status: 'scored' });
      expect(db.transaction).toHaveBeenCalledOnce();
    }, 10_000);

    it('does not commit score row when opportunity status update fails', async () => {
      const committedScores: unknown[] = [];
      const committedOpportunityUpdates: unknown[] = [];
      const db = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [
                {
                  id: 'opp-1',
                  title: 'AI compliance workflow for finance teams',
                  description:
                    'Finance teams have urgent, manual, expensive compliance workflows with clear ROI and paid budget.',
                  source: 'yc',
                  sourceUrl: 'https://example.com/source',
                  rawData: { quote: 'manual process is slow' },
                  aiFriendlyOk: true,
                },
              ]),
            })),
          })),
        })),
        insert: vi.fn(() => {
          throw new Error('score_opportunity state must be persisted inside a transaction');
        }),
        update: vi.fn(() => {
          throw new Error('score_opportunity state must be persisted inside a transaction');
        }),
        transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
          const stagedScores: unknown[] = [];
          const stagedOpportunityUpdates: unknown[] = [];
          const tx = {
            insert: vi.fn((table: unknown) => ({
              values: vi.fn((value: unknown) => {
                if (table === opportunityScores) {
                  stagedScores.push(value);
                  return Promise.resolve([]);
                }
                return Promise.resolve([]);
              }),
            })),
            update: vi.fn((table: unknown) => ({
              set: vi.fn((value: unknown) => {
                if (table === opportunities) stagedOpportunityUpdates.push(value);
                return {
                  where: vi.fn(async () => {
                    throw new Error('opportunity status update failed');
                  }),
                };
              }),
            })),
          };
          const result = await callback(tx);
          committedScores.push(...stagedScores);
          committedOpportunityUpdates.push(...stagedOpportunityUpdates);
          return result;
        }),
      };
      const registry = createRegistryWithDb(db);

      const result = await registry.execute('score_opportunity', {
        opportunityId: 'opp-1',
        founderSignals: ['finance automation', 'compliance'],
        citations: [{ url: 'https://example.com/source', title: 'Source' }],
      });

      expect(result).toEqual({ error: 'opportunity status update failed' });
      expect(db.transaction).toHaveBeenCalledOnce();
      expect(committedScores).toEqual([]);
      expect(committedOpportunityUpdates).toEqual([]);
    }, 10_000);

    it('exposes a typed manifest for opportunity scoring', () => {
      const registry = createRegistry();

      expect(registry.getToolManifest('score_opportunity')).toMatchObject({
        key: 'score_opportunity',
        version: 'evidence_v1',
        riskClass: 'low',
        effectLevel: 'E1',
        requiredEvidence: ['opportunity_score', 'citations'],
        permissionRequirements: ['opportunity:score'],
      });
    });
  });

  describe('built-in: search_knowledge', () => {
    it('returns error when memory service is not available', async () => {
      const registry = createRegistry(); // no memory
      const result = await registry.execute('search_knowledge', { query: 'test' });

      expect(result).toEqual({ error: 'Memory service not available' });
    });

    it('calls memory.search with query and default limit', async () => {
      const mockMemory = {
        search: vi.fn(async () => [{ id: '1', title: 'Result' }]),
      };
      const registry = createRegistry({ memory: mockMemory });

      const result = await registry.execute('search_knowledge', { query: 'funding' });

      expect(mockMemory.search).toHaveBeenCalledWith('funding', { limit: 5 });
      expect(result).toEqual([{ id: '1', title: 'Result' }]);
    });

    it('respects custom limit', async () => {
      const mockMemory = {
        search: vi.fn(async () => []),
      };
      const registry = createRegistry({ memory: mockMemory });

      await registry.execute('search_knowledge', { query: 'test', limit: 10 });

      expect(mockMemory.search).toHaveBeenCalledWith('test', { limit: 10 });
    });

    it('uses server-bound workspace for memory retrieval when context is present', async () => {
      const mockMemory = {
        search: vi.fn(async () => []),
      };
      const registry = createRegistry({ memory: mockMemory });

      await registry.execute(
        'search_knowledge',
        { query: 'test', workspaceId: 'spoofed-ws' },
        { workspaceId: 'server-ws', taskId: 'server-task' },
      );

      expect(mockMemory.search).toHaveBeenCalledWith('test', {
        limit: 5,
        workspaceId: 'server-ws',
      });
    });
  });

  describe('built-in: create_note', () => {
    it('returns error when memory service is not available', async () => {
      const registry = createRegistry(); // no memory
      const result = await registry.execute('create_note', {
        title: 'Test',
        content: 'Body',
      });

      expect(result).toEqual({ error: 'Memory service not available' });
    });

    it('calls memory.upsertPage and returns id + title', async () => {
      const mockMemory = {
        search: vi.fn(),
        upsertPage: vi.fn(async () => 'page-123'),
      };
      const registry = createRegistry({ memory: mockMemory });

      const result = await registry.execute('create_note', {
        title: 'Insight',
        content: 'Some important finding',
        tags: ['research'],
      });

      expect(mockMemory.upsertPage).toHaveBeenCalledWith({
        type: 'concept',
        title: 'Insight',
        compiledTruth: 'Some important finding',
        tags: ['research'],
        content: 'Some important finding',
      });
      expect(result).toEqual({ id: 'page-123', title: 'Insight' });
    });

    it('truncates compiledTruth to 500 characters', async () => {
      const mockMemory = {
        search: vi.fn(),
        upsertPage: vi.fn(async () => 'page-456'),
      };
      const registry = createRegistry({ memory: mockMemory });

      const longContent = 'x'.repeat(1000);
      await registry.execute('create_note', {
        title: 'Long',
        content: longContent,
      });

      const call = (mockMemory.upsertPage.mock.calls as unknown[][])[0]![0] as {
        compiledTruth: string;
        content: string;
      };
      expect(call.compiledTruth).toHaveLength(500);
      expect(call.content).toHaveLength(1000);
    });
  });
});
