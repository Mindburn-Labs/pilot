import { randomUUID } from 'node:crypto';
import { userErasureReceipts } from './schema/index.js';

type UserErasureReceiptInsert = typeof userErasureReceipts.$inferInsert;
type UserErasureReceiptDb = {
  insert: (table: typeof userErasureReceipts) => {
    values: (value: UserErasureReceiptInsert) => Promise<unknown> | unknown;
  };
};

export type AppendUserErasureReceiptInput = Pick<
  UserErasureReceiptInsert,
  'subjectHash' | 'source' | 'actor' | 'replayRef'
> &
  Partial<
    Omit<
      UserErasureReceiptInsert,
      'id' | 'subjectHash' | 'source' | 'actor' | 'replayRef' | 'createdAt'
    >
  >;

export async function appendUserErasureReceipt(
  db: UserErasureReceiptDb,
  input: AppendUserErasureReceiptInput,
): Promise<string> {
  const id = randomUUID();
  await db.insert(userErasureReceipts).values({
    id,
    subjectHash: input.subjectHash,
    source: input.source,
    actor: input.actor,
    deletedWorkspaceCount: input.deletedWorkspaceCount ?? 0,
    workspaceSetHash: input.workspaceSetHash ?? null,
    replayRef: input.replayRef,
    metadata: input.metadata ?? {},
    requestedAt: input.requestedAt,
  });
  return id;
}
