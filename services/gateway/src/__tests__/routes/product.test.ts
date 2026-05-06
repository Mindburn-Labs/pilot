import { describe, it, expect, vi, beforeEach } from 'vitest';
import { auditLog, evidenceItems, milestones, plans } from '@pilot/db/schema';
import { productRoutes } from '../../routes/product.js';
import { createMockDeps, testApp, expectJson } from '../helpers.js';

const mockFactory = {
  listPlans: vi.fn(async () => []),
  getPlan: vi.fn(async () => null),
  createPlan: vi.fn(async () => ({ id: 'plan-1', title: 'MVP', description: 'Build MVP' })),
  addMilestone: vi.fn(async () => ({ id: 'ms-1', title: 'Alpha', planId: 'plan-1' })),
  getWorkspaceSummary: vi.fn(async () => ({ plans: 0, milestones: 0, completedMilestones: 0 })),
};

vi.mock('@pilot/product-factory', () => ({
  ProductFactory: vi.fn().mockImplementation(() => mockFactory),
}));

beforeEach(() => {
  Object.values(mockFactory).forEach((fn) => fn.mockClear());
});

function createProductPlanDb(options: { failEvidence?: boolean } = {}) {
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
          orderBy: vi.fn(async () => []),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertSink.push({ table, value });
        return {
          returning: vi.fn(async () => {
            if (table === plans) {
              return [
                {
                  id: 'plan-1',
                  workspaceId: value['workspaceId'],
                  title: value['title'],
                  description: value['description'],
                  status: 'draft',
                },
              ];
            }
            if (table === evidenceItems) {
              if (options.failEvidence) throw new Error('evidence unavailable');
              return [{ id: 'evidence-product-plan-1' }];
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

function createProductMilestoneDb(
  options: {
    failEvidence?: boolean;
    plan?: unknown;
    existingMilestones?: Array<{ id: string }>;
  } = {},
) {
  const inserts: Array<{ table: unknown; value: unknown }> = [];
  const updates: Array<{ table: unknown; value: unknown }> = [];
  const plan =
    'plan' in options ? options.plan : { id: 'plan-1', workspaceId: 'ws-1', title: 'MVP' };
  const existingMilestones = options.existingMilestones ?? [{ id: 'ms-existing' }];

  const createDbFacade = (
    insertSink: Array<{ table: unknown; value: unknown }>,
    updateSink: Array<{ table: unknown; value: unknown }>,
  ) => ({
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          if (table === plans) {
            return {
              limit: vi.fn(async () => (plan ? [plan] : [])),
              orderBy: vi.fn(async () => []),
            };
          }
          if (table === milestones) {
            return Promise.resolve(existingMilestones);
          }
          return {
            limit: vi.fn(async () => []),
            orderBy: vi.fn(async () => []),
          };
        }),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertSink.push({ table, value });
        return {
          returning: vi.fn(async () => {
            if (table === milestones) {
              return [
                {
                  id: 'ms-1',
                  planId: value['planId'],
                  title: value['title'],
                  description: value['description'],
                  sortOrder: value['sortOrder'],
                },
              ];
            }
            if (table === evidenceItems) {
              if (options.failEvidence) throw new Error('evidence unavailable');
              return [{ id: 'evidence-product-milestone-1' }];
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

describe('productRoutes', () => {
  const wsHeader = { 'X-Workspace-Id': 'ws-1' };

  // ─── GET /plans ───

  describe('GET /plans', () => {
    it('returns 400 without workspaceId', async () => {
      const { fetch } = testApp(productRoutes);
      const res = await fetch('GET', '/plans');
      const json = await expectJson(res, 400);
      expect(json).toHaveProperty('error', 'workspaceId required');
    });

    it('returns list of plans', async () => {
      const plans = [{ id: 'plan-1', title: 'MVP' }];
      mockFactory.listPlans.mockResolvedValueOnce(plans);

      const { fetch } = testApp(productRoutes);
      const res = await fetch('GET', '/plans', undefined, wsHeader);
      const json = await expectJson(res, 200);

      expect(mockFactory.listPlans).toHaveBeenCalledWith('ws-1');
      expect(json).toEqual(plans);
    });
  });

  // ─── GET /plans/:id ───

  describe('GET /plans/:id', () => {
    it('returns 404 when plan not found', async () => {
      mockFactory.getPlan.mockResolvedValueOnce(null);

      const { fetch } = testApp(productRoutes);
      const res = await fetch('GET', '/plans/plan-999', undefined, wsHeader);
      const json = await expectJson(res, 404);
      expect(json).toHaveProperty('error', 'Not found');
    });

    it('returns 200 when plan found', async () => {
      const plan = { id: 'plan-1', workspaceId: 'ws-1', title: 'MVP', description: 'Build MVP' };
      mockFactory.getPlan.mockResolvedValueOnce(plan);

      const { fetch } = testApp(productRoutes);
      const res = await fetch('GET', '/plans/plan-1', undefined, wsHeader);
      const json = await expectJson(res, 200);
      expect(json).toEqual(plan);
    });
  });

  // ─── POST /plans ───

  describe('POST /plans', () => {
    it('returns 400 without workspaceId', async () => {
      const { fetch } = testApp(productRoutes);
      const res = await fetch('POST', '/plans', { title: 'MVP', description: 'Build it' });
      const json = await expectJson(res, 400);
      expect(json).toHaveProperty('error', 'workspaceId required');
    });

    it('returns 400 when title is invalid', async () => {
      const { fetch } = testApp(productRoutes);
      const res = await fetch('POST', '/plans', { title: '' }, wsHeader);
      const json = await expectJson<{ error: string }>(res, 400);
      expect(json.error).toContain('title');
      expect(mockFactory.createPlan).not.toHaveBeenCalled();
    });

    it('denies members from creating product plans', async () => {
      const { fetch } = testApp(productRoutes);
      const res = await fetch(
        'POST',
        '/plans',
        { title: 'MVP' },
        { ...wsHeader, 'X-Workspace-Role': 'member' },
      );
      const json = await expectJson<{ error: string; requiredRole: string }>(res, 403);
      expect(json.error).toBe('insufficient workspace role');
      expect(json.requiredRole).toBe('partner');
      expect(mockFactory.createPlan).not.toHaveBeenCalled();
    });

    it('writes audit-linked evidence on success', async () => {
      const { db, inserts, updates } = createProductPlanDb();
      const deps = createMockDeps({ db: db as never });
      const { fetch } = testApp(productRoutes, deps);
      const res = await fetch(
        'POST',
        '/plans',
        {
          title: 'MVP',
          description: 'Build MVP',
        },
        wsHeader,
      );
      const json = await expectJson<{
        id: string;
        workspaceId: string;
        title: string;
        description: string;
        evidenceItemId: string;
      }>(res, 201);

      expect(mockFactory.createPlan).not.toHaveBeenCalled();
      expect(json).toMatchObject({
        id: 'plan-1',
        workspaceId: 'ws-1',
        title: 'MVP',
        description: 'Build MVP',
        evidenceItemId: 'evidence-product-plan-1',
      });
      expect(inserts.map((insert) => insert.table)).toEqual([plans, auditLog, evidenceItems]);
      expect(inserts.find((insert) => insert.table === plans)?.value).toEqual({
        workspaceId: 'ws-1',
        title: 'MVP',
        description: 'Build MVP',
      });
      const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
        id: string;
      };
      expect(auditInsert).toMatchObject({
        workspaceId: 'ws-1',
        action: 'PRODUCT_PLAN_CREATED',
        actor: 'user:user-1',
        target: 'plan-1',
        verdict: 'allow',
        metadata: {
          evidenceType: 'product_plan_created',
          planId: 'plan-1',
          title: 'MVP',
          descriptionPresent: true,
        },
      });
      expect(inserts.find((insert) => insert.table === evidenceItems)?.value).toMatchObject({
        workspaceId: 'ws-1',
        auditEventId: auditInsert.id,
        evidenceType: 'product_plan_created',
        sourceType: 'gateway_product',
        redactionState: 'none',
        sensitivity: 'internal',
        metadata: {
          planId: 'plan-1',
          title: 'MVP',
          descriptionPresent: true,
        },
      });
      expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
        metadata: {
          evidenceItemId: 'evidence-product-plan-1',
        },
      });
    });

    it('fails closed without committing plan rows when evidence persistence fails', async () => {
      const { db, inserts } = createProductPlanDb({ failEvidence: true });
      const deps = createMockDeps({ db: db as never });
      const { fetch } = testApp(productRoutes, deps);
      const res = await fetch('POST', '/plans', { title: 'MVP' }, wsHeader);
      const json = await expectJson<{ error: string }>(res, 500);

      expect(json.error).toContain('failed to persist product plan evidence');
      expect(inserts).toEqual([]);
    });
  });

  // ─── POST /plans/:id/milestones ───

  describe('POST /plans/:id/milestones', () => {
    it('denies members from creating product milestones', async () => {
      const { fetch, deps } = testApp(productRoutes);
      const res = await fetch(
        'POST',
        '/plans/plan-1/milestones',
        {
          title: 'Alpha',
        },
        { ...wsHeader, 'X-Workspace-Role': 'member' },
      );
      const json = await expectJson<{ error: string; requiredRole: string }>(res, 403);

      expect(json.error).toBe('insufficient workspace role');
      expect(json.requiredRole).toBe('partner');
      expect(deps.db.select).not.toHaveBeenCalled();
    });

    it('returns 404 when the plan is outside the workspace', async () => {
      const { db } = createProductMilestoneDb({ plan: null });
      const { fetch } = testApp(productRoutes, createMockDeps({ db: db as never }));

      const res = await fetch('POST', '/plans/plan-1/milestones', { title: 'Alpha' }, wsHeader);
      const json = await expectJson<{ error: string }>(res, 404);

      expect(json.error).toBe('Not found');
    });

    it('writes audit-linked evidence on success', async () => {
      const { db, inserts, updates } = createProductMilestoneDb();
      const deps = createMockDeps({ db: db as never });
      const { fetch } = testApp(productRoutes, deps);

      const res = await fetch(
        'POST',
        '/plans/plan-1/milestones',
        {
          title: 'Alpha',
          description: 'First alpha release',
        },
        wsHeader,
      );
      const json = await expectJson<{
        id: string;
        planId: string;
        title: string;
        description: string;
        sortOrder: number;
        evidenceItemId: string;
      }>(res, 201);

      expect(mockFactory.addMilestone).not.toHaveBeenCalled();
      expect(json).toMatchObject({
        id: 'ms-1',
        planId: 'plan-1',
        title: 'Alpha',
        description: 'First alpha release',
        sortOrder: 1,
        evidenceItemId: 'evidence-product-milestone-1',
      });
      expect(inserts.map((insert) => insert.table)).toEqual([milestones, auditLog, evidenceItems]);
      expect(inserts.find((insert) => insert.table === milestones)?.value).toEqual({
        planId: 'plan-1',
        title: 'Alpha',
        description: 'First alpha release',
        sortOrder: 1,
      });
      const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
        id: string;
      };
      expect(auditInsert).toMatchObject({
        workspaceId: 'ws-1',
        action: 'PRODUCT_MILESTONE_CREATED',
        actor: 'user:user-1',
        target: 'ms-1',
        verdict: 'allow',
        metadata: {
          evidenceType: 'product_milestone_created',
          planId: 'plan-1',
          milestoneId: 'ms-1',
          title: 'Alpha',
          descriptionPresent: true,
          sortOrder: 1,
          evidenceContract: 'product_milestone_create_evidence_required',
        },
      });
      expect(inserts.find((insert) => insert.table === evidenceItems)?.value).toMatchObject({
        workspaceId: 'ws-1',
        auditEventId: auditInsert.id,
        evidenceType: 'product_milestone_created',
        sourceType: 'gateway_product',
        redactionState: 'none',
        sensitivity: 'internal',
        metadata: {
          planId: 'plan-1',
          milestoneId: 'ms-1',
          title: 'Alpha',
          descriptionPresent: true,
          sortOrder: 1,
        },
      });
      expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
        metadata: {
          evidenceItemId: 'evidence-product-milestone-1',
        },
      });
    });

    it('fails closed without committing milestone rows when evidence persistence fails', async () => {
      const { db, inserts, updates } = createProductMilestoneDb({ failEvidence: true });
      const deps = createMockDeps({ db: db as never });
      const { fetch } = testApp(productRoutes, deps);

      const res = await fetch(
        'POST',
        '/plans/plan-1/milestones',
        {
          title: 'Alpha',
          description: 'First alpha release',
        },
        wsHeader,
      );
      const json = await expectJson<{ error: string }>(res, 500);

      expect(json.error).toContain('failed to persist product milestone evidence');
      expect(inserts).toEqual([]);
      expect(updates).toEqual([]);
    });
  });

  // ─── GET /summary ───

  describe('GET /summary', () => {
    it('returns 400 without workspaceId', async () => {
      const { fetch } = testApp(productRoutes);
      const res = await fetch('GET', '/summary');
      const json = await expectJson(res, 400);
      expect(json).toHaveProperty('error', 'workspaceId required');
    });

    it('returns workspace summary', async () => {
      const summary = { plans: 3, milestones: 12, completedMilestones: 5 };
      mockFactory.getWorkspaceSummary.mockResolvedValueOnce(summary);

      const { fetch } = testApp(productRoutes);
      const res = await fetch('GET', '/summary', undefined, wsHeader);
      const json = await expectJson(res, 200);

      expect(mockFactory.getWorkspaceSummary).toHaveBeenCalledWith('ws-1');
      expect(json).toEqual(summary);
    });
  });
});
