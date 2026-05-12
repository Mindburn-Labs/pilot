import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, desc, eq, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { appendEvidenceItem } from '@pilot/db';
import {
  auditLog,
  capabilityPromotions,
  evalEvidenceLinks,
  evalResults,
  evalRuns,
  evalSteps,
  evaluations,
  tasks,
} from '@pilot/db/schema';
import {
  CapabilityKeySchema,
  getCapabilityRecord,
  type CapabilityKey,
  type CapabilityRecord,
} from '@pilot/shared/capabilities';
import {
  ExecutePilotEvalInputSchema,
  PilotEvalIdSchema,
  PilotEvalExecutionModeSchema,
  PilotEvalRunRecordSchema,
  PilotEvalStatusSchema,
  PRODUCTION_READY_EXECUTION_MODE,
  RecordPilotEvalRunInputSchema,
  buildCapabilityEvalReadinessInventory,
  checkCapabilityPromotionReadiness,
  executePilotProductionEval,
  getPilotProductionEvalSuite,
  getRequiredEvalsForCapability,
  type PilotEvalRunRecord,
  type RecordPilotEvalRunInput,
} from '@pilot/shared/eval';
import { type GatewayDeps } from '../index.js';
import { getWorkspaceId, requireWorkspaceRole, workspaceIdMismatch } from '../lib/workspace.js';

const ListEvalRunsQuery = z.object({
  evalId: PilotEvalIdSchema.optional(),
  capabilityKey: CapabilityKeySchema.optional(),
  status: PilotEvalStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const PromotionCheckInput = z.object({
  workspaceId: z.string().uuid().optional(),
  capabilityKey: CapabilityKeySchema,
  runs: z.array(PilotEvalRunRecordSchema).default([]),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toIso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function trustedExecutionMode(extraResponse: Record<string, unknown>) {
  const parsed = PilotEvalExecutionModeSchema.safeParse(extraResponse['executionMode']);
  return parsed.success ? parsed.data : undefined;
}

function trustedEvalMetadata(
  metadata: Record<string, unknown> | undefined,
  extraResponse: Record<string, unknown>,
) {
  const { executionMode: _clientExecutionMode, ...rest } = metadata ?? {};
  const executionMode = trustedExecutionMode(extraResponse);
  return executionMode ? { ...rest, executionMode } : rest;
}

function toPilotEvalRunRecord(row: typeof evalRuns.$inferSelect): PilotEvalRunRecord {
  return PilotEvalRunRecordSchema.parse({
    evalId: row.evalId,
    workspaceId: row.workspaceId,
    status: row.status,
    capabilityKey: row.capabilityKey ?? undefined,
    evidenceRefs: stringArray(row.evidenceRefs),
    auditReceiptRefs: stringArray(row.auditReceiptRefs),
    runRef: row.runRef ?? undefined,
    failureReason: row.failureReason ?? undefined,
    metadata: isRecord(row.metadata) ? row.metadata : {},
    completedAt: toIso(row.completedAt),
  });
}

function toEvalRunResponse(row: typeof evalRuns.$inferSelect) {
  return {
    id: row.id,
    ...toPilotEvalRunRecord(row),
    startedAt: toIso(row.startedAt),
    createdAt: toIso(row.createdAt),
  };
}

function evalCapabilityMismatch(evalId: string, capabilityKey?: CapabilityKey) {
  if (!capabilityKey) return null;
  const scenario = getPilotProductionEvalSuite().find((item) => item.id === evalId);
  if (!scenario || scenario.capabilityKeys.includes(capabilityKey)) return null;

  return {
    error: 'Eval/capability mismatch',
    message: `${scenario.name} does not evaluate capability ${capabilityKey}`,
    evalId,
    capabilityKey,
    allowedCapabilityKeys: scenario.capabilityKeys,
  };
}

function failedRealExternalEvalRun(
  workspaceId: string,
  input: z.infer<typeof ExecutePilotEvalInputSchema>,
  failureReason: string,
): RecordPilotEvalRunInput {
  return {
    workspaceId,
    evalId: input.evalId,
    status: 'failed',
    capabilityKey: input.capabilityKey,
    runRef: input.runRef ?? `real-external-eval:${input.evalId}:${randomUUID()}`,
    failureReason,
    summary: failureReason,
    evidenceRefs: [],
    auditReceiptRefs: [],
    metadata: {
      requestedExecutionMode: PRODUCTION_READY_EXECUTION_MODE,
      trustedRunnerAvailable: false,
    },
    completedAt: new Date().toISOString(),
    steps: [],
  };
}

async function executeTrustedRealExternalEval(
  deps: GatewayDeps,
  workspaceId: string,
  input: z.infer<typeof ExecutePilotEvalInputSchema>,
): Promise<{
  run: RecordPilotEvalRunInput;
  blockers: string[];
}> {
  if (!deps.productionEvalRunner) {
    const failureReason =
      'real_external_eval requested, but no trusted production eval runner is configured';
    return {
      run: failedRealExternalEvalRun(workspaceId, input, failureReason),
      blockers: [failureReason],
    };
  }

  try {
    const executed = await deps.productionEvalRunner.execute({
      ...input,
      workspaceId,
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
    });
    const parsedRun = RecordPilotEvalRunInputSchema.parse({
      ...executed.run,
      workspaceId,
    });
    const runnerBlockers = (executed.blockers ?? []).filter((blocker) => blocker.length > 0);
    if (runnerBlockers.length > 0) {
      const failureReason = `trusted real_external_eval runner reported blockers: ${runnerBlockers.join('; ')}`;
      return {
        run: failedRealExternalEvalRun(workspaceId, input, failureReason),
        blockers: runnerBlockers,
      };
    }
    if (parsedRun.evalId !== input.evalId) {
      const failureReason = `trusted real_external_eval runner returned evalId ${parsedRun.evalId} for requested evalId ${input.evalId}`;
      return {
        run: failedRealExternalEvalRun(workspaceId, input, failureReason),
        blockers: [failureReason],
      };
    }
    if (input.capabilityKey && parsedRun.capabilityKey !== input.capabilityKey) {
      const failureReason = `trusted real_external_eval runner returned capabilityKey ${parsedRun.capabilityKey} for requested capabilityKey ${input.capabilityKey}`;
      return {
        run: failedRealExternalEvalRun(workspaceId, input, failureReason),
        blockers: [failureReason],
      };
    }
    return {
      run: parsedRun,
      blockers: executed.blockers ?? [],
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const failureReason = `trusted real_external_eval runner failed: ${detail}`;
    return {
      run: failedRealExternalEvalRun(workspaceId, input, failureReason),
      blockers: [failureReason],
    };
  }
}

function capabilityRunScope(capabilityKey: CapabilityKey): SQL {
  const requiredEvalIds = getRequiredEvalsForCapability(capabilityKey).map(
    (scenario) => scenario.id,
  );
  const explicitCapabilityRun = eq(evalRuns.capabilityKey, capabilityKey);
  const scenarioWideRequiredEval =
    requiredEvalIds.length > 0
      ? and(isNull(evalRuns.capabilityKey), inArray(evalRuns.evalId, requiredEvalIds))
      : undefined;
  return scenarioWideRequiredEval
    ? (or(explicitCapabilityRun, scenarioWideRequiredEval) ?? explicitCapabilityRun)
    : explicitCapabilityRun;
}

async function persistEvalRun(
  deps: GatewayDeps,
  workspaceId: string,
  input: RecordPilotEvalRunInput,
  extraResponse: Record<string, unknown> = {},
) {
  const scenario = getPilotProductionEvalSuite().find((item) => item.id === input.evalId);
  const completedAt =
    input.completedAt ??
    (input.status === 'passed' || input.status === 'failed' ? new Date().toISOString() : undefined);
  const metadata = trustedEvalMetadata(input.metadata, extraResponse);
  const executionMode = trustedExecutionMode(extraResponse) ?? null;

  return await deps.db.transaction(async (tx) => {
    const db = tx as unknown as typeof deps.db;

    if (scenario) {
      await db
        .insert(evaluations)
        .values({
          evalId: scenario.id,
          name: scenario.name,
          capabilityKeys: scenario.capabilityKeys,
          scenario,
        })
        .onConflictDoUpdate({
          target: evaluations.evalId,
          set: {
            name: scenario.name,
            capabilityKeys: scenario.capabilityKeys,
            scenario,
          },
        });
    }

    const [created] = await db
      .insert(evalRuns)
      .values({
        workspaceId,
        evalId: input.evalId,
        status: input.status,
        capabilityKey: input.capabilityKey ?? null,
        runRef: input.runRef ?? null,
        failureReason: input.failureReason ?? input.summary ?? null,
        evidenceRefs: input.evidenceRefs,
        auditReceiptRefs: input.auditReceiptRefs,
        metadata,
        completedAt: completedAt ? new Date(completedAt) : null,
      })
      .returning();

    if (!created) {
      return {
        status: 500 as const,
        body: { error: 'eval run was not persisted' },
      };
    }

    if (input.steps.length > 0) {
      await db.insert(evalSteps).values(
        input.steps.map((step) => ({
          evalRunId: created.id,
          stepKey: step.stepKey,
          status: step.status,
          evidenceRefs: step.evidenceRefs,
          auditReceiptRefs: step.auditReceiptRefs,
          metadata: step.metadata,
          completedAt: step.completedAt ? new Date(step.completedAt) : null,
        })),
      );
    }

    if (input.evidenceRefs.length > 0) {
      await db.insert(evalEvidenceLinks).values(
        input.evidenceRefs.map((evidenceRef, index) => ({
          workspaceId,
          evalRunId: created.id,
          evidenceRef,
          auditReceiptRef: input.auditReceiptRefs[index] ?? null,
        })),
      );
    }

    const terminal = input.status === 'passed' || input.status === 'failed';
    const passed = input.status === 'passed';
    const blockers = passed
      ? []
      : [input.failureReason ?? input.summary ?? `${input.evalId} did not pass`];

    const evidenceItemIds: string[] = [];
    const auditEventId = randomUUID();
    const auditMetadata = {
      evalRunId: created.id,
      evalId: input.evalId,
      status: input.status,
      capabilityKey: created.capabilityKey ?? input.capabilityKey ?? null,
      capabilityKeys: scenario?.capabilityKeys ?? [],
      evidenceRefs: input.evidenceRefs,
      auditReceiptRefs: input.auditReceiptRefs,
      runRef: input.runRef ?? `eval:${created.id}`,
      executionMode,
      promotionRule:
        'production_ready promotion eligibility only; capability registry remains immutable here',
    };

    await db.insert(auditLog).values({
      id: auditEventId,
      workspaceId,
      action: 'PILOT_PRODUCTION_EVAL_RUN',
      actor: `workspace:${workspaceId}`,
      target: input.evalId,
      verdict: input.status,
      reason: input.failureReason ?? input.summary ?? null,
      metadata: auditMetadata,
    });

    evidenceItemIds.push(
      await appendEvidenceItem(db, {
        workspaceId,
        auditEventId,
        evidenceType: 'eval_run',
        sourceType: 'eval_harness',
        title: `Eval ${input.evalId}: ${input.status}`,
        summary: input.summary ?? input.failureReason ?? scenario?.name ?? input.evalId,
        redactionState: 'redacted',
        sensitivity: 'internal',
        replayRef: input.runRef ?? `eval:${created.id}`,
        observedAt: completedAt ? new Date(completedAt) : (created.createdAt ?? new Date()),
        metadata: {
          evalRunId: created.id,
          evalId: input.evalId,
          status: input.status,
          capabilityKey: created.capabilityKey ?? input.capabilityKey ?? null,
          capabilityKeys: scenario?.capabilityKeys ?? [],
          evidenceRefs: input.evidenceRefs,
          auditReceiptRefs: input.auditReceiptRefs,
          executionMode,
        },
      }),
    );

    for (const [index, evidenceRef] of input.evidenceRefs.entries()) {
      evidenceItemIds.push(
        await appendEvidenceItem(db, {
          workspaceId,
          auditEventId,
          evidenceType: 'eval_evidence_ref',
          sourceType: 'eval_harness',
          title: `Eval evidence: ${input.evalId}`,
          summary: evidenceRef,
          redactionState: 'redacted',
          sensitivity: 'internal',
          replayRef: evidenceRef,
          observedAt: completedAt ? new Date(completedAt) : (created.createdAt ?? new Date()),
          metadata: {
            evalRunId: created.id,
            evalId: input.evalId,
            capabilityKey: created.capabilityKey ?? input.capabilityKey ?? null,
            capabilityKeys: scenario?.capabilityKeys ?? [],
            evidenceRef,
            auditReceiptRef: input.auditReceiptRefs[index] ?? null,
          },
        }),
      );
    }

    let result: unknown;
    let blockerTask: unknown;
    const promotions = [];
    const runRecord = toPilotEvalRunRecord(created);
    const promotionChecks = [];
    if (passed) {
      const promotionCapabilities = (
        input.capabilityKey ? [input.capabilityKey] : (scenario?.capabilityKeys ?? [])
      )
        .map((capabilityKey) => getCapabilityRecord(capabilityKey))
        .filter((capability): capability is CapabilityRecord => Boolean(capability));

      for (const capability of promotionCapabilities) {
        const persistedRows = await db
          .select()
          .from(evalRuns)
          .where(and(eq(evalRuns.workspaceId, workspaceId), capabilityRunScope(capability.key)))
          .orderBy(desc(evalRuns.createdAt))
          .limit(25);
        const persistedRuns = persistedRows
          .map(toPilotEvalRunRecord)
          .filter(
            (run) => run.evalId !== runRecord.evalId || run.completedAt !== runRecord.completedAt,
          );

        promotionChecks.push(
          checkCapabilityPromotionReadiness({
            capability,
            runs: [{ ...runRecord, capabilityKey: capability.key }, ...persistedRuns],
          }),
        );
      }
    }

    if (terminal) {
      const [createdResult] = await db
        .insert(evalResults)
        .values({
          workspaceId,
          evalRunId: created.id,
          evalId: input.evalId,
          capabilityKey: created.capabilityKey ?? input.capabilityKey ?? null,
          status: input.status,
          passed,
          summary: input.summary ?? input.failureReason ?? null,
          blockers,
        })
        .returning();
      result = createdResult;
      if (createdResult) {
        evidenceItemIds.push(
          await appendEvidenceItem(db, {
            workspaceId,
            auditEventId,
            evidenceType: 'eval_result',
            sourceType: 'eval_harness',
            title: `Eval result ${input.evalId}: ${passed ? 'passed' : 'failed'}`,
            summary: input.summary ?? input.failureReason ?? null,
            redactionState: 'redacted',
            sensitivity: 'internal',
            replayRef: `eval-result:${createdResult.id}`,
            observedAt: created.completedAt ?? createdResult.createdAt ?? new Date(),
            metadata: {
              evalRunId: created.id,
              evalResultId: createdResult.id,
              evalId: input.evalId,
              status: input.status,
              passed,
              blockers,
              capabilityKey: created.capabilityKey ?? input.capabilityKey ?? null,
              capabilityKeys: scenario?.capabilityKeys ?? [],
            },
          }),
        );
      }
    }

    if (input.status === 'failed') {
      const [createdTask] = await db
        .insert(tasks)
        .values({
          workspaceId,
          title: `[Eval Blocker] ${scenario?.name ?? input.evalId}`,
          description:
            input.failureReason ?? input.summary ?? `Production eval ${input.evalId} failed.`,
          mode: 'eval',
          status: 'pending',
          priority: 100,
          metadata: {
            kind: 'production_eval_blocker',
            productionReadyBlocked: true,
            evalId: input.evalId,
            evalRunId: created.id,
            capabilityKey: created.capabilityKey ?? input.capabilityKey ?? null,
            capabilityKeys: scenario?.capabilityKeys ?? [],
          },
        })
        .returning();
      blockerTask = createdTask;
    }

    for (const check of promotionChecks) {
      if (!check.canPromote) continue;
      const [promotion] = await db
        .insert(capabilityPromotions)
        .values({
          workspaceId,
          capabilityKey: check.capability.key,
          evalRunId: created.id,
          status: 'eligible',
          promotedState: 'production_ready',
          evidenceRefs: check.evidenceRefs,
          auditReceiptRefs: check.auditReceiptRefs,
        })
        .returning();
      if (promotion) promotions.push(promotion);
    }

    await db
      .update(auditLog)
      .set({
        metadata: {
          ...auditMetadata,
          evidenceItemIds,
          resultId: isRecord(result) && typeof result['id'] === 'string' ? result['id'] : null,
          blockerTaskId:
            isRecord(blockerTask) && typeof blockerTask['id'] === 'string'
              ? blockerTask['id']
              : null,
          promotionIds: promotions
            .map((promotion) =>
              isRecord(promotion) && typeof promotion['id'] === 'string' ? promotion['id'] : null,
            )
            .filter((id): id is string => typeof id === 'string'),
        },
      })
      .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

    return {
      status: 201 as const,
      body: {
        ...toEvalRunResponse(created),
        result,
        blockerTask,
        promotionChecks,
        promotions,
        evidenceItemIds,
        productionReadyRegistryMutation: false,
        ...extraResponse,
      },
    };
  });
}

export function evalRoutes(deps: GatewayDeps) {
  const app = new Hono();

  app.get('/production-suite', (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view production eval suite');
    if (roleDenied) return roleDenied;

    return c.json({
      workspaceId,
      productionReadyPromotionRule: `A capability cannot be promoted to production_ready unless every required eval run passed with evidenceRefs, auditReceiptRefs, completedAt, and trusted metadata.executionMode=${PRODUCTION_READY_EXECUTION_MODE}.`,
      scenarios: getPilotProductionEvalSuite(),
    });
  });

  app.get('/readiness', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view production eval readiness');
    if (roleDenied) return roleDenied;

    const rows = await deps.db
      .select()
      .from(evalRuns)
      .where(eq(evalRuns.workspaceId, workspaceId))
      .orderBy(desc(evalRuns.createdAt))
      .limit(200);

    return c.json(
      {
        workspaceId,
        inventory: buildCapabilityEvalReadinessInventory(rows.map(toPilotEvalRunRecord)),
        productionReadyRegistryMutation: false,
      },
      200,
    );
  });

  app.get('/runs', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'list production eval runs');
    if (roleDenied) return roleDenied;

    const parsed = ListEvalRunsQuery.safeParse({
      evalId: c.req.query('evalId'),
      capabilityKey: c.req.query('capabilityKey'),
      status: c.req.query('status'),
      limit: c.req.query('limit'),
    });
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const clauses = [eq(evalRuns.workspaceId, workspaceId)];
    if (parsed.data.evalId) clauses.push(eq(evalRuns.evalId, parsed.data.evalId));
    if (parsed.data.capabilityKey) {
      clauses.push(capabilityRunScope(parsed.data.capabilityKey));
    }
    if (parsed.data.status) clauses.push(eq(evalRuns.status, parsed.data.status));

    const rows = await deps.db
      .select()
      .from(evalRuns)
      .where(and(...clauses))
      .orderBy(desc(evalRuns.createdAt))
      .limit(parsed.data.limit);

    return c.json({ workspaceId, runs: rows.map(toEvalRunResponse) }, 200);
  });

  app.post('/runs', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'record production eval run');
    if (roleDenied) return roleDenied;

    const raw = await c.req.json().catch(() => ({}));
    if (workspaceIdMismatch(c, (raw as { workspaceId?: string }).workspaceId)) {
      return c.json({ error: 'workspaceId does not match authenticated workspace' }, 403);
    }

    const parsed = RecordPilotEvalRunInputSchema.safeParse({
      ...(raw as Record<string, unknown>),
      workspaceId,
    });
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }
    const mismatch = evalCapabilityMismatch(parsed.data.evalId, parsed.data.capabilityKey);
    if (mismatch) return c.json(mismatch, 400);

    const persisted = await persistEvalRun(deps, workspaceId, parsed.data);
    return c.json(persisted.body, persisted.status);
  });

  app.post('/execute', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'execute production eval');
    if (roleDenied) return roleDenied;

    const raw = await c.req.json().catch(() => ({}));
    if (workspaceIdMismatch(c, (raw as { workspaceId?: string }).workspaceId)) {
      return c.json({ error: 'workspaceId does not match authenticated workspace' }, 403);
    }

    const parsed = ExecutePilotEvalInputSchema.safeParse({
      ...(raw as Record<string, unknown>),
      workspaceId,
    });
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }
    const mismatch = evalCapabilityMismatch(parsed.data.evalId, parsed.data.capabilityKey);
    if (mismatch) return c.json(mismatch, 400);

    const executed =
      parsed.data.executionMode === PRODUCTION_READY_EXECUTION_MODE
        ? {
            ...(await executeTrustedRealExternalEval(deps, workspaceId, parsed.data)),
            executionMode: PRODUCTION_READY_EXECUTION_MODE,
          }
        : executePilotProductionEval(parsed.data);
    const persisted = await persistEvalRun(deps, workspaceId, executed.run, {
      executionMode: executed.executionMode,
      executionBlockers: executed.blockers,
    });
    return c.json(persisted.body, persisted.status);
  });

  app.post('/promotion-check', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'check capability promotion readiness');
    if (roleDenied) return roleDenied;

    const raw = await c.req.json().catch(() => ({}));
    if (workspaceIdMismatch(c, (raw as { workspaceId?: string }).workspaceId)) {
      return c.json({ error: 'workspaceId does not match authenticated workspace' }, 403);
    }

    const parsed = PromotionCheckInput.safeParse({
      ...(raw as Record<string, unknown>),
      workspaceId,
    });
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const capability = getCapabilityRecord(parsed.data.capabilityKey);
    if (!capability) return c.json({ error: 'Unknown capability' }, 404);

    const persistedRows = await deps.db
      .select()
      .from(evalRuns)
      .where(
        and(eq(evalRuns.workspaceId, workspaceId), capabilityRunScope(parsed.data.capabilityKey)),
      )
      .orderBy(desc(evalRuns.createdAt))
      .limit(25);

    const persistedRuns = persistedRows.map(toPilotEvalRunRecord);
    const check = checkCapabilityPromotionReadiness({
      capability,
      runs: persistedRuns,
    });
    return c.json(
      {
        workspaceId,
        check,
        submittedRunsIgnored: parsed.data.runs.length,
        productionReadyRegistryMutation: false,
      },
      200,
    );
  });

  return app;
}
