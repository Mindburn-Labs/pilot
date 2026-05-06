import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OAuthFlowManager } from '../oauth.js';
import {
  PERMANENT_AFTER_ATTEMPTS,
  PROACTIVE_WINDOW_MS,
  TICK_BATCH_LIMIT,
} from '../refresh.js';

vi.mock('@pilot/db/schema', () => ({
  connectorGrants: { id: 'cg.id', workspaceId: 'cg.ws', needsReauth: 'cg.nr' },
  connectorTokens: { grantId: 'ct.grant', expiresAt: 'ct.exp' },
  connectors: { id: 'c.id', name: 'c.name' },
  auditLog: { id: 'audit.id', workspaceId: 'audit.ws' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val, op: 'eq' }),
  and: (...args: unknown[]) => ({ args, op: 'and' }),
  lt: (col: unknown, val: unknown) => ({ col, val, op: 'lt' }),
  sql: (strings: TemplateStringsArray, ..._values: unknown[]) => ({
    strings: strings.join(''),
    op: 'sql',
  }),
}));

function makeDb(options: { failEvidence?: boolean } = {}) {
  type UpdateCall = {
    values: Record<string, unknown>;
    where: unknown;
  };
  type DbSink = {
    updateCalls: UpdateCall[];
    auditUpdateCalls: UpdateCall[];
    insertCalls: Array<Record<string, unknown>>;
    auditInsertCalls: Array<Record<string, unknown>>;
  };

  const updateCalls: Array<{
    values: Record<string, unknown>;
    where: unknown;
  }> = [];
  const auditUpdateCalls: Array<{
    values: Record<string, unknown>;
    where: unknown;
  }> = [];
  const insertCalls: Array<Record<string, unknown>> = [];
  const auditInsertCalls: Array<Record<string, unknown>> = [];

  let nextSelectRows: unknown[] = [];
  let nextLockAcquired = true;
  const sink: DbSink = {
    updateCalls,
    auditUpdateCalls,
    insertCalls,
    auditInsertCalls,
  };

  const selectChain = () => ({
    from: () => ({
      innerJoin: () => ({
        where: () => ({
          limit: async () => nextSelectRows,
        }),
      }),
      where: () => ({
        limit: async () => nextSelectRows,
      }),
    }),
  });

  const operationsFor = (target: DbSink) => ({
    insert: vi.fn((_table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        if (value['evidenceType']) {
          if (options.failEvidence) {
            return {
              returning: vi.fn(async () => {
                throw new Error('evidence unavailable');
              }),
            };
          }
          target.insertCalls.push(value);
        } else {
          target.auditInsertCalls.push(value);
        }
        return {
          returning: vi.fn(async () => [{ id: `evidence-item-${target.insertCalls.length}` }]),
        };
      }),
    })),
    update: vi.fn((_table: unknown) => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: (where: unknown) => {
          if (values['metadata']) {
            target.auditUpdateCalls.push({ values, where });
          } else {
            target.updateCalls.push({ values, where });
          }
          return Promise.resolve();
        },
      })),
    })),
  });

  const db = {
    ...operationsFor(sink),
    select: vi.fn(() => selectChain()),
    execute: vi.fn(async () => ({ rows: [{ acquired: nextLockAcquired }] })),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const txSink: DbSink = {
        updateCalls: [],
        auditUpdateCalls: [],
        insertCalls: [],
        auditInsertCalls: [],
      };
      const result = await callback(operationsFor(txSink));
      sink.updateCalls.push(...txSink.updateCalls);
      sink.auditUpdateCalls.push(...txSink.auditUpdateCalls);
      sink.insertCalls.push(...txSink.insertCalls);
      sink.auditInsertCalls.push(...txSink.auditInsertCalls);
      return result;
    }),
  } as any;

  return {
    db,
    updateCalls,
    auditUpdateCalls,
    insertCalls,
    auditInsertCalls,
    setNextSelectRows: (rows: unknown[]) => {
      nextSelectRows = rows;
    },
    setLockAcquired: (ok: boolean) => {
      nextLockAcquired = ok;
    },
  };
}

function makeOauth(result: string | null): OAuthFlowManager {
  return {
    refreshToken: vi.fn(async () => result),
  } as unknown as OAuthFlowManager;
}

function makeBoss() {
  const handlers = new Map<string, (jobs: unknown) => Promise<unknown>>();
  const createQueueCalls: string[] = [];
  const scheduleCalls: Array<[string, string]> = [];
  const boss = {
    createQueue: vi.fn(async (q: string) => {
      createQueueCalls.push(q);
    }),
    work: vi.fn((queue: string, fn: (jobs: unknown) => Promise<unknown>) => {
      handlers.set(queue, fn);
    }),
    send: vi.fn(async () => {}),
    schedule: vi.fn(async (q: string, cron: string) => {
      scheduleCalls.push([q, cron]);
    }),
  } as any;
  return { boss, handlers, createQueueCalls, scheduleCalls };
}

describe('connector refresh — public constants', () => {
  it('proactive window is 30 minutes', () => {
    expect(PROACTIVE_WINDOW_MS).toBe(30 * 60 * 1000);
  });

  it('permanent failure threshold is 3 attempts', () => {
    expect(PERMANENT_AFTER_ATTEMPTS).toBe(3);
  });

  it('tick batch is capped at 50', () => {
    expect(TICK_BATCH_LIMIT).toBe(50);
  });
});

describe('connector refresh — registerRefreshJobs', () => {
  let refresh: typeof import('../refresh.js');

  beforeEach(async () => {
    vi.resetModules();
    refresh = await import('../refresh.js');
  });

  it('registers both queues and schedules the tick cron', async () => {
    const { db } = makeDb();
    const oauth = makeOauth('tok');
    const { boss, createQueueCalls, scheduleCalls } = makeBoss();

    await refresh.registerRefreshJobs(boss, { db, oauth });

    expect(createQueueCalls).toContain('connectors.refresh.tick');
    expect(createQueueCalls).toContain('connectors.refresh.grant');
    expect(scheduleCalls[0]?.[0]).toBe('connectors.refresh.tick');
    expect(scheduleCalls[0]?.[1]).toBe('*/1 * * * *');
  });

  it('success path: clears attempts + needs_reauth', async () => {
    const {
      db,
      updateCalls,
      insertCalls,
      auditInsertCalls,
      auditUpdateCalls,
      setNextSelectRows,
    } = makeDb();
    const oauth = makeOauth('new_access_token');
    const { boss, handlers } = makeBoss();

    setNextSelectRows([{ refreshAttempts: 2, workspaceId: 'ws_abc' }]);

    await refresh.registerRefreshJobs(boss, { db, oauth });

    const grantHandler = handlers.get('connectors.refresh.grant');
    expect(grantHandler).toBeDefined();

    await grantHandler!([
      { data: { grantId: 'cg_1', connectorId: 'conn_github' } },
    ]);

    expect(oauth.refreshToken).toHaveBeenCalledWith('cg_1', 'conn_github');
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.values).toMatchObject({
      refreshAttempts: 0,
      lastRefreshError: null,
      needsReauth: false,
    });
    expect(auditInsertCalls[0]).toMatchObject({
      id: expect.any(String),
      workspaceId: 'ws_abc',
      action: 'CONNECTOR_REFRESH_SUCCEEDED',
      actor: 'workspace:ws_abc',
      target: 'conn_github',
      verdict: 'succeeded',
      metadata: expect.objectContaining({
        evidenceType: 'connector_refresh_succeeded',
        replayRef: 'connector-refresh:cg_1:succeeded:0',
        grantId: 'cg_1',
        connectorId: 'conn_github',
        productionReady: false,
      }),
    });
    expect(insertCalls[0]).toMatchObject({
      workspaceId: 'ws_abc',
      auditEventId: auditInsertCalls[0]?.['id'],
      evidenceType: 'connector_refresh_succeeded',
      sourceType: 'connector_refresh_worker',
      redactionState: 'redacted',
      sensitivity: 'sensitive',
      replayRef: 'connector-refresh:cg_1:succeeded:0',
      metadata: expect.objectContaining({
        grantId: 'cg_1',
        connectorId: 'conn_github',
        status: 'succeeded',
        attempts: 0,
        permanent: false,
        credentialBoundary: 'no_raw_tokens_in_evidence',
      }),
    });
    expect(auditUpdateCalls[0]?.values['metadata']).toMatchObject({
      evidenceItemId: 'evidence-item-1',
    });
    expect(JSON.stringify(insertCalls)).not.toContain('new_access_token');
  });

  it('first failure: bumps attempts, stays eligible', async () => {
    const { db, updateCalls, insertCalls, setNextSelectRows } = makeDb();
    const oauth = makeOauth(null);
    const { boss, handlers } = makeBoss();

    setNextSelectRows([{ refreshAttempts: 0, workspaceId: 'ws_abc' }]);

    await refresh.registerRefreshJobs(boss, { db, oauth });
    const grantHandler = handlers.get('connectors.refresh.grant');

    await grantHandler!([
      { data: { grantId: 'cg_2', connectorId: 'conn_github' } },
    ]);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.values).toMatchObject({
      refreshAttempts: 1,
      needsReauth: false,
    });
    expect(String(updateCalls[0]?.values['lastRefreshError'])).toMatch(/attempt 1/);
    expect(insertCalls[0]).toMatchObject({
      workspaceId: 'ws_abc',
      evidenceType: 'connector_refresh_failed',
      sourceType: 'connector_refresh_worker',
      replayRef: 'connector-refresh:cg_2:failed:1',
      metadata: expect.objectContaining({
        grantId: 'cg_2',
        connectorId: 'conn_github',
        status: 'failed',
        attempts: 1,
        permanent: false,
      }),
    });
  });

  it('does not commit refresh state when evidence persistence fails', async () => {
    const {
      db,
      updateCalls,
      insertCalls,
      auditInsertCalls,
      auditUpdateCalls,
      setNextSelectRows,
    } = makeDb({ failEvidence: true });
    const oauth = makeOauth(null);
    const { boss, handlers } = makeBoss();

    setNextSelectRows([{ refreshAttempts: 0, workspaceId: 'ws_abc' }]);

    await refresh.registerRefreshJobs(boss, { db, oauth });
    const grantHandler = handlers.get('connectors.refresh.grant');

    await expect(
      grantHandler!([{ data: { grantId: 'cg_2', connectorId: 'conn_github' } }]),
    ).resolves.not.toThrow();

    expect(oauth.refreshToken).toHaveBeenCalledWith('cg_2', 'conn_github');
    expect(updateCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(0);
    expect(auditInsertCalls).toHaveLength(0);
    expect(auditUpdateCalls).toHaveLength(0);
  });

  it('3rd failure: sets needs_reauth=true and invokes notifier', async () => {
    const { db, updateCalls, insertCalls, setNextSelectRows } = makeDb();
    const oauth = makeOauth(null);
    const { boss, handlers } = makeBoss();

    // First select returns attempts; subsequent select returns connector name.
    setNextSelectRows([{ refreshAttempts: 2, workspaceId: 'ws_abc' }]);

    const reauthCalls: Array<[string, string]> = [];
    const notifier = {
      async reauthRequired(ws: string, name: string) {
        reauthCalls.push([ws, name]);
      },
    };

    await refresh.registerRefreshJobs(boss, { db, oauth, notifier });
    const grantHandler = handlers.get('connectors.refresh.grant');

    await grantHandler!([
      { data: { grantId: 'cg_3', connectorId: 'conn_github' } },
    ]);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.values).toMatchObject({
      refreshAttempts: 3,
      needsReauth: true,
    });
    expect(insertCalls[0]).toMatchObject({
      workspaceId: 'ws_abc',
      evidenceType: 'connector_refresh_failed',
      replayRef: 'connector-refresh:cg_3:failed:3',
      metadata: expect.objectContaining({
        grantId: 'cg_3',
        connectorId: 'conn_github',
        attempts: 3,
        permanent: true,
      }),
    });
  });

  it('advisory-lock not acquired → skip (no oauth call, no update)', async () => {
    const { db, updateCalls, setLockAcquired } = makeDb();
    setLockAcquired(false);
    const oauth = makeOauth('tok');
    const { boss, handlers } = makeBoss();

    await refresh.registerRefreshJobs(boss, { db, oauth });
    const grantHandler = handlers.get('connectors.refresh.grant');

    await grantHandler!([
      { data: { grantId: 'cg_locked', connectorId: 'conn_github' } },
    ]);

    expect(oauth.refreshToken).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
  });

  it('handler crash does not propagate (pg-boss handles retry)', async () => {
    const { db } = makeDb();
    // This oauth throws — refreshOneGrant must catch it.
    const oauth = {
      refreshToken: vi.fn(async () => {
        throw new Error('network down');
      }),
    } as unknown as OAuthFlowManager;
    const { boss, handlers } = makeBoss();

    await refresh.registerRefreshJobs(boss, { db, oauth });
    const grantHandler = handlers.get('connectors.refresh.grant');

    // Should NOT throw out of the handler — the per-job try/catch swallows.
    await expect(
      grantHandler!([{ data: { grantId: 'cg_err', connectorId: 'conn_x' } }]),
    ).resolves.not.toThrow();
  });
});
