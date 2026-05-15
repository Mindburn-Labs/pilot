import { Hono } from 'hono';
import { and, desc, eq, lt } from 'drizzle-orm';
import { evidencePacks, helmHealthSnapshots } from '@pilot/db/schema';
import { HelmClient } from '@pilot/helm-client';
import { type GatewayDeps } from '../index.js';
import { getWorkspaceId, requireWorkspaceRole } from '../lib/workspace.js';

/**
 * Governance admin surface.
 *
 * Exposes the founder-facing receipt trail backed by HELM. Every row returned
 * here corresponds to a real Guardian decision; rows are materialized by the
 * orchestrator's HelmClient.onReceipt callback (see services/orchestrator).
 *
 * All endpoints require authenticated access — the gateway's `requireAuth`
 * middleware applies to the whole /api/* surface.
 */
export function governanceRoutes(deps: GatewayDeps) {
  const app = new Hono();
  const helm = deps.helmClient;

  // GET /api/governance/status
  // Reports current HELM sidecar health and the most recent snapshots. Safe
  // for dashboards to poll every few seconds (no HELM traffic on the poll
  // itself — we only read the cached snapshot table).
  app.get('/status', async (c) => {
    // Latest recorded snapshot
    const [latest] = await deps.db
      .select()
      .from(helmHealthSnapshots)
      .orderBy(desc(helmHealthSnapshots.checkedAt))
      .limit(1);

    // Live probe (short timeout) — optional, only when client is configured
    let live: { ok: boolean; latencyMs: number; version?: string; error?: string } | null = null;
    if (helm) {
      const snap = await helm.health();
      live = {
        ok: snap.gatewayOk,
        latencyMs: snap.latencyMs,
        version: snap.version,
        error: snap.error,
      };
    }

    return c.json({
      helmConfigured: Boolean(helm),
      live,
      latestSnapshot: latest ?? null,
    });
  });

  // GET /api/governance/receipts
  // Paginated list of local evidence packs for the authenticated workspace.
  // Supports cursor pagination via `?before=<isoDate>&limit=<n>`.
  app.get('/receipts', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view governance receipts');
    if (roleDenied) return roleDenied;

    const before = c.req.query('before');
    const limit = Math.min(Number(c.req.query('limit') ?? '25'), 100);

    const beforeDate = before ? new Date(before) : null;
    const predicate = beforeDate
      ? and(eq(evidencePacks.workspaceId, workspaceId), lt(evidencePacks.receivedAt, beforeDate))
      : eq(evidencePacks.workspaceId, workspaceId);

    const rows = await deps.db
      .select()
      .from(evidencePacks)
      .where(predicate)
      .orderBy(desc(evidencePacks.receivedAt))
      .limit(limit);

    const nextCursor =
      rows.length === limit ? rows[rows.length - 1]!.receivedAt.toISOString() : null;

    return c.json({
      receipts: rows.map(toReceiptDto),
      nextCursor,
    });
  });

  // GET /api/governance/receipts/:decisionId
  // Single receipt — signed blob included so clients can verify offline.
  app.get('/receipts/:decisionId', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view governance receipts');
    if (roleDenied) return roleDenied;

    const decisionId = c.req.param('decisionId');
    const [row] = await deps.db
      .select()
      .from(evidencePacks)
      .where(
        and(eq(evidencePacks.workspaceId, workspaceId), eq(evidencePacks.decisionId, decisionId)),
      )
      .limit(1);

    if (!row) return c.json({ error: 'not found' }, 404);
    return c.json({ receipt: toReceiptDto(row), signedBlob: row.signedBlob });
  });

  // GET /api/governance/proofgraph/:taskId
  //
  // Phase 13 (Track C2) — returns the recursive DAG of evidence packs
  // rooted at the given task's task_runs. Nodes are flat; edges are
  // parent_evidence_pack_id → id. Traversal uses Postgres recursive CTE.
  app.get('/proofgraph/:taskId', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view governance proof graph');
    if (roleDenied) return roleDenied;

    const taskId = c.req.param('taskId');
    const { sql } = await import('drizzle-orm');

    // Recursive CTE: seed with all evidence_packs whose task_run belongs to
    // the given taskId + workspace, then walk parent_evidence_pack_id chain
    // in both directions so ancestors + descendants of the seed set are
    // included. Workspace predicate on every union branch guards tenancy.
    const result = (await deps.db.execute(sql`
      WITH RECURSIVE chain AS (
        SELECT ep.*
        FROM evidence_packs ep
        JOIN task_runs tr ON tr.id = ep.task_run_id
        WHERE tr.task_id = ${taskId}
          AND ep.workspace_id = ${workspaceId}
        UNION
        SELECT ep.*
        FROM evidence_packs ep
        JOIN chain c ON c.parent_evidence_pack_id = ep.id
        WHERE ep.workspace_id = ${workspaceId}
        UNION
        SELECT ep.*
        FROM evidence_packs ep
        JOIN chain c ON ep.parent_evidence_pack_id = c.id
        WHERE ep.workspace_id = ${workspaceId}
      )
      SELECT DISTINCT id, decision_id, task_run_id, verdict, reason_code,
        policy_version, decision_hash, action, resource, principal,
        signed_blob, received_at, verified_at, parent_evidence_pack_id
      FROM chain
      ORDER BY received_at ASC
    `)) as unknown as { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;

    const rows = (Array.isArray(result) ? result : (result.rows ?? [])) as Array<
      Record<string, unknown>
    >;

    const nodes = rows.map((r) => ({
      id: String(r['id']),
      decisionId: String(r['decision_id']),
      taskRunId: r['task_run_id'] ? String(r['task_run_id']) : null,
      verdict: String(r['verdict']),
      reasonCode: r['reason_code'] ? String(r['reason_code']) : null,
      policyVersion: String(r['policy_version']),
      decisionHash: r['decision_hash'] ? String(r['decision_hash']) : null,
      action: String(r['action']),
      resource: String(r['resource']),
      principal: String(r['principal']),
      receivedAt:
        r['received_at'] instanceof Date
          ? (r['received_at'] as Date).toISOString()
          : String(r['received_at']),
      verifiedAt:
        r['verified_at'] instanceof Date
          ? (r['verified_at'] as Date).toISOString()
          : r['verified_at']
            ? String(r['verified_at'])
            : null,
      parentEvidencePackId: r['parent_evidence_pack_id']
        ? String(r['parent_evidence_pack_id'])
        : null,
    }));

    const edges = nodes
      .filter((n) => n.parentEvidencePackId)
      .map((n) => ({ from: n.parentEvidencePackId as string, to: n.id }));

    return c.json({ taskId, nodes, edges });
  });

  // ─── Phase 14 Track F — helm-ai-kernel endpoint surface ───
  // Proxy thin reads of HelmClient endpoints into the gateway so the
  // web dashboard can render budget / cost / merkle / boundary widgets
  // without speaking the HELM admin protocol directly.

  app.get('/budget', async (c) => {
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view governance budget state');
    if (roleDenied) return roleDenied;
    if (!helm) return c.json({ error: 'helm client not configured' }, 503);
    try {
      return c.json(await helm.getBudgetStatus());
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.get('/merkle', async (c) => {
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view governance merkle state');
    if (roleDenied) return roleDenied;
    if (!helm) return c.json({ error: 'helm client not configured' }, 503);
    try {
      return c.json(await helm.getMerkleRoot());
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.get('/charges', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view governance charges');
    if (roleDenied) return roleDenied;
    if (!helm) return c.json({ error: 'helm client not configured' }, 503);
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const from = c.req.query('from') ?? sevenDaysAgo.toISOString();
    const to = c.req.query('to') ?? now.toISOString();
    try {
      return c.json(await helm.getEconomicCharges(workspaceId, from, to));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  app.get('/allocations', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view governance allocations');
    if (roleDenied) return roleDenied;
    if (!helm) return c.json({ error: 'helm client not configured' }, 503);
    try {
      return c.json(await helm.getEconomicAllocations(workspaceId));
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  return app;
}

type EvidenceRow = typeof evidencePacks.$inferSelect;

function toReceiptDto(row: EvidenceRow) {
  return {
    id: row.id,
    decisionId: row.decisionId,
    taskRunId: row.taskRunId,
    verdict: row.verdict,
    reasonCode: row.reasonCode,
    policyVersion: row.policyVersion,
    decisionHash: row.decisionHash,
    action: row.action,
    resource: row.resource,
    principal: row.principal,
    receivedAt: row.receivedAt,
    verifiedAt: row.verifiedAt,
  };
}

export type GovernanceDeps = { helmClient?: HelmClient };
