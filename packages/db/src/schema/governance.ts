import { pgTable, uuid, text, timestamp, jsonb, integer, boolean, index } from 'drizzle-orm/pg-core';
import { workspaces } from './workspace.js';
import { taskRuns } from './tasking.js';

// ─── Governance Domain ───
//
// Materializes HELM governance records locally. Every tool call that crosses
// the HelmTrustBoundary records (a) a decision receipt from HELM and (b) an
// optional signed evidence pack that can be verified offline via Ed25519.
//
// This table is a local mirror. The authoritative proof graph lives inside
// helm-ai-kernel; Pilot fetches and caches to power the founder-facing Governance
// surface without blocking on HELM every query.

/**
 * Evidence Pack — local mirror of a HELM-signed receipt.
 *
 * Populated by HelmClient.onReceipt callbacks (see packages/helm-client) so
 * the founder can browse decisions under /api/governance/receipts/:workspaceId
 * without round-tripping to HELM every request.
 */
export const evidencePacks = pgTable(
  'evidence_packs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Upstream HELM decision ID (X-Helm-Decision-ID header). */
    decisionId: text('decision_id').notNull(),
    /** The `taskRuns` row this decision anchors, when the call was inside an agent loop. */
    taskRunId: uuid('task_run_id').references(() => taskRuns.id, { onDelete: 'set null' }),
    /** 'ALLOW' | 'DENY' | 'ESCALATE'. */
    verdict: text('verdict').notNull(),
    /** Canonical reason code or reason string from HELM. */
    reasonCode: text('reason_code'),
    /** Policy bundle version that produced this verdict (X-Helm-Policy-Version). */
    policyVersion: text('policy_version').notNull(),
    /** SHA-256 hash of the canonicalized decision payload (X-Helm-Decision-Hash). */
    decisionHash: text('decision_hash'),
    /** 'LLM_INFERENCE' | 'TOOL_USE' | ... */
    action: text('action').notNull(),
    /** Tool name or model identifier governed by this decision. */
    resource: text('resource').notNull(),
    /** Principal that HELM governed on Pilot's behalf (e.g. 'workspace:uuid/operator:engineering'). */
    principal: text('principal').notNull(),
    /** Full signed evidence blob when HELM returned one; schema is HELM-defined. */
    signedBlob: jsonb('signed_blob'),
    /** Wall-clock receive time in Pilot. */
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** When this mirror row was verified against the upstream HELM signature. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    /**
     * Phase 12 — governed-subagent lineage. When set, this pack is a
     * subagent's internal decision anchored to a parent pack (typically a
     * SUBAGENT_SPAWN pack emitted by the Conductor). The proof graph
     * becomes a DAG traversable via recursive CTE:
     *   WITH RECURSIVE chain AS (SELECT * FROM evidence_packs WHERE id = ?
     *   UNION ALL SELECT e.* FROM evidence_packs e
     *   JOIN chain c ON e.parent_evidence_pack_id = c.id)
     *   SELECT * FROM chain
     */
    parentEvidencePackId: uuid('parent_evidence_pack_id'),
  },
  (table) => [
    index('evidence_packs_workspace_idx').on(table.workspaceId),
    index('evidence_packs_decision_idx').on(table.decisionId),
    index('evidence_packs_task_run_idx').on(table.taskRunId),
    index('evidence_packs_received_idx').on(table.receivedAt),
    index('evidence_packs_parent_idx').on(table.parentEvidencePackId),
  ],
);

/**
 * Snapshot of HELM gateway health, captured by the orchestrator every N
 * seconds (default 60). Used by the governance dashboard + alerting.
 */
export const helmHealthSnapshots = pgTable(
  'helm_health_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
    gatewayOk: boolean('gateway_ok').notNull(),
    version: text('version'),
    latencyMs: integer('latency_ms').notNull(),
    error: text('error'),
  },
  (table) => [index('helm_health_checked_idx').on(table.checkedAt)],
);
