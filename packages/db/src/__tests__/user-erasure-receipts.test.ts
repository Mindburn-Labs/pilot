import { describe, expect, it, vi } from 'vitest';
import { userErasureReceipts } from '../schema/index.js';
import { appendUserErasureReceipt } from '../user-erasure-receipts.js';

describe('appendUserErasureReceipt', () => {
  it('inserts a retained user-erasure receipt without raw subject identifiers', async () => {
    const values = vi.fn(async (_value: Record<string, unknown>) => undefined);
    const db = {
      insert: vi.fn(() => ({ values })),
    };

    const id = await appendUserErasureReceipt(db, {
      subjectHash: 'sha256:subject-hash',
      source: 'gateway_user',
      actor: 'self-service',
      deletedWorkspaceCount: 2,
      workspaceSetHash: 'sha256:workspace-set',
      replayRef: 'user-erasure:subject-hash',
      metadata: {
        retainedAfterUserDelete: true,
        rawSubjectStored: false,
      },
    });

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(db.insert).toHaveBeenCalledWith(userErasureReceipts);
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        id,
        subjectHash: 'sha256:subject-hash',
        source: 'gateway_user',
        actor: 'self-service',
        deletedWorkspaceCount: 2,
        workspaceSetHash: 'sha256:workspace-set',
        replayRef: 'user-erasure:subject-hash',
        metadata: {
          retainedAfterUserDelete: true,
          rawSubjectStored: false,
        },
      }),
    );
    expect(JSON.stringify(values.mock.calls[0]?.[0])).not.toContain('user-123');
  });

  it('throws before returning an id when persistence fails', async () => {
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn(async () => {
          throw new Error('receipt unavailable');
        }),
      })),
    };

    await expect(
      appendUserErasureReceipt(db, {
        subjectHash: 'sha256:subject-hash',
        source: 'gateway_user',
        actor: 'self-service',
        replayRef: 'user-erasure:subject-hash',
      }),
    ).rejects.toThrow('receipt unavailable');
  });
});
