import { describe, expect, it, vi } from 'vitest';
import {
  auditLog,
  evidenceItems,
  goals,
  missionEdges,
  missionNodes,
  missionRuntimeCheckpoints,
  missionTasks,
  missions,
  tasks,
  ventures,
} from '@pilot/db/schema';
import { startupLifecycleRoutes } from '../../routes/startup-lifecycle.js';
import { createMockDeps, expectJson, testApp } from '../helpers.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const wsHeader = { 'X-Workspace-Id': workspaceId };

function captureEvidenceItemInserts(deps: ReturnType<typeof createMockDeps>) {
  const insertedEvidenceItems: unknown[] = [];
  const originalInsert = deps.db.insert;
  deps.db.insert = vi.fn((table: unknown) => {
    if (table === evidenceItems) {
      return {
        values: vi.fn((value: unknown) => {
          insertedEvidenceItems.push(value);
          const id = `00000000-0000-4000-8000-00000000009${insertedEvidenceItems.length}`;
          return { returning: vi.fn(async () => [{ id }]) };
        }),
      };
    }
    return originalInsert(table);
  }) as typeof deps.db.insert;
  return insertedEvidenceItems;
}

function captureFailedPersistTransaction(deps: ReturnType<typeof createMockDeps>) {
  const committedInserts: Array<{ table: string; values: unknown }> = [];
  const originalInsert = deps.db.insert;
  let idCounter = 300;

  const tableName = (table: unknown) => {
    if (table === ventures) return 'ventures';
    if (table === goals) return 'goals';
    if (table === missions) return 'missions';
    if (table === missionNodes) return 'missionNodes';
    if (table === missionEdges) return 'missionEdges';
    if (table === tasks) return 'tasks';
    if (table === missionTasks) return 'missionTasks';
    if (table === evidenceItems) return 'evidenceItems';
    return 'unknown';
  };
  const nextId = () => `00000000-0000-4000-8000-${String(idCounter++).padStart(12, '0')}`;
  const rowFor = (values: unknown) => {
    const value = Array.isArray(values) ? values[0] : values;
    return {
      ...(typeof value === 'object' && value !== null ? value : {}),
      id:
        typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string'
          ? value.id
          : nextId(),
    };
  };
  const captureInsert = (sink: Array<{ table: string; values: unknown }>, failEvidence: boolean) =>
    vi.fn((table: unknown) => {
      if (
        table === ventures ||
        table === goals ||
        table === missions ||
        table === missionNodes ||
        table === missionEdges ||
        table === tasks ||
        table === missionTasks ||
        table === evidenceItems
      ) {
        return {
          values: vi.fn((values: unknown) => {
            if (failEvidence && table === evidenceItems) {
              throw new Error('evidence unavailable');
            }
            sink.push({ table: tableName(table), values });
            return {
              returning: vi.fn(async () => [rowFor(values)]),
              then: (resolve: (value: unknown[]) => void) => resolve([]),
              catch: vi.fn(),
            };
          }),
        };
      }
      return originalInsert(table);
    }) as typeof deps.db.insert;

  deps.db.insert = captureInsert(committedInserts, false);
  deps.db.transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    const stagedInserts: Array<{ table: string; values: unknown }> = [];
    const result = await callback({
      ...deps.db,
      insert: captureInsert(stagedInserts, true),
    });
    committedInserts.push(...stagedInserts);
    return result;
  }) as typeof deps.db.transaction;

  return committedInserts;
}

function captureFailedScheduleTransaction(deps: ReturnType<typeof createMockDeps>) {
  const committedUpdates: Array<{ table: string; values: unknown }> = [];
  const originalInsert = deps.db.insert;
  const originalUpdate = deps.db.update;

  const tableName = (table: unknown) => {
    if (table === missionNodes) return 'missionNodes';
    if (table === missions) return 'missions';
    return 'unknown';
  };
  const captureUpdate = (sink: Array<{ table: string; values: unknown }>) =>
    vi.fn((table: unknown) => {
      if (table === missionNodes || table === missions) {
        return {
          set: vi.fn((values: unknown) => ({
            where: vi.fn(async () => {
              sink.push({ table: tableName(table), values });
              return [];
            }),
          })),
        };
      }
      return originalUpdate(table);
    }) as typeof deps.db.update;
  const captureInsert = (failEvidence: boolean) =>
    vi.fn((table: unknown) => {
      if (table === evidenceItems) {
        return {
          values: vi.fn(() => {
            if (failEvidence) {
              throw new Error('schedule evidence unavailable');
            }
            return { returning: vi.fn(async () => [{ id: 'evidence-item-1' }]) };
          }),
        };
      }
      return originalInsert(table);
    }) as typeof deps.db.insert;

  deps.db.update = captureUpdate(committedUpdates);
  deps.db.transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    const stagedUpdates: Array<{ table: string; values: unknown }> = [];
    const result = await callback({
      ...deps.db,
      insert: captureInsert(true),
      update: captureUpdate(stagedUpdates),
    });
    committedUpdates.push(...stagedUpdates);
    return result;
  }) as typeof deps.db.transaction;

  return committedUpdates;
}

function captureEvidenceAndMissionCheckpointInserts(deps: ReturnType<typeof createMockDeps>) {
  const insertedEvidenceItems: unknown[] = [];
  const insertedAuditEvents: unknown[] = [];
  const updatedAuditEvents: unknown[] = [];
  const insertedMissionRuntimeCheckpoints: unknown[] = [];
  const originalInsert = deps.db.insert;
  const originalUpdate = deps.db.update;

  const captureInsert = (
    evidenceSink: unknown[],
    checkpointSink: unknown[],
    auditSink: unknown[],
    options: { failMissionRuntimeCheckpointInsert?: boolean } = {},
  ) =>
    vi.fn((table: unknown) => {
      if (table === auditLog) {
        return {
          values: vi.fn((value: unknown) => {
            auditSink.push(value);
            return { returning: vi.fn(async () => []) };
          }),
        };
      }
      if (table === evidenceItems) {
        return {
          values: vi.fn((value: unknown) => {
            evidenceSink.push(value);
            const id = `00000000-0000-4000-8000-00000000019${evidenceSink.length}`;
            return { returning: vi.fn(async () => [{ id }]) };
          }),
        };
      }
      if (table === missionRuntimeCheckpoints) {
        return {
          values: vi.fn((value: unknown) => {
            checkpointSink.push(value);
            const id =
              typeof value === 'object' &&
              value !== null &&
              'id' in value &&
              typeof value.id === 'string'
                ? value.id
                : '00000000-0000-4000-8000-000000000291';
            return {
              returning: vi.fn(async () => {
                if (options.failMissionRuntimeCheckpointInsert) {
                  throw new Error('mission checkpoint insert failed');
                }
                return [{ id }];
              }),
            };
          }),
        };
      }
      return originalInsert(table);
    }) as typeof deps.db.insert;

  const captureUpdate = (auditSink: unknown[]) =>
    vi.fn((table: unknown) => {
      if (table === auditLog) {
        return {
          set: vi.fn((value: unknown) => {
            auditSink.push(value);
            return { where: vi.fn(async () => []) };
          }),
        };
      }
      return originalUpdate(table);
    }) as typeof deps.db.update;

  deps.db.insert = captureInsert(
    insertedEvidenceItems,
    insertedMissionRuntimeCheckpoints,
    insertedAuditEvents,
  );
  deps.db.update = captureUpdate(updatedAuditEvents);
  deps.db.transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    const stagedEvidenceItems: unknown[] = [];
    const stagedAuditEvents: unknown[] = [];
    const stagedAuditUpdates: unknown[] = [];
    const stagedMissionRuntimeCheckpoints: unknown[] = [];
    const tx = {
      ...deps.db,
      insert: captureInsert(
        stagedEvidenceItems,
        stagedMissionRuntimeCheckpoints,
        stagedAuditEvents,
      ),
      update: captureUpdate(stagedAuditUpdates),
    };
    const result = await callback(tx);
    insertedEvidenceItems.push(...stagedEvidenceItems);
    insertedAuditEvents.push(...stagedAuditEvents);
    updatedAuditEvents.push(...stagedAuditUpdates);
    insertedMissionRuntimeCheckpoints.push(...stagedMissionRuntimeCheckpoints);
    return result;
  }) as typeof deps.db.transaction;

  return {
    insertedEvidenceItems,
    insertedAuditEvents,
    updatedAuditEvents,
    insertedMissionRuntimeCheckpoints,
  };
}

function captureFailedMissionCheckpointTransaction(deps: ReturnType<typeof createMockDeps>) {
  const insertedEvidenceItems: unknown[] = [];
  const insertedAuditEvents: unknown[] = [];
  const updatedAuditEvents: unknown[] = [];
  const insertedMissionRuntimeCheckpoints: unknown[] = [];
  const originalInsert = deps.db.insert;
  const originalUpdate = deps.db.update;

  const captureInsert = (
    evidenceSink: unknown[],
    checkpointSink: unknown[],
    auditSink: unknown[],
  ) =>
    vi.fn((table: unknown) => {
      if (table === auditLog) {
        return {
          values: vi.fn((value: unknown) => {
            auditSink.push(value);
            return { returning: vi.fn(async () => []) };
          }),
        };
      }
      if (table === evidenceItems) {
        return {
          values: vi.fn((value: unknown) => {
            evidenceSink.push(value);
            const id = `00000000-0000-4000-8000-00000000019${evidenceSink.length}`;
            return { returning: vi.fn(async () => [{ id }]) };
          }),
        };
      }
      if (table === missionRuntimeCheckpoints) {
        return {
          values: vi.fn((value: unknown) => {
            checkpointSink.push(value);
            return {
              returning: vi.fn(async () => {
                throw new Error('mission checkpoint insert failed');
              }),
            };
          }),
        };
      }
      return originalInsert(table);
    }) as typeof deps.db.insert;

  const captureUpdate = (auditSink: unknown[]) =>
    vi.fn((table: unknown) => {
      if (table === auditLog) {
        return {
          set: vi.fn((value: unknown) => {
            auditSink.push(value);
            return { where: vi.fn(async () => []) };
          }),
        };
      }
      return originalUpdate(table);
    }) as typeof deps.db.update;

  deps.db.insert = captureInsert(
    insertedEvidenceItems,
    insertedMissionRuntimeCheckpoints,
    insertedAuditEvents,
  );
  deps.db.update = captureUpdate(updatedAuditEvents);
  deps.db.transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    const stagedEvidenceItems: unknown[] = [];
    const stagedAuditEvents: unknown[] = [];
    const stagedAuditUpdates: unknown[] = [];
    const stagedMissionRuntimeCheckpoints: unknown[] = [];
    const tx = {
      ...deps.db,
      insert: captureInsert(
        stagedEvidenceItems,
        stagedMissionRuntimeCheckpoints,
        stagedAuditEvents,
      ),
      update: captureUpdate(stagedAuditUpdates),
    };
    const result = await callback(tx);
    insertedEvidenceItems.push(...stagedEvidenceItems);
    insertedAuditEvents.push(...stagedAuditEvents);
    updatedAuditEvents.push(...stagedAuditUpdates);
    insertedMissionRuntimeCheckpoints.push(...stagedMissionRuntimeCheckpoints);
    return result;
  }) as typeof deps.db.transaction;
  return {
    insertedEvidenceItems,
    insertedAuditEvents,
    updatedAuditEvents,
    insertedMissionRuntimeCheckpoints,
  };
}

describe('startupLifecycleRoutes', () => {
  it('requires workspace scope', async () => {
    const { fetch } = testApp(startupLifecycleRoutes, createMockDeps());
    const res = await fetch('GET', '/templates');
    const body = await expectJson<{ error: string }>(res, 400);

    expect(body.error).toContain('workspaceId');
  });

  it('requires partner role to compile lifecycle missions', async () => {
    const { fetch } = testApp(startupLifecycleRoutes, createMockDeps());
    const res = await fetch(
      'POST',
      '/compile',
      {
        founderGoal: 'Build an AI finance operations assistant for small agencies.',
      },
      {
        ...wsHeader,
        'X-Workspace-Role': 'member',
      },
    );
    const body = await expectJson<{ error: string; requiredRole: string }>(res, 403);

    expect(body.error).toBe('insufficient workspace role');
    expect(body.requiredRole).toBe('partner');
  });

  it('rejects mismatched workspace ids', async () => {
    const { fetch } = testApp(startupLifecycleRoutes, createMockDeps());
    const res = await fetch(
      'POST',
      '/compile',
      {
        workspaceId: '00000000-0000-4000-8000-000000000099',
        founderGoal: 'Build an AI finance operations assistant for small agencies.',
      },
      wsHeader,
    );
    const body = await expectJson<{ error: string }>(res, 403);

    expect(body.error).toContain('workspaceId');
  });

  it('compiles a founder goal into a non-production lifecycle DAG', async () => {
    const { fetch } = testApp(startupLifecycleRoutes, createMockDeps());
    const res = await fetch(
      'POST',
      '/compile',
      {
        founderGoal:
          'Build and launch a HELM-governed AI product for startup operators who need reliable weekly execution.',
        ventureContext: 'Founder has GitHub, Cloudflare, Stripe, and PostHog access.',
        constraints: ['No public launches without founder approval'],
        autonomyMode: 'review',
      },
      wsHeader,
    );
    const body = await expectJson<{
      workspaceId: string;
      capabilityState: string;
      productionReady: boolean;
      mission: {
        status: string;
        nodes: Array<{
          stage: string;
          requiredAgents: string[];
          requiredSkills: string[];
          requiredTools: string[];
          requiredEvidence: string[];
          helmPolicyClasses: string[];
          escalationConditions: string[];
          acceptanceCriteria: string[];
        }>;
        edges: Array<{ from: string; to: string }>;
        blockers: string[];
      };
    }>(res, 200);

    expect(body.workspaceId).toBe(workspaceId);
    expect(body.capabilityState).toBe('prototype');
    expect(body.productionReady).toBe(false);
    expect(body.mission.status).toBe('compiled_not_persisted');
    expect(body.mission.nodes.map((node) => node.stage)).toContain('company_formation_prep');
    expect(body.mission.nodes.map((node) => node.stage)).toContain('growth_experiments');
    expect(body.mission.edges.length).toBeGreaterThan(0);
    expect(body.mission.blockers.join(' ')).toContain('Mission DAG');

    const formation = body.mission.nodes.find((node) => node.stage === 'company_formation_prep');
    expect(formation?.helmPolicyClasses).toContain('legal');
    expect(formation?.escalationConditions.join(' ')).toMatch(/Signature|filing|payment/i);

    for (const node of body.mission.nodes) {
      expect(node.requiredAgents.length).toBeGreaterThan(0);
      expect(node.requiredSkills.length).toBeGreaterThan(0);
      expect(node.requiredTools.length).toBeGreaterThan(0);
      expect(node.requiredEvidence.length).toBeGreaterThan(0);
      expect(node.helmPolicyClasses.length).toBeGreaterThan(0);
      expect(node.acceptanceCriteria.length).toBeGreaterThan(0);
    }
  });

  it('exposes templates with capability truth', async () => {
    const { fetch } = testApp(startupLifecycleRoutes, createMockDeps());
    const res = await fetch('GET', '/templates', undefined, wsHeader);
    const body = await expectJson<{
      workspaceId: string;
      capability: { key: string; state: string };
      templates: Array<{ stage: string; requiredEvidence: string[] }>;
    }>(res, 200);

    expect(body.workspaceId).toBe(workspaceId);
    expect(body.capability.key).toBe('startup_lifecycle');
    expect(body.capability.state).toBe('prototype');
    expect(body.templates.map((node) => node.stage)).toContain('pmf_discovery');
    expect(body.templates[0]?.requiredEvidence.length).toBeGreaterThan(0);
  });

  it('persists a lifecycle DAG as durable mission runtime without starting execution', async () => {
    const deps = createMockDeps();
    const insertedEvidenceItems = captureEvidenceItemInserts(deps);
    deps.db._setResult([{ id: '00000000-0000-4000-8000-000000000010' }]);
    const { fetch } = testApp(startupLifecycleRoutes, deps);
    const res = await fetch(
      'POST',
      '/persist',
      {
        ventureName: 'EvidenceOS',
        founderGoal:
          'Build and launch a governed evidence automation product for startup founders.',
        ventureContext: 'Founder has GitHub and Cloudflare access.',
        constraints: ['No external sends without review'],
        autonomyMode: 'review',
      },
      wsHeader,
    );
    const body = await expectJson<{
      workspaceId: string;
      capabilityState: string;
      productionReady: boolean;
      evidenceItemIds: string[];
      persisted: {
        ventureId: string;
        goalId: string;
        missionId: string;
        nodeCount: number;
        edgeCount: number;
        taskCount: number;
      };
      mission: {
        status: string;
        blockers: string[];
      };
    }>(res, 201);

    expect(body.workspaceId).toBe(workspaceId);
    expect(body.capabilityState).toBe('prototype');
    expect(body.productionReady).toBe(false);
    expect(body.mission.status).toBe('persisted_not_executing');
    expect(body.persisted.ventureId).toBe('00000000-0000-4000-8000-000000000010');
    expect(body.persisted.nodeCount).toBeGreaterThan(10);
    expect(body.persisted.edgeCount).toBeGreaterThan(0);
    expect(body.persisted.taskCount).toBe(body.persisted.nodeCount);
    expect(body.evidenceItemIds).toEqual(['00000000-0000-4000-8000-000000000091']);
    expect(insertedEvidenceItems[0]).toMatchObject({
      workspaceId,
      ventureId: '00000000-0000-4000-8000-000000000010',
      missionId: '00000000-0000-4000-8000-000000000010',
      evidenceType: 'startup_lifecycle_mission_persisted',
      sourceType: 'gateway_startup_lifecycle',
      redactionState: 'redacted',
      replayRef: 'mission:00000000-0000-4000-8000-000000000010:persisted',
      metadata: expect.objectContaining({
        compilerVersion: 'startup-lifecycle.v1',
        productionReady: false,
      }),
    });
    expect(body.mission.blockers.join(' ')).toContain('not executing through the runtime');
    expect(body.mission.blockers.join(' ')).not.toContain('not persisted');
  });

  it('does not commit persisted mission graph rows when persist evidence fails', async () => {
    const deps = createMockDeps();
    const committedInserts = captureFailedPersistTransaction(deps);
    const { fetch } = testApp(startupLifecycleRoutes, deps);
    const res = await fetch(
      'POST',
      '/persist',
      {
        ventureName: 'RollbackOS',
        founderGoal:
          'Build a governed startup lifecycle runtime with transaction-safe evidence records.',
        ventureContext: 'Founder has source control and deployment access.',
        constraints: ['No external action without durable evidence'],
        autonomyMode: 'review',
      },
      wsHeader,
    );

    expect(res.status).toBe(500);
    expect(committedInserts).toEqual([]);
  });

  it('schedules ready mission nodes without dispatching autonomous execution', async () => {
    const deps = createMockDeps();
    const insertedEvidenceItems = captureEvidenceItemInserts(deps);
    const missionId = '00000000-0000-4000-8000-000000000020';
    const founderNodeId = '00000000-0000-4000-8000-000000000021';
    const ideationNodeId = '00000000-0000-4000-8000-000000000022';
    const operationsNodeId = '00000000-0000-4000-8000-000000000026';
    const founderTaskId = '00000000-0000-4000-8000-000000000023';
    const selectResults = [
      [{ id: missionId, workspaceId, status: 'persisted_not_executing' }],
      [
        {
          id: founderNodeId,
          workspaceId,
          missionId,
          nodeKey: 'founder_onboarding',
          stage: 'founder_onboarding',
          title: 'Founder DNA and access charter',
          status: 'pending',
        },
        {
          id: ideationNodeId,
          workspaceId,
          missionId,
          nodeKey: 'ideation',
          stage: 'ideation',
          title: 'Venture hypothesis generation',
          status: 'pending',
        },
        {
          id: operationsNodeId,
          workspaceId,
          missionId,
          nodeKey: 'operations_recovery',
          stage: 'operations_recovery',
          title: 'Operations, monitoring, and recovery',
          status: 'pending',
        },
      ],
      [
        {
          id: '00000000-0000-4000-8000-000000000024',
          workspaceId,
          missionId,
          edgeKey: 'founder_onboarding->ideation',
          fromNodeKey: 'founder_onboarding',
          toNodeKey: 'ideation',
          reason: 'Ideation depends on founder onboarding',
        },
      ],
      [
        {
          id: '00000000-0000-4000-8000-000000000025',
          workspaceId,
          missionId,
          nodeId: founderNodeId,
          taskId: founderTaskId,
        },
      ],
    ];
    let selectCall = 0;
    const originalSelect = deps.db.select;
    deps.db.select = vi.fn(() => {
      deps.db._setResult(selectResults[selectCall] ?? []);
      selectCall += 1;
      return originalSelect();
    }) as typeof deps.db.select;

    const { fetch } = testApp(startupLifecycleRoutes, deps);
    const res = await fetch('POST', `/missions/${missionId}/schedule`, { maxNodes: 1 }, wsHeader);
    const body = await expectJson<{
      status: string;
      productionReady: boolean;
      readyNodes: Array<{ nodeKey: string; taskId?: string; waitingOn: string[] }>;
      blockedNodes: Array<{ nodeKey: string; waitingOn: string[] }>;
      queuedTaskIds: string[];
      evidenceItemIds: string[];
      executionStarted: boolean;
      blockers: string[];
    }>(res, 200);

    expect(body.status).toBe('scheduled_not_executing');
    expect(body.productionReady).toBe(false);
    expect(body.readyNodes).toEqual([
      expect.objectContaining({
        nodeKey: 'founder_onboarding',
        taskId: founderTaskId,
        waitingOn: [],
      }),
    ]);
    expect(body.blockedNodes).toEqual([
      expect.objectContaining({ nodeKey: 'ideation', waitingOn: ['founder_onboarding'] }),
      expect.objectContaining({
        nodeKey: 'operations_recovery',
        waitingOn: ['scheduler_batch_limit'],
      }),
    ]);
    expect(body.queuedTaskIds).toEqual([founderTaskId]);
    expect(body.evidenceItemIds).toEqual(['00000000-0000-4000-8000-000000000091']);
    expect(insertedEvidenceItems[0]).toMatchObject({
      workspaceId,
      missionId,
      evidenceType: 'startup_lifecycle_nodes_scheduled',
      sourceType: 'gateway_startup_lifecycle',
      summary: '1 ready node(s), 2 blocked node(s)',
      replayRef: `mission:${missionId}:schedule`,
      metadata: expect.objectContaining({
        schedulerVersion: 'mission-scheduler.v1',
        readyNodeKeys: ['founder_onboarding'],
        queuedTaskIds: [founderTaskId],
        productionReady: false,
      }),
    });
    expect(body.executionStarted).toBe(false);
    expect(body.blockers.join(' ')).toContain('does not dispatch autonomous execution');
    expect(deps.orchestrator.runTask).not.toHaveBeenCalled();
  });

  it('does not commit scheduled node or mission state when schedule evidence fails', async () => {
    const deps = createMockDeps();
    const committedUpdates = captureFailedScheduleTransaction(deps);
    const missionId = '00000000-0000-4000-8000-000000000030';
    const nodeId = '00000000-0000-4000-8000-000000000031';
    const selectResults = [
      [{ id: missionId, workspaceId, status: 'persisted_not_executing' }],
      [
        {
          id: nodeId,
          workspaceId,
          missionId,
          nodeKey: 'founder_onboarding',
          stage: 'founder_onboarding',
          title: 'Founder DNA and access charter',
          status: 'pending',
        },
      ],
      [],
      [],
    ];
    let selectCall = 0;
    const originalSelect = deps.db.select;
    deps.db.select = vi.fn(() => {
      deps.db._setResult(selectResults[selectCall] ?? []);
      selectCall += 1;
      return originalSelect();
    }) as typeof deps.db.select;

    const { fetch } = testApp(startupLifecycleRoutes, deps);
    const res = await fetch('POST', `/missions/${missionId}/schedule`, { maxNodes: 1 }, wsHeader);

    expect(res.status).toBe(500);
    expect(committedUpdates).toEqual([]);
    expect(deps.orchestrator.runTask).not.toHaveBeenCalled();
  });

  it('checkpoints a mission DAG as durable evidence without recovery promotion', async () => {
    const deps = createMockDeps();
    const {
      insertedEvidenceItems,
      insertedAuditEvents,
      updatedAuditEvents,
      insertedMissionRuntimeCheckpoints,
    } = captureEvidenceAndMissionCheckpointInserts(deps);
    const missionId = '00000000-0000-4000-8000-000000000070';
    const ventureId = '00000000-0000-4000-8000-000000000071';
    const founderNodeId = '00000000-0000-4000-8000-000000000072';
    const ideationNodeId = '00000000-0000-4000-8000-000000000073';
    const launchNodeId = '00000000-0000-4000-8000-000000000074';
    const taskLinkId = '00000000-0000-4000-8000-000000000075';
    const taskId = '00000000-0000-4000-8000-000000000076';
    const selectResults = [
      [
        {
          id: missionId,
          workspaceId,
          ventureId,
          title: 'Launch EvidenceOS',
          status: 'scheduled_not_executing',
          autonomyMode: 'review',
          capabilityState: 'prototype',
          productionReady: false,
          metadata: { existing: 'value' },
        },
      ],
      [
        {
          id: founderNodeId,
          workspaceId,
          missionId,
          nodeKey: 'founder_onboarding',
          stage: 'founder_onboarding',
          title: 'Founder DNA and access charter',
          status: 'completed',
          sortOrder: 0,
        },
        {
          id: ideationNodeId,
          workspaceId,
          missionId,
          nodeKey: 'ideation',
          stage: 'ideation',
          title: 'Venture hypothesis generation',
          status: 'ready',
          sortOrder: 1,
        },
        {
          id: launchNodeId,
          workspaceId,
          missionId,
          nodeKey: 'launch_engine',
          stage: 'infrastructure_deployment',
          title: 'Launch readiness',
          status: 'pending',
          sortOrder: 2,
        },
      ],
      [
        {
          id: '00000000-0000-4000-8000-000000000077',
          workspaceId,
          missionId,
          edgeKey: 'founder_onboarding->ideation',
          fromNodeKey: 'founder_onboarding',
          toNodeKey: 'ideation',
        },
      ],
      [
        {
          id: taskLinkId,
          workspaceId,
          missionId,
          nodeId: ideationNodeId,
          taskId,
          role: 'startup_lifecycle_node',
        },
      ],
    ];
    let selectCall = 0;
    const originalSelect = deps.db.select;
    deps.db.select = vi.fn(() => {
      deps.db._setResult(selectResults[selectCall] ?? []);
      selectCall += 1;
      return originalSelect();
    }) as typeof deps.db.select;

    const { fetch } = testApp(startupLifecycleRoutes, deps);
    const res = await fetch(
      'POST',
      `/missions/${missionId}/checkpoint`,
      { reason: 'before executing ready nodes' },
      wsHeader,
    );
    const body = await expectJson<{
      missionId: string;
      checkpointId: string;
      checkpointVersion: string;
      productionReady: boolean;
      status: string;
      missionStatus: string;
      replayRef: string;
      evidenceItemIds: string[];
      snapshot: {
        missionId: string;
        status: string;
        nodeCount: number;
        edgeCount: number;
        taskLinkCount: number;
        nodeStatuses: Record<string, number>;
      };
      blockers: string[];
      runtimeCheckpointId: string;
    }>(res, 200);

    expect(body.missionId).toBe(missionId);
    expect(body.checkpointId).toMatch(/^mission-checkpoint:[a-f0-9]+$/);
    expect(body.runtimeCheckpointId).toBe('00000000-0000-4000-8000-000000000291');
    expect(body.checkpointVersion).toBe('mission-checkpoint.v1');
    expect(body.productionReady).toBe(false);
    expect(body.status).toBe('checkpointed_not_recovered');
    expect(body.missionStatus).toBe('scheduled_not_executing');
    expect(body.replayRef).toContain(`mission:${missionId}:checkpoint:`);
    expect(body.evidenceItemIds).toEqual(['00000000-0000-4000-8000-000000000191']);
    expect(body.snapshot).toMatchObject({
      missionId,
      status: 'scheduled_not_executing',
      nodeCount: 3,
      edgeCount: 1,
      taskLinkCount: 1,
      nodeStatuses: {
        completed: 1,
        ready: 1,
        pending: 1,
      },
    });
    expect(body.blockers.join(' ')).toContain('recovery and rollback');
    const checkpointAudit = insertedAuditEvents[0] as {
      id: string;
      workspaceId: string;
      action: string;
      actor: string;
      target: string;
      verdict: string;
      metadata: Record<string, unknown>;
    };
    expect(checkpointAudit).toMatchObject({
      workspaceId,
      action: 'STARTUP_LIFECYCLE_MISSION_CHECKPOINT',
      actor: `workspace:${workspaceId}`,
      target: missionId,
      verdict: 'recorded',
      metadata: expect.objectContaining({
        evidenceType: 'startup_lifecycle_mission_checkpoint',
        replayRef: body.replayRef,
        checkpointId: body.checkpointId,
        checkpointVersion: 'mission-checkpoint.v1',
        productionReady: false,
      }),
    });
    expect(insertedEvidenceItems[0]).toMatchObject({
      auditEventId: checkpointAudit.id,
      workspaceId,
      ventureId,
      missionId,
      evidenceType: 'startup_lifecycle_mission_checkpoint',
      sourceType: 'gateway_startup_lifecycle',
      redactionState: 'redacted',
      replayRef: body.replayRef,
      metadata: expect.objectContaining({
        checkpointVersion: 'mission-checkpoint.v1',
        checkpointId: body.checkpointId,
        missionStatus: 'scheduled_not_executing',
        nodeCount: 3,
        edgeCount: 1,
        taskLinkCount: 1,
        nodeStatuses: {
          completed: 1,
          ready: 1,
          pending: 1,
        },
        snapshot: expect.objectContaining({
          mission: expect.objectContaining({
            id: missionId,
            status: 'scheduled_not_executing',
            productionReady: false,
          }),
          nodes: [
            expect.objectContaining({ id: founderNodeId, nodeKey: 'founder_onboarding' }),
            expect.objectContaining({ id: ideationNodeId, nodeKey: 'ideation' }),
            expect.objectContaining({ id: launchNodeId, nodeKey: 'launch_engine' }),
          ],
          edges: [expect.objectContaining({ fromNodeKey: 'founder_onboarding' })],
          taskLinks: [expect.objectContaining({ id: taskLinkId, taskId })],
          reason: 'before executing ready nodes',
        }),
        productionReady: false,
      }),
    });
    expect(updatedAuditEvents[0]).toMatchObject({
      metadata: expect.objectContaining({
        evidenceItemId: '00000000-0000-4000-8000-000000000191',
        replayRef: body.replayRef,
        checkpointId: body.checkpointId,
      }),
    });
    expect(insertedMissionRuntimeCheckpoints[0]).toMatchObject({
      workspaceId,
      missionId,
      checkpointKind: 'manual_checkpoint',
      checkpointStatus: 'recorded',
      missionStatus: 'scheduled_not_executing',
      cursorNodeId: ideationNodeId,
      cursorNodeKey: 'ideation',
      nodeStatusCounts: {
        completed: 1,
        ready: 1,
        pending: 1,
      },
      readyNodeIds: [ideationNodeId],
      blockedNodeIds: [],
      failedNodeIds: [],
      awaitingApprovalNodeIds: [],
      taskRunCheckpointRefs: [],
      recoveryPlan: expect.objectContaining({
        recoveryVersion: 'mission-recovery.v1',
        recoverableReadyNodeKeys: ['launch_engine'],
      }),
      rollbackPlan: {},
      evidenceItemId: '00000000-0000-4000-8000-000000000191',
      metadata: expect.objectContaining({
        checkpointVersion: 'mission-runtime-checkpoint.v1',
        sourceCheckpointVersion: 'mission-checkpoint.v1',
        checkpointId: body.checkpointId,
        replayRef: body.replayRef,
        snapshot: expect.objectContaining({
          mission: expect.objectContaining({ id: missionId }),
          nodes: [
            expect.objectContaining({ id: founderNodeId, nodeKey: 'founder_onboarding' }),
            expect.objectContaining({ id: ideationNodeId, nodeKey: 'ideation' }),
            expect.objectContaining({ id: launchNodeId, nodeKey: 'launch_engine' }),
          ],
        }),
        productionReady: false,
      }),
    });
    expect(deps.orchestrator.runTask).not.toHaveBeenCalled();
  });

  it('does not commit manual checkpoint evidence when runtime checkpoint persistence fails', async () => {
    const deps = createMockDeps();
    const {
      insertedEvidenceItems,
      insertedAuditEvents,
      updatedAuditEvents,
      insertedMissionRuntimeCheckpoints,
    } = captureFailedMissionCheckpointTransaction(deps);
    const missionId = '00000000-0000-4000-8000-000000000270';
    const nodeId = '00000000-0000-4000-8000-000000000271';
    const selectResults = [
      [
        {
          id: missionId,
          workspaceId,
          ventureId: null,
          title: 'Launch EvidenceOS',
          status: 'scheduled_not_executing',
          autonomyMode: 'review',
          capabilityState: 'prototype',
          productionReady: false,
          metadata: {},
        },
      ],
      [
        {
          id: nodeId,
          workspaceId,
          missionId,
          nodeKey: 'ideation',
          stage: 'ideation',
          title: 'Venture hypothesis generation',
          status: 'ready',
          sortOrder: 0,
        },
      ],
      [],
      [],
    ];
    let selectCall = 0;
    const originalSelect = deps.db.select;
    deps.db.select = vi.fn(() => {
      deps.db._setResult(selectResults[selectCall] ?? []);
      selectCall += 1;
      return originalSelect();
    }) as typeof deps.db.select;

    const { fetch } = testApp(startupLifecycleRoutes, deps);
    const res = await fetch(
      'POST',
      `/missions/${missionId}/checkpoint`,
      { reason: 'force checkpoint insert failure' },
      wsHeader,
    );

    expect(res.status).toBe(500);
    expect(insertedEvidenceItems).toEqual([]);
    expect(insertedAuditEvents).toEqual([]);
    expect(updatedAuditEvents).toEqual([]);
    expect(insertedMissionRuntimeCheckpoints).toEqual([]);
  });

  it('plans mission recovery from the latest checkpoint without executing recovery', async () => {
    const deps = createMockDeps();
    const insertedEvidenceItems = captureEvidenceItemInserts(deps);
    const missionId = '00000000-0000-4000-8000-000000000080';
    const ventureId = '00000000-0000-4000-8000-000000000081';
    const founderNodeId = '00000000-0000-4000-8000-000000000082';
    const ideationNodeId = '00000000-0000-4000-8000-000000000083';
    const launchNodeId = '00000000-0000-4000-8000-000000000084';
    const taskId = '00000000-0000-4000-8000-000000000085';
    const checkpointReplayRef = `mission:${missionId}:checkpoint:abc123`;
    const checkpointId = 'mission-checkpoint:abc123';
    const selectResults = [
      [
        {
          id: missionId,
          workspaceId,
          ventureId,
          title: 'Launch EvidenceOS',
          status: 'blocked',
          productionReady: false,
          metadata: {
            lastCheckpoint: {
              checkpointId,
              evidenceItemId: '00000000-0000-4000-8000-000000000086',
              replayRef: checkpointReplayRef,
            },
          },
        },
      ],
      [
        {
          id: '00000000-0000-4000-8000-000000000086',
          workspaceId,
          missionId,
          replayRef: checkpointReplayRef,
          metadata: {
            checkpointId,
            snapshot: {
              nodes: [
                { id: founderNodeId, nodeKey: 'founder_onboarding', status: 'completed' },
                { id: ideationNodeId, nodeKey: 'ideation', status: 'ready' },
                { id: launchNodeId, nodeKey: 'launch_engine', status: 'pending' },
              ],
            },
          },
        },
      ],
      [
        {
          id: founderNodeId,
          workspaceId,
          missionId,
          nodeKey: 'founder_onboarding',
          stage: 'founder_onboarding',
          title: 'Founder DNA and access charter',
          status: 'completed',
          sortOrder: 0,
        },
        {
          id: ideationNodeId,
          workspaceId,
          missionId,
          nodeKey: 'ideation',
          stage: 'ideation',
          title: 'Venture hypothesis generation',
          status: 'blocked',
          sortOrder: 1,
        },
        {
          id: launchNodeId,
          workspaceId,
          missionId,
          nodeKey: 'launch_engine',
          stage: 'infrastructure_deployment',
          title: 'Launch readiness',
          status: 'ready',
          sortOrder: 2,
        },
      ],
      [
        {
          id: '00000000-0000-4000-8000-000000000087',
          workspaceId,
          missionId,
          edgeKey: 'ideation->launch_engine',
          fromNodeKey: 'ideation',
          toNodeKey: 'launch_engine',
        },
      ],
      [
        {
          id: '00000000-0000-4000-8000-000000000088',
          workspaceId,
          missionId,
          nodeId: launchNodeId,
          taskId,
          role: 'startup_lifecycle_node',
        },
      ],
    ];
    let selectCall = 0;
    const originalSelect = deps.db.select;
    deps.db.select = vi.fn(() => {
      deps.db._setResult(selectResults[selectCall] ?? []);
      selectCall += 1;
      return originalSelect();
    }) as typeof deps.db.select;

    const { fetch } = testApp(startupLifecycleRoutes, deps);
    const res = await fetch(
      'POST',
      `/missions/${missionId}/recovery-plan`,
      { reason: 'resume after node failure' },
      wsHeader,
    );
    const body = await expectJson<{
      missionId: string;
      recoveryPlanId: string;
      recoveryPlanVersion: string;
      productionReady: boolean;
      status: string;
      missionStatus: string;
      recoveryExecuted: boolean;
      checkpointId: string;
      checkpointReplayRef: string;
      replayRef: string;
      evidenceItemIds: string[];
      plan: {
        changedNodeKeys: string[];
        blockedNodeKeys: string[];
        failedNodeKeys: string[];
        readyNodeKeys: string[];
        currentNodeStatuses: Record<string, string>;
        checkpointNodeStatuses: Record<string, string>;
        recommendedNextActions: string[];
      };
      blockers: string[];
    }>(res, 200);

    expect(body.missionId).toBe(missionId);
    expect(body.recoveryPlanId).toMatch(/^mission-recovery-plan:[a-f0-9]+$/);
    expect(body.recoveryPlanVersion).toBe('mission-recovery-plan.v1');
    expect(body.productionReady).toBe(false);
    expect(body.status).toBe('planned_not_executed');
    expect(body.missionStatus).toBe('blocked');
    expect(body.recoveryExecuted).toBe(false);
    expect(body.checkpointId).toBe(checkpointId);
    expect(body.checkpointReplayRef).toBe(checkpointReplayRef);
    expect(body.replayRef).toContain(`mission:${missionId}:recovery-plan:`);
    expect(body.evidenceItemIds).toEqual(['00000000-0000-4000-8000-000000000091']);
    expect(body.plan.changedNodeKeys).toEqual(['ideation', 'launch_engine']);
    expect(body.plan.blockedNodeKeys).toEqual(['ideation']);
    expect(body.plan.failedNodeKeys).toEqual([]);
    expect(body.plan.readyNodeKeys).toEqual(['launch_engine']);
    expect(body.plan.currentNodeStatuses).toMatchObject({
      founder_onboarding: 'completed',
      ideation: 'blocked',
      launch_engine: 'ready',
    });
    expect(body.plan.checkpointNodeStatuses).toMatchObject({
      founder_onboarding: 'completed',
      ideation: 'ready',
      launch_engine: 'pending',
    });
    expect(body.plan.recommendedNextActions.join(' ')).toContain('Do not roll back');
    expect(body.blockers.join(' ')).toContain('evidence only');
    expect(insertedEvidenceItems[0]).toMatchObject({
      workspaceId,
      ventureId,
      missionId,
      evidenceType: 'startup_lifecycle_recovery_plan',
      sourceType: 'gateway_startup_lifecycle',
      replayRef: body.replayRef,
      metadata: expect.objectContaining({
        recoveryPlanVersion: 'mission-recovery-plan.v1',
        recoveryPlanId: body.recoveryPlanId,
        checkpointId,
        checkpointReplayRef,
        recoveryExecuted: false,
        productionReady: false,
        plan: expect.objectContaining({
          changedNodeKeys: ['ideation', 'launch_engine'],
          blockedNodeKeys: ['ideation'],
          readyNodeKeys: ['launch_engine'],
        }),
      }),
    });
    expect(deps.db.update).toHaveBeenCalled();
    expect(deps.orchestrator.runTask).not.toHaveBeenCalled();
  });

  it('plans mission recovery from a durable runtime checkpoint when evidence lookup misses', async () => {
    const deps = createMockDeps();
    const insertedEvidenceItems = captureEvidenceItemInserts(deps);
    const missionId = '00000000-0000-4000-8000-000000000180';
    const ventureId = '00000000-0000-4000-8000-000000000181';
    const founderNodeId = '00000000-0000-4000-8000-000000000182';
    const ideationNodeId = '00000000-0000-4000-8000-000000000183';
    const checkpointReplayRef = `mission:${missionId}:checkpoint:def456`;
    const checkpointId = 'mission-checkpoint:def456';
    const checkpointEvidenceItemId = '00000000-0000-4000-8000-000000000184';
    const selectResults = [
      [
        {
          id: missionId,
          workspaceId,
          ventureId,
          title: 'Recover EvidenceOS',
          status: 'blocked',
          productionReady: false,
          metadata: {
            lastCheckpoint: {
              checkpointId,
              replayRef: checkpointReplayRef,
            },
          },
        },
      ],
      [],
      [
        {
          id: '00000000-0000-4000-8000-000000000185',
          workspaceId,
          missionId,
          checkpointKind: 'manual_checkpoint',
          checkpointStatus: 'recorded',
          missionStatus: 'scheduled_not_executing',
          evidenceItemId: checkpointEvidenceItemId,
          metadata: {
            checkpointVersion: 'mission-runtime-checkpoint.v1',
            sourceCheckpointVersion: 'mission-checkpoint.v1',
            checkpointId,
            replayRef: checkpointReplayRef,
            snapshot: {
              nodes: [
                { id: founderNodeId, nodeKey: 'founder_onboarding', status: 'completed' },
                { id: ideationNodeId, nodeKey: 'ideation', status: 'ready' },
              ],
            },
            productionReady: false,
          },
        },
      ],
      [
        {
          id: founderNodeId,
          workspaceId,
          missionId,
          nodeKey: 'founder_onboarding',
          stage: 'founder_onboarding',
          title: 'Founder DNA and access charter',
          status: 'completed',
          sortOrder: 0,
        },
        {
          id: ideationNodeId,
          workspaceId,
          missionId,
          nodeKey: 'ideation',
          stage: 'ideation',
          title: 'Venture hypothesis generation',
          status: 'failed',
          sortOrder: 1,
        },
      ],
      [],
      [],
    ];
    let selectCall = 0;
    const originalSelect = deps.db.select;
    deps.db.select = vi.fn(() => {
      deps.db._setResult(selectResults[selectCall] ?? []);
      selectCall += 1;
      return originalSelect();
    }) as typeof deps.db.select;

    const { fetch } = testApp(startupLifecycleRoutes, deps);
    const res = await fetch(
      'POST',
      `/missions/${missionId}/recovery-plan`,
      { reason: 'recover from persisted runtime checkpoint' },
      wsHeader,
    );
    const body = await expectJson<{
      checkpointId: string;
      checkpointReplayRef: string;
      evidenceItemIds: string[];
      plan: {
        changedNodeKeys: string[];
        failedNodeKeys: string[];
        checkpointNodeStatuses: Record<string, string>;
      };
    }>(res, 200);

    expect(body.checkpointId).toBe(checkpointId);
    expect(body.checkpointReplayRef).toBe(checkpointReplayRef);
    expect(body.plan.changedNodeKeys).toEqual(['ideation']);
    expect(body.plan.failedNodeKeys).toEqual(['ideation']);
    expect(body.plan.checkpointNodeStatuses).toMatchObject({
      founder_onboarding: 'completed',
      ideation: 'ready',
    });
    expect(insertedEvidenceItems[0]).toMatchObject({
      workspaceId,
      ventureId,
      missionId,
      evidenceType: 'startup_lifecycle_recovery_plan',
      metadata: expect.objectContaining({
        checkpointId,
        checkpointReplayRef,
        snapshot: expect.objectContaining({
          checkpoint: expect.objectContaining({
            evidenceItemId: checkpointEvidenceItemId,
          }),
        }),
      }),
    });
    expect(deps.orchestrator.runTask).not.toHaveBeenCalled();
  });

  it('applies a recovery plan by resetting failed mission nodes without executing tasks', async () => {
    const deps = createMockDeps();
    const {
      insertedEvidenceItems,
      insertedAuditEvents,
      updatedAuditEvents,
      insertedMissionRuntimeCheckpoints,
    } = captureEvidenceAndMissionCheckpointInserts(deps);
    const missionId = '00000000-0000-4000-8000-000000000140';
    const ventureId = '00000000-0000-4000-8000-000000000141';
    const failedNodeId = '00000000-0000-4000-8000-000000000142';
    const blockedNodeId = '00000000-0000-4000-8000-000000000143';
    const taskId = '00000000-0000-4000-8000-000000000144';
    const recoveryPlanReplayRef = `mission:${missionId}:recovery-plan:abc123`;
    const selectResults = [
      [
        {
          id: missionId,
          workspaceId,
          ventureId,
          title: 'Launch EvidenceOS',
          status: 'blocked',
          productionReady: false,
          metadata: {
            lastRecoveryPlan: {
              recoveryPlanId: 'mission-recovery-plan:abc123',
              evidenceItemId: '00000000-0000-4000-8000-000000000145',
              replayRef: recoveryPlanReplayRef,
            },
          },
        },
      ],
      [
        {
          id: '00000000-0000-4000-8000-000000000145',
          workspaceId,
          missionId,
          replayRef: recoveryPlanReplayRef,
          evidenceType: 'startup_lifecycle_recovery_plan',
          metadata: {
            plan: {
              failedNodeKeys: ['ideation'],
              blockedNodeKeys: ['launch_engine'],
            },
          },
        },
      ],
      [
        {
          id: failedNodeId,
          workspaceId,
          missionId,
          nodeKey: 'ideation',
          stage: 'ideation',
          title: 'Venture hypothesis generation',
          status: 'failed',
          sortOrder: 1,
        },
        {
          id: blockedNodeId,
          workspaceId,
          missionId,
          nodeKey: 'launch_engine',
          stage: 'infrastructure_deployment',
          title: 'Launch readiness',
          status: 'blocked',
          sortOrder: 2,
        },
      ],
      [],
      [
        {
          id: '00000000-0000-4000-8000-000000000146',
          workspaceId,
          missionId,
          nodeId: failedNodeId,
          taskId,
          role: 'startup_lifecycle_node',
        },
      ],
      [],
      [
        {
          id: failedNodeId,
          workspaceId,
          missionId,
          nodeKey: 'ideation',
          stage: 'ideation',
          title: 'Venture hypothesis generation',
          status: 'failed',
          sortOrder: 1,
        },
        {
          id: blockedNodeId,
          workspaceId,
          missionId,
          nodeKey: 'launch_engine',
          stage: 'infrastructure_deployment',
          title: 'Launch readiness',
          status: 'blocked',
          sortOrder: 2,
        },
      ],
      [
        {
          id: '00000000-0000-4000-8000-000000000146',
          workspaceId,
          missionId,
          nodeId: failedNodeId,
          taskId,
          role: 'startup_lifecycle_node',
        },
      ],
    ];
    let selectCall = 0;
    const originalSelect = deps.db.select;
    deps.db.select = vi.fn(() => {
      deps.db._setResult(selectResults[selectCall] ?? []);
      selectCall += 1;
      return originalSelect();
    }) as typeof deps.db.select;
    const updates: Array<Record<string, unknown>> = [];
    deps.db.update = vi.fn(() => ({
      set: vi.fn((payload: Record<string, unknown>) => {
        updates.push(payload);
        return { where: vi.fn(async () => []) };
      }),
    })) as unknown as typeof deps.db.update;

    const { fetch } = testApp(startupLifecycleRoutes, deps);
    const res = await fetch(
      'POST',
      `/missions/${missionId}/recover`,
      { reason: 'retry failed ideation node' },
      wsHeader,
    );
    const body = await expectJson<{
      missionId: string;
      recoveryApplyId: string;
      recoveryApplyVersion: string;
      productionReady: boolean;
      status: string;
      missionStatus: string;
      recoveryPlanReplayRef: string;
      executionStarted: boolean;
      recoveredNodes: Array<{
        nodeId: string;
        nodeKey: string;
        previousStatus: string;
        nextStatus: string;
        taskId?: string;
      }>;
      skippedNodes: unknown[];
      evidenceItemIds: string[];
      blockers: string[];
    }>(res, 200);

    expect(body.missionId).toBe(missionId);
    expect(body.recoveryApplyId).toMatch(/^mission-recovery-apply:[a-f0-9]+$/);
    expect(body.recoveryApplyVersion).toBe('mission-recovery-apply.v1');
    expect(body.productionReady).toBe(false);
    expect(body.status).toBe('recovery_applied_not_executed');
    expect(body.missionStatus).toBe('scheduled_not_executing');
    expect(body.recoveryPlanReplayRef).toBe(recoveryPlanReplayRef);
    expect(body.executionStarted).toBe(false);
    expect(body.recoveredNodes).toEqual([
      {
        nodeId: failedNodeId,
        nodeKey: 'ideation',
        previousStatus: 'failed',
        nextStatus: 'ready',
        taskId,
      },
    ]);
    expect(body.skippedNodes).toEqual([]);
    expect(body.evidenceItemIds).toEqual([
      '00000000-0000-4000-8000-000000000191',
      '00000000-0000-4000-8000-000000000192',
    ]);
    expect(body.blockers.join(' ')).toContain('does not execute tasks');
    expect(insertedMissionRuntimeCheckpoints[0]).toMatchObject({
      checkpointKind: 'pre_recovery',
      recoveryPlan: expect.objectContaining({
        blockedTerminalNodeKeys: ['ideation', 'launch_engine'],
      }),
    });
    const runtimeCheckpoint = insertedMissionRuntimeCheckpoints[0] as {
      id: string;
      metadata: { replayRef: string };
    };
    const checkpointAudit = insertedAuditEvents[0] as {
      id: string;
      workspaceId: string;
      action: string;
      actor: string;
      target: string;
      verdict: string;
      metadata: Record<string, unknown>;
    };
    expect(runtimeCheckpoint.metadata.replayRef).toBe(
      `mission:${missionId}:checkpoint:pre_recovery:${runtimeCheckpoint.id}`,
    );
    expect(checkpointAudit).toMatchObject({
      workspaceId,
      action: 'STARTUP_LIFECYCLE_MISSION_CHECKPOINT',
      actor: `workspace:${workspaceId}`,
      target: missionId,
      verdict: 'recorded',
      metadata: expect.objectContaining({
        checkpointVersion: 'mission-runtime-checkpoint.v1',
        evidenceType: 'startup_lifecycle_mission_checkpoint',
        replayRef: runtimeCheckpoint.metadata.replayRef,
        checkpointId: runtimeCheckpoint.id,
        checkpointKind: 'pre_recovery',
        productionReady: false,
      }),
    });
    expect(insertedEvidenceItems[0]).toMatchObject({
      auditEventId: checkpointAudit.id,
      replayRef: runtimeCheckpoint.metadata.replayRef,
      metadata: expect.objectContaining({
        checkpointId: runtimeCheckpoint.id,
        checkpointKind: 'pre_recovery',
      }),
    });
    expect(updatedAuditEvents[0]).toMatchObject({
      metadata: expect.objectContaining({
        evidenceItemId: '00000000-0000-4000-8000-000000000191',
        checkpointId: runtimeCheckpoint.id,
        replayRef: runtimeCheckpoint.metadata.replayRef,
      }),
    });
    expect(insertedEvidenceItems[1]).toMatchObject({
      workspaceId,
      ventureId,
      missionId,
      evidenceType: 'startup_lifecycle_recovery_applied',
      sourceType: 'gateway_startup_lifecycle',
      summary: '1 failed node(s) reset to ready',
      metadata: expect.objectContaining({
        recoveryApplyVersion: 'mission-recovery-apply.v1',
        recoveryApplyId: body.recoveryApplyId,
        recoveryPlanReplayRef,
        recoveryPlanEvidenceItemId: '00000000-0000-4000-8000-000000000145',
        runtimeCheckpointId: runtimeCheckpoint.id,
        recoveredNodeKeys: ['ideation'],
        executionStarted: false,
        productionReady: false,
      }),
    });
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'ready', startedAt: null, completedAt: null }),
        expect.objectContaining({ status: 'pending', completedAt: null }),
        expect.objectContaining({
          status: 'scheduled_not_executing',
          metadata: expect.objectContaining({
            lastRecoveryApply: expect.objectContaining({
              recoveryApplyId: body.recoveryApplyId,
              runtimeCheckpointId: runtimeCheckpoint.id,
              recoveredNodeKeys: ['ideation'],
            }),
          }),
        }),
      ]),
    );
    expect(deps.orchestrator.runTask).not.toHaveBeenCalled();
  });

  it('refuses safe recovery apply for blocked nodes and records a no-op evidence item', async () => {
    const deps = createMockDeps();
    const { insertedEvidenceItems, insertedMissionRuntimeCheckpoints } =
      captureEvidenceAndMissionCheckpointInserts(deps);
    const missionId = '00000000-0000-4000-8000-000000000150';
    const ventureId = '00000000-0000-4000-8000-000000000151';
    const blockedNodeId = '00000000-0000-4000-8000-000000000152';
    const recoveryPlanReplayRef = `mission:${missionId}:recovery-plan:def456`;
    const selectResults = [
      [
        {
          id: missionId,
          workspaceId,
          ventureId,
          title: 'Launch EvidenceOS',
          status: 'blocked',
          productionReady: false,
          metadata: {
            lastRecoveryPlan: {
              recoveryPlanId: 'mission-recovery-plan:def456',
              replayRef: recoveryPlanReplayRef,
            },
          },
        },
      ],
      [
        {
          id: '00000000-0000-4000-8000-000000000153',
          workspaceId,
          missionId,
          replayRef: recoveryPlanReplayRef,
          evidenceType: 'startup_lifecycle_recovery_plan',
          metadata: {
            plan: {
              failedNodeKeys: ['ideation'],
              blockedNodeKeys: ['launch_engine'],
            },
          },
        },
      ],
      [
        {
          id: blockedNodeId,
          workspaceId,
          missionId,
          nodeKey: 'launch_engine',
          stage: 'infrastructure_deployment',
          title: 'Launch readiness',
          status: 'blocked',
          sortOrder: 2,
        },
      ],
      [],
      [],
      [
        {
          id: blockedNodeId,
          workspaceId,
          missionId,
          nodeKey: 'launch_engine',
          stage: 'infrastructure_deployment',
          title: 'Launch readiness',
          status: 'blocked',
          sortOrder: 2,
        },
      ],
      [],
    ];
    let selectCall = 0;
    const originalSelect = deps.db.select;
    deps.db.select = vi.fn(() => {
      deps.db._setResult(selectResults[selectCall] ?? []);
      selectCall += 1;
      return originalSelect();
    }) as typeof deps.db.select;
    const updates: Array<Record<string, unknown>> = [];
    deps.db.update = vi.fn(() => ({
      set: vi.fn((payload: Record<string, unknown>) => {
        updates.push(payload);
        return { where: vi.fn(async () => []) };
      }),
    })) as unknown as typeof deps.db.update;

    const { fetch } = testApp(startupLifecycleRoutes, deps);
    const res = await fetch(
      'POST',
      `/missions/${missionId}/recover`,
      { retryNodeKeys: ['launch_engine'], reason: 'explicitly test blocked refusal' },
      wsHeader,
    );
    const body = await expectJson<{
      productionReady: boolean;
      status: string;
      missionStatus: string;
      executionStarted: boolean;
      recoveredNodes: unknown[];
      skippedNodes: Array<{ nodeId: string; nodeKey: string; status: string; reason: string }>;
      evidenceItemIds: string[];
    }>(res, 200);

    expect(body.productionReady).toBe(false);
    expect(body.status).toBe('recovery_noop_not_executed');
    expect(body.missionStatus).toBe('blocked');
    expect(body.executionStarted).toBe(false);
    expect(body.recoveredNodes).toEqual([]);
    expect(body.skippedNodes).toEqual([
      {
        nodeId: blockedNodeId,
        nodeKey: 'launch_engine',
        status: 'blocked',
        reason: 'Only failed mission nodes can be reset to ready by safe recovery apply',
      },
    ]);
    expect(body.evidenceItemIds).toEqual([
      '00000000-0000-4000-8000-000000000191',
      '00000000-0000-4000-8000-000000000192',
    ]);
    expect(insertedMissionRuntimeCheckpoints[0]).toMatchObject({
      checkpointKind: 'pre_recovery',
      blockedNodeIds: [blockedNodeId],
    });
    const runtimeCheckpoint = insertedMissionRuntimeCheckpoints[0] as {
      id: string;
      metadata: { replayRef: string };
    };
    expect(insertedEvidenceItems[1]).toMatchObject({
      workspaceId,
      ventureId,
      missionId,
      evidenceType: 'startup_lifecycle_recovery_applied',
      summary: 'No mission nodes were eligible for recovery apply',
      metadata: expect.objectContaining({
        recoveredNodeKeys: [],
        runtimeCheckpointId: runtimeCheckpoint.id,
        skippedNodes: [
          expect.objectContaining({
            nodeKey: 'launch_engine',
            status: 'blocked',
          }),
        ],
        executionStarted: false,
        productionReady: false,
      }),
    });
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      status: 'blocked',
      metadata: expect.objectContaining({
        lastRecoveryApply: expect.objectContaining({
          recoveredNodeKeys: [],
        }),
      }),
    });
    expect(deps.orchestrator.runTask).not.toHaveBeenCalled();
  });

  it('rolls back failed or blocked mission nodes without deleting history or external effects', async () => {
    const deps = createMockDeps();
    const { insertedEvidenceItems, insertedMissionRuntimeCheckpoints } =
      captureEvidenceAndMissionCheckpointInserts(deps);
    const missionId = '00000000-0000-4000-8000-000000000170';
    const failedNodeId = '00000000-0000-4000-8000-000000000171';
    const blockedNodeId = '00000000-0000-4000-8000-000000000172';
    const failedTaskId = '00000000-0000-4000-8000-000000000173';
    const blockedTaskId = '00000000-0000-4000-8000-000000000174';
    const selectResults = [
      [
        {
          id: missionId,
          workspaceId,
          ventureId: null,
          title: 'Launch EvidenceOS',
          status: 'blocked',
        },
      ],
      [
        {
          id: failedNodeId,
          workspaceId,
          missionId,
          nodeKey: 'ideation',
          stage: 'ideation',
          title: 'Venture hypothesis generation',
          status: 'failed',
          sortOrder: 0,
        },
        {
          id: blockedNodeId,
          workspaceId,
          missionId,
          nodeKey: 'market_research',
          stage: 'market_research',
          title: 'Market and competitor map',
          status: 'blocked',
          sortOrder: 1,
        },
      ],
      [
        {
          id: '00000000-0000-4000-8000-000000000175',
          workspaceId,
          missionId,
          fromNodeKey: 'ideation',
          toNodeKey: 'market_research',
        },
      ],
      [
        {
          id: '00000000-0000-4000-8000-000000000176',
          workspaceId,
          missionId,
          nodeId: failedNodeId,
          taskId: failedTaskId,
        },
        {
          id: '00000000-0000-4000-8000-000000000177',
          workspaceId,
          missionId,
          nodeId: blockedNodeId,
          taskId: blockedTaskId,
        },
      ],
      [],
    ];
    let selectCall = 0;
    const originalSelect = deps.db.select;
    deps.db.select = vi.fn(() => {
      deps.db._setResult(selectResults[selectCall] ?? []);
      selectCall += 1;
      return originalSelect();
    }) as typeof deps.db.select;
    const updates: Array<Record<string, unknown>> = [];
    deps.db.update = vi.fn(() => ({
      set: vi.fn((payload: Record<string, unknown>) => {
        updates.push(payload);
        return { where: vi.fn(async () => []) };
      }),
    })) as unknown as typeof deps.db.update;

    const { fetch } = testApp(startupLifecycleRoutes, deps);
    const res = await fetch(
      'POST',
      `/missions/${missionId}/rollback`,
      { reason: 'retry failed research branch' },
      wsHeader,
    );
    const body = await expectJson<{
      rollbackVersion: string;
      checkpoint: {
        checkpointId: string;
        checkpointKind: string;
        rollbackPlan: { targetNodeKeys: string[] };
      };
      rolledBackNodes: Array<{ nodeId: string; nodeKey: string; waitingOn: string[] }>;
      missionStatus: string;
      evidenceItemIds: string[];
      blockers: string[];
    }>(res, 200);

    expect(body.rollbackVersion).toBe('mission-rollback.v1');
    expect(body.checkpoint.checkpointKind).toBe('pre_rollback');
    expect(body.checkpoint.rollbackPlan.targetNodeKeys).toEqual(['ideation', 'market_research']);
    expect(body.rolledBackNodes).toEqual([
      expect.objectContaining({ nodeId: failedNodeId, nodeKey: 'ideation', waitingOn: [] }),
      expect.objectContaining({
        nodeId: blockedNodeId,
        nodeKey: 'market_research',
        waitingOn: ['ideation'],
      }),
    ]);
    expect(body.missionStatus).toBe('scheduled_not_executing');
    expect(body.evidenceItemIds).toEqual([
      '00000000-0000-4000-8000-000000000191',
      '00000000-0000-4000-8000-000000000192',
    ]);
    expect(body.blockers.join(' ')).toContain('does not reverse external-world actions');
    expect(insertedMissionRuntimeCheckpoints[0]).toMatchObject({
      checkpointKind: 'pre_rollback',
      rollbackPlan: expect.objectContaining({
        destructive: false,
        targetNodeKeys: ['ideation', 'market_research'],
      }),
    });
    expect(insertedEvidenceItems[1]).toMatchObject({
      evidenceType: 'startup_lifecycle_mission_rollback_applied',
      replayRef: `mission:${missionId}:rollback:${body.checkpoint.checkpointId}`,
    });
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'ready' }),
        expect.objectContaining({ status: 'pending' }),
        expect.objectContaining({ status: 'scheduled_not_executing' }),
      ]),
    );
    expect(deps.orchestrator.runTask).not.toHaveBeenCalled();
  });

  it('records unique runtime checkpoint replay refs for repeated rollback checkpoints', async () => {
    const missionId = '00000000-0000-4000-8000-000000000190';
    const failedNodeId = '00000000-0000-4000-8000-000000000191';

    async function runRollbackCheckpoint(reason: string) {
      const deps = createMockDeps();
      const { insertedEvidenceItems, insertedMissionRuntimeCheckpoints } =
        captureEvidenceAndMissionCheckpointInserts(deps);
      const selectResults = [
        [
          {
            id: missionId,
            workspaceId,
            ventureId: null,
            title: 'Launch EvidenceOS',
            status: 'blocked',
          },
        ],
        [
          {
            id: failedNodeId,
            workspaceId,
            missionId,
            nodeKey: 'ideation',
            stage: 'ideation',
            title: 'Venture hypothesis generation',
            status: 'failed',
            sortOrder: 0,
          },
        ],
        [],
        [],
        [],
      ];
      let selectCall = 0;
      const originalSelect = deps.db.select;
      deps.db.select = vi.fn(() => {
        deps.db._setResult(selectResults[selectCall] ?? []);
        selectCall += 1;
        return originalSelect();
      }) as typeof deps.db.select;

      const { fetch } = testApp(startupLifecycleRoutes, deps);
      const res = await fetch('POST', `/missions/${missionId}/rollback`, { reason }, wsHeader);
      await expectJson(res, 200);
      return {
        checkpoint: insertedMissionRuntimeCheckpoints[0] as {
          id: string;
          metadata: { replayRef: string };
        },
        checkpointEvidence: insertedEvidenceItems[0] as {
          replayRef: string;
          metadata: { checkpointId: string };
        },
      };
    }

    const first = await runRollbackCheckpoint('first rollback checkpoint');
    const second = await runRollbackCheckpoint('second rollback checkpoint');

    expect(first.checkpoint.id).not.toBe(second.checkpoint.id);
    expect(first.checkpointEvidence.replayRef).toBe(first.checkpoint.metadata.replayRef);
    expect(second.checkpointEvidence.replayRef).toBe(second.checkpoint.metadata.replayRef);
    expect(first.checkpointEvidence.replayRef).toBe(
      `mission:${missionId}:checkpoint:pre_rollback:${first.checkpoint.id}`,
    );
    expect(second.checkpointEvidence.replayRef).toBe(
      `mission:${missionId}:checkpoint:pre_rollback:${second.checkpoint.id}`,
    );
    expect(first.checkpointEvidence.replayRef).not.toBe(second.checkpointEvidence.replayRef);
    expect(first.checkpointEvidence.replayRef).not.toBe(
      `mission:${missionId}:checkpoint:pre_rollback`,
    );
    expect(first.checkpointEvidence.metadata.checkpointId).toBe(first.checkpoint.id);
    expect(second.checkpointEvidence.metadata.checkpointId).toBe(second.checkpoint.id);
  });

  it('does not commit checkpoint evidence when runtime checkpoint persistence fails', async () => {
    const missionId = '00000000-0000-4000-8000-000000000190';
    const failedNodeId = '00000000-0000-4000-8000-000000000191';
    const deps = createMockDeps();
    const {
      insertedEvidenceItems,
      insertedAuditEvents,
      updatedAuditEvents,
      insertedMissionRuntimeCheckpoints,
    } = captureFailedMissionCheckpointTransaction(deps);
    const selectResults = [
      [
        {
          id: missionId,
          workspaceId,
          ventureId: null,
          title: 'Launch EvidenceOS',
          status: 'blocked',
        },
      ],
      [
        {
          id: failedNodeId,
          workspaceId,
          missionId,
          nodeKey: 'ideation',
          stage: 'ideation',
          title: 'Venture hypothesis generation',
          status: 'failed',
          sortOrder: 0,
        },
      ],
      [],
      [],
      [],
    ];
    let selectCall = 0;
    const originalSelect = deps.db.select;
    deps.db.select = vi.fn(() => {
      deps.db._setResult(selectResults[selectCall] ?? []);
      selectCall += 1;
      return originalSelect();
    }) as typeof deps.db.select;

    const { fetch } = testApp(startupLifecycleRoutes, deps);
    const res = await fetch(
      'POST',
      `/missions/${missionId}/rollback`,
      { reason: 'force checkpoint insert failure' },
      wsHeader,
    );

    expect(res.status).toBe(500);
    expect(insertedEvidenceItems).toEqual([]);
    expect(insertedAuditEvents).toEqual([]);
    expect(updatedAuditEvents).toEqual([]);
    expect(insertedMissionRuntimeCheckpoints).toEqual([]);
  });

  it('executes a ready mission node through the governed task runtime without production promotion', async () => {
    const deps = createMockDeps();
    const insertedEvidenceItems = captureEvidenceItemInserts(deps);
    const missionId = '00000000-0000-4000-8000-000000000030';
    const ventureId = '00000000-0000-4000-8000-000000000031';
    const nodeId = '00000000-0000-4000-8000-000000000032';
    const taskId = '00000000-0000-4000-8000-000000000033';
    const operatorId = '00000000-0000-4000-8000-000000000034';
    const ideationNodeId = '00000000-0000-4000-8000-000000000036';
    const ideationTaskId = '00000000-0000-4000-8000-000000000037';
    const selectResults = [
      [
        {
          id: missionId,
          workspaceId,
          ventureId,
          title: 'Launch EvidenceOS',
          status: 'scheduled_not_executing',
          startedAt: null,
        },
      ],
      [
        {
          id: nodeId,
          workspaceId,
          missionId,
          nodeKey: 'founder_onboarding',
          stage: 'founder_onboarding',
          title: 'Founder DNA and access charter',
          objective: 'Draft founder DNA and access boundaries.',
          status: 'ready',
          requiredEvidence: ['founder goal intake'],
          acceptanceCriteria: ['Founder DNA draft exists'],
          helmPolicyClasses: ['access', 'audit'],
        },
      ],
      [
        {
          id: '00000000-0000-4000-8000-000000000035',
          workspaceId,
          missionId,
          nodeId,
          taskId,
        },
      ],
      [
        {
          id: taskId,
          workspaceId,
          operatorId,
          title: '[Lifecycle] Founder DNA and access charter',
          description: 'Draft founder DNA and access boundaries.',
          status: 'pending',
        },
      ],
      [{ id: operatorId }],
      [
        {
          id: nodeId,
          workspaceId,
          missionId,
          nodeKey: 'founder_onboarding',
          stage: 'founder_onboarding',
          title: 'Founder DNA and access charter',
          objective: 'Draft founder DNA and access boundaries.',
          status: 'completed',
          requiredEvidence: ['founder goal intake'],
          acceptanceCriteria: ['Founder DNA draft exists'],
          helmPolicyClasses: ['access', 'audit'],
        },
        {
          id: ideationNodeId,
          workspaceId,
          missionId,
          nodeKey: 'ideation',
          stage: 'ideation',
          title: 'Venture hypothesis generation',
          objective: 'Generate venture hypotheses.',
          status: 'pending',
          requiredEvidence: ['idea scoring evidence'],
          acceptanceCriteria: ['At least one venture hypothesis exists'],
          helmPolicyClasses: ['data_handling', 'audit'],
        },
      ],
      [
        {
          id: '00000000-0000-4000-8000-000000000038',
          workspaceId,
          missionId,
          edgeKey: 'founder_onboarding->ideation',
          fromNodeKey: 'founder_onboarding',
          toNodeKey: 'ideation',
          reason: 'Ideation depends on founder onboarding',
        },
      ],
      [
        {
          id: '00000000-0000-4000-8000-000000000039',
          workspaceId,
          missionId,
          nodeId: ideationNodeId,
          taskId: ideationTaskId,
        },
      ],
    ];
    let selectCall = 0;
    const originalSelect = deps.db.select;
    deps.db.select = vi.fn(() => {
      deps.db._setResult(selectResults[selectCall] ?? []);
      selectCall += 1;
      return originalSelect();
    }) as typeof deps.db.select;

    const { fetch } = testApp(startupLifecycleRoutes, deps);
    const res = await fetch(
      'POST',
      `/missions/${missionId}/nodes/${nodeId}/execute`,
      { iterationBudget: 3 },
      wsHeader,
    );
    const body = await expectJson<{
      missionId: string;
      nodeId: string;
      taskId: string;
      productionReady: boolean;
      executionStarted: boolean;
      status: string;
      missionStatus: string;
      run: { status: string; iterationsUsed: number; iterationBudget: number; actionCount: number };
      advancedReadyNodes: Array<{ nodeKey: string; taskId?: string; waitingOn: string[] }>;
      evidenceItemIds: string[];
      blockers: string[];
    }>(res, 200);

    expect(body.missionId).toBe(missionId);
    expect(body.nodeId).toBe(nodeId);
    expect(body.taskId).toBe(taskId);
    expect(body.productionReady).toBe(false);
    expect(body.executionStarted).toBe(true);
    expect(body.status).toBe('completed');
    expect(body.missionStatus).toBe('scheduled_not_executing');
    expect(body.advancedReadyNodes).toEqual([
      expect.objectContaining({
        nodeKey: 'ideation',
        taskId: ideationTaskId,
        waitingOn: [],
      }),
    ]);
    expect(body.evidenceItemIds).toEqual(['00000000-0000-4000-8000-000000000091']);
    expect(insertedEvidenceItems[0]).toMatchObject({
      workspaceId,
      ventureId,
      missionId,
      taskId,
      evidenceType: 'startup_lifecycle_node_executed',
      sourceType: 'gateway_startup_lifecycle',
      summary: 'founder_onboarding finished with completed',
      replayRef: `mission:${missionId}:node:${nodeId}:execute`,
      metadata: expect.objectContaining({
        executorVersion: 'mission-node-executor.v1',
        nodeKey: 'founder_onboarding',
        runStatus: 'completed',
        nodeStatus: 'completed',
        productionReady: false,
      }),
    });
    expect(body.run).toMatchObject({
      status: 'completed',
      iterationsUsed: 1,
      iterationBudget: 50,
      actionCount: 0,
    });
    expect(body.blockers.join(' ')).toContain('has not passed Full Startup Launch Eval');
    expect(deps.orchestrator.runTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId,
        workspaceId,
        ventureId,
        missionId,
        operatorId,
        iterationBudget: 3,
      }),
    );
  });

  it('rejects mission node execution when the task operator is outside the workspace', async () => {
    const deps = createMockDeps();
    const missionId = '00000000-0000-4000-8000-000000000130';
    const ventureId = '00000000-0000-4000-8000-000000000131';
    const nodeId = '00000000-0000-4000-8000-000000000132';
    const taskId = '00000000-0000-4000-8000-000000000133';
    const operatorId = '00000000-0000-4000-8000-000000000134';
    const selectResults = [
      [
        {
          id: missionId,
          workspaceId,
          ventureId,
          title: 'Launch EvidenceOS',
          status: 'scheduled_not_executing',
          startedAt: null,
        },
      ],
      [
        {
          id: nodeId,
          workspaceId,
          missionId,
          nodeKey: 'founder_onboarding',
          stage: 'founder_onboarding',
          title: 'Founder DNA and access charter',
          objective: 'Draft founder DNA and access boundaries.',
          status: 'ready',
          requiredEvidence: ['founder goal intake'],
          acceptanceCriteria: ['Founder DNA draft exists'],
          helmPolicyClasses: ['access', 'audit'],
        },
      ],
      [
        {
          id: '00000000-0000-4000-8000-000000000135',
          workspaceId,
          missionId,
          nodeId,
          taskId,
        },
      ],
      [
        {
          id: taskId,
          workspaceId,
          operatorId,
          title: '[Lifecycle] Founder DNA and access charter',
          description: 'Draft founder DNA and access boundaries.',
          status: 'pending',
        },
      ],
      [],
    ];
    let selectCall = 0;
    const originalSelect = deps.db.select;
    deps.db.select = vi.fn(() => {
      deps.db._setResult(selectResults[selectCall] ?? []);
      selectCall += 1;
      return originalSelect();
    }) as typeof deps.db.select;

    const { fetch } = testApp(startupLifecycleRoutes, deps);
    const res = await fetch('POST', `/missions/${missionId}/nodes/${nodeId}/execute`, {}, wsHeader);
    const body = await expectJson<{ error: string; remediation: string }>(res, 403);

    expect(body.error).toBe('operatorId does not belong to authenticated workspace');
    expect(body.remediation).toContain('Reassign');
    expect(deps.db.update).not.toHaveBeenCalled();
    expect(deps.orchestrator.runTask).not.toHaveBeenCalled();
  });

  it('executes bounded ready mission nodes in dependency order without production promotion', async () => {
    const deps = createMockDeps();
    const insertedEvidenceItems = captureEvidenceItemInserts(deps);
    const missionId = '00000000-0000-4000-8000-000000000060';
    const ventureId = '00000000-0000-4000-8000-000000000061';
    const nodeId = '00000000-0000-4000-8000-000000000062';
    const taskId = '00000000-0000-4000-8000-000000000063';
    const ideationNodeId = '00000000-0000-4000-8000-000000000064';
    const ideationTaskId = '00000000-0000-4000-8000-000000000065';
    const founderNode = {
      id: nodeId,
      workspaceId,
      missionId,
      nodeKey: 'founder_onboarding',
      stage: 'founder_onboarding',
      title: 'Founder DNA and access charter',
      objective: 'Draft founder DNA and access boundaries.',
      status: 'ready',
      sortOrder: 0,
      requiredEvidence: ['founder goal intake'],
      acceptanceCriteria: ['Founder DNA draft exists'],
      helmPolicyClasses: ['access', 'audit'],
    };
    const ideationNode = {
      id: ideationNodeId,
      workspaceId,
      missionId,
      nodeKey: 'ideation',
      stage: 'ideation',
      title: 'Venture hypothesis generation',
      objective: 'Generate venture hypotheses.',
      status: 'ready',
      sortOrder: 1,
      requiredEvidence: ['idea scoring evidence'],
      acceptanceCriteria: ['At least one venture hypothesis exists'],
      helmPolicyClasses: ['data_handling', 'audit'],
    };
    const selectResults = [
      [
        {
          id: missionId,
          workspaceId,
          ventureId,
          title: 'Launch EvidenceOS',
          status: 'scheduled_not_executing',
          startedAt: null,
        },
      ],
      [founderNode],
      [
        {
          id: '00000000-0000-4000-8000-000000000066',
          workspaceId,
          missionId,
          nodeId,
          taskId,
        },
      ],
      [
        {
          id: taskId,
          workspaceId,
          operatorId: null,
          title: '[Lifecycle] Founder DNA and access charter',
          description: 'Draft founder DNA and access boundaries.',
          status: 'pending',
        },
      ],
      [
        { ...founderNode, status: 'completed' },
        { ...ideationNode, status: 'pending' },
      ],
      [
        {
          id: '00000000-0000-4000-8000-000000000067',
          workspaceId,
          missionId,
          edgeKey: 'founder_onboarding->ideation',
          fromNodeKey: 'founder_onboarding',
          toNodeKey: 'ideation',
          reason: 'Ideation depends on founder onboarding',
        },
      ],
      [
        {
          id: '00000000-0000-4000-8000-000000000068',
          workspaceId,
          missionId,
          nodeId: ideationNodeId,
          taskId: ideationTaskId,
        },
      ],
      [ideationNode],
      [
        {
          id: '00000000-0000-4000-8000-000000000069',
          workspaceId,
          missionId,
          nodeId: ideationNodeId,
          taskId: ideationTaskId,
        },
      ],
      [
        {
          id: ideationTaskId,
          workspaceId,
          operatorId: null,
          title: '[Lifecycle] Venture hypothesis generation',
          description: 'Generate venture hypotheses.',
          status: 'pending',
        },
      ],
      [
        { ...founderNode, status: 'completed' },
        { ...ideationNode, status: 'completed' },
      ],
      [
        {
          id: '00000000-0000-4000-8000-000000000067',
          workspaceId,
          missionId,
          edgeKey: 'founder_onboarding->ideation',
          fromNodeKey: 'founder_onboarding',
          toNodeKey: 'ideation',
          reason: 'Ideation depends on founder onboarding',
        },
      ],
      [],
      [],
    ];
    let selectCall = 0;
    const originalSelect = deps.db.select;
    deps.db.select = vi.fn(() => {
      deps.db._setResult(selectResults[selectCall] ?? []);
      selectCall += 1;
      return originalSelect();
    }) as typeof deps.db.select;

    const { fetch } = testApp(startupLifecycleRoutes, deps);
    const res = await fetch(
      'POST',
      `/missions/${missionId}/execute-ready`,
      { maxNodes: 2, iterationBudget: 2 },
      wsHeader,
    );
    const body = await expectJson<{
      missionId: string;
      executorVersion: string;
      productionReady: boolean;
      executionStarted: boolean;
      missionStatus: string;
      executedNodes: Array<{
        nodeId: string;
        nodeKey: string;
        status: string;
        missionStatus: string;
        advancedReadyNodes: Array<{ nodeId: string; taskId?: string }>;
      }>;
      remainingReadyNodeIds: string[];
      evidenceItemIds: string[];
      blockers: string[];
    }>(res, 200);

    expect(body.missionId).toBe(missionId);
    expect(body.executorVersion).toBe('mission-executor.v1');
    expect(body.productionReady).toBe(false);
    expect(body.executionStarted).toBe(true);
    expect(body.missionStatus).toBe('completed');
    expect(body.executedNodes).toEqual([
      expect.objectContaining({
        nodeId,
        nodeKey: 'founder_onboarding',
        status: 'completed',
        missionStatus: 'scheduled_not_executing',
        advancedReadyNodes: [
          expect.objectContaining({ nodeId: ideationNodeId, taskId: ideationTaskId }),
        ],
      }),
      expect.objectContaining({
        nodeId: ideationNodeId,
        nodeKey: 'ideation',
        status: 'completed',
        missionStatus: 'completed',
        advancedReadyNodes: [],
      }),
    ]);
    expect(body.remainingReadyNodeIds).toEqual([]);
    expect(body.evidenceItemIds).toEqual([
      '00000000-0000-4000-8000-000000000091',
      '00000000-0000-4000-8000-000000000092',
    ]);
    expect(insertedEvidenceItems).toHaveLength(2);
    expect(body.blockers.join(' ')).toContain('not founder-off-grid autonomous execution');
    expect(deps.orchestrator.runTask).toHaveBeenCalledTimes(2);
    expect(deps.orchestrator.runTask).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        taskId,
        workspaceId,
        ventureId,
        missionId,
        iterationBudget: 2,
      }),
    );
    expect(deps.orchestrator.runTask).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        taskId: ideationTaskId,
        workspaceId,
        ventureId,
        missionId,
        iterationBudget: 2,
      }),
    );
  });

  it('reports no-op mission step execution when no nodes are ready', async () => {
    const deps = createMockDeps();
    const missionId = '00000000-0000-4000-8000-000000000070';
    const selectResults = [
      [
        {
          id: missionId,
          workspaceId,
          ventureId: null,
          title: 'Launch EvidenceOS',
          status: 'scheduled_not_executing',
          startedAt: null,
        },
      ],
      [],
      [],
    ];
    let selectCall = 0;
    const originalSelect = deps.db.select;
    deps.db.select = vi.fn(() => {
      deps.db._setResult(selectResults[selectCall] ?? []);
      selectCall += 1;
      return originalSelect();
    }) as typeof deps.db.select;

    const { fetch } = testApp(startupLifecycleRoutes, deps);
    const res = await fetch('POST', `/missions/${missionId}/execute-ready`, {}, wsHeader);
    const body = await expectJson<{
      productionReady: boolean;
      executionStarted: boolean;
      missionStatus: string;
      executedNodes: unknown[];
      remainingReadyNodeIds: string[];
      blockers: string[];
    }>(res, 200);

    expect(body.productionReady).toBe(false);
    expect(body.executionStarted).toBe(false);
    expect(body.missionStatus).toBe('blocked');
    expect(body.executedNodes).toEqual([]);
    expect(body.remainingReadyNodeIds).toEqual([]);
    expect(body.blockers.join(' ')).toContain('No ready mission node was executed');
    expect(deps.orchestrator.runTask).not.toHaveBeenCalled();
  });

  it('refuses to execute mission nodes that have not been scheduled ready', async () => {
    const deps = createMockDeps();
    const missionId = '00000000-0000-4000-8000-000000000040';
    const nodeId = '00000000-0000-4000-8000-000000000041';
    const selectResults = [
      [
        {
          id: missionId,
          workspaceId,
          ventureId: null,
          title: 'Launch EvidenceOS',
          status: 'persisted_not_executing',
          startedAt: null,
        },
      ],
      [
        {
          id: nodeId,
          workspaceId,
          missionId,
          nodeKey: 'ideation',
          stage: 'ideation',
          title: 'Venture hypothesis generation',
          objective: 'Generate venture hypotheses.',
          status: 'pending',
          requiredEvidence: ['idea scoring evidence'],
          acceptanceCriteria: ['At least one venture hypothesis exists'],
          helmPolicyClasses: ['data_handling', 'audit'],
        },
      ],
    ];
    let selectCall = 0;
    const originalSelect = deps.db.select;
    deps.db.select = vi.fn(() => {
      deps.db._setResult(selectResults[selectCall] ?? []);
      selectCall += 1;
      return originalSelect();
    }) as typeof deps.db.select;

    const { fetch } = testApp(startupLifecycleRoutes, deps);
    const res = await fetch('POST', `/missions/${missionId}/nodes/${nodeId}/execute`, {}, wsHeader);
    const body = await expectJson<{ error: string; nodeStatus: string; requiredStatus: string }>(
      res,
      409,
    );

    expect(body.error).toContain('not ready');
    expect(body.nodeStatus).toBe('pending');
    expect(body.requiredStatus).toBe('ready');
    expect(deps.orchestrator.runTask).not.toHaveBeenCalled();
  });

  it('marks mission node and task failed when execution throws', async () => {
    const deps = createMockDeps();
    const insertedEvidenceItems = captureEvidenceItemInserts(deps);
    const missionId = '00000000-0000-4000-8000-000000000050';
    const nodeId = '00000000-0000-4000-8000-000000000051';
    const taskId = '00000000-0000-4000-8000-000000000052';
    const selectResults = [
      [
        {
          id: missionId,
          workspaceId,
          ventureId: null,
          title: 'Launch EvidenceOS',
          status: 'scheduled_not_executing',
          startedAt: null,
        },
      ],
      [
        {
          id: nodeId,
          workspaceId,
          missionId,
          nodeKey: 'founder_onboarding',
          stage: 'founder_onboarding',
          title: 'Founder DNA and access charter',
          objective: 'Draft founder DNA and access boundaries.',
          status: 'ready',
          requiredEvidence: ['founder goal intake'],
          acceptanceCriteria: ['Founder DNA draft exists'],
          helmPolicyClasses: ['access', 'audit'],
        },
      ],
      [{ id: '00000000-0000-4000-8000-000000000053', workspaceId, missionId, nodeId, taskId }],
      [
        {
          id: taskId,
          workspaceId,
          operatorId: null,
          title: '[Lifecycle] Founder DNA and access charter',
          description: 'Draft founder DNA and access boundaries.',
          status: 'pending',
        },
      ],
    ];
    let selectCall = 0;
    const originalSelect = deps.db.select;
    deps.db.select = vi.fn(() => {
      deps.db._setResult(selectResults[selectCall] ?? []);
      selectCall += 1;
      return originalSelect();
    }) as typeof deps.db.select;
    const updates: Array<Record<string, unknown>> = [];
    deps.db.update = vi.fn(() => ({
      set: vi.fn((payload: Record<string, unknown>) => {
        updates.push(payload);
        return { where: vi.fn(async () => []) };
      }),
    })) as unknown as typeof deps.db.update;
    deps.orchestrator.runTask = vi.fn(async () => {
      throw new Error('HELM unavailable');
    }) as typeof deps.orchestrator.runTask;

    const { fetch } = testApp(startupLifecycleRoutes, deps);
    const res = await fetch('POST', `/missions/${missionId}/nodes/${nodeId}/execute`, {}, wsHeader);
    const body = await expectJson<{
      error: string;
      detail: string;
      productionReady: boolean;
      evidenceItemIds: string[];
    }>(res, 502);

    expect(body.error).toContain('execution failed');
    expect(body.detail).toContain('HELM unavailable');
    expect(body.productionReady).toBe(false);
    expect(body.evidenceItemIds).toEqual(['00000000-0000-4000-8000-000000000091']);
    expect(insertedEvidenceItems[0]).toMatchObject({
      workspaceId,
      missionId,
      taskId,
      evidenceType: 'startup_lifecycle_node_failed',
      sourceType: 'gateway_startup_lifecycle',
      summary: 'HELM unavailable',
      replayRef: `mission:${missionId}:node:${nodeId}:failure`,
      metadata: expect.objectContaining({
        executorVersion: 'mission-node-executor.v1',
        nodeKey: 'founder_onboarding',
        nodeStatus: 'failed',
        missionStatus: 'blocked',
        productionReady: false,
      }),
    });
    expect(updates.filter((payload) => payload.status === 'failed')).toHaveLength(2);
  });
});
