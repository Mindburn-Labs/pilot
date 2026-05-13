import { describe, expect, it, vi } from 'vitest';
import { auditLog, evidenceItems, evidencePacks } from '@pilot/db/schema';
import { persistHelmReceipt } from '../helm-receipts.js';
import { type HelmReceipt } from '@pilot/helm-client';

const receipt: HelmReceipt = {
  decisionId: 'dec-1',
  verdict: 'allow',
  reason: 'policy allowed',
  policyVersion: 'policy.v1',
  decisionHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  action: 'LLM_INFERENCE',
  resource: 'model:gpt-test',
  principal: 'workspace:00000000-0000-4000-8000-000000000001/operator:op-1',
  signedBlob: null,
  receivedAt: new Date('2026-05-06T00:00:00Z'),
  receiptId: 'receipt-1',
};

function makeReceiptDb(options: { failEvidenceItem?: boolean } = {}) {
  const committedInserts: Array<{ table: string; values: unknown }> = [];
  let idCounter = 1;

  const tableName = (table: unknown) => {
    if (table === evidencePacks) return 'evidencePacks';
    if (table === auditLog) return 'auditLog';
    if (table === evidenceItems) return 'evidenceItems';
    return 'unknown';
  };

  const makeInsert = (sink: Array<{ table: string; values: unknown }>) =>
    vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        if (options.failEvidenceItem && table === evidenceItems) {
          throw new Error('evidence item insert failed');
        }
        sink.push({ table: tableName(table), values });
        return {
          returning: vi.fn(async () => [{ id: `row-${idCounter++}` }]),
        };
      }),
    }));

  const db = {
    insert: makeInsert(committedInserts),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const stagedInserts: Array<{ table: string; values: unknown }> = [];
      const result = await callback({
        insert: makeInsert(stagedInserts),
      });
      committedInserts.push(...stagedInserts);
      return result;
    }),
  };

  return { db, committedInserts };
}

describe('persistHelmReceipt', () => {
  it('persists receipt pack and canonical evidence item together', async () => {
    const { db, committedInserts } = makeReceiptDb();

    await persistHelmReceipt(db as never, receipt);

    expect(committedInserts.map((entry) => entry.table)).toEqual([
      'evidencePacks',
      'auditLog',
      'evidenceItems',
    ]);
    expect(committedInserts[0]?.values).toMatchObject({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      decisionId: 'dec-1',
      action: 'LLM_INFERENCE',
    });
    expect(committedInserts[1]?.values).toMatchObject({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      action: 'HELM_RECEIPT_PERSISTED',
      target: 'dec-1',
      verdict: 'allow',
      metadata: {
        evidencePackId: 'row-1',
        decisionId: 'dec-1',
        policyVersion: 'policy.v1',
      },
    });
    expect(committedInserts[2]?.values).toMatchObject({
      workspaceId: '00000000-0000-4000-8000-000000000001',
      evidencePackId: 'row-1',
      auditEventId: expect.any(String),
      evidenceType: 'helm_receipt',
      replayRef: 'helm:dec-1',
    });
  });

  it('does not commit a receipt pack when canonical evidence persistence fails', async () => {
    const { db, committedInserts } = makeReceiptDb({ failEvidenceItem: true });

    await expect(persistHelmReceipt(db as never, receipt)).rejects.toThrow(
      'evidence item insert failed',
    );

    expect(committedInserts).toEqual([]);
  });
});
