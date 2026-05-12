import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { a2aMessages, a2aThreads, auditLog } from '@pilot/db/schema';
import { a2aRoutes, __resetA2aTasks } from '../../routes/a2a.js';
import { createMockDeps, testApp } from '../helpers.js';

const appendEvidenceItemMock = vi.hoisted(() => vi.fn(async () => 'evidence-a2a-1'));

vi.mock('@pilot/db', () => ({
  appendEvidenceItem: appendEvidenceItemMock,
}));

vi.mock('@pilot/db/schema', () => ({
  a2aThreads: {
    id: 'a2aThreads.id',
    workspaceId: 'a2aThreads.workspaceId',
    externalTaskId: 'a2aThreads.externalTaskId',
    pilotTaskId: 'a2aThreads.pilotTaskId',
    status: 'a2aThreads.status',
    updatedAt: 'a2aThreads.updatedAt',
    completedAt: 'a2aThreads.completedAt',
  },
  a2aMessages: {
    id: 'a2aMessages.id',
    threadId: 'a2aMessages.threadId',
    workspaceId: 'a2aMessages.workspaceId',
    role: 'a2aMessages.role',
    parts: 'a2aMessages.parts',
    sequence: 'a2aMessages.sequence',
  },
  auditLog: {
    id: 'auditLog.id',
    workspaceId: 'auditLog.workspaceId',
  },
  tasks: {
    id: 'tasks.id',
    workspaceId: 'tasks.workspaceId',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ op: 'and', conditions })),
  asc: vi.fn((col: unknown) => ({ op: 'asc', col })),
  eq: vi.fn((col: unknown, value: unknown) => ({ op: 'eq', col, value })),
}));

const BEARER = 'test123abc456def789012345';
const WS_ID = 'ws-a2a-1';

describe('a2aRoutes', () => {
  beforeEach(() => {
    __resetA2aTasks();
    appendEvidenceItemMock.mockClear();
    appendEvidenceItemMock.mockResolvedValue('evidence-a2a-1');
    process.env['PILOT_A2A_TOKEN'] = BEARER;
    process.env['PILOT_A2A_WORKSPACE_ID'] = WS_ID;
    process.env['PILOT_A2A_PUBLIC_URL'] = 'http://localhost:3100';
    process.env['PILOT_VERSION'] = '1.2.1';
  });
  afterEach(() => {
    delete process.env['PILOT_A2A_TOKEN'];
    delete process.env['PILOT_A2A_WORKSPACE_ID'];
    delete process.env['PILOT_A2A_PUBLIC_URL'];
    delete process.env['PILOT_VERSION'];
  });

  it('GET /.well-known/agent-card.json returns AgentCard', async () => {
    const { fetch } = testApp(a2aRoutes);
    const res = await fetch('GET', '/.well-known/agent-card.json');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      protocolVersion: string;
      skills: unknown[];
      authentication: { schemes: string[] };
    };
    expect(body.protocolVersion).toBe('0.3.0');
    expect(body.skills.length).toBeGreaterThan(0);
    expect(body.authentication.schemes).toEqual(['bearer']);
  });

  it('POST /a2a with no token env returns 503', async () => {
    delete process.env['PILOT_A2A_TOKEN'];
    const { fetch } = testApp(a2aRoutes);
    const res = await fetch('POST', '/a2a', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    });
    expect(res.status).toBe(503);
  });

  it('POST /a2a missing bearer header returns 401', async () => {
    const { fetch } = testApp(a2aRoutes);
    const res = await fetch('POST', '/a2a', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/send',
    });
    expect(res.status).toBe(401);
  });

  it('POST /a2a wrong bearer returns 401', async () => {
    const { fetch } = testApp(a2aRoutes);
    const res = await fetch(
      'POST',
      '/a2a',
      { jsonrpc: '2.0', id: 1, method: 'tasks/send' },
      { authorization: 'Bearer wrong-token-xxxxxxxxxxxx' },
    );
    expect(res.status).toBe(401);
  });

  it('tasks/send happy path dispatches via orchestrator.runConduct', async () => {
    const deps = createMockDeps();
    deps.db.insert = vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(async () => [{ id: 'task-row-1' }]),
      })),
    })) as unknown as typeof deps.db.insert;
    const runConductMock = vi.fn(async () => ({
      status: 'completed',
      actions: [{ tool: 'finish', input: { summary: 'All done.' } }],
    }));
    (deps.orchestrator as unknown as { runConduct: typeof runConductMock }).runConduct =
      runConductMock;

    const { fetch } = testApp(a2aRoutes, deps);
    const res = await fetch(
      'POST',
      '/a2a',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          message: {
            role: 'user',
            parts: [{ type: 'text', text: 'Find AI opportunities' }],
          },
        },
      },
      { authorization: `Bearer ${BEARER}` },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: {
        task: {
          id: string;
          status: {
            state: string;
            message?: { parts: Array<{ type: string; text: string }> };
          };
        };
      };
    };
    expect(body.result.task.id).toBeDefined();
    expect(body.result.task.status.state).toBe('completed');
    expect(body.result.task.status.message?.parts[0]?.text).toBe('All done.');
    expect(runConductMock).toHaveBeenCalledTimes(1);
    expect(appendEvidenceItemMock).toHaveBeenCalledTimes(1);
    expect(appendEvidenceItemMock.mock.invocationCallOrder[0]).toBeLessThan(
      runConductMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    const evidenceInput = appendEvidenceItemMock.mock.calls[0]?.[1] as {
      evidenceType?: string;
      sourceType?: string;
      metadata?: Record<string, unknown>;
    };
    expect(evidenceInput).toMatchObject({
      evidenceType: 'a2a_task_dispatched',
      sourceType: 'gateway_a2a_route',
      metadata: {
        workspaceId: WS_ID,
        externalTaskId: expect.any(String),
        pilotTaskId: 'task-row-1',
        textHash: expect.any(String),
        textLength: 'Find AI opportunities'.length,
        evidenceContract: 'a2a_dispatch_evidence_required',
      },
    });
    expect(JSON.stringify(evidenceInput.metadata)).not.toContain('Find AI opportunities');
    expect(deps.db.insert).toHaveBeenCalledWith(a2aThreads);
    expect(deps.db.insert).toHaveBeenCalledWith(a2aMessages);
  });

  it('tasks/send fails closed before conductor execution when dispatch evidence cannot persist', async () => {
    appendEvidenceItemMock.mockRejectedValueOnce(new Error('evidence unavailable'));
    const deps = createMockDeps();
    deps.db.insert = vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(async () => [{ id: 'task-row-1' }]),
      })),
    })) as unknown as typeof deps.db.insert;
    const runConductMock = vi.fn(async () => ({
      status: 'completed',
      actions: [{ tool: 'finish', input: { summary: 'All done.' } }],
    }));
    (deps.orchestrator as unknown as { runConduct: typeof runConductMock }).runConduct =
      runConductMock;

    const { fetch } = testApp(a2aRoutes, deps);
    const res = await fetch(
      'POST',
      '/a2a',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          message: {
            role: 'user',
            parts: [{ type: 'text', text: 'Find AI opportunities' }],
          },
        },
      },
      { authorization: `Bearer ${BEARER}` },
    );

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code: number; message: string } };
    expect(body.error).toMatchObject({
      code: -32603,
      message: 'A2A dispatch evidence persistence failed',
    });
    expect(runConductMock).not.toHaveBeenCalled();
    expect(deps.db.insert).not.toHaveBeenCalledWith(a2aThreads);
    expect(deps.db.insert).toHaveBeenCalledWith(auditLog);
  });

  it('does not commit A2A thread state when message persistence fails', async () => {
    const deps = createMockDeps();
    const committedThreads: unknown[] = [];
    const committedMessages: unknown[] = [];
    deps.db.insert = vi.fn((table: unknown) => {
      if (table === a2aThreads || table === a2aMessages) {
        throw new Error('A2A durable state must be persisted inside a transaction');
      }
      return {
        values: vi.fn(() => ({
          returning: vi.fn(async () => [{ id: 'task-row-1' }]),
        })),
      };
    }) as unknown as typeof deps.db.insert;
    deps.db.transaction = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const stagedThreads: unknown[] = [];
      const stagedMessages: unknown[] = [];
      const tx = {
        ...deps.db,
        insert: vi.fn((table: unknown) => ({
          values: vi.fn((value: unknown) => {
            if (table === a2aThreads) {
              stagedThreads.push(value);
              return { returning: vi.fn(async () => [{ id: 'thread-1' }]) };
            }
            if (table === a2aMessages) {
              stagedMessages.push(value);
              throw new Error('a2a message ledger unavailable');
            }
            return {
              returning: vi.fn(async () => [{ id: 'task-row-1' }]),
            };
          }),
        })),
      };
      const result = await callback(tx);
      committedThreads.push(...stagedThreads);
      committedMessages.push(...stagedMessages);
      return result;
    }) as typeof deps.db.transaction;
    const runConductMock = vi.fn(async () => ({
      status: 'completed',
      actions: [{ tool: 'finish', input: { summary: 'All done.' } }],
    }));
    (deps.orchestrator as unknown as { runConduct: typeof runConductMock }).runConduct =
      runConductMock;

    const { fetch } = testApp(a2aRoutes, deps);
    const res = await fetch(
      'POST',
      '/a2a',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: {
          message: {
            role: 'user',
            parts: [{ type: 'text', text: 'Find AI opportunities' }],
          },
        },
      },
      { authorization: `Bearer ${BEARER}` },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { error?: { code: number; message: string } };
    expect(body.error).toMatchObject({
      code: -32603,
      message: 'a2a message ledger unavailable',
    });
    expect(runConductMock).toHaveBeenCalledTimes(1);
    expect(committedThreads).toEqual([]);
    expect(committedMessages).toEqual([]);
  });

  it('tasks/get reconstructs durable A2A state from DB after route re-instantiation', async () => {
    const deps = createMockDeps();
    let selectCount = 0;
    deps.db.select = vi.fn(() => {
      selectCount++;
      if (selectCount === 1) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(async () => [
                {
                  id: 'thread-1',
                  workspaceId: WS_ID,
                  externalTaskId: 'durable-task-1',
                  status: 'completed',
                  createdAt: new Date('2026-05-05T10:00:00.000Z'),
                  updatedAt: new Date('2026-05-05T10:00:01.000Z'),
                  completedAt: new Date('2026-05-05T10:00:02.000Z'),
                },
              ]),
            })),
          })),
        };
      }
      return {
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(async () => [
              {
                role: 'user',
                parts: [{ type: 'text', text: 'Find AI opportunities' }],
                sequence: 1,
              },
              {
                role: 'agent',
                parts: [{ type: 'text', text: 'All done.' }],
                sequence: 2,
              },
            ]),
          })),
        })),
      };
    }) as unknown as typeof deps.db.select;

    const { fetch } = testApp(a2aRoutes, deps);
    const res = await fetch(
      'POST',
      '/a2a',
      { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: 'durable-task-1' } },
      { authorization: `Bearer ${BEARER}` },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { task: { id: string; status: { state: string; message?: { parts: unknown[] } } } };
    };
    expect(body.result.task.id).toBe('durable-task-1');
    expect(body.result.task.status.state).toBe('completed');
    expect(body.result.task.status.message?.parts).toEqual([{ type: 'text', text: 'All done.' }]);
  });

  it('tasks/get for unknown id returns task_not_found', async () => {
    const { fetch } = testApp(a2aRoutes);
    const res = await fetch(
      'POST',
      '/a2a',
      { jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { id: 'ghost' } },
      { authorization: `Bearer ${BEARER}` },
    );
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32004);
  });

  it('malformed JSON returns -32700', async () => {
    const { app } = testApp(a2aRoutes);
    const res = await app.fetch(
      new Request('http://localhost/a2a', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${BEARER}`,
        },
        body: '{not json',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it('unknown method returns -32601', async () => {
    const { fetch } = testApp(a2aRoutes);
    const res = await fetch(
      'POST',
      '/a2a',
      { jsonrpc: '2.0', id: 9, method: 'resources/list' },
      { authorization: `Bearer ${BEARER}` },
    );
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32601);
  });

  it('tasks/send with no workspace env returns -32000', async () => {
    delete process.env['PILOT_A2A_WORKSPACE_ID'];
    const { fetch } = testApp(a2aRoutes);
    const res = await fetch(
      'POST',
      '/a2a',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/send',
        params: { message: { role: 'user', parts: [{ type: 'text', text: 'hi' }] } },
      },
      { authorization: `Bearer ${BEARER}` },
    );
    const body = (await res.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32000);
  });
});
