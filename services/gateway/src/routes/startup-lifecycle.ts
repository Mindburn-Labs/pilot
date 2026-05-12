import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { appendEvidenceItem } from '@pilot/db';
import {
  evidenceItems,
  auditLog,
  goals,
  missionEdges,
  missionNodes,
  missionRuntimeCheckpoints,
  missions,
  missionTasks,
  tasks,
  taskRuns,
  ventures,
} from '@pilot/db/schema';
import {
  AppliedStartupMissionRecoverySchema,
  ApplyStartupMissionRecoveryInputSchema,
  CheckpointedStartupMissionSchema,
  CheckpointStartupMissionInputSchema,
  CompileStartupLifecycleInputSchema,
  ExecutedStartupMissionSchema,
  ExecutedStartupMissionNodeSchema,
  ExecuteStartupMissionInputSchema,
  ExecuteStartupMissionNodeInputSchema,
  type ExecutedStartupMissionNode,
  type AppliedStartupMissionRecovery,
  MissionRuntimeCheckpointSchema,
  type MissionRuntimeCheckpointKind,
  PlannedStartupMissionRecoverySchema,
  PlanStartupMissionRecoveryInputSchema,
  PersistStartupLifecycleInputSchema,
  PersistedStartupLifecycleMissionSchema,
  RolledBackStartupMissionSchema,
  RollbackStartupMissionInputSchema,
  type ScheduledStartupMissionNode,
  ScheduledStartupMissionSchema,
  ScheduleStartupMissionInputSchema,
  StartupLifecycleStageSchema,
  compileStartupLifecycleMission,
  getStartupLifecycleTemplates,
} from '@pilot/shared/schemas';
import { getCapabilityRecord } from '@pilot/shared/capabilities';
import { type GatewayDeps } from '../index.js';
import {
  getWorkspaceId,
  requireWorkspaceRole,
  workspaceIdMismatch,
  workspaceOperatorBelongsToWorkspace,
} from '../lib/workspace.js';

type MissionContextRunTask = (params: {
  taskId: string;
  workspaceId: string;
  ventureId?: string;
  missionId?: string;
  operatorId?: string;
  context: string;
  iterationBudget?: number;
}) => ReturnType<GatewayDeps['orchestrator']['runTask']>;

export function startupLifecycleRoutes(_deps: GatewayDeps) {
  const app = new Hono();

  app.get('/templates', (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view startup lifecycle templates');
    if (roleDenied) return roleDenied;

    return c.json({
      workspaceId,
      capability: getCapabilityRecord('startup_lifecycle'),
      templates: getStartupLifecycleTemplates(),
    });
  });

  app.post('/compile', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'compile startup lifecycle mission');
    if (roleDenied) return roleDenied;

    const raw = await c.req.json().catch(() => ({}));
    if (workspaceIdMismatch(c, (raw as { workspaceId?: string }).workspaceId)) {
      return c.json({ error: 'workspaceId does not match authenticated workspace' }, 403);
    }

    const parsed = CompileStartupLifecycleInputSchema.safeParse({
      ...(raw as Record<string, unknown>),
      workspaceId,
    });
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const compiled = compileStartupLifecycleMission(parsed.data);
    return c.json(compiled, 200);
  });

  app.post('/persist', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'persist startup lifecycle mission');
    if (roleDenied) return roleDenied;

    const raw = await c.req.json().catch(() => ({}));
    if (workspaceIdMismatch(c, (raw as { workspaceId?: string }).workspaceId)) {
      return c.json({ error: 'workspaceId does not match authenticated workspace' }, 403);
    }

    const parsed = PersistStartupLifecycleInputSchema.safeParse({
      ...(raw as Record<string, unknown>),
      workspaceId,
    });
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const compiled = compileStartupLifecycleMission(parsed.data);
    const ventureName = parsed.data.ventureName ?? deriveVentureName(parsed.data.founderGoal);

    const { createdVenture, createdGoal, createdMission, createdNodes, taskCount, evidenceItemId } =
      await _deps.db.transaction(async (tx) => {
        const db = tx as unknown as typeof _deps.db;
        const [persistedVenture] = await db
          .insert(ventures)
          .values({
            workspaceId,
            name: ventureName,
            status: 'draft',
            metadata: {
              source: 'startup_lifecycle_persist',
              ventureContext: parsed.data.ventureContext ?? null,
              productionReady: false,
            },
          })
          .returning();
        if (!persistedVenture) throw new Error('venture was not persisted');

        const [persistedGoal] = await db
          .insert(goals)
          .values({
            workspaceId,
            ventureId: persistedVenture.id,
            title: 'Founder startup goal',
            description: parsed.data.founderGoal,
            status: 'compiled',
            autonomyMode: parsed.data.autonomyMode,
            constraints: parsed.data.constraints,
            metadata: {
              source: 'startup_lifecycle_persist',
              ventureContext: parsed.data.ventureContext ?? null,
            },
          })
          .returning();
        if (!persistedGoal) throw new Error('goal was not persisted');

        const [persistedMission] = await db
          .insert(missions)
          .values({
            workspaceId,
            ventureId: persistedVenture.id,
            goalId: persistedGoal.id,
            missionKey: compiled.mission.id,
            title: compiled.mission.title,
            status: 'persisted_not_executing',
            compilerVersion: compiled.compilerVersion,
            autonomyMode: compiled.mission.autonomyMode,
            capabilityState: compiled.capabilityState,
            productionReady: false,
            assumptions: compiled.mission.assumptions,
            blockers: persistedMissionBlockers(compiled.mission.blockers),
            metadata: {
              source: 'startup_lifecycle_persist',
              founderGoal: compiled.mission.founderGoal,
              ventureContext: compiled.mission.ventureContext ?? null,
              constraints: compiled.mission.constraints,
            },
          })
          .returning();
        if (!persistedMission) throw new Error('mission was not persisted');

        const persistedNodes = [];
        for (const [index, node] of compiled.mission.nodes.entries()) {
          const [createdNode] = await db
            .insert(missionNodes)
            .values({
              workspaceId,
              missionId: persistedMission.id,
              nodeKey: node.id,
              stage: node.stage,
              title: node.title,
              objective: node.objective,
              status: 'pending',
              sortOrder: index,
              requiredAgents: node.requiredAgents,
              requiredSkills: node.requiredSkills,
              requiredTools: node.requiredTools,
              requiredEvidence: node.requiredEvidence,
              helmPolicyClasses: node.helmPolicyClasses,
              escalationConditions: node.escalationConditions,
              acceptanceCriteria: node.acceptanceCriteria,
              metadata: {
                dependsOn: node.dependsOn,
                source: 'startup_lifecycle_template',
              },
            })
            .returning();
          if (!createdNode) throw new Error(`mission node ${node.id} was not persisted`);
          persistedNodes.push({ node, row: createdNode });
        }

        if (compiled.mission.edges.length > 0) {
          await db.insert(missionEdges).values(
            compiled.mission.edges.map((edge) => ({
              workspaceId,
              missionId: persistedMission.id,
              edgeKey: edge.id,
              fromNodeKey: edge.from,
              toNodeKey: edge.to,
              reason: edge.reason,
              metadata: { source: 'startup_lifecycle_template' },
            })),
          );
        }

        let createdTaskCount = 0;
        if (parsed.data.createNodeTasks) {
          for (const { node, row } of persistedNodes) {
            const [createdTask] = await db
              .insert(tasks)
              .values({
                workspaceId,
                title: `[Lifecycle] ${node.title}`,
                description: node.objective,
                mode: 'mission',
                status: 'pending',
                priority: taskPriorityForStage(node.stage),
                metadata: {
                  kind: 'startup_lifecycle_node',
                  ventureId: persistedVenture.id,
                  goalId: persistedGoal.id,
                  missionId: persistedMission.id,
                  missionNodeId: row.id,
                  stage: node.stage,
                  requiredAgents: node.requiredAgents,
                  requiredSkills: node.requiredSkills,
                  requiredTools: node.requiredTools,
                  requiredEvidence: node.requiredEvidence,
                  helmPolicyClasses: node.helmPolicyClasses,
                  escalationConditions: node.escalationConditions,
                  acceptanceCriteria: node.acceptanceCriteria,
                  productionReady: false,
                },
              })
              .returning();
            if (!createdTask) throw new Error(`task for node ${node.id} was not persisted`);
            await db.insert(missionTasks).values({
              workspaceId,
              missionId: persistedMission.id,
              nodeId: row.id,
              taskId: createdTask.id,
              role: 'startup_lifecycle_node',
            });
            createdTaskCount += 1;
          }
        }

        const persistedEvidenceItemId = await appendEvidenceItem(db, {
          workspaceId,
          ventureId: persistedVenture.id,
          missionId: persistedMission.id,
          evidenceType: 'startup_lifecycle_mission_persisted',
          sourceType: 'gateway_startup_lifecycle',
          title: `Startup lifecycle mission persisted: ${compiled.mission.title}`,
          summary: compiled.mission.founderGoal,
          redactionState: 'redacted',
          sensitivity: 'internal',
          contentHash: hashJson({
            missionKey: compiled.mission.id,
            founderGoal: compiled.mission.founderGoal,
            nodeKeys: compiled.mission.nodes.map((node) => node.id),
            edges: compiled.mission.edges,
          }),
          replayRef: `mission:${persistedMission.id}:persisted`,
          metadata: {
            compilerVersion: compiled.compilerVersion,
            autonomyMode: compiled.mission.autonomyMode,
            capabilityState: compiled.capabilityState,
            productionReady: false,
            nodeCount: persistedNodes.length,
            edgeCount: compiled.mission.edges.length,
            taskCount: createdTaskCount,
            source: 'startup_lifecycle_persist',
          },
        });

        return {
          createdVenture: persistedVenture,
          createdGoal: persistedGoal,
          createdMission: persistedMission,
          createdNodes: persistedNodes,
          taskCount: createdTaskCount,
          evidenceItemId: persistedEvidenceItemId,
        };
      });

    const response = PersistedStartupLifecycleMissionSchema.parse({
      ...compiled,
      evidenceItemIds: [evidenceItemId],
      mission: {
        ...compiled.mission,
        status: 'persisted_not_executing',
        blockers: persistedMissionBlockers(compiled.mission.blockers),
      },
      persisted: {
        ventureId: createdVenture.id,
        goalId: createdGoal.id,
        missionId: createdMission.id,
        nodeCount: createdNodes.length,
        edgeCount: compiled.mission.edges.length,
        taskCount,
      },
    });

    return c.json(response, 201);
  });

  app.post('/missions/:missionId/checkpoint', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'checkpoint startup lifecycle mission');
    if (roleDenied) return roleDenied;

    const raw = await c.req.json().catch(() => ({}));
    if (workspaceIdMismatch(c, (raw as { workspaceId?: string }).workspaceId)) {
      return c.json({ error: 'workspaceId does not match authenticated workspace' }, 403);
    }

    const parsed = CheckpointStartupMissionInputSchema.safeParse({
      ...(raw as Record<string, unknown>),
      workspaceId,
      missionId: c.req.param('missionId'),
    });
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const [mission] = await _deps.db
      .select()
      .from(missions)
      .where(and(eq(missions.id, parsed.data.missionId), eq(missions.workspaceId, workspaceId)))
      .limit(1);
    if (!mission) return c.json({ error: 'Mission not found' }, 404);

    const nodeRows = await _deps.db
      .select()
      .from(missionNodes)
      .where(and(eq(missionNodes.missionId, mission.id), eq(missionNodes.workspaceId, workspaceId)))
      .orderBy(missionNodes.sortOrder);
    const edgeRows = await _deps.db
      .select()
      .from(missionEdges)
      .where(and(eq(missionEdges.missionId, mission.id), eq(missionEdges.workspaceId, workspaceId)))
      .orderBy(missionEdges.edgeKey);
    const taskLinks = await _deps.db
      .select()
      .from(missionTasks)
      .where(and(eq(missionTasks.missionId, mission.id), eq(missionTasks.workspaceId, workspaceId)))
      .orderBy(missionTasks.createdAt);

    const nodeStatuses = countNodeStatuses(nodeRows);
    const snapshot = {
      mission: {
        id: mission.id,
        status: mission.status,
        autonomyMode: mission.autonomyMode,
        capabilityState: mission.capabilityState,
        productionReady: mission.productionReady,
      },
      nodes: nodeRows.map((node) => ({
        id: node.id,
        nodeKey: node.nodeKey,
        status: node.status,
        stage: node.stage,
        sortOrder: node.sortOrder,
      })),
      edges: edgeRows.map((edge) => ({
        id: edge.id,
        edgeKey: edge.edgeKey,
        fromNodeKey: edge.fromNodeKey,
        toNodeKey: edge.toNodeKey,
      })),
      taskLinks: taskLinks.map((link) => ({
        id: link.id,
        nodeId: link.nodeId,
        taskId: link.taskId,
        role: link.role,
      })),
      reason: parsed.data.reason ?? null,
    };
    const contentHash = hashJson(snapshot);
    const checkpointId = `mission-checkpoint:${contentHash.slice('sha256:'.length, 23)}`;
    const replayRef = `mission:${mission.id}:checkpoint:${checkpointId.split(':')[1]}`;
    const checkpointedAt = new Date();
    const readyNodeIds = nodeRows.filter((node) => node.status === 'ready').map((node) => node.id);
    const blockedNodeIds = nodeRows
      .filter((node) => node.status === 'blocked')
      .map((node) => node.id);
    const failedNodeIds = nodeRows
      .filter((node) => node.status === 'failed')
      .map((node) => node.id);
    const awaitingApprovalNodeIds = nodeRows
      .filter((node) => node.status === 'awaiting_approval')
      .map((node) => node.id);
    const cursorNode = nodeRows.find((node) =>
      ['running', 'ready', 'awaiting_approval', 'blocked', 'failed'].includes(node.status),
    );
    const runtimeSnapshot: MissionRuntimeSnapshot = {
      mission,
      nodes: nodeRows,
      edges: edgeRows,
      taskLinks,
      taskRunCheckpointRefs: [],
      nodeStatusCounts: nodeStatuses,
      ...(cursorNode ? { cursorNode } : {}),
    };

    const evidenceMetadata = {
      checkpointVersion: 'mission-checkpoint.v1',
      checkpointId,
      missionStatus: mission.status,
      nodeCount: nodeRows.length,
      edgeCount: edgeRows.length,
      taskLinkCount: taskLinks.length,
      nodeStatuses,
      snapshot,
      productionReady: false,
    };
    const auditMetadata = {
      evidenceType: 'startup_lifecycle_mission_checkpoint',
      replayRef,
      contentHash,
      ...evidenceMetadata,
    };
    const { evidenceItemId, runtimeCheckpoint } = await _deps.db.transaction(async (tx) => {
      const db = tx as unknown as typeof _deps.db;
      const auditEventId = randomUUID();
      await db.insert(auditLog).values({
        id: auditEventId,
        workspaceId,
        action: 'STARTUP_LIFECYCLE_MISSION_CHECKPOINT',
        actor: `workspace:${workspaceId}`,
        target: mission.id,
        verdict: 'recorded',
        reason: parsed.data.reason ?? `Checkpoint for mission status ${mission.status}`,
        metadata: auditMetadata,
        createdAt: checkpointedAt,
      });
      const persistedEvidenceItemId = await appendEvidenceItem(db, {
        workspaceId,
        auditEventId,
        ventureId: mission.ventureId ?? null,
        missionId: mission.id,
        evidenceType: 'startup_lifecycle_mission_checkpoint',
        sourceType: 'gateway_startup_lifecycle',
        title: `Startup lifecycle mission checkpoint: ${mission.title}`,
        summary: parsed.data.reason ?? `Checkpoint for mission status ${mission.status}`,
        redactionState: 'redacted',
        sensitivity: 'internal',
        contentHash,
        replayRef,
        observedAt: checkpointedAt,
        metadata: evidenceMetadata,
      });
      await db
        .update(auditLog)
        .set({
          metadata: {
            ...auditMetadata,
            evidenceItemId: persistedEvidenceItemId,
          },
        })
        .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));
      const [persistedRuntimeCheckpoint] = await db
        .insert(missionRuntimeCheckpoints)
        .values({
          workspaceId,
          missionId: mission.id,
          checkpointKind: 'manual_checkpoint',
          checkpointStatus: 'recorded',
          missionStatus: mission.status,
          cursorNodeId: cursorNode?.id ?? null,
          cursorNodeKey: cursorNode?.nodeKey ?? null,
          nodeStatusCounts: nodeStatuses,
          readyNodeIds,
          blockedNodeIds,
          failedNodeIds,
          awaitingApprovalNodeIds,
          taskRunCheckpointRefs: [],
          recoveryPlan: buildRuntimeRecoveryPlan(runtimeSnapshot),
          rollbackPlan: {},
          evidenceItemId: persistedEvidenceItemId,
          contentHash,
          metadata: {
            checkpointVersion: 'mission-runtime-checkpoint.v1',
            sourceCheckpointVersion: 'mission-checkpoint.v1',
            checkpointId,
            replayRef,
            reason: parsed.data.reason ?? null,
            snapshot,
            productionReady: false,
          },
          createdAt: checkpointedAt,
        })
        .returning({ id: missionRuntimeCheckpoints.id });
      if (!persistedRuntimeCheckpoint?.id) {
        throw new Error('Manual mission runtime checkpoint was not persisted');
      }

      await db
        .update(missions)
        .set({
          metadata: {
            ...jsonRecord(mission.metadata),
            lastCheckpoint: {
              checkpointId,
              evidenceItemId: persistedEvidenceItemId,
              replayRef,
              contentHash,
              checkpointedAt: checkpointedAt.toISOString(),
            },
          },
          updatedAt: checkpointedAt,
        })
        .where(and(eq(missions.id, mission.id), eq(missions.workspaceId, workspaceId)));

      return {
        evidenceItemId: persistedEvidenceItemId,
        runtimeCheckpoint: persistedRuntimeCheckpoint,
      };
    });

    const response = CheckpointedStartupMissionSchema.parse({
      workspaceId,
      missionId: mission.id,
      checkpointId,
      runtimeCheckpointId: runtimeCheckpoint.id,
      checkpointVersion: 'mission-checkpoint.v1',
      productionReady: false,
      status: 'checkpointed_not_recovered',
      missionStatus: mission.status,
      replayRef,
      evidenceItemIds: [evidenceItemId],
      snapshot: {
        missionId: mission.id,
        status: mission.status,
        nodeCount: nodeRows.length,
        edgeCount: edgeRows.length,
        taskLinkCount: taskLinks.length,
        nodeStatuses,
      },
      blockers: [
        'Mission checkpoint snapshots are durable evidence for constrained recovery and rollback controls; production retry/replay and founder-off-grid execution remain incomplete.',
        'Full Startup Launch Eval has not promoted mission_runtime or startup_lifecycle to production_ready.',
      ],
    });

    return c.json(response, 200);
  });

  app.post('/missions/:missionId/recovery-plan', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'plan startup lifecycle recovery');
    if (roleDenied) return roleDenied;

    const raw = await c.req.json().catch(() => ({}));
    if (workspaceIdMismatch(c, (raw as { workspaceId?: string }).workspaceId)) {
      return c.json({ error: 'workspaceId does not match authenticated workspace' }, 403);
    }

    const parsed = PlanStartupMissionRecoveryInputSchema.safeParse({
      ...(raw as Record<string, unknown>),
      workspaceId,
      missionId: c.req.param('missionId'),
    });
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const [mission] = await _deps.db
      .select()
      .from(missions)
      .where(and(eq(missions.id, parsed.data.missionId), eq(missions.workspaceId, workspaceId)))
      .limit(1);
    if (!mission) return c.json({ error: 'Mission not found' }, 404);

    const missionMetadata = jsonRecord(mission.metadata);
    const lastCheckpoint = jsonRecord(missionMetadata['lastCheckpoint']);
    let checkpointId = stringValue(lastCheckpoint['checkpointId']);
    let checkpointReplayRef = stringValue(lastCheckpoint['replayRef']);
    const [checkpointEvidence] = checkpointReplayRef
      ? await _deps.db
          .select()
          .from(evidenceItems)
          .where(
            and(
              eq(evidenceItems.workspaceId, workspaceId),
              eq(evidenceItems.replayRef, checkpointReplayRef),
            ),
          )
          .orderBy(desc(evidenceItems.observedAt), desc(evidenceItems.id))
          .limit(1)
      : [];
    const [checkpointRuntimeRow] = !checkpointEvidence
      ? await _deps.db
          .select()
          .from(missionRuntimeCheckpoints)
          .where(
            and(
              eq(missionRuntimeCheckpoints.workspaceId, workspaceId),
              eq(missionRuntimeCheckpoints.missionId, mission.id),
              eq(missionRuntimeCheckpoints.checkpointKind, 'manual_checkpoint'),
            ),
          )
          .orderBy(desc(missionRuntimeCheckpoints.createdAt), desc(missionRuntimeCheckpoints.id))
          .limit(1)
      : [];
    const checkpointRuntimeMetadata = jsonRecord(checkpointRuntimeRow?.metadata);
    checkpointId =
      checkpointId ??
      stringValue(checkpointRuntimeMetadata['checkpointId']) ??
      checkpointRuntimeRow?.id ??
      null;
    checkpointReplayRef =
      checkpointReplayRef ?? stringValue(checkpointRuntimeMetadata['replayRef']);
    const checkpointEvidenceItemId =
      stringValue(lastCheckpoint['evidenceItemId']) ?? checkpointRuntimeRow?.evidenceItemId ?? null;

    const nodeRows = await _deps.db
      .select()
      .from(missionNodes)
      .where(and(eq(missionNodes.missionId, mission.id), eq(missionNodes.workspaceId, workspaceId)))
      .orderBy(missionNodes.sortOrder);
    const edgeRows = await _deps.db
      .select()
      .from(missionEdges)
      .where(and(eq(missionEdges.missionId, mission.id), eq(missionEdges.workspaceId, workspaceId)))
      .orderBy(missionEdges.edgeKey);
    const taskLinks = await _deps.db
      .select()
      .from(missionTasks)
      .where(and(eq(missionTasks.missionId, mission.id), eq(missionTasks.workspaceId, workspaceId)))
      .orderBy(missionTasks.createdAt);

    const currentNodeStatuses = nodeStatusMap(nodeRows);
    const checkpointNodeStatuses = checkpointStatusMap(
      checkpointEvidence?.metadata ?? checkpointRuntimeRow?.metadata,
    );
    const plan = buildMissionRecoveryPlan({
      currentNodeStatuses,
      checkpointNodeStatuses,
      checkpointReplayRef,
      nodeRows,
    });
    const planSnapshot = {
      mission: {
        id: mission.id,
        status: mission.status,
        productionReady: mission.productionReady,
      },
      checkpoint: {
        checkpointId,
        replayRef: checkpointReplayRef,
        evidenceItemId: checkpointEvidenceItemId,
      },
      current: {
        nodes: nodeRows.map((node) => ({
          id: node.id,
          nodeKey: node.nodeKey,
          status: node.status,
          stage: node.stage,
          sortOrder: node.sortOrder,
        })),
        edges: edgeRows.map((edge) => ({
          id: edge.id,
          edgeKey: edge.edgeKey,
          fromNodeKey: edge.fromNodeKey,
          toNodeKey: edge.toNodeKey,
        })),
        taskLinks: taskLinks.map((link) => ({
          id: link.id,
          nodeId: link.nodeId,
          taskId: link.taskId,
          role: link.role,
        })),
      },
      reason: parsed.data.reason ?? null,
    };
    const contentHash = hashJson({ plan, planSnapshot });
    const recoveryPlanId = `mission-recovery-plan:${contentHash.slice('sha256:'.length, 23)}`;
    const replayRef = `mission:${mission.id}:recovery-plan:${recoveryPlanId.split(':')[1]}`;
    const plannedAt = new Date();

    const evidenceItemId = await _deps.db.transaction(async (tx) => {
      const db = tx as unknown as typeof _deps.db;
      const persistedEvidenceItemId = await appendEvidenceItem(db, {
        workspaceId,
        ventureId: mission.ventureId ?? null,
        missionId: mission.id,
        evidenceType: 'startup_lifecycle_recovery_plan',
        sourceType: 'gateway_startup_lifecycle',
        title: `Startup lifecycle recovery plan: ${mission.title}`,
        summary: parsed.data.reason ?? `Recovery plan for mission status ${mission.status}`,
        redactionState: 'redacted',
        sensitivity: 'internal',
        contentHash,
        replayRef,
        observedAt: plannedAt,
        metadata: {
          recoveryPlanVersion: 'mission-recovery-plan.v1',
          recoveryPlanId,
          checkpointId,
          checkpointReplayRef,
          missionStatus: mission.status,
          recoveryExecuted: false,
          plan,
          snapshot: planSnapshot,
          productionReady: false,
        },
      });

      await db
        .update(missions)
        .set({
          metadata: {
            ...missionMetadata,
            lastRecoveryPlan: {
              recoveryPlanId,
              evidenceItemId: persistedEvidenceItemId,
              replayRef,
              contentHash,
              plannedAt: plannedAt.toISOString(),
            },
          },
          updatedAt: plannedAt,
        })
        .where(and(eq(missions.id, mission.id), eq(missions.workspaceId, workspaceId)));

      return persistedEvidenceItemId;
    });

    const response = PlannedStartupMissionRecoverySchema.parse({
      workspaceId,
      missionId: mission.id,
      recoveryPlanId,
      recoveryPlanVersion: 'mission-recovery-plan.v1',
      productionReady: false,
      status: 'planned_not_executed',
      missionStatus: mission.status,
      recoveryExecuted: false,
      checkpointId,
      checkpointReplayRef,
      replayRef,
      evidenceItemIds: [evidenceItemId],
      plan,
      blockers: [
        'Recovery plan is persisted as evidence only; safe recovery apply and constrained rollback require explicit founder/operator calls.',
        'Full Startup Launch Eval has not promoted mission_runtime or startup_lifecycle to production_ready.',
      ],
    });

    return c.json(response, 200);
  });

  app.post('/missions/:missionId/recover', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'apply startup lifecycle recovery');
    if (roleDenied) return roleDenied;

    const raw = await c.req.json().catch(() => ({}));
    if (workspaceIdMismatch(c, (raw as { workspaceId?: string }).workspaceId)) {
      return c.json({ error: 'workspaceId does not match authenticated workspace' }, 403);
    }

    const parsed = ApplyStartupMissionRecoveryInputSchema.safeParse({
      ...(raw as Record<string, unknown>),
      workspaceId,
      missionId: c.req.param('missionId'),
    });
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const [mission] = await _deps.db
      .select()
      .from(missions)
      .where(and(eq(missions.id, parsed.data.missionId), eq(missions.workspaceId, workspaceId)))
      .limit(1);
    if (!mission) return c.json({ error: 'Mission not found' }, 404);

    const missionMetadata = jsonRecord(mission.metadata);
    const lastRecoveryPlan = jsonRecord(missionMetadata['lastRecoveryPlan']);
    const recoveryPlanReplayRef =
      parsed.data.recoveryPlanReplayRef ?? stringValue(lastRecoveryPlan['replayRef']);
    const [recoveryEvidence] = recoveryPlanReplayRef
      ? await _deps.db
          .select()
          .from(evidenceItems)
          .where(
            and(
              eq(evidenceItems.workspaceId, workspaceId),
              eq(evidenceItems.missionId, mission.id),
              eq(evidenceItems.replayRef, recoveryPlanReplayRef),
              eq(evidenceItems.evidenceType, 'startup_lifecycle_recovery_plan'),
            ),
          )
          .orderBy(desc(evidenceItems.observedAt), desc(evidenceItems.id))
          .limit(1)
      : await _deps.db
          .select()
          .from(evidenceItems)
          .where(
            and(
              eq(evidenceItems.workspaceId, workspaceId),
              eq(evidenceItems.missionId, mission.id),
              eq(evidenceItems.evidenceType, 'startup_lifecycle_recovery_plan'),
            ),
          )
          .orderBy(desc(evidenceItems.observedAt), desc(evidenceItems.id))
          .limit(1);
    if (!recoveryEvidence) {
      return c.json(
        {
          error: 'Recovery plan evidence not found',
          remediation: 'Create a recovery plan before applying recovery state changes.',
          productionReady: false,
        },
        409,
      );
    }

    const runtimeCheckpoint = await persistMissionRuntimeCheckpoint(_deps, workspaceId, mission, {
      checkpointKind: 'pre_recovery',
      reason: parsed.data.reason ?? 'safe mission recovery apply requested',
    });

    const nodeRows = await _deps.db
      .select()
      .from(missionNodes)
      .where(and(eq(missionNodes.missionId, mission.id), eq(missionNodes.workspaceId, workspaceId)))
      .orderBy(missionNodes.sortOrder, missionNodes.id);
    const taskLinks = await _deps.db
      .select()
      .from(missionTasks)
      .where(and(eq(missionTasks.missionId, mission.id), eq(missionTasks.workspaceId, workspaceId)))
      .orderBy(missionTasks.createdAt, missionTasks.id);

    const plan = jsonRecord(jsonRecord(recoveryEvidence.metadata)['plan']);
    const targetNodeKeys =
      parsed.data.retryNodeKeys && parsed.data.retryNodeKeys.length > 0
        ? uniqueStrings(parsed.data.retryNodeKeys)
        : uniqueStrings(stringArray(plan['failedNodeKeys']));
    const nodeByKey = new Map(nodeRows.map((node) => [node.nodeKey, node]));
    const taskIdByNodeId = new Map(
      taskLinks
        .filter((link) => Boolean(link.nodeId))
        .map((link) => [String(link.nodeId), link.taskId]),
    );
    const recoveredNodes: AppliedStartupMissionRecovery['recoveredNodes'] = [];
    const skippedNodes: AppliedStartupMissionRecovery['skippedNodes'] = [];
    const appliedAt = new Date();

    const recoverableNodes: Array<{ node: typeof missionNodes.$inferSelect; taskId?: string }> = [];
    for (const nodeKey of targetNodeKeys) {
      const node = nodeByKey.get(nodeKey);
      if (!node) {
        skippedNodes.push({
          nodeKey,
          reason: 'Node key was not found in this mission',
        });
        continue;
      }
      if (node.status !== 'failed') {
        skippedNodes.push({
          nodeId: node.id,
          nodeKey,
          status: node.status,
          reason: 'Only failed mission nodes can be reset to ready by safe recovery apply',
        });
        continue;
      }

      const taskId = taskIdByNodeId.get(node.id);
      recoverableNodes.push({ node, ...(taskId ? { taskId } : {}) });
      recoveredNodes.push({
        nodeId: node.id,
        nodeKey,
        previousStatus: node.status,
        nextStatus: 'ready' as const,
        ...(taskId ? { taskId } : {}),
      });
    }

    const missionStatus =
      recoveredNodes.length > 0 ? 'scheduled_not_executing' : String(mission.status);
    const recoveryApplyPayload = {
      missionId: mission.id,
      recoveryPlanReplayRef: recoveryEvidence.replayRef,
      runtimeCheckpointId: runtimeCheckpoint.checkpointId,
      recoveredNodes,
      skippedNodes,
      reason: parsed.data.reason ?? null,
    };
    const contentHash = hashJson(recoveryApplyPayload);
    const recoveryApplyId = `mission-recovery-apply:${contentHash.slice('sha256:'.length, 23)}`;
    const replayRef = `mission:${mission.id}:recovery-apply:${recoveryApplyId.split(':')[1]}`;
    const evidenceItemId = await _deps.db.transaction(async (tx) => {
      const db = tx as unknown as typeof _deps.db;
      const persistedEvidenceItemId = await appendEvidenceItem(db, {
        workspaceId,
        ventureId: mission.ventureId ?? null,
        missionId: mission.id,
        evidenceType: 'startup_lifecycle_recovery_applied',
        sourceType: 'gateway_startup_lifecycle',
        title: `Startup lifecycle recovery applied: ${mission.title}`,
        summary:
          recoveredNodes.length > 0
            ? `${recoveredNodes.length} failed node(s) reset to ready`
            : 'No mission nodes were eligible for recovery apply',
        redactionState: 'redacted',
        sensitivity: 'internal',
        contentHash,
        replayRef,
        observedAt: appliedAt,
        metadata: {
          recoveryApplyVersion: 'mission-recovery-apply.v1',
          recoveryApplyId,
          recoveryPlanReplayRef: recoveryEvidence.replayRef,
          recoveryPlanEvidenceItemId: recoveryEvidence.id,
          runtimeCheckpointId: runtimeCheckpoint.checkpointId,
          runtimeCheckpointEvidenceItemIds: runtimeCheckpoint.evidenceItemIds,
          recoveredNodeKeys: recoveredNodes.map((node) => node.nodeKey),
          skippedNodes,
          executionStarted: false,
          productionReady: false,
        },
      });

      for (const { node, taskId } of recoverableNodes) {
        await db
          .update(missionNodes)
          .set({
            status: 'ready',
            startedAt: null,
            completedAt: null,
            updatedAt: appliedAt,
          })
          .where(and(eq(missionNodes.id, node.id), eq(missionNodes.workspaceId, workspaceId)));
        if (taskId) {
          await db
            .update(tasks)
            .set({ status: 'pending', completedAt: null, updatedAt: appliedAt })
            .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)));
        }
      }

      await db
        .update(missions)
        .set({
          status: missionStatus,
          metadata: {
            ...missionMetadata,
            lastRecoveryApply: {
              recoveryApplyId,
              evidenceItemId: persistedEvidenceItemId,
              replayRef,
              contentHash,
              appliedAt: appliedAt.toISOString(),
              runtimeCheckpointId: runtimeCheckpoint.checkpointId,
              recoveredNodeKeys: recoveredNodes.map((node) => node.nodeKey),
            },
          },
          updatedAt: appliedAt,
        })
        .where(and(eq(missions.id, mission.id), eq(missions.workspaceId, workspaceId)));

      return persistedEvidenceItemId;
    });

    const response = AppliedStartupMissionRecoverySchema.parse({
      workspaceId,
      missionId: mission.id,
      recoveryApplyId,
      recoveryApplyVersion: 'mission-recovery-apply.v1',
      productionReady: false,
      status:
        recoveredNodes.length > 0 ? 'recovery_applied_not_executed' : 'recovery_noop_not_executed',
      missionStatus,
      recoveryPlanReplayRef: recoveryEvidence.replayRef,
      executionStarted: false,
      recoveredNodes,
      skippedNodes,
      evidenceItemIds: [...runtimeCheckpoint.evidenceItemIds, evidenceItemId],
      blockers: [
        'Recovery apply records a pre-recovery runtime checkpoint and only resets failed internal mission nodes to ready; it does not execute tasks, roll back completed nodes, or touch external systems.',
        'Blocked, awaiting-approval, ready, pending, completed, and skipped nodes are not reset by safe recovery apply.',
        'Full Startup Launch Eval has not promoted mission_runtime or startup_lifecycle to production_ready.',
      ],
    });

    return c.json(response, 200);
  });

  app.post('/missions/:missionId/rollback', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'rollback startup lifecycle mission');
    if (roleDenied) return roleDenied;

    const raw = await c.req.json().catch(() => ({}));
    if (workspaceIdMismatch(c, (raw as { workspaceId?: string }).workspaceId)) {
      return c.json({ error: 'workspaceId does not match authenticated workspace' }, 403);
    }

    const parsed = RollbackStartupMissionInputSchema.safeParse({
      ...(raw as Record<string, unknown>),
      workspaceId,
      missionId: c.req.param('missionId'),
    });
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const [mission] = await _deps.db
      .select()
      .from(missions)
      .where(and(eq(missions.id, parsed.data.missionId), eq(missions.workspaceId, workspaceId)))
      .limit(1);
    if (!mission) return c.json({ error: 'Mission not found' }, 404);

    const snapshot = await loadMissionRuntimeSnapshot(_deps, workspaceId, mission);
    const rollbackPlan = buildRollbackPlan(snapshot, parsed.data.reason);
    const checkpoint = await persistMissionRuntimeCheckpoint(_deps, workspaceId, mission, {
      checkpointKind: 'pre_rollback',
      reason: parsed.data.reason,
      snapshot,
      rollbackPlan,
    });
    const { rollback, rollbackEvidenceItemId } = await _deps.db.transaction(async (tx) => {
      const db = tx as unknown as typeof _deps.db;
      const rollbackDeps = { ..._deps, db };
      const appliedRollback = await applyConstrainedMissionRollback(
        rollbackDeps,
        workspaceId,
        mission,
        snapshot,
      );
      const evidenceItemId = await appendEvidenceItem(db, {
        workspaceId,
        ventureId: mission.ventureId ?? null,
        missionId: mission.id,
        evidenceType: 'startup_lifecycle_mission_rollback_applied',
        sourceType: 'gateway_startup_lifecycle',
        title: `Startup lifecycle mission rollback: ${mission.title}`,
        summary: `${appliedRollback.rolledBackNodes.length} node(s) reopened without deleting history`,
        redactionState: 'redacted',
        sensitivity: 'internal',
        contentHash: hashJson({
          missionId: mission.id,
          checkpointId: checkpoint.checkpointId,
          reason: parsed.data.reason,
          rolledBackNodeKeys: appliedRollback.rolledBackNodes.map((node) => node.nodeKey),
        }),
        replayRef: `mission:${mission.id}:rollback:${checkpoint.checkpointId}`,
        metadata: {
          rollbackVersion: 'mission-rollback.v1',
          checkpointId: checkpoint.checkpointId,
          scope: parsed.data.scope,
          rolledBackNodeKeys: appliedRollback.rolledBackNodes.map((node) => node.nodeKey),
          destructive: false,
          productionReady: false,
        },
      });
      return { rollback: appliedRollback, rollbackEvidenceItemId: evidenceItemId };
    });

    const response = RolledBackStartupMissionSchema.parse({
      workspaceId,
      missionId: mission.id,
      rollbackVersion: 'mission-rollback.v1',
      productionReady: false,
      rollbackApplied: true,
      checkpoint,
      rolledBackNodes: rollback.rolledBackNodes,
      missionStatus: rollback.missionStatus,
      evidenceItemIds: [...checkpoint.evidenceItemIds, rollbackEvidenceItemId],
      blockers: missionRollbackBlockers(),
    });

    return c.json(response, 200);
  });

  app.post('/missions/:missionId/schedule', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'schedule startup lifecycle mission');
    if (roleDenied) return roleDenied;

    const raw = await c.req.json().catch(() => ({}));
    if (workspaceIdMismatch(c, (raw as { workspaceId?: string }).workspaceId)) {
      return c.json({ error: 'workspaceId does not match authenticated workspace' }, 403);
    }

    const parsed = ScheduleStartupMissionInputSchema.safeParse({
      ...(raw as Record<string, unknown>),
      workspaceId,
      missionId: c.req.param('missionId'),
    });
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const [mission] = await _deps.db
      .select()
      .from(missions)
      .where(and(eq(missions.id, parsed.data.missionId), eq(missions.workspaceId, workspaceId)))
      .limit(1);
    if (!mission) return c.json({ error: 'Mission not found' }, 404);

    const nodeRows = await _deps.db
      .select()
      .from(missionNodes)
      .where(eq(missionNodes.missionId, mission.id));
    const edgeRows = await _deps.db
      .select()
      .from(missionEdges)
      .where(eq(missionEdges.missionId, mission.id));
    const taskLinks = await _deps.db
      .select()
      .from(missionTasks)
      .where(eq(missionTasks.missionId, mission.id));

    const taskIdByNodeId = new Map(
      taskLinks
        .filter((link) => Boolean(link.nodeId))
        .map((link) => [String(link.nodeId), link.taskId]),
    );
    const completedNodeKeys = new Set(
      nodeRows
        .filter((node) => node.status === 'completed' || node.status === 'skipped')
        .map((node) => node.nodeKey),
    );

    const ready: ScheduledStartupMissionNode[] = [];
    const blocked: ScheduledStartupMissionNode[] = [];
    for (const node of nodeRows.filter((item) => item.status === 'pending')) {
      const waitingOn = edgeRows
        .filter((edge) => edge.toNodeKey === node.nodeKey)
        .map((edge) => edge.fromNodeKey)
        .filter((dependency) => !completedNodeKeys.has(dependency));
      const scheduledNode = {
        nodeId: node.id,
        nodeKey: node.nodeKey,
        stage: StartupLifecycleStageSchema.parse(node.stage),
        title: node.title,
        taskId: taskIdByNodeId.get(node.id),
        waitingOn,
      };
      if (waitingOn.length === 0 && ready.length < parsed.data.maxNodes) {
        ready.push(scheduledNode);
      } else {
        blocked.push({
          ...scheduledNode,
          waitingOn: waitingOn.length > 0 ? waitingOn : ['scheduler_batch_limit'],
        });
      }
    }

    const evidenceItemId = await _deps.db.transaction(async (tx) => {
      const db = tx as unknown as typeof _deps.db;
      const scheduledAt = new Date();
      for (const node of ready) {
        await db
          .update(missionNodes)
          .set({ status: 'ready', updatedAt: scheduledAt })
          .where(and(eq(missionNodes.id, node.nodeId), eq(missionNodes.workspaceId, workspaceId)));
      }

      await db
        .update(missions)
        .set({ status: 'scheduled_not_executing', updatedAt: scheduledAt })
        .where(and(eq(missions.id, mission.id), eq(missions.workspaceId, workspaceId)));

      return appendEvidenceItem(db, {
        workspaceId,
        ventureId: mission.ventureId ?? null,
        missionId: mission.id,
        evidenceType: 'startup_lifecycle_nodes_scheduled',
        sourceType: 'gateway_startup_lifecycle',
        title: `Startup lifecycle nodes scheduled: ${mission.title}`,
        summary: `${ready.length} ready node(s), ${blocked.length} blocked node(s)`,
        redactionState: 'redacted',
        sensitivity: 'internal',
        contentHash: hashJson({ ready, blocked }),
        replayRef: `mission:${mission.id}:schedule`,
        observedAt: scheduledAt,
        metadata: {
          schedulerVersion: 'mission-scheduler.v1',
          readyNodeKeys: ready.map((node) => node.nodeKey),
          blockedNodeKeys: blocked.map((node) => node.nodeKey),
          queuedTaskIds: ready
            .map((node) => node.taskId)
            .filter((taskId): taskId is string => Boolean(taskId)),
          productionReady: false,
        },
      });
    });

    const response = ScheduledStartupMissionSchema.parse({
      workspaceId,
      missionId: mission.id,
      schedulerVersion: 'mission-scheduler.v1',
      productionReady: false,
      status: 'scheduled_not_executing',
      readyNodes: ready,
      blockedNodes: blocked,
      queuedTaskIds: ready
        .map((node) => node.taskId)
        .filter((taskId): taskId is string => Boolean(taskId)),
      evidenceItemIds: [evidenceItemId],
      executionStarted: false,
      blockers: [
        'Mission scheduler identifies ready nodes and task rows but does not dispatch autonomous execution yet',
        'Mission runtime remains blocked until node execution, checkpointing, recovery, and Full Startup Launch Eval pass',
      ],
    });

    return c.json(response, 200);
  });

  app.post('/missions/:missionId/nodes/:nodeId/execute', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'execute startup lifecycle mission node');
    if (roleDenied) return roleDenied;

    const raw = await c.req.json().catch(() => ({}));
    if (workspaceIdMismatch(c, (raw as { workspaceId?: string }).workspaceId)) {
      return c.json({ error: 'workspaceId does not match authenticated workspace' }, 403);
    }

    const parsed = ExecuteStartupMissionNodeInputSchema.safeParse({
      ...(raw as Record<string, unknown>),
      workspaceId,
      missionId: c.req.param('missionId'),
      nodeId: c.req.param('nodeId'),
    });
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const [mission] = await _deps.db
      .select()
      .from(missions)
      .where(and(eq(missions.id, parsed.data.missionId), eq(missions.workspaceId, workspaceId)))
      .limit(1);
    if (!mission) return c.json({ error: 'Mission not found' }, 404);

    const [node] = await _deps.db
      .select()
      .from(missionNodes)
      .where(
        and(
          eq(missionNodes.id, parsed.data.nodeId),
          eq(missionNodes.missionId, mission.id),
          eq(missionNodes.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!node) return c.json({ error: 'Mission node not found' }, 404);
    if (node.status !== 'ready') {
      return c.json(
        {
          error: 'mission node is not ready for execution',
          nodeStatus: node.status,
          requiredStatus: 'ready',
        },
        409,
      );
    }

    const result = await executeReadyMissionNode(_deps, workspaceId, mission, node, {
      context: parsed.data.context,
      iterationBudget: parsed.data.iterationBudget,
    });
    if (!result.ok) return c.json(result.body, result.status);
    return c.json(result.response, 200);
  });

  app.post('/missions/:missionId/execute-ready', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'execute ready startup lifecycle nodes');
    if (roleDenied) return roleDenied;

    const raw = await c.req.json().catch(() => ({}));
    if (workspaceIdMismatch(c, (raw as { workspaceId?: string }).workspaceId)) {
      return c.json({ error: 'workspaceId does not match authenticated workspace' }, 403);
    }

    const parsed = ExecuteStartupMissionInputSchema.safeParse({
      ...(raw as Record<string, unknown>),
      workspaceId,
      missionId: c.req.param('missionId'),
    });
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const [mission] = await _deps.db
      .select()
      .from(missions)
      .where(and(eq(missions.id, parsed.data.missionId), eq(missions.workspaceId, workspaceId)))
      .limit(1);
    if (!mission) return c.json({ error: 'Mission not found' }, 404);

    const executedNodes: ExecutedStartupMissionNode[] = [];
    let missionStatus: 'completed' | 'scheduled_not_executing' | 'blocked' | 'awaiting_approval' =
      'scheduled_not_executing';
    for (let index = 0; index < parsed.data.maxNodes; index += 1) {
      const [node] = await _deps.db
        .select()
        .from(missionNodes)
        .where(
          and(
            eq(missionNodes.missionId, mission.id),
            eq(missionNodes.workspaceId, workspaceId),
            eq(missionNodes.status, 'ready'),
          ),
        )
        .orderBy(missionNodes.sortOrder)
        .limit(1);
      if (!node) break;

      const result = await executeReadyMissionNode(_deps, workspaceId, mission, node, {
        context: parsed.data.context,
        iterationBudget: parsed.data.iterationBudget,
      });
      if (!result.ok) return c.json(result.body, result.status);
      executedNodes.push(result.response);
      missionStatus = result.response.missionStatus;
      if (result.response.status !== 'completed') break;
    }

    const remainingReadyNodes = await _deps.db
      .select({ id: missionNodes.id })
      .from(missionNodes)
      .where(
        and(
          eq(missionNodes.missionId, mission.id),
          eq(missionNodes.workspaceId, workspaceId),
          eq(missionNodes.status, 'ready'),
        ),
      )
      .orderBy(missionNodes.sortOrder);

    const response = ExecutedStartupMissionSchema.parse({
      workspaceId,
      missionId: mission.id,
      executorVersion: 'mission-executor.v1',
      productionReady: false,
      executionStarted: executedNodes.length > 0,
      missionStatus:
        executedNodes.length > 0
          ? missionStatus
          : remainingReadyNodes.length > 0
            ? 'scheduled_not_executing'
            : mission.status === 'completed'
              ? 'completed'
              : 'blocked',
      executedNodes,
      remainingReadyNodeIds: remainingReadyNodes.map((node) => node.id),
      evidenceItemIds: executedNodes.flatMap((node) => node.evidenceItemIds),
      blockers: missionExecutorBlockers(executedNodes.length, remainingReadyNodes.length),
    });

    return c.json(response, 200);
  });

  return app;
}

async function executeReadyMissionNode(
  deps: GatewayDeps,
  workspaceId: string,
  mission: typeof missions.$inferSelect,
  node: typeof missionNodes.$inferSelect,
  input: {
    context?: string;
    iterationBudget?: number;
  },
): Promise<
  | { ok: true; response: typeof ExecutedStartupMissionNodeSchema._type }
  | {
      ok: false;
      status: 403 | 404 | 409 | 502;
      body: Record<string, unknown>;
    }
> {
  const [taskLink] = await deps.db
    .select()
    .from(missionTasks)
    .where(
      and(
        eq(missionTasks.missionId, mission.id),
        eq(missionTasks.nodeId, node.id),
        eq(missionTasks.workspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!taskLink) {
    return {
      ok: false,
      status: 409,
      body: {
        error: 'mission node has no execution task',
        remediation: 'Persist the lifecycle mission with createNodeTasks=true before execution.',
      },
    };
  }

  const [task] = await deps.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, taskLink.taskId), eq(tasks.workspaceId, workspaceId)))
    .limit(1);
  if (!task) {
    return { ok: false, status: 404, body: { error: 'Mission node task not found' } };
  }
  if (!(await workspaceOperatorBelongsToWorkspace(deps.db, workspaceId, task.operatorId))) {
    return {
      ok: false,
      status: 403,
      body: {
        error: 'operatorId does not belong to authenticated workspace',
        remediation: 'Reassign the mission task to an operator owned by this workspace.',
      },
    };
  }

  await deps.db
    .update(missionNodes)
    .set({ status: 'running', startedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(missionNodes.id, node.id), eq(missionNodes.workspaceId, workspaceId)));
  await deps.db
    .update(missions)
    .set({ status: 'running', startedAt: mission.startedAt ?? new Date(), updatedAt: new Date() })
    .where(and(eq(missions.id, mission.id), eq(missions.workspaceId, workspaceId)));
  await deps.db
    .update(tasks)
    .set({ status: 'running', completedAt: null, updatedAt: new Date() })
    .where(and(eq(tasks.id, task.id), eq(tasks.workspaceId, workspaceId)));

  const runTaskWithMissionContext = deps.orchestrator.runTask as MissionContextRunTask;
  let run;
  try {
    run = await runTaskWithMissionContext({
      taskId: task.id,
      workspaceId,
      ...(mission.ventureId ? { ventureId: mission.ventureId } : {}),
      missionId: mission.id,
      ...(task.operatorId ? { operatorId: task.operatorId } : {}),
      context: input.context ?? missionNodeExecutionContext(mission, node, task.description),
      iterationBudget: input.iterationBudget,
    });
  } catch (err) {
    const failedAt = new Date();
    const evidenceItemId = await deps.db.transaction(async (tx) => {
      const db = tx as unknown as typeof deps.db;
      await db
        .update(missionNodes)
        .set({ status: 'failed', updatedAt: failedAt, completedAt: failedAt })
        .where(and(eq(missionNodes.id, node.id), eq(missionNodes.workspaceId, workspaceId)));
      await db
        .update(missions)
        .set({ status: 'blocked', updatedAt: failedAt })
        .where(and(eq(missions.id, mission.id), eq(missions.workspaceId, workspaceId)));
      await db
        .update(tasks)
        .set({ status: 'failed', updatedAt: failedAt, completedAt: failedAt })
        .where(and(eq(tasks.id, task.id), eq(tasks.workspaceId, workspaceId)));
      return appendEvidenceItem(db, {
        workspaceId,
        ventureId: mission.ventureId ?? null,
        missionId: mission.id,
        taskId: task.id,
        evidenceType: 'startup_lifecycle_node_failed',
        sourceType: 'gateway_startup_lifecycle',
        title: `Startup lifecycle node failed: ${node.title}`,
        summary: err instanceof Error ? err.message : String(err),
        redactionState: 'redacted',
        sensitivity: 'internal',
        contentHash: hashJson({
          nodeId: node.id,
          nodeKey: node.nodeKey,
          taskId: task.id,
          error: err instanceof Error ? err.message : String(err),
        }),
        replayRef: `mission:${mission.id}:node:${node.id}:failure`,
        metadata: {
          executorVersion: 'mission-node-executor.v1',
          nodeKey: node.nodeKey,
          stage: node.stage,
          nodeStatus: 'failed',
          missionStatus: 'blocked',
          productionReady: false,
        },
      });
    });
    return {
      ok: false,
      status: 502,
      body: {
        error: 'mission node execution failed',
        detail: err instanceof Error ? err.message : String(err),
        productionReady: false,
        evidenceItemIds: [evidenceItemId],
      },
    };
  }

  const nodeStatus = mapRunStatusToMissionNodeStatus(run.status);
  const completedAt = new Date();
  const { advancement, evidenceItemId } = await deps.db.transaction(async (tx) => {
    const db = tx as unknown as typeof deps.db;
    const txDeps = { ...deps, db };
    await db
      .update(missionNodes)
      .set({
        status: nodeStatus,
        updatedAt: completedAt,
        completedAt: nodeStatus === 'completed' ? completedAt : null,
      })
      .where(and(eq(missionNodes.id, node.id), eq(missionNodes.workspaceId, workspaceId)));
    await db
      .update(tasks)
      .set({
        status: mapRunStatusToTaskStatus(run.status),
        updatedAt: completedAt,
        completedAt: run.status === 'completed' ? completedAt : null,
      })
      .where(and(eq(tasks.id, task.id), eq(tasks.workspaceId, workspaceId)));

    const nextAdvancement =
      nodeStatus === 'completed'
        ? await advanceReadyMissionNodes(txDeps, workspaceId, mission.id)
        : {
            advancedReadyNodes: [],
            missionStatus: mapRunStatusToMissionStatus(run.status),
          };
    await db
      .update(missions)
      .set({
        status: nextAdvancement.missionStatus,
        updatedAt: completedAt,
        completedAt: nextAdvancement.missionStatus === 'completed' ? completedAt : null,
      })
      .where(and(eq(missions.id, mission.id), eq(missions.workspaceId, workspaceId)));

    const persistedEvidenceItemId = await appendEvidenceItem(db, {
      workspaceId,
      ventureId: mission.ventureId ?? null,
      missionId: mission.id,
      taskId: task.id,
      evidenceType: 'startup_lifecycle_node_executed',
      sourceType: 'gateway_startup_lifecycle',
      title: `Startup lifecycle node executed: ${node.title}`,
      summary: `${node.nodeKey} finished with ${nodeStatus}`,
      redactionState: 'redacted',
      sensitivity: 'internal',
      contentHash: hashJson({
        nodeId: node.id,
        nodeKey: node.nodeKey,
        taskId: task.id,
        runStatus: run.status,
        iterationsUsed: run.iterationsUsed,
        actionCount: run.actions.length,
        advancedReadyNodes: nextAdvancement.advancedReadyNodes.map((advanced) => advanced.nodeKey),
      }),
      replayRef: `mission:${mission.id}:node:${node.id}:execute`,
      metadata: {
        executorVersion: 'mission-node-executor.v1',
        nodeKey: node.nodeKey,
        stage: node.stage,
        runStatus: run.status,
        nodeStatus,
        missionStatus: nextAdvancement.missionStatus,
        iterationsUsed: run.iterationsUsed,
        iterationBudget: run.iterationBudget,
        actionCount: run.actions.length,
        advancedReadyNodeKeys: nextAdvancement.advancedReadyNodes.map(
          (advanced) => advanced.nodeKey,
        ),
        productionReady: false,
      },
    });
    return { advancement: nextAdvancement, evidenceItemId: persistedEvidenceItemId };
  });

  const response = ExecutedStartupMissionNodeSchema.parse({
    workspaceId,
    missionId: mission.id,
    nodeId: node.id,
    nodeKey: node.nodeKey,
    taskId: task.id,
    executorVersion: 'mission-node-executor.v1',
    productionReady: false,
    executionStarted: true,
    status: nodeStatus,
    missionStatus: advancement.missionStatus,
    run: {
      status: run.status,
      iterationsUsed: run.iterationsUsed,
      iterationBudget: run.iterationBudget,
      actionCount: run.actions.length,
    },
    advancedReadyNodes: advancement.advancedReadyNodes,
    evidenceItemIds: [evidenceItemId],
    blockers: missionNodeExecutionBlockers(run.status),
  });

  return { ok: true, response };
}

function deriveVentureName(founderGoal: string): string {
  const compact = founderGoal.replace(/\s+/g, ' ').trim();
  if (compact.length <= 80) return compact;
  return `${compact.slice(0, 77).trim()}...`;
}

function taskPriorityForStage(stage: string): number {
  if (stage === 'founder_onboarding') return 100;
  if (stage === 'ideation' || stage === 'market_research' || stage === 'pmf_discovery') return 90;
  if (stage === 'engineering' || stage === 'infrastructure_deployment') return 80;
  if (stage.includes('prep')) return 70;
  return 50;
}

function persistedMissionBlockers(blockers: readonly string[]): string[] {
  const stalePersistenceBlockers = new Set([
    'Mission DAG is not persisted as the runtime backbone yet',
    'Lifecycle nodes are not bound to durable venture/mission/action records yet',
  ]);

  return [
    ...blockers.filter((blocker) => !stalePersistenceBlockers.has(blocker)),
    'Mission DAG is persisted but not executing through the runtime yet',
    'Lifecycle nodes are not yet dispatched as governed action/tool/evidence workflows',
  ];
}

function countNodeStatuses(nodes: Array<typeof missionNodes.$inferSelect>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of nodes) {
    counts[node.status] = (counts[node.status] ?? 0) + 1;
  }
  return counts;
}

interface MissionRuntimeSnapshot {
  mission: typeof missions.$inferSelect;
  nodes: Array<typeof missionNodes.$inferSelect>;
  edges: Array<typeof missionEdges.$inferSelect>;
  taskLinks: Array<typeof missionTasks.$inferSelect>;
  taskRunCheckpointRefs: Array<Record<string, unknown>>;
  nodeStatusCounts: Record<string, number>;
  cursorNode?: typeof missionNodes.$inferSelect;
}

async function loadMissionRuntimeSnapshot(
  deps: GatewayDeps,
  workspaceId: string,
  mission: typeof missions.$inferSelect,
): Promise<MissionRuntimeSnapshot> {
  const nodes = await deps.db
    .select()
    .from(missionNodes)
    .where(and(eq(missionNodes.missionId, mission.id), eq(missionNodes.workspaceId, workspaceId)))
    .orderBy(missionNodes.sortOrder);
  const edges = await deps.db
    .select()
    .from(missionEdges)
    .where(and(eq(missionEdges.missionId, mission.id), eq(missionEdges.workspaceId, workspaceId)))
    .orderBy(missionEdges.edgeKey);
  const taskLinks = await deps.db
    .select()
    .from(missionTasks)
    .where(and(eq(missionTasks.missionId, mission.id), eq(missionTasks.workspaceId, workspaceId)))
    .orderBy(missionTasks.createdAt);
  const taskIds = taskLinks
    .map((link) => link.taskId)
    .filter((taskId): taskId is string => Boolean(taskId));
  const runRows =
    taskIds.length > 0
      ? await deps.db
          .select({
            id: taskRuns.id,
            taskId: taskRuns.taskId,
            status: taskRuns.status,
            checkpointId: taskRuns.checkpointId,
            lastCheckpointAt: taskRuns.lastCheckpointAt,
          })
          .from(taskRuns)
          .where(inArray(taskRuns.taskId, taskIds))
          .orderBy(taskRuns.runSequence, taskRuns.startedAt, taskRuns.id)
      : [];
  const taskRunCheckpointRefs = runRows
    .filter((row) => row.checkpointId || row.lastCheckpointAt)
    .map((row) => ({
      taskRunId: row.id,
      taskId: row.taskId,
      status: row.status,
      checkpointId: row.checkpointId,
      lastCheckpointAt:
        row.lastCheckpointAt instanceof Date
          ? row.lastCheckpointAt.toISOString()
          : row.lastCheckpointAt,
    }));
  const cursorNode = nodes.find((node) =>
    ['running', 'ready', 'awaiting_approval', 'blocked', 'failed'].includes(node.status),
  );
  return {
    mission,
    nodes,
    edges,
    taskLinks,
    taskRunCheckpointRefs,
    nodeStatusCounts: countNodeStatuses(nodes),
    ...(cursorNode ? { cursorNode } : {}),
  };
}

async function persistMissionRuntimeCheckpoint(
  deps: GatewayDeps,
  workspaceId: string,
  mission: typeof missions.$inferSelect,
  input: {
    checkpointKind: MissionRuntimeCheckpointKind;
    reason: string;
    snapshot?: MissionRuntimeSnapshot;
    rollbackPlan?: Record<string, unknown>;
  },
) {
  const snapshot = input.snapshot ?? (await loadMissionRuntimeSnapshot(deps, workspaceId, mission));
  const readyNodeIds = snapshot.nodes
    .filter((node) => node.status === 'ready')
    .map((node) => node.id);
  const blockedNodeIds = snapshot.nodes
    .filter((node) => node.status === 'blocked')
    .map((node) => node.id);
  const failedNodeIds = snapshot.nodes
    .filter((node) => node.status === 'failed')
    .map((node) => node.id);
  const awaitingApprovalNodeIds = snapshot.nodes
    .filter((node) => node.status === 'awaiting_approval')
    .map((node) => node.id);
  const recoveryPlan = buildRuntimeRecoveryPlan(snapshot);
  const rollbackPlan = input.rollbackPlan ?? {};
  const contentHash = hashJson({
    checkpointKind: input.checkpointKind,
    missionId: mission.id,
    missionStatus: mission.status,
    nodeStatusCounts: snapshot.nodeStatusCounts,
    readyNodeIds,
    blockedNodeIds,
    failedNodeIds,
    awaitingApprovalNodeIds,
    taskRunCheckpointRefs: snapshot.taskRunCheckpointRefs,
    recoveryPlan,
    rollbackPlan,
  });
  const now = new Date();
  const checkpointId = randomUUID();
  const replayRef = missionRuntimeCheckpointReplayRef(
    mission.id,
    input.checkpointKind,
    checkpointId,
  );
  const { checkpoint, evidenceItemId } = await deps.db.transaction(async (tx) => {
    const db = tx as unknown as typeof deps.db;
    const auditEventId = randomUUID();
    const evidenceMetadata = {
      checkpointKind: input.checkpointKind,
      checkpointId,
      missionStatus: mission.status,
      cursorNodeKey: snapshot.cursorNode?.nodeKey ?? null,
      reason: input.reason,
      productionReady: false,
    };
    const auditMetadata = {
      checkpointVersion: 'mission-runtime-checkpoint.v1',
      evidenceType: 'startup_lifecycle_mission_checkpoint',
      replayRef,
      contentHash,
      ...evidenceMetadata,
    };
    await db.insert(auditLog).values({
      id: auditEventId,
      workspaceId,
      action: 'STARTUP_LIFECYCLE_MISSION_CHECKPOINT',
      actor: `workspace:${workspaceId}`,
      target: mission.id,
      verdict: 'recorded',
      reason: `${input.checkpointKind} checkpoint for mission ${mission.id}`,
      metadata: auditMetadata,
      createdAt: now,
    });
    const persistedEvidenceItemId = await appendEvidenceItem(db, {
      workspaceId,
      auditEventId,
      ventureId: mission.ventureId ?? null,
      missionId: mission.id,
      evidenceType: 'startup_lifecycle_mission_checkpoint',
      sourceType: 'gateway_startup_lifecycle',
      title: `Mission runtime checkpoint: ${mission.title}`,
      summary: `${input.checkpointKind} checkpoint for mission ${mission.id}`,
      redactionState: 'redacted',
      sensitivity: 'internal',
      contentHash,
      replayRef,
      metadata: evidenceMetadata,
    });
    await db
      .update(auditLog)
      .set({
        metadata: {
          ...auditMetadata,
          evidenceItemId: persistedEvidenceItemId,
        },
      })
      .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));
    const [persistedCheckpoint] = await db
      .insert(missionRuntimeCheckpoints)
      .values({
        id: checkpointId,
        workspaceId,
        missionId: mission.id,
        checkpointKind: input.checkpointKind,
        checkpointStatus: 'recorded',
        missionStatus: mission.status,
        cursorNodeId: snapshot.cursorNode?.id ?? null,
        cursorNodeKey: snapshot.cursorNode?.nodeKey ?? null,
        nodeStatusCounts: snapshot.nodeStatusCounts,
        readyNodeIds,
        blockedNodeIds,
        failedNodeIds,
        awaitingApprovalNodeIds,
        taskRunCheckpointRefs: snapshot.taskRunCheckpointRefs,
        recoveryPlan,
        rollbackPlan,
        evidenceItemId: persistedEvidenceItemId,
        contentHash,
        metadata: {
          checkpointVersion: 'mission-runtime-checkpoint.v1',
          reason: input.reason,
          replayRef,
          productionReady: false,
        },
        createdAt: now,
      })
      .returning({ id: missionRuntimeCheckpoints.id });

    return { checkpoint: persistedCheckpoint, evidenceItemId: persistedEvidenceItemId };
  });
  if (!checkpoint?.id) {
    throw new Error('Mission runtime checkpoint was not persisted');
  }
  if (checkpoint.id !== checkpointId) {
    throw new Error('Mission runtime checkpoint id mismatch');
  }

  return MissionRuntimeCheckpointSchema.parse({
    checkpointId: checkpoint.id,
    checkpointKind: input.checkpointKind,
    replayRef,
    missionId: mission.id,
    missionStatus: mission.status,
    ...(snapshot.cursorNode?.id ? { cursorNodeId: snapshot.cursorNode.id } : {}),
    ...(snapshot.cursorNode?.nodeKey ? { cursorNodeKey: snapshot.cursorNode.nodeKey } : {}),
    nodeStatusCounts: snapshot.nodeStatusCounts,
    readyNodeIds,
    blockedNodeIds,
    failedNodeIds,
    awaitingApprovalNodeIds,
    taskRunCheckpointRefs: snapshot.taskRunCheckpointRefs,
    recoveryPlan,
    rollbackPlan,
    evidenceItemIds: [evidenceItemId],
    productionReady: false,
    createdAt: now.toISOString(),
  });
}

function missionRuntimeCheckpointReplayRef(
  missionId: string,
  checkpointKind: MissionRuntimeCheckpointKind,
  checkpointId: string,
) {
  return `mission:${missionId}:checkpoint:${checkpointKind}:${checkpointId}`;
}

function buildRuntimeRecoveryPlan(snapshot: MissionRuntimeSnapshot): Record<string, unknown> {
  const completedNodeKeys = new Set(
    snapshot.nodes
      .filter((node) => node.status === 'completed' || node.status === 'skipped')
      .map((node) => node.nodeKey),
  );
  const recoverableReadyNodeKeys = snapshot.nodes
    .filter(
      (node) =>
        node.status === 'pending' && dependenciesSatisfied(node, snapshot.edges, completedNodeKeys),
    )
    .map((node) => node.nodeKey);
  return {
    recoveryVersion: 'mission-recovery.v1',
    recoverableReadyNodeKeys,
    taskRunCheckpointRefs: snapshot.taskRunCheckpointRefs,
    blockedTerminalNodeKeys: snapshot.nodes
      .filter((node) => ['failed', 'blocked', 'awaiting_approval'].includes(node.status))
      .map((node) => node.nodeKey),
  };
}

function dependenciesSatisfied(
  node: typeof missionNodes.$inferSelect,
  edges: Array<typeof missionEdges.$inferSelect>,
  completedNodeKeys: Set<string>,
) {
  return edges
    .filter((edge) => edge.toNodeKey === node.nodeKey)
    .every((edge) => completedNodeKeys.has(edge.fromNodeKey));
}

function buildRollbackPlan(
  snapshot: MissionRuntimeSnapshot,
  reason: string,
): Record<string, unknown> {
  return {
    rollbackVersion: 'mission-rollback.v1',
    scope: 'failed_blocked_to_ready',
    reason,
    destructive: false,
    targetNodeKeys: snapshot.nodes
      .filter((node) => ['failed', 'blocked', 'awaiting_approval'].includes(node.status))
      .map((node) => node.nodeKey),
  };
}

async function applyConstrainedMissionRollback(
  deps: GatewayDeps,
  workspaceId: string,
  mission: typeof missions.$inferSelect,
  snapshot: MissionRuntimeSnapshot,
): Promise<{
  rolledBackNodes: ScheduledStartupMissionNode[];
  missionStatus: 'scheduled_not_executing' | 'blocked';
}> {
  const completedNodeKeys = new Set(
    snapshot.nodes
      .filter((node) => node.status === 'completed' || node.status === 'skipped')
      .map((node) => node.nodeKey),
  );
  const taskIdByNodeId = new Map(
    snapshot.taskLinks
      .filter((link) => Boolean(link.nodeId))
      .map((link) => [String(link.nodeId), link.taskId]),
  );
  const rolledBackNodes: ScheduledStartupMissionNode[] = [];
  for (const node of snapshot.nodes.filter((item) =>
    ['failed', 'blocked', 'awaiting_approval'].includes(item.status),
  )) {
    const waitingOn = snapshot.edges
      .filter((edge) => edge.toNodeKey === node.nodeKey)
      .map((edge) => edge.fromNodeKey)
      .filter((dependency) => !completedNodeKeys.has(dependency));
    const nextStatus = waitingOn.length === 0 ? 'ready' : 'pending';
    await deps.db
      .update(missionNodes)
      .set({ status: nextStatus, startedAt: null, completedAt: null, updatedAt: new Date() })
      .where(and(eq(missionNodes.id, node.id), eq(missionNodes.workspaceId, workspaceId)));

    const taskId = taskIdByNodeId.get(node.id);
    if (taskId) {
      await deps.db
        .update(tasks)
        .set({ status: 'pending', completedAt: null, updatedAt: new Date() })
        .where(and(eq(tasks.id, taskId), eq(tasks.workspaceId, workspaceId)));
    }
    rolledBackNodes.push({
      nodeId: node.id,
      nodeKey: node.nodeKey,
      stage: StartupLifecycleStageSchema.parse(node.stage),
      title: node.title,
      ...(taskId ? { taskId } : {}),
      waitingOn,
    });
  }

  const missionStatus = rolledBackNodes.some((node) => node.waitingOn.length === 0)
    ? 'scheduled_not_executing'
    : 'blocked';
  await deps.db
    .update(missions)
    .set({ status: missionStatus, completedAt: null, updatedAt: new Date() })
    .where(and(eq(missions.id, mission.id), eq(missions.workspaceId, workspaceId)));

  return { rolledBackNodes, missionStatus };
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function nodeStatusMap(nodes: Array<typeof missionNodes.$inferSelect>): Record<string, string> {
  return Object.fromEntries(nodes.map((node) => [node.nodeKey, node.status]));
}

function checkpointStatusMap(metadata: unknown): Record<string, string> {
  const snapshot = jsonRecord(jsonRecord(metadata)['snapshot']);
  const nodes = Array.isArray(snapshot['nodes']) ? snapshot['nodes'] : [];
  const statuses: Record<string, string> = {};
  for (const rawNode of nodes) {
    const node = jsonRecord(rawNode);
    const nodeKey = stringValue(node['nodeKey']);
    const status = stringValue(node['status']);
    if (nodeKey && status) statuses[nodeKey] = status;
  }
  return statuses;
}

function buildMissionRecoveryPlan(input: {
  currentNodeStatuses: Record<string, string>;
  checkpointNodeStatuses: Record<string, string>;
  checkpointReplayRef: string | null;
  nodeRows: Array<typeof missionNodes.$inferSelect>;
}): {
  changedNodeKeys: string[];
  blockedNodeKeys: string[];
  failedNodeKeys: string[];
  awaitingApprovalNodeKeys: string[];
  readyNodeKeys: string[];
  currentNodeStatuses: Record<string, string>;
  checkpointNodeStatuses: Record<string, string>;
  recommendedNextActions: string[];
} {
  const changedNodeKeys = Object.entries(input.currentNodeStatuses)
    .filter(([nodeKey, status]) => {
      const checkpointStatus = input.checkpointNodeStatuses[nodeKey];
      return Boolean(checkpointStatus && checkpointStatus !== status);
    })
    .map(([nodeKey]) => nodeKey);
  const nodeKeysByStatus = (status: string) =>
    input.nodeRows.filter((node) => node.status === status).map((node) => node.nodeKey);
  const blockedNodeKeys = nodeKeysByStatus('blocked');
  const failedNodeKeys = nodeKeysByStatus('failed');
  const awaitingApprovalNodeKeys = nodeKeysByStatus('awaiting_approval');
  const readyNodeKeys = nodeKeysByStatus('ready');
  const recommendedNextActions = [
    ...(!input.checkpointReplayRef
      ? ['Create a mission checkpoint before executing any recovery action.']
      : []),
    ...(changedNodeKeys.length > 0
      ? ['Review node status drift against the checkpoint before retrying or resuming work.']
      : []),
    ...(failedNodeKeys.length > 0
      ? ['Inspect failed node evidence and decide whether to retry the linked task manually.']
      : []),
    ...(blockedNodeKeys.length > 0
      ? ['Resolve blocked node evidence and escalation conditions before further execution.']
      : []),
    ...(awaitingApprovalNodeKeys.length > 0
      ? ['Resolve pending approvals before executing dependent mission nodes.']
      : []),
    ...(readyNodeKeys.length > 0
      ? ['Use explicit bounded ready-node execution only after founder review.']
      : []),
    'Do not roll back, retry, or continue automatically from this plan.',
  ];

  return {
    changedNodeKeys,
    blockedNodeKeys,
    failedNodeKeys,
    awaitingApprovalNodeKeys,
    readyNodeKeys,
    currentNodeStatuses: input.currentNodeStatuses,
    checkpointNodeStatuses: input.checkpointNodeStatuses,
    recommendedNextActions,
  };
}

function missionNodeExecutionContext(
  mission: typeof missions.$inferSelect,
  node: typeof missionNodes.$inferSelect,
  taskDescription: string,
): string {
  return [
    `Mission: ${mission.title}`,
    `Lifecycle node: ${node.title}`,
    `Objective: ${node.objective}`,
    `Task: ${taskDescription}`,
    `Required evidence: ${node.requiredEvidence.join(', ')}`,
    `Acceptance criteria: ${node.acceptanceCriteria.join(', ')}`,
    `HELM policy classes: ${node.helmPolicyClasses.join(', ')}`,
    'Do not perform irreversible external actions unless HELM policy and the current workspace mode explicitly allow them.',
  ].join('\n');
}

function mapRunStatusToMissionNodeStatus(
  status: 'completed' | 'budget_exhausted' | 'blocked' | 'awaiting_approval' | 'stalled',
) {
  if (status === 'completed') return 'completed';
  if (status === 'awaiting_approval') return 'awaiting_approval';
  if (status === 'blocked') return 'blocked';
  return 'failed';
}

function mapRunStatusToTaskStatus(
  status: 'completed' | 'budget_exhausted' | 'blocked' | 'awaiting_approval' | 'stalled',
) {
  if (status === 'completed') return 'completed';
  if (status === 'awaiting_approval') return 'awaiting_approval';
  return 'failed';
}

function mapRunStatusToMissionStatus(
  status: 'completed' | 'budget_exhausted' | 'blocked' | 'awaiting_approval' | 'stalled',
) {
  if (status === 'awaiting_approval') return 'awaiting_approval';
  return 'blocked';
}

async function advanceReadyMissionNodes(
  deps: GatewayDeps,
  workspaceId: string,
  missionId: string,
): Promise<{
  advancedReadyNodes: Array<{
    nodeId: string;
    nodeKey: string;
    stage: string;
    title: string;
    taskId?: string;
    waitingOn: string[];
  }>;
  missionStatus: 'completed' | 'scheduled_not_executing' | 'blocked' | 'awaiting_approval';
}> {
  const nodeRows = await deps.db
    .select()
    .from(missionNodes)
    .where(and(eq(missionNodes.missionId, missionId), eq(missionNodes.workspaceId, workspaceId)));
  const edgeRows = await deps.db
    .select()
    .from(missionEdges)
    .where(and(eq(missionEdges.missionId, missionId), eq(missionEdges.workspaceId, workspaceId)));
  const taskLinks = await deps.db
    .select()
    .from(missionTasks)
    .where(and(eq(missionTasks.missionId, missionId), eq(missionTasks.workspaceId, workspaceId)));

  const taskIdByNodeId = new Map(
    taskLinks
      .filter((link) => Boolean(link.nodeId))
      .map((link) => [String(link.nodeId), link.taskId]),
  );
  const completedNodeKeys = new Set(
    nodeRows
      .filter((node) => node.status === 'completed' || node.status === 'skipped')
      .map((node) => node.nodeKey),
  );
  const advancedReadyNodes = [];
  for (const node of nodeRows.filter((item) => item.status === 'pending')) {
    const waitingOn = edgeRows
      .filter((edge) => edge.toNodeKey === node.nodeKey)
      .map((edge) => edge.fromNodeKey)
      .filter((dependency) => !completedNodeKeys.has(dependency));
    if (waitingOn.length > 0) continue;
    const taskId = taskIdByNodeId.get(node.id);
    const advanced = {
      nodeId: node.id,
      nodeKey: node.nodeKey,
      stage: node.stage,
      title: node.title,
      waitingOn,
      ...(taskId ? { taskId } : {}),
    };
    await deps.db
      .update(missionNodes)
      .set({ status: 'ready', updatedAt: new Date() })
      .where(and(eq(missionNodes.id, node.id), eq(missionNodes.workspaceId, workspaceId)));
    advancedReadyNodes.push(advanced);
  }

  if (
    nodeRows.length > 0 &&
    nodeRows.every((node) => node.status === 'completed' || node.status === 'skipped')
  ) {
    return { advancedReadyNodes, missionStatus: 'completed' };
  }
  if (advancedReadyNodes.length > 0) {
    return { advancedReadyNodes, missionStatus: 'scheduled_not_executing' };
  }
  if (nodeRows.some((node) => node.status === 'ready')) {
    return { advancedReadyNodes, missionStatus: 'scheduled_not_executing' };
  }
  if (nodeRows.some((node) => node.status === 'awaiting_approval')) {
    return { advancedReadyNodes, missionStatus: 'awaiting_approval' };
  }
  return { advancedReadyNodes, missionStatus: 'blocked' };
}

function missionNodeExecutionBlockers(
  status: 'completed' | 'budget_exhausted' | 'blocked' | 'awaiting_approval' | 'stalled',
): string[] {
  const blockers = [
    'Mission node execution uses the governed task runtime but has not passed Full Startup Launch Eval',
    'Mission checkpoint, recovery, and rollback controls are prototype-only; automatic next-node dispatch remains blocked',
  ];
  if (status === 'blocked')
    blockers.push('Agent run blocked before completing node acceptance criteria');
  if (status === 'budget_exhausted') blockers.push('Agent run exhausted iteration budget');
  if (status === 'awaiting_approval') blockers.push('Agent run is awaiting HELM/user approval');
  if (status === 'stalled')
    blockers.push('Agent run stalled before completing node acceptance criteria');
  return blockers;
}

function missionExecutorBlockers(executedCount: number, remainingReadyCount: number): string[] {
  const blockers = [
    'Mission executor is explicit and bounded; it is not founder-off-grid autonomous execution',
    'Mission recovery/rollback controls and Full Startup Launch Eval have not promoted mission runtime',
  ];
  if (executedCount === 0) blockers.push('No ready mission node was executed');
  if (remainingReadyCount > 0) {
    blockers.push('Additional ready nodes remain and require another explicit execution call');
  }
  return blockers;
}

function missionRollbackBlockers(): string[] {
  return [
    'Mission rollback is constrained to reopening failed, blocked, or awaiting-approval lifecycle nodes; it does not reverse external-world actions',
    'Rollback is prototype-only until Recovery Eval verifies replay, evidence, and incident handling',
    'Production rollback of deployments, financial actions, legal actions, or external communications remains governed by separate HELM policies',
  ];
}

function hashJson(value: unknown) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortJson);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
