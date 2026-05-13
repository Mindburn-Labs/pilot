import { vi } from 'vitest';
import { Hono } from 'hono';
import { type GatewayDeps } from '../index.js';

// ─── Chainable Mock DB ───

type MockResult = unknown[];

/**
 * Creates a Drizzle-compatible mock DB. Each chained query resolves to `results`
 * (default: empty array). Override per-call via the returned `_setResult()`.
 */
export function createMockDb() {
  let nextResult: MockResult = [];

  const chainable = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    const methods = [
      'from',
      'innerJoin',
      'where',
      'orderBy',
      'limit',
      'offset',
      'returning',
      'onConflictDoNothing',
      'onConflictDoUpdate',
    ];
    for (const m of methods) {
      chain[m] = vi.fn(() => chainable());
    }
    // Make the chain thenable so `await db.select().from().where()` resolves
    chain['then'] = (resolve: (v: MockResult) => void) => resolve(nextResult);
    return chain;
  };

  const db = {
    select: vi.fn(() => chainable()),
    insert: vi.fn(() => ({ values: vi.fn(() => chainable()) })),
    update: vi.fn(() => ({ set: vi.fn(() => chainable()) })),
    delete: vi.fn(() => chainable()),
    transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(db)),
    execute: vi.fn(async () => [{ '?column?': 1 }]),
    _setResult(result: MockResult) {
      nextResult = result;
      return db;
    },
    _reset() {
      nextResult = [];
    },
  };

  return db;
}

// ─── Mock Deps ───

export function createMockDeps(
  overrides?: Partial<GatewayDeps>,
): GatewayDeps & { db: ReturnType<typeof createMockDb> } {
  const db = createMockDb();
  return {
    db: db as any,
    orchestrator: {
      boss: { send: vi.fn() } as any,
      runTask: vi.fn(async () => ({
        status: 'completed',
        iterationsUsed: 1,
        iterationBudget: 50,
        actions: [],
        tokensIn: 0,
        tokensOut: 0,
      })),
      trust: {} as any,
      agentLoop: {} as any,
      tools: {} as any,
      db: db as any,
    } as any,
    memory: {
      search: vi.fn(async () => []),
      upsertPage: vi.fn(async () => 'page-1'),
      addTimeline: vi.fn(async () => {}),
      getPage: vi.fn(async () => null),
      recompileTruth: vi.fn(async () => {}),
      createLink: vi.fn(async () => {}),
      getLinks: vi.fn(async () => []),
      addTag: vi.fn(async () => {}),
      getPageTags: vi.fn(async () => []),
      listTags: vi.fn(async () => []),
    } as any,
    oauth: {
      getProvider: vi.fn((connectorId: string) => ({
        connectorId,
        clientId: 'client-id',
        clientIdEnv: `${connectorId.toUpperCase()}_CLIENT_ID`,
      })),
      initiateFlow: vi.fn(({ connectorId }: { connectorId: string }) => ({
        authUrl: `https://auth.example.com/${connectorId}`,
        state: 'state-1',
      })),
      handleCallback: vi.fn(async () => ({
        connectorId: 'github',
        workspaceId: 'ws-1',
        grantId: 'grant-1',
        scopes: ['repo'],
      })),
      inspectCallbackState: vi.fn(() => ({
        connectorId: 'github',
        workspaceId: 'ws-1',
      })),
      refreshToken: vi.fn(async () => 'new-token'),
    } as any,
    ...overrides,
  } as any;
}

// ─── Test App Helper ───

/**
 * Mounts a route factory on a Hono app and returns a fetch helper.
 */
export function testApp(routeFactory: (deps: GatewayDeps) => Hono, deps?: GatewayDeps) {
  const d = deps ?? createMockDeps();
  const app = new Hono();
  app.use('*', async (c, next) => {
    const workspaceId = c.req.header('X-Workspace-Id') ?? c.req.query('workspaceId');
    if (workspaceId) c.set('workspaceId', workspaceId);
    c.set('userId', c.req.header('X-User-Id') ?? 'user-1');
    c.set('workspaceRole', c.req.header('X-Workspace-Role') ?? 'owner');
    await next();
  });
  app.route('/', routeFactory(d));

  return {
    deps: d,
    app,
    async fetch(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
      const url = `http://localhost${path}`;
      const init: RequestInit = {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      return app.fetch(new Request(url, init));
    },
  };
}

/**
 * Assert status and parse JSON from a Response.
 */
export async function expectJson<T = unknown>(res: Response, expectedStatus?: number): Promise<T> {
  if (expectedStatus !== undefined) {
    if (res.status !== expectedStatus) {
      const text = await res.text();
      throw new Error(`Expected status ${expectedStatus} but got ${res.status}: ${text}`);
    }
  }
  return res.json() as Promise<T>;
}

// ─── Mock Factories ───

export function mockUser(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: 'user-1',
    telegramId: null,
    email: 'test@pilot.local',
    name: 'Test User',
    avatarUrl: null,
    isActive: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

export function mockWorkspace(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: 'ws-1',
    name: "Test User's Workspace",
    currentMode: 'discover',
    ownerId: 'user-1',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

export function mockSession(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: 'sess-1',
    userId: 'user-1',
    token: 'test-token-abc123',
    channel: 'email',
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    createdAt: new Date(),
    ...overrides,
  };
}

export function mockTask(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: 'task-1',
    workspaceId: 'ws-1',
    operatorId: null,
    parentTaskId: null,
    title: 'Test Task',
    description: 'A test task',
    mode: 'build',
    status: 'pending',
    priority: 0,
    metadata: {},
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

export function mockOperator(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: 'op-1',
    workspaceId: 'ws-1',
    name: 'Test Operator',
    role: 'builder',
    goal: 'Build things',
    constraints: [],
    tools: [],
    isActive: true,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

export function mockOpportunity(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: 'opp-1',
    workspaceId: 'ws-1',
    source: 'manual',
    sourceUrl: null,
    title: 'Test Opportunity',
    description: 'A test opportunity',
    rawData: null,
    aiFriendlyOk: true,
    discoveredAt: new Date('2026-01-01'),
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

export function mockMembership(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: 'mem-1',
    workspaceId: 'ws-1',
    userId: 'user-1',
    role: 'owner',
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}
