import { describe, expect, it, vi } from 'vitest';
import { tenantDeletionReceipts } from '../schema/tenancy.js';
import { appendTenantDeletionReceipt } from '../tenant-deletion-receipts.js';

describe('appendTenantDeletionReceipt', () => {
  it('inserts a retained non-cascading hard-delete receipt', async () => {
    const values = vi.fn(() => ({
      returning: vi.fn(async () => [{ id: 'receipt-1' }]),
    }));
    const db = {
      insert: vi.fn((table: unknown) => {
        expect(table).toBe(tenantDeletionReceipts);
        return { values };
      }),
    };

    const id = await appendTenantDeletionReceipt(db as never, {
      workspaceId: '00000000-0000-4000-8000-000000000101',
      deletionId: '00000000-0000-4000-8000-000000000201',
      source: 'gateway_admin',
      actor: 'platform-admin',
      replayRef: 'tenant-hard-delete:ws:deletion:gateway-admin',
      metadata: { retainedAfterWorkspaceDelete: true },
    });

    expect(id).toBe('receipt-1');
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: '00000000-0000-4000-8000-000000000101',
        source: 'gateway_admin',
        actor: 'platform-admin',
        replayRef: 'tenant-hard-delete:ws:deletion:gateway-admin',
        metadata: { retainedAfterWorkspaceDelete: true },
      }),
    );
  });

  it('fails when the insert does not return a receipt id', async () => {
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => []),
        })),
      })),
    };

    await expect(
      appendTenantDeletionReceipt(db as never, {
        workspaceId: '00000000-0000-4000-8000-000000000101',
        source: 'orchestrator_job',
        actor: 'job:tenant.hard-delete-sweep',
        replayRef: 'tenant-hard-delete:ws:deletion:scheduled-job',
      }),
    ).rejects.toThrow('tenant_deletion_receipts insert did not return id');
  });
});
