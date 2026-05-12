import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createHmac } from 'node:crypto';
import {
  apiKeys,
  auditLog,
  evidenceItems,
  sessions,
  users,
  workspaceMembers,
  workspaces,
} from '@pilot/db/schema';
import { authenticatedAuthRoutes, authRoutes } from '../../routes/auth.js';
import { createGateway } from '../../index.js';
import { requireAuth } from '../../middleware/auth.js';
import {
  createMockDeps,
  testApp,
  expectJson,
  mockUser,
  mockSession,
  mockMembership,
  mockWorkspace,
} from '../helpers.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';

function createApiKeyDb(options: { failEvidence?: boolean; selectResults?: unknown[][] } = {}) {
  const inserts: Array<{ table: unknown; value: unknown }> = [];
  const updates: Array<{ table: unknown; value: unknown }> = [];
  let selectCall = 0;

  const createDbFacade = (
    insertSink: Array<{ table: unknown; value: unknown }>,
    updateSink: Array<{ table: unknown; value: unknown }>,
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
        insertSink.push({ table, value });
        return {
          returning: vi.fn(async () => {
            if (table === evidenceItems) {
              if (options.failEvidence) throw new Error('evidence unavailable');
              return [{ id: 'evidence-api-key-1' }];
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

function createInviteAcceptDb(
  options: { failEvidence?: boolean; userExists?: boolean; expiresAt?: Date } = {},
) {
  const inserts: Array<{ table: unknown; value: unknown }> = [];
  const updates: Array<{ table: unknown; value: unknown }> = [];
  const deletes: Array<{ table: unknown }> = [];
  const inviteSession = {
    id: 'invite-session-1',
    userId: 'inviter-1',
    token: `invite:${workspaceId}:partner:opaque-token`,
    channel: 'invite',
    expiresAt: options.expiresAt ?? new Date(Date.now() + 60_000),
  };
  const existingUser =
    options.userExists === false
      ? null
      : mockUser({ id: 'user-invitee-1', email: 'invitee@example.com', name: 'Invitee' });

  const createDbFacade = (
    insertSink: Array<{ table: unknown; value: unknown }>,
    updateSink: Array<{ table: unknown; value: unknown }>,
    deleteSink: Array<{ table: unknown }>,
  ) => ({
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            if (table === sessions) return [inviteSession];
            if (table === users) return existingUser ? [existingUser] : [];
            return [];
          }),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertSink.push({ table, value });
        return {
          returning: vi.fn(async () => {
            if (table === users) {
              return [
                {
                  id: 'user-invitee-created',
                  email: value['email'],
                  name: value['name'],
                },
              ];
            }
            if (table === evidenceItems) {
              if (options.failEvidence) throw new Error('invite evidence unavailable');
              return [{ id: 'evidence-invite-accepted-1' }];
            }
            return [];
          }),
          onConflictDoNothing: vi.fn(async () => []),
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
        where: vi.fn(async () => []),
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

function createEmailVerifyDb(
  options: {
    failEvidence?: boolean;
    magicToken?: string;
    code?: string;
    existingMembership?: boolean;
  } = {},
) {
  const inserts: Array<{ table: unknown; value: unknown }> = [];
  const updates: Array<{ table: unknown; value: unknown }> = [];
  const deletes: Array<{ table: unknown }> = [];
  const user = mockUser({ id: 'user-email-1', email: 'test@example.com', name: 'Test' });
  const workspace = mockWorkspace({ id: workspaceId, name: 'Test Workspace' });
  const membership = mockMembership({
    workspaceId,
    userId: user.id,
    role: 'owner',
  });
  const magicSession = mockSession({
    id: 'pending-email-1',
    userId: user.id,
    token: options.magicToken ?? `magic:${options.code ?? '123456'}:opaque-token`,
    channel: 'email_pending',
    expiresAt: new Date(Date.now() + 60_000),
  });

  const createDbFacade = (
    insertSink: Array<{ table: unknown; value: unknown }>,
    updateSink: Array<{ table: unknown; value: unknown }>,
    deleteSink: Array<{ table: unknown }>,
  ) => ({
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            if (table === users) return [user];
            if (table === workspaceMembers) {
              return options.existingMembership === false ? [] : [membership];
            }
            if (table === workspaces) return [workspace];
            return [];
          }),
          then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) => {
            const rows = table === sessions ? [magicSession] : [];
            return Promise.resolve(rows).then(resolve, reject);
          },
          catch: (reject: (reason: unknown) => void) => Promise.resolve([]).catch(reject),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertSink.push({ table, value });
        return {
          returning: vi.fn(async () => {
            if (table === workspaces) return [workspace];
            if (table === workspaceMembers) return [membership];
            if (table === evidenceItems) {
              if (options.failEvidence) throw new Error('email verification evidence unavailable');
              return [{ id: 'evidence-email-verified-1' }];
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
        where: vi.fn(async () => []),
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

function createTelegramAuthDb(
  options: {
    failEvidence?: boolean;
    userExists?: boolean;
    existingMembership?: boolean;
  } = {},
) {
  const inserts: Array<{ table: unknown; value: unknown }> = [];
  const updates: Array<{ table: unknown; value: unknown }> = [];
  const deletes: Array<{ table: unknown }> = [];
  const user = mockUser({
    id: 'user-telegram-1',
    telegramId: '123',
    name: 'Test',
  });
  const workspace = mockWorkspace({ id: workspaceId, name: 'Telegram Workspace' });
  const membership = mockMembership({
    workspaceId,
    userId: user.id,
    role: 'owner',
  });

  const createDbFacade = (
    insertSink: Array<{ table: unknown; value: unknown }>,
    updateSink: Array<{ table: unknown; value: unknown }>,
    deleteSink: Array<{ table: unknown }>,
  ) => ({
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            if (table === users) return options.userExists === false ? [] : [user];
            if (table === workspaceMembers) {
              return options.existingMembership === false ? [] : [membership];
            }
            if (table === workspaces) return [workspace];
            return [];
          }),
          then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
            Promise.resolve([]).then(resolve, reject),
          catch: (reject: (reason: unknown) => void) => Promise.resolve([]).catch(reject),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertSink.push({ table, value });
        return {
          returning: vi.fn(async () => {
            if (table === users) {
              return [{ ...user, telegramId: value['telegramId'], name: value['name'] }];
            }
            if (table === workspaces) return [workspace];
            if (table === workspaceMembers) return [membership];
            if (table === evidenceItems) {
              if (options.failEvidence) throw new Error('telegram auth evidence unavailable');
              return [{ id: 'evidence-telegram-verified-1' }];
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
        where: vi.fn(async () => []),
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

function createSessionLogoutDb(options: { failEvidence?: boolean } = {}) {
  const inserts: Array<{ table: unknown; value: unknown }> = [];
  const updates: Array<{ table: unknown; value: unknown }> = [];
  const deletes: Array<{ table: unknown }> = [];
  const session = mockSession({
    id: 'session-logout-1',
    userId: 'user-logout-1',
    token: 'logout-token',
    channel: 'email',
  });
  const membership = mockMembership({
    workspaceId,
    userId: session.userId,
    role: 'owner',
  });

  const createDbFacade = (
    insertSink: Array<{ table: unknown; value: unknown }>,
    updateSink: Array<{ table: unknown; value: unknown }>,
    deleteSink: Array<{ table: unknown }>,
  ) => ({
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => {
            if (table === sessions) return [session];
            if (table === workspaceMembers) return [membership];
            return [];
          }),
          then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
            Promise.resolve([]).then(resolve, reject),
          catch: (reject: (reason: unknown) => void) => Promise.resolve([]).catch(reject),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertSink.push({ table, value });
        return {
          returning: vi.fn(async () => {
            if (table === evidenceItems) {
              if (options.failEvidence) throw new Error('session logout evidence unavailable');
              return [{ id: 'evidence-session-logout-1' }];
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
        where: vi.fn(async () => []),
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

describe('authRoutes', () => {
  let savedBotToken: string | undefined;

  beforeEach(() => {
    savedBotToken = process.env['TELEGRAM_BOT_TOKEN'];
    process.env['TELEGRAM_BOT_TOKEN'] = 'test-token';
  });

  afterEach(() => {
    if (savedBotToken === undefined) {
      delete process.env['TELEGRAM_BOT_TOKEN'];
    } else {
      process.env['TELEGRAM_BOT_TOKEN'] = savedBotToken;
    }
  });

  // ─── POST /telegram ───

  describe('POST /telegram', () => {
    it('returns 400 when initData is missing', async () => {
      const { fetch } = testApp(authRoutes);
      const res = await fetch('POST', '/telegram', {});
      const json = await expectJson(res, 400);
      expect(json).toHaveProperty('error', 'initData required');
    });

    it('returns 503 when TELEGRAM_BOT_TOKEN is not set', async () => {
      delete process.env['TELEGRAM_BOT_TOKEN'];
      const { fetch } = testApp(authRoutes);
      const res = await fetch('POST', '/telegram', { initData: 'some=data&hash=abc' });
      const json = await expectJson(res, 503);
      expect(json).toHaveProperty('error', 'Telegram not configured');
    });

    it('returns 401 when HMAC is invalid', async () => {
      const { fetch } = testApp(authRoutes);
      const res = await fetch('POST', '/telegram', {
        initData: 'user=%7B%22id%22%3A123%7D&auth_date=1700000000&hash=invalidhashvalue',
      });
      const json = await expectJson(res, 401);
      expect(json).toHaveProperty('error', 'Invalid Telegram initData');
    });

    it('returns 401 when signed initData is stale', async () => {
      const { fetch } = testApp(authRoutes);
      const staleAuthDate = Math.floor(Date.now() / 1000) - 25 * 60 * 60;
      const res = await fetch('POST', '/telegram', {
        initData: signedTelegramInitData('test-token', staleAuthDate),
      });
      const json = await expectJson(res, 401);
      expect(json).toHaveProperty('error', 'Invalid Telegram initData');
    });

    it('returns 401 when signed initData is too far in the future', async () => {
      const { fetch } = testApp(authRoutes);
      const futureAuthDate = Math.floor(Date.now() / 1000) + 120;
      const res = await fetch('POST', '/telegram', {
        initData: signedTelegramInitData('test-token', futureAuthDate),
      });
      const json = await expectJson(res, 401);
      expect(json).toHaveProperty('error', 'Invalid Telegram initData');
    });

    it('writes redacted audit-linked evidence when Telegram auth succeeds', async () => {
      const { db, inserts, updates } = createTelegramAuthDb();
      const deps = createMockDeps({ db: db as never });
      const app = new Hono();
      app.route('/', authRoutes(deps));
      const initData = signedTelegramInitData('test-token', Math.floor(Date.now() / 1000));

      const res = await app.fetch(
        new Request('http://localhost/telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData }),
        }),
      );

      const json = await expectJson<{
        token: string;
        csrfToken: string;
        workspace: { id: string; name: string };
        evidenceItemId: string;
      }>(res, 200);
      expect(json.token).toMatch(/^[a-f0-9]{64}$/);
      expect(json.csrfToken).toMatch(/^[a-f0-9]{64}$/);
      expect(json.workspace).toEqual({ id: workspaceId, name: 'Telegram Workspace' });
      expect(json.evidenceItemId).toBe('evidence-telegram-verified-1');
      expect(res.headers.get('set-cookie') ?? '').toContain('helm_session=');

      expect(inserts.map((insert) => insert.table)).toEqual([sessions, auditLog, evidenceItems]);
      expect(inserts.find((insert) => insert.table === sessions)?.value).toMatchObject({
        userId: 'user-telegram-1',
        channel: 'telegram',
      });

      const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
        id: string;
        metadata: Record<string, unknown>;
      };
      expect(auditInsert).toMatchObject({
        workspaceId,
        action: 'AUTH_TELEGRAM_VERIFIED',
        actor: 'user:user-telegram-1',
        target: workspaceId,
        verdict: 'allow',
        metadata: expect.objectContaining({
          evidenceType: 'auth_telegram_verified',
          workspaceId,
          userId: 'user-telegram-1',
          initDataStoredInEvidence: false,
          botTokenStoredInEvidence: false,
          telegramIdStoredInEvidence: false,
          sessionTokenStoredInEvidence: false,
        }),
      });

      const evidenceInsert = inserts.find((insert) => insert.table === evidenceItems)?.value;
      expect(evidenceInsert).toMatchObject({
        workspaceId,
        auditEventId: auditInsert.id,
        evidenceType: 'auth_telegram_verified',
        sourceType: 'gateway_auth',
        redactionState: 'redacted',
        sensitivity: 'sensitive',
        metadata: expect.objectContaining({
          workspaceId,
          userId: 'user-telegram-1',
          initDataStoredInEvidence: false,
          botTokenStoredInEvidence: false,
          telegramIdStoredInEvidence: false,
          sessionTokenStoredInEvidence: false,
        }),
      });
      expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
        metadata: expect.objectContaining({
          evidenceItemId: 'evidence-telegram-verified-1',
        }),
      });

      const serializedProof = JSON.stringify({ auditInsert, evidenceInsert });
      expect(serializedProof).not.toContain(initData);
      expect(serializedProof).not.toContain('test-token');
      expect(serializedProof).not.toContain(json.token);
    });

    it('fails closed without committing Telegram auth rows when evidence persistence fails', async () => {
      const { db, inserts, deletes } = createTelegramAuthDb({ failEvidence: true });
      const deps = createMockDeps({ db: db as never });
      const app = new Hono();
      app.route('/', authRoutes(deps));

      const res = await app.fetch(
        new Request('http://localhost/telegram', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            initData: signedTelegramInitData('test-token', Math.floor(Date.now() / 1000)),
          }),
        }),
      );

      const json = await expectJson<{ error: string }>(res, 500);
      expect(json.error).toContain('failed to persist telegram auth evidence');
      expect(inserts).toEqual([]);
      expect(deletes).toEqual([]);
      expect(res.headers.get('set-cookie')).toBeNull();
    });
  });

  // ─── POST /apikey ───

  describe('POST /apikey', () => {
    it('is not mounted on the public auth routes', async () => {
      const { fetch } = testApp(authRoutes);
      const res = await fetch('POST', '/apikey', { name: 'my-key' });
      expect(res.status).toBe(404);
    });

    it('requires a workspace context', async () => {
      const { db } = createApiKeyDb();
      const deps = createMockDeps({ db: db as never });
      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('userId', 'user-1');
        await next();
      });
      app.route('/', authenticatedAuthRoutes(deps));

      const res = await app.fetch(
        new Request('http://localhost/apikey', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'ci-key' }),
        }),
      );
      const json = await expectJson<{ error: string }>(res, 400);
      expect(json.error).toBe('workspaceId required');
    });

    it('requires owner role to create api keys', async () => {
      const { db } = createApiKeyDb();
      const deps = createMockDeps({ db: db as never });
      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('userId', 'user-1');
        c.set('workspaceId', workspaceId);
        c.set('workspaceRole', 'partner');
        await next();
      });
      app.route('/', authenticatedAuthRoutes(deps));

      const res = await app.fetch(
        new Request('http://localhost/apikey', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'ci-key' }),
        }),
      );
      const json = await expectJson<{ error: string; requiredRole: string }>(res, 403);
      expect(json.error).toBe('insufficient workspace role');
      expect(json.requiredRole).toBe('owner');
    });

    it('writes redacted audit-linked evidence when creating an api key', async () => {
      const { db, inserts, updates } = createApiKeyDb();
      const deps = createMockDeps({ db: db as never });
      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('userId', 'user-1');
        c.set('workspaceId', workspaceId);
        c.set('workspaceRole', 'owner');
        await next();
      });
      app.route('/', authenticatedAuthRoutes(deps));

      const res = await app.fetch(
        new Request('http://localhost/apikey', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'ci-key' }),
        }),
      );
      const json = await expectJson<{
        key: string;
        name: string;
        expiresAt: string;
        evidenceItemId: string;
      }>(res, 201);
      expect(json.key).toMatch(/^hp_/);
      expect(json.name).toBe('ci-key');
      expect(json.expiresAt).toBeDefined();
      expect(json.evidenceItemId).toBe('evidence-api-key-1');

      expect(inserts.map((insert) => insert.table)).toEqual([apiKeys, auditLog, evidenceItems]);
      expect(inserts.find((insert) => insert.table === apiKeys)?.value).toMatchObject({
        userId: 'user-1',
        name: 'ci-key',
      });
      const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
        id: string;
      };
      expect(auditInsert).toMatchObject({
        workspaceId,
        action: 'API_KEY_CREATED',
        actor: 'user:user-1',
        target: 'ci-key',
        verdict: 'allow',
        metadata: {
          evidenceType: 'api_key_created',
          apiKeyName: 'ci-key',
          keyMaterialStoredInEvidence: false,
          keyHashStoredInEvidence: false,
        },
      });
      const evidenceInsert = inserts.find((insert) => insert.table === evidenceItems)?.value;
      expect(evidenceInsert).toMatchObject({
        workspaceId,
        auditEventId: auditInsert.id,
        evidenceType: 'api_key_created',
        sourceType: 'gateway_auth',
        redactionState: 'redacted',
        sensitivity: 'restricted',
        metadata: {
          apiKeyName: 'ci-key',
          keyMaterialStoredInEvidence: false,
          keyHashStoredInEvidence: false,
        },
      });
      expect(JSON.stringify(evidenceInsert)).not.toContain(json.key);
      expect(JSON.stringify(evidenceInsert)).not.toContain(
        (inserts.find((insert) => insert.table === apiKeys)?.value as { keyHash: string }).keyHash,
      );
      expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
        metadata: {
          evidenceItemId: 'evidence-api-key-1',
        },
      });
    });

    it('fails closed without committing api key rows when evidence persistence fails', async () => {
      const { db, inserts } = createApiKeyDb({ failEvidence: true });
      const deps = createMockDeps({ db: db as never });
      const app = new Hono();
      app.use('*', async (c, next) => {
        c.set('userId', 'user-1');
        c.set('workspaceId', workspaceId);
        c.set('workspaceRole', 'owner');
        await next();
      });
      app.route('/', authenticatedAuthRoutes(deps));

      const res = await app.fetch(
        new Request('http://localhost/apikey', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'ci-key' }),
        }),
      );
      const json = await expectJson<{ error: string }>(res, 500);
      expect(json.error).toContain('failed to persist api key evidence');
      expect(inserts).toEqual([]);
    });

    it('is reachable through the full gateway only after auth middleware succeeds', async () => {
      const { db } = createApiKeyDb({
        selectResults: [
          [mockSession({ token: 'session-token', createdAt: new Date() })],
          [mockMembership({ workspaceId, role: 'owner' })],
        ],
      });
      const deps = createMockDeps({ db: db as never });
      const app = createGateway(deps);

      const res = await app.fetch(
        new Request('http://localhost/api/auth/apikey', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer session-token',
            'X-Workspace-Id': workspaceId,
          },
          body: JSON.stringify({ name: 'full-gateway-key' }),
        }),
      );

      const json = await expectJson<{ key: string; name: string; expiresAt: string }>(res, 201);
      expect(json.key).toMatch(/^hp_/);
      expect(json.name).toBe('full-gateway-key');
    });

    it('requires CSRF header for mutating cookie-authenticated requests', async () => {
      const deps = createMockDeps();
      deps.db._setResult([mockSession({ token: 'cookie-session', createdAt: new Date() })]);
      const app = new Hono();
      app.use('*', requireAuth(deps.db as any));
      app.post('/protected', (c) => c.json({ userId: c.get('userId') }));

      const missingCsrf = await app.fetch(
        new Request('http://localhost/protected', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'helm_session=cookie-session',
          },
        }),
      );

      expect(missingCsrf.status).toBe(403);

      const ok = await app.fetch(
        new Request('http://localhost/protected', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Cookie: 'helm_session=cookie-session; helm_csrf=csrf-token',
            'X-CSRF-Token': 'csrf-token',
          },
        }),
      );
      const json = await expectJson<{ userId: string }>(ok, 200);
      expect(json.userId).toBe('user-1');
    });

    it('sets workspaceRole from the authenticated membership', async () => {
      const deps = createMockDeps();
      let selectCall = 0;
      deps.db.select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => {
              selectCall++;
              const rows =
                selectCall === 1
                  ? [mockSession({ token: 'session-token', createdAt: new Date() })]
                  : [mockMembership({ workspaceId: 'ws-1', role: 'partner' })];
              return { then: (r: any) => r(rows) };
            }),
          })),
        })),
      })) as any;

      const app = new Hono();
      app.use('*', requireAuth(deps.db as any));
      app.get('/protected', (c) =>
        c.json({ userId: c.get('userId'), workspaceRole: c.get('workspaceRole') }),
      );

      const res = await app.fetch(
        new Request('http://localhost/protected', {
          headers: {
            Authorization: 'Bearer session-token',
            'X-Workspace-Id': 'ws-1',
          },
        }),
      );
      const json = await expectJson<{ userId: string; workspaceRole: string }>(res, 200);
      expect(json.userId).toBe('user-1');
      expect(json.workspaceRole).toBe('partner');
    });
  });

  // ─── POST /email/request ───

  describe('POST /email/request', () => {
    it('returns 400 when email is missing', async () => {
      const { fetch } = testApp(authRoutes);
      const res = await fetch('POST', '/email/request', {});
      const json = await expectJson(res, 400);
      expect(json).toHaveProperty('error', 'Valid email required');
    });

    it('returns 400 when email has no @', async () => {
      const { fetch } = testApp(authRoutes);
      const res = await fetch('POST', '/email/request', { email: 'not-an-email' });
      const json = await expectJson(res, 400);
      expect(json).toHaveProperty('error', 'Valid email required');
    });

    it('returns sent:true on success', async () => {
      const sendMagicLink = vi.fn(async () => {});
      const randomSpy = vi.spyOn(Math, 'random');
      const insertedValues: Array<Record<string, unknown>> = [];
      const deps = createMockDeps({
        emailProvider: { kind: 'noop', sendMagicLink } as any,
      });
      // First select (find user by email) returns nothing, then insert returns the new user
      deps.db.select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({
              then: (r: any) => r([]),
            })),
          })),
        })),
      })) as any;
      deps.db.insert = vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => {
          insertedValues.push(values);
          return {
            returning: vi.fn(async () => [mockUser({ email: 'test@example.com' })]),
            then: (r: any) => r([mockUser({ email: 'test@example.com' })]),
          };
        }),
      })) as any;

      const app = new Hono();
      app.route('/', authRoutes(deps));
      const res = await app.fetch(
        new Request('http://localhost/email/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'test@example.com' }),
        }),
      );
      const json = await expectJson<{ sent: boolean; email: string; code?: string }>(res, 200);
      expect(json.sent).toBe(true);
      expect(json.email).toBe('test@example.com');
      expect(json.code).toMatch(/^\d{6}$/);
      expect(sendMagicLink).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'test@example.com', code: json.code }),
      );
      const pending = insertedValues.find((values) => values.channel === 'email_pending');
      expect(pending?.token).toMatch(/^magic:v2:/);
      expect(String(pending?.token)).not.toContain(json.code ?? '');
      expect(randomSpy).not.toHaveBeenCalled();
      randomSpy.mockRestore();
    });
  });

  describe('POST /invite/:token', () => {
    it('writes redacted audit-linked evidence when accepting a workspace invite', async () => {
      const { db, inserts, updates, deletes } = createInviteAcceptDb();
      const deps = createMockDeps({ db: db as never });
      const app = new Hono();
      app.route('/', authRoutes(deps));

      const res = await app.fetch(
        new Request(
          'http://localhost/invite/00000000-0000-4000-8000-000000000001:partner:opaque-token',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'Invitee@Example.com' }),
          },
        ),
      );

      const json = await expectJson<{
        token: string;
        workspaceId: string;
        role: string;
        evidenceItemId: string;
      }>(res, 200);
      expect(json.workspaceId).toBe(workspaceId);
      expect(json.role).toBe('partner');
      expect(json.evidenceItemId).toBe('evidence-invite-accepted-1');

      expect(inserts.map((insert) => insert.table)).toEqual([
        workspaceMembers,
        sessions,
        auditLog,
        evidenceItems,
      ]);
      expect(inserts.find((insert) => insert.table === workspaceMembers)?.value).toMatchObject({
        workspaceId,
        userId: 'user-invitee-1',
        role: 'partner',
      });
      expect(deletes.map((entry) => entry.table)).toEqual([sessions]);

      const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
        id: string;
        metadata: Record<string, unknown>;
      };
      expect(auditInsert).toMatchObject({
        workspaceId,
        action: 'WORKSPACE_INVITE_ACCEPTED',
        actor: 'user:user-invitee-1',
        target: workspaceId,
        verdict: 'allow',
        metadata: expect.objectContaining({
          evidenceType: 'workspace_invite_accepted',
          role: 'partner',
          emailStoredInEvidence: false,
          inviteTokenStoredInEvidence: false,
          sessionTokenStoredInEvidence: false,
        }),
      });

      const evidenceInsert = inserts.find((insert) => insert.table === evidenceItems)?.value;
      expect(evidenceInsert).toMatchObject({
        workspaceId,
        auditEventId: auditInsert.id,
        evidenceType: 'workspace_invite_accepted',
        sourceType: 'gateway_auth',
        redactionState: 'redacted',
        sensitivity: 'sensitive',
        metadata: expect.objectContaining({
          emailStoredInEvidence: false,
          inviteTokenStoredInEvidence: false,
          sessionTokenStoredInEvidence: false,
        }),
      });
      expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
        metadata: expect.objectContaining({
          evidenceItemId: 'evidence-invite-accepted-1',
        }),
      });

      const serializedProof = JSON.stringify({ auditInsert, evidenceInsert });
      expect(serializedProof).not.toContain('invitee@example.com');
      expect(serializedProof).not.toContain('Invitee@Example.com');
      expect(serializedProof).not.toContain('opaque-token');
      expect(serializedProof).not.toContain(json.token);
    });

    it('fails closed without committing invite acceptance rows when evidence persistence fails', async () => {
      const { db, inserts, deletes } = createInviteAcceptDb({ failEvidence: true });
      const deps = createMockDeps({ db: db as never });
      const app = new Hono();
      app.route('/', authRoutes(deps));

      const res = await app.fetch(
        new Request(
          'http://localhost/invite/00000000-0000-4000-8000-000000000001:partner:opaque-token',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: 'invitee@example.com' }),
          },
        ),
      );

      const json = await expectJson<{ error: string }>(res, 500);
      expect(json.error).toContain('failed to persist invite acceptance evidence');
      expect(inserts).toEqual([]);
      expect(deletes).toEqual([]);
      expect(res.headers.get('set-cookie')).toBeNull();
    });
  });

  // ─── POST /email/verify ───

  describe('POST /email/verify', () => {
    it('returns 400 when fields are missing', async () => {
      const { fetch } = testApp(authRoutes);
      const res = await fetch('POST', '/email/verify', { email: 'a@b.com' });
      const json = await expectJson(res, 400);
      expect(json).toHaveProperty('error', 'email and code required');
    });

    it('returns 401 when user not found', async () => {
      // Default mock db returns [] for selects, so user won't be found
      const { fetch } = testApp(authRoutes);
      const res = await fetch('POST', '/email/verify', {
        email: 'ghost@example.com',
        code: '123456',
      });
      const json = await expectJson(res, 401);
      expect(json).toHaveProperty('error', 'Invalid code');
    });

    it('returns 401 when no matching magic session', async () => {
      const deps = createMockDeps();
      let selectCallCount = 0;
      deps.db.select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            selectCallCount++;
            // First select: find user by email -> return a user
            // Second select: find sessions by userId -> return empty (no magic session)
            const result = selectCallCount === 1 ? [mockUser()] : [];
            return {
              limit: vi.fn(() => ({
                then: (r: any) => r(result),
              })),
              then: (r: any) => r(result),
            };
          }),
        })),
      })) as any;

      const app = new Hono();
      app.route('/', authRoutes(deps));
      const res = await app.fetch(
        new Request('http://localhost/email/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'test@example.com', code: '999999' }),
        }),
      );
      const json = await expectJson(res, 401);
      expect(json).toHaveProperty('error', 'Invalid or expired code');
    });

    it('writes redacted audit-linked evidence when redeeming an email magic code', async () => {
      const { db, inserts, updates, deletes } = createEmailVerifyDb({ code: '123456' });
      const deps = createMockDeps({ db: db as never });
      const app = new Hono();
      app.route('/', authRoutes(deps));

      const res = await app.fetch(
        new Request('http://localhost/email/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'Test@Example.com', code: '123456' }),
        }),
      );

      const json = await expectJson<{
        token: string;
        csrfToken: string;
        workspace: { id: string; name: string };
        evidenceItemId: string;
      }>(res, 200);
      expect(json.token).toMatch(/^[a-f0-9]{64}$/);
      expect(json.csrfToken).toMatch(/^[a-f0-9]{64}$/);
      expect(json.workspace).toEqual({ id: workspaceId, name: 'Test Workspace' });
      expect(json.evidenceItemId).toBe('evidence-email-verified-1');
      expect(res.headers.get('set-cookie') ?? '').toContain('helm_session=');

      expect(deletes.map((entry) => entry.table)).toEqual([sessions]);
      expect(inserts.map((insert) => insert.table)).toEqual([sessions, auditLog, evidenceItems]);
      expect(inserts.find((insert) => insert.table === sessions)?.value).toMatchObject({
        userId: 'user-email-1',
        channel: 'email',
      });

      const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
        id: string;
        metadata: Record<string, unknown>;
      };
      expect(auditInsert).toMatchObject({
        workspaceId,
        action: 'AUTH_EMAIL_VERIFIED',
        actor: 'user:user-email-1',
        target: workspaceId,
        verdict: 'allow',
        metadata: expect.objectContaining({
          evidenceType: 'auth_email_verified',
          workspaceId,
          userId: 'user-email-1',
          emailStoredInEvidence: false,
          magicCodeStoredInEvidence: false,
          magicSessionTokenStoredInEvidence: false,
          sessionTokenStoredInEvidence: false,
        }),
      });

      const evidenceInsert = inserts.find((insert) => insert.table === evidenceItems)?.value;
      expect(evidenceInsert).toMatchObject({
        workspaceId,
        auditEventId: auditInsert.id,
        evidenceType: 'auth_email_verified',
        sourceType: 'gateway_auth',
        redactionState: 'redacted',
        sensitivity: 'sensitive',
        metadata: expect.objectContaining({
          workspaceId,
          userId: 'user-email-1',
          emailStoredInEvidence: false,
          magicCodeStoredInEvidence: false,
          magicSessionTokenStoredInEvidence: false,
          sessionTokenStoredInEvidence: false,
        }),
      });
      expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
        metadata: expect.objectContaining({
          evidenceItemId: 'evidence-email-verified-1',
        }),
      });

      const serializedProof = JSON.stringify({ auditInsert, evidenceInsert });
      expect(serializedProof).not.toContain('Test@Example.com');
      expect(serializedProof).not.toContain('test@example.com');
      expect(serializedProof).not.toContain('123456');
      expect(serializedProof).not.toContain(json.token);
    });

    it('fails closed without committing email verification rows when evidence persistence fails', async () => {
      const { db, inserts, deletes } = createEmailVerifyDb({
        code: '123456',
        failEvidence: true,
      });
      const deps = createMockDeps({ db: db as never });
      const app = new Hono();
      app.route('/', authRoutes(deps));

      const res = await app.fetch(
        new Request('http://localhost/email/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'test@example.com', code: '123456' }),
        }),
      );

      const json = await expectJson<{ error: string }>(res, 500);
      expect(json.error).toContain('failed to persist email verification evidence');
      expect(inserts).toEqual([]);
      expect(deletes).toEqual([]);
      expect(res.headers.get('set-cookie')).toBeNull();
    });

    it('redeems hashed magic codes once and deletes the pending session', async () => {
      const sendMagicLink = vi.fn(async () => {});
      const insertedValues: Array<Record<string, unknown>> = [];
      const deps = createMockDeps({
        emailProvider: { kind: 'noop', sendMagicLink } as any,
      });

      deps.db.select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({
              then: (r: any) => r([]),
            })),
          })),
        })),
      })) as any;
      deps.db.insert = vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => {
          insertedValues.push(values);
          return {
            returning: vi.fn(async () => [mockUser({ email: 'test@example.com' })]),
            then: (r: any) => r([]),
          };
        }),
      })) as any;

      const app = new Hono();
      app.route('/', authRoutes(deps));
      const requestRes = await app.fetch(
        new Request('http://localhost/email/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'TEST@example.com' }),
        }),
      );
      const requestJson = await expectJson<{ code: string }>(requestRes, 200);
      const pending = insertedValues.find((values) => values.channel === 'email_pending');
      expect(pending?.token).toMatch(/^magic:v2:/);

      const verifyDb = createEmailVerifyDb({ magicToken: String(pending?.token) });
      (deps as any).db = verifyDb.db;

      const verifyRes = await app.fetch(
        new Request('http://localhost/email/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'test@example.com', code: requestJson.code }),
        }),
      );

      const verifyJson = await expectJson<{ token: string; csrfToken: string }>(verifyRes, 200);
      expect(verifyJson.token).toMatch(/^[a-f0-9]{64}$/);
      expect(verifyJson.csrfToken).toMatch(/^[a-f0-9]{64}$/);
      expect(verifyRes.headers.get('set-cookie') ?? '').toContain('helm_session=');
      expect(verifyDb.deletes.map((entry) => entry.table)).toEqual([sessions]);
      expect(verifyDb.inserts.map((insert) => insert.table)).toEqual([
        sessions,
        auditLog,
        evidenceItems,
      ]);
    });

    it('deletes pending hashed code after the final failed attempt', async () => {
      const sendMagicLink = vi.fn(async () => {});
      const insertedValues: Array<Record<string, unknown>> = [];
      const deps = createMockDeps({
        emailProvider: { kind: 'noop', sendMagicLink } as any,
      });

      deps.db.select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({
              then: (r: any) => r([]),
            })),
          })),
        })),
      })) as any;
      deps.db.insert = vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => {
          insertedValues.push(values);
          return {
            returning: vi.fn(async () => [mockUser({ email: 'test@example.com' })]),
            then: (r: any) => r([]),
          };
        }),
      })) as any;

      const app = new Hono();
      app.route('/', authRoutes(deps));
      const requestRes = await app.fetch(
        new Request('http://localhost/email/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'test@example.com' }),
        }),
      );
      await expectJson(requestRes, 200);
      const pending = insertedValues.find((values) => values.channel === 'email_pending');
      const finalAttemptToken = String(pending?.token).replace(/:0:/, ':4:');

      let selectCallCount = 0;
      deps.db.select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            selectCallCount++;
            const result =
              selectCallCount === 1
                ? [mockUser({ email: 'test@example.com' })]
                : [
                    mockSession({
                      id: 'pending-1',
                      token: finalAttemptToken,
                      channel: 'email_pending',
                      expiresAt: new Date(Date.now() + 60_000),
                    }),
                  ];
            return {
              limit: vi.fn(() => ({
                then: (r: any) => r(result),
              })),
              then: (r: any) => r(result),
            };
          }),
        })),
      })) as any;
      deps.db.delete = vi.fn(() => ({
        where: vi.fn(() => ({
          then: (r: any) => r([]),
        })),
      })) as any;

      const verifyRes = await app.fetch(
        new Request('http://localhost/email/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: 'test@example.com', code: '000000' }),
        }),
      );

      const verifyJson = await expectJson(verifyRes, 401);
      expect(verifyJson).toHaveProperty('error', 'Invalid or expired code');
      expect(deps.db.delete).toHaveBeenCalled();
    });
  });

  // ─── DELETE /session ───

  describe('DELETE /session', () => {
    it('returns 400 when no Bearer token is provided', async () => {
      const { fetch } = testApp(authRoutes);
      const res = await fetch('DELETE', '/session');
      const json = await expectJson(res, 400);
      expect(json).toHaveProperty('error', 'No session');
    });

    it('returns ok:true on success', async () => {
      const { fetch } = testApp(authRoutes);
      const res = await fetch('DELETE', '/session', undefined, {
        Authorization: 'Bearer test-token-abc123',
      });
      const json = await expectJson<{ ok: boolean }>(res, 200);
      expect(json.ok).toBe(true);
    });

    it('writes redacted audit-linked evidence when deleting a resolved session', async () => {
      const { db, inserts, updates, deletes } = createSessionLogoutDb();
      const deps = createMockDeps({ db: db as never });
      const app = new Hono();
      app.route('/', authRoutes(deps));

      const res = await app.fetch(
        new Request('http://localhost/session', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer logout-token' },
        }),
      );

      const json = await expectJson<{ ok: boolean; evidenceItemId: string }>(res, 200);
      expect(json.ok).toBe(true);
      expect(json.evidenceItemId).toBe('evidence-session-logout-1');
      expect(inserts.map((insert) => insert.table)).toEqual([auditLog, evidenceItems]);
      expect(deletes.map((entry) => entry.table)).toEqual([sessions]);

      const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
        id: string;
        metadata: Record<string, unknown>;
      };
      expect(auditInsert).toMatchObject({
        workspaceId,
        action: 'AUTH_SESSION_DELETED',
        actor: 'user:user-logout-1',
        target: 'session-logout-1',
        verdict: 'allow',
        metadata: expect.objectContaining({
          evidenceType: 'auth_session_deleted',
          workspaceId,
          userId: 'user-logout-1',
          sessionId: 'session-logout-1',
          tokenStoredInEvidence: false,
          cookieTokenStoredInEvidence: false,
        }),
      });

      const evidenceInsert = inserts.find((insert) => insert.table === evidenceItems)?.value;
      expect(evidenceInsert).toMatchObject({
        workspaceId,
        auditEventId: auditInsert.id,
        evidenceType: 'auth_session_deleted',
        sourceType: 'gateway_auth',
        redactionState: 'redacted',
        sensitivity: 'sensitive',
        metadata: expect.objectContaining({
          workspaceId,
          userId: 'user-logout-1',
          tokenStoredInEvidence: false,
          cookieTokenStoredInEvidence: false,
        }),
      });
      expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
        metadata: expect.objectContaining({
          evidenceItemId: 'evidence-session-logout-1',
        }),
      });
      expect(JSON.stringify({ auditInsert, evidenceInsert })).not.toContain('logout-token');
    });

    it('fails closed without deleting a resolved session when logout evidence fails', async () => {
      const { db, inserts, deletes } = createSessionLogoutDb({ failEvidence: true });
      const deps = createMockDeps({ db: db as never });
      const app = new Hono();
      app.route('/', authRoutes(deps));

      const res = await app.fetch(
        new Request('http://localhost/session', {
          method: 'DELETE',
          headers: { Authorization: 'Bearer logout-token' },
        }),
      );

      const json = await expectJson<{ error: string }>(res, 500);
      expect(json.error).toContain('failed to persist session logout evidence');
      expect(inserts).toEqual([]);
      expect(deletes).toEqual([]);
      expect(res.headers.get('set-cookie')).toBeNull();
    });
  });

  // ─── POST /invite/:token ───

  describe('POST /invite/:token', () => {
    it('returns 400 when email is missing', async () => {
      const { fetch } = testApp(authRoutes);
      const res = await fetch('POST', '/invite/some-token', {});
      const json = await expectJson(res, 400);
      expect(json).toHaveProperty('error', 'email required');
    });

    it('returns 401 when invite session not found or expired', async () => {
      // Default mock db returns [] — no invite session found
      const { fetch } = testApp(authRoutes);
      const res = await fetch('POST', '/invite/some-token', { email: 'invitee@example.com' });
      const json = await expectJson(res, 401);
      expect(json).toHaveProperty('error', 'Invalid or expired invite');
    });
  });
});

function signedTelegramInitData(botToken: string, authDate: number): string {
  const params = new URLSearchParams();
  params.set('auth_date', String(authDate));
  params.set('user', JSON.stringify({ id: 123, first_name: 'Test' }));
  const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([key, value]) => `${key}=${value}`).join('\n');
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  params.set('hash', hash);
  return params.toString();
}
