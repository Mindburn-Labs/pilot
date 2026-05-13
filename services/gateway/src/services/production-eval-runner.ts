import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  a2aMessages,
  a2aThreads,
  agentHandoffs,
  artifacts,
  auditLog,
  browserObservations,
  computerActions,
  deployHealth,
  deployments,
  evidenceItems,
  evidencePacks,
  missionEdges,
  missionNodes,
  missionTasks,
  missions,
  opportunities,
  opportunityScores,
  taskRuns,
  tasks,
  toolExecutions,
} from '@pilot/db/schema';
import type { Db } from '@pilot/db/client';
import {
  PRODUCTION_READY_EXECUTION_MODE,
  type ExecutePilotEvalInput,
  type RecordPilotEvalRunInput,
} from '@pilot/shared/eval';

type TrustedRealExternalEvalInput = ExecutePilotEvalInput & {
  workspaceId: string;
  executionMode: typeof PRODUCTION_READY_EXECUTION_MODE;
};

type ProductionEvalRunner = {
  execute(input: TrustedRealExternalEvalInput): Promise<{
    run: RecordPilotEvalRunInput;
    blockers?: string[];
  }>;
};

const FULL_STARTUP_LAUNCH_REQUIRED_STAGES = [
  'founder_onboarding',
  'ideation',
  'market_research',
  'pmf_discovery',
  'product_definition',
  'brand_domain_planning',
  'engineering',
  'infrastructure_deployment',
  'growth_experiments',
  'operations_recovery',
] as const;

const FULL_STARTUP_MIN_TOOL_PROOFS = 3;

type ComputerActionRow = typeof computerActions.$inferSelect;
type BrowserObservationRow = typeof browserObservations.$inferSelect;
type EvidencePackRow = typeof evidencePacks.$inferSelect;
type EvidenceItemRow = typeof evidenceItems.$inferSelect;
type AuditRow = typeof auditLog.$inferSelect;
type A2aThreadRow = typeof a2aThreads.$inferSelect;
type A2aMessageRow = typeof a2aMessages.$inferSelect;
type MissionRow = typeof missions.$inferSelect;
type MissionNodeRow = typeof missionNodes.$inferSelect;
type MissionEdgeRow = typeof missionEdges.$inferSelect;
type MissionTaskRow = typeof missionTasks.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;
type TaskRunRow = typeof taskRuns.$inferSelect;
type AgentHandoffRow = typeof agentHandoffs.$inferSelect;
type ArtifactRow = typeof artifacts.$inferSelect;
type DeploymentRow = typeof deployments.$inferSelect;
type DeployHealthRow = typeof deployHealth.$inferSelect;
type OpportunityRow = typeof opportunities.$inferSelect;
type OpportunityScoreRow = typeof opportunityScores.$inferSelect;
type ToolExecutionRow = typeof toolExecutions.$inferSelect;

const SAFE_COMPUTER_ACTIONS = new Set([
  'terminal_command',
  'file_read',
  'file_write',
  'dev_server_status',
]);
const BROWSER_CREDENTIAL_BOUNDARY = 'read_only_no_cookie_or_password_export';

export function createProductionEvalRunner(db: Db): ProductionEvalRunner {
  return {
    async execute(input) {
      if (input.evalId === 'full_startup_launch') {
        return executeFullStartupLaunchEval(db, input);
      }
      if (input.evalId === 'safe_computer_sandbox_action') {
        return executeSafeComputerSandboxEval(db, input);
      }
      if (input.evalId === 'yc_logged_in_browser_extraction') {
        return executeYcLoggedInBrowserExtractionEval(db, input);
      }
      if (input.evalId === 'helm_governance') {
        return executeHelmGovernanceEval(db, input);
      }
      if (input.evalId === 'decision_court_governed_model') {
        return executeDecisionCourtGovernedModelEval(db, input);
      }
      if (input.evalId === 'pmf_discovery') {
        return executePmfDiscoveryEval(db, input);
      }
      if (input.evalId === 'skill_invocation_governance') {
        return executeSkillInvocationGovernanceEval(db, input);
      }
      if (input.evalId === 'proof_dag_lineage') {
        return executeProofDagLineageEval(db, input);
      }
      if (input.evalId === 'approval_resume_isolation') {
        return executeApprovalResumeIsolationEval(db, input);
      }
      if (input.evalId === 'cross_workspace_operator_rejection') {
        return executeCrossWorkspaceOperatorRejectionEval(db, input);
      }
      if (input.evalId === 'recovery') {
        return executeRecoveryEval(db, input);
      }
      if (input.evalId === 'multi_agent_parallel_build') {
        return executeMultiAgentParallelBuildEval(db, input);
      }
      if (input.evalId === 'command_center_real_state_ux') {
        return executeCommandCenterRealStateUxEval(db, input);
      }
      return failedRun(
        input,
        `No trusted real_external_eval runner is implemented for ${input.evalId}`,
      );
    },
  };
}

async function executeFullStartupLaunchEval(
  db: Db,
  input: TrustedRealExternalEvalInput,
): Promise<{ run: RecordPilotEvalRunInput }> {
  const missionRows = await db
    .select()
    .from(missions)
    .where(eq(missions.workspaceId, input.workspaceId))
    .orderBy(desc(missions.completedAt), desc(missions.updatedAt), desc(missions.id))
    .limit(100);
  const nodeRows = await db
    .select()
    .from(missionNodes)
    .where(eq(missionNodes.workspaceId, input.workspaceId))
    .orderBy(desc(missionNodes.updatedAt), desc(missionNodes.id))
    .limit(1000);
  const edgeRows = await db
    .select()
    .from(missionEdges)
    .where(eq(missionEdges.workspaceId, input.workspaceId))
    .orderBy(desc(missionEdges.createdAt), desc(missionEdges.id))
    .limit(1000);
  const missionTaskRows = await db
    .select()
    .from(missionTasks)
    .where(eq(missionTasks.workspaceId, input.workspaceId))
    .orderBy(desc(missionTasks.createdAt), desc(missionTasks.id))
    .limit(1000);
  const taskRows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.workspaceId, input.workspaceId))
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(1000);
  const taskIds = taskRows.map((row) => row.id);
  const runRows =
    taskIds.length > 0
      ? await db
          .select()
          .from(taskRuns)
          .where(inArray(taskRuns.taskId, taskIds))
          .orderBy(desc(taskRuns.completedAt), desc(taskRuns.startedAt), desc(taskRuns.id))
          .limit(2000)
      : [];
  const executionRows = await db
    .select()
    .from(toolExecutions)
    .where(eq(toolExecutions.workspaceId, input.workspaceId))
    .orderBy(desc(toolExecutions.completedAt), desc(toolExecutions.id))
    .limit(2000);
  const artifactRows = await db
    .select()
    .from(artifacts)
    .where(eq(artifacts.workspaceId, input.workspaceId))
    .orderBy(desc(artifacts.updatedAt), desc(artifacts.id))
    .limit(500);
  const deploymentRows = await db
    .select()
    .from(deployments)
    .where(eq(deployments.workspaceId, input.workspaceId))
    .orderBy(desc(deployments.completedAt), desc(deployments.id))
    .limit(500);
  const healthRows = await db
    .select()
    .from(deployHealth)
    .orderBy(desc(deployHealth.checkedAt), desc(deployHealth.id))
    .limit(500);
  const evidenceRows = await db
    .select()
    .from(evidenceItems)
    .where(eq(evidenceItems.workspaceId, input.workspaceId))
    .orderBy(desc(evidenceItems.observedAt), desc(evidenceItems.id))
    .limit(2000);
  const auditRows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.workspaceId, input.workspaceId))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(2000);

  const proof = findFullStartupLaunchProof({
    workspaceId: input.workspaceId,
    missionRows,
    nodeRows,
    edgeRows,
    missionTaskRows,
    taskRows,
    runRows,
    executionRows,
    artifactRows,
    deploymentRows,
    healthRows,
    evidenceRows,
    auditRows,
  });
  if (!proof) {
    return failedRun(
      input,
      'Full Startup Launch Eval requires a completed startup lifecycle mission DAG, required launch stages, completed linked task runs, brokered tool evidence, artifact provenance, live deployment and health evidence, checkpoint evidence, and durable audit receipts',
    );
  }

  const evidenceRefs = [
    evidenceRef(proof.persistEvidence),
    evidenceRef(proof.checkpointEvidence),
    evidenceRef(proof.artifactEvidence),
    evidenceRef(proof.deploymentEvidence),
    evidenceRef(proof.healthEvidence),
    ...proof.toolProofs.map((item) => evidenceRef(item.evidence)),
  ];
  const auditReceiptRefs = [
    auditRef(proof.checkpointAudit),
    auditRef(proof.artifactAudit),
    auditRef(proof.deploymentAudit),
    auditRef(proof.healthAudit),
    ...proof.toolProofs.map((item) => auditRef(item.audit)),
  ];
  const completedAt = new Date().toISOString();

  return {
    run: {
      workspaceId: input.workspaceId,
      evalId: 'full_startup_launch',
      status: 'passed',
      capabilityKey: input.capabilityKey,
      runRef: input.runRef ?? `real-external-eval:full-startup-launch:${randomUUID()}`,
      summary:
        'Full Startup Launch Eval verified a completed lifecycle mission DAG with required stages, task-run execution, brokered tool evidence, artifact provenance, deployment verification, checkpoint evidence, and audit receipts.',
      evidenceRefs,
      auditReceiptRefs,
      metadata: {
        runnerRef: 'gateway:full_startup_launch:v1',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
        verifiedMissionId: proof.mission.id,
        verifiedNodeCount: proof.nodes.length,
        verifiedEdgeCount: proof.edges.length,
        verifiedTaskRunIds: proof.completedRuns.map((row) => row.id),
        verifiedToolExecutionIds: proof.toolProofs.map((item) => item.execution.id),
        verifiedArtifactId: proof.artifact.id,
        verifiedDeploymentId: proof.deployment.id,
        verifiedDeploymentUrl: proof.deployment.url,
        verifiedDeployHealthId: proof.health.id,
        requiredStages: [...FULL_STARTUP_LAUNCH_REQUIRED_STAGES],
      },
      completedAt,
      steps: [
        {
          stepKey: 'completed-lifecycle-mission-dag',
          status: 'passed',
          evidenceRefs: [evidenceRef(proof.persistEvidence), evidenceRef(proof.checkpointEvidence)],
          auditReceiptRefs: [auditRef(proof.checkpointAudit)],
          completedAt,
          metadata: {
            missionId: proof.mission.id,
            nodeCount: proof.nodes.length,
            edgeCount: proof.edges.length,
            stages: uniqueSorted(proof.nodes.map((row) => row.stage)),
          },
        },
        {
          stepKey: 'brokered-runtime-tool-evidence',
          status: 'passed',
          evidenceRefs: proof.toolProofs.map((item) => evidenceRef(item.evidence)),
          auditReceiptRefs: proof.toolProofs.map((item) => auditRef(item.audit)),
          completedAt,
          metadata: {
            taskRunIds: proof.completedRuns.map((row) => row.id),
            toolExecutionIds: proof.toolProofs.map((item) => item.execution.id),
          },
        },
        {
          stepKey: 'artifact-and-deployment-verification',
          status: 'passed',
          evidenceRefs: [
            evidenceRef(proof.artifactEvidence),
            evidenceRef(proof.deploymentEvidence),
            evidenceRef(proof.healthEvidence),
          ],
          auditReceiptRefs: [
            auditRef(proof.artifactAudit),
            auditRef(proof.deploymentAudit),
            auditRef(proof.healthAudit),
          ],
          completedAt,
          metadata: {
            artifactId: proof.artifact.id,
            deploymentId: proof.deployment.id,
            deploymentUrl: proof.deployment.url,
            healthStatus: proof.health.status,
          },
        },
      ],
    },
  };
}

async function executeSkillInvocationGovernanceEval(
  db: Db,
  input: TrustedRealExternalEvalInput,
): Promise<{ run: RecordPilotEvalRunInput }> {
  const taskRows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.workspaceId, input.workspaceId))
    .orderBy(desc(tasks.createdAt))
    .limit(100);
  const taskIds = taskRows.map((row) => row.id);
  if (taskIds.length === 0) {
    return failedRun(
      input,
      'Skill Invocation Governance Eval requires a workspace-scoped task with subagent skill invocation records',
    );
  }

  const runRows = await db
    .select()
    .from(taskRuns)
    .where(inArray(taskRuns.taskId, taskIds))
    .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id))
    .limit(500);
  const handoffRows = await db
    .select()
    .from(agentHandoffs)
    .where(eq(agentHandoffs.workspaceId, input.workspaceId))
    .orderBy(desc(agentHandoffs.createdAt), desc(agentHandoffs.id))
    .limit(200);
  const executionRows = await db
    .select()
    .from(toolExecutions)
    .where(
      and(
        eq(toolExecutions.workspaceId, input.workspaceId),
        eq(toolExecutions.toolKey, 'skill.invoke'),
      ),
    )
    .orderBy(desc(toolExecutions.completedAt))
    .limit(100);

  const proof = findSkillInvocationGovernanceProof({
    taskRows,
    runRows,
    handoffRows,
    executionRows,
  });
  if (!proof) {
    return failedRun(
      input,
      'Skill Invocation Governance Eval requires a completed brokered skill.invoke execution, versioned skill metadata on task_runs and agent_handoffs, policy pins, and brokered invocation IDs',
    );
  }

  const evidenceRows = await db
    .select()
    .from(evidenceItems)
    .where(
      and(
        eq(evidenceItems.workspaceId, input.workspaceId),
        eq(evidenceItems.toolExecutionId, proof.execution.id),
      ),
    )
    .orderBy(desc(evidenceItems.observedAt))
    .limit(25);
  const evidence = evidenceRows.find((row) => isSkillInvocationToolEvidence(row, proof.execution));
  if (!evidence) {
    return failedRun(
      input,
      `skill.invoke tool execution ${proof.execution.id} has no linked skill Tool Broker evidence row`,
    );
  }
  if (!evidence.auditEventId) {
    return failedRun(input, `skill.invoke evidence ${evidence.id} is missing audit_event_id`);
  }
  if (
    !hasBrokeredSkillInvocation(
      proof.run.skillInvocations,
      proof.execution,
      proof.skill,
      evidence.id,
    ) ||
    !hasBrokeredSkillInvocation(
      proof.handoff.skillInvocations,
      proof.execution,
      proof.skill,
      evidence.id,
    )
  ) {
    return failedRun(
      input,
      `skill.invoke evidence ${evidence.id} is not referenced by task_run and handoff brokeredInvocation metadata`,
    );
  }

  const audits = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, input.workspaceId), eq(auditLog.id, evidence.auditEventId)))
    .limit(1);
  const audit = audits.find((row) => isSkillInvocationToolAudit(row, evidence, proof.execution));
  if (!audit) {
    return failedRun(
      input,
      `skill.invoke evidence ${evidence.id} has no matching TOOL_EXECUTION audit row`,
    );
  }

  const skill = proof.skill;
  const evidenceReference = evidenceRef(evidence);
  const auditReference = auditRef(audit);
  const completedAt = new Date().toISOString();

  return {
    run: {
      workspaceId: input.workspaceId,
      evalId: 'skill_invocation_governance',
      status: 'passed',
      capabilityKey: input.capabilityKey ?? 'skill_registry_runtime',
      runRef: input.runRef ?? `real-external-eval:skill-invocation:${randomUUID()}`,
      summary:
        'Skill Invocation Governance Eval verified a loaded, versioned, scoped skill activated through Tool Broker with task-run metadata, handoff metadata, evidence, policy pins, and audit receipt.',
      evidenceRefs: [evidenceReference],
      auditReceiptRefs: [auditReference],
      metadata: {
        runnerRef: 'gateway:skill_invocation_governance:v1',
        verifiedTaskId: proof.task.id,
        verifiedTaskRunId: proof.run.id,
        verifiedAgentHandoffId: proof.handoff.id,
        verifiedToolExecutionId: proof.execution.id,
        verifiedEvidenceItemId: evidence.id,
        verifiedAuditEventId: audit.id,
        skillName: skill.name,
        skillVersion: skill.version,
        skillRiskProfile: skill.riskProfile,
        skillEvalStatus: skill.evalStatus,
        permissionRequirements: skill.permissionRequirements,
        declaredTools: skill.declaredTools,
        policyDecisionId: proof.execution.policyDecisionId,
        policyVersion: proof.execution.policyVersion,
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
      completedAt,
      steps: [
        {
          stepKey: 'brokered-versioned-skill-invocation',
          status: 'passed',
          evidenceRefs: [evidenceReference],
          auditReceiptRefs: [auditReference],
          completedAt,
          metadata: {
            taskRunId: proof.run.id,
            handoffId: proof.handoff.id,
            toolExecutionId: proof.execution.id,
            skillName: skill.name,
            skillVersion: skill.version,
            riskProfile: skill.riskProfile,
            evalStatus: skill.evalStatus,
            permissionRequirements: skill.permissionRequirements,
            declaredTools: skill.declaredTools,
          },
        },
      ],
    },
  };
}

async function executeProofDagLineageEval(
  db: Db,
  input: TrustedRealExternalEvalInput,
): Promise<{ run: RecordPilotEvalRunInput }> {
  const taskRows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.workspaceId, input.workspaceId))
    .orderBy(desc(tasks.createdAt))
    .limit(100);
  const taskIds = taskRows.map((row) => row.id);
  if (taskIds.length === 0) {
    return failedRun(
      input,
      'Proof DAG Lineage Regression requires a workspace-scoped task with parent and subagent run records',
    );
  }

  const runRows = await db
    .select()
    .from(taskRuns)
    .where(inArray(taskRuns.taskId, taskIds))
    .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id))
    .limit(500);
  const handoffRows = await db
    .select()
    .from(agentHandoffs)
    .where(eq(agentHandoffs.workspaceId, input.workspaceId))
    .orderBy(desc(agentHandoffs.createdAt), desc(agentHandoffs.id))
    .limit(200);
  const packRows = await db
    .select()
    .from(evidencePacks)
    .where(eq(evidencePacks.workspaceId, input.workspaceId))
    .orderBy(desc(evidencePacks.receivedAt), desc(evidencePacks.id))
    .limit(500);
  const evidenceRows = await db
    .select()
    .from(evidenceItems)
    .where(eq(evidenceItems.workspaceId, input.workspaceId))
    .orderBy(desc(evidenceItems.observedAt), desc(evidenceItems.id))
    .limit(500);

  const proof = findSubagentProofDagProof({
    workspaceId: input.workspaceId,
    taskRows,
    runRows,
    handoffRows,
    packRows,
    evidenceRows,
  });
  if (!proof) {
    return failedRun(
      input,
      'Proof DAG Lineage Regression requires parent task_run, subagent spawn task_run, child subagent action row, durable agent_handoff, SUBAGENT_SPAWN evidence, and child receipt evidence linked by parent_evidence_pack_id',
    );
  }

  const spawnEvidenceReference = evidenceRef(proof.spawnEvidence);
  const childEvidenceReference = evidenceRef(proof.childReceiptEvidence);
  const spawnReceiptReference = evidencePackRef(proof.spawnPack);
  const childReceiptReference = evidencePackRef(proof.childReceiptPack);
  const completedAt = new Date().toISOString();

  return {
    run: {
      workspaceId: input.workspaceId,
      evalId: 'proof_dag_lineage',
      status: 'passed',
      capabilityKey: input.capabilityKey ?? 'subagent_lineage',
      runRef: input.runRef ?? `real-external-eval:proof-dag-lineage:${randomUUID()}`,
      summary:
        'Proof DAG Lineage Regression verified parent run, subagent spawn run, child action run, agent handoff, spawn evidence, and child receipt evidence as a durable proof DAG.',
      evidenceRefs: [spawnEvidenceReference, childEvidenceReference],
      auditReceiptRefs: [spawnReceiptReference, childReceiptReference],
      metadata: {
        runnerRef: 'gateway:proof_dag_lineage:v1',
        verifiedTaskId: proof.task.id,
        verifiedParentTaskRunId: proof.parentRun.id,
        verifiedSpawnTaskRunId: proof.spawnRun.id,
        verifiedChildTaskRunId: proof.childRun.id,
        verifiedAgentHandoffId: proof.handoff.id,
        verifiedSpawnEvidencePackId: proof.spawnPack.id,
        verifiedChildEvidencePackId: proof.childReceiptPack.id,
        verifiedEvidenceItemIds: [proof.spawnEvidence.id, proof.childReceiptEvidence.id],
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
      completedAt,
      steps: [
        {
          stepKey: 'parent-subagent-proof-dag',
          status: 'passed',
          evidenceRefs: [spawnEvidenceReference, childEvidenceReference],
          auditReceiptRefs: [spawnReceiptReference, childReceiptReference],
          completedAt,
          metadata: {
            taskId: proof.task.id,
            parentTaskRunId: proof.parentRun.id,
            spawnTaskRunId: proof.spawnRun.id,
            childTaskRunId: proof.childRun.id,
            handoffId: proof.handoff.id,
            spawnDecisionId: proof.spawnPack.decisionId,
            childDecisionId: proof.childReceiptPack.decisionId,
          },
        },
      ],
    },
  };
}

async function executeApprovalResumeIsolationEval(
  db: Db,
  input: TrustedRealExternalEvalInput,
): Promise<{ run: RecordPilotEvalRunInput }> {
  const taskRows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.workspaceId, input.workspaceId))
    .orderBy(desc(tasks.createdAt))
    .limit(100);
  const taskIds = taskRows.map((row) => row.id);
  if (taskIds.length === 0) {
    return failedRun(
      input,
      'Approval Resume Isolation Regression requires a workspace-scoped task with replay history',
    );
  }

  const runRows = await db
    .select()
    .from(taskRuns)
    .where(inArray(taskRuns.taskId, taskIds))
    .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id))
    .limit(500);
  const evidenceRows = await db
    .select()
    .from(evidenceItems)
    .where(eq(evidenceItems.workspaceId, input.workspaceId))
    .orderBy(desc(evidenceItems.observedAt), desc(evidenceItems.id))
    .limit(500);
  const auditRows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.workspaceId, input.workspaceId))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(500);

  const proof = findApprovalResumeIsolationProof({
    taskRows,
    runRows,
    evidenceRows,
    auditRows,
  });
  if (!proof) {
    return failedRun(
      input,
      'Approval Resume Isolation Regression requires deterministic parent-only task_runs, at least one excluded child/subagent row, and audit-linked task_resume_dispatched evidence with matching priorActionCount',
    );
  }

  const evidenceReference = evidenceRef(proof.evidence);
  const auditReference = auditRef(proof.audit);
  const completedAt = new Date().toISOString();
  return {
    run: {
      workspaceId: input.workspaceId,
      evalId: 'approval_resume_isolation',
      status: 'passed',
      capabilityKey: input.capabilityKey ?? 'approval_resume',
      runRef: input.runRef ?? `real-external-eval:approval-resume:${randomUUID()}`,
      summary:
        'Approval Resume Isolation Regression verified deterministic parent-only replay rows, excluded child rows, and audit-linked resume dispatch evidence.',
      evidenceRefs: [evidenceReference],
      auditReceiptRefs: [auditReference],
      metadata: {
        runnerRef: 'gateway:approval_resume_isolation:v1',
        verifiedTaskId: proof.task.id,
        parentReplayTaskRunIds: proof.parentRows.map((row) => row.id),
        excludedChildTaskRunIds: proof.childRows.map((row) => row.id),
        verifiedEvidenceItemId: proof.evidence.id,
        verifiedAuditEventId: proof.audit.id,
        priorActionCount: proof.parentRows.length,
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
      completedAt,
      steps: [
        {
          stepKey: 'deterministic-parent-only-resume',
          status: 'passed',
          evidenceRefs: [evidenceReference],
          auditReceiptRefs: [auditReference],
          completedAt,
          metadata: {
            taskId: proof.task.id,
            priorActionCount: proof.parentRows.length,
            excludedChildRowCount: proof.childRows.length,
            replayOrder: proof.parentRows.map((row) => ({
              taskRunId: row.id,
              runSequence: row.runSequence,
              actionTool: row.actionTool,
            })),
          },
        },
      ],
    },
  };
}

async function executeCrossWorkspaceOperatorRejectionEval(
  db: Db,
  input: TrustedRealExternalEvalInput,
): Promise<{ run: RecordPilotEvalRunInput }> {
  const evidenceRows = await db
    .select()
    .from(evidenceItems)
    .where(eq(evidenceItems.workspaceId, input.workspaceId))
    .orderBy(desc(evidenceItems.observedAt), desc(evidenceItems.id))
    .limit(500);
  const auditRows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.workspaceId, input.workspaceId))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(500);

  const gatewayProof = findOperatorScopeRejectionProof(
    evidenceRows,
    auditRows,
    input.workspaceId,
    'gateway_operator_scope',
  );
  const runtimeProof = findOperatorScopeRejectionProof(
    evidenceRows,
    auditRows,
    input.workspaceId,
    'orchestrator_operator_scope',
  );

  if (!gatewayProof || !runtimeProof) {
    return failedRun(
      input,
      'Cross-Workspace Operator Rejection Regression requires durable gateway ingress and orchestrator runtime rejection evidence with deny audit receipts',
    );
  }

  const completedAt = new Date().toISOString();
  const evidenceRefs = [evidenceRef(gatewayProof.evidence), evidenceRef(runtimeProof.evidence)];
  const auditReceiptRefs = [auditRef(gatewayProof.audit), auditRef(runtimeProof.audit)];
  const requestedOperatorIds = uniqueSorted([
    String((gatewayProof.evidence.metadata as Record<string, unknown>)['requestedOperatorId']),
    String((runtimeProof.evidence.metadata as Record<string, unknown>)['requestedOperatorId']),
  ]);

  return {
    run: {
      workspaceId: input.workspaceId,
      evalId: 'cross_workspace_operator_rejection',
      status: 'passed',
      capabilityKey: input.capabilityKey ?? 'operator_scoping',
      runRef:
        input.runRef ?? `real-external-eval:cross_workspace_operator_rejection:${randomUUID()}`,
      summary:
        'Verified cross-workspace operator IDs are denied at gateway ingress and orchestrator runtime with durable evidence and audit receipts.',
      evidenceRefs,
      auditReceiptRefs,
      metadata: {
        runnerRef: 'gateway:cross_workspace_operator_rejection:v1',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
        verifiedGatewayEvidenceItemId: gatewayProof.evidence.id,
        verifiedGatewayAuditEventId: gatewayProof.audit.id,
        verifiedRuntimeEvidenceItemId: runtimeProof.evidence.id,
        verifiedRuntimeAuditEventId: runtimeProof.audit.id,
        requestedOperatorIds,
      },
      completedAt,
      steps: [
        {
          stepKey: 'gateway-and-runtime-operator-scope-denial',
          status: 'passed',
          evidenceRefs,
          auditReceiptRefs,
          completedAt,
          metadata: {
            gatewaySurface: (gatewayProof.evidence.metadata as Record<string, unknown>)['surface'],
            runtimeSurface: (runtimeProof.evidence.metadata as Record<string, unknown>)['surface'],
            requestedOperatorIds,
          },
        },
      ],
    },
  };
}

async function executeRecoveryEval(
  db: Db,
  input: TrustedRealExternalEvalInput,
): Promise<{ run: RecordPilotEvalRunInput }> {
  const evidenceRows = await db
    .select()
    .from(evidenceItems)
    .where(eq(evidenceItems.workspaceId, input.workspaceId))
    .orderBy(desc(evidenceItems.observedAt), desc(evidenceItems.id))
    .limit(1000);
  const auditRows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.workspaceId, input.workspaceId))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(1000);

  const recoveryPlan = evidenceRows.find((row) => isRecoveryPlanEvidence(row));
  const recoveryPlanAudit = recoveryPlan
    ? auditRows.find((row) => isRecoveryPlanAudit(row, recoveryPlan))
    : undefined;
  const recoveryApply = recoveryPlan
    ? evidenceRows.find((row) => isRecoveryApplyEvidence(row, recoveryPlan))
    : undefined;
  const recoveryApplyAudit = recoveryApply
    ? auditRows.find((row) => isRecoveryApplyAudit(row, recoveryApply))
    : undefined;
  const checkpoint = recoveryApply
    ? evidenceRows.find((row) => isPreRecoveryCheckpointEvidence(row, recoveryApply))
    : undefined;
  const checkpointAudit = checkpoint
    ? auditRows.find((row) => isPreRecoveryCheckpointAudit(row, checkpoint))
    : undefined;

  if (
    !recoveryPlan ||
    !recoveryPlanAudit ||
    !recoveryApply ||
    !recoveryApplyAudit ||
    !checkpoint ||
    !checkpointAudit
  ) {
    return failedRun(
      input,
      'Recovery Eval requires linked recovery plan, pre-recovery checkpoint, and recovery-applied evidence with durable audit receipts',
    );
  }

  const completedAt = new Date().toISOString();
  const evidenceRefs = [
    evidenceRef(recoveryPlan),
    evidenceRef(checkpoint),
    evidenceRef(recoveryApply),
  ];
  const auditReceiptRefs = [
    auditRef(recoveryPlanAudit),
    auditRef(checkpointAudit),
    auditRef(recoveryApplyAudit),
  ];
  const applyMetadata = recoveryApply.metadata as Record<string, unknown>;

  return {
    run: {
      workspaceId: input.workspaceId,
      evalId: 'recovery',
      status: 'passed',
      capabilityKey: input.capabilityKey ?? 'evidence_ledger',
      runRef: input.runRef ?? `real-external-eval:recovery:${randomUUID()}`,
      summary:
        'Verified recovery plan, pre-recovery checkpoint, and safe recovery apply evidence with audit receipts.',
      evidenceRefs,
      auditReceiptRefs,
      metadata: {
        runnerRef: 'gateway:recovery:v1',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
        verifiedMissionId: recoveryApply.missionId ?? recoveryPlan.missionId,
        verifiedRecoveryPlanEvidenceItemId: recoveryPlan.id,
        verifiedCheckpointEvidenceItemId: checkpoint.id,
        verifiedRecoveryApplyEvidenceItemId: recoveryApply.id,
        recoveredNodeKeys: applyMetadata['recoveredNodeKeys'],
      },
      completedAt,
      steps: [
        {
          stepKey: 'checkpointed-safe-recovery-apply',
          status: 'passed',
          evidenceRefs,
          auditReceiptRefs,
          completedAt,
          metadata: {
            recoveryPlanReplayRef: recoveryPlan.replayRef,
            checkpointReplayRef: checkpoint.replayRef,
            recoveryApplyReplayRef: recoveryApply.replayRef,
            recoveredNodeKeys: applyMetadata['recoveredNodeKeys'],
          },
        },
      ],
    },
  };
}

async function executeMultiAgentParallelBuildEval(
  db: Db,
  input: TrustedRealExternalEvalInput,
): Promise<{ run: RecordPilotEvalRunInput }> {
  const threadRows = await db
    .select()
    .from(a2aThreads)
    .where(eq(a2aThreads.workspaceId, input.workspaceId))
    .orderBy(desc(a2aThreads.updatedAt), desc(a2aThreads.id))
    .limit(100);
  const taskRows = await db
    .select()
    .from(tasks)
    .where(eq(tasks.workspaceId, input.workspaceId))
    .orderBy(desc(tasks.createdAt))
    .limit(100);
  const taskIds = taskRows.map((row) => row.id);
  if (threadRows.length === 0 || taskIds.length === 0) {
    return failedRun(
      input,
      'Multi-Agent Parallel Build Eval requires durable A2A thread state linked to a workspace task',
    );
  }

  const messageRows = await db
    .select()
    .from(a2aMessages)
    .where(eq(a2aMessages.workspaceId, input.workspaceId))
    .orderBy(desc(a2aMessages.createdAt), desc(a2aMessages.sequence), desc(a2aMessages.id))
    .limit(1000);
  const runRows = await db
    .select()
    .from(taskRuns)
    .where(inArray(taskRuns.taskId, taskIds))
    .orderBy(desc(taskRuns.startedAt), desc(taskRuns.id))
    .limit(1000);
  const handoffRows = await db
    .select()
    .from(agentHandoffs)
    .where(eq(agentHandoffs.workspaceId, input.workspaceId))
    .orderBy(desc(agentHandoffs.createdAt), desc(agentHandoffs.id))
    .limit(500);
  const executionRows = await db
    .select()
    .from(toolExecutions)
    .where(eq(toolExecutions.workspaceId, input.workspaceId))
    .orderBy(desc(toolExecutions.completedAt), desc(toolExecutions.id))
    .limit(1000);
  const evidenceRows = await db
    .select()
    .from(evidenceItems)
    .where(eq(evidenceItems.workspaceId, input.workspaceId))
    .orderBy(desc(evidenceItems.observedAt), desc(evidenceItems.id))
    .limit(1000);
  const auditRows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.workspaceId, input.workspaceId))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(1000);

  const proof = findMultiAgentParallelBuildProof({
    workspaceId: input.workspaceId,
    threadRows,
    messageRows,
    taskRows,
    runRows,
    handoffRows,
    executionRows,
    evidenceRows,
    auditRows,
  });
  if (!proof) {
    return failedRun(
      input,
      'Multi-Agent Parallel Build Eval requires a completed restart-verified A2A thread, ordered durable messages, dispatch evidence/audit, at least two completed agent handoffs, completed child runs, and brokered tool evidence/audit including artifact diffs',
    );
  }

  const evidenceRefs = [
    evidenceRef(proof.dispatchEvidence),
    ...proof.toolProofs.map((item) => evidenceRef(item.evidence)),
  ];
  const auditReceiptRefs = [
    auditRef(proof.dispatchAudit),
    ...proof.toolProofs.map((item) => auditRef(item.audit)),
  ];
  const completedAt = new Date().toISOString();
  const agentNames = uniqueSorted(proof.handoffs.map((row) => row.toAgent));

  return {
    run: {
      workspaceId: input.workspaceId,
      evalId: 'multi_agent_parallel_build',
      status: 'passed',
      capabilityKey: input.capabilityKey ?? 'a2a_durable_state',
      runRef: input.runRef ?? `real-external-eval:multi-agent-parallel-build:${randomUUID()}`,
      summary:
        'Multi-Agent Parallel Build Eval verified restart-marked A2A state, durable message replay, multiple completed handoffs, child runs, and brokered tool evidence with audit receipts.',
      evidenceRefs,
      auditReceiptRefs,
      metadata: {
        runnerRef: 'gateway:multi_agent_parallel_build:v1',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
        verifiedA2aThreadId: proof.thread.id,
        verifiedExternalTaskId: proof.thread.externalTaskId,
        verifiedPilotTaskId: proof.task.id,
        verifiedMessageSequences: proof.messages.map((row) => row.sequence),
        verifiedAgentHandoffIds: proof.handoffs.map((row) => row.id),
        verifiedChildTaskRunIds: proof.childRuns.map((row) => row.id),
        verifiedToolExecutionIds: proof.toolProofs.map((item) => item.execution.id),
        verifiedEvidenceItemIds: [
          proof.dispatchEvidence.id,
          ...proof.toolProofs.map((item) => item.evidence.id),
        ],
        verifiedAuditEventIds: [
          proof.dispatchAudit.id,
          ...proof.toolProofs.map((item) => item.audit.id),
        ],
        agentNames,
      },
      completedAt,
      steps: [
        {
          stepKey: 'durable-a2a-restart-replay',
          status: 'passed',
          evidenceRefs: [evidenceRef(proof.dispatchEvidence)],
          auditReceiptRefs: [auditRef(proof.dispatchAudit)],
          completedAt,
          metadata: {
            a2aThreadId: proof.thread.id,
            externalTaskId: proof.thread.externalTaskId,
            pilotTaskId: proof.task.id,
            messageSequences: proof.messages.map((row) => row.sequence),
          },
        },
        {
          stepKey: 'parallel-agent-tool-evidence',
          status: 'passed',
          evidenceRefs: proof.toolProofs.map((item) => evidenceRef(item.evidence)),
          auditReceiptRefs: proof.toolProofs.map((item) => auditRef(item.audit)),
          completedAt,
          metadata: {
            handoffIds: proof.handoffs.map((row) => row.id),
            childTaskRunIds: proof.childRuns.map((row) => row.id),
            toolExecutionIds: proof.toolProofs.map((item) => item.execution.id),
            agentNames,
          },
        },
      ],
    },
  };
}

async function executeCommandCenterRealStateUxEval(
  db: Db,
  input: TrustedRealExternalEvalInput,
): Promise<{ run: RecordPilotEvalRunInput }> {
  const evidenceRows = await db
    .select()
    .from(evidenceItems)
    .where(eq(evidenceItems.workspaceId, input.workspaceId))
    .orderBy(desc(evidenceItems.observedAt), desc(evidenceItems.id))
    .limit(1000);
  const auditRows = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.workspaceId, input.workspaceId))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(1000);

  const evidence = evidenceRows.find((row) => isCommandCenterRealStateUxEvidence(row));
  const audit = evidence
    ? auditRows.find((row) => isCommandCenterRealStateUxAudit(row, evidence))
    : undefined;

  if (!evidence || !audit) {
    return failedRun(
      input,
      'Command Center Real-State UX Eval requires durable command-center API fixture, UI screenshot, accessibility report, non-production capability labels, replay evidence, and a linked audit receipt',
    );
  }

  const metadata = evidence.metadata as Record<string, unknown>;
  const evidenceReference = evidenceRef(evidence);
  const auditReference = auditRef(audit);
  const completedAt = new Date().toISOString();

  return {
    run: {
      workspaceId: input.workspaceId,
      evalId: 'command_center_real_state_ux',
      status: 'passed',
      capabilityKey: input.capabilityKey ?? 'command_center',
      runRef: input.runRef ?? `real-external-eval:command-center-real-state-ux:${randomUUID()}`,
      summary:
        'Verified command-center real-state UX evidence for durable API state, screenshot proof, accessibility report, non-production labels, replay surfaces, and linked audit receipt.',
      evidenceRefs: [evidenceReference],
      auditReceiptRefs: [auditReference],
      metadata: {
        runnerRef: 'gateway:command_center_real_state_ux:v1',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
        verifiedEvidenceItemId: evidence.id,
        verifiedAuditEventId: audit.id,
        apiResponseFixtureRef: metadata['apiResponseFixtureRef'],
        uiScreenshotRef: metadata['uiScreenshotRef'],
        accessibilityReportRef: metadata['accessibilityReportRef'],
        durableStateSurfaces: metadata['durableStateSurfaces'],
        capabilityStatesRendered: metadata['capabilityStatesRendered'],
      },
      completedAt,
      steps: [
        {
          stepKey: 'durable-command-center-api-fixture',
          status: 'passed',
          evidenceRefs: [evidenceReference],
          auditReceiptRefs: [auditReference],
          completedAt,
          metadata: {
            apiResponseFixtureRef: metadata['apiResponseFixtureRef'],
            apiResponseFixtureHash: metadata['apiResponseFixtureHash'],
            durableStateSurfaces: metadata['durableStateSurfaces'],
          },
        },
        {
          stepKey: 'ui-screenshot-and-replay-surfaces',
          status: 'passed',
          evidenceRefs: [evidenceReference],
          auditReceiptRefs: [auditReference],
          completedAt,
          metadata: {
            uiScreenshotRef: metadata['uiScreenshotRef'],
            uiScreenshotHash: metadata['uiScreenshotHash'],
            replayRef: evidence.replayRef,
          },
        },
        {
          stepKey: 'accessibility-and-claim-control',
          status: 'passed',
          evidenceRefs: [evidenceReference],
          auditReceiptRefs: [auditReference],
          completedAt,
          metadata: {
            accessibilityReportRef: metadata['accessibilityReportRef'],
            accessibilityReportHash: metadata['accessibilityReportHash'],
            capabilityStatesRendered: metadata['capabilityStatesRendered'],
            routeLocalMockState: metadata['routeLocalMockState'],
            productionReadyClaims: metadata['productionReadyClaims'],
          },
        },
      ],
    },
  };
}

async function executePmfDiscoveryEval(
  db: Db,
  input: TrustedRealExternalEvalInput,
): Promise<{ run: RecordPilotEvalRunInput }> {
  if (input.capabilityKey && input.capabilityKey !== 'opportunity_scoring') {
    return failedRun(
      input,
      'PMF Discovery real eval runner currently verifies the opportunity_scoring slice only; startup_lifecycle still requires Full Startup Launch Eval coverage',
    );
  }

  const opportunityRows = await db
    .select()
    .from(opportunities)
    .where(eq(opportunities.workspaceId, input.workspaceId))
    .orderBy(desc(opportunities.createdAt))
    .limit(100);

  const opportunityById = new Map(
    opportunityRows
      .filter((row) => row.workspaceId === input.workspaceId)
      .map((row) => [row.id, row]),
  );
  if (opportunityById.size === 0) {
    return failedRun(
      input,
      'PMF Discovery Eval requires a workspace-scoped opportunity candidate before scoring can be verified',
    );
  }

  const scoreRows = await db
    .select()
    .from(opportunityScores)
    .where(inArray(opportunityScores.opportunityId, [...opportunityById.keys()]))
    .orderBy(desc(opportunityScores.scoredAt))
    .limit(100);
  const score = scoreRows.find((row) =>
    isProductionPmfOpportunityScore(row, opportunityById.get(row.opportunityId)),
  );
  if (!score) {
    return failedRun(
      input,
      'PMF Discovery Eval requires a non-heuristic, policy-pinned opportunity_scores row with 0-100 score dimensions for a scored workspace opportunity',
    );
  }

  const executionRows = await db
    .select()
    .from(toolExecutions)
    .where(
      and(
        eq(toolExecutions.workspaceId, input.workspaceId),
        eq(toolExecutions.toolKey, 'score_opportunity'),
      ),
    )
    .orderBy(desc(toolExecutions.completedAt))
    .limit(100);
  const execution = executionRows.find((row) =>
    isProductionPmfScoreToolExecution(row, score.opportunityId),
  );
  if (!execution) {
    return failedRun(
      input,
      `PMF Discovery Eval requires a completed Tool Broker score_opportunity execution with citations, assumptions, scorecard output, evidence ids, and policy pins for opportunity ${score.opportunityId}`,
    );
  }

  const evidenceRows = await db
    .select()
    .from(evidenceItems)
    .where(
      and(
        eq(evidenceItems.workspaceId, input.workspaceId),
        eq(evidenceItems.toolExecutionId, execution.id),
      ),
    )
    .orderBy(desc(evidenceItems.observedAt))
    .limit(25);
  const evidence = evidenceRows.find((row) => isPmfToolExecutionEvidence(row, execution));
  if (!evidence) {
    return failedRun(
      input,
      `score_opportunity tool execution ${execution.id} has no linked tool_execution_completed evidence_items row`,
    );
  }
  if (!evidence.auditEventId) {
    return failedRun(input, `score_opportunity evidence ${evidence.id} is missing audit_event_id`);
  }

  const audits = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, input.workspaceId), eq(auditLog.id, evidence.auditEventId)))
    .limit(1);
  const audit = audits.find((row) => isPmfToolExecutionAudit(row, evidence, execution));
  if (!audit) {
    return failedRun(
      input,
      `score_opportunity evidence ${evidence.id} has no matching TOOL_EXECUTION audit row`,
    );
  }

  const output = execution.sanitizedOutput as Record<string, unknown>;
  const evidenceReference = evidenceRef(evidence);
  const auditReference = auditRef(audit);
  const completedAt = new Date().toISOString();
  return {
    run: {
      workspaceId: input.workspaceId,
      evalId: 'pmf_discovery',
      status: 'passed',
      capabilityKey: 'opportunity_scoring',
      runRef: input.runRef ?? `real-external-eval:pmf-discovery:${randomUUID()}`,
      summary:
        'PMF Discovery opportunity-scoring eval verified a scored workspace opportunity, non-heuristic policy-pinned score row, brokered score_opportunity execution, citations, assumptions, evidence, and audit ledger entry.',
      evidenceRefs: [evidenceReference],
      auditReceiptRefs: [auditReference],
      metadata: {
        runnerRef: 'gateway:pmf_discovery:opportunity_scoring:v1',
        verifiedOpportunityId: score.opportunityId,
        verifiedScoreId: score.id,
        verifiedToolExecutionId: execution.id,
        verifiedEvidenceItemId: evidence.id,
        verifiedAuditEventId: audit.id,
        scoreOverall: score.overallScore,
        scoringMethod: score.scoringMethod,
        citationCount: getArrayLength(output, 'citations'),
        assumptionCount: getArrayLength(output, 'assumptions'),
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
      completedAt,
      steps: [
        {
          stepKey: 'evidence-backed-opportunity-score',
          status: 'passed',
          evidenceRefs: [evidenceReference],
          auditReceiptRefs: [auditReference],
          completedAt,
          metadata: pmfDiscoveryStepMetadata(score, execution),
        },
      ],
    },
  };
}

async function executeHelmGovernanceEval(
  db: Db,
  input: TrustedRealExternalEvalInput,
): Promise<{ run: RecordPilotEvalRunInput }> {
  const packs = await db
    .select()
    .from(evidencePacks)
    .where(eq(evidencePacks.workspaceId, input.workspaceId))
    .orderBy(desc(evidencePacks.receivedAt))
    .limit(200);

  const allowed = packs.find(isAllowedHelmReceiptPack);
  const deniedOrEscalated = packs.find(isDeniedOrEscalatedHelmReceiptPack);
  if (!allowed) {
    return failedRun(
      input,
      'HELM Governance Eval requires a durable ALLOW HELM receipt with policy version, decision hash, and workspace principal',
    );
  }
  if (!deniedOrEscalated) {
    return failedRun(
      input,
      'HELM Governance Eval requires a durable DENY or ESCALATE HELM receipt for restricted/high-risk behavior',
    );
  }

  const receiptPacks = [allowed, deniedOrEscalated];
  const evidenceRows = await db
    .select()
    .from(evidenceItems)
    .where(
      and(
        eq(evidenceItems.workspaceId, input.workspaceId),
        inArray(
          evidenceItems.evidencePackId,
          receiptPacks.map((pack) => pack.id),
        ),
      ),
    )
    .orderBy(desc(evidenceItems.observedAt))
    .limit(50);

  const allowedEvidence = findHelmReceiptEvidence(evidenceRows, allowed);
  const deniedEvidence = findHelmReceiptEvidence(evidenceRows, deniedOrEscalated);
  if (!allowedEvidence) {
    return failedRun(
      input,
      `Allowed HELM receipt ${allowed.decisionId} has no audit-linked helm_receipt evidence_items row`,
    );
  }
  if (!deniedEvidence) {
    return failedRun(
      input,
      `Restricted HELM receipt ${deniedOrEscalated.decisionId} has no audit-linked helm_receipt evidence_items row`,
    );
  }

  const auditIds = [allowedEvidence.auditEventId, deniedEvidence.auditEventId].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
  if (auditIds.length < 2) {
    return failedRun(
      input,
      'HELM Governance Eval requires audit-linked evidence for both receipt outcomes',
    );
  }

  const audits = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, input.workspaceId), inArray(auditLog.id, auditIds)))
    .limit(auditIds.length);
  const allowedAudit = findHelmReceiptAudit(audits, allowedEvidence.auditEventId, allowed);
  const deniedAudit = findHelmReceiptAudit(audits, deniedEvidence.auditEventId, deniedOrEscalated);
  if (!allowedAudit) {
    return failedRun(
      input,
      `Allowed HELM receipt evidence ${allowedEvidence.id} has no matching HELM_RECEIPT_PERSISTED audit row`,
    );
  }
  if (!deniedAudit) {
    return failedRun(
      input,
      `Restricted HELM receipt evidence ${deniedEvidence.id} has no matching HELM_RECEIPT_PERSISTED audit row`,
    );
  }

  const allowedEvidenceRef = evidenceRef(allowedEvidence);
  const deniedEvidenceRef = evidenceRef(deniedEvidence);
  const allowedAuditRef = auditRef(allowedAudit);
  const deniedAuditRef = auditRef(deniedAudit);
  const completedAt = new Date().toISOString();
  return {
    run: {
      workspaceId: input.workspaceId,
      evalId: 'helm_governance',
      status: 'passed',
      capabilityKey: input.capabilityKey ?? 'helm_receipts',
      runRef: input.runRef ?? `real-external-eval:helm-governance:${randomUUID()}`,
      summary:
        'HELM governance eval verified durable allowed and restricted receipt outcomes with receipt sink rows, linked evidence, and audit ledger entries.',
      evidenceRefs: [allowedEvidenceRef, deniedEvidenceRef],
      auditReceiptRefs: [allowedAuditRef, deniedAuditRef],
      metadata: {
        runnerRef: 'gateway:helm_governance:v1',
        verifiedEvidencePackIds: receiptPacks.map((pack) => pack.id),
        verifiedDecisionIds: receiptPacks.map((pack) => pack.decisionId),
        verifiedEvidenceItemIds: [allowedEvidence.id, deniedEvidence.id],
        verifiedAuditEventIds: [allowedAudit.id, deniedAudit.id],
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
      completedAt,
      steps: [
        {
          stepKey: 'allowed-helm-receipt-evidence',
          status: 'passed',
          evidenceRefs: [allowedEvidenceRef],
          auditReceiptRefs: [allowedAuditRef],
          completedAt,
          metadata: helmReceiptStepMetadata(allowed),
        },
        {
          stepKey: 'restricted-helm-receipt-evidence',
          status: 'passed',
          evidenceRefs: [deniedEvidenceRef],
          auditReceiptRefs: [deniedAuditRef],
          completedAt,
          metadata: helmReceiptStepMetadata(deniedOrEscalated),
        },
      ],
    },
  };
}

async function executeDecisionCourtGovernedModelEval(
  db: Db,
  input: TrustedRealExternalEvalInput,
): Promise<{ run: RecordPilotEvalRunInput }> {
  const evidenceRows = await db
    .select()
    .from(evidenceItems)
    .where(
      and(
        eq(evidenceItems.workspaceId, input.workspaceId),
        eq(evidenceItems.evidenceType, 'decision_court_run'),
      ),
    )
    .orderBy(desc(evidenceItems.observedAt))
    .limit(50);

  const evidence = evidenceRows.find((row) =>
    isGovernedDecisionCourtEvidence(row, input.workspaceId),
  );
  if (!evidence) {
    return failedRun(
      input,
      'Decision Court Governed Model Eval requires redacted decision_court_run evidence from a completed governed_llm_court run with model-call metadata',
    );
  }
  if (!evidence.auditEventId) {
    return failedRun(
      input,
      `Decision Court evidence ${evidence.id} is missing an audit_event_id link`,
    );
  }

  const audits = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, input.workspaceId), eq(auditLog.id, evidence.auditEventId)))
    .limit(1);
  const audit = audits.find((row) =>
    isGovernedDecisionCourtAudit(row, evidence, input.workspaceId),
  );
  if (!audit) {
    return failedRun(
      input,
      `Decision Court evidence ${evidence.id} has no matching DECISION_COURT_RUN audit row`,
    );
  }

  const metadata = evidence.metadata as Record<string, unknown>;
  const evidenceReference = evidenceRef(evidence);
  const auditReference = auditRef(audit);
  const completedAt = new Date().toISOString();
  return {
    run: {
      workspaceId: input.workspaceId,
      evalId: 'decision_court_governed_model',
      status: 'passed',
      capabilityKey: input.capabilityKey ?? 'decision_court',
      runRef: input.runRef ?? `real-external-eval:decision-court:${randomUUID()}`,
      summary:
        'Decision Court governed model eval verified a completed governed_llm_court run with bull, bear, and referee model calls, HELM receipts, costs, final recommendation, linked evidence, and audit ledger entry.',
      evidenceRefs: [evidenceReference],
      auditReceiptRefs: [auditReference],
      metadata: {
        runnerRef: 'gateway:decision_court_governed_model:v1',
        verifiedEvidenceItemId: evidence.id,
        verifiedAuditEventId: audit.id,
        verifiedPolicyDecisionIds: getStringArray(metadata, 'policyDecisionIds'),
        verifiedPolicyVersions: getStringArray(metadata, 'policyVersions'),
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
      completedAt,
      steps: [
        {
          stepKey: 'governed-court-run-evidence',
          status: 'passed',
          evidenceRefs: [evidenceReference],
          auditReceiptRefs: [auditReference],
          completedAt,
          metadata: decisionCourtStepMetadata(metadata),
        },
      ],
    },
  };
}

async function executeYcLoggedInBrowserExtractionEval(
  db: Db,
  input: TrustedRealExternalEvalInput,
): Promise<{ run: RecordPilotEvalRunInput }> {
  const rows = await db
    .select()
    .from(browserObservations)
    .where(eq(browserObservations.workspaceId, input.workspaceId))
    .orderBy(desc(browserObservations.observedAt))
    .limit(100);

  const observation = rows.find(isYcLoggedInBrowserObservation);
  if (!observation) {
    return failedRun(
      input,
      'YC Logged-In Browser Extraction Eval requires a durable YC browser observation with DOM hash, screenshot reference, extracted fields, redacted DOM, and replay metadata',
    );
  }

  const evidenceRows = await db
    .select()
    .from(evidenceItems)
    .where(
      and(
        eq(evidenceItems.workspaceId, input.workspaceId),
        eq(evidenceItems.browserObservationId, observation.id),
      ),
    )
    .orderBy(desc(evidenceItems.observedAt))
    .limit(10);

  const evidence = evidenceRows.find(findBrowserEvidence);
  if (!evidence) {
    return failedRun(
      input,
      `YC browser observation ${observation.id} has no linked browser_observation evidence_items row`,
    );
  }
  if (!evidence.auditEventId) {
    return failedRun(
      input,
      `YC browser observation evidence ${evidence.id} is missing an audit_event_id link`,
    );
  }

  const audits = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, input.workspaceId), eq(auditLog.id, evidence.auditEventId)))
    .limit(1);
  const audit = audits.find(
    (row) =>
      row.id === evidence.auditEventId &&
      row.action === 'BROWSER_OBSERVATION_CAPTURED' &&
      row.target === observation.id &&
      row.verdict === 'allow' &&
      hasMetadataString(row.metadata, 'helmDecisionId') &&
      hasMetadataString(row.metadata, 'helmPolicyVersion'),
  );
  if (!audit) {
    return failedRun(
      input,
      `YC browser observation evidence ${evidence.id} has no matching BROWSER_OBSERVATION_CAPTURED audit row`,
    );
  }

  const evidenceReference = evidenceRef(evidence);
  const auditReference = auditRef(audit);
  const completedAt = new Date().toISOString();
  return {
    run: {
      workspaceId: input.workspaceId,
      evalId: 'yc_logged_in_browser_extraction',
      status: 'passed',
      capabilityKey: input.capabilityKey ?? 'browser_execution',
      runRef: input.runRef ?? `real-external-eval:yc-browser:${randomUUID()}`,
      summary:
        'YC browser eval verified a durable logged-in read/extract observation with redacted DOM, DOM hash, screenshot metadata, extracted fields, replay reference, evidence, and audit receipt.',
      evidenceRefs: [evidenceReference],
      auditReceiptRefs: [auditReference],
      metadata: {
        runnerRef: 'gateway:yc_logged_in_browser_extraction:v1',
        verifiedBrowserObservationId: observation.id,
        verifiedEvidenceItemId: evidence.id,
        verifiedAuditEventId: audit.id,
        origin: observation.origin,
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
      completedAt,
      steps: [
        {
          stepKey: 'yc-browser-read-extract-evidence',
          status: 'passed',
          evidenceRefs: [evidenceReference],
          auditReceiptRefs: [auditReference],
          completedAt,
          metadata: {
            browserObservationId: observation.id,
            sessionId: observation.sessionId,
            grantId: observation.grantId,
            domHash: observation.domHash,
            screenshotHash: observation.screenshotHash,
            screenshotRef: observation.screenshotRef,
            redactionCount: observation.redactions.length,
          },
        },
      ],
    },
  };
}

async function executeSafeComputerSandboxEval(
  db: Db,
  input: TrustedRealExternalEvalInput,
): Promise<{ run: RecordPilotEvalRunInput }> {
  const rows = await db
    .select()
    .from(computerActions)
    .where(
      and(
        eq(computerActions.workspaceId, input.workspaceId),
        inArray(computerActions.status, ['completed', 'denied']),
      ),
    )
    .orderBy(desc(computerActions.createdAt))
    .limit(100);

  const completed = rows.find(isCompletedSafeComputerAction);
  const denied = rows.find(isDeniedRestrictedComputerAction);
  if (!completed) {
    return failedRun(
      input,
      'Safe Computer/Sandbox Action Eval requires a completed safe computer action with policy metadata, output hash, and completion timestamp',
    );
  }
  if (!denied) {
    return failedRun(
      input,
      'Safe Computer/Sandbox Action Eval requires a denied restricted-path or destructive computer action with policy metadata',
    );
  }

  const actionIds = [completed.id, denied.id];
  const evidenceRows = await db
    .select()
    .from(evidenceItems)
    .where(
      and(
        eq(evidenceItems.workspaceId, input.workspaceId),
        inArray(evidenceItems.computerActionId, actionIds),
      ),
    )
    .orderBy(desc(evidenceItems.observedAt))
    .limit(25);

  const completedEvidence = findComputerEvidence(evidenceRows, completed.id);
  const deniedEvidence = findComputerEvidence(evidenceRows, denied.id);
  if (!completedEvidence) {
    return failedRun(
      input,
      `Completed computer action ${completed.id} has no linked evidence_items row`,
    );
  }
  if (!deniedEvidence) {
    return failedRun(input, `Denied computer action ${denied.id} has no linked evidence_items row`);
  }

  const auditIds = [completedEvidence.auditEventId, deniedEvidence.auditEventId].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
  if (auditIds.length < 2) {
    return {
      run: failedRun(
        input,
        'Safe Computer/Sandbox Action Eval requires audit-linked evidence for completed and denied computer actions',
      ).run,
    };
  }

  const audits = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, input.workspaceId), inArray(auditLog.id, auditIds)))
    .limit(auditIds.length);
  const completedAudit = findComputerAudit(audits, completedEvidence.auditEventId);
  const deniedAudit = findComputerAudit(audits, deniedEvidence.auditEventId);
  if (!completedAudit) {
    return failedRun(
      input,
      `Completed computer action evidence ${completedEvidence.id} has no matching audit row`,
    );
  }
  if (!deniedAudit) {
    return failedRun(
      input,
      `Denied computer action evidence ${deniedEvidence.id} has no matching audit row`,
    );
  }

  const completedEvidenceRef = evidenceRef(completedEvidence);
  const deniedEvidenceRef = evidenceRef(deniedEvidence);
  const completedAuditRef = auditRef(completedAudit);
  const deniedAuditRef = auditRef(deniedAudit);
  const completedAt = new Date().toISOString();

  return {
    run: {
      workspaceId: input.workspaceId,
      evalId: 'safe_computer_sandbox_action',
      status: 'passed',
      capabilityKey: input.capabilityKey ?? 'computer_use',
      runRef: input.runRef ?? `real-external-eval:safe-computer:${randomUUID()}`,
      summary:
        'Safe computer eval verified completed safe action evidence and restricted-action denial evidence from durable computer_actions, evidence_items, and audit_log rows.',
      evidenceRefs: [completedEvidenceRef, deniedEvidenceRef],
      auditReceiptRefs: [completedAuditRef, deniedAuditRef],
      metadata: {
        runnerRef: 'gateway:safe_computer_sandbox_action:v1',
        verifiedComputerActionIds: actionIds,
        verifiedEvidenceItemIds: [completedEvidence.id, deniedEvidence.id],
        verifiedAuditEventIds: [completedAudit.id, deniedAudit.id],
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
      completedAt,
      steps: [
        {
          stepKey: 'completed-safe-action-evidence',
          status: 'passed',
          evidenceRefs: [completedEvidenceRef],
          auditReceiptRefs: [completedAuditRef],
          completedAt,
          metadata: {
            computerActionId: completed.id,
            actionType: completed.actionType,
            environment: completed.environment,
          },
        },
        {
          stepKey: 'restricted-action-denial-evidence',
          status: 'passed',
          evidenceRefs: [deniedEvidenceRef],
          auditReceiptRefs: [deniedAuditRef],
          completedAt,
          metadata: {
            computerActionId: denied.id,
            actionType: denied.actionType,
            environment: denied.environment,
          },
        },
      ],
    },
  };
}

function findSkillInvocationGovernanceProof(params: {
  taskRows: TaskRow[];
  runRows: TaskRunRow[];
  handoffRows: AgentHandoffRow[];
  executionRows: ToolExecutionRow[];
}):
  | {
      task: TaskRow;
      run: TaskRunRow;
      handoff: AgentHandoffRow;
      execution: ToolExecutionRow;
      skill: SkillInvocationProof;
    }
  | undefined {
  for (const task of params.taskRows) {
    const taskRunRows = params.runRows.filter((row) => row.taskId === task.id);
    for (const execution of params.executionRows) {
      if (!isProductionSkillToolExecution(execution)) continue;
      const skill = extractSkillInvocationProof(execution.sanitizedOutput);
      if (!skill) continue;
      const run = taskRunRows.find(
        (row) =>
          row.id === execution.taskRunId &&
          row.lineageKind === 'subagent_spawn' &&
          row.parentTaskRunId !== null &&
          typeof row.operatorRole === 'string' &&
          row.operatorRole.length > 0 &&
          hasBrokeredSkillInvocation(row.skillInvocations, execution, skill),
      );
      if (!run) continue;
      const handoff = params.handoffRows.find(
        (row) =>
          row.taskId === task.id &&
          row.childTaskRunId === run.id &&
          row.handoffKind === 'subagent_spawn' &&
          hasBrokeredSkillInvocation(row.skillInvocations, execution, skill),
      );
      if (!handoff) continue;
      return { task, run, handoff, execution, skill };
    }
  }
  return undefined;
}

function findSubagentProofDagProof(params: {
  workspaceId: string;
  taskRows: TaskRow[];
  runRows: TaskRunRow[];
  handoffRows: AgentHandoffRow[];
  packRows: EvidencePackRow[];
  evidenceRows: EvidenceItemRow[];
}):
  | {
      task: TaskRow;
      parentRun: TaskRunRow;
      spawnRun: TaskRunRow;
      childRun: TaskRunRow;
      handoff: AgentHandoffRow;
      spawnPack: EvidencePackRow;
      childReceiptPack: EvidencePackRow;
      spawnEvidence: EvidenceItemRow;
      childReceiptEvidence: EvidenceItemRow;
    }
  | undefined {
  for (const task of params.taskRows) {
    const taskRunRows = params.runRows.filter((row) => row.taskId === task.id);
    const parentRuns = taskRunRows.filter(isParentReplayRun);
    for (const parentRun of parentRuns) {
      const spawnRun = taskRunRows.find((row) => isSubagentSpawnRun(row, parentRun.id));
      if (!spawnRun) continue;
      const childRun = taskRunRows.find((row) =>
        isSubagentChildActionRun(row, parentRun.id, spawnRun.id),
      );
      if (!childRun) continue;
      const handoff = params.handoffRows.find(
        (row) =>
          row.workspaceId === params.workspaceId &&
          row.taskId === task.id &&
          row.parentTaskRunId === parentRun.id &&
          row.childTaskRunId === spawnRun.id &&
          row.handoffKind === 'subagent_spawn',
      );
      if (!handoff) continue;
      const spawnPack = params.packRows.find((row) => isSubagentSpawnEvidencePack(row, spawnRun));
      if (!spawnPack) continue;
      const spawnEvidence = params.evidenceRows.find((row) =>
        isSubagentSpawnEvidenceItem(row, spawnPack),
      );
      if (!spawnEvidence) continue;
      const childReceiptPack = params.packRows.find((row) =>
        isChildReceiptEvidencePack(row, childRun, spawnPack),
      );
      if (!childReceiptPack) continue;
      const childReceiptEvidence = params.evidenceRows.find((row) =>
        isChildReceiptEvidenceItem(row, childRun, childReceiptPack),
      );
      if (!childReceiptEvidence) continue;

      return {
        task,
        parentRun,
        spawnRun,
        childRun,
        handoff,
        spawnPack,
        childReceiptPack,
        spawnEvidence,
        childReceiptEvidence,
      };
    }
  }
  return undefined;
}

function findApprovalResumeIsolationProof(params: {
  taskRows: TaskRow[];
  runRows: TaskRunRow[];
  evidenceRows: EvidenceItemRow[];
  auditRows: AuditRow[];
}):
  | {
      task: TaskRow;
      parentRows: TaskRunRow[];
      childRows: TaskRunRow[];
      evidence: EvidenceItemRow;
      audit: AuditRow;
    }
  | undefined {
  for (const task of params.taskRows) {
    const taskRunRows = params.runRows.filter((row) => row.taskId === task.id);
    const parentRows = taskRunRows.filter(isParentReplayRun).sort(compareTaskRunReplayOrder);
    const childRows = taskRunRows.filter((row) => !isParentReplayRun(row));
    if (parentRows.length < 2 || childRows.length === 0) continue;
    if (!isDeterministicReplayOrder(parentRows)) continue;

    const evidence = params.evidenceRows.find((row) =>
      isTaskResumeDispatchEvidence(row, task.id, parentRows.length),
    );
    if (!evidence || !evidence.auditEventId) continue;
    const audit = params.auditRows.find((row) =>
      isTaskResumeDispatchAudit(row, evidence, task.id, parentRows.length),
    );
    if (!audit) continue;
    return { task, parentRows, childRows, evidence, audit };
  }
  return undefined;
}

type SkillInvocationProof = {
  name: string;
  version: string;
  riskProfile: string;
  permissionRequirements: string[];
  evalStatus: string;
  declaredTools: string[];
  sourcePath: string;
  instructionHash: string;
};

function isProductionSkillToolExecution(row: ToolExecutionRow): boolean {
  return Boolean(
    row.toolKey === 'skill.invoke' &&
    row.status === 'completed' &&
    row.completedAt &&
    row.outputHash &&
    row.actionId &&
    row.taskRunId &&
    row.idempotencyKey &&
    Array.isArray(row.evidenceIds) &&
    row.evidenceIds.length > 0 &&
    hasPolicyPin(row.policyDecisionId, row.policyVersion, row.helmDocumentVersionPins) &&
    extractSkillInvocationProof(row.sanitizedOutput),
  );
}

function extractSkillInvocationProof(value: unknown): SkillInvocationProof | undefined {
  if (!isRecord(value)) return undefined;
  const skill = value['skill'];
  if (!isRecord(skill)) return undefined;
  const permissionRequirements = getStringArray(skill, 'permissionRequirements');
  const declaredTools = getStringArray(skill, 'declaredTools');
  const name = typeof skill['name'] === 'string' ? skill['name'] : '';
  const version = typeof skill['version'] === 'string' ? skill['version'] : '';
  const riskProfile = typeof skill['riskProfile'] === 'string' ? skill['riskProfile'] : '';
  const evalStatus = typeof skill['evalStatus'] === 'string' ? skill['evalStatus'] : '';
  const sourcePath = typeof skill['sourcePath'] === 'string' ? skill['sourcePath'] : '';
  const instructionHash =
    typeof value['instructionHash'] === 'string' ? value['instructionHash'] : '';
  if (
    !name ||
    !version ||
    !riskProfile ||
    !evalStatus ||
    !sourcePath ||
    !instructionHash ||
    permissionRequirements.length === 0
  ) {
    return undefined;
  }
  return {
    name,
    version,
    riskProfile,
    permissionRequirements,
    evalStatus,
    declaredTools,
    sourcePath,
    instructionHash,
  };
}

function hasBrokeredSkillInvocation(
  value: unknown,
  execution: ToolExecutionRow,
  skill: SkillInvocationProof,
  evidenceItemId?: string,
): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((entry) => isBrokeredSkillInvocation(entry, execution, skill, evidenceItemId));
}

function isBrokeredSkillInvocation(
  value: unknown,
  execution: ToolExecutionRow,
  skill: SkillInvocationProof,
  evidenceItemId?: string,
): boolean {
  if (!isRecord(value)) return false;
  const brokered = value['brokeredInvocation'];
  const expectedEvidenceItemId =
    typeof evidenceItemId === 'string' && evidenceItemId.length > 0 ? evidenceItemId : undefined;
  return Boolean(
    value['name'] === skill.name &&
    value['version'] === skill.version &&
    value['riskProfile'] === skill.riskProfile &&
    value['evalStatus'] === skill.evalStatus &&
    value['sourcePath'] === skill.sourcePath &&
    value['instructionHash'] === skill.instructionHash &&
    arrayContainsAll(value['permissionRequirements'], skill.permissionRequirements) &&
    arrayContainsAll(value['declaredTools'], skill.declaredTools) &&
    isRecord(brokered) &&
    brokered['actionId'] === execution.actionId &&
    brokered['toolExecutionId'] === execution.id &&
    (expectedEvidenceItemId
      ? brokered['evidenceItemId'] === expectedEvidenceItemId
      : typeof brokered['evidenceItemId'] === 'string' && brokered['evidenceItemId'].length > 0) &&
    brokered['status'] === 'completed' &&
    brokered['inputHash'] === execution.inputHash &&
    brokered['outputHash'] === execution.outputHash &&
    brokered['policyDecisionId'] === execution.policyDecisionId &&
    brokered['policyVersion'] === execution.policyVersion,
  );
}

function isSkillInvocationToolEvidence(row: EvidenceItemRow, execution: ToolExecutionRow): boolean {
  return Boolean(
    row.toolExecutionId === execution.id &&
    row.actionId === execution.actionId &&
    row.evidenceType === 'tool_execution_completed' &&
    row.sourceType === 'tool_broker' &&
    row.auditEventId &&
    row.replayRef === `tool:${execution.id}` &&
    row.contentHash === execution.outputHash &&
    Array.isArray(execution.evidenceIds) &&
    execution.evidenceIds.includes(row.id) &&
    hasMetadataValue(row.metadata, 'broker', 'tool_broker_v1') &&
    hasMetadataValue(row.metadata, 'toolKey', 'skill.invoke') &&
    hasMetadataValue(row.metadata, 'toolExecutionId', execution.id) &&
    hasMetadataValue(row.metadata, 'status', 'completed') &&
    hasMetadataValue(row.metadata, 'policyDecisionId', execution.policyDecisionId ?? '') &&
    hasMetadataValue(row.metadata, 'policyVersion', execution.policyVersion ?? '') &&
    metadataArrayIncludes(row.metadata, 'requiredEvidence', 'skill_manifest') &&
    metadataArrayIncludes(row.metadata, 'requiredEvidence', 'skill_run_record') &&
    metadataArrayIncludes(row.metadata, 'permissionRequirements', 'skill:invoke'),
  );
}

function isSkillInvocationToolAudit(
  row: AuditRow,
  evidence: EvidenceItemRow,
  execution: ToolExecutionRow,
): boolean {
  return Boolean(
    row.id === evidence.auditEventId &&
    row.action === 'TOOL_EXECUTION' &&
    row.target === 'skill.invoke' &&
    row.verdict === 'allow' &&
    hasMetadataValue(row.metadata, 'broker', 'tool_broker_v1') &&
    hasMetadataValue(row.metadata, 'toolKey', 'skill.invoke') &&
    hasMetadataValue(row.metadata, 'toolExecutionId', execution.id) &&
    hasMetadataValue(row.metadata, 'evidenceItemId', evidence.id) &&
    hasMetadataValue(row.metadata, 'policyDecisionId', execution.policyDecisionId ?? '') &&
    hasMetadataValue(row.metadata, 'policyVersion', execution.policyVersion ?? ''),
  );
}

function isParentReplayRun(row: TaskRunRow): boolean {
  return (
    row.lineageKind === 'parent_action' &&
    row.parentTaskRunId === null &&
    typeof row.actionTool === 'string' &&
    row.actionTool.length > 0
  );
}

function isSubagentSpawnRun(row: TaskRunRow, parentTaskRunId: string): boolean {
  return (
    row.lineageKind === 'subagent_spawn' &&
    row.parentTaskRunId === parentTaskRunId &&
    row.rootTaskRunId === parentTaskRunId &&
    row.actionTool === 'subagent.spawn' &&
    typeof row.spawnedByActionId === 'string' &&
    row.spawnedByActionId.length > 0 &&
    typeof row.operatorRole === 'string' &&
    row.operatorRole.length > 0
  );
}

function isSubagentChildActionRun(
  row: TaskRunRow,
  parentTaskRunId: string,
  spawnTaskRunId: string,
): boolean {
  return (
    row.lineageKind === 'subagent_action' &&
    row.rootTaskRunId === parentTaskRunId &&
    row.parentTaskRunId === spawnTaskRunId &&
    typeof row.actionTool === 'string' &&
    row.actionTool.length > 0
  );
}

function isSubagentSpawnEvidencePack(row: EvidencePackRow, spawnRun: TaskRunRow): boolean {
  return (
    row.taskRunId === spawnRun.id &&
    row.action === 'SUBAGENT_SPAWN' &&
    normalizeVerdict(row.verdict) === 'allow' &&
    typeof row.decisionId === 'string' &&
    row.decisionId.length > 0 &&
    typeof row.policyVersion === 'string' &&
    row.policyVersion.length > 0 &&
    row.principal.startsWith(`workspace:${row.workspaceId}/operator:`)
  );
}

function isSubagentSpawnEvidenceItem(row: EvidenceItemRow, pack: EvidencePackRow): boolean {
  return (
    row.evidencePackId === pack.id &&
    row.evidenceType === 'subagent_spawn_receipt' &&
    row.sourceType === 'conductor' &&
    row.replayRef === `helm:${pack.decisionId}` &&
    hasMetadataValue(row.metadata, 'decisionId', pack.decisionId) &&
    hasMetadataValue(row.metadata, 'policyVersion', pack.policyVersion) &&
    hasMetadataValue(row.metadata, 'action', 'SUBAGENT_SPAWN')
  );
}

function isChildReceiptEvidencePack(
  row: EvidencePackRow,
  childRun: TaskRunRow,
  spawnPack: EvidencePackRow,
): boolean {
  return (
    row.taskRunId === childRun.id &&
    row.parentEvidencePackId === spawnPack.id &&
    row.action !== 'SUBAGENT_SPAWN' &&
    normalizeVerdict(row.verdict) === 'allow' &&
    typeof row.decisionId === 'string' &&
    row.decisionId.length > 0 &&
    typeof row.policyVersion === 'string' &&
    row.policyVersion.length > 0 &&
    row.principal.startsWith(`workspace:${row.workspaceId}/operator:`)
  );
}

function isChildReceiptEvidenceItem(
  row: EvidenceItemRow,
  childRun: TaskRunRow,
  pack: EvidencePackRow,
): boolean {
  return (
    row.taskRunId === childRun.id &&
    row.evidencePackId === pack.id &&
    (row.evidenceType === 'llm_inference_receipt' || row.evidenceType === 'tool_receipt') &&
    row.sourceType === 'agent_loop' &&
    row.replayRef === `helm:${pack.decisionId}` &&
    hasMetadataValue(row.metadata, 'decisionId', pack.decisionId) &&
    hasMetadataValue(row.metadata, 'policyVersion', pack.policyVersion) &&
    hasMetadataValue(row.metadata, 'parentEvidencePackId', pack.parentEvidencePackId ?? '')
  );
}

function compareTaskRunReplayOrder(a: TaskRunRow, b: TaskRunRow): number {
  return (
    a.runSequence - b.runSequence ||
    a.startedAt.getTime() - b.startedAt.getTime() ||
    a.id.localeCompare(b.id)
  );
}

function isDeterministicReplayOrder(rows: TaskRunRow[]): boolean {
  return rows.every(
    (row, index) => index === 0 || compareTaskRunReplayOrder(rows[index - 1]!, row) <= 0,
  );
}

function isTaskResumeDispatchEvidence(
  row: EvidenceItemRow,
  taskId: string,
  priorActionCount: number,
): boolean {
  return (
    row.evidenceType === 'task_resume_dispatched' &&
    row.sourceType === 'task_resume_worker' &&
    row.auditEventId !== null &&
    typeof row.replayRef === 'string' &&
    row.replayRef.length > 0 &&
    hasMetadataValue(row.metadata, 'taskId', taskId) &&
    hasMetadataValue(
      row.metadata,
      'evidenceContract',
      'task_resume_dispatch_before_orchestrator_resume',
    ) &&
    hasMetadataValue(
      row.metadata,
      'credentialBoundary',
      'no_raw_credentials_or_session_payloads_in_evidence',
    ) &&
    hasMetadataNumber(row.metadata, 'priorActionCount', priorActionCount)
  );
}

function isTaskResumeDispatchAudit(
  row: AuditRow,
  evidence: EvidenceItemRow,
  taskId: string,
  priorActionCount: number,
): boolean {
  return (
    row.id === evidence.auditEventId &&
    row.action === 'TASK_RESUME_DISPATCHED' &&
    row.target === taskId &&
    row.verdict === 'allow' &&
    hasMetadataValue(row.metadata, 'evidenceItemId', evidence.id) &&
    hasMetadataValue(row.metadata, 'taskId', taskId) &&
    hasMetadataNumber(row.metadata, 'priorActionCount', priorActionCount) &&
    hasMetadataValue(row.metadata, 'replayRef', evidence.replayRef ?? '')
  );
}

function findOperatorScopeRejectionProof(
  evidenceRows: EvidenceItemRow[],
  auditRows: AuditRow[],
  workspaceId: string,
  sourceType: 'gateway_operator_scope' | 'orchestrator_operator_scope',
): { evidence: EvidenceItemRow; audit: AuditRow } | undefined {
  for (const evidence of evidenceRows) {
    if (!isOperatorScopeRejectionEvidence(evidence, workspaceId, sourceType)) continue;
    const audit = auditRows.find((row) => isOperatorScopeRejectionAudit(row, evidence));
    if (audit) return { evidence, audit };
  }
  return undefined;
}

function isOperatorScopeRejectionEvidence(
  row: EvidenceItemRow,
  workspaceId: string,
  sourceType: 'gateway_operator_scope' | 'orchestrator_operator_scope',
): boolean {
  if (!row.replayRef || !row.auditEventId || row.workspaceId !== workspaceId) return false;
  if (
    row.evidenceType !== 'workspace_operator_scope_rejected' ||
    row.sourceType !== sourceType ||
    row.redactionState !== 'redacted' ||
    row.sensitivity !== 'internal'
  ) {
    return false;
  }
  if (!isRecord(row.metadata)) return false;
  return (
    typeof row.metadata['requestedOperatorId'] === 'string' &&
    row.metadata['requestedOperatorId'].length > 0 &&
    typeof row.metadata['surface'] === 'string' &&
    row.metadata['surface'].length > 0 &&
    row.metadata['reason'] === 'operatorId_not_in_workspace' &&
    row.metadata['evidenceContract'] === 'operator_scope_denial_evidence_required' &&
    row.metadata['credentialBoundary'] === 'no_raw_credentials_or_session_payloads_in_evidence' &&
    row.metadata['replayRef'] === row.replayRef &&
    row.metadata['foreignWorkspaceId'] === undefined
  );
}

function isOperatorScopeRejectionAudit(row: AuditRow, evidence: EvidenceItemRow): boolean {
  return Boolean(
    row.id === evidence.auditEventId &&
    row.workspaceId === evidence.workspaceId &&
    row.action === 'WORKSPACE_OPERATOR_SCOPE_REJECTED' &&
    row.verdict === 'deny' &&
    hasMetadataValue(row.metadata, 'evidenceItemId', evidence.id) &&
    hasMetadataValue(row.metadata, 'requestedOperatorId', requestedOperatorId(evidence)) &&
    hasMetadataValue(row.metadata, 'reason', 'operatorId_not_in_workspace') &&
    hasMetadataValue(row.metadata, 'replayRef', evidence.replayRef ?? ''),
  );
}

function requestedOperatorId(evidence: EvidenceItemRow): string {
  return isRecord(evidence.metadata) && typeof evidence.metadata['requestedOperatorId'] === 'string'
    ? evidence.metadata['requestedOperatorId']
    : '';
}

function isRecoveryPlanEvidence(row: EvidenceItemRow): boolean {
  if (
    row.evidenceType !== 'startup_lifecycle_recovery_plan' ||
    row.sourceType !== 'gateway_startup_lifecycle' ||
    row.redactionState !== 'redacted' ||
    row.sensitivity !== 'internal' ||
    !row.auditEventId ||
    !row.replayRef ||
    !isSha256ContentHash(row.contentHash)
  ) {
    return false;
  }
  if (!isRecord(row.metadata)) return false;
  return (
    row.metadata['recoveryPlanVersion'] === 'mission-recovery-plan.v1' &&
    typeof row.metadata['recoveryPlanId'] === 'string' &&
    typeof row.metadata['checkpointId'] === 'string' &&
    typeof row.metadata['checkpointReplayRef'] === 'string' &&
    row.metadata['recoveryExecuted'] === false &&
    row.metadata['productionReady'] === false &&
    isRecord(row.metadata['plan']) &&
    isRecord(row.metadata['snapshot'])
  );
}

function isRecoveryPlanAudit(row: AuditRow, evidence: EvidenceItemRow): boolean {
  return Boolean(
    row.id === evidence.auditEventId &&
    row.workspaceId === evidence.workspaceId &&
    row.action === 'STARTUP_LIFECYCLE_RECOVERY_PLAN' &&
    row.verdict === 'recorded' &&
    hasMetadataValue(row.metadata, 'evidenceItemId', evidence.id) &&
    hasMetadataValue(row.metadata, 'evidenceType', 'startup_lifecycle_recovery_plan') &&
    hasMetadataValue(row.metadata, 'recoveryPlanVersion', 'mission-recovery-plan.v1') &&
    hasMetadataValue(row.metadata, 'replayRef', evidence.replayRef ?? '') &&
    hasMetadataValue(row.metadata, 'contentHash', evidence.contentHash ?? ''),
  );
}

function isRecoveryApplyEvidence(row: EvidenceItemRow, plan: EvidenceItemRow): boolean {
  if (
    row.evidenceType !== 'startup_lifecycle_recovery_applied' ||
    row.sourceType !== 'gateway_startup_lifecycle' ||
    row.redactionState !== 'redacted' ||
    row.sensitivity !== 'internal' ||
    !row.auditEventId ||
    !row.replayRef ||
    !isSha256ContentHash(row.contentHash)
  ) {
    return false;
  }
  if (!isRecord(row.metadata)) return false;
  return (
    row.metadata['recoveryApplyVersion'] === 'mission-recovery-apply.v1' &&
    typeof row.metadata['recoveryApplyId'] === 'string' &&
    row.metadata['recoveryPlanReplayRef'] === plan.replayRef &&
    row.metadata['recoveryPlanEvidenceItemId'] === plan.id &&
    typeof row.metadata['runtimeCheckpointId'] === 'string' &&
    isNonEmptyArray(row.metadata['runtimeCheckpointEvidenceItemIds']) &&
    isNonEmptyArray(row.metadata['recoveredNodeKeys']) &&
    row.metadata['executionStarted'] === false &&
    row.metadata['productionReady'] === false
  );
}

function isRecoveryApplyAudit(row: AuditRow, evidence: EvidenceItemRow): boolean {
  return Boolean(
    row.id === evidence.auditEventId &&
    row.workspaceId === evidence.workspaceId &&
    row.action === 'STARTUP_LIFECYCLE_RECOVERY_APPLIED' &&
    row.verdict === 'recorded' &&
    hasMetadataValue(row.metadata, 'evidenceItemId', evidence.id) &&
    hasMetadataValue(row.metadata, 'evidenceType', 'startup_lifecycle_recovery_applied') &&
    hasMetadataValue(row.metadata, 'recoveryApplyVersion', 'mission-recovery-apply.v1') &&
    hasMetadataValue(row.metadata, 'replayRef', evidence.replayRef ?? '') &&
    hasMetadataValue(row.metadata, 'contentHash', evidence.contentHash ?? ''),
  );
}

function isPreRecoveryCheckpointEvidence(row: EvidenceItemRow, apply: EvidenceItemRow): boolean {
  if (
    row.evidenceType !== 'startup_lifecycle_mission_checkpoint' ||
    row.sourceType !== 'gateway_startup_lifecycle' ||
    row.redactionState !== 'redacted' ||
    row.sensitivity !== 'internal' ||
    !row.auditEventId ||
    !row.replayRef ||
    !isSha256ContentHash(row.contentHash) ||
    !isRecord(row.metadata) ||
    !isRecord(apply.metadata)
  ) {
    return false;
  }
  const checkpointEvidenceIds = apply.metadata['runtimeCheckpointEvidenceItemIds'];
  return (
    row.metadata['checkpointKind'] === 'pre_recovery' &&
    row.metadata['productionReady'] === false &&
    row.metadata['checkpointId'] === apply.metadata['runtimeCheckpointId'] &&
    Array.isArray(checkpointEvidenceIds) &&
    checkpointEvidenceIds.includes(row.id)
  );
}

function isPreRecoveryCheckpointAudit(row: AuditRow, evidence: EvidenceItemRow): boolean {
  return Boolean(
    row.id === evidence.auditEventId &&
    row.workspaceId === evidence.workspaceId &&
    row.action === 'STARTUP_LIFECYCLE_MISSION_CHECKPOINT' &&
    row.verdict === 'recorded' &&
    hasMetadataValue(row.metadata, 'evidenceItemId', evidence.id) &&
    hasMetadataValue(row.metadata, 'evidenceType', 'startup_lifecycle_mission_checkpoint') &&
    hasMetadataValue(row.metadata, 'checkpointVersion', 'mission-runtime-checkpoint.v1') &&
    hasMetadataValue(row.metadata, 'checkpointKind', 'pre_recovery') &&
    hasMetadataValue(row.metadata, 'replayRef', evidence.replayRef ?? '') &&
    hasMetadataValue(row.metadata, 'contentHash', evidence.contentHash ?? ''),
  );
}

type MultiAgentParallelBuildProof = {
  thread: A2aThreadRow;
  task: TaskRow;
  messages: A2aMessageRow[];
  dispatchEvidence: EvidenceItemRow;
  dispatchAudit: AuditRow;
  handoffs: AgentHandoffRow[];
  childRuns: TaskRunRow[];
  toolProofs: Array<{
    execution: ToolExecutionRow;
    evidence: EvidenceItemRow;
    audit: AuditRow;
  }>;
};

function findMultiAgentParallelBuildProof(params: {
  workspaceId: string;
  threadRows: A2aThreadRow[];
  messageRows: A2aMessageRow[];
  taskRows: TaskRow[];
  runRows: TaskRunRow[];
  handoffRows: AgentHandoffRow[];
  executionRows: ToolExecutionRow[];
  evidenceRows: EvidenceItemRow[];
  auditRows: AuditRow[];
}): MultiAgentParallelBuildProof | undefined {
  for (const thread of params.threadRows) {
    if (!isRestartVerifiedA2aThread(thread)) continue;
    const task = params.taskRows.find((row) => row.id === thread.pilotTaskId);
    if (!task) continue;

    const messages = params.messageRows
      .filter((row) => row.threadId === thread.id && row.workspaceId === params.workspaceId)
      .sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id));
    if (!hasDeterministicA2aMessages(messages)) continue;

    const dispatchEvidence = params.evidenceRows.find((row) => isA2aDispatchEvidence(row, thread));
    if (!dispatchEvidence) continue;
    const dispatchAudit = params.auditRows.find((row) =>
      isA2aDispatchAudit(row, dispatchEvidence, thread),
    );
    if (!dispatchAudit) continue;

    const handoffs = params.handoffRows.filter(
      (row) =>
        row.workspaceId === params.workspaceId &&
        row.taskId === task.id &&
        row.handoffKind === 'subagent_spawn' &&
        row.status === 'completed' &&
        row.parentTaskRunId &&
        row.childTaskRunId &&
        row.completedAt,
    );
    const distinctAgents = uniqueSorted(handoffs.map((row) => row.toAgent));
    if (handoffs.length < 2 || distinctAgents.length < 2) continue;

    const selectedHandoffs: AgentHandoffRow[] = [];
    const childRuns: TaskRunRow[] = [];
    const toolProofs: MultiAgentParallelBuildProof['toolProofs'] = [];
    for (const handoff of handoffs) {
      if (selectedHandoffs.some((row) => row.toAgent === handoff.toAgent)) continue;
      const childRun = params.runRows.find((row) => isParallelBuildChildRun(row, handoff));
      if (!childRun) continue;
      const proof = findParallelBuildToolProof({
        childRun,
        executionRows: params.executionRows,
        evidenceRows: params.evidenceRows,
        auditRows: params.auditRows,
      });
      if (!proof) continue;
      selectedHandoffs.push(handoff);
      childRuns.push(childRun);
      toolProofs.push(proof);
      if (selectedHandoffs.length >= 2 && toolProofs.some((item) => hasArtifactDiffProof(item))) {
        return {
          thread,
          task,
          messages,
          dispatchEvidence,
          dispatchAudit,
          handoffs: selectedHandoffs,
          childRuns,
          toolProofs,
        };
      }
    }
  }
  return undefined;
}

function isRestartVerifiedA2aThread(row: A2aThreadRow): boolean {
  if (
    row.status !== 'completed' ||
    !row.completedAt ||
    !row.pilotTaskId ||
    typeof row.externalTaskId !== 'string' ||
    row.externalTaskId.length === 0 ||
    !isRecord(row.metadata)
  ) {
    return false;
  }
  return (
    row.metadata['conductStatus'] === 'completed' &&
    row.metadata['restartVerified'] === true &&
    typeof row.metadata['dispatchEvidenceItemId'] === 'string' &&
    row.metadata['dispatchEvidenceItemId'].length > 0
  );
}

function hasDeterministicA2aMessages(rows: A2aMessageRow[]): boolean {
  if (rows.length < 2) return false;
  const roles = new Set(rows.map((row) => row.role));
  if (!roles.has('user') || !roles.has('agent')) return false;
  return rows.every((row, index) => {
    if (row.sequence !== index + 1) return false;
    return Array.isArray(row.parts) && row.parts.length > 0;
  });
}

function isA2aDispatchEvidence(row: EvidenceItemRow, thread: A2aThreadRow): boolean {
  if (!isRecord(thread.metadata)) return false;
  return Boolean(
    row.workspaceId === thread.workspaceId &&
    row.taskId === thread.pilotTaskId &&
    row.id === thread.metadata['dispatchEvidenceItemId'] &&
    row.evidenceType === 'a2a_task_dispatched' &&
    row.sourceType === 'gateway_a2a_route' &&
    row.redactionState === 'redacted' &&
    row.sensitivity === 'internal' &&
    row.auditEventId &&
    row.replayRef?.startsWith(`a2a:${thread.externalTaskId}:dispatch:`) &&
    hasMetadataValue(row.metadata, 'externalTaskId', thread.externalTaskId) &&
    hasMetadataValue(row.metadata, 'pilotTaskId', thread.pilotTaskId ?? '') &&
    hasMetadataValue(row.metadata, 'evidenceContract', 'a2a_dispatch_evidence_required'),
  );
}

function isA2aDispatchAudit(
  row: AuditRow,
  evidence: EvidenceItemRow,
  thread: A2aThreadRow,
): boolean {
  return Boolean(
    row.id === evidence.auditEventId &&
    row.workspaceId === thread.workspaceId &&
    row.action === 'A2A_TASK_SEND_DISPATCHED' &&
    row.target === thread.pilotTaskId &&
    row.verdict === 'allow' &&
    hasMetadataValue(row.metadata, 'externalTaskId', thread.externalTaskId) &&
    hasMetadataValue(row.metadata, 'pilotTaskId', thread.pilotTaskId ?? '') &&
    hasMetadataValue(row.metadata, 'evidenceItemId', evidence.id),
  );
}

function isParallelBuildChildRun(row: TaskRunRow, handoff: AgentHandoffRow): boolean {
  return Boolean(
    row.id === handoff.childTaskRunId &&
    row.taskId === handoff.taskId &&
    row.status === 'completed' &&
    row.completedAt &&
    row.parentTaskRunId === handoff.parentTaskRunId &&
    row.rootTaskRunId &&
    row.lineageKind === 'subagent_spawn' &&
    row.runSequence > 0,
  );
}

function findParallelBuildToolProof(params: {
  childRun: TaskRunRow;
  executionRows: ToolExecutionRow[];
  evidenceRows: EvidenceItemRow[];
  auditRows: AuditRow[];
}):
  | {
      execution: ToolExecutionRow;
      evidence: EvidenceItemRow;
      audit: AuditRow;
    }
  | undefined {
  for (const execution of params.executionRows) {
    if (!isParallelBuildToolExecution(execution, params.childRun)) continue;
    const evidence = params.evidenceRows.find((row) => isParallelBuildToolEvidence(row, execution));
    if (!evidence) continue;
    const audit = params.auditRows.find((row) =>
      isParallelBuildToolAudit(row, evidence, execution),
    );
    if (!audit) continue;
    return { execution, evidence, audit };
  }
  return undefined;
}

function isParallelBuildToolExecution(row: ToolExecutionRow, childRun: TaskRunRow): boolean {
  return Boolean(
    row.taskRunId === childRun.id &&
    row.status === 'completed' &&
    row.completedAt &&
    row.toolKey !== 'finish' &&
    row.outputHash &&
    row.actionId &&
    row.idempotencyKey &&
    Array.isArray(row.evidenceIds) &&
    row.evidenceIds.length > 0 &&
    hasPolicyPin(row.policyDecisionId, row.policyVersion, row.helmDocumentVersionPins),
  );
}

function isParallelBuildToolEvidence(row: EvidenceItemRow, execution: ToolExecutionRow): boolean {
  return Boolean(
    row.toolExecutionId === execution.id &&
    row.taskRunId === execution.taskRunId &&
    row.actionId === execution.actionId &&
    row.evidenceType === 'tool_execution_completed' &&
    row.sourceType === 'tool_broker' &&
    row.auditEventId &&
    row.replayRef === `tool:${execution.id}` &&
    row.contentHash === execution.outputHash &&
    Array.isArray(execution.evidenceIds) &&
    execution.evidenceIds.includes(row.id) &&
    hasMetadataValue(row.metadata, 'broker', 'tool_broker_v1') &&
    hasMetadataValue(row.metadata, 'toolKey', execution.toolKey) &&
    hasMetadataValue(row.metadata, 'toolExecutionId', execution.id) &&
    hasMetadataValue(row.metadata, 'status', 'completed') &&
    hasMetadataValue(row.metadata, 'policyDecisionId', execution.policyDecisionId ?? '') &&
    hasMetadataValue(row.metadata, 'policyVersion', execution.policyVersion ?? '') &&
    metadataArrayIncludes(row.metadata, 'requiredEvidence', 'agent_run_log'),
  );
}

function isParallelBuildToolAudit(
  row: AuditRow,
  evidence: EvidenceItemRow,
  execution: ToolExecutionRow,
): boolean {
  return Boolean(
    row.id === evidence.auditEventId &&
    row.action === 'TOOL_EXECUTION' &&
    row.target === execution.toolKey &&
    row.verdict === 'allow' &&
    hasMetadataValue(row.metadata, 'broker', 'tool_broker_v1') &&
    hasMetadataValue(row.metadata, 'toolKey', execution.toolKey) &&
    hasMetadataValue(row.metadata, 'toolExecutionId', execution.id) &&
    hasMetadataValue(row.metadata, 'evidenceItemId', evidence.id) &&
    hasMetadataValue(row.metadata, 'policyDecisionId', execution.policyDecisionId ?? '') &&
    hasMetadataValue(row.metadata, 'policyVersion', execution.policyVersion ?? ''),
  );
}

function hasArtifactDiffProof(proof: {
  execution: ToolExecutionRow;
  evidence: EvidenceItemRow;
}): boolean {
  return (
    metadataArrayIncludes(proof.evidence.metadata, 'requiredEvidence', 'artifact_diff') ||
    metadataArrayIncludes(proof.execution.sanitizedOutput, 'evidenceKinds', 'artifact_diff') ||
    hasMetadataString(proof.execution.sanitizedOutput, 'artifactDiffRef') ||
    getArrayLength(
      isRecord(proof.execution.sanitizedOutput) ? proof.execution.sanitizedOutput : {},
      'artifactDiffRefs',
    ) > 0
  );
}

function isCommandCenterRealStateUxEvidence(row: EvidenceItemRow): boolean {
  if (
    row.evidenceType !== 'command_center_real_state_ux' ||
    row.sourceType !== 'command_center_eval' ||
    row.redactionState !== 'redacted' ||
    row.sensitivity !== 'internal' ||
    !row.auditEventId ||
    !row.replayRef ||
    !isSha256ContentHash(row.contentHash) ||
    !isRecord(row.metadata)
  ) {
    return false;
  }

  return (
    row.metadata['commandCenterEvalVersion'] === 'command-center-real-state-ux.v1' &&
    row.metadata['executionMode'] === PRODUCTION_READY_EXECUTION_MODE &&
    row.metadata['capabilityMatrixRendered'] === true &&
    row.metadata['routeLocalMockState'] === false &&
    row.metadata['productionReadyClaims'] === false &&
    hasMetadataString(row.metadata, 'apiResponseFixtureRef') &&
    isSha256ContentHash(stringMetadata(row.metadata, 'apiResponseFixtureHash')) &&
    hasMetadataString(row.metadata, 'uiScreenshotRef') &&
    isSha256ContentHash(stringMetadata(row.metadata, 'uiScreenshotHash')) &&
    hasMetadataString(row.metadata, 'accessibilityReportRef') &&
    isSha256ContentHash(stringMetadata(row.metadata, 'accessibilityReportHash')) &&
    arrayContainsAll(row.metadata['capabilityStatesRendered'], ['prototype', 'blocked']) &&
    arrayContainsAll(row.metadata['durableStateSurfaces'], [
      'mission_graph',
      'agent_lanes',
      'action_timeline',
      'evidence_drawer',
      'receipt_chips',
      'browser_computer_replay',
      'permission_graph',
      'eval_status',
      'capability_matrix',
    ])
  );
}

function isCommandCenterRealStateUxAudit(row: AuditRow, evidence: EvidenceItemRow): boolean {
  return Boolean(
    row.id === evidence.auditEventId &&
    row.workspaceId === evidence.workspaceId &&
    row.action === 'COMMAND_CENTER_REAL_STATE_UX_EVAL' &&
    row.target === 'command_center' &&
    row.verdict === 'recorded' &&
    hasMetadataValue(row.metadata, 'evidenceItemId', evidence.id) &&
    hasMetadataValue(row.metadata, 'evidenceType', 'command_center_real_state_ux') &&
    hasMetadataValue(row.metadata, 'sourceType', 'command_center_eval') &&
    hasMetadataValue(row.metadata, 'commandCenterEvalVersion', 'command-center-real-state-ux.v1') &&
    hasMetadataValue(row.metadata, 'executionMode', PRODUCTION_READY_EXECUTION_MODE) &&
    hasMetadataValue(row.metadata, 'replayRef', evidence.replayRef ?? '') &&
    hasMetadataValue(row.metadata, 'contentHash', evidence.contentHash ?? ''),
  );
}

type FullStartupLaunchProof = {
  mission: MissionRow;
  nodes: MissionNodeRow[];
  edges: MissionEdgeRow[];
  taskLinks: MissionTaskRow[];
  completedRuns: TaskRunRow[];
  persistEvidence: EvidenceItemRow;
  checkpointEvidence: EvidenceItemRow;
  checkpointAudit: AuditRow;
  artifact: ArtifactRow;
  artifactEvidence: EvidenceItemRow;
  artifactAudit: AuditRow;
  deployment: DeploymentRow;
  deploymentEvidence: EvidenceItemRow;
  deploymentAudit: AuditRow;
  health: DeployHealthRow;
  healthEvidence: EvidenceItemRow;
  healthAudit: AuditRow;
  toolProofs: Array<{
    execution: ToolExecutionRow;
    evidence: EvidenceItemRow;
    audit: AuditRow;
  }>;
};

function findFullStartupLaunchProof(params: {
  workspaceId: string;
  missionRows: MissionRow[];
  nodeRows: MissionNodeRow[];
  edgeRows: MissionEdgeRow[];
  missionTaskRows: MissionTaskRow[];
  taskRows: TaskRow[];
  runRows: TaskRunRow[];
  executionRows: ToolExecutionRow[];
  artifactRows: ArtifactRow[];
  deploymentRows: DeploymentRow[];
  healthRows: DeployHealthRow[];
  evidenceRows: EvidenceItemRow[];
  auditRows: AuditRow[];
}): FullStartupLaunchProof | undefined {
  for (const mission of params.missionRows) {
    if (!isCompletedFullStartupMission(mission)) continue;
    const nodes = params.nodeRows
      .filter((row) => row.missionId === mission.id)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.nodeKey.localeCompare(b.nodeKey));
    if (!hasRequiredFullStartupStages(nodes)) continue;
    if (!nodes.every((row) => row.status === 'completed' || row.status === 'skipped')) continue;

    const edges = params.edgeRows.filter((row) => row.missionId === mission.id);
    if (edges.length < FULL_STARTUP_LAUNCH_REQUIRED_STAGES.length - 1) continue;

    const nodeIds = new Set(nodes.map((row) => row.id));
    const taskLinks = params.missionTaskRows.filter(
      (row) => row.missionId === mission.id && (!row.nodeId || nodeIds.has(row.nodeId)),
    );
    if (taskLinks.length < nodes.length) continue;

    const taskIds = new Set(taskLinks.map((row) => row.taskId));
    const completedRuns = params.runRows.filter(
      (row) => taskIds.has(row.taskId) && row.status === 'completed' && Boolean(row.completedAt),
    );
    if (completedRuns.length < nodes.length) continue;

    const persistEvidence = params.evidenceRows.find((row) =>
      isFullStartupMissionPersistEvidence(row, mission, nodes.length),
    );
    if (!persistEvidence) continue;

    const checkpointEvidence = params.evidenceRows.find((row) =>
      isFullStartupCompletedCheckpointEvidence(row, mission, nodes.length),
    );
    if (!checkpointEvidence) continue;
    const checkpointAudit = params.auditRows.find((row) =>
      isFullStartupCompletedCheckpointAudit(row, checkpointEvidence, mission),
    );
    if (!checkpointAudit) continue;

    const toolProofs = findFullStartupToolProofs({
      completedRuns,
      executionRows: params.executionRows,
      evidenceRows: params.evidenceRows,
      auditRows: params.auditRows,
    });
    if (toolProofs.length < FULL_STARTUP_MIN_TOOL_PROOFS) continue;

    for (const deployment of params.deploymentRows) {
      if (!isFullStartupLiveDeployment(deployment)) continue;
      const artifactId = deployment.artifactId;
      const artifact = artifactId
        ? params.artifactRows.find((row) => isFullStartupArtifact(row, artifactId))
        : undefined;
      if (!artifact) continue;

      const artifactEvidence = params.evidenceRows.find((row) =>
        isFullStartupArtifactEvidence(row, artifact),
      );
      if (!artifactEvidence) continue;
      const artifactAudit = params.auditRows.find((row) =>
        isFullStartupArtifactAudit(row, artifactEvidence, artifact),
      );
      if (!artifactAudit) continue;

      const deploymentEvidence = params.evidenceRows.find((row) =>
        isFullStartupDeploymentEvidence(row, deployment),
      );
      if (!deploymentEvidence) continue;
      const deploymentAudit = params.auditRows.find((row) =>
        isFullStartupDeploymentAudit(row, deploymentEvidence, deployment),
      );
      if (!deploymentAudit) continue;

      const health = params.healthRows.find((row) => isFullStartupDeployHealth(row, deployment));
      if (!health) continue;
      const healthEvidence = params.evidenceRows.find((row) =>
        isFullStartupHealthEvidence(row, health, deployment),
      );
      if (!healthEvidence) continue;
      const healthAudit = params.auditRows.find((row) =>
        isFullStartupHealthAudit(row, healthEvidence, health, deployment),
      );
      if (!healthAudit) continue;

      return {
        mission,
        nodes,
        edges,
        taskLinks,
        completedRuns,
        persistEvidence,
        checkpointEvidence,
        checkpointAudit,
        artifact,
        artifactEvidence,
        artifactAudit,
        deployment,
        deploymentEvidence,
        deploymentAudit,
        health,
        healthEvidence,
        healthAudit,
        toolProofs: toolProofs.slice(0, FULL_STARTUP_MIN_TOOL_PROOFS),
      };
    }
  }
  return undefined;
}

function isCompletedFullStartupMission(row: MissionRow): boolean {
  return (
    row.status === 'completed' &&
    Boolean(row.completedAt) &&
    row.productionReady === false &&
    row.capabilityState !== 'production_ready' &&
    row.compilerVersion === 'startup-lifecycle.v1' &&
    Boolean(row.ventureId) &&
    Boolean(row.goalId)
  );
}

function hasRequiredFullStartupStages(rows: MissionNodeRow[]): boolean {
  const stages = rows.map((row) => row.stage);
  return FULL_STARTUP_LAUNCH_REQUIRED_STAGES.every((stage) => stages.includes(stage));
}

function isFullStartupMissionPersistEvidence(
  row: EvidenceItemRow,
  mission: MissionRow,
  nodeCount: number,
): boolean {
  return Boolean(
    row.workspaceId === mission.workspaceId &&
    row.missionId === mission.id &&
    row.ventureId === mission.ventureId &&
    row.evidenceType === 'startup_lifecycle_mission_persisted' &&
    row.sourceType === 'gateway_startup_lifecycle' &&
    row.redactionState === 'redacted' &&
    row.sensitivity === 'internal' &&
    row.replayRef === `mission:${mission.id}:persisted` &&
    isSha256ContentHash(row.contentHash) &&
    hasMetadataValue(row.metadata, 'compilerVersion', 'startup-lifecycle.v1') &&
    hasMetadataNumber(row.metadata, 'nodeCount', nodeCount) &&
    hasMetadataValue(row.metadata, 'source', 'startup_lifecycle_persist') &&
    isRecord(row.metadata) &&
    row.metadata['productionReady'] === false,
  );
}

function isFullStartupCompletedCheckpointEvidence(
  row: EvidenceItemRow,
  mission: MissionRow,
  nodeCount: number,
): boolean {
  return Boolean(
    row.workspaceId === mission.workspaceId &&
    row.missionId === mission.id &&
    row.evidenceType === 'startup_lifecycle_mission_checkpoint' &&
    row.sourceType === 'gateway_startup_lifecycle' &&
    row.redactionState === 'redacted' &&
    row.sensitivity === 'internal' &&
    row.auditEventId &&
    row.replayRef &&
    isSha256ContentHash(row.contentHash) &&
    hasMetadataValue(row.metadata, 'checkpointVersion', 'mission-checkpoint.v1') &&
    hasMetadataValue(row.metadata, 'missionStatus', 'completed') &&
    hasMetadataNumber(row.metadata, 'nodeCount', nodeCount) &&
    isRecord(row.metadata) &&
    row.metadata['productionReady'] === false,
  );
}

function isFullStartupCompletedCheckpointAudit(
  row: AuditRow,
  evidence: EvidenceItemRow,
  mission: MissionRow,
): boolean {
  return Boolean(
    row.id === evidence.auditEventId &&
    row.workspaceId === mission.workspaceId &&
    row.action === 'STARTUP_LIFECYCLE_MISSION_CHECKPOINT' &&
    row.target === mission.id &&
    row.verdict === 'recorded' &&
    hasMetadataValue(row.metadata, 'evidenceItemId', evidence.id) &&
    hasMetadataValue(row.metadata, 'evidenceType', 'startup_lifecycle_mission_checkpoint') &&
    hasMetadataValue(row.metadata, 'checkpointVersion', 'mission-checkpoint.v1') &&
    hasMetadataValue(row.metadata, 'missionStatus', 'completed') &&
    hasMetadataValue(row.metadata, 'replayRef', evidence.replayRef ?? '') &&
    hasMetadataValue(row.metadata, 'contentHash', evidence.contentHash ?? ''),
  );
}

function findFullStartupToolProofs(params: {
  completedRuns: TaskRunRow[];
  executionRows: ToolExecutionRow[];
  evidenceRows: EvidenceItemRow[];
  auditRows: AuditRow[];
}): FullStartupLaunchProof['toolProofs'] {
  const runIds = new Set(params.completedRuns.map((row) => row.id));
  const proofs: FullStartupLaunchProof['toolProofs'] = [];
  for (const execution of params.executionRows) {
    if (!isFullStartupToolExecution(execution, runIds)) continue;
    const evidence = params.evidenceRows.find((row) => isFullStartupToolEvidence(row, execution));
    if (!evidence) continue;
    const audit = params.auditRows.find((row) => isFullStartupToolAudit(row, evidence, execution));
    if (!audit) continue;
    proofs.push({ execution, evidence, audit });
  }
  return proofs;
}

function isFullStartupToolExecution(row: ToolExecutionRow, completedRunIds: Set<string>): boolean {
  return Boolean(
    row.taskRunId &&
    completedRunIds.has(row.taskRunId) &&
    row.status === 'completed' &&
    row.completedAt &&
    row.toolKey !== 'finish' &&
    row.outputHash &&
    row.actionId &&
    row.idempotencyKey &&
    Array.isArray(row.evidenceIds) &&
    row.evidenceIds.length > 0 &&
    hasPolicyPin(row.policyDecisionId, row.policyVersion, row.helmDocumentVersionPins),
  );
}

function isFullStartupToolEvidence(row: EvidenceItemRow, execution: ToolExecutionRow): boolean {
  return Boolean(
    row.workspaceId === execution.workspaceId &&
    row.toolExecutionId === execution.id &&
    row.taskRunId === execution.taskRunId &&
    row.actionId === execution.actionId &&
    row.evidenceType === 'tool_execution_completed' &&
    row.sourceType === 'tool_broker' &&
    row.auditEventId &&
    row.replayRef === `tool:${execution.id}` &&
    row.contentHash === execution.outputHash &&
    Array.isArray(execution.evidenceIds) &&
    execution.evidenceIds.includes(row.id) &&
    hasMetadataValue(row.metadata, 'broker', 'tool_broker_v1') &&
    hasMetadataValue(row.metadata, 'toolKey', execution.toolKey) &&
    hasMetadataValue(row.metadata, 'toolExecutionId', execution.id) &&
    hasMetadataValue(row.metadata, 'status', 'completed') &&
    hasMetadataValue(row.metadata, 'policyDecisionId', execution.policyDecisionId ?? '') &&
    hasMetadataValue(row.metadata, 'policyVersion', execution.policyVersion ?? ''),
  );
}

function isFullStartupToolAudit(
  row: AuditRow,
  evidence: EvidenceItemRow,
  execution: ToolExecutionRow,
): boolean {
  return Boolean(
    row.id === evidence.auditEventId &&
    row.workspaceId === execution.workspaceId &&
    row.action === 'TOOL_EXECUTION' &&
    row.target === execution.toolKey &&
    row.verdict === 'allow' &&
    hasMetadataValue(row.metadata, 'broker', 'tool_broker_v1') &&
    hasMetadataValue(row.metadata, 'toolKey', execution.toolKey) &&
    hasMetadataValue(row.metadata, 'toolExecutionId', execution.id) &&
    hasMetadataValue(row.metadata, 'evidenceItemId', evidence.id) &&
    hasMetadataValue(row.metadata, 'policyDecisionId', execution.policyDecisionId ?? '') &&
    hasMetadataValue(row.metadata, 'policyVersion', execution.policyVersion ?? ''),
  );
}

function isFullStartupArtifact(row: ArtifactRow, artifactId: string): boolean {
  return (
    row.id === artifactId &&
    ['landing_page', 'code', 'design', 'copy', 'pitch_deck', 'application'].includes(row.type) &&
    typeof row.storagePath === 'string' &&
    row.storagePath.length > 0
  );
}

function isFullStartupArtifactEvidence(row: EvidenceItemRow, artifact: ArtifactRow): boolean {
  return Boolean(
    row.workspaceId === artifact.workspaceId &&
    row.artifactId === artifact.id &&
    row.evidenceType === 'artifact_created' &&
    (row.sourceType === 'tool_registry' || row.sourceType === 'mcp_server') &&
    row.auditEventId &&
    row.replayRef === `artifact:${artifact.id}:1` &&
    row.redactionState === 'redacted' &&
    row.sensitivity === 'internal' &&
    hasMetadataValue(row.metadata, 'artifactType', artifact.type) &&
    hasMetadataNumber(row.metadata, 'version', 1),
  );
}

function isFullStartupArtifactAudit(
  row: AuditRow,
  evidence: EvidenceItemRow,
  artifact: ArtifactRow,
): boolean {
  return Boolean(
    row.id === evidence.auditEventId &&
    row.workspaceId === artifact.workspaceId &&
    row.action === 'ARTIFACT_CREATED' &&
    row.target === artifact.id &&
    row.verdict === 'created' &&
    hasMetadataValue(row.metadata, 'evidenceItemId', evidence.id) &&
    hasMetadataValue(row.metadata, 'evidenceType', 'artifact_created') &&
    hasMetadataValue(row.metadata, 'replayRef', evidence.replayRef ?? '') &&
    hasMetadataValue(row.metadata, 'artifactId', artifact.id),
  );
}

function isFullStartupLiveDeployment(row: DeploymentRow): boolean {
  return Boolean(
    row.status === 'live' &&
    row.completedAt &&
    row.artifactId &&
    typeof row.url === 'string' &&
    /^https?:\/\//u.test(row.url),
  );
}

function isFullStartupDeploymentEvidence(row: EvidenceItemRow, deployment: DeploymentRow): boolean {
  return Boolean(
    row.workspaceId === deployment.workspaceId &&
    row.evidenceType === 'launch_deployment_requested' &&
    row.sourceType === 'gateway_launch' &&
    row.auditEventId &&
    row.replayRef &&
    row.redactionState === 'redacted' &&
    row.sensitivity === 'restricted' &&
    hasMetadataValue(row.metadata, 'action', 'DEPLOY') &&
    hasMetadataValue(row.metadata, 'executionStatus', 'pending') &&
    isRecord(row.metadata) &&
    row.metadata['secretValuesStoredInEvidence'] === false,
  );
}

function isFullStartupDeploymentAudit(
  row: AuditRow,
  evidence: EvidenceItemRow,
  deployment: DeploymentRow,
): boolean {
  return Boolean(
    row.id === evidence.auditEventId &&
    row.workspaceId === deployment.workspaceId &&
    row.action === 'DEPLOY' &&
    row.verdict === 'allow' &&
    hasMetadataValue(row.metadata, 'evidenceItemId', evidence.id) &&
    hasMetadataValue(row.metadata, 'evidenceType', 'launch_deployment_requested') &&
    hasMetadataValue(row.metadata, 'executionStatus', 'completed') &&
    hasMetadataValue(row.metadata, 'deploymentId', deployment.id) &&
    hasLaunchGovernanceMetadata(row.metadata),
  );
}

function isFullStartupDeployHealth(row: DeployHealthRow, deployment: DeploymentRow): boolean {
  return (
    row.deploymentId === deployment.id &&
    row.status === 'healthy' &&
    Boolean(row.checkedAt) &&
    isRecord(row.details)
  );
}

function isFullStartupHealthEvidence(
  row: EvidenceItemRow,
  health: DeployHealthRow,
  deployment: DeploymentRow,
): boolean {
  return Boolean(
    row.workspaceId === deployment.workspaceId &&
    row.evidenceType === 'launch_deployment_health_check_requested' &&
    row.sourceType === 'gateway_launch' &&
    row.auditEventId &&
    row.replayRef &&
    row.redactionState === 'redacted' &&
    row.sensitivity === 'restricted' &&
    hasMetadataValue(row.metadata, 'action', 'DEPLOY_HEALTH_CHECK') &&
    hasMetadataValue(row.metadata, 'deploymentId', deployment.id) &&
    hasMetadataValue(row.metadata, 'executionStatus', 'pending') &&
    isRecord(row.metadata) &&
    row.metadata['secretValuesStoredInEvidence'] === false &&
    (row.metadata['healthCheckId'] === undefined || row.metadata['healthCheckId'] === health.id),
  );
}

function isFullStartupHealthAudit(
  row: AuditRow,
  evidence: EvidenceItemRow,
  health: DeployHealthRow,
  deployment: DeploymentRow,
): boolean {
  return Boolean(
    row.id === evidence.auditEventId &&
    row.workspaceId === deployment.workspaceId &&
    row.action === 'DEPLOY_HEALTH_CHECK' &&
    row.verdict === 'allow' &&
    hasMetadataValue(row.metadata, 'evidenceItemId', evidence.id) &&
    hasMetadataValue(row.metadata, 'evidenceType', 'launch_deployment_health_check_requested') &&
    hasMetadataValue(row.metadata, 'executionStatus', 'completed') &&
    hasMetadataValue(row.metadata, 'deploymentId', deployment.id) &&
    hasMetadataValue(row.metadata, 'healthStatus', health.status) &&
    hasLaunchGovernanceMetadata(row.metadata),
  );
}

function hasLaunchGovernanceMetadata(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false;
  const governance = metadata['governance'];
  if (!isRecord(governance)) return false;
  return (
    hasMetadataString(governance, 'policyDecisionId') &&
    hasMetadataString(governance, 'policyVersion') &&
    isRecord(governance['policyPin'])
  );
}

function failedRun(
  input: TrustedRealExternalEvalInput,
  reason: string,
): { run: RecordPilotEvalRunInput } {
  return {
    run: {
      workspaceId: input.workspaceId,
      evalId: input.evalId,
      status: 'failed',
      capabilityKey: input.capabilityKey,
      runRef: input.runRef ?? `real-external-eval:${input.evalId}:${randomUUID()}`,
      failureReason: reason,
      summary: reason,
      evidenceRefs: [],
      auditReceiptRefs: [],
      metadata: {
        runnerRef: 'gateway:production-eval-runner:v1',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
      completedAt: new Date().toISOString(),
      steps: [],
    },
  };
}

function isCompletedSafeComputerAction(row: ComputerActionRow): boolean {
  return (
    row.status === 'completed' &&
    SAFE_COMPUTER_ACTIONS.has(row.actionType) &&
    row.exitCode === 0 &&
    Boolean(row.completedAt) &&
    Boolean(row.outputHash) &&
    hasPolicyMetadata(row)
  );
}

function isDeniedRestrictedComputerAction(row: ComputerActionRow): boolean {
  return (
    row.status === 'denied' &&
    SAFE_COMPUTER_ACTIONS.has(row.actionType) &&
    Boolean(row.completedAt) &&
    hasPolicyMetadata(row) &&
    /restricted|denied|outside|destructive/iu.test(row.stderr ?? '')
  );
}

function isYcLoggedInBrowserObservation(row: BrowserObservationRow): boolean {
  return (
    isYcUrl(row.url, row.origin) &&
    Boolean(row.domHash) &&
    Boolean(row.redactedDomSnapshot) &&
    Boolean(row.replayIndex !== null && row.replayIndex !== undefined) &&
    (Boolean(row.screenshotHash) || Boolean(row.screenshotRef)) &&
    isRecord(row.extractedData) &&
    Object.keys(row.extractedData).length > 0 &&
    Array.isArray(row.redactions) &&
    hasMetadataValue(row.metadata, 'credentialBoundary', BROWSER_CREDENTIAL_BOUNDARY) &&
    hasMetadataString(row.metadata, 'helmDecisionId') &&
    hasMetadataString(row.metadata, 'helmPolicyVersion')
  );
}

function isAllowedHelmReceiptPack(row: EvidencePackRow): boolean {
  return isCompleteHelmReceiptPack(row) && normalizeVerdict(row.verdict) === 'allow';
}

function isDeniedOrEscalatedHelmReceiptPack(row: EvidencePackRow): boolean {
  const verdict = normalizeVerdict(row.verdict);
  return isCompleteHelmReceiptPack(row) && (verdict === 'deny' || verdict === 'escalate');
}

function isCompleteHelmReceiptPack(row: EvidencePackRow): boolean {
  return (
    Boolean(row.decisionId) &&
    Boolean(row.policyVersion) &&
    isDecisionHash(row.decisionHash) &&
    Boolean(row.action) &&
    Boolean(row.resource) &&
    row.principal.startsWith(`workspace:${row.workspaceId}`)
  );
}

function isGovernedDecisionCourtEvidence(row: EvidenceItemRow, workspaceId: string): boolean {
  return Boolean(
    row.evidenceType === 'decision_court_run' &&
    row.sourceType === 'decision_court' &&
    row.auditEventId &&
    row.redactionState === 'redacted' &&
    isSha256ContentHash(row.contentHash) &&
    row.replayRef &&
    isGovernedDecisionCourtMetadata(row.metadata, row.replayRef, workspaceId),
  );
}

function isGovernedDecisionCourtAudit(
  row: AuditRow,
  evidence: EvidenceItemRow,
  workspaceId: string,
): boolean {
  return Boolean(
    row.id === evidence.auditEventId &&
    row.action === 'DECISION_COURT_RUN' &&
    row.target === 'governed_llm_court' &&
    row.verdict === 'completed' &&
    isRecord(row.metadata) &&
    row.metadata['evidenceItemId'] === evidence.id &&
    isGovernedDecisionCourtMetadata(row.metadata, evidence.replayRef, workspaceId),
  );
}

function isGovernedDecisionCourtMetadata(
  metadata: unknown,
  replayRef: string | null,
  workspaceId: string,
): boolean {
  if (!isRecord(metadata)) return false;
  return (
    metadata['mode'] === 'governed_llm_court' &&
    metadata['status'] === 'completed' &&
    metadata['productionReady'] === false &&
    metadata['promptVersion'] === 'decision-court-v1' &&
    metadata['credentialBoundary'] === 'no_raw_credentials_or_session_payloads_in_prompt' &&
    metadata['replayRef'] === replayRef &&
    isNonEmptyArray(metadata['requestedOpportunityIds']) &&
    isNonEmptyArray(metadata['ranking']) &&
    isRecord(metadata['finalRecommendation']) &&
    isNonEmptyArray(metadata['policyDecisionIds']) &&
    isNonEmptyArray(metadata['policyVersions']) &&
    isRecord(metadata['helmDocumentVersionPins']) &&
    Object.keys(metadata['helmDocumentVersionPins']).length > 0 &&
    hasDecisionCourtStages(metadata['stages']) &&
    hasGovernedDecisionCourtModelCalls(metadata['modelCalls'], workspaceId)
  );
}

function hasDecisionCourtStages(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const stages = new Set(
    value
      .map((entry) => (isRecord(entry) && typeof entry['stage'] === 'string' ? entry['stage'] : ''))
      .filter(Boolean),
  );
  return ['buildDocket', 'researchBull', 'researchBear', 'referee', 'synthesize'].every((stage) =>
    stages.has(stage),
  );
}

function hasGovernedDecisionCourtModelCalls(value: unknown, workspaceId: string): boolean {
  if (!Array.isArray(value)) return false;
  const calls = value.filter((call) =>
    isCompletedGovernedDecisionCourtModelCall(call, workspaceId),
  );
  const participants = new Set(calls.map((call) => call['participant']));
  return (
    calls.length >= 3 &&
    participants.has('bull') &&
    participants.has('bear') &&
    participants.has('referee')
  );
}

function isCompletedGovernedDecisionCourtModelCall(
  value: unknown,
  workspaceId: string,
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const receipt = value['receipt'];
  return (
    value['status'] === 'completed' &&
    ['bull', 'bear', 'referee'].includes(String(value['participant'])) &&
    typeof value['opportunityId'] === 'string' &&
    typeof value['prompt'] === 'string' &&
    value['prompt'].trim().length > 0 &&
    typeof value['output'] === 'string' &&
    value['output'].trim().length > 0 &&
    typeof value['model'] === 'string' &&
    typeof value['tokensIn'] === 'number' &&
    value['tokensIn'] > 0 &&
    typeof value['tokensOut'] === 'number' &&
    value['tokensOut'] > 0 &&
    typeof value['costUsd'] === 'number' &&
    value['costUsd'] >= 0 &&
    typeof value['policyDecisionId'] === 'string' &&
    typeof value['policyVersion'] === 'string' &&
    isRecord(receipt) &&
    receipt['decisionId'] === value['policyDecisionId'] &&
    receipt['policyVersion'] === value['policyVersion'] &&
    normalizeVerdict(String(receipt['verdict'] ?? '')) === 'allow' &&
    typeof receipt['principal'] === 'string' &&
    receipt['principal'].startsWith(`workspace:${workspaceId}`) &&
    isDecisionHash(typeof receipt['decisionHash'] === 'string' ? receipt['decisionHash'] : null)
  );
}

function isProductionPmfOpportunityScore(
  row: OpportunityScoreRow,
  opportunity: OpportunityRow | undefined,
): boolean {
  return Boolean(
    opportunity &&
    row.opportunityId === opportunity.id &&
    (opportunity.status === 'scored' || opportunity.status === 'selected') &&
    row.scoringMethod !== 'heuristic' &&
    row.scoringMethod.trim().length > 0 &&
    isScoreNumber(row.overallScore) &&
    isScoreNumber(row.founderFitScore) &&
    isScoreNumber(row.marketSignal) &&
    isScoreNumber(row.feasibility) &&
    isScoreNumber(row.timing) &&
    hasPolicyPin(row.policyDecisionId, row.policyVersion, row.helmDocumentVersionPins),
  );
}

function isProductionPmfScoreToolExecution(row: ToolExecutionRow, opportunityId: string): boolean {
  return Boolean(
    row.toolKey === 'score_opportunity' &&
    row.status === 'completed' &&
    row.completedAt &&
    row.outputHash &&
    row.idempotencyKey &&
    Array.isArray(row.evidenceIds) &&
    row.evidenceIds.length > 0 &&
    hasPolicyPin(row.policyDecisionId, row.policyVersion, row.helmDocumentVersionPins) &&
    isEvidenceBackedScoreOutput(row.sanitizedOutput, opportunityId),
  );
}

function isEvidenceBackedScoreOutput(value: unknown, opportunityId: string): boolean {
  if (!isRecord(value)) return false;
  return (
    value['opportunityId'] === opportunityId &&
    value['method'] !== 'heuristic' &&
    typeof value['method'] === 'string' &&
    isScoreNumber(value['overall']) &&
    hasCompleteOpportunityScoreDimensions(value['dimensions']) &&
    hasEvidenceCitations(value['citations']) &&
    isNonEmptyArray(value['assumptions']) &&
    typeof value['rationale'] === 'string' &&
    value['rationale'].trim().length > 0
  );
}

function hasCompleteOpportunityScoreDimensions(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [
    'marketPain',
    'urgency',
    'icpClarity',
    'monetization',
    'channelAccessibility',
    'competition',
    'founderFit',
    'technicalFeasibility',
    'evidenceQuality',
    'confidence',
  ].every((key) => isScoreNumber(value[key]));
}

function hasEvidenceCitations(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every((citation) => {
    if (!isRecord(citation) || typeof citation['url'] !== 'string') return false;
    try {
      const parsed = new URL(citation['url']);
      return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    } catch {
      return false;
    }
  });
}

function isPmfToolExecutionEvidence(row: EvidenceItemRow, execution: ToolExecutionRow): boolean {
  return Boolean(
    row.toolExecutionId === execution.id &&
    row.actionId === execution.actionId &&
    row.evidenceType === 'tool_execution_completed' &&
    row.sourceType === 'tool_broker' &&
    row.auditEventId &&
    row.replayRef === `tool:${execution.id}` &&
    row.contentHash === execution.outputHash &&
    Array.isArray(execution.evidenceIds) &&
    execution.evidenceIds.includes(row.id) &&
    hasMetadataValue(row.metadata, 'broker', 'tool_broker_v1') &&
    hasMetadataValue(row.metadata, 'toolKey', 'score_opportunity') &&
    hasMetadataValue(row.metadata, 'toolExecutionId', execution.id) &&
    hasMetadataValue(row.metadata, 'status', 'completed') &&
    hasMetadataValue(row.metadata, 'policyDecisionId', execution.policyDecisionId ?? '') &&
    hasMetadataValue(row.metadata, 'policyVersion', execution.policyVersion ?? '') &&
    metadataArrayIncludes(row.metadata, 'requiredEvidence', 'opportunity_score') &&
    metadataArrayIncludes(row.metadata, 'requiredEvidence', 'citations'),
  );
}

function isPmfToolExecutionAudit(
  row: AuditRow,
  evidence: EvidenceItemRow,
  execution: ToolExecutionRow,
): boolean {
  return Boolean(
    row.id === evidence.auditEventId &&
    row.action === 'TOOL_EXECUTION' &&
    row.target === 'score_opportunity' &&
    row.verdict === 'allow' &&
    hasMetadataValue(row.metadata, 'broker', 'tool_broker_v1') &&
    hasMetadataValue(row.metadata, 'toolKey', 'score_opportunity') &&
    hasMetadataValue(row.metadata, 'toolExecutionId', execution.id) &&
    hasMetadataValue(row.metadata, 'evidenceItemId', evidence.id) &&
    hasMetadataValue(row.metadata, 'policyDecisionId', execution.policyDecisionId ?? '') &&
    hasMetadataValue(row.metadata, 'policyVersion', execution.policyVersion ?? ''),
  );
}

function isYcUrl(url: string, origin: string): boolean {
  return [url, origin].some((value) => {
    try {
      const parsed = new URL(value);
      const hostname = parsed.hostname.toLowerCase();
      return hostname === 'ycombinator.com' || hostname.endsWith('.ycombinator.com');
    } catch {
      return false;
    }
  });
}

function hasPolicyMetadata(row: ComputerActionRow): boolean {
  return (
    Boolean(row.policyDecisionId) &&
    Boolean(row.policyVersion) &&
    isRecord(row.helmDocumentVersionPins) &&
    Object.keys(row.helmDocumentVersionPins).length > 0
  );
}

function findBrowserEvidence(row: EvidenceItemRow): boolean {
  return Boolean(
    row.browserObservationId &&
    row.evidenceType === 'browser_observation' &&
    row.auditEventId &&
    row.replayRef &&
    hasMetadataValue(row.metadata, 'credentialBoundary', BROWSER_CREDENTIAL_BOUNDARY) &&
    hasMetadataString(row.metadata, 'helmDecisionId') &&
    hasMetadataString(row.metadata, 'helmPolicyVersion'),
  );
}

function findHelmReceiptEvidence(
  rows: EvidenceItemRow[],
  pack: EvidencePackRow,
): EvidenceItemRow | undefined {
  return rows.find(
    (row) =>
      row.evidencePackId === pack.id &&
      row.evidenceType === 'helm_receipt' &&
      row.auditEventId &&
      row.replayRef === `helm:${pack.decisionId}` &&
      row.contentHash === pack.decisionHash &&
      hasMetadataValue(row.metadata, 'decisionId', pack.decisionId) &&
      hasMetadataValue(row.metadata, 'policyVersion', pack.policyVersion) &&
      hasMetadataValue(row.metadata, 'action', pack.action) &&
      hasMetadataValue(row.metadata, 'resource', pack.resource) &&
      hasMetadataValue(row.metadata, 'principal', pack.principal),
  );
}

function findComputerEvidence(
  rows: EvidenceItemRow[],
  computerActionId: string,
): EvidenceItemRow | undefined {
  return rows.find(
    (row) =>
      row.computerActionId === computerActionId &&
      row.evidenceType === 'computer_action' &&
      row.auditEventId &&
      row.replayRef,
  );
}

function findHelmReceiptAudit(
  rows: AuditRow[],
  auditEventId: string | null,
  pack: EvidencePackRow,
): AuditRow | undefined {
  if (!auditEventId) return undefined;
  return rows.find(
    (row) =>
      row.id === auditEventId &&
      row.action === 'HELM_RECEIPT_PERSISTED' &&
      row.target === pack.decisionId &&
      normalizeVerdict(row.verdict) === normalizeVerdict(pack.verdict) &&
      hasMetadataValue(row.metadata, 'evidencePackId', pack.id) &&
      hasMetadataValue(row.metadata, 'decisionId', pack.decisionId) &&
      hasMetadataValue(row.metadata, 'policyVersion', pack.policyVersion) &&
      hasMetadataValue(row.metadata, 'action', pack.action) &&
      hasMetadataValue(row.metadata, 'resource', pack.resource) &&
      hasMetadataValue(row.metadata, 'principal', pack.principal),
  );
}

function findComputerAudit(rows: AuditRow[], auditEventId: string | null): AuditRow | undefined {
  if (!auditEventId) return undefined;
  return rows.find((row) => row.id === auditEventId && row.action === 'OPERATOR_COMPUTER_USE');
}

function evidenceRef(row: EvidenceItemRow): string {
  return row.replayRef ?? `evidence:${row.id}`;
}

function auditRef(row: AuditRow): string {
  return `audit:${row.id}`;
}

function evidencePackRef(row: EvidencePackRow): string {
  return `helm:${row.decisionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasMetadataString(metadata: unknown, key: string): boolean {
  return isRecord(metadata) && typeof metadata[key] === 'string' && metadata[key].length > 0;
}

function stringMetadata(metadata: unknown, key: string): string | null {
  return isRecord(metadata) && typeof metadata[key] === 'string' ? metadata[key] : null;
}

function hasMetadataValue(metadata: unknown, key: string, expected: string): boolean {
  return isRecord(metadata) && metadata[key] === expected;
}

function hasMetadataNumber(metadata: unknown, key: string, expected: number): boolean {
  return isRecord(metadata) && metadata[key] === expected;
}

function metadataArrayIncludes(metadata: unknown, key: string, expected: string): boolean {
  return isRecord(metadata) && Array.isArray(metadata[key]) && metadata[key].includes(expected);
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function normalizeVerdict(verdict: string): string {
  return verdict.trim().toLowerCase();
}

function isScoreNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function hasPolicyPin(
  policyDecisionId: string | null,
  policyVersion: string | null,
  helmDocumentVersionPins: unknown,
): boolean {
  return Boolean(
    policyDecisionId &&
    policyVersion &&
    isRecord(helmDocumentVersionPins) &&
    Object.keys(helmDocumentVersionPins).length > 0,
  );
}

function isDecisionHash(value: string | null): boolean {
  return typeof value === 'string' && /^[a-f0-9]{32,}$/u.test(value);
}

function isSha256ContentHash(value: string | null): boolean {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

function isNonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

function arrayContainsAll(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && expected.every((entry) => value.includes(entry));
}

function getStringArray(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function getArrayLength(metadata: Record<string, unknown>, key: string): number {
  const value = metadata[key];
  return Array.isArray(value) ? value.length : 0;
}

function helmReceiptStepMetadata(pack: EvidencePackRow): Record<string, string | null> {
  return {
    evidencePackId: pack.id,
    decisionId: pack.decisionId,
    verdict: pack.verdict,
    policyVersion: pack.policyVersion,
    action: pack.action,
    resource: pack.resource,
    decisionHash: pack.decisionHash,
  };
}

function decisionCourtStepMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const calls = Array.isArray(metadata['modelCalls']) ? metadata['modelCalls'] : [];
  return {
    mode: metadata['mode'],
    status: metadata['status'],
    promptVersion: metadata['promptVersion'],
    participantCount: new Set(
      calls
        .map((call) =>
          isRecord(call) && typeof call['participant'] === 'string' ? call['participant'] : '',
        )
        .filter(Boolean),
    ).size,
    modelCallCount: calls.length,
    policyDecisionIds: getStringArray(metadata, 'policyDecisionIds'),
    policyVersions: getStringArray(metadata, 'policyVersions'),
  };
}

function pmfDiscoveryStepMetadata(
  score: OpportunityScoreRow,
  execution: ToolExecutionRow,
): Record<string, unknown> {
  const output = isRecord(execution.sanitizedOutput) ? execution.sanitizedOutput : {};
  return {
    opportunityId: score.opportunityId,
    scoreId: score.id,
    toolExecutionId: execution.id,
    scoringMethod: score.scoringMethod,
    overallScore: score.overallScore,
    founderFitScore: score.founderFitScore,
    marketSignal: score.marketSignal,
    feasibility: score.feasibility,
    timing: score.timing,
    citationCount: getArrayLength(output, 'citations'),
    assumptionCount: getArrayLength(output, 'assumptions'),
    policyDecisionId: execution.policyDecisionId,
    policyVersion: execution.policyVersion,
  };
}
