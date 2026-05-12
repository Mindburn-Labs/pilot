import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { userErasureReceipts, users, workspaces } from '@pilot/db/schema';
import { userRoutes } from '../../routes/users.js';
import { createMockDeps } from '../helpers.js';

function mountWithAuth(userId: string | undefined, deps = createMockDeps()) {
  const app = new Hono();
  // Fake auth middleware that sets userId
  app.use('*', async (c, next) => {
    if (userId) c.set('userId' as never, userId as never);
    return next();
  });
  app.route('/', userRoutes(deps));
  return { app, deps };
}

function createUserErasureDb(options: { failReceipt?: boolean; selectResults?: unknown[][] } = {}) {
  const inserts: Array<{ table: unknown; value: Record<string, unknown> }> = [];
  const deletes: Array<{ table: unknown }> = [];
  let selectCall = 0;

  const db = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          then: (resolve: (value: unknown[]) => void) => {
            const result = options.selectResults?.[selectCall] ?? [];
            selectCall += 1;
            return Promise.resolve(result).then(resolve);
          },
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        if (table === userErasureReceipts && options.failReceipt) {
          throw new Error('erasure receipt unavailable');
        }
        inserts.push({ table, value });
        return Promise.resolve([]);
      }),
    })),
    delete: vi.fn((table: unknown) => {
      deletes.push({ table });
      return {
        where: vi.fn(async () => []),
      };
    }),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
    execute: vi.fn(async () => [{ '?column?': 1 }]),
    _setResult: vi.fn(),
    _reset: vi.fn(),
  };

  return { db, inserts, deletes };
}

describe('userRoutes: DELETE /me', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 if unauthenticated', async () => {
    const { app } = mountWithAuth(undefined);
    const res = await app.fetch(new Request('http://x/me', { method: 'DELETE' }));
    expect(res.status).toBe(401);
  });

  it('deletes the authenticated user', async () => {
    const { db, inserts, deletes } = createUserErasureDb();
    const { app } = mountWithAuth('user-123', createMockDeps({ db: db as never }));

    const res = await app.fetch(new Request('http://x/me', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
    expect(body.deletedWorkspaces).toBe(0);
    expect(body.erasureReceiptRef).toMatch(/^user-erasure:/);

    expect(inserts.map((insert) => insert.table)).toEqual([userErasureReceipts]);
    expect(inserts[0]?.value).toMatchObject({
      source: 'gateway_user',
      actor: 'self-service',
      deletedWorkspaceCount: 0,
      workspaceSetHash: null,
      replayRef: body.erasureReceiptRef,
      metadata: {
        retainedAfterUserDelete: true,
        rawSubjectStored: false,
        rawWorkspaceIdsStored: false,
      },
    });
    expect(JSON.stringify(inserts[0]?.value)).not.toContain('user-123');
    expect(deletes.map((entry) => entry.table)).toEqual([users]);
  });

  it('deletes solo workspaces the user owned', async () => {
    const { db, inserts, deletes } = createUserErasureDb({
      selectResults: [[{ workspaceId: 'workspace-solo' }], []],
    });
    const { app } = mountWithAuth('user-456', createMockDeps({ db: db as never }));

    const res = await app.fetch(new Request('http://x/me', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deletedWorkspaces).toBe(1);
    expect(inserts[0]?.value).toMatchObject({ deletedWorkspaceCount: 1 });
    expect(inserts[0]?.value.workspaceSetHash).toMatch(/^sha256:/);
    expect(JSON.stringify(inserts[0]?.value)).not.toContain('workspace-solo');
    expect(deletes.map((entry) => entry.table)).toEqual([workspaces, users]);
  });

  it('fails closed without deleting user or workspaces when receipt persistence fails', async () => {
    const { db, deletes } = createUserErasureDb({
      failReceipt: true,
      selectResults: [[{ workspaceId: 'workspace-solo' }], []],
    });
    const { app } = mountWithAuth('user-789', createMockDeps({ db: db as never }));

    const res = await app.fetch(new Request('http://x/me', { method: 'DELETE' }));

    expect(res.status).toBe(500);
    expect(deletes).toEqual([]);
  });
});
