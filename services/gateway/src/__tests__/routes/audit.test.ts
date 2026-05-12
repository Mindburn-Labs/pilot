import { describe, it, expect, vi, beforeEach } from 'vitest';
import { approvals, auditLog, evidenceItems } from '@pilot/db/schema';
import { auditRoutes } from '../../routes/audit.js';
import { testApp, expectJson, createMockDeps } from '../helpers.js';

describe('auditRoutes', () => {
  const wsHeader = { 'X-Workspace-Id': 'ws-1' };

  // ── GET / ──

  describe('GET /', () => {
    it('returns 400 when workspaceId is missing', async () => {
      const { fetch } = testApp(auditRoutes);
      const res = await fetch('GET', '/');
      const body = await expectJson<{ error: string }>(res, 400);
      expect(body.error).toContain('workspaceId');
    });

    it('returns audit entries for a workspace', async () => {
      const deps = createMockDeps();
      const entries = [
        {
          id: 'al-1',
          workspaceId: 'ws-1',
          action: 'task.created',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'al-2',
          workspaceId: 'ws-1',
          action: 'task.completed',
          createdAt: new Date().toISOString(),
        },
      ];
      deps.db._setResult(entries);

      const { fetch } = testApp(auditRoutes, deps);
      const res = await fetch('GET', '/', undefined, wsHeader);
      const body = await expectJson<unknown[]>(res, 200);
      expect(body).toEqual(entries);
    });
  });

  // ── GET /approvals ──

  describe('GET /approvals', () => {
    it('returns 400 when workspaceId is missing', async () => {
      const { fetch } = testApp(auditRoutes);
      const res = await fetch('GET', '/approvals');
      const body = await expectJson<{ error: string }>(res, 400);
      expect(body.error).toContain('workspaceId');
    });

    it('returns approvals for a workspace', async () => {
      const deps = createMockDeps();
      const approvalsList = [
        { id: 'appr-1', workspaceId: 'ws-1', action: 'deploy', status: 'pending' },
      ];
      deps.db._setResult(approvalsList);

      const { fetch } = testApp(auditRoutes, deps);
      const res = await fetch('GET', '/approvals', undefined, wsHeader);
      const body = await expectJson<unknown[]>(res, 200);
      expect(body).toEqual(approvalsList);
    });
  });

  // ── PUT /approvals/:id ──

  describe('PUT /approvals/:id', () => {
    it('returns 400 for invalid status', async () => {
      const { fetch } = testApp(auditRoutes);
      const res = await fetch('PUT', '/approvals/appr-1', { status: 'maybe' }, wsHeader);
      const body = await expectJson<{ error: string }>(res, 400);
      expect(body.error).toContain('approved or rejected');
    });

    it('returns 404 when approval is not found', async () => {
      const deps = createMockDeps();
      deps.db.update = vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => []),
            then: (r: any) => r([]),
          })),
        })),
      })) as any;

      const { fetch } = testApp(auditRoutes, deps);
      const res = await fetch('PUT', '/approvals/appr-missing', { status: 'approved' }, wsHeader);
      const body = await expectJson<{ error: string }>(res, 404);
      expect(body.error).toContain('not found');
    });

    it('triggers boss.send when approval is approved', async () => {
      const deps = createMockDeps();
      const approval = {
        id: 'appr-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        action: 'deploy.production',
        status: 'approved',
        resolvedBy: 'unknown',
        resolvedAt: new Date().toISOString(),
      };
      const inserts: Array<{ table: unknown; value: unknown }> = [];
      const updates: Array<{ table: unknown; value: unknown }> = [];

      deps.db.insert = vi.fn((table: unknown) => ({
        values: vi.fn((value: unknown) => {
          inserts.push({ table, value });
          return {
            returning: vi.fn(async () =>
              table === evidenceItems ? [{ id: 'evidence-approval-1' }] : [],
            ),
            then: (r: any) => r([]),
          };
        }),
      })) as any;
      deps.db.update = vi.fn((table: unknown) => ({
        set: vi.fn((value: unknown) => {
          updates.push({ table, value });
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => (table === approvals ? [approval] : [])),
              then: (r: any) => r([]),
            })),
          };
        }),
      })) as any;

      const { fetch } = testApp(auditRoutes, deps);
      const res = await fetch('PUT', '/approvals/appr-1', { status: 'approved' }, wsHeader);
      await expectJson(res, 200);

      const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
        id: string;
      };
      expect(auditInsert).toMatchObject({
        workspaceId: 'ws-1',
        action: 'WORKSPACE_APPROVAL_RESOLVED',
        target: 'appr-1',
        verdict: 'allow',
        metadata: {
          evidenceType: 'workspace_approval_resolved',
          approvalId: 'appr-1',
          approvalStatus: 'approved',
          requestedAction: 'deploy.production',
          taskId: 'task-1',
        },
      });
      expect(inserts.find((insert) => insert.table === evidenceItems)?.value).toMatchObject({
        workspaceId: 'ws-1',
        auditEventId: auditInsert.id,
        evidenceType: 'workspace_approval_resolved',
        sourceType: 'gateway_approval',
        metadata: {
          approvalId: 'appr-1',
          approvalStatus: 'approved',
          requestedAction: 'deploy.production',
          taskId: 'task-1',
        },
      });
      expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
        metadata: {
          evidenceItemId: 'evidence-approval-1',
        },
      });
      expect(deps.orchestrator.boss.send).toHaveBeenCalledWith('task.resume', {
        taskId: 'task-1',
        workspaceId: 'ws-1',
        context: expect.stringContaining('deploy.production'),
      });
    });

    it('fails closed before resume when approval evidence cannot be persisted', async () => {
      const deps = createMockDeps();
      const approval = {
        id: 'appr-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        action: 'deploy.production',
        status: 'approved',
        resolvedBy: 'unknown',
        resolvedAt: new Date().toISOString(),
      };

      deps.db.insert = vi.fn((table: unknown) => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => {
            if (table === evidenceItems) throw new Error('evidence unavailable');
            return [];
          }),
          then: (r: any) => r([]),
        })),
      })) as any;
      deps.db.update = vi.fn((table: unknown) => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => (table === approvals ? [approval] : [])),
            then: (r: any) => r([]),
          })),
        })),
      })) as any;

      const { fetch } = testApp(auditRoutes, deps);
      const res = await fetch('PUT', '/approvals/appr-1', { status: 'approved' }, wsHeader);
      const body = await expectJson<{ error: string }>(res, 500);

      expect(body.error).toBe('Failed to resolve approval');
      expect(deps.orchestrator.boss.send).not.toHaveBeenCalled();
    });

    it('does not trigger boss.send when approval is rejected', async () => {
      const deps = createMockDeps();
      const approval = {
        id: 'appr-1',
        taskId: 'task-1',
        workspaceId: 'ws-1',
        action: 'deploy.production',
        status: 'rejected',
        resolvedBy: 'unknown',
        resolvedAt: new Date().toISOString(),
      };

      deps.db.insert = vi.fn((table: unknown) => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () =>
            table === evidenceItems ? [{ id: 'evidence-approval-2' }] : [],
          ),
          then: (r: any) => r([]),
        })),
      })) as any;
      deps.db.update = vi.fn((table: unknown) => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => (table === approvals ? [approval] : [])),
            then: (r: any) => r([]),
          })),
        })),
      })) as any;

      const { fetch } = testApp(auditRoutes, deps);
      const res = await fetch('PUT', '/approvals/appr-1', { status: 'rejected' }, wsHeader);
      await expectJson(res, 200);

      expect(deps.orchestrator.boss.send).not.toHaveBeenCalled();
    });

    it('surfaces approved managed Telegram send failures instead of swallowing them', async () => {
      const managedTelegram = {
        sendApprovedMessage: vi.fn(async () => {
          throw new Error('telegram send failed');
        }),
      };
      const deps = createMockDeps({ managedTelegram } as never);
      const approval = {
        id: 'appr-telegram-1',
        taskId: null,
        workspaceId: 'ws-1',
        action: 'TELEGRAM_CHILD_SEND_MESSAGE',
        status: 'approved',
        resolvedBy: 'unknown',
        resolvedAt: new Date().toISOString(),
      };

      deps.db.insert = vi.fn((table: unknown) => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () =>
            table === evidenceItems ? [{ id: 'evidence-approval-telegram-1' }] : [],
          ),
          then: (r: any) => r([]),
        })),
      })) as any;
      deps.db.update = vi.fn((table: unknown) => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({
            returning: vi.fn(async () => (table === approvals ? [approval] : [])),
            then: (r: any) => r([]),
          })),
        })),
      })) as any;

      const { fetch } = testApp(auditRoutes, deps);
      const res = await fetch(
        'PUT',
        '/approvals/appr-telegram-1',
        { status: 'approved' },
        wsHeader,
      );
      const body = await expectJson<{ error: string }>(res, 502);

      expect(body.error).toBe('Failed to send approved managed Telegram message');
      expect(managedTelegram.sendApprovedMessage).toHaveBeenCalledWith('appr-telegram-1');
      expect(deps.orchestrator.boss.send).not.toHaveBeenCalled();
    });
  });

  // ── GET /violations ──

  describe('GET /violations', () => {
    it('returns 400 when workspaceId is missing', async () => {
      const { fetch } = testApp(auditRoutes);
      const res = await fetch('GET', '/violations');
      const body = await expectJson<{ error: string }>(res, 400);
      expect(body.error).toContain('workspaceId');
    });

    it('returns violations for a workspace', async () => {
      const deps = createMockDeps();
      const violations = [
        { id: 'v-1', workspaceId: 'ws-1', rule: 'no-prod-delete', severity: 'high' },
      ];
      deps.db._setResult(violations);

      const { fetch } = testApp(auditRoutes, deps);
      const res = await fetch('GET', '/violations', undefined, wsHeader);
      const body = await expectJson<unknown[]>(res, 200);
      expect(body).toEqual(violations);
    });
  });
});
