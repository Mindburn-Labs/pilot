import { describe, expect, it, vi } from 'vitest';
import { auditLog, computerActions, evidenceItems } from '@pilot/db/schema';
import type { Db } from '@pilot/db/client';
import { PRODUCTION_READY_EXECUTION_MODE } from '@pilot/shared/eval';
import { createProductionEvalRunner } from '../../services/production-eval-runner.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';

type ComputerActionRow = typeof computerActions.$inferSelect;
type EvidenceItemRow = typeof evidenceItems.$inferSelect;
type AuditRow = typeof auditLog.$inferSelect;

function createRunnerDb({
  actions = [],
  evidence = [],
  audits = [],
}: {
  actions?: ComputerActionRow[];
  evidence?: EvidenceItemRow[];
  audits?: AuditRow[];
}) {
  const db = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const result =
          table === computerActions ? actions : table === evidenceItems ? evidence : audits;
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

describe('createProductionEvalRunner', () => {
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
