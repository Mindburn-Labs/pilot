import {
  pgTable,
  uuid,
  text,
  integer,
  timestamp,
  doublePrecision,
  primaryKey,
  index,
  jsonb,
} from 'drizzle-orm/pg-core';
import { workspaces } from './workspace.js';

// ─── Tenancy Domain ───
//
// Per-tenant secret envelopes. Each row stores an AES-256-GCM ciphertext whose
// DEK is derived per `(workspaceId, kind)` via HKDF-SHA256 over the master
// ENCRYPTION_KEY — see packages/shared/src/secrets. Plaintext is never
// persisted; reads re-derive the DEK on demand, so:
//
//   - Cross-tenant leak is cryptographically impossible (DEK is keyed by
//     workspaceId; trying to decrypt A's blob while passing B's workspaceId
//     yields an auth-tag failure).
//   - Rotation is additive: new master version → new keyVersion → in-place
//     re-encrypt (see scripts/rotate-master-key.ts).
//   - Admins running SQL against the DB see only opaque ciphertext.
//
// Kinds are free-form text so new connector types can register without a
// schema migration, but the canonical enum lives in shared/src/secrets.
export const tenantSecrets = pgTable(
  'tenant_secrets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** e.g. `llm_openrouter_key`, `telegram_bot_token`, `connector_gmail`. */
    kind: text('kind').notNull(),
    /** AES-256-GCM envelope: iv(12) || ciphertext || auth_tag(16), base64-encoded. */
    encryptedBlob: text('encrypted_blob').notNull(),
    /** Master-key version used to derive the DEK. Increments on rotation. */
    keyVersion: integer('key_version').notNull().default(1),
    /** Optional wall-clock expiry — reads past this return null (no-decrypt). */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('tenant_secrets_workspace_idx').on(table.workspaceId)],
);

// ─── Rate-limit buckets (Phase 2c) ────────────────────────────────────────
//
// Token-bucket state for tenant-partitioned rate limiting. Each row tracks
// a single (subject, routeClass) pair:
//   - subject     — either a workspaceId UUID, a userId UUID, or an IP for
//                   unauthenticated paths. Free-form text so all three fit.
//   - routeClass  — 'auth' | 'task' | 'connector_oauth' | 'default' |
//                   'llm_inference' | etc. Keyed so different route families
//                   can have different ceilings.
//   - tokens      — current bucket level (float; refilled lazily on read).
//   - capacity    — max bucket size (= burst allowance).
//   - refillPerSec — steady-state refill rate.
//   - lastRefillAt — wall clock of the last refill; the next query computes
//                    elapsed seconds to advance the bucket.
//
// Postgres MVCC serializes concurrent UPDATEs on the same (subject, routeClass)
// so two parallel requests can't both consume the last token. See
// services/gateway/src/middleware/rate-limit.ts for the atomic consume SQL.
export const rateLimitBuckets = pgTable(
  'ratelimit_buckets',
  {
    subject: text('subject').notNull(),
    routeClass: text('route_class').notNull(),
    tokens: doublePrecision('tokens').notNull(),
    capacity: doublePrecision('capacity').notNull(),
    refillPerSec: doublePrecision('refill_per_sec').notNull(),
    lastRefillAt: timestamp('last_refill_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.subject, t.routeClass] })],
);

// ─── Tenant lifecycle (Phase 2d) ──────────────────────────────────────────
//
// Soft-delete tracking. Keeping the mark on a separate table (rather than a
// column on `workspaces`) means existing workspace queries don't need to
// learn about soft-delete — the admin surface consults this table
// explicitly, and a pg-boss cron issues the hard delete (cascade-cleanup of
// every workspace-scoped row) once `hardDeleteAfter` passes.
export const workspaceDeletions = pgTable(
  'workspace_deletions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' })
      .unique(),
    softDeletedAt: timestamp('soft_deleted_at', { withTimezone: true }).notNull().defaultNow(),
    /** Platform-admin user that initiated the delete. */
    softDeletedBy: uuid('soft_deleted_by'),
    reason: text('reason'),
    /** Wall clock past which the cleanup cron issues the hard delete. */
    hardDeleteAfter: timestamp('hard_delete_after', { withTimezone: true }).notNull(),
    hardDeletedAt: timestamp('hard_deleted_at', { withTimezone: true }),
  },
  (t) => [index('workspace_deletions_hard_idx').on(t.hardDeleteAfter, t.hardDeletedAt)],
);

// Retained hard-delete receipts deliberately do not reference `workspaces`.
// They must survive the cascading tenant delete while avoiding retained
// workspace data beyond the minimum redacted proof needed for audit.
export const tenantDeletionReceipts = pgTable(
  'tenant_deletion_receipts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    deletionId: uuid('deletion_id'),
    workspaceName: text('workspace_name'),
    source: text('source').notNull(),
    actor: text('actor').notNull(),
    reason: text('reason'),
    softDeletedAt: timestamp('soft_deleted_at', { withTimezone: true }),
    hardDeleteAfter: timestamp('hard_delete_after', { withTimezone: true }),
    hardDeletedAt: timestamp('hard_deleted_at', { withTimezone: true }).notNull().defaultNow(),
    replayRef: text('replay_ref').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tenant_deletion_receipts_workspace_idx').on(t.workspaceId),
    index('tenant_deletion_receipts_created_idx').on(t.createdAt),
  ],
);
