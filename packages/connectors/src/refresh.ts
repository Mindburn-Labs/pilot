import { createHash, randomUUID } from 'node:crypto';
import type PgBoss from 'pg-boss';
import { and, eq, lt, sql } from 'drizzle-orm';
import { appendEvidenceItem } from '@pilot/db';
import type { Db } from '@pilot/db/client';
import { auditLog } from '@pilot/db/schema';
import { createLogger } from '@pilot/shared/logger';
import type { OAuthFlowManager } from './oauth.js';

const log = createLogger('connectors.refresh');

/**
 * OAuth token refresh background worker (Phase 13, Track B).
 *
 * Two pg-boss queues:
 *   - `connectors.refresh.tick`    — cron, fires every 60s, queries eligible
 *                                    grants and enqueues one `.grant` job
 *                                    per eligible grant.
 *   - `connectors.refresh.grant`   — worker, one invocation per grant. Uses
 *                                    a pg advisory lock so concurrent ticks
 *                                    of the same grant collapse into one
 *                                    network call. Routes outcomes:
 *                                      success  → reset attempts, clear err
 *                                      transient → bump attempts, log err
 *                                      permanent → set needs_reauth, notify
 *
 * Thresholds (SOTA, April 2026):
 *   PROACTIVE_WINDOW_MS = 30 * 60 * 1000     // refresh if expires <30m
 *   PERMANENT_AFTER_ATTEMPTS = 3             // set needs_reauth after 3 fails
 *   TICK_BATCH_LIMIT = 50                    // cap fan-out per tick
 */

export const PROACTIVE_WINDOW_MS = 30 * 60 * 1000;
export const PERMANENT_AFTER_ATTEMPTS = 3;
export const TICK_BATCH_LIMIT = 50;

const TICK_QUEUE = 'connectors.refresh.tick';
const GRANT_QUEUE = 'connectors.refresh.grant';
const TICK_CRON = '*/1 * * * *'; // every minute

export interface RefreshNotifier {
  reauthRequired(workspaceId: string, connectorName: string): Promise<void>;
}

export interface RefreshDeps {
  db: Db;
  oauth: OAuthFlowManager;
  notifier?: RefreshNotifier;
  now?: () => Date; // injectable for tests
}

/**
 * Register the refresh worker on an existing pg-boss instance. Idempotent —
 * safe to call on every gateway boot.
 */
export async function registerRefreshJobs(
  boss: PgBoss,
  deps: RefreshDeps,
): Promise<void> {
  // ─── Tick: enqueue grant jobs for rows approaching expiry ───
  await boss.createQueue(TICK_QUEUE).catch(() => {});
  await boss.createQueue(GRANT_QUEUE).catch(() => {});

  boss.work(TICK_QUEUE, async () => {
    const eligible = await selectEligibleGrants(deps);
    if (eligible.length === 0) return;
    log.info({ count: eligible.length }, 'Enqueueing refresh jobs');
    for (const row of eligible) {
      await boss.send(
        GRANT_QUEUE,
        { grantId: row.grantId, connectorId: row.connectorId },
        // singletonKey collapses repeat enqueues of the same grant within the
        // 60s window — at most one grant job per grant in flight.
        { singletonKey: `refresh:${row.grantId}` },
      );
    }
  });

  // ─── Grant: actually refresh one grant ───
  boss.work(
    GRANT_QUEUE,
    async (jobs: PgBoss.Job<{ grantId: string; connectorId: string }>[]) => {
      for (const job of jobs) {
        const { grantId, connectorId } = job.data;
        try {
          await refreshOneGrant(grantId, connectorId, deps);
        } catch (err) {
          // Non-fatal — pg-boss will retry per its own policy.
          log.error({ err, grantId }, 'Refresh handler crashed');
        }
      }
    },
  );

  try {
    await boss.schedule(TICK_QUEUE, TICK_CRON, {}, { tz: 'UTC' });
  } catch (err) {
    log.warn({ err }, 'Failed to schedule refresh tick — continuing');
  }

  log.info({ cron: TICK_CRON }, 'Connector token refresh worker registered');
}

async function selectEligibleGrants(deps: RefreshDeps): Promise<
  Array<{ grantId: string; connectorId: string; workspaceId: string }>
> {
  const now = (deps.now?.() ?? new Date()).getTime();
  const threshold = new Date(now + PROACTIVE_WINDOW_MS);

  const { connectorGrants, connectorTokens } = await import(
    '@pilot/db/schema'
  );

  // Join grants → tokens; filter on both sides.
  const rows = await deps.db
    .select({
      grantId: connectorGrants.id,
      connectorId: connectorGrants.connectorId,
      workspaceId: connectorGrants.workspaceId,
    })
    .from(connectorGrants)
    .innerJoin(connectorTokens, eq(connectorTokens.grantId, connectorGrants.id))
    .where(
      and(
        eq(connectorGrants.isActive, true),
        eq(connectorGrants.needsReauth, false),
        lt(connectorTokens.expiresAt, threshold),
      ),
    )
    .limit(TICK_BATCH_LIMIT);

  return rows;
}

async function refreshOneGrant(
  grantId: string,
  connectorId: string,
  deps: RefreshDeps,
): Promise<void> {
  const { connectorGrants, connectors } = await import('@pilot/db/schema');

  // Serialize concurrent refreshes of the same grant via pg advisory lock.
  // `pg_try_advisory_xact_lock` returns false if another session holds it —
  // we skip this invocation rather than block the worker.
  const lockKey = `refresh:${grantId}`;
  const lockResult = (await deps.db.execute(
    sql`SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS acquired`,
  )) as unknown as
    | { rows?: Array<{ acquired: boolean }> }
    | Array<{ acquired: boolean }>;
  const acquired = Array.isArray(lockResult)
    ? lockResult[0]?.acquired
    : lockResult.rows?.[0]?.acquired;
  if (acquired !== true) {
    log.info({ grantId }, 'Another worker holds the grant lock — skipping');
    return;
  }

  const [existing] = await deps.db
    .select({
      refreshAttempts: connectorGrants.refreshAttempts,
      workspaceId: connectorGrants.workspaceId,
    })
    .from(connectorGrants)
    .where(eq(connectorGrants.id, grantId))
    .limit(1);

  const access = await deps.oauth.refreshToken(grantId, connectorId);

  if (access) {
    // Success: clear error + reset attempts.
    await persistRefreshOutcome(deps, {
      workspaceId: existing?.workspaceId,
      grantId,
      connectorId,
      grantUpdate: {
        refreshAttempts: 0,
        lastRefreshError: null,
        needsReauth: false,
      },
      status: 'succeeded',
      attempts: 0,
      permanent: false,
      summary: 'Connector token refresh succeeded without raw token evidence.',
    });
    log.info({ grantId, connectorId }, 'Grant refreshed');
    return;
  }

  // Failure: bump attempts + classify.
  const attempts = (existing?.refreshAttempts ?? 0) + 1;
  const permanent = attempts >= PERMANENT_AFTER_ATTEMPTS;
  const errorMsg = permanent
    ? `Refresh failed after ${attempts} attempts — grant marked for re-auth`
    : `Refresh failed (attempt ${attempts}/${PERMANENT_AFTER_ATTEMPTS})`;

  await persistRefreshOutcome(deps, {
    workspaceId: existing?.workspaceId,
    grantId,
    connectorId,
    grantUpdate: {
      refreshAttempts: attempts,
      lastRefreshError: errorMsg,
      needsReauth: permanent,
    },
    status: 'failed',
    attempts,
    permanent,
    summary: errorMsg,
  });

  if (permanent && existing?.workspaceId && deps.notifier) {
    // Fetch connector name for the notification copy.
    const [conn] = await deps.db
      .select({ name: connectors.name })
      .from(connectors)
      .where(eq(connectors.id, connectorId))
      .limit(1);
    if (conn?.name) {
      try {
        await deps.notifier.reauthRequired(existing.workspaceId, conn.name);
      } catch (err) {
        log.warn({ err, grantId }, 'Failed to send re-auth notification');
      }
    }
  }

  log.warn({ grantId, connectorId, attempts, permanent }, errorMsg);
}

async function persistRefreshOutcome(
  deps: RefreshDeps,
  input: {
    workspaceId?: string | null;
    grantId: string;
    connectorId: string;
    grantUpdate: {
      refreshAttempts: number;
      lastRefreshError: string | null;
      needsReauth: boolean;
    };
    status: 'succeeded' | 'failed';
    attempts: number;
    permanent: boolean;
    summary: string;
  },
): Promise<void> {
  const { connectorGrants } = await import('@pilot/db/schema');
  const workspaceId = input.workspaceId;
  if (!workspaceId) {
    throw new Error('Connector refresh evidence requires a workspace-scoped grant');
  }

  await deps.db.transaction(async (tx) => {
    await appendRefreshEvidence(tx, input);
    await tx
      .update(connectorGrants)
      .set(input.grantUpdate)
      .where(
        and(
          eq(connectorGrants.id, input.grantId),
          eq(connectorGrants.workspaceId, workspaceId),
        ),
      );
  });
}

async function appendRefreshEvidence(
  db: Pick<Db, 'insert' | 'update'>,
  input: {
    workspaceId?: string | null;
    grantId: string;
    connectorId: string;
    status: 'succeeded' | 'failed';
    attempts: number;
    permanent: boolean;
    summary: string;
  },
): Promise<void> {
  if (!input.workspaceId) return;

  const metadata = {
    grantId: input.grantId,
    connectorId: input.connectorId,
    status: input.status,
    attempts: input.attempts,
    permanent: input.permanent,
    productionReady: false,
    credentialBoundary: 'no_raw_tokens_in_evidence',
  };
  const evidenceType =
    input.status === 'succeeded' ? 'connector_refresh_succeeded' : 'connector_refresh_failed';
  const auditEventId = randomUUID();
  const replayRef = `connector-refresh:${input.grantId}:${input.status}:${input.attempts}`;
  const auditMetadata = {
    evidenceType,
    replayRef,
    ...metadata,
  };

  await db.insert(auditLog).values({
    id: auditEventId,
    workspaceId: input.workspaceId,
    action: evidenceType.toUpperCase(),
    actor: `workspace:${input.workspaceId}`,
    target: input.connectorId,
    verdict: input.status,
    reason: input.summary,
    metadata: auditMetadata,
  });

  const evidenceItemId = await appendEvidenceItem(db, {
    workspaceId: input.workspaceId,
    auditEventId,
    evidenceType,
    sourceType: 'connector_refresh_worker',
    title: `Connector refresh ${input.status}: ${input.connectorId}`,
    summary: input.summary,
    redactionState: 'redacted',
    sensitivity: 'sensitive',
    contentHash: hashJson(metadata),
    replayRef,
    metadata,
  });

  await db
    .update(auditLog)
    .set({
      metadata: {
        ...auditMetadata,
        evidenceItemId,
      },
    })
    .where(and(eq(auditLog.workspaceId, input.workspaceId), eq(auditLog.id, auditEventId)));
}

function hashJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortJson);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

/**
 * Fetch the list of grants that currently need re-auth for a workspace.
 * Used by the Mini App + web re-auth banners.
 */
export async function listReauthRequired(
  db: Db,
  workspaceId: string,
): Promise<
  Array<{ grantId: string; connectorName: string; lastError: string | null }>
> {
  const { connectorGrants, connectors } = await import('@pilot/db/schema');
  const rows = await db
    .select({
      grantId: connectorGrants.id,
      connectorName: connectors.name,
      lastError: connectorGrants.lastRefreshError,
    })
    .from(connectorGrants)
    .innerJoin(connectors, eq(connectors.id, connectorGrants.connectorId))
    .where(
      and(
        eq(connectorGrants.workspaceId, workspaceId),
        eq(connectorGrants.needsReauth, true),
      ),
    );
  return rows;
}
