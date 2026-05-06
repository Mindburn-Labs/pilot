import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { commandCenterRoutes } from '../../routes/command-center.js';
import { createMockDeps, expectJson } from '../helpers.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const wsHeader = { 'X-Workspace-Id': workspaceId };

function createCommandCenterDb(selectResults: unknown[][] = []) {
  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => {
        const chain = {
          where: vi.fn(() => chain),
          orderBy: vi.fn(() => chain),
          limit: vi.fn(async () => selectResults.shift() ?? []),
          then: (resolve: (value: unknown[]) => void) => resolve(selectResults.shift() ?? []),
        };
        return chain;
      }),
    })),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(async () => [{ '?column?': 1 }]),
    _setResult: vi.fn(),
    _reset: vi.fn(),
  };
  return db;
}

function createApp(selectResults: unknown[][] = []) {
  const db = createCommandCenterDb(selectResults);
  const deps = createMockDeps({ db: db as never });
  const app = new Hono();
  app.use('*', async (c, next) => {
    const id = c.req.header('X-Workspace-Id');
    if (id) c.set('workspaceId', id);
    c.set('workspaceRole', c.req.header('X-Workspace-Role') ?? 'owner');
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/', commandCenterRoutes(deps));
  return {
    db,
    fetch(method: string, path: string, headers?: Record<string, string>) {
      return app.fetch(
        new Request(`http://localhost${path}`, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
        }),
      );
    },
  };
}

describe('commandCenterRoutes', () => {
  it('requires workspace scope', async () => {
    const { fetch } = createApp();
    const res = await fetch('GET', '/');
    const body = await expectJson<{ error: string }>(res, 400);

    expect(body.error).toContain('workspaceId');
  });

  it('requires partner role to inspect command-center state', async () => {
    const { fetch, db } = createApp();
    const res = await fetch('GET', '/', {
      ...wsHeader,
      'X-Workspace-Role': 'member',
    });
    const body = await expectJson<{ error: string; requiredRole: string }>(res, 403);

    expect(body.error).toBe('insufficient workspace role');
    expect(body.requiredRole).toBe('partner');
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns a first-class workspace permission graph without raw policy values', async () => {
    const { fetch } = createApp([
      [
        {
          id: 'member-1',
          workspaceId,
          userId: 'user-secret',
          role: 'owner',
          joinedAt: new Date('2026-05-05T08:00:00Z'),
        },
      ],
      [
        {
          id: 'operator-1',
          workspaceId,
          name: 'Opportunity Scout',
          role: 'scout',
          goal: 'Find opportunities',
          constraints: ['no_external_posting'],
          tools: ['score_opportunity', 'token=abc'],
          isActive: 'true',
          createdAt: new Date('2026-05-05T08:01:00Z'),
        },
      ],
      [
        {
          id: 'settings-1',
          workspaceId,
          policyConfig: {
            mode: 'build',
            apiToken: 'do-not-return',
            toolBlocklist: ['operator.computer_use'],
          },
        },
      ],
    ]);

    const res = await fetch('GET', '/permission-graph', wsHeader);
    const body = await expectJson<{
      productionReady: boolean;
      redactionContract: string;
      graph: {
        nodes: Array<{
          id: string;
          kind: string;
          label: string;
          state?: string;
          metadata: Record<string, unknown>;
        }>;
        edges: Array<{ from: string; to: string; relation: string; status: string }>;
      };
      blockers: string[];
    }>(res, 200);

    expect(body.productionReady).toBe(false);
    expect(body.redactionContract).toContain('raw policy values are withheld');
    expect(body.graph.nodes.some((node) => node.id === `workspace:${workspaceId}`)).toBe(true);
    expect(body.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'workspace-role:current',
          label: 'Current role owner',
          state: 'allowed',
        }),
        expect.objectContaining({
          id: 'operator:operator-1',
          label: 'Opportunity Scout',
          metadata: expect.objectContaining({ toolCount: 1 }),
        }),
        expect.objectContaining({
          id: 'tool-scope:score_opportunity',
          label: 'score_opportunity',
        }),
      ]),
    );
    expect(body.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'operator:operator-1',
          to: 'tool-scope:score_opportunity',
          relation: 'declares_tool_scope',
          status: 'configured',
        }),
        expect.objectContaining({
          from: 'policy-config',
          to: 'capability:helm_receipts',
          relation: 'constrains_capability',
          status: 'requires_eval',
        }),
      ]),
    );
    expect(body.blockers.join(' ')).toContain('read-only command-center introspection');
    expect(JSON.stringify(body)).not.toContain('do-not-return');
    expect(JSON.stringify(body)).not.toContain('user-secret');
    expect(JSON.stringify(body)).not.toContain('token=abc');
    expect(JSON.stringify(body)).not.toContain('apiToken');
  });

  it('returns a read-only durable mission graph without production promotion', async () => {
    const missionId = 'mission-1';
    const { fetch } = createApp([
      [
        {
          id: missionId,
          workspaceId,
          missionKey: 'pmf-discovery',
          title: 'PMF Discovery',
          status: 'scheduled',
          autonomyMode: 'review',
          capabilityState: 'prototype',
          productionReady: false,
          updatedAt: new Date('2026-05-05T08:00:00Z'),
        },
      ],
      [
        {
          id: 'node-1',
          workspaceId,
          missionId,
          nodeKey: 'research',
          stage: 'market_research',
          title: 'Research market',
          objective: 'Collect evidence',
          status: 'ready',
          sortOrder: 1,
          requiredAgents: ['opportunity_scout'],
          requiredTools: ['score_opportunity'],
        },
      ],
      [
        {
          id: 'edge-1',
          workspaceId,
          missionId,
          edgeKey: 'research-to-score',
          fromNodeKey: 'research',
          toNodeKey: 'score',
          reason: 'Evidence precedes scoring',
        },
      ],
      [
        {
          id: 'mission-task-1',
          workspaceId,
          missionId,
          nodeId: 'node-1',
          taskId: 'task-1',
          role: 'execution_task',
          createdAt: new Date('2026-05-05T08:01:00Z'),
        },
      ],
      [
        {
          id: 'evidence-checkpoint-1',
          workspaceId,
          missionId,
          evidenceType: 'startup_lifecycle_mission_checkpoint',
          sourceType: 'gateway_startup_lifecycle',
          title: 'Startup lifecycle mission checkpoint: PMF Discovery',
          replayRef: `mission:${missionId}:checkpoint:abc123`,
          redactionState: 'redacted',
          observedAt: new Date('2026-05-05T08:02:00Z'),
        },
        {
          id: 'evidence-recovery-1',
          workspaceId,
          missionId,
          evidenceType: 'startup_lifecycle_recovery_plan',
          sourceType: 'gateway_startup_lifecycle',
          title: 'Startup lifecycle recovery plan: PMF Discovery',
          replayRef: `mission:${missionId}:recovery-plan:def456`,
          redactionState: 'redacted',
          observedAt: new Date('2026-05-05T08:03:00Z'),
        },
        {
          id: 'evidence-recovery-apply-1',
          workspaceId,
          missionId,
          evidenceType: 'startup_lifecycle_recovery_applied',
          sourceType: 'gateway_startup_lifecycle',
          title: 'Startup lifecycle recovery applied: PMF Discovery',
          replayRef: `mission:${missionId}:recovery-apply:fed789`,
          redactionState: 'redacted',
          observedAt: new Date('2026-05-05T08:04:00Z'),
        },
        {
          id: 'evidence-rollback-1',
          workspaceId,
          missionId,
          evidenceType: 'startup_lifecycle_mission_rollback_applied',
          sourceType: 'gateway_startup_lifecycle',
          title: 'Startup lifecycle mission rollback: PMF Discovery',
          replayRef: `mission:${missionId}:rollback:abc999`,
          redactionState: 'redacted',
          observedAt: new Date('2026-05-05T08:05:00Z'),
        },
      ],
    ]);

    const res = await fetch('GET', `/mission-graph?missionId=${missionId}`, wsHeader);
    const body = await expectJson<{
      productionReady: boolean;
      missionId: string;
      graph: {
        missions: Array<{ id: string; title: string; productionReady: boolean }>;
        nodes: Array<{ nodeKey: string; status: string }>;
        edges: Array<{ fromNodeKey: string; toNodeKey: string }>;
        taskLinks: Array<{ taskId: string; nodeId: string }>;
        recovery: {
          checkpoints: Array<{ id: string; replayRef: string }>;
          recoveryPlans: Array<{ id: string; replayRef: string }>;
          recoveryApplies: Array<{ id: string; replayRef: string }>;
          rollbacks: Array<{ id: string; replayRef: string }>;
        };
        orderedBy: string[];
      };
      blockers: string[];
    }>(res, 200);

    expect(body.productionReady).toBe(false);
    expect(body.missionId).toBe(missionId);
    expect(body.graph.missions[0]).toMatchObject({
      id: missionId,
      title: 'PMF Discovery',
      productionReady: false,
    });
    expect(body.graph.nodes[0]).toMatchObject({ nodeKey: 'research', status: 'ready' });
    expect(body.graph.edges[0]).toMatchObject({
      fromNodeKey: 'research',
      toNodeKey: 'score',
    });
    expect(body.graph.taskLinks[0]).toMatchObject({ taskId: 'task-1', nodeId: 'node-1' });
    expect(body.graph.recovery.checkpoints[0]).toMatchObject({
      id: 'evidence-checkpoint-1',
      replayRef: `mission:${missionId}:checkpoint:abc123`,
    });
    expect(body.graph.recovery.recoveryPlans[0]).toMatchObject({
      id: 'evidence-recovery-1',
      replayRef: `mission:${missionId}:recovery-plan:def456`,
    });
    expect(body.graph.recovery.recoveryApplies[0]).toMatchObject({
      id: 'evidence-recovery-apply-1',
      replayRef: `mission:${missionId}:recovery-apply:fed789`,
    });
    expect(body.graph.recovery.rollbacks[0]).toMatchObject({
      id: 'evidence-rollback-1',
      replayRef: `mission:${missionId}:rollback:abc999`,
    });
    expect(body.graph.orderedBy).toContain('node.sortOrder');
    expect(body.graph.orderedBy).toContain('recoveryEvidence.observedAt');
    expect(body.blockers.join(' ')).toContain(
      'do not dispatch, apply recovery, roll back, or resume',
    );
  });

  it('returns read-only eval status and promotion eligibility without registry mutation', async () => {
    const { fetch } = createApp([
      [
        {
          id: 'eval-run-1',
          workspaceId,
          evalId: 'helm_governance',
          status: 'failed',
          capabilityKey: 'helm_receipts',
          runRef: 'eval:helm_governance',
          failureReason: 'token=abc missing receipt evidence',
          evidenceRefs: ['evidence:helm'],
          auditReceiptRefs: ['audit:helm'],
          metadata: { apiToken: 'do-not-return', note: 'safe' },
          createdAt: new Date('2026-05-05T08:00:00Z'),
        },
      ],
      [
        {
          id: 'promotion-1',
          workspaceId,
          capabilityKey: 'workspace_rbac',
          evalRunId: 'eval-run-2',
          status: 'eligible',
          promotedState: 'production_ready',
          evidenceRefs: ['evidence:rbac'],
          auditReceiptRefs: ['audit:rbac'],
          createdAt: new Date('2026-05-05T09:00:00Z'),
        },
      ],
      [
        {
          id: 'eval-result-1',
          workspaceId,
          evalRunId: 'eval-run-1',
          evalId: 'helm_governance',
          capabilityKey: 'helm_receipts',
          status: 'failed',
          passed: false,
          summary: 'token=abc result summary',
          blockers: ['apiToken missing'],
          createdAt: new Date('2026-05-05T08:01:00Z'),
        },
      ],
      [
        {
          id: 'eval-step-1',
          evalRunId: 'eval-run-1',
          stepKey: 'receipt-persistence',
          status: 'failed',
          evidenceRefs: ['evidence:token=abc'],
          auditReceiptRefs: ['audit:helm'],
          metadata: { apiToken: 'do-not-return' },
          completedAt: new Date('2026-05-05T08:02:00Z'),
        },
      ],
      [
        {
          id: 'eval-evidence-link-1',
          workspaceId,
          evalRunId: 'eval-run-1',
          evidenceRef: 'evidence:token=abc',
          auditReceiptRef: 'audit:helm',
          createdAt: new Date('2026-05-05T08:03:00Z'),
        },
      ],
    ]);

    const res = await fetch('GET', '/eval-status', wsHeader);
    const body = await expectJson<{
      productionReady: boolean;
      promotionRule: string;
      evals: {
        scenarios: Array<{ id: string; capabilityKeys: string[] }>;
        recentRuns: Array<{
          id: string;
          evalId: string;
          status: string;
          failureReason: string;
          metadata: Record<string, unknown>;
        }>;
        results: Array<{
          id: string;
          evalRunId: string;
          status: string;
          summary: string;
          blockers: string[];
        }>;
        steps: Array<{
          id: string;
          evalRunId: string;
          stepKey: string;
          status: string;
          evidenceRefs: string[];
          metadata: Record<string, unknown>;
        }>;
        evidenceLinks: Array<{
          id: string;
          evidenceRef: string;
          auditReceiptRef: string;
        }>;
        promotions: Array<{ capabilityKey: string; promotedState: string; status: string }>;
        orderedBy: string[];
      };
      blockers: string[];
    }>(res, 200);

    expect(body.productionReady).toBe(false);
    expect(body.promotionRule).toContain('never mutates the registry');
    expect(body.evals.scenarios.some((scenario) => scenario.id === 'helm_governance')).toBe(true);
    expect(body.evals.recentRuns[0]).toMatchObject({
      id: 'eval-run-1',
      evalId: 'helm_governance',
      status: 'failed',
      failureReason: 'token=[REDACTED] missing receipt evidence',
      metadata: { apiToken: '[REDACTED]', note: 'safe' },
    });
    expect(body.evals.promotions[0]).toMatchObject({
      capabilityKey: 'workspace_rbac',
      promotedState: 'production_ready',
      status: 'eligible',
    });
    expect(body.evals.results[0]).toMatchObject({
      id: 'eval-result-1',
      evalRunId: 'eval-run-1',
      status: 'failed',
      summary: 'token=[REDACTED] result summary',
      blockers: ['apiToken missing'],
    });
    expect(body.evals.steps[0]).toMatchObject({
      id: 'eval-step-1',
      evalRunId: 'eval-run-1',
      stepKey: 'receipt-persistence',
      status: 'failed',
      evidenceRefs: ['evidence:token=[REDACTED]'],
      metadata: { apiToken: '[REDACTED]' },
    });
    expect(body.evals.evidenceLinks[0]).toMatchObject({
      id: 'eval-evidence-link-1',
      evidenceRef: 'evidence:token=[REDACTED]',
      auditReceiptRef: 'audit:helm',
    });
    expect(body.evals.orderedBy).toContain('evalRun.createdAt');
    expect(body.evals.orderedBy).toContain('evalResult.createdAt');
    expect(body.evals.orderedBy).toContain('evalStep.completedAt');
    expect(body.evals.orderedBy).toContain('evalEvidenceLink.createdAt');
    expect(body.blockers.join(' ')).toContain('does not mark capabilities production_ready');
    expect(JSON.stringify(body)).not.toContain('do-not-return');
    expect(JSON.stringify(body)).not.toContain('token=abc');
  });

  it('requires a replay ref for command-center replay lookup', async () => {
    const { fetch, db } = createApp();
    const res = await fetch('GET', '/replay', wsHeader);
    const body = await expectJson<{ error: string }>(res, 400);

    expect(body.error).toBe('replay ref required');
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns workspace-scoped browser and computer replay rows without production promotion', async () => {
    const replayRef = 'browser:session-1:0';
    const { fetch } = createApp([
      [
        {
          id: 'ev-browser-1',
          workspaceId,
          evidenceType: 'browser_observation',
          sourceType: 'browser_operator',
          title: 'Browser observation',
          redactionState: 'redacted',
          replayRef,
          browserObservationId: 'obs-1',
          computerActionId: 'computer-1',
          observedAt: new Date('2026-05-05T09:00:00Z'),
        },
      ],
      [
        {
          id: 'obs-1',
          workspaceId,
          sessionId: 'session-1',
          url: 'https://www.ycombinator.com/account',
          title: 'YC Account',
          domHash: 'sha256:dom',
          screenshotHash: 'sha256:shot',
          redactedDomSnapshot: '<main>[redacted]</main>',
          extractedData: { applicantName: 'redacted' },
          redactions: ['token'],
          replayIndex: 0,
          observedAt: new Date('2026-05-05T09:00:00Z'),
        },
      ],
      [
        {
          id: 'computer-1',
          workspaceId,
          actionType: 'terminal_command',
          objective: 'Check local server',
          status: 'completed',
          command: 'curl',
          args: ['-I', 'http://localhost:3000'],
          stdout: 'token=abc HTTP/1.1 200 OK',
          replayIndex: 0,
          createdAt: new Date('2026-05-05T09:01:00Z'),
          metadata: { token: 'do-not-return' },
        },
      ],
    ]);

    const res = await fetch('GET', `/replay?ref=${encodeURIComponent(replayRef)}`, wsHeader);
    const body = await expectJson<{
      workspaceId: string;
      replayRef: string;
      productionReady: boolean;
      capability: { key: string; state: string };
      replay: {
        evidenceItems: Array<{ id: string; replayRef: string }>;
        browserObservations: Array<{
          id: string;
          domHash: string;
          redactedDomSnapshot: string;
          replayRef: string;
        }>;
        computerActions: Array<{
          id: string;
          actionType: string;
          replayRef: string;
          stdout: string;
          metadata: Record<string, unknown>;
        }>;
      };
      blockers: string[];
    }>(res, 200);

    expect(body.workspaceId).toBe(workspaceId);
    expect(body.replayRef).toBe(replayRef);
    expect(body.productionReady).toBe(false);
    expect(body.capability.key).toBe('evidence_ledger');
    expect(body.capability.state).toBe('prototype');
    expect(body.replay.evidenceItems[0]?.id).toBe('ev-browser-1');
    expect(body.replay.browserObservations[0]?.domHash).toBe('sha256:dom');
    expect(body.replay.browserObservations[0]?.replayRef).toBe('browser:session-1:0');
    expect(body.replay.browserObservations[0]?.redactedDomSnapshot).toContain('[redacted]');
    expect(body.replay.computerActions[0]?.replayRef).toBe('computer:computer-1:0');
    expect(body.replay.computerActions[0]?.stdout).toContain('200 OK');
    expect(body.replay.computerActions[0]?.stdout).toContain('token=[REDACTED]');
    expect(body.replay.computerActions[0]?.metadata).toMatchObject({ token: '[REDACTED]' });
    expect(JSON.stringify(body)).not.toContain('do-not-return');
    expect(JSON.stringify(body)).not.toContain('token=abc');
    expect(body.blockers.join(' ')).toContain('does not promote');
  });

  it('returns 404 when replay ref has no workspace rows', async () => {
    const { fetch } = createApp([[], []]);
    const res = await fetch('GET', '/replay?ref=browser:missing:0', wsHeader);
    const body = await expectJson<{ error: string }>(res, 404);

    expect(body.error).toBe('Replay ref not found in workspace');
  });

  it('returns real durable rows and capability truth without production-ready inflation', async () => {
    const task = {
      id: 'task-1',
      workspaceId,
      title: 'Score opportunity',
      description: 'Evidence-backed score',
      mode: 'discover',
      status: 'running',
      createdAt: new Date('2026-05-05T08:00:00Z'),
      updatedAt: new Date('2026-05-05T09:00:00Z'),
    };
    const action = {
      id: 'action-1',
      workspaceId,
      actionKey: 'score_opportunity',
      actionType: 'tool',
      riskClass: 'medium',
      status: 'completed',
      policyDecisionId: 'dec-1',
      policyVersion: 'founder-ops-v1',
      startedAt: new Date('2026-05-05T09:01:00Z'),
    };
    const receipt = {
      id: 'ep-1',
      workspaceId,
      decisionId: 'dec-1',
      verdict: 'ALLOW',
      action: 'TOOL_USE',
      resource: 'score_opportunity',
      principal: `workspace:${workspaceId}`,
      policyVersion: 'founder-ops-v1',
      receivedAt: new Date('2026-05-05T09:02:00Z'),
    };
    const { fetch } = createApp([
      [task],
      [
        {
          id: 'run-1',
          taskId: 'task-1',
          status: 'completed',
          actionTool: 'score_opportunity',
          runSequence: 1,
          lineageKind: 'parent_action',
          startedAt: new Date('2026-05-05T09:00:00Z'),
        },
      ],
      [action],
      [
        {
          id: 'tool-1',
          workspaceId,
          actionId: 'action-1',
          toolKey: 'score_opportunity',
          status: 'completed',
          idempotencyKey: 'idem-1',
          inputHash: 'sha256:in',
          outputHash: 'sha256:out',
          evidenceIds: ['ep-1'],
          createdAt: new Date('2026-05-05T09:01:00Z'),
        },
      ],
      [receipt],
      [
        {
          id: 'ev-1',
          workspaceId,
          evidenceType: 'tool_receipt',
          sourceType: 'agent_loop',
          title: 'TOOL_USE ALLOW',
          redactionState: 'redacted',
          evidencePackId: 'ep-1',
          replayRef: 'helm:dec-1',
          observedAt: new Date('2026-05-05T09:02:30Z'),
        },
      ],
      [
        {
          id: 'approval-1',
          workspaceId,
          taskId: 'task-1',
          action: 'EXTERNAL_POST',
          status: 'pending',
          reason: 'Founder approval required',
          requestedAt: new Date('2026-05-05T09:03:00Z'),
        },
      ],
      [
        {
          id: 'audit-1',
          workspaceId,
          action: 'TOOL_EXECUTION_COMPLETED',
          actor: 'agent:opportunity_scout',
          verdict: 'allow',
          createdAt: new Date('2026-05-05T09:04:00Z'),
        },
      ],
      [
        {
          id: 'obs-1',
          workspaceId,
          sessionId: 'browser-session-1',
          url: 'https://www.ycombinator.com/account',
          title: 'YC Account',
          domHash: 'sha256:dom',
          redactions: ['token'],
          replayIndex: 0,
          observedAt: new Date('2026-05-05T09:05:00Z'),
        },
      ],
      [
        {
          id: 'computer-1',
          workspaceId,
          actionType: 'terminal_command',
          command: 'git',
          status: 'completed',
          evidencePackId: 'ep-1',
          replayIndex: 0,
          createdAt: new Date('2026-05-05T09:06:00Z'),
        },
      ],
      [
        {
          id: 'handoff-1',
          workspaceId,
          taskId: 'task-1',
          fromAgent: 'conductor',
          toAgent: 'opportunity_scout',
          status: 'completed',
          createdAt: new Date('2026-05-05T09:07:00Z'),
        },
      ],
      [
        {
          id: 'artifact-1',
          workspaceId,
          type: 'scorecard',
          name: 'Opportunity Score',
          storagePath: 'artifacts/opportunity-score.json',
          updatedAt: new Date('2026-05-05T09:08:00Z'),
        },
      ],
    ]);

    const res = await fetch('GET', '/', wsHeader);
    const body = await expectJson<{
      runtimeTruth: {
        productionReady: boolean;
        commandCenterState: string;
        missionRuntimeState: string;
        statement: string;
      };
      authorization: { workspaceRole: string; requiredRole: string; workspaceId: string };
      capabilities: {
        summary: { productionReady: number };
        records: Array<{ key: string; state: string }>;
      };
      status: {
        activeTasks: number;
        pendingApprovals: number;
        recentEvidence: number;
        evidenceItems: number;
      };
      recent: {
        tasks: Array<{ id: string; title: string }>;
        actions: Array<{ id: string; policyDecisionId: string }>;
        evidencePacks: Array<{ id: string; decisionId: string }>;
        evidenceItems: Array<{ id: string; evidenceType: string; replayRef: string }>;
        browserObservations: Array<{ id: string; domHash: string; replayRef: string }>;
        computerActions: Array<{ id: string; actionType: string; replayRef: string }>;
      };
    }>(res, 200);

    expect(body.runtimeTruth.productionReady).toBe(false);
    expect(body.runtimeTruth.commandCenterState).toBe('prototype');
    expect(body.runtimeTruth.missionRuntimeState).toBe('prototype');
    expect(body.runtimeTruth.statement).toContain('without claiming mission autonomy');
    expect(body.authorization).toEqual({
      workspaceRole: 'owner',
      requiredRole: 'partner',
      workspaceId,
    });
    expect(body.capabilities.summary.productionReady).toBe(0);
    expect(body.capabilities.records.find((record) => record.key === 'command_center')?.state).toBe(
      'prototype',
    );
    expect(body.status.activeTasks).toBe(1);
    expect(body.status.pendingApprovals).toBe(1);
    expect(body.status.recentEvidence).toBe(1);
    expect(body.status.evidenceItems).toBe(1);
    expect(body.recent.tasks[0]?.title).toBe('Score opportunity');
    expect(body.recent.actions[0]?.policyDecisionId).toBe('dec-1');
    expect(body.recent.evidencePacks[0]?.decisionId).toBe('dec-1');
    expect(body.recent.evidenceItems[0]?.replayRef).toBe('helm:dec-1');
    expect(body.recent.browserObservations[0]?.domHash).toBe('sha256:dom');
    expect(body.recent.browserObservations[0]?.replayRef).toBe('browser:browser-session-1:0');
    expect(body.recent.computerActions[0]?.actionType).toBe('terminal_command');
    expect(body.recent.computerActions[0]?.replayRef).toBe('computer:computer-1:0');
  });

  it('returns bounded computer action replay without secret metadata or production promotion', async () => {
    const longOutput = `token=abc ${'x'.repeat(4_010)}`;
    const { fetch } = createApp([
      [
        {
          id: 'computer-1',
          workspaceId,
          taskId: 'task-1',
          toolActionId: 'action-1',
          operatorId: 'operator-1',
          actionType: 'terminal_command',
          environment: 'local',
          objective: 'Check repository',
          status: 'completed',
          cwd: '/repo',
          command: 'npm',
          args: ['test'],
          filePath: null,
          devServerUrl: null,
          stdout: longOutput,
          stderr: 'warning only',
          exitCode: 0,
          durationMs: 123,
          fileDiff: 'diff --git a/file b/file',
          outputHash: 'sha256:out',
          policyDecisionId: 'dec-computer',
          policyVersion: 'founder-ops-v1',
          evidencePackId: 'ep-1',
          replayIndex: 2,
          createdAt: new Date('2026-05-05T10:00:00Z'),
          completedAt: new Date('2026-05-05T10:00:01Z'),
          metadata: {
            token: 'do-not-return',
            nested: { authorization: 'Bearer abc123', note: 'safe' },
          },
        },
      ],
    ]);

    const res = await fetch('GET', '/computer-actions/replay?taskId=task-1', wsHeader);
    const body = await expectJson<{
      replay: {
        kind: string;
        taskId: string;
        orderedBy: string[];
        capability: { key: string; state: string; productionReady: boolean };
        redactionContract: string;
        actions: Array<{
          id: string;
          replayRef: string;
          replayIndex: number;
          stdoutPreview: string;
          metadata: Record<string, unknown>;
        }>;
      };
    }>(res, 200);

    expect(body.replay.kind).toBe('computer_action_sequence');
    expect(body.replay.taskId).toBe('task-1');
    expect(body.replay.orderedBy).toEqual(['replayIndex', 'createdAt', 'id']);
    expect(body.replay.capability).toEqual({
      key: 'computer_use',
      state: 'prototype',
      productionReady: false,
    });
    expect(body.replay.redactionContract).toContain('bounded_stdout_stderr');
    expect(body.replay.actions[0]).toMatchObject({
      id: 'computer-1',
      replayRef: 'computer:computer-1:2',
      replayIndex: 2,
      metadata: {
        token: '[REDACTED]',
        nested: { authorization: '[REDACTED]', note: 'safe' },
      },
    });
    expect(body.replay.actions[0]?.stdoutPreview).toContain('[truncated]');
    expect(body.replay.actions[0]?.stdoutPreview).toContain('token=[REDACTED]');
    expect(JSON.stringify(body)).not.toContain('do-not-return');
    expect(JSON.stringify(body)).not.toContain('token=abc');
    expect(JSON.stringify(body)).not.toContain('Bearer abc123');
  });

  it('returns a workspace-scoped subagent proof DAG without production promotion', async () => {
    const rootTaskRunId = '00000000-0000-4000-8000-000000000101';
    const spawnTaskRunId = '00000000-0000-4000-8000-000000000102';
    const childTaskRunId = '00000000-0000-4000-8000-000000000103';
    const pollutedTaskRunId = '00000000-0000-4000-8000-000000000104';
    const { fetch } = createApp([
      [
        {
          id: rootTaskRunId,
          taskId: 'task-1',
          status: 'completed',
          lineageKind: 'parent_action',
          startedAt: new Date('2026-05-05T09:00:00Z'),
        },
      ],
      [{ id: 'task-1' }],
      [
        {
          id: rootTaskRunId,
          taskId: 'task-1',
          status: 'completed',
          lineageKind: 'parent_action',
          startedAt: new Date('2026-05-05T09:00:00Z'),
        },
        {
          id: spawnTaskRunId,
          taskId: 'task-1',
          status: 'running',
          actionTool: 'subagent.spawn',
          parentTaskRunId: rootTaskRunId,
          rootTaskRunId,
          spawnedByActionId: rootTaskRunId,
          lineageKind: 'subagent_spawn',
          startedAt: new Date('2026-05-05T09:01:00Z'),
        },
        {
          id: childTaskRunId,
          taskId: 'task-1',
          status: 'completed',
          actionTool: 'finish',
          parentTaskRunId: spawnTaskRunId,
          rootTaskRunId,
          spawnedByActionId: spawnTaskRunId,
          lineageKind: 'subagent_action',
          startedAt: new Date('2026-05-05T09:02:00Z'),
        },
        {
          id: pollutedTaskRunId,
          taskId: 'task-1',
          status: 'completed',
          actionTool: 'finish',
          parentTaskRunId: '00000000-0000-4000-8000-000000009998',
          rootTaskRunId: '00000000-0000-4000-8000-000000009999',
          spawnedByActionId: rootTaskRunId,
          lineageKind: 'subagent_action',
          startedAt: new Date('2026-05-05T09:03:00Z'),
        },
      ],
      [
        {
          id: 'handoff-1',
          workspaceId,
          taskId: 'task-1',
          parentTaskRunId: rootTaskRunId,
          childTaskRunId: spawnTaskRunId,
          fromAgent: 'conductor',
          toAgent: 'opportunity_scout',
          status: 'completed',
          createdAt: new Date('2026-05-05T09:01:00Z'),
        },
      ],
      [
        {
          id: 'ep-spawn',
          workspaceId,
          taskRunId: spawnTaskRunId,
          decisionId: 'local_spawn_1',
          verdict: 'ALLOW',
          policyVersion: 'founder-ops-v1',
          action: 'SUBAGENT_SPAWN',
          resource: 'opportunity_scout',
          principal: `workspace:${workspaceId}/operator:growth/subagent:opportunity_scout:abc123`,
          receivedAt: new Date('2026-05-05T09:01:00Z'),
        },
      ],
    ]);

    const res = await fetch('GET', `/proof-dag/${rootTaskRunId}`, wsHeader);
    const body = await expectJson<{
      workspaceId: string;
      rootTaskRunId: string;
      productionReady: boolean;
      capability: { key: string; state: string };
      dag: {
        taskRuns: Array<{ id: string; lineageKind: string; spawnedByActionId?: string }>;
        agentHandoffs: Array<{ childTaskRunId: string }>;
        evidencePacks: Array<{ taskRunId: string; action: string }>;
      };
      blockers: string[];
    }>(res, 200);

    expect(body.workspaceId).toBe(workspaceId);
    expect(body.rootTaskRunId).toBe(rootTaskRunId);
    expect(body.productionReady).toBe(false);
    expect(body.capability).toMatchObject({ key: 'subagent_lineage', state: 'implemented' });
    expect(body.dag.taskRuns.map((run) => run.lineageKind)).toEqual([
      'parent_action',
      'subagent_spawn',
      'subagent_action',
    ]);
    expect(body.dag.taskRuns.map((run) => run.id)).not.toContain(pollutedTaskRunId);
    expect(body.dag.taskRuns.find((run) => run.id === childTaskRunId)?.spawnedByActionId).toBe(
      spawnTaskRunId,
    );
    expect(body.dag.agentHandoffs[0]?.childTaskRunId).toBe(spawnTaskRunId);
    expect(body.dag.evidencePacks[0]).toMatchObject({
      taskRunId: spawnTaskRunId,
      action: 'SUBAGENT_SPAWN',
    });
    expect(body.blockers.join(' ')).toContain('has not passed Proof DAG Lineage Regression');
  });
});
