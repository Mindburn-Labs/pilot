import { describe, it, expect, vi, beforeEach } from 'vitest';
import { auditLog, evidenceItems, opportunities } from '@pilot/db/schema';
import { opportunityRoutes } from '../../routes/opportunity.js';
import { testApp, expectJson, mockOpportunity, createMockDeps } from '../helpers.js';

function createOpportunityCreateDb(workspaceId: string, options: { failEvidence?: boolean } = {}) {
  const inserts: Array<{ table: unknown; value: unknown }> = [];
  const updates: Array<{ table: unknown; value: unknown }> = [];

  const createDbFacade = (
    insertSink: Array<{ table: unknown; value: unknown }>,
    updateSink: Array<{ table: unknown; value: unknown }>,
  ) => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => []),
          orderBy: vi.fn(() => ({ limit: vi.fn(async () => []) })),
        })),
        orderBy: vi.fn(() => ({ limit: vi.fn(async () => []) })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertSink.push({ table, value });
        return {
          returning: vi.fn(async () => {
            if (table === opportunities) {
              return [
                mockOpportunity({
                  id: 'opp-1',
                  workspaceId,
                  source: value['source'],
                  sourceUrl: value['sourceUrl'],
                  title: value['title'],
                  description: value['description'],
                  status: value['status'],
                }),
              ];
            }
            if (table === evidenceItems) {
              if (options.failEvidence) throw new Error('evidence unavailable');
              return [{ id: 'evidence-opportunity-create-1' }];
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
      set: vi.fn((value: unknown) => {
        updateSink.push({ table, value });
        return {
          where: vi.fn(async () => []),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => []),
    })),
    execute: vi.fn(async () => [{ '?column?': 1 }]),
  });

  const db = {
    ...createDbFacade(inserts, updates),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const stagedInserts: Array<{ table: unknown; value: unknown }> = [];
      const stagedUpdates: Array<{ table: unknown; value: unknown }> = [];
      const tx = createDbFacade(stagedInserts, stagedUpdates);
      const result = await callback(tx);
      inserts.push(...stagedInserts);
      updates.push(...stagedUpdates);
      return result;
    }),
    _setResult: vi.fn(),
    _reset: vi.fn(),
  };

  return { db, inserts, updates };
}

function createOpportunityScoreDb(
  workspaceId: string,
  options: { failEvidence?: boolean; existingOpportunity?: unknown } = {},
) {
  const existingOpportunity =
    options.existingOpportunity ??
    mockOpportunity({
      id: 'opp-1',
      workspaceId,
      title: 'Scorable Opp',
      description: 'Do not persist this description in score request evidence',
      status: 'discovered',
    });
  const inserts: Array<{ table: unknown; value: unknown }> = [];
  const updates: Array<{ table: unknown; value: unknown }> = [];

  const createDbFacade = (
    insertSink: Array<{ table: unknown; value: unknown }>,
    updateSink: Array<{ table: unknown; value: unknown }>,
  ) => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => (existingOpportunity ? [existingOpportunity] : [])),
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
              return [{ id: 'evidence-opportunity-score-1' }];
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
    delete: vi.fn(() => ({
      where: vi.fn(async () => []),
    })),
    execute: vi.fn(async () => [{ '?column?': 1 }]),
  });

  const db = {
    ...createDbFacade(inserts, updates),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const stagedInserts: Array<{ table: unknown; value: unknown }> = [];
      const stagedUpdates: Array<{ table: unknown; value: unknown }> = [];
      const tx = createDbFacade(stagedInserts, stagedUpdates);
      const result = await callback(tx);
      inserts.push(...stagedInserts);
      updates.push(...stagedUpdates);
      return result;
    }),
    _setResult: vi.fn(),
    _reset: vi.fn(),
  };

  return { db, inserts, updates };
}

describe('opportunityRoutes', () => {
  let deps: ReturnType<typeof createMockDeps>;
  let fetch: ReturnType<typeof testApp>['fetch'];
  const workspaceId = '00000000-0000-4000-8000-000000000001';
  const wsHeader = { 'X-Workspace-Id': workspaceId };

  beforeEach(() => {
    const t = testApp(opportunityRoutes);
    deps = t.deps as ReturnType<typeof createMockDeps>;
    fetch = t.fetch;
    deps.db._reset();
  });

  // ── GET / ──

  describe('GET /', () => {
    it('returns 400 when workspaceId is missing', async () => {
      const opps = [mockOpportunity(), mockOpportunity({ id: 'opp-2', title: 'Second' })];
      deps.db._setResult(opps);

      const res = await fetch('GET', '/');
      const json = await expectJson<{ error: string }>(res, 400);
      expect(json.error).toContain('workspaceId');
    });

    it('filters by workspaceId when provided', async () => {
      const opps = [mockOpportunity({ workspaceId: 'ws-42' })];
      deps.db._setResult(opps);

      const res = await fetch('GET', '/', undefined, { 'X-Workspace-Id': 'ws-42' });
      const json = await expectJson<unknown[]>(res, 200);

      expect(json).toHaveLength(1);
      expect(json[0]).toMatchObject({ workspaceId: 'ws-42' });
    });
  });

  // ── GET /:id ──

  describe('GET /:id', () => {
    it('returns opportunity with scores and tags', async () => {
      const opp = mockOpportunity();
      const scores = [{ id: 's-1', opportunityId: 'opp-1', dimension: 'market', score: 0.8 }];
      const tags = [{ id: 't-1', opportunityId: 'opp-1', tag: 'saas' }];

      // First query: opportunity lookup
      deps.db._setResult([opp]);

      // Override select to return different results on successive calls
      let selectCall = 0;
      const origSelect = deps.db.select;
      deps.db.select = vi.fn(() => {
        selectCall++;
        if (selectCall === 1) {
          deps.db._setResult([opp]);
        } else if (selectCall === 2) {
          deps.db._setResult(scores);
        } else {
          deps.db._setResult(tags);
        }
        return origSelect();
      }) as any;

      const res = await fetch('GET', '/opp-1', undefined, wsHeader);
      const json = await expectJson<Record<string, unknown>>(res, 200);

      expect(json.id).toBe('opp-1');
      expect(json.scores).toEqual(scores);
      expect(json.tags).toEqual(tags);
    });

    it('returns 404 when opportunity not found', async () => {
      deps.db._setResult([]);

      const res = await fetch('GET', '/nonexistent', undefined, wsHeader);
      const json = await expectJson<{ error: string }>(res, 404);

      expect(json.error).toBe('Not found');
    });
  });

  // ── POST / ──

  describe('POST /', () => {
    it('returns 400 on invalid body (missing source)', async () => {
      const res = await fetch(
        'POST',
        '/',
        {
          title: 'Test',
          description: 'Desc',
          // source is missing
        },
        wsHeader,
      );
      const json = await expectJson<{ error: string }>(res, 400);

      expect(json.error).toBe('Validation failed');
    });

    it('returns 403 when body workspaceId mismatches the bound workspace', async () => {
      const res = await fetch(
        'POST',
        '/',
        {
          workspaceId: '00000000-0000-4000-8000-000000000002',
          source: 'scraper',
          title: 'New Opp',
          description: 'A scraped opportunity',
        },
        wsHeader,
      );
      const json = await expectJson<{ error: string }>(res, 403);

      expect(json.error).toBe('workspaceId does not match authenticated workspace');
    });

    it('denies members from creating opportunities', async () => {
      const res = await fetch(
        'POST',
        '/',
        {
          source: 'scraper',
          title: 'New Opp',
          description: 'A scraped opportunity',
        },
        { ...wsHeader, 'X-Workspace-Role': 'member' },
      );
      const json = await expectJson<{ error: string; requiredRole: string }>(res, 403);

      expect(json.error).toBe('insufficient workspace role');
      expect(json.requiredRole).toBe('partner');
      expect(deps.db.insert).not.toHaveBeenCalled();
    });

    it('writes audit-linked evidence when creating an opportunity', async () => {
      const { db, inserts, updates } = createOpportunityCreateDb(workspaceId);
      const scoped = testApp(opportunityRoutes, createMockDeps({ db: db as never }));

      const res = await scoped.fetch(
        'POST',
        '/',
        {
          source: 'scraper',
          title: 'New Opp',
          description: 'A scraped opportunity',
          sourceUrl: 'https://example.com/opportunities/1',
        },
        wsHeader,
      );
      const json = await expectJson<Record<string, unknown>>(res, 201);

      expect(json.id).toBe('opp-1');
      expect(json.source).toBe('scraper');
      expect(json.evidenceItemId).toBe('evidence-opportunity-create-1');
      expect(inserts.map((insert) => insert.table)).toEqual([
        opportunities,
        auditLog,
        evidenceItems,
      ]);
      expect(inserts.find((insert) => insert.table === opportunities)?.value).toMatchObject({
        workspaceId,
        source: 'scraper',
        sourceUrl: 'https://example.com/opportunities/1',
        title: 'New Opp',
        description: 'A scraped opportunity',
        status: 'discovered',
      });
      const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
        id: string;
      };
      expect(auditInsert).toMatchObject({
        workspaceId,
        action: 'OPPORTUNITY_CREATED',
        actor: 'user:user-1',
        target: 'opp-1',
        verdict: 'allow',
        metadata: {
          evidenceType: 'opportunity_created',
          replayRef: `opportunity:${workspaceId}:opp-1:created`,
          opportunityId: 'opp-1',
          source: 'scraper',
          sourceUrlPresent: true,
          title: 'New Opp',
          descriptionLength: 21,
          status: 'discovered',
          evidenceContract: 'opportunity_create_evidence_required',
        },
      });
      const evidenceInsert = inserts.find((insert) => insert.table === evidenceItems)?.value as {
        metadata: Record<string, unknown>;
      };
      expect(evidenceInsert).toMatchObject({
        workspaceId,
        auditEventId: auditInsert.id,
        evidenceType: 'opportunity_created',
        sourceType: 'gateway_opportunity_route',
        redactionState: 'redacted',
        replayRef: `opportunity:${workspaceId}:opp-1:created`,
      });
      expect(evidenceInsert.metadata).not.toHaveProperty('description');
      expect(evidenceInsert.metadata).toMatchObject({
        opportunityId: 'opp-1',
        descriptionLength: 21,
        evidenceContract: 'opportunity_create_evidence_required',
      });
      expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
        metadata: {
          evidenceItemId: 'evidence-opportunity-create-1',
        },
      });
    });

    it('fails closed without committing opportunity rows when evidence persistence fails', async () => {
      const { db, inserts, updates } = createOpportunityCreateDb(workspaceId, {
        failEvidence: true,
      });
      const scoped = testApp(opportunityRoutes, createMockDeps({ db: db as never }));

      const res = await scoped.fetch(
        'POST',
        '/',
        {
          source: 'scraper',
          title: 'New Opp',
          description: 'A scraped opportunity',
        },
        wsHeader,
      );
      const json = await expectJson<{ error: string }>(res, 500);

      expect(json.error).toContain('Failed to persist opportunity evidence');
      expect(inserts).toEqual([]);
      expect(updates).toEqual([]);
    });
  });

  describe('POST /:id/score', () => {
    it('denies members from queueing opportunity scoring', async () => {
      const res = await fetch('POST', '/opp-1/score', undefined, {
        ...wsHeader,
        'X-Workspace-Role': 'member',
      });
      const json = await expectJson<{ error: string; requiredRole: string }>(res, 403);

      expect(json.error).toBe('insufficient workspace role');
      expect(json.requiredRole).toBe('partner');
      expect(deps.orchestrator.boss?.send).not.toHaveBeenCalled();
      expect(deps.db.update).not.toHaveBeenCalled();
    });

    it('does not mutate opportunity status when background jobs are unavailable', async () => {
      deps.orchestrator.boss = undefined as never;

      const res = await fetch('POST', '/opp-1/score', undefined, wsHeader);
      const json = await expectJson<{ error: string }>(res, 503);

      expect(json.error).toBe('Background job system unavailable');
      expect(deps.db.select).not.toHaveBeenCalled();
      expect(deps.db.update).not.toHaveBeenCalled();
    });

    it('writes audit-linked evidence before queueing opportunity scoring', async () => {
      const { db, inserts, updates } = createOpportunityScoreDb(workspaceId);
      const deps = createMockDeps({ db: db as never });
      deps.orchestrator.boss = {
        send: vi.fn(async () => 'job-score-1'),
      } as never;
      const scoped = testApp(opportunityRoutes, deps);

      const res = await scoped.fetch('POST', '/opp-1/score', undefined, wsHeader);
      const json = await expectJson<Record<string, unknown>>(res, 202);

      expect(json).toMatchObject({
        queued: true,
        opportunityId: 'opp-1',
        status: 'scoring',
        jobId: 'job-score-1',
        evidenceItemId: 'evidence-opportunity-score-1',
      });
      expect(deps.orchestrator.boss.send).toHaveBeenCalledWith('opportunity.score', {
        opportunityId: 'opp-1',
      });
      expect(inserts.map((insert) => insert.table)).toEqual([auditLog, evidenceItems]);
      expect(updates.map((update) => update.table)).toEqual([auditLog, opportunities, auditLog]);
      const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
        id: string;
      };
      expect(auditInsert).toMatchObject({
        workspaceId,
        action: 'OPPORTUNITY_SCORE_REQUESTED',
        actor: 'user:user-1',
        target: 'opp-1',
        verdict: 'allow',
        metadata: {
          evidenceType: 'opportunity_score_requested',
          replayRef: `opportunity:${workspaceId}:opp-1:score-requested`,
          queued: false,
          opportunityId: 'opp-1',
          previousStatus: 'discovered',
          requestedStatus: 'scoring',
          capabilityKey: 'opportunity_scoring',
          capabilityState: 'implemented',
          evidenceContract: 'opportunity_score_request_evidence_required',
        },
      });
      const evidenceInsert = inserts.find((insert) => insert.table === evidenceItems)?.value as {
        metadata: Record<string, unknown>;
      };
      expect(evidenceInsert).toMatchObject({
        workspaceId,
        auditEventId: auditInsert.id,
        evidenceType: 'opportunity_score_requested',
        sourceType: 'gateway_opportunity_route',
        redactionState: 'redacted',
        replayRef: `opportunity:${workspaceId}:opp-1:score-requested`,
      });
      expect(evidenceInsert.metadata).not.toHaveProperty('description');
      expect(evidenceInsert.metadata).toMatchObject({
        opportunityId: 'opp-1',
        previousStatus: 'discovered',
        evidenceContract: 'opportunity_score_request_evidence_required',
      });
      expect(updates.find((update) => update.table === opportunities)?.value).toEqual({
        status: 'scoring',
      });
      expect(updates.at(-1)?.value).toMatchObject({
        metadata: {
          queued: true,
          jobId: 'job-score-1',
          evidenceItemId: 'evidence-opportunity-score-1',
        },
      });
    });

    it('fails closed without queueing or status mutation when score request evidence fails', async () => {
      const { db, inserts, updates } = createOpportunityScoreDb(workspaceId, {
        failEvidence: true,
      });
      const deps = createMockDeps({ db: db as never });
      deps.orchestrator.boss = {
        send: vi.fn(async () => 'job-score-1'),
      } as never;
      const scoped = testApp(opportunityRoutes, deps);

      const res = await scoped.fetch('POST', '/opp-1/score', undefined, wsHeader);
      const json = await expectJson<{ error: string }>(res, 500);

      expect(json.error).toContain('Failed to persist opportunity scoring evidence');
      expect(deps.orchestrator.boss.send).not.toHaveBeenCalled();
      expect(inserts).toEqual([]);
      expect(updates).toEqual([]);
    });
  });
});
