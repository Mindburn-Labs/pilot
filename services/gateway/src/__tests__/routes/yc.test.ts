import { describe, it, expect, vi, beforeEach } from 'vitest';
import { auditLog, evidenceItems } from '@pilot/db/schema';
import { ycRoutes } from '../../routes/yc.js';
import { createMockDeps, expectJson, testApp } from '../helpers.js';

const mockYc = {
  searchCompanies: vi.fn(async () => []),
  getCompany: vi.fn(async () => null),
  listBatches: vi.fn(async () => []),
  searchAdvice: vi.fn(async () => []),
  getCompanyStats: vi.fn(async () => ({})),
  searchAdviceByTag: vi.fn(async () => []),
  getCourseModules: vi.fn(async () => []),
  getIngestionHistory: vi.fn(async () => []),
  getIngestionRecord: vi.fn(async () => null),
};

vi.mock('@pilot/yc-intel', () => ({
  YcIntelService: vi.fn().mockImplementation(() => mockYc),
}));

beforeEach(() => {
  Object.values(mockYc).forEach((fn) => fn.mockClear());
});

function createYcIngestionDb(options: { failEvidence?: boolean } = {}) {
  const inserts: Array<{ table: unknown; value: Record<string, unknown> }> = [];
  const updates: Array<{ table: unknown; value: unknown }> = [];

  const createDbFacade = (
    insertSink: Array<{ table: unknown; value: Record<string, unknown> }>,
    updateSink: Array<{ table: unknown; value: unknown }>,
  ) => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => []),
        })),
        orderBy: vi.fn(() => ({
          limit: vi.fn(async () => []),
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
              return [{ id: 'evidence-yc-ingestion-1' }];
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
      const stagedInserts: Array<{ table: unknown; value: Record<string, unknown> }> = [];
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

describe('ycRoutes', () => {
  // ─── GET /companies ───

  describe('GET /companies', () => {
    it('returns array with empty query', async () => {
      const { fetch } = testApp(ycRoutes);
      const res = await fetch('GET', '/companies');
      const json = await expectJson(res, 200);

      expect(mockYc.searchCompanies).toHaveBeenCalledWith('', 20);
      expect(json).toEqual([]);
    });

    it('returns matching companies', async () => {
      const companies = [
        { id: 'c-1', name: 'Stripe', batch: 'S09' },
        { id: 'c-2', name: 'Stripe Atlas', batch: 'W16' },
      ];
      mockYc.searchCompanies.mockResolvedValueOnce(companies);

      const { fetch } = testApp(ycRoutes);
      const res = await fetch('GET', '/companies?q=stripe&limit=5');
      const json = await expectJson(res, 200);

      expect(mockYc.searchCompanies).toHaveBeenCalledWith('stripe', 5);
      expect(json).toEqual(companies);
    });
  });

  // ─── GET /companies/:id ───

  describe('GET /companies/:id', () => {
    it('returns 404 when company not found', async () => {
      mockYc.getCompany.mockResolvedValueOnce(null);

      const { fetch } = testApp(ycRoutes);
      const res = await fetch('GET', '/companies/c-999');
      const json = await expectJson(res, 404);
      expect(json).toHaveProperty('error', 'Not found');
    });

    it('returns 200 when company found', async () => {
      const company = { id: 'c-1', name: 'Stripe', batch: 'S09', description: 'Payments' };
      mockYc.getCompany.mockResolvedValueOnce(company);

      const { fetch } = testApp(ycRoutes);
      const res = await fetch('GET', '/companies/c-1');
      const json = await expectJson(res, 200);
      expect(json).toEqual(company);
    });
  });

  // ─── GET /batches ───

  describe('GET /batches', () => {
    it('returns array of batches', async () => {
      const batches = [
        { id: 'b-1', name: 'S24', startDate: '2024-06-01' },
        { id: 'b-2', name: 'W25', startDate: '2025-01-01' },
      ];
      mockYc.listBatches.mockResolvedValueOnce(batches);

      const { fetch } = testApp(ycRoutes);
      const res = await fetch('GET', '/batches');
      const json = await expectJson(res, 200);

      expect(mockYc.listBatches).toHaveBeenCalled();
      expect(json).toEqual(batches);
    });
  });

  // ─── GET /advice ───

  describe('GET /advice', () => {
    it('returns array with empty query', async () => {
      const { fetch } = testApp(ycRoutes);
      const res = await fetch('GET', '/advice');
      const json = await expectJson(res, 200);

      expect(mockYc.searchAdvice).toHaveBeenCalledWith('', 20);
      expect(json).toEqual([]);
    });

    it('returns matching advice', async () => {
      const advice = [
        { id: 'a-1', topic: 'fundraising', content: 'Raise when you can, not when you need to.' },
      ];
      mockYc.searchAdvice.mockResolvedValueOnce(advice);

      const { fetch } = testApp(ycRoutes);
      const res = await fetch('GET', '/advice?q=fundraising&limit=10');
      const json = await expectJson(res, 200);

      expect(mockYc.searchAdvice).toHaveBeenCalledWith('fundraising', 10);
      expect(json).toEqual(advice);
    });
  });

  describe('POST /ingestion/public', () => {
    it('queues public ingestion jobs', async () => {
      const { db, inserts, updates } = createYcIngestionDb();
      const deps = createMockDeps({
        db: db as any,
        orchestrator: { boss: { send: vi.fn(async () => 'job-1') } } as any,
      });
      const { fetch } = testApp(ycRoutes, deps);

      const res = await fetch(
        'POST',
        '/ingestion/public',
        { source: 'all', limit: 25 },
        { 'X-Workspace-Id': 'ws-1' },
      );
      const json = await expectJson<{
        queued: boolean;
        evidenceItemId: string;
        jobs: Array<{ queue: string }>;
      }>(res, 202);

      expect(json.queued).toBe(true);
      expect(json.evidenceItemId).toBe('evidence-yc-ingestion-1');
      expect(json.jobs.map((job) => job.queue)).toEqual(['pipeline.yc-scrape', 'pipeline.startup-school']);
      expect(inserts.map(({ table }) => table)).toEqual([auditLog, evidenceItems]);
      expect(updates.map(({ table }) => table)).toEqual([auditLog, auditLog]);
      expect(inserts[0].value).toMatchObject({
        workspaceId: 'ws-1',
        action: 'YC_PUBLIC_INGESTION_REQUESTED',
        actor: 'user:user-1',
        verdict: 'allow',
      });
      expect(inserts[1].value).toMatchObject({
        workspaceId: 'ws-1',
        auditEventId: inserts[0].value['id'],
        evidenceType: 'yc_public_ingestion_requested',
        sourceType: 'gateway_yc_route',
        redactionState: 'redacted',
      });
      expect(deps.orchestrator.boss?.send).toHaveBeenCalledWith('pipeline.yc-scrape', {
        workspaceId: 'ws-1',
        batch: undefined,
        limit: 25,
        auditEventId: inserts[0].value['id'],
        evidenceItemId: 'evidence-yc-ingestion-1',
        replayRef: expect.stringContaining('yc-ingestion:ws-1:public:'),
      });
    });

    it('denies public ingestion for workspace members', async () => {
      const deps = createMockDeps();
      const { fetch } = testApp(ycRoutes, deps);

      const res = await fetch(
        'POST',
        '/ingestion/public',
        { source: 'companies' },
        { 'X-Workspace-Id': 'ws-1', 'X-Workspace-Role': 'member' },
      );
      const json = await expectJson<{ error: string; requiredRole: string }>(res, 403);

      expect(json).toMatchObject({ error: 'insufficient workspace role', requiredRole: 'partner' });
      expect(deps.orchestrator.boss?.send).not.toHaveBeenCalled();
    });

    it('does not queue public ingestion when evidence persistence fails', async () => {
      const { db, inserts, updates } = createYcIngestionDb({ failEvidence: true });
      const deps = createMockDeps({ db: db as any });
      const { fetch } = testApp(ycRoutes, deps);

      const res = await fetch(
        'POST',
        '/ingestion/public',
        { source: 'companies', limit: 10 },
        { 'X-Workspace-Id': 'ws-1' },
      );
      const json = await expectJson<{ error: string }>(res, 500);

      expect(json.error).toBe('Failed to persist YC public ingestion evidence');
      expect(inserts).toEqual([]);
      expect(updates).toEqual([]);
      expect(deps.orchestrator.boss?.send).not.toHaveBeenCalled();
    });
  });

  describe('POST /ingestion/private', () => {
    it('queues private yc sync job', async () => {
      const grantId = '00000000-0000-4000-8000-000000000001';
      const { db, inserts } = createYcIngestionDb();
      const deps = createMockDeps({
        db: db as any,
        connectors: {
          getGrantByWorkspaceConnector: vi.fn(async () => ({ id: grantId, workspaceId: 'ws-1' })),
        } as any,
      });
      const { fetch } = testApp(ycRoutes, deps);

      const res = await fetch(
        'POST',
        '/ingestion/private',
        { grantId, action: 'sync', limit: 5 },
        { 'X-Workspace-Id': 'ws-1' },
      );
      const json = await expectJson<{ queued: boolean; queue: string }>(res, 202);

      expect(json).toMatchObject({ queued: true, queue: 'pipeline.yc-private' });
      expect(deps.orchestrator.boss.send).toHaveBeenCalledWith('pipeline.yc-private', {
        workspaceId: 'ws-1',
        grantId,
        action: 'sync',
        limit: 5,
        auditEventId: inserts[0].value['id'],
        evidenceItemId: 'evidence-yc-ingestion-1',
        replayRef: expect.stringContaining('yc-ingestion:ws-1:private:'),
      });
    });

    it('requires owner role for private yc sync jobs', async () => {
      const grantId = '00000000-0000-4000-8000-000000000001';
      const deps = createMockDeps({
        connectors: {
          getGrantByWorkspaceConnector: vi.fn(async () => ({ id: grantId, workspaceId: 'ws-1' })),
        } as any,
      });
      const { fetch } = testApp(ycRoutes, deps);

      const res = await fetch(
        'POST',
        '/ingestion/private',
        { grantId, action: 'sync', limit: 5 },
        { 'X-Workspace-Id': 'ws-1', 'X-Workspace-Role': 'partner' },
      );
      const json = await expectJson<{ error: string; requiredRole: string }>(res, 403);

      expect(json).toMatchObject({ error: 'insufficient workspace role', requiredRole: 'owner' });
      expect(deps.connectors?.getGrantByWorkspaceConnector).not.toHaveBeenCalled();
      expect(deps.orchestrator.boss?.send).not.toHaveBeenCalled();
    });
  });

  describe('POST /ingestion/replay', () => {
    it('queues replay from an existing ingestion record', async () => {
      const ingestionRecordId = '00000000-0000-4000-8000-000000000002';
      mockYc.getIngestionRecord.mockResolvedValueOnce({
        id: ingestionRecordId,
        rawStoragePath: '/tmp/yc-companies.json',
      });
      const { db, inserts } = createYcIngestionDb();
      const deps = createMockDeps({ db: db as any });
      const { fetch } = testApp(ycRoutes, deps);

      const res = await fetch(
        'POST',
        '/ingestion/replay',
        { source: 'companies', ingestionRecordId },
        { 'X-Workspace-Id': 'ws-1' },
      );
      const json = await expectJson<{ queued: boolean; replayPath: string }>(res, 202);

      expect(json).toMatchObject({ queued: true, replayPath: '/tmp/yc-companies.json' });
      expect(deps.orchestrator.boss.send).toHaveBeenCalledWith('pipeline.yc-scrape', {
        workspaceId: 'ws-1',
        replayPath: '/tmp/yc-companies.json',
        auditEventId: inserts[0].value['id'],
        evidenceItemId: 'evidence-yc-ingestion-1',
        replayRef: expect.stringContaining('yc-ingestion:ws-1:replay:'),
      });
    });

    it('does not queue replay when evidence persistence fails', async () => {
      const ingestionRecordId = '00000000-0000-4000-8000-000000000002';
      mockYc.getIngestionRecord.mockResolvedValueOnce({
        id: ingestionRecordId,
        rawStoragePath: '/tmp/yc-companies.json',
      });
      const { db, inserts, updates } = createYcIngestionDb({ failEvidence: true });
      const deps = createMockDeps({ db: db as any });
      const { fetch } = testApp(ycRoutes, deps);

      const res = await fetch(
        'POST',
        '/ingestion/replay',
        { source: 'companies', ingestionRecordId },
        { 'X-Workspace-Id': 'ws-1' },
      );
      const json = await expectJson<{ error: string }>(res, 500);

      expect(json.error).toBe('Failed to persist YC replay evidence');
      expect(inserts).toEqual([]);
      expect(updates).toEqual([]);
      expect(deps.orchestrator.boss?.send).not.toHaveBeenCalled();
    });
  });
});
