import { describe, expect, it, vi } from 'vitest';
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
  deployTargets,
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
import { PRODUCTION_READY_EXECUTION_MODE } from '@pilot/shared/eval';
import { createProductionEvalRunner } from '../../services/production-eval-runner.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const browserCredentialBoundary = 'read_only_no_cookie_or_password_export';
const fullStartupStages = [
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
type DeployTargetRow = typeof deployTargets.$inferSelect;
type DeploymentRow = typeof deployments.$inferSelect;
type DeployHealthRow = typeof deployHealth.$inferSelect;
type OpportunityRow = typeof opportunities.$inferSelect;
type OpportunityScoreRow = typeof opportunityScores.$inferSelect;
type ToolExecutionRow = typeof toolExecutions.$inferSelect;

function createRunnerDb({
  actions = [],
  browser = [],
  packs = [],
  evidence = [],
  audits = [],
  a2aThreadRows = [],
  a2aMessageRows = [],
  missionRows = [],
  missionNodeRows = [],
  missionEdgeRows = [],
  missionTaskRows = [],
  taskRows = [],
  taskRunRows = [],
  handoffRows = [],
  artifactRows = [],
  deployTargetRows = [],
  deploymentRows = [],
  deployHealthRows = [],
  opportunityRows = [],
  scoreRows = [],
  toolExecutionRows = [],
}: {
  actions?: ComputerActionRow[];
  browser?: BrowserObservationRow[];
  packs?: EvidencePackRow[];
  evidence?: EvidenceItemRow[];
  audits?: AuditRow[];
  a2aThreadRows?: A2aThreadRow[];
  a2aMessageRows?: A2aMessageRow[];
  missionRows?: MissionRow[];
  missionNodeRows?: MissionNodeRow[];
  missionEdgeRows?: MissionEdgeRow[];
  missionTaskRows?: MissionTaskRow[];
  taskRows?: TaskRow[];
  taskRunRows?: TaskRunRow[];
  handoffRows?: AgentHandoffRow[];
  artifactRows?: ArtifactRow[];
  deployTargetRows?: DeployTargetRow[];
  deploymentRows?: DeploymentRow[];
  deployHealthRows?: DeployHealthRow[];
  opportunityRows?: OpportunityRow[];
  scoreRows?: OpportunityScoreRow[];
  toolExecutionRows?: ToolExecutionRow[];
}) {
  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const result =
          table === computerActions
            ? actions
            : table === browserObservations
              ? browser
              : table === evidencePacks
                ? packs
                : table === evidenceItems
                  ? evidence
                  : table === auditLog
                    ? audits
                    : table === a2aThreads
                      ? a2aThreadRows
                      : table === a2aMessages
                        ? a2aMessageRows
                        : table === missions
                          ? missionRows
                          : table === missionNodes
                            ? missionNodeRows
                            : table === missionEdges
                              ? missionEdgeRows
                              : table === missionTasks
                                ? missionTaskRows
                                : table === tasks
                                  ? taskRows
                                  : table === taskRuns
                                    ? taskRunRows
                                    : table === agentHandoffs
                                      ? handoffRows
                                      : table === artifacts
                                        ? artifactRows
                                        : table === deployTargets
                                          ? deployTargetRows
                                          : table === deployments
                                            ? deploymentRows
                                            : table === deployHealth
                                              ? deployHealthRows
                                              : table === opportunities
                                                ? opportunityRows
                                                : table === opportunityScores
                                                  ? scoreRows
                                                  : table === toolExecutions
                                                    ? toolExecutionRows
                                                    : [];
        const chain = {
          where: vi.fn(() => chain),
          orderBy: vi.fn(() => chain),
          limit: vi.fn(async () => result),
          then: (resolve: (value: unknown[]) => void) => resolve(result),
        };
        return chain;
      }),
    })),
  };
  return db as unknown as Db;
}

function opportunity(overrides: Partial<OpportunityRow>): OpportunityRow {
  return {
    id: 'opp-pmf-1',
    workspaceId,
    source: 'manual',
    sourceUrl: 'https://example.com/customer-discovery',
    title: 'Compliance teams need urgent workflow automation',
    description:
      'Compliance operators have painful manual workflows, deadlines, budgets, and expensive errors.',
    status: 'scored',
    rawData: { quote: 'manual workflow is too slow' },
    aiFriendlyOk: true,
    discoveredAt: new Date('2026-05-12T00:00:00.000Z'),
    createdAt: new Date('2026-05-12T00:00:00.000Z'),
    ...overrides,
  };
}

function opportunityScore(overrides: Partial<OpportunityScoreRow>): OpportunityScoreRow {
  return {
    id: 'score-pmf-1',
    opportunityId: 'opp-pmf-1',
    overallScore: 82,
    founderFitScore: 86,
    marketSignal: 80,
    feasibility: 77,
    timing: 84,
    scoringMethod: 'evidence_v1',
    policyDecisionId: 'score-decision-1',
    policyVersion: 'founder-ops-v1',
    helmDocumentVersionPins: { opportunityScorePrompt: 'opportunity-score.v1' },
    modelUsage: {},
    scoredAt: new Date('2026-05-12T00:02:00.000Z'),
    ...overrides,
  };
}

function opportunityScoreOutput(opportunityId = 'opp-pmf-1'): Record<string, unknown> {
  return {
    opportunityId,
    method: 'evidence_v1',
    overall: 82,
    dimensions: {
      marketPain: 84,
      urgency: 76,
      icpClarity: 80,
      monetization: 74,
      channelAccessibility: 70,
      competition: 68,
      founderFit: 86,
      technicalFeasibility: 77,
      evidenceQuality: 90,
      confidence: 84,
    },
    assumptions: ['Scores are directional until validated with customer discovery evidence.'],
    citations: [
      {
        url: 'https://example.com/customer-discovery',
        title: 'Customer discovery notes',
        note: 'Founder interview evidence.',
      },
    ],
    rationale: 'Evidence-backed score 82/100.',
  };
}

function toolExecution(overrides: Partial<ToolExecutionRow>): ToolExecutionRow {
  return {
    id: 'tool-execution-pmf-1',
    workspaceId,
    ventureId: null,
    missionId: null,
    actionId: 'action-pmf-score-1',
    taskRunId: null,
    toolKey: 'score_opportunity',
    inputHash: 'sha256:input',
    sanitizedInput: { opportunityId: 'opp-pmf-1' },
    outputHash: 'sha256:score-output',
    sanitizedOutput: opportunityScoreOutput(),
    status: 'completed',
    idempotencyKey: 'tool-broker-v1:workspace:task:score_opportunity',
    evidenceIds: ['evidence-pmf-score-tool'],
    policyDecisionId: 'score-decision-1',
    policyVersion: 'founder-ops-v1',
    helmDocumentVersionPins: { toolAccessPolicy: 'founder-ops-v1' },
    error: null,
    createdAt: new Date('2026-05-12T00:01:00.000Z'),
    completedAt: new Date('2026-05-12T00:02:00.000Z'),
    ...overrides,
  };
}

function missionRow(overrides: Partial<MissionRow> = {}): MissionRow {
  return {
    id: 'mission-full-startup-1',
    workspaceId,
    ventureId: 'venture-full-startup-1',
    goalId: 'goal-full-startup-1',
    missionKey: 'startup-launch-full-1',
    title: 'Launch evidence automation startup',
    status: 'completed',
    compilerVersion: 'startup-lifecycle.v1',
    autonomyMode: 'review',
    capabilityState: 'prototype',
    productionReady: false,
    assumptions: ['External legal and payment actions require approval.'],
    blockers: [],
    metadata: { templateKey: 'full_startup_launch' },
    createdAt: new Date('2026-05-12T00:00:00.000Z'),
    updatedAt: new Date('2026-05-12T00:20:00.000Z'),
    startedAt: new Date('2026-05-12T00:01:00.000Z'),
    completedAt: new Date('2026-05-12T00:20:00.000Z'),
    ...overrides,
  };
}

function missionNodeRow(overrides: Partial<MissionNodeRow>): MissionNodeRow {
  return {
    id: 'mission-node-1',
    workspaceId,
    missionId: 'mission-full-startup-1',
    nodeKey: 'founder_onboarding',
    stage: 'founder_onboarding',
    title: 'Founder onboarding',
    objective: 'Gather launch constraints',
    status: 'completed',
    sortOrder: 1,
    requiredAgents: ['founder_operator'],
    requiredSkills: ['startup_lifecycle'],
    requiredTools: ['tool_broker'],
    requiredEvidence: ['run summary'],
    helmPolicyClasses: ['audit'],
    escalationConditions: ['restricted action'],
    acceptanceCriteria: ['Evidence recorded'],
    metadata: {},
    createdAt: new Date('2026-05-12T00:00:00.000Z'),
    updatedAt: new Date('2026-05-12T00:10:00.000Z'),
    startedAt: new Date('2026-05-12T00:01:00.000Z'),
    completedAt: new Date('2026-05-12T00:10:00.000Z'),
    ...overrides,
  };
}

function missionEdgeRow(overrides: Partial<MissionEdgeRow>): MissionEdgeRow {
  return {
    id: 'mission-edge-1',
    workspaceId,
    missionId: 'mission-full-startup-1',
    edgeKey: 'founder_onboarding->ideation',
    fromNodeKey: 'founder_onboarding',
    toNodeKey: 'ideation',
    reason: 'Sequential lifecycle dependency',
    metadata: {},
    createdAt: new Date('2026-05-12T00:00:00.000Z'),
    ...overrides,
  };
}

function missionTaskRow(overrides: Partial<MissionTaskRow>): MissionTaskRow {
  return {
    id: 'mission-task-1',
    workspaceId,
    missionId: 'mission-full-startup-1',
    nodeId: 'mission-node-1',
    taskId: 'task-full-startup-1',
    role: 'startup_lifecycle_node',
    createdAt: new Date('2026-05-12T00:00:00.000Z'),
    ...overrides,
  };
}

function artifactRow(overrides: Partial<ArtifactRow> = {}): ArtifactRow {
  return {
    id: 'artifact-landing-page-1',
    workspaceId,
    type: 'landing_page',
    name: 'Launch landing page',
    description: 'MVP launch landing page artifact',
    storagePath: 'artifacts/landing/index.html',
    mimeType: 'text/html',
    sizeBytes: 2048,
    metadata: { missionId: 'mission-full-startup-1' },
    currentVersion: 1,
    createdAt: new Date('2026-05-12T00:12:00.000Z'),
    updatedAt: new Date('2026-05-12T00:12:00.000Z'),
    ...overrides,
  };
}

function deployTargetRow(overrides: Partial<DeployTargetRow> = {}): DeployTargetRow {
  return {
    id: 'deploy-target-1',
    workspaceId,
    name: 'digitalocean-production',
    provider: 'digitalocean',
    config: {
      domain: 'launch.example.com',
      dnsProvider: 'cloudflare',
      dnsRecordRef: 'dns-record-launch-1',
    },
    isActive: true,
    createdAt: new Date('2026-05-12T00:10:00.000Z'),
    updatedAt: new Date('2026-05-12T00:10:00.000Z'),
    ...overrides,
  };
}

function deploymentRow(overrides: Partial<DeploymentRow> = {}): DeploymentRow {
  return {
    id: 'deployment-full-startup-1',
    workspaceId,
    targetId: 'deploy-target-1',
    artifactId: 'artifact-landing-page-1',
    status: 'live',
    version: 'launch-v1',
    url: 'https://launch.example.com',
    metadata: { providerDeploymentId: 'provider-deployment-1' },
    startedAt: new Date('2026-05-12T00:14:00.000Z'),
    completedAt: new Date('2026-05-12T00:16:00.000Z'),
    ...overrides,
  };
}

function deployHealthRow(overrides: Partial<DeployHealthRow> = {}): DeployHealthRow {
  return {
    id: 'deploy-health-full-startup-1',
    deploymentId: 'deployment-full-startup-1',
    status: 'healthy',
    checkedAt: new Date('2026-05-12T00:17:00.000Z'),
    responseTimeMs: '120',
    details: { statusCode: 200 },
    ...overrides,
  };
}

function browserObservation(overrides: Partial<BrowserObservationRow>): BrowserObservationRow {
  return {
    id: 'browser-observation-1',
    workspaceId,
    sessionId: '00000000-0000-4000-8000-000000000011',
    grantId: '00000000-0000-4000-8000-000000000012',
    browserActionId: '00000000-0000-4000-8000-000000000013',
    taskId: null,
    actionId: null,
    evidencePackId: null,
    url: 'https://www.ycombinator.com/companies',
    origin: 'https://www.ycombinator.com',
    title: 'YC Companies',
    objective: 'Extract YC company data',
    domHash: 'sha256:dom',
    screenshotHash: 'sha256:screenshot',
    screenshotRef: null,
    redactedDomSnapshot: '<html>[REDACTED]</html>',
    extractedData: { company: 'Pilot', batch: 'S26' },
    redactions: ['token'],
    replayIndex: 3,
    metadata: {
      credentialBoundary: browserCredentialBoundary,
      helmDecisionId: 'browser-decision-1',
      helmPolicyVersion: 'founder-ops-v1',
    },
    observedAt: new Date('2026-05-12T00:01:00.000Z'),
    createdAt: new Date('2026-05-12T00:01:00.000Z'),
    ...overrides,
  };
}

function computerAction(overrides: Partial<ComputerActionRow>): ComputerActionRow {
  return {
    id: 'computer-action-1',
    workspaceId,
    taskId: null,
    toolActionId: null,
    operatorId: null,
    actionType: 'terminal_command',
    environment: 'sandbox',
    objective: 'Run safe action',
    status: 'completed',
    cwd: '.',
    command: 'pwd',
    args: [],
    filePath: null,
    devServerUrl: null,
    stdout: 'ok',
    stderr: null,
    exitCode: 0,
    durationMs: 5,
    fileDiff: null,
    outputHash: 'sha256:abc',
    policyDecisionId: 'decision-1',
    policyVersion: 'founder-ops-v1',
    helmDocumentVersionPins: { computerUsePolicy: 'founder-ops-v1' },
    evidencePackId: null,
    replayIndex: 0,
    metadata: {},
    createdAt: new Date('2026-05-12T00:00:00.000Z'),
    completedAt: new Date('2026-05-12T00:01:00.000Z'),
    ...overrides,
  };
}

function helmReceiptPack(overrides: Partial<EvidencePackRow>): EvidencePackRow {
  return {
    id: 'evidence-pack-1',
    workspaceId,
    decisionId: 'helm-decision-1',
    taskRunId: null,
    verdict: 'allow',
    reasonCode: 'policy allowed',
    policyVersion: 'founder-ops-v1',
    decisionHash: 'a'.repeat(64),
    action: 'TOOL_USE',
    resource: 'tool:example',
    principal: `workspace:${workspaceId}/operator:op-1`,
    signedBlob: null,
    receivedAt: new Date('2026-05-12T00:01:00.000Z'),
    verifiedAt: null,
    parentEvidencePackId: null,
    ...overrides,
  };
}

function evidenceItem(overrides: Partial<EvidenceItemRow>): EvidenceItemRow {
  return {
    id: 'evidence-1',
    workspaceId,
    ventureId: null,
    missionId: null,
    taskId: null,
    taskRunId: null,
    actionId: null,
    toolExecutionId: null,
    evidencePackId: null,
    browserObservationId: null,
    computerActionId: 'computer-action-1',
    artifactId: null,
    auditEventId: 'audit-1',
    evidenceType: 'computer_action',
    sourceType: 'computer_operator',
    title: 'Computer action',
    summary: 'Safe action',
    redactionState: 'redacted',
    sensitivity: 'sensitive',
    contentHash: 'sha256:abc',
    storageRef: null,
    replayRef: 'computer:computer-action-1:0',
    metadata: {},
    observedAt: new Date('2026-05-12T00:01:00.000Z'),
    createdAt: new Date('2026-05-12T00:01:00.000Z'),
    ...overrides,
  };
}

function auditRow(overrides: Partial<AuditRow>): AuditRow {
  return {
    id: 'audit-1',
    workspaceId,
    action: 'OPERATOR_COMPUTER_USE',
    actor: 'agent',
    target: 'computer-action-1',
    verdict: 'allow',
    reason: null,
    metadata: {},
    createdAt: new Date('2026-05-12T00:01:00.000Z'),
    ...overrides,
  };
}

function a2aThreadRow(overrides: Partial<A2aThreadRow>): A2aThreadRow {
  return {
    id: 'a2a-thread-1',
    workspaceId,
    externalTaskId: 'external-parallel-build-1',
    pilotTaskId: 'task-foundation-1',
    status: 'completed',
    metadata: {
      conductStatus: 'completed',
      dispatchEvidenceItemId: 'evidence-a2a-dispatch',
      restartVerified: true,
    },
    createdAt: new Date('2026-05-12T00:00:00.000Z'),
    updatedAt: new Date('2026-05-12T00:05:00.000Z'),
    completedAt: new Date('2026-05-12T00:05:00.000Z'),
    ...overrides,
  };
}

function a2aMessageRow(overrides: Partial<A2aMessageRow>): A2aMessageRow {
  return {
    id: 'a2a-message-1',
    threadId: 'a2a-thread-1',
    workspaceId,
    role: 'user',
    parts: [{ type: 'text', text: 'Build MVP and landing page in parallel' }],
    sequence: 1,
    createdAt: new Date('2026-05-12T00:00:00.000Z'),
    ...overrides,
  };
}

function taskRow(overrides: Partial<TaskRow>): TaskRow {
  return {
    id: 'task-foundation-1',
    workspaceId,
    operatorId: null,
    parentTaskId: null,
    title: 'Foundation proof task',
    description: 'Verify lineage and replay invariants',
    mode: 'autonomous',
    status: 'running',
    priority: 0,
    metadata: {},
    createdAt: new Date('2026-05-12T00:00:00.000Z'),
    updatedAt: new Date('2026-05-12T00:00:00.000Z'),
    completedAt: null,
    ...overrides,
  };
}

function taskRunRow(overrides: Partial<TaskRunRow>): TaskRunRow {
  return {
    id: 'task-run-parent-1',
    taskId: 'task-foundation-1',
    status: 'completed',
    actionTool: 'search_knowledge',
    actionInput: { query: 'customers' },
    actionHash: 'sha256:action',
    actionOutput: { ok: true },
    verdict: 'allow',
    iterationsUsed: 1,
    iterationBudget: 50,
    modelUsed: 'test-model',
    tokensIn: 10,
    tokensOut: 20,
    costUsd: '0.0000',
    error: null,
    helmDecisionId: 'decision-parent-1',
    helmPolicyVersion: 'founder-ops-v1',
    helmReasonCode: null,
    parentTaskRunId: null,
    rootTaskRunId: null,
    spawnedByActionId: null,
    lineageKind: 'parent_action',
    runSequence: 1,
    checkpointId: null,
    operatorRole: null,
    budgetSliceUsed: '0.0000',
    budgetSliceAllocated: null,
    skillInvocations: [],
    startedAt: new Date('2026-05-12T00:01:00.000Z'),
    completedAt: new Date('2026-05-12T00:02:00.000Z'),
    checkpointState: null,
    lastCheckpointAt: null,
    watchdogAlertedAt: null,
    ...overrides,
  };
}

function agentHandoffRow(overrides: Partial<AgentHandoffRow>): AgentHandoffRow {
  return {
    id: 'handoff-1',
    workspaceId,
    taskId: 'task-foundation-1',
    parentTaskRunId: 'task-run-parent-1',
    childTaskRunId: 'task-run-spawn-1',
    fromAgent: 'orchestrator',
    toAgent: 'researcher',
    handoffKind: 'subagent_spawn',
    status: 'completed',
    skillInvocations: [],
    input: { task: 'research customer pain' },
    output: { summary: 'done' },
    createdAt: new Date('2026-05-12T00:03:00.000Z'),
    completedAt: new Date('2026-05-12T00:04:00.000Z'),
    ...overrides,
  };
}

function launchGovernanceMetadata(action: string, decisionId: string) {
  return {
    surface: 'launch',
    action,
    policyDecisionId: decisionId,
    policyVersion: 'founder-ops-v1',
    evidencePackId: `pack-${decisionId}`,
    policyPin: {
      policyDecisionId: decisionId,
      policyVersion: 'founder-ops-v1',
      decisionRequired: true,
      documentVersionPins: {
        deploymentPolicy: 'founder-ops-v1',
      },
    },
  };
}

function fullStartupLaunchFixture({ includeHealth = true }: { includeHealth?: boolean } = {}): {
  missionRows: MissionRow[];
  missionNodeRows: MissionNodeRow[];
  missionEdgeRows: MissionEdgeRow[];
  missionTaskRows: MissionTaskRow[];
  taskRows: TaskRow[];
  taskRunRows: TaskRunRow[];
  toolExecutionRows: ToolExecutionRow[];
  artifactRows: ArtifactRow[];
  deploymentRows: DeploymentRow[];
  deployHealthRows: DeployHealthRow[];
  evidence: EvidenceItemRow[];
  audits: AuditRow[];
} {
  const mission = missionRow();
  const nodes = fullStartupStages.map((stage, index) =>
    missionNodeRow({
      id: `mission-node-${stage}`,
      nodeKey: stage,
      stage,
      title: `Launch stage ${stage}`,
      sortOrder: index + 1,
    }),
  );
  const edges = fullStartupStages.slice(1).map((stage, index) =>
    missionEdgeRow({
      id: `mission-edge-${index + 1}`,
      edgeKey: `${fullStartupStages[index]}->${stage}`,
      fromNodeKey: fullStartupStages[index],
      toNodeKey: stage,
    }),
  );
  const taskRowsForMission = nodes.map((node, index) =>
    taskRow({
      id: `task-full-startup-${index + 1}`,
      title: `Task for ${node.nodeKey}`,
      status: 'completed',
      completedAt: new Date('2026-05-12T00:20:00.000Z'),
    }),
  );
  const taskLinks = nodes.map((node, index) =>
    missionTaskRow({
      id: `mission-task-${index + 1}`,
      nodeId: node.id,
      taskId: taskRowsForMission[index]!.id,
    }),
  );
  const runs = taskRowsForMission.map((task, index) =>
    taskRunRow({
      id: `task-run-full-startup-${index + 1}`,
      taskId: task.id,
      runSequence: index + 1,
      actionTool:
        index < 3
          ? ['search_knowledge', 'create_artifact', 'operator.computer_use'][index]!
          : 'finish',
      completedAt: new Date(`2026-05-12T00:${String(2 + index).padStart(2, '0')}:00.000Z`),
    }),
  );
  const executionToolKeys = ['search_knowledge', 'create_artifact', 'operator.computer_use'];
  const executionHashes = ['e', 'f', '1'];
  const executions = executionToolKeys.map((toolKey, index) =>
    toolExecution({
      id: `tool-execution-full-startup-${index + 1}`,
      actionId: `action-full-startup-${index + 1}`,
      taskRunId: runs[index]!.id,
      toolKey,
      inputHash: `sha256:launch-input-${index + 1}`,
      sanitizedInput: { stage: nodes[index]!.stage },
      outputHash: `sha256:${executionHashes[index]!.repeat(64)}`,
      sanitizedOutput: {
        evidenceKinds: index === 1 ? ['artifact_diff'] : ['agent_run_log'],
        artifactDiffRef: index === 1 ? 'artifact:artifact-landing-page-1:1' : undefined,
      },
      evidenceIds: [`evidence-tool-full-startup-${index + 1}`],
      policyDecisionId: `tool-decision-full-startup-${index + 1}`,
      policyVersion: 'founder-ops-v1',
      helmDocumentVersionPins: { toolAccessPolicy: 'founder-ops-v1' },
      completedAt: new Date(`2026-05-12T00:${String(5 + index).padStart(2, '0')}:00.000Z`),
    }),
  );
  const artifact = artifactRow();
  const deployment = deploymentRow();
  const health = deployHealthRow();
  const persistHash = `sha256:${'2'.repeat(64)}`;
  const checkpointHash = `sha256:${'3'.repeat(64)}`;
  const artifactHash = `sha256:${'4'.repeat(64)}`;
  const deployReplayRef = 'launch:workspace:deploy:audit-deploy-full-startup';
  const healthReplayRef = 'launch:workspace:deploy_health_check:audit-health-full-startup';
  const deploymentGovernance = launchGovernanceMetadata('DEPLOY', 'deploy-decision-full-startup');
  const healthGovernance = launchGovernanceMetadata(
    'DEPLOY_HEALTH_CHECK',
    'health-decision-full-startup',
  );
  const toolEvidence = executions.map((execution, index) =>
    evidenceItem({
      id: `evidence-tool-full-startup-${index + 1}`,
      computerActionId: null,
      actionId: execution.actionId,
      taskRunId: execution.taskRunId,
      toolExecutionId: execution.id,
      evidenceType: 'tool_execution_completed',
      sourceType: 'tool_broker',
      auditEventId: `audit-tool-full-startup-${index + 1}`,
      contentHash: execution.outputHash,
      replayRef: `tool:${execution.id}`,
      metadata: {
        broker: 'tool_broker_v1',
        toolKey: execution.toolKey,
        toolExecutionId: execution.id,
        status: 'completed',
        policyDecisionId: execution.policyDecisionId,
        policyVersion: execution.policyVersion,
      },
    }),
  );
  const toolAudits = executions.map((execution, index) =>
    auditRow({
      id: `audit-tool-full-startup-${index + 1}`,
      action: 'TOOL_EXECUTION',
      target: execution.toolKey,
      verdict: 'allow',
      metadata: {
        broker: 'tool_broker_v1',
        toolKey: execution.toolKey,
        toolExecutionId: execution.id,
        evidenceItemId: `evidence-tool-full-startup-${index + 1}`,
        policyDecisionId: execution.policyDecisionId,
        policyVersion: execution.policyVersion,
      },
    }),
  );

  return {
    missionRows: [mission],
    missionNodeRows: nodes,
    missionEdgeRows: edges,
    missionTaskRows: taskLinks,
    taskRows: taskRowsForMission,
    taskRunRows: runs,
    toolExecutionRows: executions,
    artifactRows: [artifact],
    deploymentRows: [deployment],
    deployHealthRows: includeHealth ? [health] : [],
    evidence: [
      evidenceItem({
        id: 'evidence-full-startup-persist',
        computerActionId: null,
        ventureId: mission.ventureId,
        missionId: mission.id,
        evidenceType: 'startup_lifecycle_mission_persisted',
        sourceType: 'gateway_startup_lifecycle',
        auditEventId: null,
        sensitivity: 'internal',
        contentHash: persistHash,
        replayRef: `mission:${mission.id}:persisted`,
        metadata: {
          compilerVersion: 'startup-lifecycle.v1',
          autonomyMode: 'review',
          capabilityState: 'prototype',
          productionReady: false,
          nodeCount: nodes.length,
          edgeCount: edges.length,
          taskCount: taskLinks.length,
          source: 'startup_lifecycle_persist',
        },
      }),
      evidenceItem({
        id: 'evidence-full-startup-checkpoint',
        computerActionId: null,
        ventureId: mission.ventureId,
        missionId: mission.id,
        evidenceType: 'startup_lifecycle_mission_checkpoint',
        sourceType: 'gateway_startup_lifecycle',
        auditEventId: 'audit-full-startup-checkpoint',
        sensitivity: 'internal',
        contentHash: checkpointHash,
        replayRef: `mission:${mission.id}:checkpoint:completed`,
        metadata: {
          checkpointVersion: 'mission-checkpoint.v1',
          checkpointId: 'checkpoint-full-startup-completed',
          missionStatus: 'completed',
          nodeCount: nodes.length,
          edgeCount: edges.length,
          taskLinkCount: taskLinks.length,
          nodeStatuses: { completed: nodes.length },
          snapshot: {
            nodes: nodes.map((node) => ({ nodeKey: node.nodeKey, status: node.status })),
          },
          productionReady: false,
        },
      }),
      evidenceItem({
        id: 'evidence-full-startup-artifact',
        computerActionId: null,
        artifactId: artifact.id,
        evidenceType: 'artifact_created',
        sourceType: 'tool_registry',
        auditEventId: 'audit-full-startup-artifact',
        sensitivity: 'internal',
        contentHash: artifactHash,
        storageRef: artifact.storagePath,
        replayRef: `artifact:${artifact.id}:1`,
        metadata: {
          artifactType: artifact.type,
          version: 1,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
          storageMode: 'inline_artifact_metadata',
          tool: 'create_artifact',
        },
      }),
      evidenceItem({
        id: 'evidence-full-startup-deploy',
        computerActionId: null,
        evidenceType: 'launch_deployment_requested',
        sourceType: 'gateway_launch',
        auditEventId: 'audit-full-startup-deploy',
        sensitivity: 'restricted',
        contentHash: null,
        replayRef: deployReplayRef,
        metadata: {
          evidenceType: 'launch_deployment_requested',
          replayRef: deployReplayRef,
          action: 'DEPLOY',
          executionStatus: 'pending',
          targetId: deployment.targetId,
          provider: 'digitalocean',
          imageProvided: true,
          secretValuesStoredInEvidence: false,
          governance: deploymentGovernance,
        },
      }),
      evidenceItem({
        id: 'evidence-full-startup-health',
        computerActionId: null,
        evidenceType: 'launch_deployment_health_check_requested',
        sourceType: 'gateway_launch',
        auditEventId: 'audit-full-startup-health',
        sensitivity: 'restricted',
        contentHash: null,
        replayRef: healthReplayRef,
        metadata: {
          evidenceType: 'launch_deployment_health_check_requested',
          replayRef: healthReplayRef,
          action: 'DEPLOY_HEALTH_CHECK',
          executionStatus: 'pending',
          deploymentId: deployment.id,
          healthCheckId: health.id,
          secretValuesStoredInEvidence: false,
          governance: healthGovernance,
        },
      }),
      ...toolEvidence,
    ],
    audits: [
      auditRow({
        id: 'audit-full-startup-checkpoint',
        action: 'STARTUP_LIFECYCLE_MISSION_CHECKPOINT',
        target: mission.id,
        verdict: 'recorded',
        metadata: {
          evidenceItemId: 'evidence-full-startup-checkpoint',
          evidenceType: 'startup_lifecycle_mission_checkpoint',
          checkpointVersion: 'mission-checkpoint.v1',
          checkpointId: 'checkpoint-full-startup-completed',
          missionStatus: 'completed',
          replayRef: `mission:${mission.id}:checkpoint:completed`,
          contentHash: checkpointHash,
        },
      }),
      auditRow({
        id: 'audit-full-startup-artifact',
        action: 'ARTIFACT_CREATED',
        target: artifact.id,
        verdict: 'created',
        metadata: {
          evidenceItemId: 'evidence-full-startup-artifact',
          evidenceType: 'artifact_created',
          replayRef: `artifact:${artifact.id}:1`,
          artifactId: artifact.id,
          artifactType: artifact.type,
          version: 1,
        },
      }),
      auditRow({
        id: 'audit-full-startup-deploy',
        action: 'DEPLOY',
        target: `digitalocean:${deployment.targetId}`,
        verdict: 'allow',
        metadata: {
          evidenceItemId: 'evidence-full-startup-deploy',
          evidenceType: 'launch_deployment_requested',
          replayRef: deployReplayRef,
          action: 'DEPLOY',
          executionStatus: 'completed',
          deploymentId: deployment.id,
          providerDeploymentId: 'provider-deployment-1',
          providerStatus: 'live',
          urlRecorded: true,
          governance: deploymentGovernance,
        },
      }),
      auditRow({
        id: 'audit-full-startup-health',
        action: 'DEPLOY_HEALTH_CHECK',
        target: deployment.id,
        verdict: 'allow',
        metadata: {
          evidenceItemId: 'evidence-full-startup-health',
          evidenceType: 'launch_deployment_health_check_requested',
          replayRef: healthReplayRef,
          action: 'DEPLOY_HEALTH_CHECK',
          executionStatus: 'completed',
          deploymentId: deployment.id,
          healthStatus: health.status,
          providerStatus: 'healthy',
          governance: healthGovernance,
        },
      }),
      ...toolAudits,
    ],
  };
}

function domainToDeploymentFixture({
  includeRollback = true,
}: { includeRollback?: boolean } = {}): {
  actions: ComputerActionRow[];
  browser: BrowserObservationRow[];
  deployTargetRows: DeployTargetRow[];
  artifactRows: ArtifactRow[];
  deploymentRows: DeploymentRow[];
  deployHealthRows: DeployHealthRow[];
  evidence: EvidenceItemRow[];
  audits: AuditRow[];
} {
  const target = deployTargetRow();
  const artifact = artifactRow({
    id: 'artifact-domain-landing-1',
    metadata: { evalId: 'domain_to_deployment' },
  });
  const deployment = deploymentRow({
    id: 'deployment-domain-1',
    targetId: target.id,
    artifactId: artifact.id,
    url: 'https://launch.example.com',
    metadata: {
      providerId: 'do-app-domain-1',
      providerDeploymentId: 'provider-domain-deployment-1',
      governance: launchGovernanceMetadata('DEPLOY', 'deploy-decision-domain-1'),
    },
  });
  const health = deployHealthRow({
    id: 'deploy-health-domain-1',
    deploymentId: deployment.id,
  });
  const buildAction = computerAction({
    id: 'computer-domain-build-1',
    objective: 'Build landing page for domain-to-deployment eval',
    command: 'npm',
    args: ['run', 'build'],
    outputHash: `sha256:${'b'.repeat(64)}`,
    policyDecisionId: 'computer-build-decision-domain-1',
    policyVersion: 'founder-ops-v1',
    metadata: {
      evalId: 'domain_to_deployment',
      stage: 'build',
      artifactId: artifact.id,
      deploymentId: deployment.id,
    },
  });
  const testAction = computerAction({
    id: 'computer-domain-test-1',
    objective: 'Run test gate for domain-to-deployment eval',
    command: 'npm',
    args: ['test'],
    outputHash: `sha256:${'c'.repeat(64)}`,
    policyDecisionId: 'computer-test-decision-domain-1',
    policyVersion: 'founder-ops-v1',
    metadata: {
      evalId: 'domain_to_deployment',
      stage: 'test',
      artifactId: artifact.id,
      deploymentId: deployment.id,
    },
  });
  const browser = browserObservation({
    id: 'browser-observation-domain-1',
    url: deployment.url!,
    origin: 'https://launch.example.com',
    title: 'Launch landing page',
    objective: 'Verify live deployment renders',
    domHash: `sha256:${'d'.repeat(64)}`,
    screenshotHash: `sha256:${'5'.repeat(64)}`,
    screenshotRef: 'browser/domain-to-deployment/screenshot.png',
    redactedDomSnapshot: '<html><main>Launch</main></html>',
    extractedData: {
      headline: 'Launch evidence automation startup',
      deploymentId: deployment.id,
    },
    redactions: [],
    metadata: {
      credentialBoundary: browserCredentialBoundary,
      helmDecisionId: 'browser-decision-domain-1',
      helmPolicyVersion: 'founder-ops-v1',
      deploymentId: deployment.id,
    },
  });
  const deployReplayRef = 'launch:workspace:deploy:audit-domain-deploy';
  const healthReplayRef = 'launch:workspace:deploy_health_check:audit-domain-health';
  const rollbackReplayRef = `launch:${workspaceId}:deploy_rollback_plan:audit-domain-rollback-plan`;
  const deploymentGovernance = launchGovernanceMetadata('DEPLOY', 'deploy-decision-domain-1');
  const healthGovernance = launchGovernanceMetadata(
    'DEPLOY_HEALTH_CHECK',
    'health-decision-domain-1',
  );

  return {
    actions: [buildAction, testAction],
    browser: [browser],
    deployTargetRows: [target],
    artifactRows: [artifact],
    deploymentRows: [deployment],
    deployHealthRows: [health],
    evidence: [
      evidenceItem({
        id: 'evidence-domain-build',
        computerActionId: buildAction.id,
        evidenceType: 'computer_action',
        sourceType: 'operator_computer_use',
        auditEventId: 'audit-domain-build',
        contentHash: buildAction.outputHash,
        replayRef: `computer:${buildAction.id}:0`,
        metadata: {
          evalId: 'domain_to_deployment',
          stage: 'build',
          status: 'completed',
          artifactId: artifact.id,
          deploymentId: deployment.id,
        },
      }),
      evidenceItem({
        id: 'evidence-domain-test',
        computerActionId: testAction.id,
        evidenceType: 'computer_action',
        sourceType: 'operator_computer_use',
        auditEventId: 'audit-domain-test',
        contentHash: testAction.outputHash,
        replayRef: `computer:${testAction.id}:1`,
        metadata: {
          evalId: 'domain_to_deployment',
          stage: 'test',
          status: 'completed',
          artifactId: artifact.id,
          deploymentId: deployment.id,
        },
      }),
      evidenceItem({
        id: 'evidence-domain-target',
        computerActionId: null,
        evidenceType: 'deploy_target_created',
        sourceType: 'gateway_launch',
        auditEventId: 'audit-domain-target',
        sensitivity: 'restricted',
        contentHash: null,
        replayRef: `deploy-target:${workspaceId}:${target.id}:created`,
        metadata: {
          targetId: target.id,
          targetName: target.name,
          provider: target.provider,
          configKeys: ['dnsProvider', 'dnsRecordRef', 'domain'],
          configValuesStoredInEvidence: false,
        },
      }),
      evidenceItem({
        id: 'evidence-domain-artifact',
        computerActionId: null,
        artifactId: artifact.id,
        evidenceType: 'artifact_created',
        sourceType: 'tool_registry',
        auditEventId: 'audit-domain-artifact',
        sensitivity: 'internal',
        contentHash: `sha256:${'6'.repeat(64)}`,
        storageRef: artifact.storagePath,
        replayRef: `artifact:${artifact.id}:1`,
        metadata: {
          artifactType: artifact.type,
          version: 1,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
          storageMode: 'inline_artifact_metadata',
          tool: 'create_artifact',
        },
      }),
      evidenceItem({
        id: 'evidence-domain-deploy',
        computerActionId: null,
        evidenceType: 'launch_deployment_requested',
        sourceType: 'gateway_launch',
        auditEventId: 'audit-domain-deploy',
        sensitivity: 'restricted',
        contentHash: null,
        replayRef: deployReplayRef,
        metadata: {
          evidenceType: 'launch_deployment_requested',
          replayRef: deployReplayRef,
          action: 'DEPLOY',
          executionStatus: 'pending',
          targetId: target.id,
          provider: target.provider,
          imageProvided: true,
          secretValuesStoredInEvidence: false,
          governance: deploymentGovernance,
        },
      }),
      evidenceItem({
        id: 'evidence-domain-health',
        computerActionId: null,
        evidenceType: 'launch_deployment_health_check_requested',
        sourceType: 'gateway_launch',
        auditEventId: 'audit-domain-health',
        sensitivity: 'restricted',
        contentHash: null,
        replayRef: healthReplayRef,
        metadata: {
          evidenceType: 'launch_deployment_health_check_requested',
          replayRef: healthReplayRef,
          action: 'DEPLOY_HEALTH_CHECK',
          executionStatus: 'pending',
          deploymentId: deployment.id,
          healthCheckId: health.id,
          secretValuesStoredInEvidence: false,
          governance: healthGovernance,
        },
      }),
      evidenceItem({
        id: 'evidence-domain-browser',
        computerActionId: null,
        browserObservationId: browser.id,
        evidenceType: 'browser_observation',
        sourceType: 'gateway_browser_session',
        auditEventId: 'audit-domain-browser',
        sensitivity: 'sensitive',
        contentHash: browser.domHash,
        storageRef: browser.screenshotRef,
        replayRef: `browser:${browser.sessionId}:3`,
        metadata: {
          sessionId: browser.sessionId,
          grantId: browser.grantId,
          browserActionId: browser.browserActionId,
          url: browser.url,
          origin: browser.origin,
          credentialBoundary: browserCredentialBoundary,
          helmDecisionId: 'browser-decision-domain-1',
          helmPolicyVersion: 'founder-ops-v1',
          deploymentId: deployment.id,
        },
      }),
      ...(includeRollback
        ? [
            evidenceItem({
              id: 'evidence-domain-rollback-plan',
              computerActionId: null,
              evidenceType: 'launch_deployment_rollback_plan_recorded',
              sourceType: 'gateway_launch',
              auditEventId: 'audit-domain-rollback-plan',
              sensitivity: 'restricted',
              contentHash: `sha256:${'7'.repeat(64)}`,
              replayRef: rollbackReplayRef,
              metadata: {
                evidenceType: 'launch_deployment_rollback_plan_recorded',
                replayRef: rollbackReplayRef,
                deploymentId: deployment.id,
                targetVersion: 'launch-v0',
                rollbackPlanRef: 'artifact:rollback-plan-domain-1',
                secretValuesStoredInEvidence: false,
              },
            }),
          ]
        : []),
    ],
    audits: [
      auditRow({
        id: 'audit-domain-build',
        action: 'OPERATOR_COMPUTER_USE',
        target: buildAction.id,
        verdict: 'allow',
        metadata: {
          computerActionId: buildAction.id,
          evidenceItemId: 'evidence-domain-build',
          stage: 'build',
        },
      }),
      auditRow({
        id: 'audit-domain-test',
        action: 'OPERATOR_COMPUTER_USE',
        target: testAction.id,
        verdict: 'allow',
        metadata: {
          computerActionId: testAction.id,
          evidenceItemId: 'evidence-domain-test',
          stage: 'test',
        },
      }),
      auditRow({
        id: 'audit-domain-target',
        action: 'DEPLOY_TARGET_CREATED',
        target: target.id,
        verdict: 'allow',
        metadata: {
          evidenceType: 'deploy_target_created',
          evidenceItemId: 'evidence-domain-target',
          replayRef: `deploy-target:${workspaceId}:${target.id}:created`,
          targetId: target.id,
          targetName: target.name,
          provider: target.provider,
          configKeys: ['dnsProvider', 'dnsRecordRef', 'domain'],
          configValuesStoredInEvidence: false,
        },
      }),
      auditRow({
        id: 'audit-domain-artifact',
        action: 'ARTIFACT_CREATED',
        target: artifact.id,
        verdict: 'created',
        metadata: {
          evidenceItemId: 'evidence-domain-artifact',
          evidenceType: 'artifact_created',
          replayRef: `artifact:${artifact.id}:1`,
          artifactId: artifact.id,
          artifactType: artifact.type,
          version: 1,
        },
      }),
      auditRow({
        id: 'audit-domain-deploy',
        action: 'DEPLOY',
        target: `${target.provider}:${target.id}`,
        verdict: 'allow',
        metadata: {
          evidenceItemId: 'evidence-domain-deploy',
          evidenceType: 'launch_deployment_requested',
          replayRef: deployReplayRef,
          action: 'DEPLOY',
          executionStatus: 'completed',
          deploymentId: deployment.id,
          providerDeploymentId: 'provider-domain-deployment-1',
          providerStatus: 'live',
          urlRecorded: true,
          governance: deploymentGovernance,
        },
      }),
      auditRow({
        id: 'audit-domain-health',
        action: 'DEPLOY_HEALTH_CHECK',
        target: deployment.id,
        verdict: 'allow',
        metadata: {
          evidenceItemId: 'evidence-domain-health',
          evidenceType: 'launch_deployment_health_check_requested',
          replayRef: healthReplayRef,
          action: 'DEPLOY_HEALTH_CHECK',
          executionStatus: 'completed',
          deploymentId: deployment.id,
          healthStatus: health.status,
          providerStatus: 'healthy',
          governance: healthGovernance,
        },
      }),
      auditRow({
        id: 'audit-domain-browser',
        action: 'BROWSER_OBSERVATION_CAPTURED',
        actor: `browser:${browser.sessionId}`,
        target: browser.id,
        verdict: 'allow',
        metadata: {
          grantId: browser.grantId,
          browserActionId: browser.browserActionId,
          url: browser.url,
          origin: browser.origin,
          helmDecisionId: 'browser-decision-domain-1',
          helmPolicyVersion: 'founder-ops-v1',
          evidenceItemId: 'evidence-domain-browser',
        },
      }),
      ...(includeRollback
        ? [
            auditRow({
              id: 'audit-domain-rollback-plan',
              action: 'DEPLOY_ROLLBACK_PLAN',
              target: deployment.id,
              verdict: 'recorded',
              metadata: {
                evidenceItemId: 'evidence-domain-rollback-plan',
                evidenceType: 'launch_deployment_rollback_plan_recorded',
                replayRef: rollbackReplayRef,
                deploymentId: deployment.id,
                targetVersion: 'launch-v0',
                rollbackPlanRef: 'artifact:rollback-plan-domain-1',
              },
            }),
          ]
        : []),
    ],
  };
}

function stripeSetupPrepFixture({
  includePrepEvidence = true,
}: { includePrepEvidence?: boolean } = {}): {
  browser: BrowserObservationRow[];
  missionNodeRows: MissionNodeRow[];
  toolExecutionRows: ToolExecutionRow[];
  artifactRows: ArtifactRow[];
  evidence: EvidenceItemRow[];
  audits: AuditRow[];
} {
  const node = missionNodeRow({
    id: 'mission-node-stripe-setup-1',
    missionId: 'mission-stripe-setup-1',
    nodeKey: 'stripe_setup_prep',
    stage: 'stripe_setup_prep',
    title: 'Stripe setup preparation',
    objective: 'Prepare Stripe products, prices, webhook plan, and human-required gates.',
    requiredAgents: ['Finance Agent', 'Backend Engineer Agent', 'Legal Workflow Agent'],
    requiredSkills: ['payment_setup_planning', 'pricing_hypothesis', 'webhook_design'],
    requiredTools: ['stripe_connector', 'artifact_writer', 'browser_read_extract'],
    requiredEvidence: ['pricing rationale', 'Stripe setup checklist', 'human gate list'],
    helmPolicyClasses: ['financial', 'legal', 'credential_handling', 'audit'],
    escalationConditions: [
      'Identity verification, bank information, charges, payouts, or legal attestations are required',
    ],
    acceptanceCriteria: [
      'Stripe prep artifact exists',
      'Human-required steps are isolated',
      'No raw credentials or financial secrets are stored',
    ],
  });
  const humanGates = [
    'identity_verification',
    'bank_information',
    'payouts',
    'charges',
    'legal_attestation',
  ];
  const artifact = artifactRow({
    id: 'artifact-stripe-setup-prep-1',
    type: 'application',
    name: 'Stripe setup prep packet',
    description: 'Non-executing Stripe setup checklist, pricing rationale, and human gates.',
    storagePath: 'artifacts/stripe/setup-prep.md',
    mimeType: 'text/markdown',
    sizeBytes: 4096,
    metadata: {
      evalId: 'stripe_setup_prep',
      lifecycleStage: 'stripe_setup_prep',
      missionNodeId: node.id,
      pricingRationaleRef: 'artifact:stripe-pricing-rationale',
      stripeSetupChecklistRef: 'artifact:stripe-checklist',
      webhookPlanRef: 'artifact:stripe-webhook-plan',
      humanGateListRef: 'artifact:stripe-human-gates',
      productionReady: false,
      restrictedActionsExecuted: false,
      financialSecretsStoredInArtifact: false,
      rawConnectorSecretsStoredInArtifact: false,
    },
  });
  const execution = toolExecution({
    id: 'tool-execution-stripe-prep-1',
    actionId: 'action-stripe-prep-1',
    toolKey: 'stripe_setup_prep',
    inputHash: 'sha256:stripe-setup-input',
    sanitizedInput: { mode: 'stripe_setup_prep', missionNodeId: node.id },
    outputHash: `sha256:${'8'.repeat(64)}`,
    sanitizedOutput: {
      mode: 'stripe_setup_prep',
      missionNodeId: node.id,
      artifactId: artifact.id,
      productionReady: false,
      restrictedActionsExecuted: false,
      financialSecretsStoredInOutput: false,
      rawConnectorSecretsStoredInOutput: false,
      products: [{ name: 'Pilot monthly plan', mode: 'subscription' }],
      prices: [{ nickname: 'monthly', currency: 'usd', interval: 'month' }],
      webhookPlan: {
        endpoint: '/api/stripe/webhook',
        events: ['checkout.session.completed', 'customer.subscription.updated'],
      },
      setupChecklist: ['create product draft', 'define price draft', 'configure webhook draft'],
      humanGates,
      requiredEscalations: humanGates,
    },
    evidenceIds: ['evidence-stripe-tool'],
    policyDecisionId: 'stripe-financial-decision-1',
    policyVersion: 'founder-ops-v1',
    helmDocumentVersionPins: {
      financialPolicy: 'founder-ops-v1',
      credentialHandlingPolicy: 'founder-ops-v1',
    },
  });
  const browser = browserObservation({
    id: 'browser-observation-stripe-1',
    url: 'https://docs.stripe.com/payments/checkout',
    origin: 'https://docs.stripe.com',
    title: 'Stripe Checkout docs',
    objective: 'Read Stripe setup docs without exporting credentials',
    domHash: `sha256:${'9'.repeat(64)}`,
    screenshotHash: `sha256:${'a'.repeat(64)}`,
    screenshotRef: 'browser/stripe/setup-prep.png',
    redactedDomSnapshot: '<html><main>Stripe setup docs</main></html>',
    extractedData: {
      products: ['subscription'],
      pricingModels: ['monthly_recurring'],
      webhookEvents: ['checkout.session.completed', 'customer.subscription.updated'],
      humanGates,
    },
    redactions: [],
    metadata: {
      credentialBoundary: browserCredentialBoundary,
      helmDecisionId: 'stripe-browser-decision-1',
      helmPolicyVersion: 'founder-ops-v1',
      rawCookiesExported: false,
      rawFinancialSecretsStored: false,
    },
  });
  const prepReplayRef = `stripe-setup-prep:${node.id}`;

  return {
    browser: [browser],
    missionNodeRows: [node],
    toolExecutionRows: [execution],
    artifactRows: [artifact],
    evidence: [
      evidenceItem({
        id: 'evidence-stripe-tool',
        computerActionId: null,
        actionId: execution.actionId,
        toolExecutionId: execution.id,
        evidenceType: 'tool_execution_completed',
        sourceType: 'tool_broker',
        auditEventId: 'audit-stripe-tool',
        contentHash: execution.outputHash,
        replayRef: `tool:${execution.id}`,
        metadata: {
          broker: 'tool_broker_v1',
          toolKey: execution.toolKey,
          toolExecutionId: execution.id,
          status: 'completed',
          policyDecisionId: execution.policyDecisionId,
          policyVersion: execution.policyVersion,
          requiredEvidence: [
            'stripe_setup_checklist',
            'pricing_rationale',
            'webhook_plan',
            'human_gate_list',
          ],
          restrictedActionsExecuted: false,
          financialSecretsStoredInEvidence: false,
        },
      }),
      evidenceItem({
        id: 'evidence-stripe-browser',
        computerActionId: null,
        browserObservationId: browser.id,
        evidenceType: 'browser_observation',
        sourceType: 'gateway_browser_session',
        auditEventId: 'audit-stripe-browser',
        sensitivity: 'sensitive',
        contentHash: browser.domHash,
        storageRef: browser.screenshotRef,
        replayRef: `browser:${browser.sessionId}:3`,
        metadata: {
          sessionId: browser.sessionId,
          grantId: browser.grantId,
          browserActionId: browser.browserActionId,
          url: browser.url,
          origin: browser.origin,
          credentialBoundary: browserCredentialBoundary,
          helmDecisionId: 'stripe-browser-decision-1',
          helmPolicyVersion: 'founder-ops-v1',
        },
      }),
      evidenceItem({
        id: 'evidence-stripe-artifact',
        computerActionId: null,
        artifactId: artifact.id,
        evidenceType: 'artifact_created',
        sourceType: 'tool_registry',
        auditEventId: 'audit-stripe-artifact',
        sensitivity: 'internal',
        contentHash: `sha256:${'b'.repeat(64)}`,
        storageRef: artifact.storagePath,
        replayRef: `artifact:${artifact.id}:1`,
        metadata: {
          evalId: 'stripe_setup_prep',
          lifecycleStage: 'stripe_setup_prep',
          missionNodeId: node.id,
          artifactType: artifact.type,
          version: 1,
          tool: 'create_artifact',
          financialSecretsStoredInEvidence: false,
          rawConnectorSecretsStoredInEvidence: false,
        },
      }),
      ...(includePrepEvidence
        ? [
            evidenceItem({
              id: 'evidence-stripe-prep',
              computerActionId: null,
              missionId: node.missionId,
              artifactId: artifact.id,
              toolExecutionId: execution.id,
              browserObservationId: browser.id,
              evidenceType: 'stripe_setup_prep_recorded',
              sourceType: 'startup_lifecycle',
              auditEventId: 'audit-stripe-prep',
              sensitivity: 'restricted',
              contentHash: `sha256:${'c'.repeat(64)}`,
              replayRef: prepReplayRef,
              metadata: {
                missionNodeId: node.id,
                artifactId: artifact.id,
                toolExecutionId: execution.id,
                browserObservationId: browser.id,
                humanGates,
                helmPolicyClasses: ['financial', 'legal', 'credential_handling', 'audit'],
                restrictedActionsExecuted: false,
                financialSecretsStoredInEvidence: false,
                rawConnectorSecretsStoredInEvidence: false,
              },
            }),
          ]
        : []),
    ],
    audits: [
      auditRow({
        id: 'audit-stripe-tool',
        action: 'TOOL_EXECUTION',
        target: execution.toolKey,
        verdict: 'allow',
        metadata: {
          broker: 'tool_broker_v1',
          toolKey: execution.toolKey,
          toolExecutionId: execution.id,
          evidenceItemId: 'evidence-stripe-tool',
          policyDecisionId: execution.policyDecisionId,
          policyVersion: execution.policyVersion,
        },
      }),
      auditRow({
        id: 'audit-stripe-browser',
        action: 'BROWSER_OBSERVATION_CAPTURED',
        actor: `browser:${browser.sessionId}`,
        target: browser.id,
        verdict: 'allow',
        metadata: {
          evidenceItemId: 'evidence-stripe-browser',
          helmDecisionId: 'stripe-browser-decision-1',
          helmPolicyVersion: 'founder-ops-v1',
        },
      }),
      auditRow({
        id: 'audit-stripe-artifact',
        action: 'ARTIFACT_CREATED',
        target: artifact.id,
        verdict: 'created',
        metadata: {
          evidenceItemId: 'evidence-stripe-artifact',
          evidenceType: 'artifact_created',
          replayRef: `artifact:${artifact.id}:1`,
          artifactId: artifact.id,
          artifactType: artifact.type,
          version: 1,
        },
      }),
      ...(includePrepEvidence
        ? [
            auditRow({
              id: 'audit-stripe-prep',
              action: 'STRIPE_SETUP_PREP_RECORDED',
              target: node.id,
              verdict: 'recorded',
              metadata: {
                evidenceItemId: 'evidence-stripe-prep',
                evidenceType: 'stripe_setup_prep_recorded',
                missionNodeId: node.id,
                artifactId: artifact.id,
                toolExecutionId: execution.id,
                browserObservationId: browser.id,
                humanGates,
                helmPolicyClasses: ['financial', 'legal', 'credential_handling', 'audit'],
                financialPolicyDecisionId: 'stripe-financial-decision-1',
                financialPolicyVersion: 'founder-ops-v1',
                legalPolicyDecisionId: 'stripe-legal-decision-1',
                legalPolicyVersion: 'founder-ops-v1',
                restrictedActionsExecuted: false,
                financialSecretsStoredInEvidence: false,
              },
            }),
          ]
        : []),
    ],
  };
}

function companyFormationPrepFixture({
  includePrepEvidence = true,
}: { includePrepEvidence?: boolean } = {}): {
  browser: BrowserObservationRow[];
  missionNodeRows: MissionNodeRow[];
  toolExecutionRows: ToolExecutionRow[];
  artifactRows: ArtifactRow[];
  evidence: EvidenceItemRow[];
  audits: AuditRow[];
} {
  const node = missionNodeRow({
    id: 'mission-node-company-formation-1',
    missionId: 'mission-company-formation-1',
    nodeKey: 'company_formation_prep',
    stage: 'company_formation_prep',
    title: 'Company formation preparation',
    objective: 'Compare formation providers and prepare a draft packet up to human gates.',
    requiredAgents: ['Legal Workflow Agent', 'Finance Agent', 'Founder Ops Agent'],
    requiredSkills: ['formation_research', 'legal_packet_drafting', 'human_gate_mapping'],
    requiredTools: ['browser_read_extract', 'artifact_writer'],
    requiredEvidence: ['formation comparison', 'draft packet', 'human gate list'],
    helmPolicyClasses: ['legal', 'financial', 'browser', 'audit'],
    escalationConditions: [
      'Signature, filing, legal attestation, identity verification, or payment is required',
    ],
    acceptanceCriteria: [
      'Formation prep artifact exists',
      'Human-required legal steps are explicit',
      'No legal filing, payment, identity submission, or raw secrets are stored',
    ],
  });
  const humanGates = [
    'signature',
    'filing',
    'legal_attestation',
    'identity_verification',
    'payment',
  ];
  const artifact = artifactRow({
    id: 'artifact-company-formation-prep-1',
    type: 'application',
    name: 'Company formation prep packet',
    description: 'Non-filing formation provider comparison, draft packet, and human gates.',
    storagePath: 'artifacts/company/formation-prep.md',
    mimeType: 'text/markdown',
    sizeBytes: 6144,
    metadata: {
      evalId: 'company_formation_prep',
      lifecycleStage: 'company_formation_prep',
      missionNodeId: node.id,
      formationComparisonRef: 'artifact:formation-comparison',
      draftPacketRef: 'artifact:formation-draft-packet',
      humanGateListRef: 'artifact:formation-human-gates',
      productionReady: false,
      restrictedActionsExecuted: false,
      legalFilingSubmitted: false,
      paymentSubmitted: false,
      identityVerificationSubmitted: false,
      rawIdentitySecretsStoredInArtifact: false,
      rawFinancialSecretsStoredInArtifact: false,
    },
  });
  const execution = toolExecution({
    id: 'tool-execution-company-formation-prep-1',
    actionId: 'action-company-formation-prep-1',
    toolKey: 'company_formation_prep',
    inputHash: 'sha256:company-formation-input',
    sanitizedInput: { mode: 'company_formation_prep', missionNodeId: node.id },
    outputHash: `sha256:${'d'.repeat(64)}`,
    sanitizedOutput: {
      mode: 'company_formation_prep',
      missionNodeId: node.id,
      artifactId: artifact.id,
      productionReady: false,
      restrictedActionsExecuted: false,
      legalFilingSubmitted: false,
      paymentSubmitted: false,
      identityVerificationSubmitted: false,
      rawIdentitySecretsStoredInOutput: false,
      rawFinancialSecretsStoredInOutput: false,
      formationComparison: [
        { provider: 'Clerky', filing: 'human_required' },
        { provider: 'Stripe Atlas', filing: 'human_required' },
      ],
      draftPacket: {
        entityType: 'Delaware C-Corp',
        founderQuestions: ['legal name', 'registered agent', 'share structure'],
      },
      humanGates,
      requiredEscalations: humanGates,
    },
    evidenceIds: ['evidence-company-formation-tool'],
    policyDecisionId: 'company-formation-legal-decision-1',
    policyVersion: 'founder-ops-v1',
    helmDocumentVersionPins: {
      legalPolicy: 'founder-ops-v1',
      financialPolicy: 'founder-ops-v1',
    },
  });
  const browser = browserObservation({
    id: 'browser-observation-company-formation-1',
    url: 'https://www.clerky.com/incorporation',
    origin: 'https://www.clerky.com',
    title: 'Clerky incorporation docs',
    objective: 'Read company formation provider docs without submitting identity or payment data',
    domHash: `sha256:${'e'.repeat(64)}`,
    screenshotHash: `sha256:${'f'.repeat(64)}`,
    screenshotRef: 'browser/company/formation-prep.png',
    redactedDomSnapshot: '<html><main>Formation provider docs</main></html>',
    extractedData: {
      providers: ['Clerky', 'Stripe Atlas', 'Doola', 'Firstbase'],
      formationOptions: ['Delaware C-Corp', 'LLC'],
      humanGates,
    },
    redactions: [],
    metadata: {
      credentialBoundary: browserCredentialBoundary,
      helmDecisionId: 'company-formation-browser-decision-1',
      helmPolicyVersion: 'founder-ops-v1',
      rawCookiesExported: false,
      rawIdentitySecretsStored: false,
      rawPaymentSecretsStored: false,
    },
  });
  const prepReplayRef = `company-formation-prep:${node.id}`;

  return {
    browser: [browser],
    missionNodeRows: [node],
    toolExecutionRows: [execution],
    artifactRows: [artifact],
    evidence: [
      evidenceItem({
        id: 'evidence-company-formation-tool',
        computerActionId: null,
        actionId: execution.actionId,
        toolExecutionId: execution.id,
        evidenceType: 'tool_execution_completed',
        sourceType: 'tool_broker',
        auditEventId: 'audit-company-formation-tool',
        contentHash: execution.outputHash,
        replayRef: `tool:${execution.id}`,
        metadata: {
          broker: 'tool_broker_v1',
          toolKey: execution.toolKey,
          toolExecutionId: execution.id,
          status: 'completed',
          policyDecisionId: execution.policyDecisionId,
          policyVersion: execution.policyVersion,
          requiredEvidence: ['formation_comparison', 'draft_packet', 'human_gate_list'],
          legalFilingSubmitted: false,
          paymentSubmitted: false,
          rawIdentitySecretsStoredInEvidence: false,
          rawFinancialSecretsStoredInEvidence: false,
        },
      }),
      evidenceItem({
        id: 'evidence-company-formation-browser',
        computerActionId: null,
        browserObservationId: browser.id,
        evidenceType: 'browser_observation',
        sourceType: 'gateway_browser_session',
        auditEventId: 'audit-company-formation-browser',
        sensitivity: 'sensitive',
        contentHash: browser.domHash,
        storageRef: browser.screenshotRef,
        replayRef: `browser:${browser.sessionId}:3`,
        metadata: {
          sessionId: browser.sessionId,
          grantId: browser.grantId,
          browserActionId: browser.browserActionId,
          url: browser.url,
          origin: browser.origin,
          credentialBoundary: browserCredentialBoundary,
          helmDecisionId: 'company-formation-browser-decision-1',
          helmPolicyVersion: 'founder-ops-v1',
        },
      }),
      evidenceItem({
        id: 'evidence-company-formation-artifact',
        computerActionId: null,
        artifactId: artifact.id,
        evidenceType: 'artifact_created',
        sourceType: 'tool_registry',
        auditEventId: 'audit-company-formation-artifact',
        sensitivity: 'internal',
        contentHash: `sha256:${'1'.repeat(64)}`,
        storageRef: artifact.storagePath,
        replayRef: `artifact:${artifact.id}:1`,
        metadata: {
          evalId: 'company_formation_prep',
          lifecycleStage: 'company_formation_prep',
          missionNodeId: node.id,
          artifactType: artifact.type,
          version: 1,
          tool: 'create_artifact',
          legalFilingSubmitted: false,
          paymentSubmitted: false,
          identityVerificationSubmitted: false,
          rawIdentitySecretsStoredInEvidence: false,
          rawFinancialSecretsStoredInEvidence: false,
        },
      }),
      ...(includePrepEvidence
        ? [
            evidenceItem({
              id: 'evidence-company-formation-prep',
              computerActionId: null,
              missionId: node.missionId,
              artifactId: artifact.id,
              toolExecutionId: execution.id,
              browserObservationId: browser.id,
              evidenceType: 'company_formation_prep_recorded',
              sourceType: 'startup_lifecycle',
              auditEventId: 'audit-company-formation-prep',
              sensitivity: 'restricted',
              contentHash: `sha256:${'2'.repeat(64)}`,
              replayRef: prepReplayRef,
              metadata: {
                missionNodeId: node.id,
                artifactId: artifact.id,
                toolExecutionId: execution.id,
                browserObservationId: browser.id,
                humanGates,
                helmPolicyClasses: ['legal', 'financial', 'browser', 'audit'],
                restrictedActionsExecuted: false,
                legalFilingSubmitted: false,
                paymentSubmitted: false,
                identityVerificationSubmitted: false,
                rawIdentitySecretsStoredInEvidence: false,
                rawFinancialSecretsStoredInEvidence: false,
              },
            }),
          ]
        : []),
    ],
    audits: [
      auditRow({
        id: 'audit-company-formation-tool',
        action: 'TOOL_EXECUTION',
        target: execution.toolKey,
        verdict: 'allow',
        metadata: {
          broker: 'tool_broker_v1',
          toolKey: execution.toolKey,
          toolExecutionId: execution.id,
          evidenceItemId: 'evidence-company-formation-tool',
          policyDecisionId: execution.policyDecisionId,
          policyVersion: execution.policyVersion,
        },
      }),
      auditRow({
        id: 'audit-company-formation-browser',
        action: 'BROWSER_OBSERVATION_CAPTURED',
        actor: `browser:${browser.sessionId}`,
        target: browser.id,
        verdict: 'allow',
        metadata: {
          evidenceItemId: 'evidence-company-formation-browser',
          helmDecisionId: 'company-formation-browser-decision-1',
          helmPolicyVersion: 'founder-ops-v1',
        },
      }),
      auditRow({
        id: 'audit-company-formation-artifact',
        action: 'ARTIFACT_CREATED',
        target: artifact.id,
        verdict: 'created',
        metadata: {
          evidenceItemId: 'evidence-company-formation-artifact',
          evidenceType: 'artifact_created',
          replayRef: `artifact:${artifact.id}:1`,
          artifactId: artifact.id,
          artifactType: artifact.type,
          version: 1,
        },
      }),
      ...(includePrepEvidence
        ? [
            auditRow({
              id: 'audit-company-formation-prep',
              action: 'COMPANY_FORMATION_PREP_RECORDED',
              target: node.id,
              verdict: 'recorded',
              metadata: {
                evidenceItemId: 'evidence-company-formation-prep',
                evidenceType: 'company_formation_prep_recorded',
                missionNodeId: node.id,
                artifactId: artifact.id,
                toolExecutionId: execution.id,
                browserObservationId: browser.id,
                humanGates,
                helmPolicyClasses: ['legal', 'financial', 'browser', 'audit'],
                legalPolicyDecisionId: 'company-formation-legal-decision-1',
                legalPolicyVersion: 'founder-ops-v1',
                financialPolicyDecisionId: 'company-formation-financial-decision-1',
                financialPolicyVersion: 'founder-ops-v1',
                restrictedActionsExecuted: false,
                legalFilingSubmitted: false,
                paymentSubmitted: false,
                rawIdentitySecretsStoredInEvidence: false,
                rawFinancialSecretsStoredInEvidence: false,
              },
            }),
          ]
        : []),
    ],
  };
}

function helmReceiptMetadata(pack: EvidencePackRow): Record<string, string | null> {
  return {
    decisionId: pack.decisionId,
    verdict: pack.verdict,
    policyVersion: pack.policyVersion,
    action: pack.action,
    resource: pack.resource,
    principal: pack.principal,
    receiptId: null,
  };
}

function helmReceiptAuditMetadata(pack: EvidencePackRow): Record<string, string | null> {
  return {
    evidencePackId: pack.id,
    ...helmReceiptMetadata(pack),
  };
}

function decisionCourtModelCall(participant: 'bull' | 'bear' | 'referee') {
  const suffix = participant === 'bull' ? '1' : participant === 'bear' ? '2' : '3';
  return {
    participant,
    opportunityId: 'opp-1',
    prompt: `${participant} prompt`,
    output:
      participant === 'referee'
        ? '{"verdict":"yes","confidence":82,"reasoning":"Strong fit."}'
        : `${participant} output`,
    status: 'completed',
    model: 'anthropic/claude-sonnet-4',
    tokensIn: 120 + Number(suffix),
    tokensOut: 80 + Number(suffix),
    costUsd: 0.001 + Number(`0.00${suffix}`),
    policyDecisionId: `model-decision-${suffix}`,
    policyVersion: 'founder-ops-v1',
    receipt: {
      decisionId: `model-decision-${suffix}`,
      verdict: 'ALLOW',
      policyVersion: 'founder-ops-v1',
      decisionHash: suffix.repeat(64),
      principal: `workspace:${workspaceId}/operator:decision_court`,
    },
  };
}

function decisionCourtMetadata(overrides: Record<string, unknown> = {}) {
  const modelCalls = [
    decisionCourtModelCall('bull'),
    decisionCourtModelCall('bear'),
    decisionCourtModelCall('referee'),
  ];
  return {
    requestedOpportunityIds: ['opp-1'],
    founderContextProvided: true,
    mode: 'governed_llm_court',
    status: 'completed',
    productionReady: false,
    finalRecommendation: {
      opportunityId: 'opp-1',
      rank: 1,
      verdict: 'yes',
      confidence: 82,
      reasoning: 'Strong fit.',
      bullCase: 'bull output',
      bearCase: 'bear output',
    },
    ranking: [
      {
        opportunityId: 'opp-1',
        rank: 1,
        verdict: 'yes',
        confidence: 82,
        reasoning: 'Strong fit.',
        bullCase: 'bull output',
        bearCase: 'bear output',
      },
    ],
    stages: [
      { stage: 'buildDocket', durationMs: 1 },
      { stage: 'researchBull', durationMs: 2 },
      { stage: 'researchBear', durationMs: 3 },
      { stage: 'referee', durationMs: 4 },
      { stage: 'synthesize', durationMs: 1 },
    ],
    modelCalls,
    policyDecisionIds: modelCalls.map((call) => call.policyDecisionId),
    policyVersions: ['founder-ops-v1'],
    helmDocumentVersionPins: {
      decisionCourtPrompt: 'decision-court-v1',
      'modelCall:1:bull:opp-1': 'founder-ops-v1',
      'modelCall:2:bear:opp-1': 'founder-ops-v1',
      'modelCall:3:referee:opp-1': 'founder-ops-v1',
    },
    promptVersion: 'decision-court-v1',
    replayRef: 'decision-court:audit-decision-court',
    credentialBoundary: 'no_raw_credentials_or_session_payloads_in_prompt',
    ...overrides,
  };
}

function commandCenterUxMetadata(overrides: Record<string, unknown> = {}) {
  return {
    commandCenterEvalVersion: 'command-center-real-state-ux.v1',
    executionMode: PRODUCTION_READY_EXECUTION_MODE,
    apiResponseFixtureRef: 'artifact:command-center-api-fixture.json',
    apiResponseFixtureHash: `sha256:${'a'.repeat(64)}`,
    uiScreenshotRef: 'artifact:command-center.png',
    uiScreenshotHash: `sha256:${'b'.repeat(64)}`,
    accessibilityReportRef: 'artifact:command-center-a11y.json',
    accessibilityReportHash: `sha256:${'c'.repeat(64)}`,
    capabilityMatrixRendered: true,
    capabilityStatesRendered: ['implemented', 'prototype', 'blocked'],
    durableStateSurfaces: [
      'mission_graph',
      'agent_lanes',
      'action_timeline',
      'evidence_drawer',
      'receipt_chips',
      'browser_computer_replay',
      'permission_graph',
      'eval_status',
      'capability_matrix',
    ],
    routeLocalMockState: false,
    productionReadyClaims: false,
    ...overrides,
  };
}

function founderOffGridFixture({
  includeBlocker = true,
}: { includeBlocker?: boolean } = {}): {
  missionRows: MissionRow[];
  missionTaskRows: MissionTaskRow[];
  taskRows: TaskRow[];
  taskRunRows: TaskRunRow[];
  handoffRows: AgentHandoffRow[];
  toolExecutionRows: ToolExecutionRow[];
  evidence: EvidenceItemRow[];
  audits: AuditRow[];
} {
  const mission = missionRow({
    id: 'mission-founder-off-grid-1',
    missionKey: 'founder-off-grid-controlled-1',
    title: 'Controlled founder-off-grid launch work',
    autonomyMode: 'founder_off_grid',
    status: 'completed',
    productionReady: false,
    metadata: {
      templateKey: 'founder_off_grid',
      founderPresence: 'absent',
      controlledEval: true,
    },
  });
  const task = taskRow({
    id: 'task-founder-off-grid-1',
    title: 'Continue approved launch work while founder is absent',
    status: 'completed',
    completedAt: new Date('2026-05-12T00:12:00.000Z'),
  });
  const missionTask = missionTaskRow({
    id: 'mission-task-founder-off-grid-1',
    missionId: mission.id,
    taskId: task.id,
  });
  const parentRun = taskRunRow({
    id: 'task-run-founder-off-grid-parent',
    taskId: task.id,
    actionTool: 'subagent.spawn',
    lineageKind: 'parent_action',
    runSequence: 1,
  });
  const childRun = taskRunRow({
    id: 'task-run-founder-off-grid-child',
    taskId: task.id,
    actionTool: 'create_artifact',
    parentTaskRunId: parentRun.id,
    rootTaskRunId: parentRun.id,
    spawnedByActionId: 'action-founder-off-grid-spawn',
    lineageKind: 'subagent_spawn',
    operatorRole: 'builder',
    runSequence: 2,
  });
  const handoff = agentHandoffRow({
    id: 'handoff-founder-off-grid-1',
    taskId: task.id,
    parentTaskRunId: parentRun.id,
    childTaskRunId: childRun.id,
    toAgent: 'builder',
    output: { status: 'completed', artifactRef: 'artifact:off-grid-progress' },
  });
  const executions = [
    toolExecution({
      id: 'tool-execution-founder-off-grid-1',
      taskRunId: parentRun.id,
      actionId: 'action-founder-off-grid-1',
      toolKey: 'search_knowledge',
      outputHash: `sha256:${'8'.repeat(64)}`,
      sanitizedOutput: {
        founderPresence: 'absent',
        externalSideEffects: false,
        evidenceKinds: ['founder_off_grid_action_log'],
      },
      evidenceIds: ['evidence-founder-off-grid-tool-1'],
      policyDecisionId: 'off-grid-tool-decision-1',
      policyVersion: 'founder-ops-v1',
      helmDocumentVersionPins: { toolAccessPolicy: 'founder-ops-v1' },
    }),
    toolExecution({
      id: 'tool-execution-founder-off-grid-2',
      taskRunId: childRun.id,
      actionId: 'action-founder-off-grid-2',
      toolKey: 'create_artifact',
      outputHash: `sha256:${'9'.repeat(64)}`,
      sanitizedOutput: {
        founderPresence: 'absent',
        externalSideEffects: false,
        artifactDiffRef: 'artifact:off-grid-progress:1',
        evidenceKinds: ['founder_off_grid_action_log', 'artifact_diff'],
      },
      evidenceIds: ['evidence-founder-off-grid-tool-2'],
      policyDecisionId: 'off-grid-tool-decision-2',
      policyVersion: 'founder-ops-v1',
      helmDocumentVersionPins: { toolAccessPolicy: 'founder-ops-v1' },
    }),
  ];
  const actionEvidenceRefs = [
    'tool:tool-execution-founder-off-grid-1',
    'tool:tool-execution-founder-off-grid-2',
  ];
  const blockerQueue = ['legal approval before filing', 'identity verification before payment'];
  const escalationReasons = [
    'legal filing requires founder',
    'payment setup requires founder',
    'identity verification requires founder',
    'policy threshold reached',
    'ambiguity in formation choice',
  ];
  const checkpointHash = `sha256:${'a'.repeat(64)}`;
  const boundaryHash = `sha256:${'b'.repeat(64)}`;
  const reportHash = `sha256:${'c'.repeat(64)}`;
  const blockerHash = `sha256:${'d'.repeat(64)}`;

  return {
    missionRows: [mission],
    missionTaskRows: [missionTask],
    taskRows: [task],
    taskRunRows: [parentRun, childRun],
    handoffRows: [handoff],
    toolExecutionRows: executions,
    evidence: [
      evidenceItem({
        id: 'evidence-founder-off-grid-boundary',
        computerActionId: null,
        missionId: mission.id,
        evidenceType: 'founder_off_grid_controlled_eval',
        sourceType: 'founder_off_grid_eval',
        auditEventId: 'audit-founder-off-grid-boundary',
        sensitivity: 'internal',
        contentHash: boundaryHash,
        replayRef: `founder-off-grid:${mission.id}:boundary`,
        metadata: {
          founderOffGridEvalVersion: 'founder-off-grid-controlled.v1',
          executionMode: PRODUCTION_READY_EXECUTION_MODE,
          missionId: mission.id,
          founderPresence: 'absent',
          mode: 'controlled',
          riskLimit: 'medium_or_lower',
          budgetLimitUsd: 25,
          emergencyStopTested: true,
          unauthorizedActionsDetected: false,
          externalCommunicationsSent: false,
          legalOrFinancialActionsExecuted: false,
          productionReady: false,
        },
      }),
      evidenceItem({
        id: 'evidence-founder-off-grid-checkpoint',
        computerActionId: null,
        missionId: mission.id,
        evidenceType: 'startup_lifecycle_mission_checkpoint',
        sourceType: 'gateway_startup_lifecycle',
        auditEventId: 'audit-founder-off-grid-checkpoint',
        sensitivity: 'internal',
        contentHash: checkpointHash,
        replayRef: `mission:${mission.id}:checkpoint:founder-off-grid`,
        metadata: {
          checkpointVersion: 'mission-runtime-checkpoint.v1',
          checkpointKind: 'founder_off_grid',
          checkpointId: 'checkpoint-founder-off-grid-1',
          missionStatus: 'completed',
          founderPresence: 'absent',
          productionReady: false,
          actionEvidenceItemIds: [
            'evidence-founder-off-grid-tool-1',
            'evidence-founder-off-grid-tool-2',
          ],
          nodeStatuses: { completed: 2, blocked: 1 },
          snapshot: { missionId: mission.id, completedActions: actionEvidenceRefs },
        },
      }),
      evidenceItem({
        id: 'evidence-founder-off-grid-report',
        computerActionId: null,
        missionId: mission.id,
        evidenceType: 'founder_off_grid_progress_report',
        sourceType: 'founder_off_grid_eval',
        auditEventId: 'audit-founder-off-grid-report',
        sensitivity: 'internal',
        contentHash: reportHash,
        replayRef: `founder-off-grid:${mission.id}:report`,
        metadata: {
          founderOffGridReportVersion: 'founder-off-grid-report.v1',
          executionMode: PRODUCTION_READY_EXECUTION_MODE,
          missionId: mission.id,
          checkpointEvidenceItemId: 'evidence-founder-off-grid-checkpoint',
          checkpointReplayRef: `mission:${mission.id}:checkpoint:founder-off-grid`,
          conciseReportRef: 'artifact:founder-off-grid-report.md',
          productionReady: false,
          costReport: { totalUsd: 0.008, budgetLimitUsd: 25 },
          actionEvidenceRefs,
          completedActions: ['search_knowledge', 'create_artifact'],
          blockerQueue,
        },
      }),
      ...(includeBlocker
        ? [
            evidenceItem({
              id: 'evidence-founder-off-grid-blockers',
              computerActionId: null,
              missionId: mission.id,
              evidenceType: 'founder_off_grid_blocker_queue',
              sourceType: 'founder_off_grid_eval',
              auditEventId: 'audit-founder-off-grid-blockers',
              sensitivity: 'internal',
              contentHash: blockerHash,
              replayRef: `founder-off-grid:${mission.id}:blockers`,
              metadata: {
                founderOffGridBlockerVersion: 'founder-off-grid-blockers.v1',
                executionMode: PRODUCTION_READY_EXECUTION_MODE,
                missionId: mission.id,
                productionReady: false,
                microPromptCount: 0,
                onlyTrueEdgeCases: true,
                blockerQueue,
                escalationReasons,
              },
            }),
          ]
        : []),
      ...executions.map((execution, index) =>
        evidenceItem({
          id: `evidence-founder-off-grid-tool-${index + 1}`,
          computerActionId: null,
          taskRunId: execution.taskRunId,
          actionId: execution.actionId,
          toolExecutionId: execution.id,
          evidenceType: 'tool_execution_completed',
          sourceType: 'tool_broker',
          auditEventId: `audit-founder-off-grid-tool-${index + 1}`,
          contentHash: execution.outputHash,
          replayRef: `tool:${execution.id}`,
          metadata: {
            broker: 'tool_broker_v1',
            toolKey: execution.toolKey,
            toolExecutionId: execution.id,
            status: 'completed',
            policyDecisionId: execution.policyDecisionId,
            policyVersion: execution.policyVersion,
            founderPresence: 'absent',
            requiredEvidence: ['founder_off_grid_action_log'],
          },
        }),
      ),
    ],
    audits: [
      auditRow({
        id: 'audit-founder-off-grid-boundary',
        action: 'FOUNDER_OFF_GRID_EVAL',
        target: 'founder_off_grid',
        verdict: 'recorded',
        metadata: {
          evidenceItemId: 'evidence-founder-off-grid-boundary',
          evidenceType: 'founder_off_grid_controlled_eval',
          founderOffGridEvalVersion: 'founder-off-grid-controlled.v1',
          executionMode: PRODUCTION_READY_EXECUTION_MODE,
          replayRef: `founder-off-grid:${mission.id}:boundary`,
          contentHash: boundaryHash,
        },
      }),
      auditRow({
        id: 'audit-founder-off-grid-checkpoint',
        action: 'STARTUP_LIFECYCLE_MISSION_CHECKPOINT',
        target: mission.id,
        verdict: 'recorded',
        metadata: {
          evidenceItemId: 'evidence-founder-off-grid-checkpoint',
          evidenceType: 'startup_lifecycle_mission_checkpoint',
          checkpointKind: 'founder_off_grid',
          founderPresence: 'absent',
          replayRef: `mission:${mission.id}:checkpoint:founder-off-grid`,
          contentHash: checkpointHash,
        },
      }),
      auditRow({
        id: 'audit-founder-off-grid-report',
        action: 'FOUNDER_OFF_GRID_PROGRESS_REPORTED',
        target: 'founder_off_grid',
        verdict: 'recorded',
        metadata: {
          evidenceItemId: 'evidence-founder-off-grid-report',
          evidenceType: 'founder_off_grid_progress_report',
          founderOffGridReportVersion: 'founder-off-grid-report.v1',
          executionMode: PRODUCTION_READY_EXECUTION_MODE,
          replayRef: `founder-off-grid:${mission.id}:report`,
          contentHash: reportHash,
        },
      }),
      ...(includeBlocker
        ? [
            auditRow({
              id: 'audit-founder-off-grid-blockers',
              action: 'FOUNDER_OFF_GRID_BLOCKER_QUEUED',
              target: 'founder_off_grid',
              verdict: 'recorded',
              metadata: {
                evidenceItemId: 'evidence-founder-off-grid-blockers',
                evidenceType: 'founder_off_grid_blocker_queue',
                founderOffGridBlockerVersion: 'founder-off-grid-blockers.v1',
                executionMode: PRODUCTION_READY_EXECUTION_MODE,
                replayRef: `founder-off-grid:${mission.id}:blockers`,
                contentHash: blockerHash,
              },
            }),
          ]
        : []),
      ...executions.map((execution, index) =>
        auditRow({
          id: `audit-founder-off-grid-tool-${index + 1}`,
          action: 'TOOL_EXECUTION',
          target: execution.toolKey,
          verdict: 'allow',
          metadata: {
            broker: 'tool_broker_v1',
            toolKey: execution.toolKey,
            toolExecutionId: execution.id,
            evidenceItemId: `evidence-founder-off-grid-tool-${index + 1}`,
            policyDecisionId: execution.policyDecisionId,
            policyVersion: execution.policyVersion,
            founderPresence: 'absent',
          },
        }),
      ),
    ],
  };
}

function skillInvocationOutput(overrides: Record<string, unknown> = {}) {
  return {
    skill: {
      name: 'yc-application-writing',
      version: '1.0.0',
      riskProfile: 'medium',
      permissionRequirements: ['skill:invoke'],
      evalStatus: 'implemented',
      declaredTools: ['search_knowledge'],
      sourcePath: 'packs/skills/yc-application-writing/SKILL.md',
    },
    activation: {
      reason: 'explicit',
      score: 1,
      subagentName: 'application_writer',
    },
    taskHash: 'sha256:task-hash',
    instructionHash: 'sha256:instruction-hash',
    capability: {
      key: 'skill_registry_runtime',
      state: 'implemented',
    },
    ...overrides,
  };
}

function skillInvocationAudit(
  execution: ToolExecutionRow,
  overrides: Record<string, unknown> = {},
) {
  return {
    name: 'yc-application-writing',
    version: '1.0.0',
    activationReason: 'explicit',
    score: 1,
    riskProfile: 'medium',
    permissionRequirements: ['skill:invoke'],
    evalStatus: 'implemented',
    declaredTools: ['search_knowledge'],
    sourcePath: 'packs/skills/yc-application-writing/SKILL.md',
    instructionHash: 'sha256:instruction-hash',
    brokeredInvocation: {
      actionId: execution.actionId,
      toolExecutionId: execution.id,
      evidenceItemId: 'evidence-skill-invoke',
      status: 'completed',
      inputHash: execution.inputHash,
      outputHash: execution.outputHash,
      policyDecisionId: execution.policyDecisionId,
      policyVersion: execution.policyVersion,
    },
    ...overrides,
  };
}

describe('createProductionEvalRunner', () => {
  it('passes stripe_setup_prep from lifecycle, tool, browser, artifact, human-gate, and audit evidence', async () => {
    const fixture = stripeSetupPrepFixture();
    const runner = createProductionEvalRunner(createRunnerDb(fixture));

    const result = await runner.execute({
      workspaceId,
      evalId: 'stripe_setup_prep',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run).toMatchObject({
      evalId: 'stripe_setup_prep',
      status: 'passed',
      capabilityKey: 'startup_lifecycle',
      evidenceRefs: expect.arrayContaining([
        'stripe-setup-prep:mission-node-stripe-setup-1',
        'tool:tool-execution-stripe-prep-1',
        'browser:00000000-0000-4000-8000-000000000011:3',
        'artifact:artifact-stripe-setup-prep-1:1',
      ]),
      auditReceiptRefs: expect.arrayContaining([
        'audit:audit-stripe-prep',
        'audit:audit-stripe-tool',
        'audit:audit-stripe-browser',
        'audit:audit-stripe-artifact',
      ]),
      metadata: {
        runnerRef: 'gateway:stripe_setup_prep:v1',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
        verifiedMissionNodeId: 'mission-node-stripe-setup-1',
        verifiedToolExecutionId: 'tool-execution-stripe-prep-1',
        verifiedBrowserObservationId: 'browser-observation-stripe-1',
        verifiedArtifactId: 'artifact-stripe-setup-prep-1',
      },
    });
    expect(result.run.steps).toEqual([
      expect.objectContaining({ stepKey: 'completed-stripe-lifecycle-node', status: 'passed' }),
      expect.objectContaining({
        stepKey: 'brokered-stripe-plan-and-browser-research',
        status: 'passed',
      }),
      expect.objectContaining({
        stepKey: 'artifact-human-gates-and-secret-boundary',
        status: 'passed',
      }),
    ]);
  });

  it('fails stripe_setup_prep without isolated human-gate prep evidence', async () => {
    const runner = createProductionEvalRunner(
      createRunnerDb(stripeSetupPrepFixture({ includePrepEvidence: false })),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'stripe_setup_prep',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('isolated human gates');
  });

  it('passes company_formation_prep from lifecycle, browser, draft artifact, human-gate, and audit evidence', async () => {
    const fixture = companyFormationPrepFixture();
    const runner = createProductionEvalRunner(createRunnerDb(fixture));

    const result = await runner.execute({
      workspaceId,
      evalId: 'company_formation_prep',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run).toMatchObject({
      evalId: 'company_formation_prep',
      status: 'passed',
      capabilityKey: 'startup_lifecycle',
      evidenceRefs: expect.arrayContaining([
        'company-formation-prep:mission-node-company-formation-1',
        'tool:tool-execution-company-formation-prep-1',
        'browser:00000000-0000-4000-8000-000000000011:3',
        'artifact:artifact-company-formation-prep-1:1',
      ]),
      auditReceiptRefs: expect.arrayContaining([
        'audit:audit-company-formation-prep',
        'audit:audit-company-formation-tool',
        'audit:audit-company-formation-browser',
        'audit:audit-company-formation-artifact',
      ]),
      metadata: {
        runnerRef: 'gateway:company_formation_prep:v1',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
        verifiedMissionNodeId: 'mission-node-company-formation-1',
        verifiedToolExecutionId: 'tool-execution-company-formation-prep-1',
        verifiedBrowserObservationId: 'browser-observation-company-formation-1',
        verifiedArtifactId: 'artifact-company-formation-prep-1',
      },
    });
    expect(result.run.steps).toEqual([
      expect.objectContaining({
        stepKey: 'completed-company-formation-lifecycle-node',
        status: 'passed',
      }),
      expect.objectContaining({
        stepKey: 'brokered-formation-research-and-draft-packet',
        status: 'passed',
      }),
      expect.objectContaining({
        stepKey: 'artifact-human-gates-and-legal-boundary',
        status: 'passed',
      }),
    ]);
  });

  it('fails company_formation_prep without isolated legal human-gate evidence', async () => {
    const runner = createProductionEvalRunner(
      createRunnerDb(companyFormationPrepFixture({ includePrepEvidence: false })),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'company_formation_prep',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('signature/filing/identity/payment');
  });

  it('passes domain_to_deployment from build, test, DNS/hosting, deployment, browser, rollback evidence, and audit rows', async () => {
    const fixture = domainToDeploymentFixture();
    const runner = createProductionEvalRunner(createRunnerDb(fixture));

    const result = await runner.execute({
      workspaceId,
      evalId: 'domain_to_deployment',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run).toMatchObject({
      evalId: 'domain_to_deployment',
      status: 'passed',
      evidenceRefs: expect.arrayContaining([
        'computer:computer-domain-build-1:0',
        'computer:computer-domain-test-1:1',
        `deploy-target:${workspaceId}:deploy-target-1:created`,
        'artifact:artifact-domain-landing-1:1',
        'launch:workspace:deploy:audit-domain-deploy',
        'launch:workspace:deploy_health_check:audit-domain-health',
        'browser:00000000-0000-4000-8000-000000000011:3',
        `launch:${workspaceId}:deploy_rollback_plan:audit-domain-rollback-plan`,
      ]),
      auditReceiptRefs: expect.arrayContaining([
        'audit:audit-domain-build',
        'audit:audit-domain-test',
        'audit:audit-domain-target',
        'audit:audit-domain-artifact',
        'audit:audit-domain-deploy',
        'audit:audit-domain-health',
        'audit:audit-domain-browser',
        'audit:audit-domain-rollback-plan',
      ]),
      metadata: {
        runnerRef: 'gateway:domain_to_deployment:v1',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
        verifiedDeployTargetId: 'deploy-target-1',
        verifiedArtifactId: 'artifact-domain-landing-1',
        verifiedDeploymentId: 'deployment-domain-1',
        verifiedDeployHealthId: 'deploy-health-domain-1',
        verifiedBrowserObservationId: 'browser-observation-domain-1',
      },
    });
    expect(result.run.steps).toEqual([
      expect.objectContaining({ stepKey: 'build-and-test-evidence', status: 'passed' }),
      expect.objectContaining({ stepKey: 'dns-hosting-target-evidence', status: 'passed' }),
      expect.objectContaining({
        stepKey: 'artifact-deployment-health-browser-proof',
        status: 'passed',
      }),
      expect.objectContaining({ stepKey: 'rollback-plan-evidence', status: 'passed' }),
    ]);
  });

  it('fails domain_to_deployment without rollback-plan evidence', async () => {
    const runner = createProductionEvalRunner(
      createRunnerDb(domainToDeploymentFixture({ includeRollback: false })),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'domain_to_deployment',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('rollback-plan evidence');
  });

  it('passes full_startup_launch from completed mission DAG, tools, artifact, deployment, health, evidence, and audit rows', async () => {
    const fixture = fullStartupLaunchFixture();
    const runner = createProductionEvalRunner(createRunnerDb(fixture));

    const result = await runner.execute({
      workspaceId,
      evalId: 'full_startup_launch',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run).toMatchObject({
      evalId: 'full_startup_launch',
      status: 'passed',
      evidenceRefs: expect.arrayContaining([
        'mission:mission-full-startup-1:persisted',
        'mission:mission-full-startup-1:checkpoint:completed',
        'artifact:artifact-landing-page-1:1',
        'launch:workspace:deploy:audit-deploy-full-startup',
        'launch:workspace:deploy_health_check:audit-health-full-startup',
      ]),
      auditReceiptRefs: expect.arrayContaining([
        'audit:audit-full-startup-checkpoint',
        'audit:audit-full-startup-artifact',
        'audit:audit-full-startup-deploy',
        'audit:audit-full-startup-health',
      ]),
      metadata: {
        runnerRef: 'gateway:full_startup_launch:v1',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
        verifiedMissionId: 'mission-full-startup-1',
        verifiedArtifactId: 'artifact-landing-page-1',
        verifiedDeploymentId: 'deployment-full-startup-1',
        verifiedDeployHealthId: 'deploy-health-full-startup-1',
      },
    });
    expect(result.run.steps).toEqual([
      expect.objectContaining({
        stepKey: 'completed-lifecycle-mission-dag',
        status: 'passed',
      }),
      expect.objectContaining({
        stepKey: 'brokered-runtime-tool-evidence',
        status: 'passed',
      }),
      expect.objectContaining({
        stepKey: 'artifact-and-deployment-verification',
        status: 'passed',
      }),
    ]);
  });

  it('fails full_startup_launch without deployment health proof', async () => {
    const runner = createProductionEvalRunner(
      createRunnerDb(fullStartupLaunchFixture({ includeHealth: false })),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'full_startup_launch',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('live deployment and health evidence');
  });

  it('passes skill_invocation_governance from brokered skill metadata, evidence, and audit rows', async () => {
    const task = taskRow({ id: 'task-skill-1' });
    const execution = toolExecution({
      id: 'tool-execution-skill-1',
      actionId: 'action-skill-1',
      taskRunId: 'task-run-skill-1',
      toolKey: 'skill.invoke',
      inputHash: 'sha256:skill-input',
      sanitizedInput: {
        skillName: 'yc-application-writing',
        expectedVersion: '1.0.0',
        allowedTools: ['search_knowledge'],
      },
      outputHash: 'sha256:skill-output',
      sanitizedOutput: skillInvocationOutput(),
      evidenceIds: ['evidence-skill-invoke'],
      policyDecisionId: 'skill-decision-1',
      policyVersion: 'founder-ops-v1',
      helmDocumentVersionPins: { skillPolicy: 'founder-ops-v1' },
      completedAt: new Date('2026-05-12T00:02:00.000Z'),
    });
    const invocation = skillInvocationAudit(execution);
    const run = taskRunRow({
      id: 'task-run-skill-1',
      taskId: task.id,
      lineageKind: 'subagent_spawn',
      parentTaskRunId: 'task-run-parent-1',
      rootTaskRunId: 'task-run-parent-1',
      spawnedByActionId: 'task-run-parent-1',
      actionTool: 'subagent.spawn',
      operatorRole: 'application_writer',
      skillInvocations: [invocation],
    });
    const runner = createProductionEvalRunner(
      createRunnerDb({
        taskRows: [task],
        taskRunRows: [run],
        handoffRows: [
          agentHandoffRow({
            taskId: task.id,
            parentTaskRunId: 'task-run-parent-1',
            childTaskRunId: run.id,
            toAgent: 'application_writer',
            skillInvocations: [invocation],
          }),
        ],
        toolExecutionRows: [execution],
        evidence: [
          evidenceItem({
            id: 'evidence-skill-invoke',
            computerActionId: null,
            actionId: execution.actionId,
            toolExecutionId: execution.id,
            evidenceType: 'tool_execution_completed',
            sourceType: 'tool_broker',
            auditEventId: 'audit-skill-invoke',
            contentHash: execution.outputHash,
            replayRef: `tool:${execution.id}`,
            metadata: {
              broker: 'tool_broker_v1',
              toolKey: 'skill.invoke',
              actionId: execution.actionId,
              toolExecutionId: execution.id,
              status: 'completed',
              riskClass: 'medium',
              effectLevel: 'E2',
              manifestVersion: 'runtime_skill_adapter_v1',
              requiredEvidence: ['skill_manifest', 'skill_run_record'],
              permissionRequirements: ['skill:invoke'],
              policyDecisionId: execution.policyDecisionId,
              policyVersion: execution.policyVersion,
            },
          }),
        ],
        audits: [
          auditRow({
            id: 'audit-skill-invoke',
            action: 'TOOL_EXECUTION',
            target: 'skill.invoke',
            verdict: 'allow',
            metadata: {
              broker: 'tool_broker_v1',
              toolKey: 'skill.invoke',
              toolExecutionId: execution.id,
              evidenceItemId: 'evidence-skill-invoke',
              policyDecisionId: execution.policyDecisionId,
              policyVersion: execution.policyVersion,
            },
          }),
        ],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'skill_invocation_governance',
      capabilityKey: 'skill_registry_runtime',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run).toMatchObject({
      evalId: 'skill_invocation_governance',
      status: 'passed',
      capabilityKey: 'skill_registry_runtime',
      evidenceRefs: ['tool:tool-execution-skill-1'],
      auditReceiptRefs: ['audit:audit-skill-invoke'],
      metadata: {
        runnerRef: 'gateway:skill_invocation_governance:v1',
        verifiedTaskId: task.id,
        verifiedTaskRunId: run.id,
        verifiedToolExecutionId: execution.id,
        skillName: 'yc-application-writing',
        skillVersion: '1.0.0',
        skillRiskProfile: 'medium',
        skillEvalStatus: 'implemented',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
    });
    expect(result.run.steps).toEqual([
      expect.objectContaining({
        stepKey: 'brokered-versioned-skill-invocation',
        status: 'passed',
        metadata: expect.objectContaining({
          skillName: 'yc-application-writing',
          skillVersion: '1.0.0',
          permissionRequirements: ['skill:invoke'],
          declaredTools: ['search_knowledge'],
        }),
      }),
    ]);
  });

  it('fails skill_invocation_governance when skill metadata is not brokered', async () => {
    const task = taskRow({ id: 'task-skill-1' });
    const execution = toolExecution({
      id: 'tool-execution-skill-1',
      actionId: 'action-skill-1',
      taskRunId: 'task-run-skill-1',
      toolKey: 'skill.invoke',
      sanitizedOutput: skillInvocationOutput(),
      outputHash: 'sha256:skill-output',
      evidenceIds: ['evidence-skill-invoke'],
      policyDecisionId: 'skill-decision-1',
      policyVersion: 'founder-ops-v1',
      helmDocumentVersionPins: { skillPolicy: 'founder-ops-v1' },
    });
    const promptOnlyInvocation = skillInvocationAudit(execution, { brokeredInvocation: undefined });
    const runner = createProductionEvalRunner(
      createRunnerDb({
        taskRows: [task],
        taskRunRows: [
          taskRunRow({
            id: 'task-run-skill-1',
            taskId: task.id,
            lineageKind: 'subagent_spawn',
            parentTaskRunId: 'task-run-parent-1',
            operatorRole: 'application_writer',
            skillInvocations: [promptOnlyInvocation],
          }),
        ],
        handoffRows: [
          agentHandoffRow({
            taskId: task.id,
            childTaskRunId: 'task-run-skill-1',
            skillInvocations: [promptOnlyInvocation],
          }),
        ],
        toolExecutionRows: [execution],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'skill_invocation_governance',
      capabilityKey: 'skill_registry_runtime',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('brokered skill.invoke execution');
  });

  it('passes proof_dag_lineage from durable parent, spawn, child, handoff, evidence, and receipts', async () => {
    const task = taskRow({ id: 'task-foundation-1' });
    const parent = taskRunRow({
      id: 'task-run-parent-1',
      taskId: task.id,
      lineageKind: 'parent_action',
      parentTaskRunId: null,
      rootTaskRunId: null,
      actionTool: 'subagent.parallel',
      runSequence: 1,
    });
    const spawn = taskRunRow({
      id: 'task-run-spawn-1',
      taskId: task.id,
      lineageKind: 'subagent_spawn',
      parentTaskRunId: parent.id,
      rootTaskRunId: parent.id,
      spawnedByActionId: parent.id,
      actionTool: 'subagent.spawn',
      operatorRole: 'research',
      runSequence: 2,
    });
    const child = taskRunRow({
      id: 'task-run-child-1',
      taskId: task.id,
      lineageKind: 'subagent_action',
      parentTaskRunId: spawn.id,
      rootTaskRunId: parent.id,
      spawnedByActionId: spawn.id,
      actionTool: 'search_knowledge',
      operatorRole: 'research',
      runSequence: 3,
    });
    const spawnPack = helmReceiptPack({
      id: 'pack-subagent-spawn-1',
      workspaceId,
      decisionId: 'local_spawn_1',
      taskRunId: spawn.id,
      action: 'SUBAGENT_SPAWN',
      resource: 'researcher',
      policyVersion: 'founder-ops-v1',
      decisionHash: null,
      principal: `workspace:${workspaceId}/operator:research/subagent:researcher:abc123`,
    });
    const childPack = helmReceiptPack({
      id: 'pack-child-receipt-1',
      workspaceId,
      decisionId: 'child-decision-1',
      taskRunId: child.id,
      action: 'LLM_INFERENCE',
      resource: 'anthropic/claude-sonnet-4',
      parentEvidencePackId: spawnPack.id,
      principal: `workspace:${workspaceId}/operator:research/subagent:researcher:abc123`,
    });
    const runner = createProductionEvalRunner(
      createRunnerDb({
        taskRows: [task],
        taskRunRows: [parent, spawn, child],
        handoffRows: [
          agentHandoffRow({
            taskId: task.id,
            parentTaskRunId: parent.id,
            childTaskRunId: spawn.id,
          }),
        ],
        packs: [spawnPack, childPack],
        evidence: [
          evidenceItem({
            id: 'evidence-subagent-spawn-1',
            computerActionId: null,
            evidencePackId: spawnPack.id,
            evidenceType: 'subagent_spawn_receipt',
            sourceType: 'conductor',
            replayRef: `helm:${spawnPack.decisionId}`,
            metadata: {
              decisionId: spawnPack.decisionId,
              policyVersion: spawnPack.policyVersion,
              action: 'SUBAGENT_SPAWN',
            },
          }),
          evidenceItem({
            id: 'evidence-child-receipt-1',
            computerActionId: null,
            taskRunId: child.id,
            evidencePackId: childPack.id,
            evidenceType: 'llm_inference_receipt',
            sourceType: 'agent_loop',
            replayRef: `helm:${childPack.decisionId}`,
            metadata: {
              decisionId: childPack.decisionId,
              policyVersion: childPack.policyVersion,
              parentEvidencePackId: spawnPack.id,
            },
          }),
        ],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'proof_dag_lineage',
      capabilityKey: 'subagent_lineage',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run).toMatchObject({
      evalId: 'proof_dag_lineage',
      status: 'passed',
      capabilityKey: 'subagent_lineage',
      evidenceRefs: ['helm:local_spawn_1', 'helm:child-decision-1'],
      auditReceiptRefs: ['helm:local_spawn_1', 'helm:child-decision-1'],
      metadata: {
        runnerRef: 'gateway:proof_dag_lineage:v1',
        verifiedParentTaskRunId: parent.id,
        verifiedSpawnTaskRunId: spawn.id,
        verifiedChildTaskRunId: child.id,
        verifiedAgentHandoffId: 'handoff-1',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
    });
    expect(result.run.steps[0]).toEqual(
      expect.objectContaining({
        stepKey: 'parent-subagent-proof-dag',
        status: 'passed',
        metadata: expect.objectContaining({
          parentTaskRunId: parent.id,
          spawnTaskRunId: spawn.id,
          childTaskRunId: child.id,
        }),
      }),
    );
  });

  it('fails proof_dag_lineage when child receipt evidence is not anchored to the spawn pack', async () => {
    const task = taskRow({ id: 'task-foundation-1' });
    const parent = taskRunRow({
      id: 'task-run-parent-1',
      taskId: task.id,
      actionTool: 'subagent.parallel',
    });
    const spawn = taskRunRow({
      id: 'task-run-spawn-1',
      taskId: task.id,
      lineageKind: 'subagent_spawn',
      parentTaskRunId: parent.id,
      rootTaskRunId: parent.id,
      spawnedByActionId: parent.id,
      actionTool: 'subagent.spawn',
      operatorRole: 'research',
    });
    const child = taskRunRow({
      id: 'task-run-child-1',
      taskId: task.id,
      lineageKind: 'subagent_action',
      parentTaskRunId: spawn.id,
      rootTaskRunId: parent.id,
      actionTool: 'search_knowledge',
    });
    const spawnPack = helmReceiptPack({
      id: 'pack-subagent-spawn-1',
      decisionId: 'local_spawn_1',
      taskRunId: spawn.id,
      action: 'SUBAGENT_SPAWN',
      principal: `workspace:${workspaceId}/operator:research/subagent:researcher:abc123`,
    });
    const runner = createProductionEvalRunner(
      createRunnerDb({
        taskRows: [task],
        taskRunRows: [parent, spawn, child],
        handoffRows: [
          agentHandoffRow({
            taskId: task.id,
            parentTaskRunId: parent.id,
            childTaskRunId: spawn.id,
          }),
        ],
        packs: [spawnPack],
        evidence: [
          evidenceItem({
            computerActionId: null,
            evidencePackId: spawnPack.id,
            evidenceType: 'subagent_spawn_receipt',
            sourceType: 'conductor',
            replayRef: `helm:${spawnPack.decisionId}`,
            metadata: {
              decisionId: spawnPack.decisionId,
              policyVersion: spawnPack.policyVersion,
              action: 'SUBAGENT_SPAWN',
            },
          }),
        ],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'proof_dag_lineage',
      capabilityKey: 'subagent_lineage',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('child receipt evidence');
  });

  it('passes multi_agent_parallel_build from restart-verified A2A state and brokered parallel agent evidence', async () => {
    const task = taskRow({ id: 'task-parallel-build-1', mode: 'a2a' });
    const thread = a2aThreadRow({
      id: 'a2a-thread-parallel-build-1',
      externalTaskId: 'external-parallel-build-1',
      pilotTaskId: task.id,
    });
    const parent = taskRunRow({
      id: 'task-run-build-parent-1',
      taskId: task.id,
      lineageKind: 'parent_action',
      parentTaskRunId: null,
      rootTaskRunId: null,
      actionTool: 'subagent.parallel',
      runSequence: 1,
    });
    const landingChild = taskRunRow({
      id: 'task-run-build-landing-1',
      taskId: task.id,
      lineageKind: 'subagent_spawn',
      parentTaskRunId: parent.id,
      rootTaskRunId: parent.id,
      spawnedByActionId: parent.id,
      actionTool: 'artifact_writer',
      operatorRole: 'frontend_builder',
      runSequence: 2,
    });
    const analyticsChild = taskRunRow({
      id: 'task-run-build-analytics-1',
      taskId: task.id,
      lineageKind: 'subagent_spawn',
      parentTaskRunId: parent.id,
      rootTaskRunId: parent.id,
      spawnedByActionId: parent.id,
      actionTool: 'analytics_config',
      operatorRole: 'analytics_builder',
      runSequence: 3,
    });
    const landingExecution = toolExecution({
      id: 'tool-execution-landing-1',
      actionId: 'action-landing-1',
      taskRunId: landingChild.id,
      toolKey: 'artifact_writer',
      outputHash: 'sha256:landing-output',
      sanitizedOutput: {
        artifactDiffRef: 'artifact:landing-page:diff:1',
        evidenceKinds: ['agent_run_log', 'artifact_diff'],
      },
      evidenceIds: ['evidence-tool-landing-1'],
      policyDecisionId: 'decision-landing-1',
      policyVersion: 'founder-ops-v1',
      helmDocumentVersionPins: { toolPolicy: 'founder-ops-v1' },
    });
    const analyticsExecution = toolExecution({
      id: 'tool-execution-analytics-1',
      actionId: 'action-analytics-1',
      taskRunId: analyticsChild.id,
      toolKey: 'analytics_config',
      outputHash: 'sha256:analytics-output',
      sanitizedOutput: {
        evidenceKinds: ['agent_run_log'],
      },
      evidenceIds: ['evidence-tool-analytics-1'],
      policyDecisionId: 'decision-analytics-1',
      policyVersion: 'founder-ops-v1',
      helmDocumentVersionPins: { toolPolicy: 'founder-ops-v1' },
    });
    const dispatchEvidence = evidenceItem({
      id: 'evidence-a2a-dispatch',
      computerActionId: null,
      taskId: task.id,
      auditEventId: 'audit-a2a-dispatch',
      evidenceType: 'a2a_task_dispatched',
      sourceType: 'gateway_a2a_route',
      sensitivity: 'internal',
      replayRef: `a2a:${thread.externalTaskId}:dispatch:audit-a2a-dispatch`,
      metadata: {
        externalTaskId: thread.externalTaskId,
        pilotTaskId: task.id,
        evidenceContract: 'a2a_dispatch_evidence_required',
      },
    });
    const landingEvidence = evidenceItem({
      id: 'evidence-tool-landing-1',
      computerActionId: null,
      taskRunId: landingChild.id,
      actionId: landingExecution.actionId,
      toolExecutionId: landingExecution.id,
      auditEventId: 'audit-tool-landing-1',
      evidenceType: 'tool_execution_completed',
      sourceType: 'tool_broker',
      contentHash: landingExecution.outputHash,
      replayRef: `tool:${landingExecution.id}`,
      metadata: {
        broker: 'tool_broker_v1',
        toolKey: landingExecution.toolKey,
        toolExecutionId: landingExecution.id,
        status: 'completed',
        policyDecisionId: landingExecution.policyDecisionId,
        policyVersion: landingExecution.policyVersion,
        requiredEvidence: ['agent_run_log', 'artifact_diff'],
      },
    });
    const analyticsEvidence = evidenceItem({
      id: 'evidence-tool-analytics-1',
      computerActionId: null,
      taskRunId: analyticsChild.id,
      actionId: analyticsExecution.actionId,
      toolExecutionId: analyticsExecution.id,
      auditEventId: 'audit-tool-analytics-1',
      evidenceType: 'tool_execution_completed',
      sourceType: 'tool_broker',
      contentHash: analyticsExecution.outputHash,
      replayRef: `tool:${analyticsExecution.id}`,
      metadata: {
        broker: 'tool_broker_v1',
        toolKey: analyticsExecution.toolKey,
        toolExecutionId: analyticsExecution.id,
        status: 'completed',
        policyDecisionId: analyticsExecution.policyDecisionId,
        policyVersion: analyticsExecution.policyVersion,
        requiredEvidence: ['agent_run_log'],
      },
    });
    const runner = createProductionEvalRunner(
      createRunnerDb({
        a2aThreadRows: [thread],
        a2aMessageRows: [
          a2aMessageRow({ id: 'a2a-message-1', threadId: thread.id, sequence: 1 }),
          a2aMessageRow({
            id: 'a2a-message-2',
            threadId: thread.id,
            role: 'agent',
            parts: [{ type: 'text', text: 'Parallel build completed with evidence.' }],
            sequence: 2,
          }),
        ],
        taskRows: [task],
        taskRunRows: [parent, landingChild, analyticsChild],
        handoffRows: [
          agentHandoffRow({
            id: 'handoff-landing-1',
            taskId: task.id,
            parentTaskRunId: parent.id,
            childTaskRunId: landingChild.id,
            toAgent: 'frontend_builder',
          }),
          agentHandoffRow({
            id: 'handoff-analytics-1',
            taskId: task.id,
            parentTaskRunId: parent.id,
            childTaskRunId: analyticsChild.id,
            toAgent: 'analytics_builder',
          }),
        ],
        toolExecutionRows: [landingExecution, analyticsExecution],
        evidence: [dispatchEvidence, landingEvidence, analyticsEvidence],
        audits: [
          auditRow({
            id: 'audit-a2a-dispatch',
            action: 'A2A_TASK_SEND_DISPATCHED',
            target: task.id,
            verdict: 'allow',
            metadata: {
              externalTaskId: thread.externalTaskId,
              pilotTaskId: task.id,
              evidenceItemId: dispatchEvidence.id,
            },
          }),
          auditRow({
            id: 'audit-tool-landing-1',
            action: 'TOOL_EXECUTION',
            target: landingExecution.toolKey,
            verdict: 'allow',
            metadata: {
              broker: 'tool_broker_v1',
              toolKey: landingExecution.toolKey,
              toolExecutionId: landingExecution.id,
              evidenceItemId: landingEvidence.id,
              policyDecisionId: landingExecution.policyDecisionId,
              policyVersion: landingExecution.policyVersion,
            },
          }),
          auditRow({
            id: 'audit-tool-analytics-1',
            action: 'TOOL_EXECUTION',
            target: analyticsExecution.toolKey,
            verdict: 'allow',
            metadata: {
              broker: 'tool_broker_v1',
              toolKey: analyticsExecution.toolKey,
              toolExecutionId: analyticsExecution.id,
              evidenceItemId: analyticsEvidence.id,
              policyDecisionId: analyticsExecution.policyDecisionId,
              policyVersion: analyticsExecution.policyVersion,
            },
          }),
        ],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'multi_agent_parallel_build',
      capabilityKey: 'a2a_durable_state',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run).toMatchObject({
      evalId: 'multi_agent_parallel_build',
      status: 'passed',
      capabilityKey: 'a2a_durable_state',
      evidenceRefs: [
        dispatchEvidence.replayRef,
        landingEvidence.replayRef,
        analyticsEvidence.replayRef,
      ],
      auditReceiptRefs: [
        'audit:audit-a2a-dispatch',
        'audit:audit-tool-landing-1',
        'audit:audit-tool-analytics-1',
      ],
      metadata: {
        runnerRef: 'gateway:multi_agent_parallel_build:v1',
        verifiedA2aThreadId: thread.id,
        verifiedPilotTaskId: task.id,
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
    });
    expect(result.run.steps).toEqual([
      expect.objectContaining({
        stepKey: 'durable-a2a-restart-replay',
        status: 'passed',
      }),
      expect.objectContaining({
        stepKey: 'parallel-agent-tool-evidence',
        status: 'passed',
        metadata: expect.objectContaining({
          handoffIds: ['handoff-landing-1', 'handoff-analytics-1'],
          childTaskRunIds: [landingChild.id, analyticsChild.id],
        }),
      }),
    ]);
  });

  it('fails multi_agent_parallel_build without restart-verified A2A state', async () => {
    const task = taskRow({ id: 'task-parallel-build-1', mode: 'a2a' });
    const runner = createProductionEvalRunner(
      createRunnerDb({
        a2aThreadRows: [
          a2aThreadRow({
            pilotTaskId: task.id,
            metadata: {
              conductStatus: 'completed',
              dispatchEvidenceItemId: 'evidence-a2a-dispatch',
              restartVerified: false,
            },
          }),
        ],
        taskRows: [task],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'multi_agent_parallel_build',
      capabilityKey: 'a2a_durable_state',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('restart-verified A2A thread');
  });

  it('passes approval_resume_isolation from deterministic parent-only replay evidence', async () => {
    const task = taskRow({ id: 'task-resume-1' });
    const parentOne = taskRunRow({
      id: 'task-run-parent-1',
      taskId: task.id,
      lineageKind: 'parent_action',
      parentTaskRunId: null,
      actionTool: 'search_knowledge',
      runSequence: 1,
      startedAt: new Date('2026-05-12T00:01:00.000Z'),
    });
    const parentTwo = taskRunRow({
      id: 'task-run-parent-2',
      taskId: task.id,
      lineageKind: 'parent_action',
      parentTaskRunId: null,
      actionTool: 'score_opportunity',
      runSequence: 2,
      startedAt: new Date('2026-05-12T00:02:00.000Z'),
    });
    const child = taskRunRow({
      id: 'task-run-child-1',
      taskId: task.id,
      lineageKind: 'subagent_action',
      parentTaskRunId: 'task-run-spawn-1',
      rootTaskRunId: parentOne.id,
      actionTool: 'search_knowledge',
      runSequence: 3,
    });
    const resumeEvidence = evidenceItem({
      id: 'evidence-resume-1',
      computerActionId: null,
      auditEventId: 'audit-resume-1',
      evidenceType: 'task_resume_dispatched',
      sourceType: 'task_resume_worker',
      replayRef: `task:${workspaceId}:${task.id}:resume:audit-resume-1`,
      metadata: {
        taskId: task.id,
        priorActionCount: 2,
        evidenceContract: 'task_resume_dispatch_before_orchestrator_resume',
        credentialBoundary: 'no_raw_credentials_or_session_payloads_in_evidence',
        replayRef: `task:${workspaceId}:${task.id}:resume:audit-resume-1`,
      },
    });
    const runner = createProductionEvalRunner(
      createRunnerDb({
        taskRows: [task],
        taskRunRows: [parentTwo, child, parentOne],
        evidence: [resumeEvidence],
        audits: [
          auditRow({
            id: 'audit-resume-1',
            action: 'TASK_RESUME_DISPATCHED',
            target: task.id,
            verdict: 'allow',
            metadata: {
              taskId: task.id,
              priorActionCount: 2,
              evidenceItemId: resumeEvidence.id,
              replayRef: resumeEvidence.replayRef,
            },
          }),
        ],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'approval_resume_isolation',
      capabilityKey: 'approval_resume',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run).toMatchObject({
      evalId: 'approval_resume_isolation',
      status: 'passed',
      capabilityKey: 'approval_resume',
      evidenceRefs: [resumeEvidence.replayRef],
      auditReceiptRefs: ['audit:audit-resume-1'],
      metadata: {
        runnerRef: 'gateway:approval_resume_isolation:v1',
        verifiedTaskId: task.id,
        parentReplayTaskRunIds: [parentOne.id, parentTwo.id],
        excludedChildTaskRunIds: [child.id],
        priorActionCount: 2,
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
    });
  });

  it('fails approval_resume_isolation when child rows are absent from the replay fixture', async () => {
    const task = taskRow({ id: 'task-resume-1' });
    const parentOne = taskRunRow({ id: 'task-run-parent-1', taskId: task.id, runSequence: 1 });
    const parentTwo = taskRunRow({ id: 'task-run-parent-2', taskId: task.id, runSequence: 2 });
    const runner = createProductionEvalRunner(
      createRunnerDb({
        taskRows: [task],
        taskRunRows: [parentOne, parentTwo],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'approval_resume_isolation',
      capabilityKey: 'approval_resume',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('excluded child/subagent row');
  });

  it('passes cross_workspace_operator_rejection from gateway and runtime denial evidence', async () => {
    const gatewayReplayRef = `operator-scope:${workspaceId}:gateway_operator_scope:audit-operator-gateway`;
    const runtimeReplayRef = `operator-scope:${workspaceId}:orchestrator_operator_scope:audit-operator-runtime`;
    const gatewayMetadata = {
      requestedOperatorId: 'operator-foreign-gateway',
      surface: 'gateway:/conduct',
      reason: 'operatorId_not_in_workspace',
      evidenceContract: 'operator_scope_denial_evidence_required',
      credentialBoundary: 'no_raw_credentials_or_session_payloads_in_evidence',
      replayRef: gatewayReplayRef,
    };
    const runtimeMetadata = {
      requestedOperatorId: 'operator-foreign-runtime',
      surface: 'orchestrator.resolveRuntime',
      reason: 'operatorId_not_in_workspace',
      evidenceContract: 'operator_scope_denial_evidence_required',
      credentialBoundary: 'no_raw_credentials_or_session_payloads_in_evidence',
      replayRef: runtimeReplayRef,
    };
    const runner = createProductionEvalRunner(
      createRunnerDb({
        evidence: [
          evidenceItem({
            id: 'evidence-operator-gateway',
            computerActionId: null,
            evidenceType: 'workspace_operator_scope_rejected',
            sourceType: 'gateway_operator_scope',
            auditEventId: 'audit-operator-gateway',
            sensitivity: 'internal',
            replayRef: gatewayReplayRef,
            metadata: gatewayMetadata,
          }),
          evidenceItem({
            id: 'evidence-operator-runtime',
            computerActionId: null,
            evidenceType: 'workspace_operator_scope_rejected',
            sourceType: 'orchestrator_operator_scope',
            auditEventId: 'audit-operator-runtime',
            sensitivity: 'internal',
            replayRef: runtimeReplayRef,
            metadata: runtimeMetadata,
          }),
        ],
        audits: [
          auditRow({
            id: 'audit-operator-gateway',
            action: 'WORKSPACE_OPERATOR_SCOPE_REJECTED',
            target: 'operator-foreign-gateway',
            verdict: 'deny',
            metadata: { ...gatewayMetadata, evidenceItemId: 'evidence-operator-gateway' },
          }),
          auditRow({
            id: 'audit-operator-runtime',
            action: 'WORKSPACE_OPERATOR_SCOPE_REJECTED',
            target: 'operator-foreign-runtime',
            verdict: 'deny',
            metadata: { ...runtimeMetadata, evidenceItemId: 'evidence-operator-runtime' },
          }),
        ],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'cross_workspace_operator_rejection',
      capabilityKey: 'operator_scoping',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run).toMatchObject({
      evalId: 'cross_workspace_operator_rejection',
      status: 'passed',
      capabilityKey: 'operator_scoping',
      evidenceRefs: [gatewayReplayRef, runtimeReplayRef],
      auditReceiptRefs: ['audit:audit-operator-gateway', 'audit:audit-operator-runtime'],
      metadata: {
        runnerRef: 'gateway:cross_workspace_operator_rejection:v1',
        verifiedGatewayEvidenceItemId: 'evidence-operator-gateway',
        verifiedRuntimeEvidenceItemId: 'evidence-operator-runtime',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
    });
  });

  it('fails cross_workspace_operator_rejection without runtime denial evidence', async () => {
    const gatewayReplayRef = `operator-scope:${workspaceId}:gateway_operator_scope:audit-operator-gateway`;
    const metadata = {
      requestedOperatorId: 'operator-foreign-gateway',
      surface: 'gateway:/tasks',
      reason: 'operatorId_not_in_workspace',
      evidenceContract: 'operator_scope_denial_evidence_required',
      credentialBoundary: 'no_raw_credentials_or_session_payloads_in_evidence',
      replayRef: gatewayReplayRef,
    };
    const runner = createProductionEvalRunner(
      createRunnerDb({
        evidence: [
          evidenceItem({
            id: 'evidence-operator-gateway',
            computerActionId: null,
            evidenceType: 'workspace_operator_scope_rejected',
            sourceType: 'gateway_operator_scope',
            auditEventId: 'audit-operator-gateway',
            sensitivity: 'internal',
            replayRef: gatewayReplayRef,
            metadata,
          }),
        ],
        audits: [
          auditRow({
            id: 'audit-operator-gateway',
            action: 'WORKSPACE_OPERATOR_SCOPE_REJECTED',
            target: 'operator-foreign-gateway',
            verdict: 'deny',
            metadata: { ...metadata, evidenceItemId: 'evidence-operator-gateway' },
          }),
        ],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'cross_workspace_operator_rejection',
      capabilityKey: 'operator_scoping',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('gateway ingress and orchestrator runtime');
  });

  it('passes recovery from recovery plan, pre-recovery checkpoint, and recovery apply receipts', async () => {
    const missionId = 'mission-recovery-1';
    const planReplayRef = `mission:${missionId}:recovery-plan:abc123`;
    const checkpointReplayRef = `mission:${missionId}:checkpoint:pre_recovery:checkpoint-1`;
    const applyReplayRef = `mission:${missionId}:recovery-apply:def456`;
    const planHash = `sha256:${'a'.repeat(64)}`;
    const checkpointHash = `sha256:${'b'.repeat(64)}`;
    const applyHash = `sha256:${'c'.repeat(64)}`;
    const planMetadata = {
      recoveryPlanVersion: 'mission-recovery-plan.v1',
      recoveryPlanId: 'mission-recovery-plan:abc123',
      checkpointId: 'mission-checkpoint:abc123',
      checkpointReplayRef: `mission:${missionId}:checkpoint:abc123`,
      missionStatus: 'blocked',
      recoveryExecuted: false,
      plan: { failedNodeKeys: ['ideation'] },
      snapshot: { nodeStatusCounts: { failed: 1 } },
      productionReady: false,
    };
    const checkpointMetadata = {
      checkpointKind: 'pre_recovery',
      checkpointId: 'checkpoint-1',
      missionStatus: 'blocked',
      cursorNodeKey: 'ideation',
      reason: 'retry failed ideation node',
      productionReady: false,
    };
    const applyMetadata = {
      recoveryApplyVersion: 'mission-recovery-apply.v1',
      recoveryApplyId: 'mission-recovery-apply:def456',
      recoveryPlanReplayRef: planReplayRef,
      recoveryPlanEvidenceItemId: 'evidence-recovery-plan',
      runtimeCheckpointId: 'checkpoint-1',
      runtimeCheckpointEvidenceItemIds: ['evidence-recovery-checkpoint'],
      recoveredNodeKeys: ['ideation'],
      skippedNodes: [],
      executionStarted: false,
      productionReady: false,
    };
    const runner = createProductionEvalRunner(
      createRunnerDb({
        evidence: [
          evidenceItem({
            id: 'evidence-recovery-plan',
            missionId,
            computerActionId: null,
            evidenceType: 'startup_lifecycle_recovery_plan',
            sourceType: 'gateway_startup_lifecycle',
            auditEventId: 'audit-recovery-plan',
            sensitivity: 'internal',
            contentHash: planHash,
            replayRef: planReplayRef,
            metadata: planMetadata,
          }),
          evidenceItem({
            id: 'evidence-recovery-checkpoint',
            missionId,
            computerActionId: null,
            evidenceType: 'startup_lifecycle_mission_checkpoint',
            sourceType: 'gateway_startup_lifecycle',
            auditEventId: 'audit-recovery-checkpoint',
            sensitivity: 'internal',
            contentHash: checkpointHash,
            replayRef: checkpointReplayRef,
            metadata: checkpointMetadata,
          }),
          evidenceItem({
            id: 'evidence-recovery-apply',
            missionId,
            computerActionId: null,
            evidenceType: 'startup_lifecycle_recovery_applied',
            sourceType: 'gateway_startup_lifecycle',
            auditEventId: 'audit-recovery-apply',
            sensitivity: 'internal',
            contentHash: applyHash,
            replayRef: applyReplayRef,
            metadata: applyMetadata,
          }),
        ],
        audits: [
          auditRow({
            id: 'audit-recovery-plan',
            action: 'STARTUP_LIFECYCLE_RECOVERY_PLAN',
            target: missionId,
            verdict: 'recorded',
            metadata: {
              ...planMetadata,
              evidenceType: 'startup_lifecycle_recovery_plan',
              replayRef: planReplayRef,
              contentHash: planHash,
              evidenceItemId: 'evidence-recovery-plan',
            },
          }),
          auditRow({
            id: 'audit-recovery-checkpoint',
            action: 'STARTUP_LIFECYCLE_MISSION_CHECKPOINT',
            target: missionId,
            verdict: 'recorded',
            metadata: {
              ...checkpointMetadata,
              checkpointVersion: 'mission-runtime-checkpoint.v1',
              evidenceType: 'startup_lifecycle_mission_checkpoint',
              replayRef: checkpointReplayRef,
              contentHash: checkpointHash,
              evidenceItemId: 'evidence-recovery-checkpoint',
            },
          }),
          auditRow({
            id: 'audit-recovery-apply',
            action: 'STARTUP_LIFECYCLE_RECOVERY_APPLIED',
            target: missionId,
            verdict: 'recorded',
            metadata: {
              ...applyMetadata,
              evidenceType: 'startup_lifecycle_recovery_applied',
              replayRef: applyReplayRef,
              contentHash: applyHash,
              evidenceItemId: 'evidence-recovery-apply',
            },
          }),
        ],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'recovery',
      capabilityKey: 'evidence_ledger',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run).toMatchObject({
      evalId: 'recovery',
      status: 'passed',
      capabilityKey: 'evidence_ledger',
      evidenceRefs: [planReplayRef, checkpointReplayRef, applyReplayRef],
      auditReceiptRefs: [
        'audit:audit-recovery-plan',
        'audit:audit-recovery-checkpoint',
        'audit:audit-recovery-apply',
      ],
      metadata: {
        runnerRef: 'gateway:recovery:v1',
        verifiedMissionId: missionId,
        verifiedRecoveryPlanEvidenceItemId: 'evidence-recovery-plan',
        verifiedCheckpointEvidenceItemId: 'evidence-recovery-checkpoint',
        verifiedRecoveryApplyEvidenceItemId: 'evidence-recovery-apply',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
    });
  });

  it('fails recovery when the recovery apply audit receipt is missing', async () => {
    const missionId = 'mission-recovery-1';
    const planReplayRef = `mission:${missionId}:recovery-plan:abc123`;
    const checkpointReplayRef = `mission:${missionId}:checkpoint:pre_recovery:checkpoint-1`;
    const applyReplayRef = `mission:${missionId}:recovery-apply:def456`;
    const runner = createProductionEvalRunner(
      createRunnerDb({
        evidence: [
          evidenceItem({
            id: 'evidence-recovery-plan',
            missionId,
            computerActionId: null,
            evidenceType: 'startup_lifecycle_recovery_plan',
            sourceType: 'gateway_startup_lifecycle',
            auditEventId: 'audit-recovery-plan',
            sensitivity: 'internal',
            contentHash: `sha256:${'a'.repeat(64)}`,
            replayRef: planReplayRef,
            metadata: {
              recoveryPlanVersion: 'mission-recovery-plan.v1',
              recoveryPlanId: 'mission-recovery-plan:abc123',
              checkpointId: 'mission-checkpoint:abc123',
              checkpointReplayRef,
              recoveryExecuted: false,
              plan: {},
              snapshot: {},
              productionReady: false,
            },
          }),
          evidenceItem({
            id: 'evidence-recovery-apply',
            missionId,
            computerActionId: null,
            evidenceType: 'startup_lifecycle_recovery_applied',
            sourceType: 'gateway_startup_lifecycle',
            auditEventId: 'audit-recovery-apply',
            sensitivity: 'internal',
            contentHash: `sha256:${'c'.repeat(64)}`,
            replayRef: applyReplayRef,
            metadata: {
              recoveryApplyVersion: 'mission-recovery-apply.v1',
              recoveryApplyId: 'mission-recovery-apply:def456',
              recoveryPlanReplayRef: planReplayRef,
              recoveryPlanEvidenceItemId: 'evidence-recovery-plan',
              runtimeCheckpointId: 'checkpoint-1',
              runtimeCheckpointEvidenceItemIds: ['evidence-recovery-checkpoint'],
              recoveredNodeKeys: ['ideation'],
              executionStarted: false,
              productionReady: false,
            },
          }),
        ],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'recovery',
      capabilityKey: 'evidence_ledger',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('recovery-applied evidence with durable audit');
  });

  it('passes command_center_real_state_ux only from durable API fixture, screenshot, accessibility, and audit proof', async () => {
    const replayRef = 'command-center:eval:real-state-ux:1';
    const contentHash = `sha256:${'d'.repeat(64)}`;
    const metadata = commandCenterUxMetadata();
    const runner = createProductionEvalRunner(
      createRunnerDb({
        evidence: [
          evidenceItem({
            id: 'evidence-command-center-ux',
            computerActionId: null,
            evidenceType: 'command_center_real_state_ux',
            sourceType: 'command_center_eval',
            auditEventId: 'audit-command-center-ux',
            sensitivity: 'internal',
            contentHash,
            replayRef,
            metadata,
          }),
        ],
        audits: [
          auditRow({
            id: 'audit-command-center-ux',
            action: 'COMMAND_CENTER_REAL_STATE_UX_EVAL',
            target: 'command_center',
            verdict: 'recorded',
            metadata: {
              ...metadata,
              evidenceItemId: 'evidence-command-center-ux',
              evidenceType: 'command_center_real_state_ux',
              sourceType: 'command_center_eval',
              replayRef,
              contentHash,
            },
          }),
        ],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'command_center_real_state_ux',
      capabilityKey: 'command_center',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run).toMatchObject({
      evalId: 'command_center_real_state_ux',
      status: 'passed',
      capabilityKey: 'command_center',
      evidenceRefs: [replayRef],
      auditReceiptRefs: ['audit:audit-command-center-ux'],
      metadata: {
        runnerRef: 'gateway:command_center_real_state_ux:v1',
        verifiedEvidenceItemId: 'evidence-command-center-ux',
        verifiedAuditEventId: 'audit-command-center-ux',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
    });
    expect(result.run.steps).toEqual([
      expect.objectContaining({
        stepKey: 'durable-command-center-api-fixture',
        status: 'passed',
        evidenceRefs: [replayRef],
      }),
      expect.objectContaining({
        stepKey: 'ui-screenshot-and-replay-surfaces',
        status: 'passed',
        evidenceRefs: [replayRef],
      }),
      expect.objectContaining({
        stepKey: 'accessibility-and-claim-control',
        status: 'passed',
        evidenceRefs: [replayRef],
        metadata: expect.objectContaining({
          routeLocalMockState: false,
          productionReadyClaims: false,
        }),
      }),
    ]);
  });

  it('fails command_center_real_state_ux when screenshot proof is missing', async () => {
    const runner = createProductionEvalRunner(
      createRunnerDb({
        evidence: [
          evidenceItem({
            id: 'evidence-command-center-ux',
            computerActionId: null,
            evidenceType: 'command_center_real_state_ux',
            sourceType: 'command_center_eval',
            auditEventId: 'audit-command-center-ux',
            sensitivity: 'internal',
            contentHash: `sha256:${'d'.repeat(64)}`,
            replayRef: 'command-center:eval:real-state-ux:1',
            metadata: commandCenterUxMetadata({ uiScreenshotHash: undefined }),
          }),
        ],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'command_center_real_state_ux',
      capabilityKey: 'command_center',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('UI screenshot');
  });

  it('fails command_center_real_state_ux when accessibility proof is missing', async () => {
    const runner = createProductionEvalRunner(
      createRunnerDb({
        evidence: [
          evidenceItem({
            id: 'evidence-command-center-ux',
            computerActionId: null,
            evidenceType: 'command_center_real_state_ux',
            sourceType: 'command_center_eval',
            auditEventId: 'audit-command-center-ux',
            sensitivity: 'internal',
            contentHash: `sha256:${'d'.repeat(64)}`,
            replayRef: 'command-center:eval:real-state-ux:1',
            metadata: commandCenterUxMetadata({ accessibilityReportRef: '' }),
          }),
        ],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'command_center_real_state_ux',
      capabilityKey: 'command_center',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('accessibility report');
  });

  it('fails command_center_real_state_ux when the linked audit receipt is missing', async () => {
    const runner = createProductionEvalRunner(
      createRunnerDb({
        evidence: [
          evidenceItem({
            id: 'evidence-command-center-ux',
            computerActionId: null,
            evidenceType: 'command_center_real_state_ux',
            sourceType: 'command_center_eval',
            auditEventId: 'audit-command-center-ux',
            sensitivity: 'internal',
            contentHash: `sha256:${'d'.repeat(64)}`,
            replayRef: 'command-center:eval:real-state-ux:1',
            metadata: commandCenterUxMetadata(),
          }),
        ],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'command_center_real_state_ux',
      capabilityKey: 'command_center',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('linked audit receipt');
  });

  it('passes pmf_discovery opportunity_scoring only from brokered score evidence and audit rows', async () => {
    const opp = opportunity({ id: 'opp-pmf-1' });
    const score = opportunityScore({ id: 'score-pmf-1', opportunityId: opp.id });
    const execution = toolExecution({
      id: 'tool-execution-pmf-1',
      actionId: 'action-pmf-score-1',
      sanitizedInput: { opportunityId: opp.id },
      sanitizedOutput: opportunityScoreOutput(opp.id),
      evidenceIds: ['evidence-pmf-score-tool'],
    });
    const runner = createProductionEvalRunner(
      createRunnerDb({
        opportunityRows: [opp],
        scoreRows: [score],
        toolExecutionRows: [execution],
        evidence: [
          evidenceItem({
            id: 'evidence-pmf-score-tool',
            computerActionId: null,
            actionId: execution.actionId,
            toolExecutionId: execution.id,
            evidenceType: 'tool_execution_completed',
            sourceType: 'tool_broker',
            auditEventId: 'audit-pmf-score-tool',
            contentHash: execution.outputHash,
            replayRef: `tool:${execution.id}`,
            metadata: {
              broker: 'tool_broker_v1',
              toolKey: 'score_opportunity',
              actionId: execution.actionId,
              toolExecutionId: execution.id,
              status: 'completed',
              requiredEvidence: ['opportunity_score', 'citations'],
              policyDecisionId: execution.policyDecisionId,
              policyVersion: execution.policyVersion,
            },
          }),
        ],
        audits: [
          auditRow({
            id: 'audit-pmf-score-tool',
            action: 'TOOL_EXECUTION',
            target: 'score_opportunity',
            verdict: 'allow',
            metadata: {
              broker: 'tool_broker_v1',
              toolKey: 'score_opportunity',
              toolExecutionId: execution.id,
              evidenceItemId: 'evidence-pmf-score-tool',
              policyDecisionId: execution.policyDecisionId,
              policyVersion: execution.policyVersion,
            },
          }),
        ],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'pmf_discovery',
      capabilityKey: 'opportunity_scoring',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run).toMatchObject({
      evalId: 'pmf_discovery',
      status: 'passed',
      capabilityKey: 'opportunity_scoring',
      evidenceRefs: ['tool:tool-execution-pmf-1'],
      auditReceiptRefs: ['audit:audit-pmf-score-tool'],
      metadata: {
        runnerRef: 'gateway:pmf_discovery:opportunity_scoring:v1',
        verifiedOpportunityId: 'opp-pmf-1',
        verifiedScoreId: 'score-pmf-1',
        verifiedToolExecutionId: 'tool-execution-pmf-1',
        citationCount: 1,
        assumptionCount: 1,
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
    });
    expect(result.run.steps).toEqual([
      expect.objectContaining({
        stepKey: 'evidence-backed-opportunity-score',
        status: 'passed',
        metadata: expect.objectContaining({
          opportunityId: 'opp-pmf-1',
          scoringMethod: 'evidence_v1',
          citationCount: 1,
          policyDecisionId: 'score-decision-1',
        }),
      }),
    ]);
  });

  it('fails pmf_discovery when citations are missing from score_opportunity output', async () => {
    const opp = opportunity({ id: 'opp-pmf-1' });
    const execution = toolExecution({
      sanitizedOutput: {
        ...opportunityScoreOutput(opp.id),
        citations: [],
      },
    });
    const runner = createProductionEvalRunner(
      createRunnerDb({
        opportunityRows: [opp],
        scoreRows: [opportunityScore({ opportunityId: opp.id })],
        toolExecutionRows: [execution],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'pmf_discovery',
      capabilityKey: 'opportunity_scoring',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('citations');
  });

  it('fails pmf_discovery startup_lifecycle requests instead of overclaiming lifecycle coverage', async () => {
    const runner = createProductionEvalRunner(createRunnerDb({}));

    const result = await runner.execute({
      workspaceId,
      evalId: 'pmf_discovery',
      capabilityKey: 'startup_lifecycle',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('opportunity_scoring slice only');
  });

  it('passes helm_governance only from allow and restricted durable receipt evidence with audits', async () => {
    const allowed = helmReceiptPack({
      id: 'pack-allow',
      decisionId: 'dec-allow',
      verdict: 'allow',
      decisionHash: 'b'.repeat(64),
      resource: 'tool:read',
    });
    const denied = helmReceiptPack({
      id: 'pack-deny',
      decisionId: 'dec-deny',
      verdict: 'deny',
      decisionHash: 'c'.repeat(64),
      resource: 'tool:restricted',
    });
    const runner = createProductionEvalRunner(
      createRunnerDb({
        packs: [allowed, denied],
        evidence: [
          evidenceItem({
            id: 'evidence-allow',
            evidencePackId: allowed.id,
            computerActionId: null,
            evidenceType: 'helm_receipt',
            auditEventId: 'audit-allow',
            contentHash: allowed.decisionHash,
            replayRef: `helm:${allowed.decisionId}`,
            metadata: helmReceiptMetadata(allowed),
          }),
          evidenceItem({
            id: 'evidence-deny',
            evidencePackId: denied.id,
            computerActionId: null,
            evidenceType: 'helm_receipt',
            auditEventId: 'audit-deny',
            contentHash: denied.decisionHash,
            replayRef: `helm:${denied.decisionId}`,
            metadata: helmReceiptMetadata(denied),
          }),
        ],
        audits: [
          auditRow({
            id: 'audit-allow',
            action: 'HELM_RECEIPT_PERSISTED',
            target: allowed.decisionId,
            verdict: allowed.verdict,
            metadata: helmReceiptAuditMetadata(allowed),
          }),
          auditRow({
            id: 'audit-deny',
            action: 'HELM_RECEIPT_PERSISTED',
            target: denied.decisionId,
            verdict: denied.verdict,
            metadata: helmReceiptAuditMetadata(denied),
          }),
        ],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'helm_governance',
      capabilityKey: 'helm_receipts',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run).toMatchObject({
      evalId: 'helm_governance',
      status: 'passed',
      capabilityKey: 'helm_receipts',
      evidenceRefs: ['helm:dec-allow', 'helm:dec-deny'],
      auditReceiptRefs: ['audit:audit-allow', 'audit:audit-deny'],
      metadata: {
        runnerRef: 'gateway:helm_governance:v1',
        verifiedEvidencePackIds: ['pack-allow', 'pack-deny'],
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
    });
    expect(result.run.steps).toEqual([
      expect.objectContaining({
        stepKey: 'allowed-helm-receipt-evidence',
        status: 'passed',
        metadata: expect.objectContaining({ decisionId: 'dec-allow', verdict: 'allow' }),
      }),
      expect.objectContaining({
        stepKey: 'restricted-helm-receipt-evidence',
        status: 'passed',
        metadata: expect.objectContaining({ decisionId: 'dec-deny', verdict: 'deny' }),
      }),
    ]);
  });

  it('fails helm_governance when restricted receipt outcome is missing', async () => {
    const runner = createProductionEvalRunner(
      createRunnerDb({
        packs: [helmReceiptPack({ verdict: 'allow' })],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'helm_governance',
      capabilityKey: 'helm_receipts',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('DENY or ESCALATE');
  });

  it('passes decision_court_governed_model only from governed court evidence and audit rows', async () => {
    const metadata = decisionCourtMetadata();
    const runner = createProductionEvalRunner(
      createRunnerDb({
        evidence: [
          evidenceItem({
            id: 'evidence-decision-court',
            computerActionId: null,
            evidenceType: 'decision_court_run',
            sourceType: 'decision_court',
            auditEventId: 'audit-decision-court',
            redactionState: 'redacted',
            contentHash: `sha256:${'d'.repeat(64)}`,
            replayRef: 'decision-court:audit-decision-court',
            metadata,
          }),
        ],
        audits: [
          auditRow({
            id: 'audit-decision-court',
            action: 'DECISION_COURT_RUN',
            target: 'governed_llm_court',
            verdict: 'completed',
            metadata: { ...metadata, evidenceItemId: 'evidence-decision-court' },
          }),
        ],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'decision_court_governed_model',
      capabilityKey: 'decision_court',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run).toMatchObject({
      evalId: 'decision_court_governed_model',
      status: 'passed',
      capabilityKey: 'decision_court',
      evidenceRefs: ['decision-court:audit-decision-court'],
      auditReceiptRefs: ['audit:audit-decision-court'],
      metadata: {
        runnerRef: 'gateway:decision_court_governed_model:v1',
        verifiedEvidenceItemId: 'evidence-decision-court',
        verifiedAuditEventId: 'audit-decision-court',
        verifiedPolicyDecisionIds: ['model-decision-1', 'model-decision-2', 'model-decision-3'],
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
    });
    expect(result.run.steps).toEqual([
      expect.objectContaining({
        stepKey: 'governed-court-run-evidence',
        status: 'passed',
        metadata: expect.objectContaining({
          mode: 'governed_llm_court',
          participantCount: 3,
          modelCallCount: 3,
        }),
      }),
    ]);
  });

  it('fails decision_court_governed_model when referee proof is missing', async () => {
    const metadata = decisionCourtMetadata({
      modelCalls: [decisionCourtModelCall('bull'), decisionCourtModelCall('bear')],
      policyDecisionIds: ['model-decision-1', 'model-decision-2'],
    });
    const runner = createProductionEvalRunner(
      createRunnerDb({
        evidence: [
          evidenceItem({
            id: 'evidence-decision-court',
            computerActionId: null,
            evidenceType: 'decision_court_run',
            sourceType: 'decision_court',
            auditEventId: 'audit-decision-court',
            redactionState: 'redacted',
            contentHash: `sha256:${'d'.repeat(64)}`,
            replayRef: 'decision-court:audit-decision-court',
            metadata,
          }),
        ],
        audits: [
          auditRow({
            id: 'audit-decision-court',
            action: 'DECISION_COURT_RUN',
            target: 'governed_llm_court',
            verdict: 'completed',
            metadata: { ...metadata, evidenceItemId: 'evidence-decision-court' },
          }),
        ],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'decision_court_governed_model',
      capabilityKey: 'decision_court',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('completed governed_llm_court run');
  });

  it('passes yc_logged_in_browser_extraction only from durable browser evidence and audit rows', async () => {
    const observation = browserObservation({ id: 'browser-yc-1' });
    const runner = createProductionEvalRunner(
      createRunnerDb({
        browser: [observation],
        evidence: [
          evidenceItem({
            id: 'evidence-browser-yc',
            browserObservationId: observation.id,
            computerActionId: null,
            evidenceType: 'browser_observation',
            auditEventId: 'audit-browser-yc',
            replayRef: 'browser:browser-session-1:3',
            metadata: {
              credentialBoundary: browserCredentialBoundary,
              helmDecisionId: 'browser-decision-1',
              helmPolicyVersion: 'founder-ops-v1',
            },
          }),
        ],
        audits: [
          auditRow({
            id: 'audit-browser-yc',
            action: 'BROWSER_OBSERVATION_CAPTURED',
            target: observation.id,
            verdict: 'allow',
            metadata: {
              helmDecisionId: 'browser-decision-1',
              helmPolicyVersion: 'founder-ops-v1',
            },
          }),
        ],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'yc_logged_in_browser_extraction',
      capabilityKey: 'browser_execution',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run).toMatchObject({
      evalId: 'yc_logged_in_browser_extraction',
      status: 'passed',
      capabilityKey: 'browser_execution',
      evidenceRefs: ['browser:browser-session-1:3'],
      auditReceiptRefs: ['audit:audit-browser-yc'],
      metadata: {
        runnerRef: 'gateway:yc_logged_in_browser_extraction:v1',
        verifiedBrowserObservationId: 'browser-yc-1',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
    });
    expect(result.run.steps).toEqual([
      expect.objectContaining({
        stepKey: 'yc-browser-read-extract-evidence',
        status: 'passed',
        evidenceRefs: ['browser:browser-session-1:3'],
        metadata: expect.objectContaining({
          domHash: 'sha256:dom',
          screenshotHash: 'sha256:screenshot',
          redactionCount: 1,
        }),
      }),
    ]);
  });

  it('fails yc_logged_in_browser_extraction when extracted fields are missing', async () => {
    const runner = createProductionEvalRunner(
      createRunnerDb({
        browser: [browserObservation({ extractedData: {} })],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'yc_logged_in_browser_extraction',
      capabilityKey: 'browser_execution',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('requires a durable YC browser observation');
  });

  it('fails yc_logged_in_browser_extraction for lookalike YC domains', async () => {
    const runner = createProductionEvalRunner(
      createRunnerDb({
        browser: [
          browserObservation({
            url: 'https://notycombinator.com/companies',
            origin: 'https://notycombinator.com',
          }),
        ],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'yc_logged_in_browser_extraction',
      capabilityKey: 'browser_execution',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('requires a durable YC browser observation');
  });

  it('passes safe_computer_sandbox_action only from durable computer evidence and audit rows', async () => {
    const completed = computerAction({ id: 'computer-completed', replayIndex: 1 });
    const denied = computerAction({
      id: 'computer-denied',
      actionType: 'file_read',
      status: 'denied',
      stderr: 'path denied by restricted environment-file boundary',
      exitCode: 1,
      outputHash: 'sha256:def',
      replayIndex: 2,
    });
    const runner = createProductionEvalRunner(
      createRunnerDb({
        actions: [completed, denied],
        evidence: [
          evidenceItem({
            id: 'evidence-completed',
            computerActionId: completed.id,
            auditEventId: 'audit-completed',
            replayRef: 'computer:computer-completed:1',
          }),
          evidenceItem({
            id: 'evidence-denied',
            computerActionId: denied.id,
            auditEventId: 'audit-denied',
            replayRef: 'computer:computer-denied:2',
          }),
        ],
        audits: [
          auditRow({ id: 'audit-completed', target: completed.id, verdict: 'allow' }),
          auditRow({ id: 'audit-denied', target: denied.id, verdict: 'deny' }),
        ],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'safe_computer_sandbox_action',
      capabilityKey: 'computer_use',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.blockers).toBeUndefined();
    expect(result.run).toMatchObject({
      evalId: 'safe_computer_sandbox_action',
      status: 'passed',
      capabilityKey: 'computer_use',
      evidenceRefs: ['computer:computer-completed:1', 'computer:computer-denied:2'],
      auditReceiptRefs: ['audit:audit-completed', 'audit:audit-denied'],
      metadata: {
        runnerRef: 'gateway:safe_computer_sandbox_action:v1',
        verifiedComputerActionIds: ['computer-completed', 'computer-denied'],
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
    });
    expect(result.run.steps).toEqual([
      expect.objectContaining({
        stepKey: 'completed-safe-action-evidence',
        status: 'passed',
        evidenceRefs: ['computer:computer-completed:1'],
      }),
      expect.objectContaining({
        stepKey: 'restricted-action-denial-evidence',
        status: 'passed',
        evidenceRefs: ['computer:computer-denied:2'],
      }),
    ]);
  });

  it('fails safe_computer_sandbox_action when restricted-action denial proof is missing', async () => {
    const runner = createProductionEvalRunner(
      createRunnerDb({
        actions: [computerAction({ id: 'computer-completed' })],
        evidence: [],
        audits: [],
      }),
    );

    const result = await runner.execute({
      workspaceId,
      evalId: 'safe_computer_sandbox_action',
      capabilityKey: 'computer_use',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('requires a denied restricted-path');
    expect(result.run.evidenceRefs).toEqual([]);
    expect(result.run.auditReceiptRefs).toEqual([]);
  });

  it('passes founder_off_grid only from controlled absence, checkpoint, delegated action, blocker, evidence, and audit proof', async () => {
    const fixture = founderOffGridFixture();
    const runner = createProductionEvalRunner(createRunnerDb(fixture));

    const result = await runner.execute({
      workspaceId,
      evalId: 'founder_off_grid',
      capabilityKey: 'founder_off_grid',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.blockers).toBeUndefined();
    expect(result.run).toMatchObject({
      evalId: 'founder_off_grid',
      status: 'passed',
      capabilityKey: 'founder_off_grid',
      metadata: {
        runnerRef: 'gateway:founder_off_grid:v1',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
        verifiedMissionId: 'mission-founder-off-grid-1',
        verifiedBoundaryEvidenceItemId: 'evidence-founder-off-grid-boundary',
        verifiedCheckpointEvidenceItemId: 'evidence-founder-off-grid-checkpoint',
        verifiedReportEvidenceItemId: 'evidence-founder-off-grid-report',
        verifiedBlockerEvidenceItemId: 'evidence-founder-off-grid-blockers',
        verifiedToolExecutionIds: [
          'tool-execution-founder-off-grid-1',
          'tool-execution-founder-off-grid-2',
        ],
        verifiedHandoffId: 'handoff-founder-off-grid-1',
        productionReady: false,
      },
    });
    expect(result.run.evidenceRefs).toEqual([
      'founder-off-grid:mission-founder-off-grid-1:boundary',
      'mission:mission-founder-off-grid-1:checkpoint:founder-off-grid',
      'founder-off-grid:mission-founder-off-grid-1:report',
      'founder-off-grid:mission-founder-off-grid-1:blockers',
      'tool:tool-execution-founder-off-grid-1',
      'tool:tool-execution-founder-off-grid-2',
    ]);
    expect(result.run.steps).toEqual([
      expect.objectContaining({
        stepKey: 'founder-absent-boundary-and-emergency-stop',
        status: 'passed',
      }),
      expect.objectContaining({
        stepKey: 'checkpointed-progress-report',
        status: 'passed',
      }),
      expect.objectContaining({
        stepKey: 'delegated-actions-and-true-blockers',
        status: 'passed',
      }),
    ]);
  });

  it('fails founder_off_grid when true blocker queue proof is missing', async () => {
    const fixture = founderOffGridFixture({ includeBlocker: false });
    const runner = createProductionEvalRunner(createRunnerDb(fixture));

    const result = await runner.execute({
      workspaceId,
      evalId: 'founder_off_grid',
      capabilityKey: 'founder_off_grid',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain('Founder-Off-Grid Eval requires');
    expect(result.run.evidenceRefs).toEqual([]);
    expect(result.run.auditReceiptRefs).toEqual([]);
  });

  it('fails unsupported real_external_eval scenarios instead of fabricating a pass', async () => {
    const runner = createProductionEvalRunner(createRunnerDb({}));

    const result = await runner.execute({
      workspaceId,
      evalId: 'polsia_outperformance',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: [],
      auditReceiptRefs: [],
      evidenceCoverage: [],
      auditCoverage: [],
      steps: [],
    });

    expect(result.run.status).toBe('failed');
    expect(result.run.failureReason).toContain(
      'No trusted real_external_eval runner is implemented for polsia_outperformance',
    );
  });
});
