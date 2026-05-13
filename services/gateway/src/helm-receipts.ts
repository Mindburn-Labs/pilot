import { randomUUID } from 'node:crypto';
import { appendEvidenceItem } from '@pilot/db';
import { type Db } from '@pilot/db/client';
import { auditLog, evidencePacks } from '@pilot/db/schema';
import { type HelmReceipt } from '@pilot/helm-client';

export async function persistHelmReceipt(db: Db, receipt: HelmReceipt) {
  const workspaceId = extractWorkspaceIdFromPrincipal(receipt.principal);
  if (!workspaceId) {
    throw new Error(
      `Cannot persist HELM receipt without workspace principal: ${receipt.principal}`,
    );
  }

  await db.transaction(async (tx) => {
    const receiptDb = tx as unknown as Db;
    const auditEventId = randomUUID();
    const [pack] = await receiptDb
      .insert(evidencePacks)
      .values({
        workspaceId,
        decisionId: receipt.decisionId,
        verdict: receipt.verdict,
        reasonCode: receipt.reason ?? null,
        policyVersion: receipt.policyVersion,
        decisionHash: receipt.decisionHash ?? null,
        action: receipt.action,
        resource: receipt.resource,
        principal: receipt.principal,
        signedBlob: receipt.signedBlob ?? null,
        receivedAt: receipt.receivedAt,
      })
      .returning({ id: evidencePacks.id });

    if (!pack?.id) {
      throw new Error(`Cannot index HELM receipt evidence: ${receipt.decisionId}`);
    }

    await receiptDb.insert(auditLog).values({
      id: auditEventId,
      workspaceId,
      action: 'HELM_RECEIPT_PERSISTED',
      actor: 'helm-client',
      target: receipt.decisionId,
      verdict: receipt.verdict,
      reason: receipt.reason ?? null,
      metadata: {
        evidencePackId: pack.id,
        decisionId: receipt.decisionId,
        verdict: receipt.verdict,
        policyVersion: receipt.policyVersion,
        action: receipt.action,
        resource: receipt.resource,
        principal: receipt.principal,
        receiptId: receipt.receiptId ?? null,
      },
    });

    await appendEvidenceItem(receiptDb, {
      workspaceId,
      auditEventId,
      evidencePackId: pack.id,
      evidenceType: 'helm_receipt',
      sourceType: 'helm_client',
      title: `HELM ${receipt.action} ${receipt.verdict}`,
      summary: receipt.reason ?? `${receipt.action} on ${receipt.resource}`,
      redactionState: 'redacted',
      sensitivity: 'internal',
      contentHash: receipt.decisionHash ?? null,
      replayRef: `helm:${receipt.decisionId}`,
      observedAt: receipt.receivedAt,
      metadata: {
        decisionId: receipt.decisionId,
        verdict: receipt.verdict,
        policyVersion: receipt.policyVersion,
        action: receipt.action,
        resource: receipt.resource,
        principal: receipt.principal,
        receiptId: receipt.receiptId ?? null,
      },
    });
  });
}

function extractWorkspaceIdFromPrincipal(principal: string): string | null {
  return /^workspace:([^/]+)/u.exec(principal)?.[1] ?? null;
}
