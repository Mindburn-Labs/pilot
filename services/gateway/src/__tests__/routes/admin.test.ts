import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  auditLog,
  evidenceItems,
  opportunities,
  policyViolations,
  tenantDeletionReceipts,
  workspaceDeletions,
  workspaceMembers,
  workspaceSettings,
  workspaces,
} from '@pilot/db/schema';
import { adminRoutes } from '../../routes/admin.js';
import { testApp, createMockDeps, expectJson } from '../helpers.js';

const ADMIN_KEY = 'test-admin-key-0123456789abcdef';
const ownerUserId = '00000000-0000-4000-8000-000000000001';
const tenantWorkspaceId = '00000000-0000-4000-8000-000000000101';

function createTenantCreationDb(options: { failEvidence?: boolean; ownerExists?: boolean } = {}) {
  const inserts: Array<{ table: unknown; value: unknown }> = [];
  const updates: Array<{ table: unknown; value: unknown }> = [];

  const createDbFacade = (
    insertSink: Array<{ table: unknown; value: unknown }>,
    updateSink: Array<{ table: unknown; value: unknown }>,
  ) => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () =>
            options.ownerExists === false ? [] : [{ id: ownerUserId, name: 'Owner' }],
          ),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: unknown) => {
        insertSink.push({ table, value });
        return {
          returning: vi.fn(async () => {
            if (table === workspaces) {
              return [
                {
                  id: '00000000-0000-4000-8000-000000000101',
                  name: 'Acme',
                  ownerId: ownerUserId,
                },
              ];
            }
            if (table === evidenceItems) {
              if (options.failEvidence) throw new Error('evidence unavailable');
              return [{ id: 'evidence-admin-tenant-1' }];
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
      where: vi.fn(() => ({ returning: vi.fn(async () => []) })),
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

function createTenantLifecycleDb(
  options: {
    failEvidence?: boolean;
    failHardDeleteReceipt?: boolean;
    selectResults?: unknown[][];
    restoreRows?: unknown[];
  } = {},
) {
  const inserts: Array<{ table: unknown; value: unknown }> = [];
  const updates: Array<{ table: unknown; value: unknown }> = [];
  const deletes: Array<{ table: unknown }> = [];
  let selectCall = 0;

  const createDbFacade = (
    insertSink: Array<{ table: unknown; value: unknown }>,
    updateSink: Array<{ table: unknown; value: unknown }>,
    deleteSink: Array<{ table: unknown }>,
  ) => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => {
            const result = options.selectResults?.[selectCall] ?? [];
            selectCall += 1;
            return { then: (resolve: (value: unknown[]) => void) => resolve(result) };
          }),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: unknown) => {
        const isHardDeleteReceipt =
          typeof value === 'object' &&
          value !== null &&
          'replayRef' in value &&
          String((value as { replayRef?: unknown }).replayRef).startsWith('tenant-hard-delete:');
        if (isHardDeleteReceipt && options.failHardDeleteReceipt) {
          throw new Error('receipt unavailable');
        }
        insertSink.push({ table, value });
        return {
          returning: vi.fn(async () => {
            if (isHardDeleteReceipt) {
              return [{ id: 'tenant-delete-receipt-1' }];
            }
            if (table === evidenceItems) {
              if (options.failEvidence) throw new Error('evidence unavailable');
              return [{ id: 'evidence-admin-lifecycle-1' }];
            }
            if (table === tenantDeletionReceipts) {
              return [{ id: 'tenant-delete-receipt-1' }];
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
    delete: vi.fn((table: unknown) => {
      deleteSink.push({ table });
      return {
        where: vi.fn(() => ({
          returning: vi.fn(async () => options.restoreRows ?? []),
        })),
      };
    }),
    execute: vi.fn(async () => [{ '?column?': 1 }]),
  });

  const db = {
    ...createDbFacade(inserts, updates, deletes),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const stagedInserts: Array<{ table: unknown; value: unknown }> = [];
      const stagedUpdates: Array<{ table: unknown; value: unknown }> = [];
      const stagedDeletes: Array<{ table: unknown }> = [];
      const tx = createDbFacade(stagedInserts, stagedUpdates, stagedDeletes);
      const result = await callback(tx);
      inserts.push(...stagedInserts);
      updates.push(...stagedUpdates);
      deletes.push(...stagedDeletes);
      return result;
    }),
    _setResult: vi.fn(),
    _reset: vi.fn(),
  };

  return { db, inserts, updates, deletes };
}

describe('adminRoutes', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env['PILOT_ADMIN_API_KEY'];
    process.env['PILOT_ADMIN_API_KEY'] = ADMIN_KEY;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['PILOT_ADMIN_API_KEY'];
    else process.env['PILOT_ADMIN_API_KEY'] = originalEnv;
    vi.restoreAllMocks();
  });

  function authHeader() {
    return { Authorization: `Bearer ${ADMIN_KEY}` };
  }

  describe('auth gate', () => {
    it('returns 503 when PILOT_ADMIN_API_KEY is unset', async () => {
      delete process.env['PILOT_ADMIN_API_KEY'];
      const { fetch } = testApp(adminRoutes);
      const res = await fetch('GET', '/tenants/deletions');
      const body = await expectJson<{ error: string }>(res, 503);
      expect(body.error).toContain('disabled');
    });

    it('returns 403 when the Bearer token is missing', async () => {
      const { fetch } = testApp(adminRoutes);
      const res = await fetch('GET', '/tenants/deletions');
      await expectJson(res, 403);
    });

    it('returns 403 when the Bearer token is wrong', async () => {
      const { fetch } = testApp(adminRoutes);
      const res = await fetch('GET', '/tenants/deletions', undefined, {
        Authorization: 'Bearer wrong',
      });
      await expectJson(res, 403);
    });
  });

  describe('POST /tenants', () => {
    it('returns 400 when name is missing', async () => {
      const { fetch } = testApp(adminRoutes);
      const res = await fetch('POST', '/tenants', { ownerUserId }, authHeader());
      const body = await expectJson<{ error: string }>(res, 400);
      expect(body.error).toContain('name');
    });

    it('returns 400 when ownerUserId is missing', async () => {
      const { fetch } = testApp(adminRoutes);
      const res = await fetch('POST', '/tenants', { name: 'Acme' }, authHeader());
      const body = await expectJson<{ error: string }>(res, 400);
      expect(body.error).toContain('ownerUserId');
    });

    it('returns 404 when the owner user does not exist', async () => {
      const deps = createMockDeps();
      deps.db._setResult([]); // owner lookup returns nothing

      const { fetch } = testApp(adminRoutes, deps);
      const res = await fetch('POST', '/tenants', { name: 'Acme', ownerUserId }, authHeader());
      const body = await expectJson<{ error: string }>(res, 404);
      expect(body.error).toContain('ownerUserId');
    });

    it('writes audit-linked evidence when creating a tenant', async () => {
      const { db, inserts, updates } = createTenantCreationDb();
      const deps = createMockDeps({ db: db as never });
      const { fetch } = testApp(adminRoutes, deps);

      const res = await fetch('POST', '/tenants', { name: ' Acme ', ownerUserId }, authHeader());
      const body = await expectJson<{
        workspace: { id: string; name: string; ownerId: string };
        evidenceItemId: string;
      }>(res, 201);

      expect(body.workspace).toMatchObject({ name: 'Acme', ownerId: ownerUserId });
      expect(body.evidenceItemId).toBe('evidence-admin-tenant-1');
      expect(inserts.map((insert) => insert.table)).toEqual([
        workspaces,
        workspaceMembers,
        workspaceSettings,
        auditLog,
        evidenceItems,
      ]);
      expect(inserts.find((insert) => insert.table === workspaces)?.value).toEqual({
        name: 'Acme',
        ownerId: ownerUserId,
      });
      expect(inserts.find((insert) => insert.table === workspaceMembers)?.value).toEqual({
        workspaceId: body.workspace.id,
        userId: ownerUserId,
        role: 'owner',
      });
      const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
        id: string;
      };
      expect(auditInsert).toMatchObject({
        workspaceId: body.workspace.id,
        action: 'ADMIN_TENANT_CREATED',
        actor: 'platform-admin',
        target: body.workspace.id,
        verdict: 'allow',
        metadata: {
          evidenceType: 'admin_tenant_created',
          workspaceId: body.workspace.id,
          workspaceName: 'Acme',
          ownerUserId,
          adminCredentialStoredInEvidence: false,
        },
      });
      expect(inserts.find((insert) => insert.table === evidenceItems)?.value).toMatchObject({
        workspaceId: body.workspace.id,
        auditEventId: auditInsert.id,
        evidenceType: 'admin_tenant_created',
        sourceType: 'gateway_admin',
        redactionState: 'redacted',
        sensitivity: 'restricted',
        metadata: {
          workspaceId: body.workspace.id,
          workspaceName: 'Acme',
          ownerUserId,
          adminCredentialStoredInEvidence: false,
        },
      });
      expect(JSON.stringify(inserts.map((insert) => insert.value))).not.toContain(ADMIN_KEY);
      expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
        metadata: {
          evidenceItemId: 'evidence-admin-tenant-1',
        },
      });
    });

    it('fails closed without committing tenant rows when evidence persistence fails', async () => {
      const { db, inserts } = createTenantCreationDb({ failEvidence: true });
      const deps = createMockDeps({ db: db as never });
      const { fetch } = testApp(adminRoutes, deps);

      const res = await fetch('POST', '/tenants', { name: 'Acme', ownerUserId }, authHeader());
      const body = await expectJson<{ error: string }>(res, 500);

      expect(body.error).toContain('failed to persist tenant creation evidence');
      expect(inserts).toEqual([]);
    });
  });

  describe('DELETE /tenants/:id', () => {
    it('writes audit-linked evidence when soft-deleting a tenant', async () => {
      const hardDeleteAfterBefore = Date.now();
      const { db, inserts, updates } = createTenantLifecycleDb({
        selectResults: [[{ id: tenantWorkspaceId, name: 'Acme' }], []],
      });
      const deps = createMockDeps({ db: db as never });
      const { fetch } = testApp(adminRoutes, deps);

      const res = await fetch(
        'DELETE',
        `/tenants/${tenantWorkspaceId}`,
        { reason: 'founder requested', graceDays: 7 },
        authHeader(),
      );
      const body = await expectJson<{
        softDeleted: boolean;
        workspaceId: string;
        hardDeleteAfter: string;
        evidenceItemId: string;
      }>(res, 200);

      expect(body.softDeleted).toBe(true);
      expect(body.workspaceId).toBe(tenantWorkspaceId);
      expect(body.evidenceItemId).toBe('evidence-admin-lifecycle-1');
      expect(new Date(body.hardDeleteAfter).getTime()).toBeGreaterThan(hardDeleteAfterBefore);
      expect(inserts.map((insert) => insert.table)).toEqual([
        workspaceDeletions,
        auditLog,
        evidenceItems,
      ]);
      expect(inserts.find((insert) => insert.table === workspaceDeletions)?.value).toMatchObject({
        workspaceId: tenantWorkspaceId,
        reason: 'founder requested',
      });
      const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
        id: string;
      };
      expect(auditInsert).toMatchObject({
        workspaceId: tenantWorkspaceId,
        action: 'ADMIN_TENANT_SOFT_DELETED',
        actor: 'platform-admin',
        target: tenantWorkspaceId,
        verdict: 'allow',
        metadata: {
          evidenceType: 'admin_tenant_soft_deleted',
          workspaceId: tenantWorkspaceId,
          workspaceName: 'Acme',
          reason: 'founder requested',
          existingSoftDelete: false,
          adminCredentialStoredInEvidence: false,
        },
      });
      expect(inserts.find((insert) => insert.table === evidenceItems)?.value).toMatchObject({
        workspaceId: tenantWorkspaceId,
        auditEventId: auditInsert.id,
        evidenceType: 'admin_tenant_soft_deleted',
        sourceType: 'gateway_admin',
        redactionState: 'redacted',
        sensitivity: 'restricted',
        metadata: {
          workspaceId: tenantWorkspaceId,
          workspaceName: 'Acme',
          reason: 'founder requested',
          existingSoftDelete: false,
          adminCredentialStoredInEvidence: false,
        },
      });
      expect(JSON.stringify(inserts.map((insert) => insert.value))).not.toContain(ADMIN_KEY);
      expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
        metadata: {
          evidenceItemId: 'evidence-admin-lifecycle-1',
        },
      });
    });

    it('fails closed without committing soft-delete rows when evidence persistence fails', async () => {
      const { db, inserts } = createTenantLifecycleDb({
        failEvidence: true,
        selectResults: [[{ id: tenantWorkspaceId, name: 'Acme' }], []],
      });
      const deps = createMockDeps({ db: db as never });
      const { fetch } = testApp(adminRoutes, deps);

      const res = await fetch(
        'DELETE',
        `/tenants/${tenantWorkspaceId}`,
        { reason: 'founder requested' },
        authHeader(),
      );
      const body = await expectJson<{ error: string }>(res, 500);

      expect(body.error).toContain('failed to persist tenant soft-delete evidence');
      expect(inserts).toEqual([]);
    });
  });

  describe('POST /tenants/:id/restore', () => {
    it('returns 404 when the workspace is not soft-deleted', async () => {
      const { db } = createTenantLifecycleDb({ restoreRows: [] });
      const deps = createMockDeps({ db: db as never });

      const { fetch } = testApp(adminRoutes, deps);
      const res = await fetch(
        'POST',
        `/tenants/${tenantWorkspaceId}/restore`,
        undefined,
        authHeader(),
      );
      const body = await expectJson<{ error: string }>(res, 404);
      expect(body.error).toContain('not soft-deleted');
    });

    it('writes audit-linked evidence when restoring a tenant', async () => {
      const { db, inserts, updates, deletes } = createTenantLifecycleDb({
        restoreRows: [{ id: 'del-1', workspaceId: tenantWorkspaceId }],
      });
      const deps = createMockDeps({ db: db as never });

      const { fetch } = testApp(adminRoutes, deps);
      const res = await fetch(
        'POST',
        `/tenants/${tenantWorkspaceId}/restore`,
        undefined,
        authHeader(),
      );
      const body = await expectJson<{
        restored: boolean;
        workspaceId: string;
        evidenceItemId: string;
      }>(res, 200);

      expect(body).toMatchObject({
        restored: true,
        workspaceId: tenantWorkspaceId,
        evidenceItemId: 'evidence-admin-lifecycle-1',
      });
      expect(deletes).toEqual([{ table: workspaceDeletions }]);
      expect(inserts.map((insert) => insert.table)).toEqual([auditLog, evidenceItems]);
      const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
        id: string;
      };
      expect(auditInsert).toMatchObject({
        workspaceId: tenantWorkspaceId,
        action: 'ADMIN_TENANT_RESTORED',
        actor: 'platform-admin',
        target: tenantWorkspaceId,
        verdict: 'allow',
        metadata: {
          evidenceType: 'admin_tenant_restored',
          workspaceId: tenantWorkspaceId,
          restoredDeletionIds: ['del-1'],
          adminCredentialStoredInEvidence: false,
        },
      });
      expect(inserts.find((insert) => insert.table === evidenceItems)?.value).toMatchObject({
        workspaceId: tenantWorkspaceId,
        auditEventId: auditInsert.id,
        evidenceType: 'admin_tenant_restored',
        sourceType: 'gateway_admin',
        redactionState: 'redacted',
        sensitivity: 'restricted',
        metadata: {
          workspaceId: tenantWorkspaceId,
          restoredDeletionIds: ['del-1'],
          adminCredentialStoredInEvidence: false,
        },
      });
      expect(JSON.stringify(inserts.map((insert) => insert.value))).not.toContain(ADMIN_KEY);
      expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
        metadata: {
          evidenceItemId: 'evidence-admin-lifecycle-1',
        },
      });
    });

    it('fails closed without committing restore when evidence persistence fails', async () => {
      const { db, inserts, deletes } = createTenantLifecycleDb({
        failEvidence: true,
        restoreRows: [{ id: 'del-1', workspaceId: tenantWorkspaceId }],
      });
      const deps = createMockDeps({ db: db as never });
      const { fetch } = testApp(adminRoutes, deps);

      const res = await fetch(
        'POST',
        `/tenants/${tenantWorkspaceId}/restore`,
        undefined,
        authHeader(),
      );
      const body = await expectJson<{ error: string }>(res, 500);

      expect(body.error).toContain('failed to persist tenant restore evidence');
      expect(inserts).toEqual([]);
      expect(deletes).toEqual([]);
    });
  });

  describe('POST /tenants/cleanup', () => {
    it('returns hardDeleted count when sweep runs clean', async () => {
      const deps = createMockDeps();
      deps.db._setResult([]); // no rows past grace window

      const { fetch } = testApp(adminRoutes, deps);
      const res = await fetch('POST', '/tenants/cleanup', undefined, authHeader());
      const body = await expectJson<{
        hardDeleted: number;
        remaining: number;
        receiptIds: string[];
      }>(res, 200);
      expect(body).toEqual({ hardDeleted: 0, remaining: 0, receiptIds: [] });
    });

    it('clamps the limit to the [1, 500] range', async () => {
      const deps = createMockDeps();
      deps.db._setResult([]);

      const { fetch } = testApp(adminRoutes, deps);
      // Absurd limit should still return ok — the clamp protects the DB.
      const res = await fetch('POST', '/tenants/cleanup?limit=99999', undefined, authHeader());
      await expectJson(res, 200);
    });

    it('writes retained receipts before hard-deleting tenant rows', async () => {
      const { db, inserts, deletes } = createTenantLifecycleDb({
        selectResults: [
          [
            {
              id: '00000000-0000-4000-8000-000000000201',
              workspaceId: tenantWorkspaceId,
              reason: 'expired test tenant',
              softDeletedAt: new Date('2026-05-01T00:00:00Z'),
              hardDeleteAfter: new Date('2026-05-02T00:00:00Z'),
            },
          ],
        ],
      });
      const deps = createMockDeps({ db: db as never });

      const { fetch } = testApp(adminRoutes, deps);
      const res = await fetch('POST', '/tenants/cleanup', undefined, authHeader());
      const body = await expectJson<{
        hardDeleted: number;
        remaining: number;
        receiptIds: string[];
      }>(res, 200);

      expect(body).toEqual({
        hardDeleted: 1,
        remaining: 0,
        receiptIds: ['tenant-delete-receipt-1'],
      });
      expect(inserts.map((insert) => insert.table)).toEqual([tenantDeletionReceipts]);
      expect(inserts[0]?.value).toMatchObject({
        workspaceId: tenantWorkspaceId,
        deletionId: '00000000-0000-4000-8000-000000000201',
        source: 'gateway_admin',
        actor: 'platform-admin',
        reason: 'expired test tenant',
        replayRef: `tenant-hard-delete:${tenantWorkspaceId}:00000000-0000-4000-8000-000000000201:gateway-admin`,
        metadata: {
          trigger: 'manual_admin_cleanup',
          retainedAfterWorkspaceDelete: true,
          workspaceScopedLedgerRowsDeleted: true,
        },
      });
      expect(deletes.map((entry) => entry.table)).toEqual([
        auditLog,
        policyViolations,
        opportunities,
        workspaces,
      ]);
    });

    it('fails closed without deleting tenant rows when retained receipt persistence fails', async () => {
      const { db, inserts, deletes } = createTenantLifecycleDb({
        failHardDeleteReceipt: true,
        selectResults: [
          [
            {
              id: '00000000-0000-4000-8000-000000000201',
              workspaceId: tenantWorkspaceId,
              reason: 'expired test tenant',
              softDeletedAt: new Date('2026-05-01T00:00:00Z'),
              hardDeleteAfter: new Date('2026-05-02T00:00:00Z'),
            },
          ],
        ],
      });
      const deps = createMockDeps({ db: db as never });

      const { fetch } = testApp(adminRoutes, deps);
      const res = await fetch('POST', '/tenants/cleanup', undefined, authHeader());
      const body = await expectJson<{ error: string }>(res, 500);

      expect(body.error).toBe('failed to persist tenant hard-delete receipt');
      expect(inserts).toEqual([]);
      expect(deletes).toEqual([]);
    });
  });
});
