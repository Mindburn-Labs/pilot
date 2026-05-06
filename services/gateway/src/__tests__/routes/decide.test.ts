import { describe, expect, it, vi } from 'vitest';
import { auditLog, evidenceItems } from '@pilot/db/schema';
import { decideRoutes } from '../../routes/decide.js';
import { createMockDeps, expectJson, mockOpportunity, testApp } from '../helpers.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const partnerHeaders = {
  'X-Workspace-Id': workspaceId,
  'X-Workspace-Role': 'partner',
};

function mockHelmClient() {
  const chatCompletion = vi.fn(
    async (
      principal: string | undefined,
      body: { model: string; messages: { content: string }[] },
    ) => {
      const prompt = body.messages[0]?.content ?? '';
      const content = prompt.includes('strongest possible case FOR')
        ? 'Bull case argument'
        : prompt.includes('strongest possible case AGAINST')
          ? 'Bear case argument'
          : JSON.stringify({
              verdict: 'yes',
              confidence: 82,
              reasoning: 'Strong fit with manageable risk.',
            });
      const callNumber = chatCompletion.mock.calls.length;
      return {
        body: {
          id: `chatcmpl-${callNumber}`,
          object: 'chat.completion',
          created: 0,
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content } }],
          usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
        },
        receipt: {
          decisionId: `helm-dec-${callNumber}`,
          verdict: 'ALLOW',
          policyVersion: 'founder-ops-v1',
          principal: principal ?? 'anonymous',
          action: 'LLM_INFERENCE',
          resource: body.model,
          receivedAt: new Date('2026-05-05T00:00:00.000Z'),
        },
      };
    },
  );

  return { chatCompletion };
}

function insertedValue(deps: ReturnType<typeof createMockDeps>, table: unknown) {
  const insertMock = deps.db.insert as unknown as ReturnType<typeof vi.fn>;
  const index = insertMock.mock.calls.findIndex((call) => call[0] === table);
  if (index === -1) throw new Error('Expected insert was not recorded');
  const builder = insertMock.mock.results[index]?.value as { values: ReturnType<typeof vi.fn> };
  return builder.values.mock.calls[0]?.[0] as Record<string, unknown>;
}

function updatedValue(deps: ReturnType<typeof createMockDeps>, table: unknown) {
  const updateMock = deps.db.update as unknown as ReturnType<typeof vi.fn>;
  const index = updateMock.mock.calls.findIndex((call) => call[0] === table);
  if (index === -1) throw new Error('Expected update was not recorded');
  const builder = updateMock.mock.results[index]?.value as { set: ReturnType<typeof vi.fn> };
  return builder.set.mock.calls[0]?.[0] as Record<string, unknown>;
}

function createDecisionCourtPersistenceDb(options: { failEvidence?: boolean } = {}) {
  const inserts: Array<{ table: unknown; value: unknown }> = [];
  const updates: Array<{ table: unknown; value: unknown }> = [];

  const createDbFacade = (
    insertSink: Array<{ table: unknown; value: unknown }>,
    updateSink: Array<{ table: unknown; value: unknown }>,
  ) => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [mockOpportunity({ id: 'opp-1', workspaceId })]),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertSink.push({ table, value });
        return {
          returning: vi.fn(async () => {
            if (table === evidenceItems) {
              if (options.failEvidence) throw new Error('evidence unavailable');
              return [{ id: 'decision-court-evidence-1' }];
            }
            return [];
          }),
          then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
            Promise.resolve([]).then(resolve, reject),
          catch: (reject: (reason: unknown) => void) => Promise.resolve([]).catch(reject),
        };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((value: unknown) => ({
        where: vi.fn(async () => {
          updateSink.push({ table, value });
          return [];
        }),
      })),
    })),
  });

  const db = {
    ...createDbFacade(inserts, updates),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const stagedInserts: Array<{ table: unknown; value: unknown }> = [];
      const stagedUpdates: Array<{ table: unknown; value: unknown }> = [];
      const result = await callback(createDbFacade(stagedInserts, stagedUpdates));
      inserts.push(...stagedInserts);
      updates.push(...stagedUpdates);
      return result;
    }),
    _setResult: vi.fn(),
    _reset: vi.fn(),
  };

  return { db, inserts, updates };
}

describe('decideRoutes', () => {
  it('requires partner role to run Decision Court', async () => {
    const deps = createMockDeps();
    const { fetch } = testApp(decideRoutes, deps);

    const res = await fetch(
      'POST',
      '/court',
      { opportunityIds: ['opp-1'] },
      { 'X-Workspace-Id': workspaceId, 'X-Workspace-Role': 'member' },
    );
    const body = await expectJson<{ error: string; requiredRole: string }>(res, 403);

    expect(body.error).toBe('insufficient workspace role');
    expect(body.requiredRole).toBe('partner');
    expect(deps.db.select).not.toHaveBeenCalled();
  });

  it('returns unavailable in governed mode when no HELM LLM provider is configured', async () => {
    const deps = createMockDeps();
    deps.db._setResult([mockOpportunity({ id: 'opp-1', workspaceId })]);
    const { fetch } = testApp(decideRoutes, deps);

    const res = await fetch('POST', '/court', { opportunityIds: ['opp-1'] }, partnerHeaders);
    const body = await expectJson<Record<string, unknown>>(res, 200);

    expect(body).toMatchObject({
      mode: 'unavailable',
      status: 'unavailable',
      productionReady: false,
    });
    expect(String(body.unavailableReason)).toContain('HELM-governed LLM provider');
    expect(deps.db.insert).toHaveBeenCalled();
  });

  it('runs heuristic preview only when explicitly requested', async () => {
    const deps = createMockDeps();
    deps.db._setResult([mockOpportunity({ id: 'opp-1', workspaceId })]);
    const { fetch } = testApp(decideRoutes, deps);

    const res = await fetch(
      'POST',
      '/court',
      { opportunityIds: ['opp-1'], mode: 'heuristic_preview' },
      partnerHeaders,
    );
    const body = await expectJson<{
      mode: string;
      status: string;
      productionReady: boolean;
      ranking: Array<{ verdict: string; reasoning: string }>;
      modelCalls: unknown[];
    }>(res, 200);

    expect(body.mode).toBe('heuristic_preview');
    expect(body.status).toBe('completed');
    expect(body.productionReady).toBe(false);
    expect(body.modelCalls).toEqual([]);
    expect(body.ranking[0]?.verdict).toBe('neutral');
    expect(body.ranking[0]?.reasoning).toContain('heuristic neutral verdict');
  });

  it('validates request shape before loading opportunities', async () => {
    const deps = createMockDeps();
    const { fetch } = testApp(decideRoutes, deps);

    const res = await fetch('POST', '/court', { opportunityIds: [] }, partnerHeaders);
    const body = await expectJson<{ error: string }>(res, 400);

    expect(body.error).toBe('Invalid decision court request');
    expect(deps.db.select).not.toHaveBeenCalled();
  });

  it('uses a workspace-scoped HELM principal for governed court model calls', async () => {
    const helmClient = mockHelmClient();
    const deps = createMockDeps({ helmClient: helmClient as never });
    deps.db._setResult([mockOpportunity({ id: 'opp-1', workspaceId })]);
    const { fetch } = testApp(decideRoutes, deps);

    const res = await fetch(
      'POST',
      '/court',
      { opportunityIds: ['opp-1'], mode: 'governed_llm_court' },
      partnerHeaders,
    );
    const body = await expectJson<{
      mode: string;
      status: string;
      modelCalls: { policyDecisionId?: string; status: string }[];
      finalRecommendation?: { opportunityId: string };
    }>(res, 200);

    expect(body.mode).toBe('governed_llm_court');
    expect(body.status).toBe('completed');
    expect(body.modelCalls).toHaveLength(3);
    expect(body.modelCalls.every((call) => call.status === 'completed')).toBe(true);
    expect(body.modelCalls.every((call) => call.policyDecisionId?.startsWith('helm-dec-'))).toBe(
      true,
    );
    expect(body.finalRecommendation).toMatchObject({ opportunityId: 'opp-1' });
    expect(helmClient.chatCompletion).toHaveBeenCalledTimes(3);
    expect(helmClient.chatCompletion.mock.calls.map((call) => call[0])).toEqual([
      `workspace:${workspaceId}/operator:decision_court`,
      `workspace:${workspaceId}/operator:decision_court`,
      `workspace:${workspaceId}/operator:decision_court`,
    ]);

    const auditValue = insertedValue(deps, auditLog);
    const evidenceValue = insertedValue(deps, evidenceItems);
    const auditMetadata = auditValue['metadata'] as Record<string, unknown>;
    const replayRef = auditMetadata['replayRef'];
    expect(auditValue).toMatchObject({
      id: expect.any(String),
      workspaceId,
      action: 'DECISION_COURT_RUN',
      verdict: 'completed',
    });
    expect(auditMetadata).toMatchObject({
      mode: 'governed_llm_court',
      status: 'completed',
      promptVersion: 'decision-court-v1',
      policyDecisionIds: ['helm-dec-1', 'helm-dec-2', 'helm-dec-3'],
      policyVersions: ['founder-ops-v1'],
      helmDocumentVersionPins: {
        decisionCourtPrompt: 'decision-court-v1',
        'modelCall:1:bull:opp-1': 'founder-ops-v1',
        'modelCall:2:bear:opp-1': 'founder-ops-v1',
        'modelCall:3:referee:opp-1': 'founder-ops-v1',
      },
      credentialBoundary: 'no_raw_credentials_or_session_payloads_in_prompt',
    });
    expect(String(replayRef)).toMatch(/^decision-court:/);
    expect(evidenceValue).toMatchObject({
      workspaceId,
      auditEventId: auditValue['id'],
      evidenceType: 'decision_court_run',
      sourceType: 'decision_court',
      redactionState: 'redacted',
      sensitivity: 'internal',
      replayRef,
      metadata: expect.objectContaining({
        policyDecisionIds: ['helm-dec-1', 'helm-dec-2', 'helm-dec-3'],
        helmDocumentVersionPins: expect.objectContaining({
          decisionCourtPrompt: 'decision-court-v1',
        }),
      }),
    });
    expect(String(evidenceValue['contentHash'])).toMatch(/^sha256:[a-f0-9]{64}$/);

    const auditUpdate = updatedValue(deps, auditLog);
    expect(auditUpdate['metadata']).toMatchObject({
      ...auditMetadata,
      evidenceItemId: expect.any(String),
    });
  });

  it('fails closed without committing Decision Court audit when evidence persistence fails', async () => {
    const { db, inserts, updates } = createDecisionCourtPersistenceDb({
      failEvidence: true,
    });
    const deps = createMockDeps({ db: db as never });
    const { fetch } = testApp(decideRoutes, deps);

    const res = await fetch('POST', '/court', { opportunityIds: ['opp-1'] }, partnerHeaders);
    const body = await expectJson<{ error: string; capability?: unknown }>(res, 500);

    expect(body.error).toContain('evidence unavailable');
    expect(inserts).toEqual([]);
    expect(updates).toEqual([]);
  });
});
