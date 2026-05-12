import { describe, expect, it } from 'vitest';
import {
  a2aMessages,
  a2aThreads,
  agentHandoffs,
  browserActions,
  browserObservations,
  browserSessionGrants,
  browserSessions,
  capabilityPromotions,
  computerActions,
  evidenceItems,
  evalEvidenceLinks,
  evalResults,
  evalRuns,
  evalSteps,
  evaluations,
  goals,
  managedTelegramBotMessages,
  managedTelegramBots,
  missionEdges,
  missionNodes,
  missionRuntimeCheckpoints,
  missions,
  missionTasks,
  opportunityScores,
  tenantDeletionReceipts,
  taskRuns,
  userErasureReceipts,
  ventures,
} from '../schema/index.js';

describe('Gate 1 foundation schema', () => {
  it('exports deterministic task run lineage columns', () => {
    expect(taskRuns.runSequence.name).toBe('run_sequence');
    expect(taskRuns.rootTaskRunId.name).toBe('root_task_run_id');
    expect(taskRuns.spawnedByActionId.name).toBe('spawned_by_action_id');
    expect(taskRuns.lineageKind.name).toBe('lineage_kind');
    expect(taskRuns.checkpointId.name).toBe('checkpoint_id');
  });

  it('exports durable A2A thread and message tables', () => {
    expect(a2aThreads.workspaceId.name).toBe('workspace_id');
    expect(a2aThreads.externalTaskId.name).toBe('external_task_id');
    expect(a2aThreads.pilotTaskId.name).toBe('pilot_task_id');
    expect(a2aMessages.threadId.name).toBe('thread_id');
    expect(a2aMessages.sequence.name).toBe('sequence');
  });
});

describe('Gate 3 runtime skill schema', () => {
  it('exports skill invocation metadata on task runs and handoffs', () => {
    expect(taskRuns.skillInvocations.name).toBe('skill_invocations');
    expect(agentHandoffs.workspaceId.name).toBe('workspace_id');
    expect(agentHandoffs.parentTaskRunId.name).toBe('parent_task_run_id');
    expect(agentHandoffs.childTaskRunId.name).toBe('child_task_run_id');
    expect(agentHandoffs.skillInvocations.name).toBe('skill_invocations');
  });
});

describe('Gate 6 browser operation schema', () => {
  it('exports browser sessions, grants, and observations', () => {
    expect(browserSessions.workspaceId.name).toBe('workspace_id');
    expect(browserSessions.allowedOrigins.name).toBe('allowed_origins');
    expect(browserSessions.helmDocumentVersionPins.name).toBe('helm_document_version_pins');
    expect(browserSessions.evidencePackId.name).toBe('evidence_pack_id');
    expect(browserSessionGrants.sessionId.name).toBe('session_id');
    expect(browserSessionGrants.scope.name).toBe('scope');
    expect(browserSessionGrants.helmDocumentVersionPins.name).toBe('helm_document_version_pins');
    expect(browserSessionGrants.evidencePackId.name).toBe('evidence_pack_id');
    expect(browserActions.helmDocumentVersionPins.name).toBe('helm_document_version_pins');
    expect(browserObservations.actionId.name).toBe('action_id');
    expect(browserObservations.evidencePackId.name).toBe('evidence_pack_id');
    expect(browserObservations.redactedDomSnapshot.name).toBe('redacted_dom_snapshot');
    expect(browserObservations.redactions.name).toBe('redactions');
  });
});

describe('Gate 7 computer operation schema', () => {
  it('exports safe computer action evidence columns', () => {
    expect(computerActions.workspaceId.name).toBe('workspace_id');
    expect(computerActions.toolActionId.name).toBe('tool_action_id');
    expect(computerActions.actionType.name).toBe('action_type');
    expect(computerActions.command.name).toBe('command');
    expect(computerActions.fileDiff.name).toBe('file_diff');
    expect(computerActions.helmDocumentVersionPins.name).toBe('helm_document_version_pins');
    expect(computerActions.evidencePackId.name).toBe('evidence_pack_id');
    expect(computerActions.replayIndex.name).toBe('replay_index');
  });
});

describe('retained tenant hard-delete receipt schema', () => {
  it('exports non-cascading deletion receipt fields', () => {
    expect(tenantDeletionReceipts.workspaceId.name).toBe('workspace_id');
    expect(tenantDeletionReceipts.deletionId.name).toBe('deletion_id');
    expect(tenantDeletionReceipts.source.name).toBe('source');
    expect(tenantDeletionReceipts.actor.name).toBe('actor');
    expect(tenantDeletionReceipts.replayRef.name).toBe('replay_ref');
    expect(tenantDeletionReceipts.metadata.name).toBe('metadata');
  });
});

describe('retained user erasure receipt schema', () => {
  it('exports non-cascading user-erasure receipt fields', () => {
    expect(userErasureReceipts.subjectHash.name).toBe('subject_hash');
    expect(userErasureReceipts.source.name).toBe('source');
    expect(userErasureReceipts.actor.name).toBe('actor');
    expect(userErasureReceipts.deletedWorkspaceCount.name).toBe('deleted_workspace_count');
    expect(userErasureReceipts.workspaceSetHash.name).toBe('workspace_set_hash');
    expect(userErasureReceipts.replayRef.name).toBe('replay_ref');
    expect(userErasureReceipts.metadata.name).toBe('metadata');
  });
});

describe('Opportunity scoring governance schema', () => {
  it('exports governance and model metadata on opportunity scores', () => {
    expect(opportunityScores.policyDecisionId.name).toBe('policy_decision_id');
    expect(opportunityScores.policyVersion.name).toBe('policy_version');
    expect(opportunityScores.helmDocumentVersionPins.name).toBe('helm_document_version_pins');
    expect(opportunityScores.modelUsage.name).toBe('model_usage');
  });
});

describe('Managed Telegram governance schema', () => {
  it('exports governance metadata on bot and message rows', () => {
    expect(managedTelegramBots.governanceMetadata.name).toBe('governance_metadata');
    expect(managedTelegramBotMessages.governanceMetadata.name).toBe('governance_metadata');
  });
});

describe('Opportunity score governance schema', () => {
  it('exports HELM policy pins and model usage on score rows', () => {
    expect(opportunityScores.policyDecisionId.name).toBe('policy_decision_id');
    expect(opportunityScores.policyVersion.name).toBe('policy_version');
    expect(opportunityScores.helmDocumentVersionPins.name).toBe('helm_document_version_pins');
    expect(opportunityScores.modelUsage.name).toBe('model_usage');
  });
});

describe('Gate 10 production eval schema', () => {
  it('exports durable eval run, result, evidence, and promotion tables', () => {
    expect(evaluations.evalId.name).toBe('eval_id');
    expect(evalRuns.workspaceId.name).toBe('workspace_id');
    expect(evalRuns.evidenceRefs.name).toBe('evidence_refs');
    expect(evalRuns.auditReceiptRefs.name).toBe('audit_receipt_refs');
    expect(evalSteps.evalRunId.name).toBe('eval_run_id');
    expect(evalResults.passed.name).toBe('passed');
    expect(evalEvidenceLinks.evidenceRef.name).toBe('evidence_ref');
    expect(capabilityPromotions.capabilityKey.name).toBe('capability_key');
    expect(capabilityPromotions.promotedState.name).toBe('promoted_state');
  });
});

describe('Evidence ledger schema', () => {
  it('exports canonical evidence item links across runtime surfaces', () => {
    expect(evidenceItems.workspaceId.name).toBe('workspace_id');
    expect(evidenceItems.ventureId.name).toBe('venture_id');
    expect(evidenceItems.missionId.name).toBe('mission_id');
    expect(evidenceItems.taskRunId.name).toBe('task_run_id');
    expect(evidenceItems.actionId.name).toBe('action_id');
    expect(evidenceItems.toolExecutionId.name).toBe('tool_execution_id');
    expect(evidenceItems.evidencePackId.name).toBe('evidence_pack_id');
    expect(evidenceItems.browserObservationId.name).toBe('browser_observation_id');
    expect(evidenceItems.computerActionId.name).toBe('computer_action_id');
    expect(evidenceItems.artifactId.name).toBe('artifact_id');
    expect(evidenceItems.auditEventId.name).toBe('audit_event_id');
    expect(evidenceItems.redactionState.name).toBe('redaction_state');
    expect(evidenceItems.replayRef.name).toBe('replay_ref');
  });
});

describe('Gate 9 durable mission runtime schema', () => {
  it('exports venture, goal, mission, DAG, and mission task tables', () => {
    expect(ventures.workspaceId.name).toBe('workspace_id');
    expect(ventures.dnaDocumentId.name).toBe('dna_document_id');
    expect(goals.ventureId.name).toBe('venture_id');
    expect(goals.autonomyMode.name).toBe('autonomy_mode');
    expect(missions.missionKey.name).toBe('mission_key');
    expect(missions.productionReady.name).toBe('production_ready');
    expect(missionNodes.nodeKey.name).toBe('node_key');
    expect(missionNodes.requiredAgents.name).toBe('required_agents');
    expect(missionEdges.fromNodeKey.name).toBe('from_node_key');
    expect(missionTasks.taskId.name).toBe('task_id');
  });

  it('exports mission-level checkpoint, recovery, and rollback fields', () => {
    expect(missionRuntimeCheckpoints.workspaceId.name).toBe('workspace_id');
    expect(missionRuntimeCheckpoints.missionId.name).toBe('mission_id');
    expect(missionRuntimeCheckpoints.checkpointKind.name).toBe('checkpoint_kind');
    expect(missionRuntimeCheckpoints.nodeStatusCounts.name).toBe('node_status_counts');
    expect(missionRuntimeCheckpoints.taskRunCheckpointRefs.name).toBe('task_run_checkpoint_refs');
    expect(missionRuntimeCheckpoints.recoveryPlan.name).toBe('recovery_plan');
    expect(missionRuntimeCheckpoints.rollbackPlan.name).toBe('rollback_plan');
    expect(missionRuntimeCheckpoints.contentHash.name).toBe('content_hash');
  });
});
