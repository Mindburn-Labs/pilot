import { describe, expect, it, vi } from 'vitest';
import {
  agentHandoffs,
  auditLog,
  browserObservations,
  computerActions,
  evidenceItems,
  evidencePacks,
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

type ComputerActionRow = typeof computerActions.$inferSelect;
type BrowserObservationRow = typeof browserObservations.$inferSelect;
type EvidencePackRow = typeof evidencePacks.$inferSelect;
type EvidenceItemRow = typeof evidenceItems.$inferSelect;
type AuditRow = typeof auditLog.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;
type TaskRunRow = typeof taskRuns.$inferSelect;
type AgentHandoffRow = typeof agentHandoffs.$inferSelect;
type OpportunityRow = typeof opportunities.$inferSelect;
type OpportunityScoreRow = typeof opportunityScores.$inferSelect;
type ToolExecutionRow = typeof toolExecutions.$inferSelect;

function createRunnerDb({
  actions = [],
  browser = [],
  packs = [],
  evidence = [],
  audits = [],
  taskRows = [],
  taskRunRows = [],
  handoffRows = [],
  opportunityRows = [],
  scoreRows = [],
  toolExecutionRows = [],
}: {
  actions?: ComputerActionRow[];
  browser?: BrowserObservationRow[];
  packs?: EvidencePackRow[];
  evidence?: EvidenceItemRow[];
  audits?: AuditRow[];
  taskRows?: TaskRow[];
  taskRunRows?: TaskRunRow[];
  handoffRows?: AgentHandoffRow[];
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
                    : table === tasks
                      ? taskRows
                      : table === taskRuns
                        ? taskRunRows
                        : table === agentHandoffs
                          ? handoffRows
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

  it('fails unsupported real_external_eval scenarios instead of fabricating a pass', async () => {
    const runner = createProductionEvalRunner(createRunnerDb({}));

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
    expect(result.run.failureReason).toContain(
      'No trusted real_external_eval runner is implemented for full_startup_launch',
    );
  });
});
