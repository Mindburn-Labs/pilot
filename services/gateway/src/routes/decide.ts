import { Hono } from 'hono';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { appendEvidenceItem } from '@pilot/db';
import { auditLog, opportunities } from '@pilot/db/schema';
import { HelmLlmProvider } from '@pilot/helm-client';
import { getCapabilityRecord } from '@pilot/shared/capabilities';
import { DecisionCourtRequestInput } from '@pilot/shared/schemas';
import type { CourtResult, DecisionCourtRequestedMode } from '@pilot/decision-court';
import { type GatewayDeps } from '../index.js';
import { getWorkspaceId, requireWorkspaceRole } from '../lib/workspace.js';

const DECISION_COURT_PROMPT_VERSION = 'decision-court-v1';

/**
 * Decision Court routes (Phase 4).
 *
 * POST /api/decide/court  — run an adversarial decision court on selected opportunities
 */
export function decideRoutes(deps: GatewayDeps) {
  const app = new Hono();

  app.post('/court', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'run decision court');
    if (roleDenied) return roleDenied;

    const parsed = DecisionCourtRequestInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json(
        {
          error: 'Invalid decision court request',
          details: parsed.error.flatten(),
        },
        400,
      );
    }
    const body = parsed.data;
    const opportunityIds = body.opportunityIds;

    // Fetch opportunity data for the shortlist (workspace-scoped)
    const shortlist = [];
    for (const oppId of opportunityIds) {
      const [opp] = await deps.db
        .select()
        .from(opportunities)
        .where(and(eq(opportunities.id, oppId), eq(opportunities.workspaceId, workspaceId)))
        .limit(1);
      if (opp) {
        shortlist.push({ id: opp.id, title: opp.title, description: opp.description });
      }
    }

    if (shortlist.length === 0) {
      return c.json({ error: 'No valid opportunities found in this workspace' }, 404);
    }

    const { DecisionCourt } = await import('@pilot/decision-court');
    const capability = getCapabilityRecord('decision_court');
    const requestedMode = normalizeCourtMode(body.mode);
    const court = new DecisionCourt({
      mode: requestedMode,
      llm: createDecisionCourtProvider(deps, workspaceId, requestedMode),
    });

    try {
      const result = await court.runCourt({
        shortlist,
        systemContext: body.founderContext,
        mode: requestedMode,
      });
      await persistDecisionCourtRun(deps, workspaceId, {
        result,
        opportunityIds,
        founderContextProvided: Boolean(body.founderContext?.trim()),
      });
      return c.json({ ...result, capability });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Decision court failed';
      return c.json({ error: message, capability }, 500);
    }
  });

  return app;
}

function normalizeCourtMode(mode: unknown): DecisionCourtRequestedMode {
  return mode === 'heuristic_preview' ? 'heuristic_preview' : 'governed_llm_court';
}

function createDecisionCourtProvider(
  deps: GatewayDeps,
  workspaceId: string,
  mode: DecisionCourtRequestedMode,
) {
  if (mode !== 'governed_llm_court' || !deps.helmClient) return undefined;
  return new HelmLlmProvider({
    helm: deps.helmClient,
    defaultPrincipal: `workspace:${workspaceId}/operator:decision_court`,
    model: process.env['PILOT_LLM_MODEL'] ?? 'anthropic/claude-sonnet-4',
  });
}

async function persistDecisionCourtRun(
  deps: GatewayDeps,
  workspaceId: string,
  params: {
    result: CourtResult;
    opportunityIds: string[];
    founderContextProvided: boolean;
  },
): Promise<void> {
  const auditEventId = randomUUID();
  const replayRef = `decision-court:${auditEventId}`;
  const helmDocumentVersionPins = decisionCourtHelmDocumentVersionPins(params.result);
  const policyDecisionIds = params.result.modelCalls
    .map((call) => call.policyDecisionId)
    .filter((value): value is string => Boolean(value));
  const policyVersions = [
    ...new Set(
      params.result.modelCalls
        .map((call) => call.policyVersion)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const metadata = {
    requestedOpportunityIds: params.opportunityIds,
    founderContextProvided: params.founderContextProvided,
    mode: params.result.mode,
    status: params.result.status,
    productionReady: params.result.productionReady,
    finalRecommendation: params.result.finalRecommendation ?? null,
    ranking: params.result.ranking,
    stages: params.result.stages,
    modelCalls: params.result.modelCalls,
    policyDecisionIds,
    policyVersions,
    helmDocumentVersionPins,
    promptVersion: DECISION_COURT_PROMPT_VERSION,
    replayRef,
    credentialBoundary: 'no_raw_credentials_or_session_payloads_in_prompt',
  };

  await deps.db.transaction(async (tx) => {
    await tx.insert(auditLog).values({
      id: auditEventId,
      workspaceId,
      action: 'DECISION_COURT_RUN',
      actor: `workspace:${workspaceId}`,
      target: params.result.mode,
      verdict: params.result.status,
      reason:
        params.result.governanceDenialReason ??
        params.result.unavailableReason ??
        params.result.finalRecommendation?.reasoning ??
        null,
      metadata,
    });

    const evidenceItemId = await appendEvidenceItem(tx, {
      workspaceId,
      auditEventId,
      evidenceType: 'decision_court_run',
      sourceType: 'decision_court',
      title: `Decision Court ${params.result.status}`,
      summary:
        params.result.finalRecommendation?.reasoning ??
        params.result.governanceDenialReason ??
        params.result.unavailableReason ??
        `Decision Court completed with status ${params.result.status}.`,
      redactionState: 'redacted',
      sensitivity: 'internal',
      contentHash: `sha256:${hashJson(metadata)}`,
      replayRef,
      metadata,
    });

    await tx
      .update(auditLog)
      .set({
        metadata: {
          ...metadata,
          evidenceItemId,
        },
      })
      .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));
  });
}

function decisionCourtHelmDocumentVersionPins(result: CourtResult): Record<string, string> {
  const pins: Record<string, string> = {
    decisionCourtPrompt: DECISION_COURT_PROMPT_VERSION,
  };
  result.modelCalls.forEach((call, index) => {
    if (call.policyVersion) {
      pins[`modelCall:${index + 1}:${call.participant}:${call.opportunityId}`] =
        call.policyVersion;
    }
  });
  return pins;
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}
