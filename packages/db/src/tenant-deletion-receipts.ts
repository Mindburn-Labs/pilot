import type { Db } from './client.js';
import { tenantDeletionReceipts } from './schema/tenancy.js';

type TenantDeletionReceiptInsert = typeof tenantDeletionReceipts.$inferInsert;
type TenantDeletionReceiptDb = Pick<Db, 'insert'>;

export type AppendTenantDeletionReceiptInput = Pick<
  TenantDeletionReceiptInsert,
  'workspaceId' | 'source' | 'actor' | 'replayRef'
> &
  Partial<
    Omit<
      TenantDeletionReceiptInsert,
      'id' | 'workspaceId' | 'source' | 'actor' | 'replayRef' | 'createdAt'
    >
  >;

export async function appendTenantDeletionReceipt(
  db: TenantDeletionReceiptDb,
  input: AppendTenantDeletionReceiptInput,
): Promise<string> {
  const [row] = await db
    .insert(tenantDeletionReceipts)
    .values({
      ...input,
      metadata: input.metadata ?? {},
    })
    .returning({ id: tenantDeletionReceipts.id });

  if (!row?.id) {
    throw new Error('tenant_deletion_receipts insert did not return id');
  }

  return row.id;
}
