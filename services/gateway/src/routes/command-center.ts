import { Hono } from 'hono';
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm';
import {
  actions,
  agentHandoffs,
  approvals,
  artifacts,
  auditLog,
  browserObservations,
  capabilityPromotions,
  computerActions,
  evidenceItems,
  evidencePacks,
  evalEvidenceLinks,
  evalResults,
  evalRuns,
  evalSteps,
  missionEdges,
  missionNodes,
  missions,
  missionTasks,
  operators,
  taskRuns,
  tasks,
  toolExecutions,
  workspaceMembers,
  workspaceSettings,
} from '@pilot/db/schema';
import {
  getCapabilityRecord,
  getCapabilityRecords,
  getCapabilitySummary,
  type CapabilityKey,
  type CapabilityRecord,
} from '@pilot/shared/capabilities';
import { getPilotProductionEvalSuite } from '@pilot/shared/eval';
import {
  CommandCenterEvalStatusResponseSchema,
  CommandCenterMissionGraphResponseSchema,
  CommandCenterProofDagResponseSchema,
  CommandCenterPermissionGraphResponseSchema,
  CommandCenterReplayResponseSchema,
  CommandCenterResponseSchema,
} from '@pilot/shared/schemas';
import { type GatewayDeps } from '../index.js';
import { getWorkspaceId, getWorkspaceRole, requireWorkspaceRole } from '../lib/workspace.js';

const focusCapabilityKeys = [
  'mission_runtime',
  'command_center',
  'evidence_ledger',
  'helm_receipts',
  'workspace_rbac',
  'operator_scoping',
  'browser_execution',
  'computer_use',
  'startup_lifecycle',
  'founder_off_grid',
] satisfies CapabilityKey[];

const focusCapabilityKeySet: ReadonlySet<CapabilityKey> = new Set(focusCapabilityKeys);
const permissionCapabilityKeys = [
  'workspace_rbac',
  'operator_scoping',
  'helm_receipts',
  'skill_registry_runtime',
  'browser_execution',
  'computer_use',
] satisfies CapabilityKey[];

export function commandCenterRoutes(deps: GatewayDeps) {
  const app = new Hono();

  app.get('/', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view command center');
    if (roleDenied) return roleDenied;

    const capabilities = getCapabilityRecords();
    const commandCenter = getCapabilityRecord('command_center');
    const missionRuntime = getCapabilityRecord('mission_runtime');
    if (!commandCenter || !missionRuntime) {
      return c.json({ error: 'capability registry incomplete' }, 500);
    }

    const taskRows = await deps.db
      .select()
      .from(tasks)
      .where(eq(tasks.workspaceId, workspaceId))
      .orderBy(desc(tasks.updatedAt), desc(tasks.createdAt), desc(tasks.id))
      .limit(20);

    const taskIds = taskRows.map((task) => task.id);
    const taskRunRows =
      taskIds.length === 0
        ? []
        : await deps.db
            .select()
            .from(taskRuns)
            .where(inArray(taskRuns.taskId, taskIds))
            .orderBy(desc(taskRuns.startedAt), desc(taskRuns.runSequence), desc(taskRuns.id))
            .limit(30);

    const actionRows = await deps.db
      .select()
      .from(actions)
      .where(eq(actions.workspaceId, workspaceId))
      .orderBy(desc(actions.startedAt), desc(actions.id))
      .limit(30);

    const toolExecutionRows = await deps.db
      .select()
      .from(toolExecutions)
      .where(eq(toolExecutions.workspaceId, workspaceId))
      .orderBy(desc(toolExecutions.createdAt), desc(toolExecutions.id))
      .limit(30);

    const evidenceRows = await deps.db
      .select()
      .from(evidencePacks)
      .where(eq(evidencePacks.workspaceId, workspaceId))
      .orderBy(desc(evidencePacks.receivedAt), desc(evidencePacks.id))
      .limit(30);

    const evidenceItemRows = await deps.db
      .select()
      .from(evidenceItems)
      .where(eq(evidenceItems.workspaceId, workspaceId))
      .orderBy(desc(evidenceItems.observedAt), desc(evidenceItems.id))
      .limit(30);

    const approvalRows = await deps.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.workspaceId, workspaceId), eq(approvals.status, 'pending')))
      .orderBy(desc(approvals.requestedAt), desc(approvals.id))
      .limit(30);

    const auditRows = await deps.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.workspaceId, workspaceId))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(30);

    const browserObservationRows = await deps.db
      .select()
      .from(browserObservations)
      .where(eq(browserObservations.workspaceId, workspaceId))
      .orderBy(desc(browserObservations.observedAt), desc(browserObservations.replayIndex))
      .limit(20);

    const computerActionRows = await deps.db
      .select()
      .from(computerActions)
      .where(eq(computerActions.workspaceId, workspaceId))
      .orderBy(desc(computerActions.createdAt), desc(computerActions.replayIndex))
      .limit(20);

    const handoffRows = await deps.db
      .select()
      .from(agentHandoffs)
      .where(eq(agentHandoffs.workspaceId, workspaceId))
      .orderBy(desc(agentHandoffs.createdAt), desc(agentHandoffs.id))
      .limit(20);

    const artifactRows = await deps.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.workspaceId, workspaceId))
      .orderBy(desc(artifacts.updatedAt), desc(artifacts.id))
      .limit(20);

    const response = CommandCenterResponseSchema.parse({
      workspaceId,
      generatedAt: new Date().toISOString(),
      runtimeTruth: {
        productionReady:
          commandCenter.state === 'production_ready' && missionRuntime.state === 'production_ready',
        commandCenterState: commandCenter.state,
        missionRuntimeState: missionRuntime.state,
        statement:
          missionRuntime.state === 'production_ready'
            ? 'Command center is backed by mission runtime state.'
            : 'Mission runtime is not production_ready; command center exposes durable task, action, receipt, browser, computer, artifact, audit, and approval state without claiming mission autonomy.',
        blockers: Array.from(new Set([...commandCenter.blockers, ...missionRuntime.blockers])),
      },
      authorization: {
        workspaceRole: getWorkspaceRole(c) ?? null,
        requiredRole: 'partner',
        workspaceId,
      },
      capabilities: {
        summary: getCapabilitySummary(capabilities),
        records: capabilities.filter((capability) => focusCapabilityKeySet.has(capability.key)),
        focusKeys: focusCapabilityKeys,
      },
      status: {
        activeTasks: taskRows.filter((task) =>
          ['queued', 'running', 'awaiting_approval'].includes(String(task.status)),
        ).length,
        pendingApprovals: approvalRows.length,
        recentActions: actionRows.length,
        recentEvidence: evidenceRows.length,
        evidenceItems: evidenceItemRows.length,
        recentArtifacts: artifactRows.length,
        browserObservations: browserObservationRows.length,
        computerActions: computerActionRows.length,
      },
      recent: {
        tasks: taskRows,
        taskRuns: taskRunRows,
        actions: actionRows,
        toolExecutions: toolExecutionRows,
        evidencePacks: evidenceRows,
        evidenceItems: evidenceItemRows,
        approvals: approvalRows,
        auditEvents: auditRows,
        browserObservations: browserObservationRows.map(withBrowserReplayRef),
        computerActions: computerActionRows.map(withComputerReplayRef),
        agentHandoffs: handoffRows,
        artifacts: artifactRows,
      },
    });

    return c.json(response);
  });

  app.get('/permission-graph', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view permission graph');
    if (roleDenied) return roleDenied;

    const capability = getCapabilityRecord('command_center');
    if (!capability) return c.json({ error: 'capability registry incomplete' }, 500);

    const memberRows = await deps.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .orderBy(asc(workspaceMembers.role), asc(workspaceMembers.id))
      .limit(100);

    const operatorRows = await deps.db
      .select()
      .from(operators)
      .where(eq(operators.workspaceId, workspaceId))
      .orderBy(asc(operators.createdAt), asc(operators.id))
      .limit(100);

    const [settingsRow] = await deps.db
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId))
      .limit(1);

    const currentRole = getWorkspaceRole(c) ?? 'member';
    const policyConfig = toRecord(settingsRow?.policyConfig);
    const policyConfigKeys = Object.keys(policyConfig)
      .filter((key) => !isSensitiveKey(key))
      .sort();
    const permissionCapabilities = permissionCapabilityKeys
      .map((key) => getCapabilityRecord(key))
      .filter((record): record is CapabilityRecord => Boolean(record));
    const toolScopes = Array.from(
      new Set(operatorRows.flatMap((operator) => toStringArray(operator.tools))),
    )
      .map((tool) => redactReplayText(tool))
      .sort()
      .slice(0, 50);

    const nodes = [
      {
        id: `workspace:${workspaceId}`,
        kind: 'workspace' as const,
        label: 'Workspace',
        state: 'scoped',
        metadata: { workspaceId },
      },
      {
        id: 'workspace-role:current',
        kind: 'workspace_role' as const,
        label: `Current role ${currentRole}`,
        state: 'allowed',
        metadata: { role: currentRole },
      },
      {
        id: 'required-role:partner',
        kind: 'required_role' as const,
        label: 'Command center requires partner',
        state: 'allowed',
        metadata: { requiredRole: 'partner' },
      },
      {
        id: 'policy-config',
        kind: 'policy_config' as const,
        label: `Workspace policy config (${policyConfigKeys.length} keys)`,
        state: settingsRow ? 'configured' : 'blocked',
        metadata: { policyConfigKeys },
      },
      ...memberRows.map((member) => ({
        id: `member:${member.id}`,
        kind: 'workspace_role' as const,
        label: `Workspace member ${member.role}`,
        state: 'configured',
        metadata: { memberId: member.id, role: member.role },
      })),
      ...operatorRows.map((operator) => ({
        id: `operator:${operator.id}`,
        kind: 'operator' as const,
        label: operator.name,
        state: operator.isActive === 'true' ? 'active' : 'inactive',
        metadata: {
          operatorId: operator.id,
          role: operator.role,
          toolCount: toStringArray(operator.tools).length,
          constraintCount: toStringArray(operator.constraints).length,
        },
      })),
      ...toolScopes.map((tool) => ({
        id: `tool-scope:${tool}`,
        kind: 'tool_scope' as const,
        label: tool,
        state: 'configured',
        metadata: { tool },
      })),
      ...permissionCapabilities.map((record) => ({
        id: `capability:${record.key}`,
        kind: 'capability' as const,
        label: record.name,
        state: record.state,
        metadata: {
          capabilityKey: record.key,
          evalRequirement: record.evalRequirement,
          productionReady: record.state === 'production_ready',
        },
      })),
    ];

    const edges = [
      {
        id: 'workspace-current-role',
        from: `workspace:${workspaceId}`,
        to: 'workspace-role:current',
        relation: 'authenticated_role',
        status: 'allowed' as const,
      },
      {
        id: 'current-role-command-center',
        from: 'workspace-role:current',
        to: 'required-role:partner',
        relation: 'meets_required_role',
        status: 'allowed' as const,
      },
      {
        id: 'policy-config-workspace',
        from: 'policy-config',
        to: `workspace:${workspaceId}`,
        relation: 'governs_workspace',
        status: settingsRow ? ('configured' as const) : ('blocked' as const),
        ...(settingsRow ? {} : { reason: 'No workspace_settings row returned' }),
      },
      ...memberRows.map((member) => ({
        id: `workspace-member:${member.id}`,
        from: `workspace:${workspaceId}`,
        to: `member:${member.id}`,
        relation: 'has_member_role',
        status: 'configured' as const,
      })),
      ...operatorRows.map((operator) => ({
        id: `workspace-operator:${operator.id}`,
        from: `workspace:${workspaceId}`,
        to: `operator:${operator.id}`,
        relation: 'owns_operator',
        status: 'configured' as const,
      })),
      ...operatorRows.flatMap((operator) =>
        toStringArray(operator.tools)
          .slice(0, 50)
          .map((tool) => {
            const redactedTool = redactReplayText(tool);
            return {
              id: `operator-tool:${operator.id}:${redactedTool}`,
              from: `operator:${operator.id}`,
              to: `tool-scope:${redactedTool}`,
              relation: 'declares_tool_scope',
              status: 'configured' as const,
            };
          }),
      ),
      ...permissionCapabilities.map((record) => ({
        id: `capability-policy:${record.key}`,
        from: 'policy-config',
        to: `capability:${record.key}`,
        relation: 'constrains_capability',
        status:
          record.state === 'production_ready' ? ('allowed' as const) : ('requires_eval' as const),
        reason:
          record.state === 'production_ready'
            ? undefined
            : `${record.name} remains ${record.state}; ${record.evalRequirement} has not promoted it.`,
      })),
    ];

    const response = CommandCenterPermissionGraphResponseSchema.parse({
      workspaceId,
      generatedAt: new Date().toISOString(),
      productionReady: false,
      capability,
      redactionContract:
        'member user ids and raw policy values are withheld; tool names are redacted',
      graph: { nodes, edges },
      blockers: [
        'Permission graph is read-only command-center introspection, not a production-ready delegation control plane.',
        ...capability.blockers,
      ],
    });

    return c.json(response, 200);
  });

  app.get('/mission-graph', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view mission graph');
    if (roleDenied) return roleDenied;

    const capability = getCapabilityRecord('startup_lifecycle');
    if (!capability) return c.json({ error: 'capability registry incomplete' }, 500);

    const missionId = c.req.query('missionId') || undefined;
    const missionRows = await deps.db
      .select()
      .from(missions)
      .where(
        missionId
          ? and(eq(missions.workspaceId, workspaceId), eq(missions.id, missionId))
          : eq(missions.workspaceId, workspaceId),
      )
      .orderBy(desc(missions.updatedAt), desc(missions.createdAt), desc(missions.id))
      .limit(missionId ? 1 : 10);

    const missionIds = missionRows.map((mission) => mission.id);
    const nodeRows =
      missionIds.length === 0
        ? []
        : await deps.db
            .select()
            .from(missionNodes)
            .where(
              and(
                eq(missionNodes.workspaceId, workspaceId),
                inArray(missionNodes.missionId, missionIds),
              ),
            )
            .orderBy(asc(missionNodes.missionId), asc(missionNodes.sortOrder), asc(missionNodes.id))
            .limit(500);
    const edgeRows =
      missionIds.length === 0
        ? []
        : await deps.db
            .select()
            .from(missionEdges)
            .where(
              and(
                eq(missionEdges.workspaceId, workspaceId),
                inArray(missionEdges.missionId, missionIds),
              ),
            )
            .orderBy(asc(missionEdges.missionId), asc(missionEdges.edgeKey), asc(missionEdges.id))
            .limit(500);
    const taskLinkRows =
      missionIds.length === 0
        ? []
        : await deps.db
            .select()
            .from(missionTasks)
            .where(
              and(
                eq(missionTasks.workspaceId, workspaceId),
                inArray(missionTasks.missionId, missionIds),
              ),
            )
            .orderBy(asc(missionTasks.missionId), asc(missionTasks.createdAt), asc(missionTasks.id))
            .limit(500);
    const recoveryEvidenceRows =
      missionIds.length === 0
        ? []
        : await deps.db
            .select()
            .from(evidenceItems)
            .where(
              and(
                eq(evidenceItems.workspaceId, workspaceId),
                inArray(evidenceItems.missionId, missionIds),
                or(
                  eq(evidenceItems.evidenceType, 'startup_lifecycle_mission_checkpoint'),
                  eq(evidenceItems.evidenceType, 'startup_lifecycle_recovery_plan'),
                  eq(evidenceItems.evidenceType, 'startup_lifecycle_recovery_applied'),
                  eq(evidenceItems.evidenceType, 'startup_lifecycle_mission_rollback_applied'),
                ),
              ),
            )
            .orderBy(desc(evidenceItems.observedAt), desc(evidenceItems.id))
            .limit(100);

    const response = CommandCenterMissionGraphResponseSchema.parse({
      workspaceId,
      generatedAt: new Date().toISOString(),
      productionReady: false,
      capability,
      missionId: missionId ?? null,
      graph: {
        missions: missionRows,
        nodes: nodeRows,
        edges: edgeRows,
        taskLinks: taskLinkRows,
        recovery: {
          checkpoints: recoveryEvidenceRows.filter(
            (row) => row.evidenceType === 'startup_lifecycle_mission_checkpoint',
          ),
          recoveryPlans: recoveryEvidenceRows.filter(
            (row) => row.evidenceType === 'startup_lifecycle_recovery_plan',
          ),
          recoveryApplies: recoveryEvidenceRows.filter(
            (row) => row.evidenceType === 'startup_lifecycle_recovery_applied',
          ),
          rollbacks: recoveryEvidenceRows.filter(
            (row) => row.evidenceType === 'startup_lifecycle_mission_rollback_applied',
          ),
        },
        orderedBy: [
          'mission.updatedAt',
          'node.sortOrder',
          'edge.edgeKey',
          'taskLink.createdAt',
          'recoveryEvidence.observedAt',
        ],
      },
      blockers: [
        'Mission graph and recovery evidence are read-only command-center introspection; they do not dispatch, apply recovery, roll back, or resume mission DAGs.',
        ...capability.blockers,
      ],
    });

    return c.json(response, 200);
  });

  app.get('/eval-status', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view eval status');
    if (roleDenied) return roleDenied;

    const capability = getCapabilityRecord('command_center');
    if (!capability) return c.json({ error: 'capability registry incomplete' }, 500);

    const runRows = await deps.db
      .select()
      .from(evalRuns)
      .where(eq(evalRuns.workspaceId, workspaceId))
      .orderBy(desc(evalRuns.createdAt), desc(evalRuns.id))
      .limit(20);

    const promotionRows = await deps.db
      .select()
      .from(capabilityPromotions)
      .where(eq(capabilityPromotions.workspaceId, workspaceId))
      .orderBy(desc(capabilityPromotions.createdAt), desc(capabilityPromotions.id))
      .limit(20);

    const evalRunIds = runRows.map((row) => row.id);
    const resultRows =
      evalRunIds.length === 0
        ? []
        : await deps.db
            .select()
            .from(evalResults)
            .where(
              and(
                eq(evalResults.workspaceId, workspaceId),
                inArray(evalResults.evalRunId, evalRunIds),
              ),
            )
            .orderBy(desc(evalResults.createdAt), desc(evalResults.id))
            .limit(50);
    const stepRows =
      evalRunIds.length === 0
        ? []
        : await deps.db
            .select()
            .from(evalSteps)
            .where(inArray(evalSteps.evalRunId, evalRunIds))
            .orderBy(desc(evalSteps.completedAt), desc(evalSteps.startedAt), desc(evalSteps.id))
            .limit(100);
    const evidenceLinkRows =
      evalRunIds.length === 0
        ? []
        : await deps.db
            .select()
            .from(evalEvidenceLinks)
            .where(
              and(
                eq(evalEvidenceLinks.workspaceId, workspaceId),
                inArray(evalEvidenceLinks.evalRunId, evalRunIds),
              ),
            )
            .orderBy(desc(evalEvidenceLinks.createdAt), desc(evalEvidenceLinks.id))
            .limit(100);

    const scenarios = getPilotProductionEvalSuite().map((scenario) => ({
      id: scenario.id,
      name: scenario.name,
      capabilityKeys: scenario.capabilityKeys,
      requiredHelmPolicies: scenario.requiredHelmPolicies,
      evidenceRequirements: scenario.evidenceRequirements,
      auditRequirements: scenario.auditRequirements,
      successCriteria: scenario.successCriteria,
      failureCriteria: scenario.failureCriteria,
    }));

    const response = CommandCenterEvalStatusResponseSchema.parse({
      workspaceId,
      generatedAt: new Date().toISOString(),
      productionReady: false,
      capability,
      promotionRule:
        'A capability cannot be promoted to production_ready unless every required eval run passed with evidenceRefs, auditReceiptRefs, completedAt, and metadata.executionMode=real_external_eval; command-center eval status never mutates the registry.',
      evals: {
        scenarios,
        recentRuns: runRows.map(sanitizeEvalRow),
        results: resultRows.map(sanitizeEvalRow),
        steps: stepRows.map(sanitizeEvalRow),
        evidenceLinks: evidenceLinkRows.map(sanitizeEvalRow),
        promotions: promotionRows.map(sanitizeEvalRow),
        orderedBy: [
          'evalRun.createdAt',
          'evalResult.createdAt',
          'evalStep.completedAt',
          'evalEvidenceLink.createdAt',
          'capabilityPromotion.createdAt',
        ],
      },
      blockers: [
        'Eval status is read-only command-center introspection; it does not mark capabilities production_ready.',
        ...capability.blockers,
      ],
    });

    return c.json(response, 200);
  });

  app.get('/computer-actions/replay', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'replay computer actions');
    if (roleDenied) return roleDenied;

    const capability = getCapabilityRecord('computer_use');
    if (!capability) return c.json({ error: 'capability registry incomplete' }, 500);
    const taskId = c.req.query('taskId') || undefined;
    const rows = await deps.db
      .select()
      .from(computerActions)
      .where(
        taskId
          ? and(eq(computerActions.workspaceId, workspaceId), eq(computerActions.taskId, taskId))
          : eq(computerActions.workspaceId, workspaceId),
      )
      .orderBy(
        asc(computerActions.replayIndex),
        asc(computerActions.createdAt),
        asc(computerActions.id),
      )
      .limit(500);

    return c.json({
      replay: {
        kind: 'computer_action_sequence',
        workspaceId,
        taskId: taskId ?? null,
        orderedBy: ['replayIndex', 'createdAt', 'id'],
        capability: {
          key: capability.key,
          state: capability.state,
          productionReady: capability.state === 'production_ready',
        },
        redactionContract: 'bounded_stdout_stderr_and_file_diff_previews_no_secret_metadata',
        actions: rows.map((action) => ({
          id: action.id,
          replayRef: `computer:${action.id}:${action.replayIndex}`,
          taskId: action.taskId,
          toolActionId: action.toolActionId,
          operatorId: action.operatorId,
          actionType: action.actionType,
          environment: action.environment,
          objective: action.objective,
          status: action.status,
          cwd: action.cwd,
          command: action.command,
          args: action.args,
          filePath: action.filePath,
          devServerUrl: action.devServerUrl,
          stdoutPreview: previewText(action.stdout),
          stderrPreview: previewText(action.stderr),
          exitCode: action.exitCode,
          durationMs: action.durationMs,
          fileDiffPreview: previewText(action.fileDiff),
          outputHash: action.outputHash,
          policyDecisionId: action.policyDecisionId,
          policyVersion: action.policyVersion,
          evidencePackId: action.evidencePackId,
          replayIndex: action.replayIndex,
          createdAt: action.createdAt,
          completedAt: action.completedAt,
          metadata: redactReplayMetadata(action.metadata),
        })),
      },
    });
  });

  app.get('/proof-dag/:taskRunId', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view subagent proof DAG');
    if (roleDenied) return roleDenied;

    const rootTaskRunId = c.req.param('taskRunId');
    const capability = getCapabilityRecord('subagent_lineage');
    if (!capability) return c.json({ error: 'capability registry incomplete' }, 500);

    const [rootRun] = await deps.db
      .select()
      .from(taskRuns)
      .where(eq(taskRuns.id, rootTaskRunId))
      .limit(1);
    if (!rootRun) return c.json({ error: 'Task run not found' }, 404);

    const [task] = await deps.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, rootRun.taskId), eq(tasks.workspaceId, workspaceId)))
      .limit(1);
    if (!task) return c.json({ error: 'Task run not found in workspace' }, 404);

    const taskRunRows = await deps.db
      .select()
      .from(taskRuns)
      .where(
        and(
          eq(taskRuns.taskId, rootRun.taskId),
          or(
            eq(taskRuns.id, rootTaskRunId),
            eq(taskRuns.rootTaskRunId, rootTaskRunId),
            eq(taskRuns.parentTaskRunId, rootTaskRunId),
          ),
        ),
      )
      .orderBy(asc(taskRuns.runSequence), asc(taskRuns.startedAt), asc(taskRuns.id))
      .limit(200);
    const proofDagTaskRunRows = taskRunRows.filter((row) =>
      taskRunBelongsToProofDag(row, rootTaskRunId),
    );

    const taskRunIds = Array.from(new Set(proofDagTaskRunRows.map((row) => row.id)));
    const handoffRows =
      taskRunIds.length === 0
        ? []
        : await deps.db
            .select()
            .from(agentHandoffs)
            .where(
              and(
                eq(agentHandoffs.workspaceId, workspaceId),
                or(
                  inArray(agentHandoffs.parentTaskRunId, taskRunIds),
                  inArray(agentHandoffs.childTaskRunId, taskRunIds),
                ),
              ),
            )
            .orderBy(desc(agentHandoffs.createdAt), desc(agentHandoffs.id))
            .limit(200);
    const evidenceRows =
      taskRunIds.length === 0
        ? []
        : await deps.db
            .select()
            .from(evidencePacks)
            .where(
              and(
                eq(evidencePacks.workspaceId, workspaceId),
                inArray(evidencePacks.taskRunId, taskRunIds),
              ),
            )
            .orderBy(desc(evidencePacks.receivedAt), desc(evidencePacks.id))
            .limit(200);

    const response = CommandCenterProofDagResponseSchema.parse({
      workspaceId,
      rootTaskRunId,
      generatedAt: new Date().toISOString(),
      productionReady: false,
      capability,
      dag: {
        taskRuns: proofDagTaskRunRows,
        agentHandoffs: handoffRows,
        evidencePacks: evidenceRows,
      },
      blockers: [
        'Proof DAG route is implemented for inspection but has not passed Proof DAG Lineage Regression',
        'This route does not promote subagent_lineage or command_center to production_ready',
      ],
    });

    return c.json(response);
  });

  app.get('/replay', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view command-center replay');
    if (roleDenied) return roleDenied;

    const replayRef = c.req.query('ref')?.trim();
    if (!replayRef) return c.json({ error: 'replay ref required' }, 400);

    const capability = getCapabilityRecord('evidence_ledger');
    if (!capability) return c.json({ error: 'capability registry incomplete' }, 500);

    const evidenceItemRows = await deps.db
      .select()
      .from(evidenceItems)
      .where(
        and(eq(evidenceItems.workspaceId, workspaceId), eq(evidenceItems.replayRef, replayRef)),
      )
      .orderBy(desc(evidenceItems.observedAt), desc(evidenceItems.id))
      .limit(50);

    const linkedBrowserObservationIds = uniqueStrings(
      evidenceItemRows.map((row) => stringField(row, 'browserObservationId')),
    );
    const linkedComputerActionIds = uniqueStrings(
      evidenceItemRows.map((row) => stringField(row, 'computerActionId')),
    );
    const parsedBrowserRef = parseBrowserReplayRef(replayRef);
    const parsedComputerRef = parseComputerReplayRef(replayRef);

    const browserObservationRows =
      linkedBrowserObservationIds.length > 0
        ? await deps.db
            .select()
            .from(browserObservations)
            .where(
              and(
                eq(browserObservations.workspaceId, workspaceId),
                inArray(browserObservations.id, linkedBrowserObservationIds),
              ),
            )
            .orderBy(asc(browserObservations.replayIndex), asc(browserObservations.observedAt))
            .limit(50)
        : parsedBrowserRef
          ? await deps.db
              .select()
              .from(browserObservations)
              .where(
                and(
                  eq(browserObservations.workspaceId, workspaceId),
                  eq(browserObservations.sessionId, parsedBrowserRef.sessionId),
                  eq(browserObservations.replayIndex, parsedBrowserRef.replayIndex),
                ),
              )
              .orderBy(asc(browserObservations.replayIndex), asc(browserObservations.observedAt))
              .limit(50)
          : [];

    const computerActionRows =
      linkedComputerActionIds.length > 0
        ? await deps.db
            .select()
            .from(computerActions)
            .where(
              and(
                eq(computerActions.workspaceId, workspaceId),
                inArray(computerActions.id, linkedComputerActionIds),
              ),
            )
            .orderBy(asc(computerActions.replayIndex), asc(computerActions.createdAt))
            .limit(50)
        : parsedComputerRef
          ? await deps.db
              .select()
              .from(computerActions)
              .where(
                and(
                  eq(computerActions.workspaceId, workspaceId),
                  eq(computerActions.id, parsedComputerRef.actionId),
                  eq(computerActions.replayIndex, parsedComputerRef.replayIndex),
                ),
              )
              .orderBy(asc(computerActions.replayIndex), asc(computerActions.createdAt))
              .limit(50)
          : [];

    if (
      evidenceItemRows.length === 0 &&
      browserObservationRows.length === 0 &&
      computerActionRows.length === 0
    ) {
      return c.json({ error: 'Replay ref not found in workspace' }, 404);
    }

    const response = CommandCenterReplayResponseSchema.parse({
      workspaceId,
      replayRef,
      generatedAt: new Date().toISOString(),
      productionReady: false,
      capability,
      replay: {
        evidenceItems: evidenceItemRows.map(sanitizeGenericReplayRow),
        browserObservations: browserObservationRows.map(withBrowserReplayRef),
        computerActions: computerActionRows.map(withComputerReplayRef),
      },
      blockers: [
        'Replay contract is implemented for workspace-scoped inspection but has not passed Browser/Computer Replay Eval',
        'This route does not promote evidence_ledger, browser_execution, computer_use, or command_center to production_ready',
      ],
    });

    return c.json(response);
  });

  return app;
}

function parseBrowserReplayRef(
  replayRef: string,
): { sessionId: string; replayIndex: number } | null {
  const match = /^browser:([^:]+):(\d+)$/.exec(replayRef);
  if (!match) return null;
  return { sessionId: match[1]!, replayIndex: Number(match[2]) };
}

function parseComputerReplayRef(
  replayRef: string,
): { actionId: string; replayIndex: number } | null {
  const match = /^computer:([^:]+):(\d+)$/.exec(replayRef);
  if (!match) return null;
  return { actionId: match[1]!, replayIndex: Number(match[2]) };
}

function taskRunBelongsToProofDag(
  row: typeof taskRuns.$inferSelect,
  rootTaskRunId: string,
): boolean {
  return (
    row.id === rootTaskRunId ||
    row.rootTaskRunId === rootTaskRunId ||
    row.parentTaskRunId === rootTaskRunId
  );
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function stringField(row: unknown, field: string): string | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const value = (row as Record<string, unknown>)[field];
  return typeof value === 'string' && value ? value : undefined;
}

function numberField(row: unknown, field: string): number | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const value = (row as Record<string, unknown>)[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sanitizeGenericReplayRow(row: unknown): Record<string, unknown> {
  const record = row && typeof row === 'object' ? { ...(row as Record<string, unknown>) } : {};
  if ('metadata' in record) record['metadata'] = redactReplayMetadata(record['metadata']);
  if ('extractedData' in record)
    record['extractedData'] = redactReplayMetadata(record['extractedData']);
  return record;
}

function withBrowserReplayRef(row: unknown): Record<string, unknown> {
  const record = sanitizeGenericReplayRow(row);
  const sessionId = stringField(record, 'sessionId');
  const replayIndex = numberField(record, 'replayIndex');
  return sessionId && replayIndex !== undefined
    ? { ...record, replayRef: `browser:${sessionId}:${replayIndex}` }
    : record;
}

function sanitizeComputerReplayRow(row: unknown): Record<string, unknown> {
  const record = sanitizeGenericReplayRow(row);
  record['stdout'] = previewText(typeof record['stdout'] === 'string' ? record['stdout'] : null);
  record['stderr'] = previewText(typeof record['stderr'] === 'string' ? record['stderr'] : null);
  record['fileDiff'] = previewText(
    typeof record['fileDiff'] === 'string' ? record['fileDiff'] : null,
  );
  return record;
}

function withComputerReplayRef(row: unknown): Record<string, unknown> {
  const record = sanitizeComputerReplayRow(row);
  const actionId = stringField(record, 'id');
  const replayIndex = numberField(record, 'replayIndex');
  return actionId && replayIndex !== undefined
    ? { ...record, replayRef: `computer:${actionId}:${replayIndex}` }
    : record;
}

function sanitizeEvalRow(row: unknown): Record<string, unknown> {
  const record = sanitizeGenericReplayRow(row);
  for (const key of ['evidenceRefs', 'auditReceiptRefs']) {
    const value = record[key];
    if (Array.isArray(value)) {
      record[key] = value.map((item) => (typeof item === 'string' ? redactReplayText(item) : item));
    }
  }
  for (const key of ['runRef', 'failureReason', 'summary', 'evidenceRef', 'auditReceiptRef']) {
    const value = record[key];
    if (typeof value === 'string') record[key] = redactReplayText(value);
  }
  return record;
}

function previewText(value: string | null | undefined): string | null {
  if (!value) return null;
  const preview = value.length > 4_000 ? `${value.slice(0, 4_000)}...[truncated]` : value;
  return redactReplayText(preview);
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .filter((item) => !isSensitiveKey(item));
}

function isSensitiveKey(value: string): boolean {
  return /password|passwd|pwd|token|secret|api[_-]?key|authorization|cookie|session/iu.test(value);
}

function redactReplayMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactReplayMetadata);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => {
      if (/password|passwd|pwd|token|secret|api[_-]?key|authorization|cookie|session/iu.test(key)) {
        return [key, '[REDACTED]'];
      }
      return [
        key,
        typeof child === 'string' ? redactReplayText(child) : redactReplayMetadata(child),
      ];
    }),
  );
}

function redactReplayText(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gu, '$1[REDACTED]')
    .replace(/\b(token|secret|password|cookie|session)=([^&\s]+)/giu, '$1=[REDACTED]');
}
