import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  auditLog,
  browserObservations,
  computerActions,
  evidenceItems,
  evidencePacks,
} from '@pilot/db/schema';
import type { Db } from '@pilot/db/client';
import {
  PRODUCTION_READY_EXECUTION_MODE,
  type ExecutePilotEvalInput,
  type RecordPilotEvalRunInput,
} from '@pilot/shared/eval';

type TrustedRealExternalEvalInput = ExecutePilotEvalInput & {
  workspaceId: string;
  executionMode: typeof PRODUCTION_READY_EXECUTION_MODE;
};

type ProductionEvalRunner = {
  execute(input: TrustedRealExternalEvalInput): Promise<{
    run: RecordPilotEvalRunInput;
    blockers?: string[];
  }>;
};

type ComputerActionRow = typeof computerActions.$inferSelect;
type BrowserObservationRow = typeof browserObservations.$inferSelect;
type EvidencePackRow = typeof evidencePacks.$inferSelect;
type EvidenceItemRow = typeof evidenceItems.$inferSelect;
type AuditRow = typeof auditLog.$inferSelect;

const SAFE_COMPUTER_ACTIONS = new Set([
  'terminal_command',
  'file_read',
  'file_write',
  'dev_server_status',
]);
const BROWSER_CREDENTIAL_BOUNDARY = 'read_only_no_cookie_or_password_export';

export function createProductionEvalRunner(db: Db): ProductionEvalRunner {
  return {
    async execute(input) {
      if (input.evalId === 'safe_computer_sandbox_action') {
        return executeSafeComputerSandboxEval(db, input);
      }
      if (input.evalId === 'yc_logged_in_browser_extraction') {
        return executeYcLoggedInBrowserExtractionEval(db, input);
      }
      if (input.evalId === 'helm_governance') {
        return executeHelmGovernanceEval(db, input);
      }
      return failedRun(
        input,
        `No trusted real_external_eval runner is implemented for ${input.evalId}`,
      );
    },
  };
}

async function executeHelmGovernanceEval(
  db: Db,
  input: TrustedRealExternalEvalInput,
): Promise<{ run: RecordPilotEvalRunInput }> {
  const packs = await db
    .select()
    .from(evidencePacks)
    .where(eq(evidencePacks.workspaceId, input.workspaceId))
    .orderBy(desc(evidencePacks.receivedAt))
    .limit(200);

  const allowed = packs.find(isAllowedHelmReceiptPack);
  const deniedOrEscalated = packs.find(isDeniedOrEscalatedHelmReceiptPack);
  if (!allowed) {
    return failedRun(
      input,
      'HELM Governance Eval requires a durable ALLOW HELM receipt with policy version, decision hash, and workspace principal',
    );
  }
  if (!deniedOrEscalated) {
    return failedRun(
      input,
      'HELM Governance Eval requires a durable DENY or ESCALATE HELM receipt for restricted/high-risk behavior',
    );
  }

  const receiptPacks = [allowed, deniedOrEscalated];
  const evidenceRows = await db
    .select()
    .from(evidenceItems)
    .where(
      and(
        eq(evidenceItems.workspaceId, input.workspaceId),
        inArray(
          evidenceItems.evidencePackId,
          receiptPacks.map((pack) => pack.id),
        ),
      ),
    )
    .orderBy(desc(evidenceItems.observedAt))
    .limit(50);

  const allowedEvidence = findHelmReceiptEvidence(evidenceRows, allowed);
  const deniedEvidence = findHelmReceiptEvidence(evidenceRows, deniedOrEscalated);
  if (!allowedEvidence) {
    return failedRun(
      input,
      `Allowed HELM receipt ${allowed.decisionId} has no audit-linked helm_receipt evidence_items row`,
    );
  }
  if (!deniedEvidence) {
    return failedRun(
      input,
      `Restricted HELM receipt ${deniedOrEscalated.decisionId} has no audit-linked helm_receipt evidence_items row`,
    );
  }

  const auditIds = [allowedEvidence.auditEventId, deniedEvidence.auditEventId].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
  if (auditIds.length < 2) {
    return failedRun(
      input,
      'HELM Governance Eval requires audit-linked evidence for both receipt outcomes',
    );
  }

  const audits = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, input.workspaceId), inArray(auditLog.id, auditIds)))
    .limit(auditIds.length);
  const allowedAudit = findHelmReceiptAudit(audits, allowedEvidence.auditEventId, allowed);
  const deniedAudit = findHelmReceiptAudit(audits, deniedEvidence.auditEventId, deniedOrEscalated);
  if (!allowedAudit) {
    return failedRun(
      input,
      `Allowed HELM receipt evidence ${allowedEvidence.id} has no matching HELM_RECEIPT_PERSISTED audit row`,
    );
  }
  if (!deniedAudit) {
    return failedRun(
      input,
      `Restricted HELM receipt evidence ${deniedEvidence.id} has no matching HELM_RECEIPT_PERSISTED audit row`,
    );
  }

  const allowedEvidenceRef = evidenceRef(allowedEvidence);
  const deniedEvidenceRef = evidenceRef(deniedEvidence);
  const allowedAuditRef = auditRef(allowedAudit);
  const deniedAuditRef = auditRef(deniedAudit);
  const completedAt = new Date().toISOString();
  return {
    run: {
      workspaceId: input.workspaceId,
      evalId: 'helm_governance',
      status: 'passed',
      capabilityKey: input.capabilityKey ?? 'helm_receipts',
      runRef: input.runRef ?? `real-external-eval:helm-governance:${randomUUID()}`,
      summary:
        'HELM governance eval verified durable allowed and restricted receipt outcomes with receipt sink rows, linked evidence, and audit ledger entries.',
      evidenceRefs: [allowedEvidenceRef, deniedEvidenceRef],
      auditReceiptRefs: [allowedAuditRef, deniedAuditRef],
      metadata: {
        runnerRef: 'gateway:helm_governance:v1',
        verifiedEvidencePackIds: receiptPacks.map((pack) => pack.id),
        verifiedDecisionIds: receiptPacks.map((pack) => pack.decisionId),
        verifiedEvidenceItemIds: [allowedEvidence.id, deniedEvidence.id],
        verifiedAuditEventIds: [allowedAudit.id, deniedAudit.id],
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
      completedAt,
      steps: [
        {
          stepKey: 'allowed-helm-receipt-evidence',
          status: 'passed',
          evidenceRefs: [allowedEvidenceRef],
          auditReceiptRefs: [allowedAuditRef],
          completedAt,
          metadata: helmReceiptStepMetadata(allowed),
        },
        {
          stepKey: 'restricted-helm-receipt-evidence',
          status: 'passed',
          evidenceRefs: [deniedEvidenceRef],
          auditReceiptRefs: [deniedAuditRef],
          completedAt,
          metadata: helmReceiptStepMetadata(deniedOrEscalated),
        },
      ],
    },
  };
}

async function executeYcLoggedInBrowserExtractionEval(
  db: Db,
  input: TrustedRealExternalEvalInput,
): Promise<{ run: RecordPilotEvalRunInput }> {
  const rows = await db
    .select()
    .from(browserObservations)
    .where(eq(browserObservations.workspaceId, input.workspaceId))
    .orderBy(desc(browserObservations.observedAt))
    .limit(100);

  const observation = rows.find(isYcLoggedInBrowserObservation);
  if (!observation) {
    return failedRun(
      input,
      'YC Logged-In Browser Extraction Eval requires a durable YC browser observation with DOM hash, screenshot reference, extracted fields, redacted DOM, and replay metadata',
    );
  }

  const evidenceRows = await db
    .select()
    .from(evidenceItems)
    .where(
      and(
        eq(evidenceItems.workspaceId, input.workspaceId),
        eq(evidenceItems.browserObservationId, observation.id),
      ),
    )
    .orderBy(desc(evidenceItems.observedAt))
    .limit(10);

  const evidence = evidenceRows.find(findBrowserEvidence);
  if (!evidence) {
    return failedRun(
      input,
      `YC browser observation ${observation.id} has no linked browser_observation evidence_items row`,
    );
  }
  if (!evidence.auditEventId) {
    return failedRun(
      input,
      `YC browser observation evidence ${evidence.id} is missing an audit_event_id link`,
    );
  }

  const audits = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, input.workspaceId), eq(auditLog.id, evidence.auditEventId)))
    .limit(1);
  const audit = audits.find(
    (row) =>
      row.id === evidence.auditEventId &&
      row.action === 'BROWSER_OBSERVATION_CAPTURED' &&
      row.target === observation.id &&
      row.verdict === 'allow' &&
      hasMetadataString(row.metadata, 'helmDecisionId') &&
      hasMetadataString(row.metadata, 'helmPolicyVersion'),
  );
  if (!audit) {
    return failedRun(
      input,
      `YC browser observation evidence ${evidence.id} has no matching BROWSER_OBSERVATION_CAPTURED audit row`,
    );
  }

  const evidenceReference = evidenceRef(evidence);
  const auditReference = auditRef(audit);
  const completedAt = new Date().toISOString();
  return {
    run: {
      workspaceId: input.workspaceId,
      evalId: 'yc_logged_in_browser_extraction',
      status: 'passed',
      capabilityKey: input.capabilityKey ?? 'browser_execution',
      runRef: input.runRef ?? `real-external-eval:yc-browser:${randomUUID()}`,
      summary:
        'YC browser eval verified a durable logged-in read/extract observation with redacted DOM, DOM hash, screenshot metadata, extracted fields, replay reference, evidence, and audit receipt.',
      evidenceRefs: [evidenceReference],
      auditReceiptRefs: [auditReference],
      metadata: {
        runnerRef: 'gateway:yc_logged_in_browser_extraction:v1',
        verifiedBrowserObservationId: observation.id,
        verifiedEvidenceItemId: evidence.id,
        verifiedAuditEventId: audit.id,
        origin: observation.origin,
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
      completedAt,
      steps: [
        {
          stepKey: 'yc-browser-read-extract-evidence',
          status: 'passed',
          evidenceRefs: [evidenceReference],
          auditReceiptRefs: [auditReference],
          completedAt,
          metadata: {
            browserObservationId: observation.id,
            sessionId: observation.sessionId,
            grantId: observation.grantId,
            domHash: observation.domHash,
            screenshotHash: observation.screenshotHash,
            screenshotRef: observation.screenshotRef,
            redactionCount: observation.redactions.length,
          },
        },
      ],
    },
  };
}

async function executeSafeComputerSandboxEval(
  db: Db,
  input: TrustedRealExternalEvalInput,
): Promise<{ run: RecordPilotEvalRunInput }> {
  const rows = await db
    .select()
    .from(computerActions)
    .where(
      and(
        eq(computerActions.workspaceId, input.workspaceId),
        inArray(computerActions.status, ['completed', 'denied']),
      ),
    )
    .orderBy(desc(computerActions.createdAt))
    .limit(100);

  const completed = rows.find(isCompletedSafeComputerAction);
  const denied = rows.find(isDeniedRestrictedComputerAction);
  if (!completed) {
    return failedRun(
      input,
      'Safe Computer/Sandbox Action Eval requires a completed safe computer action with policy metadata, output hash, and completion timestamp',
    );
  }
  if (!denied) {
    return failedRun(
      input,
      'Safe Computer/Sandbox Action Eval requires a denied restricted-path or destructive computer action with policy metadata',
    );
  }

  const actionIds = [completed.id, denied.id];
  const evidenceRows = await db
    .select()
    .from(evidenceItems)
    .where(
      and(
        eq(evidenceItems.workspaceId, input.workspaceId),
        inArray(evidenceItems.computerActionId, actionIds),
      ),
    )
    .orderBy(desc(evidenceItems.observedAt))
    .limit(25);

  const completedEvidence = findComputerEvidence(evidenceRows, completed.id);
  const deniedEvidence = findComputerEvidence(evidenceRows, denied.id);
  if (!completedEvidence) {
    return failedRun(
      input,
      `Completed computer action ${completed.id} has no linked evidence_items row`,
    );
  }
  if (!deniedEvidence) {
    return failedRun(input, `Denied computer action ${denied.id} has no linked evidence_items row`);
  }

  const auditIds = [completedEvidence.auditEventId, deniedEvidence.auditEventId].filter(
    (id): id is string => typeof id === 'string' && id.length > 0,
  );
  if (auditIds.length < 2) {
    return {
      run: failedRun(
        input,
        'Safe Computer/Sandbox Action Eval requires audit-linked evidence for completed and denied computer actions',
      ).run,
    };
  }

  const audits = await db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.workspaceId, input.workspaceId), inArray(auditLog.id, auditIds)))
    .limit(auditIds.length);
  const completedAudit = findComputerAudit(audits, completedEvidence.auditEventId);
  const deniedAudit = findComputerAudit(audits, deniedEvidence.auditEventId);
  if (!completedAudit) {
    return failedRun(
      input,
      `Completed computer action evidence ${completedEvidence.id} has no matching audit row`,
    );
  }
  if (!deniedAudit) {
    return failedRun(
      input,
      `Denied computer action evidence ${deniedEvidence.id} has no matching audit row`,
    );
  }

  const completedEvidenceRef = evidenceRef(completedEvidence);
  const deniedEvidenceRef = evidenceRef(deniedEvidence);
  const completedAuditRef = auditRef(completedAudit);
  const deniedAuditRef = auditRef(deniedAudit);
  const completedAt = new Date().toISOString();

  return {
    run: {
      workspaceId: input.workspaceId,
      evalId: 'safe_computer_sandbox_action',
      status: 'passed',
      capabilityKey: input.capabilityKey ?? 'computer_use',
      runRef: input.runRef ?? `real-external-eval:safe-computer:${randomUUID()}`,
      summary:
        'Safe computer eval verified completed safe action evidence and restricted-action denial evidence from durable computer_actions, evidence_items, and audit_log rows.',
      evidenceRefs: [completedEvidenceRef, deniedEvidenceRef],
      auditReceiptRefs: [completedAuditRef, deniedAuditRef],
      metadata: {
        runnerRef: 'gateway:safe_computer_sandbox_action:v1',
        verifiedComputerActionIds: actionIds,
        verifiedEvidenceItemIds: [completedEvidence.id, deniedEvidence.id],
        verifiedAuditEventIds: [completedAudit.id, deniedAudit.id],
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
      completedAt,
      steps: [
        {
          stepKey: 'completed-safe-action-evidence',
          status: 'passed',
          evidenceRefs: [completedEvidenceRef],
          auditReceiptRefs: [completedAuditRef],
          completedAt,
          metadata: {
            computerActionId: completed.id,
            actionType: completed.actionType,
            environment: completed.environment,
          },
        },
        {
          stepKey: 'restricted-action-denial-evidence',
          status: 'passed',
          evidenceRefs: [deniedEvidenceRef],
          auditReceiptRefs: [deniedAuditRef],
          completedAt,
          metadata: {
            computerActionId: denied.id,
            actionType: denied.actionType,
            environment: denied.environment,
          },
        },
      ],
    },
  };
}

function failedRun(
  input: TrustedRealExternalEvalInput,
  reason: string,
): { run: RecordPilotEvalRunInput } {
  return {
    run: {
      workspaceId: input.workspaceId,
      evalId: input.evalId,
      status: 'failed',
      capabilityKey: input.capabilityKey,
      runRef: input.runRef ?? `real-external-eval:${input.evalId}:${randomUUID()}`,
      failureReason: reason,
      summary: reason,
      evidenceRefs: [],
      auditReceiptRefs: [],
      metadata: {
        runnerRef: 'gateway:production-eval-runner:v1',
        executionMode: PRODUCTION_READY_EXECUTION_MODE,
      },
      completedAt: new Date().toISOString(),
      steps: [],
    },
  };
}

function isCompletedSafeComputerAction(row: ComputerActionRow): boolean {
  return (
    row.status === 'completed' &&
    SAFE_COMPUTER_ACTIONS.has(row.actionType) &&
    row.exitCode === 0 &&
    Boolean(row.completedAt) &&
    Boolean(row.outputHash) &&
    hasPolicyMetadata(row)
  );
}

function isDeniedRestrictedComputerAction(row: ComputerActionRow): boolean {
  return (
    row.status === 'denied' &&
    SAFE_COMPUTER_ACTIONS.has(row.actionType) &&
    Boolean(row.completedAt) &&
    hasPolicyMetadata(row) &&
    /restricted|denied|outside|destructive/iu.test(row.stderr ?? '')
  );
}

function isYcLoggedInBrowserObservation(row: BrowserObservationRow): boolean {
  return (
    isYcUrl(row.url, row.origin) &&
    Boolean(row.domHash) &&
    Boolean(row.redactedDomSnapshot) &&
    Boolean(row.replayIndex !== null && row.replayIndex !== undefined) &&
    (Boolean(row.screenshotHash) || Boolean(row.screenshotRef)) &&
    isRecord(row.extractedData) &&
    Object.keys(row.extractedData).length > 0 &&
    Array.isArray(row.redactions) &&
    hasMetadataValue(row.metadata, 'credentialBoundary', BROWSER_CREDENTIAL_BOUNDARY) &&
    hasMetadataString(row.metadata, 'helmDecisionId') &&
    hasMetadataString(row.metadata, 'helmPolicyVersion')
  );
}

function isAllowedHelmReceiptPack(row: EvidencePackRow): boolean {
  return isCompleteHelmReceiptPack(row) && normalizeVerdict(row.verdict) === 'allow';
}

function isDeniedOrEscalatedHelmReceiptPack(row: EvidencePackRow): boolean {
  const verdict = normalizeVerdict(row.verdict);
  return isCompleteHelmReceiptPack(row) && (verdict === 'deny' || verdict === 'escalate');
}

function isCompleteHelmReceiptPack(row: EvidencePackRow): boolean {
  return (
    Boolean(row.decisionId) &&
    Boolean(row.policyVersion) &&
    isDecisionHash(row.decisionHash) &&
    Boolean(row.action) &&
    Boolean(row.resource) &&
    row.principal.startsWith(`workspace:${row.workspaceId}`)
  );
}

function isYcUrl(url: string, origin: string): boolean {
  return [url, origin].some((value) => {
    try {
      const parsed = new URL(value);
      const hostname = parsed.hostname.toLowerCase();
      return hostname === 'ycombinator.com' || hostname.endsWith('.ycombinator.com');
    } catch {
      return false;
    }
  });
}

function hasPolicyMetadata(row: ComputerActionRow): boolean {
  return (
    Boolean(row.policyDecisionId) &&
    Boolean(row.policyVersion) &&
    isRecord(row.helmDocumentVersionPins) &&
    Object.keys(row.helmDocumentVersionPins).length > 0
  );
}

function findBrowserEvidence(row: EvidenceItemRow): boolean {
  return Boolean(
    row.browserObservationId &&
    row.evidenceType === 'browser_observation' &&
    row.auditEventId &&
    row.replayRef &&
    hasMetadataValue(row.metadata, 'credentialBoundary', BROWSER_CREDENTIAL_BOUNDARY) &&
    hasMetadataString(row.metadata, 'helmDecisionId') &&
    hasMetadataString(row.metadata, 'helmPolicyVersion'),
  );
}

function findHelmReceiptEvidence(
  rows: EvidenceItemRow[],
  pack: EvidencePackRow,
): EvidenceItemRow | undefined {
  return rows.find(
    (row) =>
      row.evidencePackId === pack.id &&
      row.evidenceType === 'helm_receipt' &&
      row.auditEventId &&
      row.replayRef === `helm:${pack.decisionId}` &&
      row.contentHash === pack.decisionHash &&
      hasMetadataValue(row.metadata, 'decisionId', pack.decisionId) &&
      hasMetadataValue(row.metadata, 'policyVersion', pack.policyVersion) &&
      hasMetadataValue(row.metadata, 'action', pack.action) &&
      hasMetadataValue(row.metadata, 'resource', pack.resource) &&
      hasMetadataValue(row.metadata, 'principal', pack.principal),
  );
}

function findComputerEvidence(
  rows: EvidenceItemRow[],
  computerActionId: string,
): EvidenceItemRow | undefined {
  return rows.find(
    (row) =>
      row.computerActionId === computerActionId &&
      row.evidenceType === 'computer_action' &&
      row.auditEventId &&
      row.replayRef,
  );
}

function findHelmReceiptAudit(
  rows: AuditRow[],
  auditEventId: string | null,
  pack: EvidencePackRow,
): AuditRow | undefined {
  if (!auditEventId) return undefined;
  return rows.find(
    (row) =>
      row.id === auditEventId &&
      row.action === 'HELM_RECEIPT_PERSISTED' &&
      row.target === pack.decisionId &&
      normalizeVerdict(row.verdict) === normalizeVerdict(pack.verdict) &&
      hasMetadataValue(row.metadata, 'evidencePackId', pack.id) &&
      hasMetadataValue(row.metadata, 'decisionId', pack.decisionId) &&
      hasMetadataValue(row.metadata, 'policyVersion', pack.policyVersion) &&
      hasMetadataValue(row.metadata, 'action', pack.action) &&
      hasMetadataValue(row.metadata, 'resource', pack.resource) &&
      hasMetadataValue(row.metadata, 'principal', pack.principal),
  );
}

function findComputerAudit(rows: AuditRow[], auditEventId: string | null): AuditRow | undefined {
  if (!auditEventId) return undefined;
  return rows.find((row) => row.id === auditEventId && row.action === 'OPERATOR_COMPUTER_USE');
}

function evidenceRef(row: EvidenceItemRow): string {
  return row.replayRef ?? `evidence:${row.id}`;
}

function auditRef(row: AuditRow): string {
  return `audit:${row.id}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasMetadataString(metadata: unknown, key: string): boolean {
  return isRecord(metadata) && typeof metadata[key] === 'string' && metadata[key].length > 0;
}

function hasMetadataValue(metadata: unknown, key: string, expected: string): boolean {
  return isRecord(metadata) && metadata[key] === expected;
}

function normalizeVerdict(verdict: string): string {
  return verdict.trim().toLowerCase();
}

function isDecisionHash(value: string | null): boolean {
  return typeof value === 'string' && /^[a-f0-9]{32,}$/u.test(value);
}

function helmReceiptStepMetadata(pack: EvidencePackRow): Record<string, string | null> {
  return {
    evidencePackId: pack.id,
    decisionId: pack.decisionId,
    verdict: pack.verdict,
    policyVersion: pack.policyVersion,
    action: pack.action,
    resource: pack.resource,
    decisionHash: pack.decisionHash,
  };
}
