import { describe, expect, it, vi } from 'vitest';
import {
  auditLog,
  capabilityPromotions,
  evidenceItems,
  evalEvidenceLinks,
  evalResults,
  evalRuns,
  evalSteps,
  evaluations,
  tasks,
} from '@pilot/db/schema';
import {
  getRequiredEvalForCapability,
  getRequiredEvalsForCapability,
  PRODUCTION_READY_EXECUTION_MODE,
} from '@pilot/shared/eval';
import { evalRoutes } from '../../routes/evals.js';
import { createMockDeps, expectJson, testApp } from '../helpers.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const foreignWorkspaceId = '00000000-0000-4000-8000-000000000099';
const wsHeader = { 'X-Workspace-Id': workspaceId };
const realExternalMetadata = { executionMode: PRODUCTION_READY_EXECUTION_MODE };

function createEvalDb(
  selectResults: unknown[][] = [],
  options: { failEvidenceInsertAt?: number } = {},
) {
  const inserts: Array<{ table: unknown; value: unknown }> = [];
  const updates: Array<{ table: unknown; value: unknown }> = [];
  let evidenceItemCount = 0;

  function insertInto(targetInserts: Array<{ table: unknown; value: unknown }>) {
    return vi.fn((table: unknown) => ({
      values: vi.fn((value: unknown) => {
        targetInserts.push({ table, value });
        return {
          onConflictDoUpdate: vi.fn(async () => []),
          returning: vi.fn(async () => {
            if (table === evalRuns) {
              return [
                {
                  id: 'eval-run-1',
                  workspaceId,
                  evalId: (value as { evalId?: string }).evalId,
                  status: (value as { status?: string }).status,
                  capabilityKey: (value as { capabilityKey?: string }).capabilityKey ?? null,
                  evidenceRefs: (value as { evidenceRefs?: string[] }).evidenceRefs ?? [],
                  auditReceiptRefs:
                    (value as { auditReceiptRefs?: string[] }).auditReceiptRefs ?? [],
                  metadata: (value as { metadata?: Record<string, unknown> }).metadata ?? {},
                  completedAt: (value as { completedAt?: Date | null }).completedAt ?? null,
                  startedAt: new Date('2026-05-05T00:00:00.000Z'),
                  createdAt: new Date('2026-05-05T00:00:00.000Z'),
                },
              ];
            }
            if (table === evalResults) {
              return [{ id: 'eval-result-1', ...(value as Record<string, unknown>) }];
            }
            if (table === tasks) {
              return [
                {
                  id: 'task-blocker-1',
                  title: (value as { title?: string }).title,
                  status: (value as { status?: string }).status,
                  metadata: (value as { metadata?: Record<string, unknown> }).metadata,
                },
              ];
            }
            if (table === capabilityPromotions) {
              return [{ id: 'promotion-1', ...(value as Record<string, unknown>) }];
            }
            if (table === evidenceItems) {
              evidenceItemCount += 1;
              if (options.failEvidenceInsertAt === evidenceItemCount) {
                throw new Error('evidence ledger unavailable');
              }
              return [{ id: `evidence-item-${evidenceItemCount}` }];
            }
            return [];
          }),
        };
      }),
    }));
  }

  const db: any = {
    select: vi.fn(() => ({
      from: vi.fn(() => {
        const result = selectResults.shift() ?? [];
        const chain = {
          where: vi.fn(() => chain),
          orderBy: vi.fn(() => chain),
          limit: vi.fn(async () => result),
          then: (resolve: (value: unknown[]) => void) => resolve(result),
        };
        return chain;
      }),
    })),
    insert: insertInto(inserts),
    update: updateInto(updates),
    delete: vi.fn(() => ({ where: vi.fn(async () => []) })),
    execute: vi.fn(async () => [{ '?column?': 1 }]),
    _setResult: vi.fn(),
    _reset: vi.fn(),
  };
  db.transaction = vi.fn(async (callback: (tx: typeof db) => Promise<unknown>) => {
    const stagedInserts: Array<{ table: unknown; value: unknown }> = [];
    const stagedUpdates: Array<{ table: unknown; value: unknown }> = [];
    const tx = { ...db, insert: insertInto(stagedInserts), update: updateInto(stagedUpdates) };
    const result = await callback(tx);
    inserts.push(...stagedInserts);
    updates.push(...stagedUpdates);
    return result;
  });

  return { db, inserts, updates };

  function updateInto(targetUpdates: Array<{ table: unknown; value: unknown }>) {
    return vi.fn((table: unknown) => ({
      set: vi.fn((value: unknown) => {
        targetUpdates.push({ table, value });
        return { where: vi.fn(async () => []) };
      }),
    }));
  }
}

describe('evalRoutes', () => {
  it('requires workspace scope', async () => {
    const { fetch } = testApp(evalRoutes, createMockDeps());
    const res = await fetch('GET', '/production-suite');
    const body = await expectJson<{ error: string }>(res, 400);

    expect(body.error).toContain('workspaceId');
  });

  it('requires partner role', async () => {
    const { fetch } = testApp(evalRoutes, createMockDeps());
    const res = await fetch('GET', '/production-suite', undefined, {
      ...wsHeader,
      'X-Workspace-Role': 'member',
    });
    const body = await expectJson<{ error: string; requiredRole: string }>(res, 403);

    expect(body.error).toBe('insufficient workspace role');
    expect(body.requiredRole).toBe('partner');
  });

  it('returns the production autonomy eval suite', async () => {
    const { fetch } = testApp(evalRoutes, createMockDeps());
    const res = await fetch('GET', '/production-suite', undefined, wsHeader);
    const body = await expectJson<{
      productionReadyPromotionRule: string;
      scenarios: Array<{ id: string; name: string; evidenceRequirements: string[] }>;
    }>(res, 200);

    expect(body.productionReadyPromotionRule).toContain('passed with evidenceRefs');
    expect(body.scenarios.map((scenario) => scenario.name)).toContain('Full Startup Launch Eval');
    expect(body.scenarios.map((scenario) => scenario.name)).toContain(
      'YC Logged-In Browser Extraction Eval',
    );
    expect(body.scenarios.every((scenario) => scenario.evidenceRequirements.length > 0)).toBe(true);
  });

  it('returns eval readiness inventory and does not treat control-plane proofs as production', async () => {
    const { db } = createEvalDb([
      [
        {
          evalId: 'helm_governance',
          workspaceId,
          status: 'passed',
          capabilityKey: 'helm_receipts',
          evidenceRefs: ['evidence:helm'],
          auditReceiptRefs: ['audit:helm'],
          metadata: { executionMode: 'control_plane_proof_check' },
          completedAt: new Date('2026-05-05T00:00:00.000Z'),
          startedAt: new Date('2026-05-05T00:00:00.000Z'),
          createdAt: new Date('2026-05-05T00:00:00.000Z'),
        },
      ],
    ]);
    const { fetch } = testApp(evalRoutes, createMockDeps({ db: db as never }));

    const res = await fetch('GET', '/readiness', undefined, wsHeader);
    const body = await expectJson<{
      productionReadyRegistryMutation: boolean;
      inventory: {
        currentExecutorMode: string;
        requiredExecutionMode: string;
        productionReadyCapabilities: number;
        items: Array<{
          capability: { key: string };
          missingRealEvalIds: string[];
          productionReadyBlocked: boolean;
          blockers: string[];
        }>;
      };
    }>(res, 200);

    const helm = body.inventory.items.find((item) => item.capability.key === 'helm_receipts');
    expect(body.productionReadyRegistryMutation).toBe(false);
    expect(body.inventory.currentExecutorMode).toBe('control_plane_proof_check');
    expect(body.inventory.requiredExecutionMode).toBe('real_external_eval');
    expect(body.inventory.productionReadyCapabilities).toBe(0);
    expect(helm).toMatchObject({
      missingRealEvalIds: ['helm_governance'],
      productionReadyBlocked: true,
    });
    expect(helm?.blockers.join(' ')).toContain('real_external_eval');
  });

  it('lists persisted eval runs scoped to the workspace', async () => {
    const { db } = createEvalDb([
      [
        {
          evalId: 'helm_governance',
          workspaceId,
          status: 'passed',
          capabilityKey: 'helm_receipts',
          evidenceRefs: ['evidence:helm'],
          auditReceiptRefs: ['audit:helm'],
          metadata: {},
          completedAt: new Date('2026-05-05T00:00:00.000Z'),
        },
      ],
    ]);
    const { fetch } = testApp(evalRoutes, createMockDeps({ db: db as never }));

    const res = await fetch('GET', '/runs', undefined, wsHeader);
    const body = await expectJson<{ runs: Array<{ evalId: string; workspaceId: string }> }>(
      res,
      200,
    );

    expect(body.runs).toEqual([
      expect.objectContaining({
        evalId: 'helm_governance',
        workspaceId,
      }),
    ]);
  });

  it('records a failed eval and creates a blocker task', async () => {
    const { db, inserts, updates } = createEvalDb();
    const { fetch } = testApp(evalRoutes, createMockDeps({ db: db as never }));

    const res = await fetch(
      'POST',
      '/runs',
      {
        evalId: 'helm_governance',
        status: 'failed',
        capabilityKey: 'helm_receipts',
        failureReason: 'receipt sink write failed under restricted action',
      },
      wsHeader,
    );
    const body = await expectJson<{
      result: { passed: boolean; blockers: string[] };
      blockerTask: { id: string; title: string };
      evidenceItemIds: string[];
      productionReadyRegistryMutation: boolean;
    }>(res, 201);

    expect(body.result.passed).toBe(false);
    expect(body.evidenceItemIds).toEqual(['evidence-item-1', 'evidence-item-2']);
    expect(body.result.blockers.join(' ')).toContain('receipt sink');
    expect(body.blockerTask.title).toContain('HELM Governance Eval');
    expect(body.productionReadyRegistryMutation).toBe(false);
    expect(inserts.find((insert) => insert.table === evaluations)?.value).toMatchObject({
      evalId: 'helm_governance',
    });
    expect(inserts.find((insert) => insert.table === evalRuns)?.value).toMatchObject({
      workspaceId,
      evalId: 'helm_governance',
      status: 'failed',
    });
    expect(inserts.find((insert) => insert.table === evalResults)?.value).toMatchObject({
      passed: false,
    });
    const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
      id: string;
    };
    expect(auditInsert).toMatchObject({
      workspaceId,
      action: 'PILOT_PRODUCTION_EVAL_RUN',
      target: 'helm_governance',
      verdict: 'failed',
      metadata: expect.objectContaining({
        evalRunId: 'eval-run-1',
        evalId: 'helm_governance',
        status: 'failed',
        capabilityKey: 'helm_receipts',
      }),
    });
    expect(inserts.findIndex((insert) => insert.table === auditLog)).toBeLessThan(
      inserts.findIndex((insert) => insert.table === evidenceItems),
    );
    expect(
      inserts.filter((insert) => insert.table === evidenceItems).map((insert) => insert.value),
    ).toEqual([
      expect.objectContaining({
        workspaceId,
        auditEventId: auditInsert.id,
        evidenceType: 'eval_run',
        sourceType: 'eval_harness',
        replayRef: 'eval:eval-run-1',
        metadata: expect.objectContaining({
          evalRunId: 'eval-run-1',
          evalId: 'helm_governance',
          status: 'failed',
        }),
      }),
      expect.objectContaining({
        workspaceId,
        auditEventId: auditInsert.id,
        evidenceType: 'eval_result',
        sourceType: 'eval_harness',
        replayRef: 'eval-result:eval-result-1',
        metadata: expect.objectContaining({
          evalRunId: 'eval-run-1',
          evalResultId: 'eval-result-1',
          passed: false,
        }),
      }),
    ]);
    expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
      metadata: {
        evidenceItemIds: ['evidence-item-1', 'evidence-item-2'],
        resultId: 'eval-result-1',
        blockerTaskId: 'task-blocker-1',
      },
    });
    expect(inserts.find((insert) => insert.table === tasks)?.value).toMatchObject({
      mode: 'eval',
      status: 'pending',
      priority: 100,
      metadata: expect.objectContaining({
        kind: 'production_eval_blocker',
        productionReadyBlocked: true,
      }),
    });
  });

  it('records a passed manual eval pack without trusting client-supplied promotion mode', async () => {
    const { db, inserts } = createEvalDb();
    const { fetch } = testApp(evalRoutes, createMockDeps({ db: db as never }));

    const res = await fetch(
      'POST',
      '/runs',
      {
        evalId: 'helm_governance',
        status: 'passed',
        capabilityKey: 'helm_receipts',
        evidenceRefs: ['evidence:helm-governance'],
        auditReceiptRefs: ['audit:helm-governance'],
        metadata: realExternalMetadata,
        steps: [
          {
            stepKey: 'restricted-action-denial',
            status: 'passed',
            evidenceRefs: ['evidence:restricted-denial'],
            auditReceiptRefs: ['audit:restricted-denial'],
            completedAt: '2026-05-05T00:00:00.000Z',
          },
        ],
      },
      wsHeader,
    );
    const body = await expectJson<{
      promotionChecks: Array<{
        canPromote: boolean;
        capability: { key: string };
        blockers: string[];
      }>;
      promotions: Array<{ capabilityKey: string; promotedState: string; status: string }>;
      evidenceItemIds: string[];
      productionReadyRegistryMutation: boolean;
    }>(res, 201);

    expect(body.promotionChecks).toEqual([
      expect.objectContaining({
        canPromote: false,
        capability: expect.objectContaining({ key: 'helm_receipts' }),
      }),
    ]);
    expect(body.promotionChecks[0]?.blockers.join(' ')).toContain(
      'executionMode real_external_eval',
    );
    expect(body.promotions).toEqual([]);
    expect(body.productionReadyRegistryMutation).toBe(false);
    expect(body.evidenceItemIds).toEqual(['evidence-item-1', 'evidence-item-2', 'evidence-item-3']);
    expect(inserts.find((insert) => insert.table === evalRuns)?.value).toMatchObject({
      metadata: {},
    });
    expect(inserts.find((insert) => insert.table === evalSteps)?.value).toEqual([
      expect.objectContaining({ stepKey: 'restricted-action-denial', status: 'passed' }),
    ]);
    expect(inserts.find((insert) => insert.table === evalEvidenceLinks)?.value).toEqual([
      expect.objectContaining({
        workspaceId,
        evalRunId: 'eval-run-1',
        evidenceRef: 'evidence:helm-governance',
        auditReceiptRef: 'audit:helm-governance',
      }),
    ]);
    expect(
      inserts.filter((insert) => insert.table === evidenceItems).map((insert) => insert.value),
    ).toEqual([
      expect.objectContaining({
        workspaceId,
        evidenceType: 'eval_run',
        replayRef: 'eval:eval-run-1',
      }),
      expect.objectContaining({
        workspaceId,
        evidenceType: 'eval_evidence_ref',
        replayRef: 'evidence:helm-governance',
        metadata: expect.objectContaining({
          auditReceiptRef: 'audit:helm-governance',
        }),
      }),
      expect.objectContaining({
        workspaceId,
        evidenceType: 'eval_result',
        replayRef: 'eval-result:eval-result-1',
      }),
    ]);
    expect(inserts.find((insert) => insert.table === capabilityPromotions)).toBeUndefined();
  });

  it('rejects passed eval runs with failed or incomplete proof steps', async () => {
    const { db, inserts } = createEvalDb();
    const { fetch } = testApp(evalRoutes, createMockDeps({ db: db as never }));

    const res = await fetch(
      'POST',
      '/runs',
      {
        evalId: 'helm_governance',
        status: 'passed',
        capabilityKey: 'helm_receipts',
        evidenceRefs: ['evidence:helm-governance'],
        auditReceiptRefs: ['audit:helm-governance'],
        steps: [
          {
            stepKey: 'restricted-action-denial',
            status: 'failed',
            evidenceRefs: ['evidence:step'],
            auditReceiptRefs: ['audit:step'],
            completedAt: '2026-05-05T00:00:00.000Z',
          },
          {
            stepKey: 'receipt-persistence',
            status: 'passed',
            evidenceRefs: [],
            auditReceiptRefs: ['audit:step-2'],
          },
        ],
      },
      wsHeader,
    );
    const body = await expectJson<{
      error: string;
      details: { fieldErrors: Record<string, string[]> };
    }>(res, 400);

    expect(body.error).toBe('Validation failed');
    expect(body.details.fieldErrors.steps.join(' ')).toContain(
      'passed eval runs cannot include non-passed steps',
    );
    expect(body.details.fieldErrors.steps.join(' ')).toContain(
      'passed eval run steps must include at least one evidence reference',
    );
    expect(body.details.fieldErrors.steps.join(' ')).toContain(
      'passed eval run steps must include completedAt',
    );
    expect(inserts).toEqual([]);
  });

  it('records scenario-wide eval packs without pinning them to the first capability only', async () => {
    const { db, inserts } = createEvalDb();
    const { fetch } = testApp(evalRoutes, createMockDeps({ db: db as never }));

    const res = await fetch(
      'POST',
      '/runs',
      {
        evalId: 'full_startup_launch',
        status: 'passed',
        evidenceRefs: ['evidence:startup-launch'],
        auditReceiptRefs: ['audit:startup-launch'],
        metadata: realExternalMetadata,
        completedAt: '2026-05-05T00:00:00.000Z',
      },
      wsHeader,
    );
    const body = await expectJson<{
      capabilityKey?: string;
      promotionChecks: Array<{
        canPromote: boolean;
        capability: { key: string };
        blockers: string[];
      }>;
      promotions: Array<{ capabilityKey: string; promotedState: string; status: string }>;
      productionReadyRegistryMutation: boolean;
    }>(res, 201);

    expect(body.capabilityKey).toBeUndefined();
    expect(body.productionReadyRegistryMutation).toBe(false);
    expect(body.promotionChecks).toEqual([
      expect.objectContaining({
        canPromote: false,
        capability: expect.objectContaining({ key: 'mission_runtime' }),
      }),
      expect.objectContaining({
        canPromote: false,
        capability: expect.objectContaining({ key: 'startup_lifecycle' }),
      }),
    ]);
    expect(body.promotionChecks[0]?.blockers.join(' ')).toContain(
      'Multi-Agent Parallel Build Eval',
    );
    expect(body.promotionChecks[1]?.blockers.join(' ')).toContain(
      'executionMode real_external_eval',
    );
    expect(body.promotions).toEqual([]);
    expect(inserts.find((insert) => insert.table === capabilityPromotions)).toBeUndefined();
    expect(inserts.find((insert) => insert.table === evalRuns)?.value).toMatchObject({
      evalId: 'full_startup_launch',
      status: 'passed',
      capabilityKey: null,
      metadata: {},
    });
    expect(inserts.find((insert) => insert.table === evalResults)?.value).toMatchObject({
      evalId: 'full_startup_launch',
      capabilityKey: null,
      passed: true,
    });
    expect(
      inserts.filter((insert) => insert.table === evidenceItems).map((insert) => insert.value),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            evalId: 'full_startup_launch',
            capabilityKey: null,
            capabilityKeys: ['mission_runtime', 'startup_lifecycle'],
          }),
        }),
      ]),
    );
  });

  it('fails closed without committing eval promotion state when evidence persistence fails', async () => {
    const { db, inserts } = createEvalDb([], { failEvidenceInsertAt: 1 });
    const { fetch } = testApp(evalRoutes, createMockDeps({ db: db as never }));

    const res = await fetch(
      'POST',
      '/runs',
      {
        evalId: 'helm_governance',
        status: 'passed',
        capabilityKey: 'helm_receipts',
        evidenceRefs: ['evidence:helm-governance'],
        auditReceiptRefs: ['audit:helm-governance'],
      },
      wsHeader,
    );

    expect(res.status).toBe(500);
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(inserts).toEqual([]);
  });

  it('does not record multi-eval promotion eligibility from client-supplied execution mode', async () => {
    const { db, inserts } = createEvalDb([
      [
        {
          evalId: 'helm_governance',
          workspaceId,
          status: 'passed',
          capabilityKey: 'evidence_ledger',
          evidenceRefs: ['evidence:helm'],
          auditReceiptRefs: ['audit:helm'],
          metadata: realExternalMetadata,
          completedAt: new Date('2026-05-05T00:00:00.000Z'),
        },
      ],
    ]);
    const { fetch } = testApp(evalRoutes, createMockDeps({ db: db as never }));

    const res = await fetch(
      'POST',
      '/runs',
      {
        evalId: 'recovery',
        status: 'passed',
        capabilityKey: 'evidence_ledger',
        evidenceRefs: ['evidence:recovery'],
        auditReceiptRefs: ['audit:recovery'],
        metadata: realExternalMetadata,
        completedAt: '2026-05-05T00:00:01.000Z',
      },
      wsHeader,
    );
    const body = await expectJson<{
      promotionChecks: Array<{
        canPromote: boolean;
        matchedEvalIds: string[];
        evidenceRefs: string[];
        blockers: string[];
      }>;
      promotions: Array<{ capabilityKey: string; promotedState: string; status: string }>;
      productionReadyRegistryMutation: boolean;
    }>(res, 201);

    expect(body.promotionChecks).toEqual([
      expect.objectContaining({
        canPromote: false,
        matchedEvalIds: ['helm_governance', 'recovery'],
        evidenceRefs: ['evidence:helm', 'evidence:recovery'],
      }),
    ]);
    expect(body.promotionChecks[0]?.blockers.join(' ')).toContain(
      'Recovery Eval passing run must use executionMode real_external_eval',
    );
    expect(body.promotions).toEqual([]);
    expect(body.productionReadyRegistryMutation).toBe(false);
    expect(inserts.find((insert) => insert.table === capabilityPromotions)).toBeUndefined();
  });

  it('executes a production eval proof check and fails closed when proof is missing', async () => {
    const { db, inserts } = createEvalDb();
    const { fetch } = testApp(evalRoutes, createMockDeps({ db: db as never }));

    const res = await fetch(
      'POST',
      '/execute',
      {
        evalId: 'helm_governance',
        capabilityKey: 'helm_receipts',
      },
      wsHeader,
    );
    const body = await expectJson<{
      executionMode: string;
      executionBlockers: string[];
      result: { passed: boolean; blockers: string[] };
      blockerTask: { id: string; title: string };
    }>(res, 201);

    expect(body.executionMode).toBe('control_plane_proof_check');
    expect(body.result.passed).toBe(false);
    expect(body.executionBlockers.join(' ')).toContain('No evidence references');
    expect(body.blockerTask.title).toContain('HELM Governance Eval');
    expect(inserts.find((insert) => insert.table === evalRuns)?.value).toMatchObject({
      status: 'failed',
      capabilityKey: 'helm_receipts',
    });
    expect(inserts.find((insert) => insert.table === tasks)?.value).toMatchObject({
      metadata: expect.objectContaining({
        kind: 'production_eval_blocker',
        productionReadyBlocked: true,
      }),
    });
  });

  it('executes a control-plane proof check without writing promotion eligibility', async () => {
    const scenario = getRequiredEvalForCapability('helm_receipts');
    if (!scenario) throw new Error('helm_receipts eval missing');
    const { db, inserts } = createEvalDb();
    const { fetch } = testApp(evalRoutes, createMockDeps({ db: db as never }));

    const res = await fetch(
      'POST',
      '/execute',
      {
        evalId: scenario.id,
        capabilityKey: 'helm_receipts',
        evidenceRefs: ['evidence:helm-governance'],
        auditReceiptRefs: ['audit:helm-governance'],
        evidenceCoverage: scenario.evidenceRequirements,
        auditCoverage: scenario.auditRequirements,
        completedAt: '2026-05-05T00:00:00.000Z',
      },
      wsHeader,
    );
    const body = await expectJson<{
      executionBlockers: string[];
      result: { passed: boolean };
      promotionChecks: Array<{ canPromote: boolean; blockers: string[] }>;
      promotions: Array<{ capabilityKey: string; promotedState: string; status: string }>;
      productionReadyRegistryMutation: boolean;
    }>(res, 201);

    expect(body.executionBlockers).toEqual([]);
    expect(body.result.passed).toBe(true);
    expect(body.promotionChecks[0]?.canPromote).toBe(false);
    expect(body.promotionChecks[0]?.blockers.join(' ')).toContain(
      'executionMode real_external_eval',
    );
    expect(body.promotions).toEqual([]);
    expect(body.productionReadyRegistryMutation).toBe(false);
    expect(inserts.find((insert) => insert.table === capabilityPromotions)).toBeUndefined();
    expect(inserts.find((insert) => insert.table === evalEvidenceLinks)?.value).toEqual([
      expect.objectContaining({
        evidenceRef: 'evidence:helm-governance',
        auditReceiptRef: 'audit:helm-governance',
      }),
    ]);
  });

  it('fails closed when real external eval execution is requested without a trusted runner', async () => {
    const { db, inserts } = createEvalDb();
    const { fetch } = testApp(evalRoutes, createMockDeps({ db: db as never }));

    const res = await fetch(
      'POST',
      '/execute',
      {
        evalId: 'full_startup_launch',
        capabilityKey: 'startup_lifecycle',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
      wsHeader,
    );
    const body = await expectJson<{
      executionMode: string;
      executionBlockers: string[];
      result: { passed: boolean; blockers: string[] };
      blockerTask: { id: string; title: string };
      promotions: Array<{ capabilityKey: string }>;
      productionReadyRegistryMutation: boolean;
    }>(res, 201);

    expect(body.executionMode).toBe(PRODUCTION_READY_EXECUTION_MODE);
    expect(body.executionBlockers.join(' ')).toContain(
      'no trusted production eval runner is configured',
    );
    expect(body.result.passed).toBe(false);
    expect(body.blockerTask.title).toContain('Full Startup Launch Eval');
    expect(body.promotions).toEqual([]);
    expect(body.productionReadyRegistryMutation).toBe(false);
    expect(inserts.find((insert) => insert.table === evalRuns)?.value).toMatchObject({
      evalId: 'full_startup_launch',
      status: 'failed',
      capabilityKey: 'startup_lifecycle',
      metadata: expect.objectContaining({
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
        trustedRunnerAvailable: false,
      }),
    });
    expect(inserts.find((insert) => insert.table === capabilityPromotions)).toBeUndefined();
  });

  it('persists trusted real external eval runner output as promotion eligibility only', async () => {
    const { db, inserts } = createEvalDb();
    const productionEvalRunner = {
      execute: vi.fn(
        async (input: {
          workspaceId: string;
          evalId: 'full_startup_launch';
          capabilityKey?: 'startup_lifecycle';
          executionMode: typeof PRODUCTION_READY_EXECUTION_MODE;
        }) => ({
          run: {
            workspaceId: input.workspaceId,
            evalId: input.evalId,
            status: 'passed' as const,
            capabilityKey: 'startup_lifecycle' as const,
            evidenceRefs: ['evidence:real-startup-launch'],
            auditReceiptRefs: ['audit:real-startup-launch'],
            metadata: {
              executionMode: 'control_plane_proof_check',
              runnerRef: 'trusted-runner:test',
            },
            completedAt: '2026-05-05T00:00:00.000Z',
            steps: [
              {
                stepKey: 'mission-dag-run',
                status: 'passed' as const,
                evidenceRefs: ['evidence:real-step'],
                auditReceiptRefs: ['audit:real-step'],
                completedAt: '2026-05-05T00:00:00.000Z',
              },
            ],
          },
        }),
      ),
    };
    const { fetch } = testApp(
      evalRoutes,
      createMockDeps({ db: db as never, productionEvalRunner }),
    );

    const res = await fetch(
      'POST',
      '/execute',
      {
        evalId: 'full_startup_launch',
        capabilityKey: 'startup_lifecycle',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
      wsHeader,
    );
    const body = await expectJson<{
      executionMode: string;
      executionBlockers: string[];
      result: { passed: boolean };
      promotionChecks: Array<{ canPromote: boolean; capability: { key: string } }>;
      promotions: Array<{ capabilityKey: string; promotedState: string; status: string }>;
      productionReadyRegistryMutation: boolean;
    }>(res, 201);

    expect(productionEvalRunner.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId,
        evalId: 'full_startup_launch',
        capabilityKey: 'startup_lifecycle',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      }),
    );
    expect(body.executionMode).toBe(PRODUCTION_READY_EXECUTION_MODE);
    expect(body.executionBlockers).toEqual([]);
    expect(body.result.passed).toBe(true);
    expect(body.promotionChecks).toEqual([
      expect.objectContaining({
        canPromote: true,
        capability: expect.objectContaining({ key: 'startup_lifecycle' }),
      }),
    ]);
    expect(body.promotions).toEqual([
      expect.objectContaining({
        capabilityKey: 'startup_lifecycle',
        promotedState: 'production_ready',
        status: 'eligible',
      }),
    ]);
    expect(body.productionReadyRegistryMutation).toBe(false);
    expect(inserts.find((insert) => insert.table === evalRuns)?.value).toMatchObject({
      evalId: 'full_startup_launch',
      status: 'passed',
      capabilityKey: 'startup_lifecycle',
      metadata: {
        runnerRef: 'trusted-runner:test',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
    });
    expect(inserts.find((insert) => insert.table === capabilityPromotions)?.value).toMatchObject({
      capabilityKey: 'startup_lifecycle',
      promotedState: 'production_ready',
      status: 'eligible',
      evidenceRefs: ['evidence:real-startup-launch'],
      auditReceiptRefs: ['audit:real-startup-launch'],
    });
  });

  it('does not promote when the trusted real external runner reports blockers', async () => {
    const { db, inserts } = createEvalDb();
    const productionEvalRunner = {
      execute: vi.fn(async () => ({
        run: {
          workspaceId,
          evalId: 'full_startup_launch' as const,
          status: 'passed' as const,
          capabilityKey: 'startup_lifecycle' as const,
          evidenceRefs: ['evidence:real-startup-launch'],
          auditReceiptRefs: ['audit:real-startup-launch'],
          completedAt: '2026-05-05T00:00:00.000Z',
        },
        blockers: ['external browser evidence pack was incomplete'],
      })),
    };
    const { fetch } = testApp(
      evalRoutes,
      createMockDeps({ db: db as never, productionEvalRunner }),
    );

    const res = await fetch(
      'POST',
      '/execute',
      {
        evalId: 'full_startup_launch',
        capabilityKey: 'startup_lifecycle',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
      wsHeader,
    );
    const body = await expectJson<{
      executionMode: string;
      executionBlockers: string[];
      result: { passed: boolean; blockers: string[] };
      promotions: Array<{ capabilityKey: string }>;
    }>(res, 201);

    expect(body.executionMode).toBe(PRODUCTION_READY_EXECUTION_MODE);
    expect(body.executionBlockers).toEqual(['external browser evidence pack was incomplete']);
    expect(body.result.passed).toBe(false);
    expect(body.result.blockers.join(' ')).toContain('external browser evidence pack');
    expect(body.promotions).toEqual([]);
    expect(inserts.find((insert) => insert.table === evalRuns)?.value).toMatchObject({
      evalId: 'full_startup_launch',
      status: 'failed',
      capabilityKey: 'startup_lifecycle',
    });
    expect(inserts.find((insert) => insert.table === capabilityPromotions)).toBeUndefined();
  });

  it('executes scenario-wide eval proof checks without pinning them to the first capability', async () => {
    const { db, inserts } = createEvalDb();
    const { fetch } = testApp(evalRoutes, createMockDeps({ db: db as never }));

    const res = await fetch(
      'POST',
      '/execute',
      {
        evalId: 'full_startup_launch',
        evidenceRefs: ['evidence:startup-launch'],
        auditReceiptRefs: ['audit:startup-launch'],
        evidenceCoverage: [
          'mission run record',
          'source citations',
          'artifact provenance',
          'deployment verification',
        ],
        auditCoverage: ['policy decisions', 'tool receipts', 'escalation records'],
        completedAt: '2026-05-05T00:00:00.000Z',
      },
      wsHeader,
    );
    const body = await expectJson<{
      capabilityKey?: string;
      executionBlockers: string[];
      promotionChecks: Array<{
        canPromote: boolean;
        capability: { key: string };
        blockers: string[];
      }>;
      promotions: Array<{ capabilityKey: string; promotedState: string; status: string }>;
      productionReadyRegistryMutation: boolean;
    }>(res, 201);

    expect(body.capabilityKey).toBeUndefined();
    expect(body.executionBlockers).toEqual([]);
    expect(body.productionReadyRegistryMutation).toBe(false);
    expect(body.promotionChecks).toEqual([
      expect.objectContaining({
        canPromote: false,
        capability: expect.objectContaining({ key: 'mission_runtime' }),
      }),
      expect.objectContaining({
        canPromote: false,
        capability: expect.objectContaining({ key: 'startup_lifecycle' }),
      }),
    ]);
    expect(body.promotionChecks[1]?.blockers.join(' ')).toContain(
      'executionMode real_external_eval',
    );
    expect(body.promotions).toEqual([]);
    expect(inserts.find((insert) => insert.table === capabilityPromotions)).toBeUndefined();
    expect(inserts.find((insert) => insert.table === evalRuns)?.value).toMatchObject({
      evalId: 'full_startup_launch',
      status: 'passed',
      capabilityKey: null,
    });
    expect(inserts.find((insert) => insert.table === evalResults)?.value).toMatchObject({
      evalId: 'full_startup_launch',
      capabilityKey: null,
      passed: true,
    });
  });

  it('executes a production eval proof check as failed when any proof step fails', async () => {
    const scenario = getRequiredEvalForCapability('helm_receipts');
    if (!scenario) throw new Error('helm_receipts eval missing');
    const { db, inserts } = createEvalDb();
    const { fetch } = testApp(evalRoutes, createMockDeps({ db: db as never }));

    const res = await fetch(
      'POST',
      '/execute',
      {
        evalId: scenario.id,
        capabilityKey: 'helm_receipts',
        evidenceRefs: ['evidence:helm-governance'],
        auditReceiptRefs: ['audit:helm-governance'],
        evidenceCoverage: scenario.evidenceRequirements,
        auditCoverage: scenario.auditRequirements,
        completedAt: '2026-05-05T00:00:00.000Z',
        steps: [
          {
            stepKey: 'restricted-action-denial',
            status: 'failed',
            evidenceRefs: ['evidence:step'],
            auditReceiptRefs: ['audit:step'],
            completedAt: '2026-05-05T00:00:00.000Z',
          },
        ],
      },
      wsHeader,
    );
    const body = await expectJson<{
      result: { passed: boolean; blockers: string[] };
      blockerTask: { id: string; title: string };
      promotions: Array<{ capabilityKey: string }>;
      productionReadyRegistryMutation: boolean;
    }>(res, 201);

    expect(body.result.passed).toBe(false);
    expect(body.result.blockers.join(' ')).toContain(
      'Eval step restricted-action-denial status is failed',
    );
    expect(body.blockerTask.title).toContain('HELM Governance Eval');
    expect(body.promotions).toEqual([]);
    expect(body.productionReadyRegistryMutation).toBe(false);
    expect(inserts.find((insert) => insert.table === evalRuns)?.value).toMatchObject({
      status: 'failed',
      capabilityKey: 'helm_receipts',
    });
    expect(inserts.find((insert) => insert.table === capabilityPromotions)).toBeUndefined();
  });

  it('blocks production promotion without a matching passed eval pack', async () => {
    const { fetch } = testApp(evalRoutes, createMockDeps());
    const res = await fetch(
      'POST',
      '/promotion-check',
      {
        capabilityKey: 'startup_lifecycle',
        runs: [],
      },
      wsHeader,
    );
    const body = await expectJson<{
      check: { canPromote: boolean; requiredEval: string; blockers: string[] };
    }>(res, 200);

    expect(body.check.canPromote).toBe(false);
    expect(body.check.requiredEval).toBe('Full Startup Launch Eval');
    expect(body.check.blockers.join(' ')).toContain('No eval run submitted');
  });

  it('uses persisted eval runs when promotion-check has no matching submitted run', async () => {
    const { db } = createEvalDb([
      [
        {
          evalId: 'full_startup_launch',
          workspaceId,
          status: 'passed',
          capabilityKey: 'startup_lifecycle',
          evidenceRefs: ['evidence:startup-launch'],
          auditReceiptRefs: ['audit:startup-launch'],
          metadata: realExternalMetadata,
          completedAt: new Date('2026-05-05T00:00:00.000Z'),
        },
      ],
    ]);
    const { fetch } = testApp(evalRoutes, createMockDeps({ db: db as never }));
    const res = await fetch(
      'POST',
      '/promotion-check',
      {
        capabilityKey: 'startup_lifecycle',
      },
      wsHeader,
    );
    const body = await expectJson<{
      check: {
        canPromote: boolean;
        matchedEvalId: string;
        evidenceRefs: string[];
        auditReceiptRefs: string[];
      };
    }>(res, 200);

    expect(body.check.canPromote).toBe(true);
    expect(body.check.matchedEvalId).toBe('full_startup_launch');
    expect(body.check.evidenceRefs).toEqual(['evidence:startup-launch']);
    expect(body.check.auditReceiptRefs).toEqual(['audit:startup-launch']);
  });

  it('ignores submitted eval runs for production promotion checks', async () => {
    const { fetch } = testApp(evalRoutes, createMockDeps());
    const res = await fetch(
      'POST',
      '/promotion-check',
      {
        capabilityKey: 'startup_lifecycle',
        runs: [
          {
            evalId: 'full_startup_launch',
            workspaceId,
            status: 'passed',
            capabilityKey: 'startup_lifecycle',
            evidenceRefs: ['evidence:startup-launch'],
            auditReceiptRefs: ['audit:startup-launch'],
            metadata: realExternalMetadata,
            completedAt: '2026-05-05T00:00:00.000Z',
          },
        ],
      },
      wsHeader,
    );
    const body = await expectJson<{
      check: { canPromote: boolean; blockers: string[] };
      submittedRunsIgnored: number;
      productionReadyRegistryMutation: boolean;
    }>(res, 200);

    expect(body.check.canPromote).toBe(false);
    expect(body.check.blockers.join(' ')).toContain('No eval run submitted');
    expect(body.submittedRunsIgnored).toBe(1);
    expect(body.productionReadyRegistryMutation).toBe(false);
  });

  it('uses persisted scenario-wide eval runs for every covered capability', async () => {
    const { db } = createEvalDb([
      [
        {
          evalId: 'full_startup_launch',
          workspaceId,
          status: 'passed',
          capabilityKey: null,
          evidenceRefs: ['evidence:startup-launch'],
          auditReceiptRefs: ['audit:startup-launch'],
          metadata: {
            ...realExternalMetadata,
            capabilityKeys: ['mission_runtime', 'startup_lifecycle'],
          },
          completedAt: new Date('2026-05-05T00:00:00.000Z'),
        },
      ],
    ]);
    const { fetch } = testApp(evalRoutes, createMockDeps({ db: db as never }));
    const res = await fetch(
      'POST',
      '/promotion-check',
      {
        capabilityKey: 'startup_lifecycle',
      },
      wsHeader,
    );
    const body = await expectJson<{
      check: {
        canPromote: boolean;
        matchedEvalId: string;
        evidenceRefs: string[];
        auditReceiptRefs: string[];
      };
    }>(res, 200);

    expect(body.check.canPromote).toBe(true);
    expect(body.check.matchedEvalId).toBe('full_startup_launch');
    expect(body.check.evidenceRefs).toEqual(['evidence:startup-launch']);
    expect(body.check.auditReceiptRefs).toEqual(['audit:startup-launch']);
  });

  it('blocks multi-eval promotion checks until every required eval has passed', async () => {
    expect(getRequiredEvalsForCapability('evidence_ledger').map((scenario) => scenario.id)).toEqual(
      ['helm_governance', 'recovery'],
    );

    const { db } = createEvalDb([
      [
        {
          evalId: 'helm_governance',
          workspaceId,
          status: 'passed',
          capabilityKey: 'evidence_ledger',
          evidenceRefs: ['evidence:helm'],
          auditReceiptRefs: ['audit:helm'],
          metadata: realExternalMetadata,
          completedAt: new Date('2026-05-05T00:00:00.000Z'),
        },
      ],
    ]);
    const { fetch } = testApp(evalRoutes, createMockDeps({ db: db as never }));
    const res = await fetch(
      'POST',
      '/promotion-check',
      {
        capabilityKey: 'evidence_ledger',
      },
      wsHeader,
    );
    const body = await expectJson<{
      check: { canPromote: boolean; requiredEvals: string[]; blockers: string[] };
    }>(res, 200);

    expect(body.check.canPromote).toBe(false);
    expect(body.check.requiredEvals).toEqual(['HELM Governance Eval', 'Recovery Eval']);
    expect(body.check.blockers.join(' ')).toContain('Recovery Eval');
  });

  it('allows multi-eval promotion checks only when all required eval packs are present', async () => {
    const { db } = createEvalDb([
      [
        {
          evalId: 'helm_governance',
          workspaceId,
          status: 'passed',
          capabilityKey: 'evidence_ledger',
          evidenceRefs: ['evidence:helm'],
          auditReceiptRefs: ['audit:helm'],
          metadata: realExternalMetadata,
          completedAt: new Date('2026-05-05T00:00:00.000Z'),
        },
        {
          evalId: 'recovery',
          workspaceId,
          status: 'passed',
          capabilityKey: 'evidence_ledger',
          evidenceRefs: ['evidence:recovery'],
          auditReceiptRefs: ['audit:recovery'],
          metadata: realExternalMetadata,
          completedAt: new Date('2026-05-05T00:00:01.000Z'),
        },
      ],
    ]);
    const { fetch } = testApp(evalRoutes, createMockDeps({ db: db as never }));
    const res = await fetch(
      'POST',
      '/promotion-check',
      {
        capabilityKey: 'evidence_ledger',
      },
      wsHeader,
    );
    const body = await expectJson<{
      check: {
        canPromote: boolean;
        matchedEvalIds: string[];
        evidenceRefs: string[];
        auditReceiptRefs: string[];
      };
    }>(res, 200);

    expect(body.check.canPromote).toBe(true);
    expect(body.check.matchedEvalIds).toEqual(['helm_governance', 'recovery']);
    expect(body.check.evidenceRefs).toEqual(['evidence:helm', 'evidence:recovery']);
    expect(body.check.auditReceiptRefs).toEqual(['audit:helm', 'audit:recovery']);
  });

  it('rejects foreign workspace ids on eval mutation', async () => {
    const { db } = createEvalDb();
    const { fetch } = testApp(evalRoutes, createMockDeps({ db: db as never }));

    const res = await fetch(
      'POST',
      '/runs',
      {
        workspaceId: foreignWorkspaceId,
        evalId: 'helm_governance',
        status: 'failed',
        failureReason: 'wrong workspace',
      },
      wsHeader,
    );
    const body = await expectJson<{ error: string }>(res, 403);

    expect(body.error).toContain('workspaceId does not match');
  });

  it('rejects recorded eval runs for capabilities outside the eval scenario', async () => {
    const scenario = getRequiredEvalForCapability('helm_receipts');
    if (!scenario) throw new Error('helm_receipts eval missing');
    const { db, inserts } = createEvalDb();
    const { fetch } = testApp(evalRoutes, createMockDeps({ db: db as never }));

    const res = await fetch(
      'POST',
      '/runs',
      {
        evalId: scenario.id,
        status: 'passed',
        capabilityKey: 'browser_execution',
        evidenceRefs: ['evidence:helm-governance'],
        auditReceiptRefs: ['audit:helm-governance'],
        completedAt: '2026-05-05T00:00:00.000Z',
      },
      wsHeader,
    );
    const body = await expectJson<{
      error: string;
      message: string;
      allowedCapabilityKeys: string[];
    }>(res, 400);

    expect(body.error).toBe('Eval/capability mismatch');
    expect(body.message).toContain('does not evaluate capability browser_execution');
    expect(body.allowedCapabilityKeys).toContain('helm_receipts');
    expect(inserts).toEqual([]);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rejects executed eval proof checks for capabilities outside the eval scenario', async () => {
    const scenario = getRequiredEvalForCapability('helm_receipts');
    if (!scenario) throw new Error('helm_receipts eval missing');
    const { db, inserts } = createEvalDb();
    const { fetch } = testApp(evalRoutes, createMockDeps({ db: db as never }));

    const res = await fetch(
      'POST',
      '/execute',
      {
        evalId: scenario.id,
        capabilityKey: 'browser_execution',
        evidenceRefs: ['evidence:helm-governance'],
        auditReceiptRefs: ['audit:helm-governance'],
        evidenceCoverage: scenario.evidenceRequirements,
        auditCoverage: scenario.auditRequirements,
        completedAt: '2026-05-05T00:00:00.000Z',
      },
      wsHeader,
    );
    const body = await expectJson<{
      error: string;
      message: string;
      allowedCapabilityKeys: string[];
    }>(res, 400);

    expect(body.error).toBe('Eval/capability mismatch');
    expect(body.message).toContain('does not evaluate capability browser_execution');
    expect(body.allowedCapabilityKeys).toContain('helm_receipts');
    expect(inserts).toEqual([]);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('rejects passed eval runs without evidence and audit receipts', async () => {
    const { db } = createEvalDb();
    const { fetch } = testApp(evalRoutes, createMockDeps({ db: db as never }));

    const res = await fetch(
      'POST',
      '/runs',
      {
        evalId: 'helm_governance',
        status: 'passed',
        capabilityKey: 'helm_receipts',
      },
      wsHeader,
    );
    const body = await expectJson<{ error: string }>(res, 400);

    expect(body.error).toBe('Validation failed');
  });
});
