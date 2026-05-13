import { createHash, randomUUID } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { appendEvidenceItem } from '@pilot/db';
import { auditLog } from '@pilot/db/schema';
import { type Connector, listReauthRequired } from '@pilot/connectors';
import { SaveConnectorSessionInput, ValidateConnectorSessionInput } from '@pilot/shared/schemas';
import { type GatewayDeps } from '../index.js';
import { getWorkspaceId, requireWorkspaceRole, workspaceIdMismatch } from '../lib/workspace.js';

export function connectorRoutes(deps: GatewayDeps) {
  const app = new Hono();

  app.get('/', async (c) => {
    if (!deps.connectors) return c.json({ error: 'Connectors not configured' }, 503);

    const workspaceId = getWorkspaceId(c);
    const available = deps.connectors.listConnectors();

    if (!workspaceId) {
      return c.json(
        available.map((connector) => serializeConnector(connector, deps, null, null, null)),
      );
    }
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view workspace connector status');
    if (roleDenied) return roleDenied;

    const statuses = await Promise.all(
      available.map((connector) => getConnectorStatus(deps, connector, workspaceId)),
    );
    return c.json(statuses);
  });

  app.get('/grants', async (c) => {
    if (!deps.connectors) return c.json({ error: 'Connectors not configured' }, 503);
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view workspace connector grants');
    if (roleDenied) return roleDenied;

    const grants = await deps.connectors.listWorkspaceGrants(workspaceId);
    return c.json(grants);
  });

  /**
   * GET /api/connectors/reauth-status
   *
   * Phase 13 (Track B) — returns the list of grants the background refresh
   * worker has permanently failed on. The Mini App + web use this to
   * render the "Reconnect <provider>" banner and CTA.
   */
  app.get('/reauth-status', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view connector reauthorization state');
    if (roleDenied) return roleDenied;
    const grants = await listReauthRequired(deps.db, workspaceId);
    return c.json({ grants });
  });

  app.post('/:name/grant', async (c) => {
    if (!deps.connectors) return c.json({ error: 'Connectors not configured' }, 503);
    const { name } = c.req.param();
    const body = (await c.req.json().catch(() => ({}))) as {
      workspaceId?: string;
      scopes?: string[];
    };
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'owner', 'grant workspace connectors');
    if (roleDenied) return roleDenied;
    if (workspaceIdMismatch(c, body.workspaceId)) {
      return c.json({ error: 'workspaceId does not match authenticated workspace' }, 403);
    }

    const connector = deps.connectors.getConnector(name);
    if (!connector) return c.json({ error: `Unknown connector: ${name}` }, 404);

    const scopes = body.scopes ?? [];
    const grantIntent = await appendConnectorEvidenceProof(deps, {
      workspaceId,
      connector,
      evidenceType: 'connector_grant_requested',
      title: `Connector grant requested: ${connector.name}`,
      summary: `Workspace connector ${name} grant was requested`,
      replayRef: `connector:${name}:grant-requested:${hashJson({ connectorId: name, scopes }).slice(7, 23)}`,
      hashContent: {
        connectorId: name,
        scopes,
        requestedAction: 'grant_connector',
      },
      metadata: {
        scopes,
        effectOrder: 'before_connector_grant',
        requestedAction: 'grant_connector',
      },
    });
    const grantId = await deps.connectors.grantConnector(workspaceId, name, body.scopes);
    const status = await getConnectorStatus(deps, connector, workspaceId);
    const evidenceItemId = await appendConnectorEvidence(deps, {
      workspaceId,
      connector,
      evidenceType: 'connector_granted',
      title: `Connector granted: ${connector.name}`,
      summary: `Workspace connector ${name} was granted`,
      replayRef: `connector:${name}:grant:${grantId}`,
      hashContent: {
        connectorId: name,
        grantId,
        scopes: body.scopes ?? [],
      },
      metadata: {
        grantId,
        scopes: body.scopes ?? [],
      },
    });
    return c.json(
      {
        grantId,
        connector: name,
        workspaceId,
        status,
        evidenceItemId,
        requestEvidenceItemId: grantIntent.evidenceItemId,
      },
      201,
    );
  });

  app.delete('/:name/grant', async (c) => {
    if (!deps.connectors) return c.json({ error: 'Connectors not configured' }, 503);
    const { name } = c.req.param();
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'owner', 'revoke workspace connectors');
    if (roleDenied) return roleDenied;

    const connector = deps.connectors.getConnector(name);
    const revokeIntent = await appendConnectorEvidenceProof(deps, {
      workspaceId,
      connector,
      evidenceType: 'connector_revoke_requested',
      title: `Connector revoke requested: ${connector?.name ?? name}`,
      summary: `Workspace connector ${name} revoke was requested`,
      replayRef: `connector:${name}:grant-revoke-requested`,
      hashContent: {
        connectorId: name,
        requestedAction: 'revoke_connector',
      },
      metadata: {
        effectOrder: 'before_connector_revoke',
        requestedAction: 'revoke_connector',
      },
    });
    await deps.connectors.revokeConnector(workspaceId, name);
    const evidenceItemId = await appendConnectorEvidence(deps, {
      workspaceId,
      connector,
      evidenceType: 'connector_revoked',
      title: `Connector revoked: ${name}`,
      summary: `Workspace connector ${name} was revoked`,
      replayRef: `connector:${name}:grant:revoked`,
      hashContent: { connectorId: name },
      metadata: {},
    });
    return c.json({
      revoked: true,
      evidenceItemId,
      requestEvidenceItemId: revokeIntent.evidenceItemId,
    });
  });

  app.post('/:name/token', async (c) => {
    if (!deps.connectors) return c.json({ error: 'Connectors not configured' }, 503);
    const { name } = c.req.param();
    const connector = deps.connectors.getConnector(name);
    if (!connector) return c.json({ error: `Unknown connector: ${name}` }, 404);

    const body = await c.req.json();
    const { grantId, accessToken, refreshToken, expiresAt } = body as {
      grantId: string;
      accessToken: string;
      refreshToken?: string;
      expiresAt?: string;
    };
    if (!grantId || !accessToken) return c.json({ error: 'grantId and accessToken required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'owner', 'store connector tokens');
    if (roleDenied) return roleDenied;

    const ownership = await requireOwnedGrant(deps, c, name, grantId);
    if (ownership instanceof Response) return ownership;

    await deps.connectors.storeToken(
      grantId,
      accessToken,
      refreshToken,
      expiresAt ? new Date(expiresAt) : undefined,
    );
    const evidenceItemId = await appendConnectorEvidence(deps, {
      workspaceId: ownership.workspaceId,
      connector,
      evidenceType: 'connector_token_stored',
      title: `Connector token stored: ${connector.name}`,
      summary: `Encrypted token metadata was stored for ${name}`,
      replayRef: `connector:${name}:token:${grantId}`,
      hashContent: {
        connectorId: name,
        grantId,
        hasRefreshToken: Boolean(refreshToken),
        expiresAt: expiresAt ?? null,
      },
      metadata: {
        grantId,
        hasRefreshToken: Boolean(refreshToken),
        expiresAt: expiresAt ?? null,
        credentialBoundary: 'encrypted_at_rest_no_token_material_in_evidence',
      },
    });
    return c.json({ stored: true, evidenceItemId });
  });

  app.post('/:name/session', async (c) => {
    if (!deps.connectors) return c.json({ error: 'Connectors not configured' }, 503);
    const { name } = c.req.param();
    const connector = deps.connectors.getConnector(name);
    if (!connector) return c.json({ error: `Unknown connector: ${name}` }, 404);
    if (connector.authType !== 'session') {
      return c.json({ error: `${name} does not use session-based auth` }, 400);
    }

    const raw = await c.req.json().catch(() => null);
    const parsed = SaveConnectorSessionInput.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }
    const roleDenied = requireWorkspaceRole(c, 'owner', 'store connector browser sessions');
    if (roleDenied) return roleDenied;

    const ownership = await requireOwnedGrant(deps, c, name, parsed.data.grantId);
    if (ownership instanceof Response) return ownership;

    await deps.connectors.storeSession(
      parsed.data.grantId,
      parsed.data.sessionData,
      parsed.data.sessionType,
      parsed.data.metadata,
    );
    const evidenceItemId = await appendConnectorEvidence(deps, {
      workspaceId: ownership.workspaceId,
      connector,
      evidenceType: 'connector_session_stored',
      title: `Connector session stored: ${connector.name}`,
      summary: `Encrypted browser session metadata was stored for ${name}`,
      replayRef: `connector:${name}:session:${parsed.data.grantId}`,
      hashContent: {
        connectorId: name,
        grantId: parsed.data.grantId,
        sessionType: parsed.data.sessionType,
        metadataKeys: sortedKeys(parsed.data.metadata),
      },
      metadata: {
        grantId: parsed.data.grantId,
        sessionType: parsed.data.sessionType,
        metadataKeys: sortedKeys(parsed.data.metadata),
        credentialBoundary: 'session_encrypted_at_rest_no_cookie_export_in_evidence',
      },
    });
    return c.json({ stored: true, evidenceItemId });
  });

  app.post('/:name/session/validate', async (c) => {
    if (!deps.connectors) return c.json({ error: 'Connectors not configured' }, 503);
    const { name } = c.req.param();
    const connector = deps.connectors.getConnector(name);
    if (!connector) return c.json({ error: `Unknown connector: ${name}` }, 404);
    if (connector.authType !== 'session') {
      return c.json({ error: `${name} does not use session-based auth` }, 400);
    }
    if (!deps.orchestrator.boss) {
      return c.json({ error: 'Background jobs unavailable' }, 503);
    }

    const raw = await c.req.json().catch(() => null);
    const parsed = ValidateConnectorSessionInput.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }
    const roleDenied = requireWorkspaceRole(c, 'owner', 'validate connector browser sessions');
    if (roleDenied) return roleDenied;

    const ownership = await requireOwnedGrant(deps, c, name, parsed.data.grantId);
    if (ownership instanceof Response) return ownership;
    const workspaceId = ownership.workspaceId;

    const record = await deps.connectors.getSessionRecord(parsed.data.grantId);
    if (!record) return c.json({ error: 'No session stored for this grant' }, 404);

    const queue = name === 'yc' ? 'pipeline.yc-private' : `pipeline.${name}-session`;
    const replayRef = `connector:${name}:session-validation:${parsed.data.grantId}`;
    const proof = await appendConnectorEvidenceProof(deps, {
      workspaceId,
      connector,
      evidenceType: 'connector_session_validation_queued',
      title: `Connector session validation queued: ${connector.name}`,
      summary: `Browser session validation was queued for ${name}`,
      replayRef,
      hashContent: {
        connectorId: name,
        grantId: parsed.data.grantId,
        action: parsed.data.action,
        limit: parsed.data.limit ?? null,
        queue,
      },
      metadata: {
        grantId: parsed.data.grantId,
        action: parsed.data.action,
        limit: parsed.data.limit ?? null,
        queue,
      },
    });

    const jobId = await deps.orchestrator.boss.send(queue, {
      workspaceId,
      grantId: parsed.data.grantId,
      action: parsed.data.action,
      limit: parsed.data.limit,
      auditEventId: proof.auditEventId,
      evidenceItemId: proof.evidenceItemId,
      replayRef,
    });

    if (parsed.data.action === 'validate') {
      await deps.connectors.markSessionValidated(parsed.data.grantId, {
        lastValidationQueuedAt: new Date().toISOString(),
      });
    }

    await deps.db
      .update(auditLog)
      .set({
        metadata: {
          evidenceType: 'connector_session_validation_queued',
          replayRef,
          evidenceItemId: proof.evidenceItemId,
          connectorId: connector.id,
          connectorName: connector.name,
          authType: connector.authType,
          requiresApproval: connector.requiresApproval,
          productionReady: false,
          grantId: parsed.data.grantId,
          action: parsed.data.action,
          limit: parsed.data.limit ?? null,
          queue,
          jobId: jobId ?? null,
        },
      })
      .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, proof.auditEventId)));

    return c.json({ queued: true, queue, jobId, evidenceItemId: proof.evidenceItemId });
  });

  app.delete('/:name/session', async (c) => {
    if (!deps.connectors) return c.json({ error: 'Connectors not configured' }, 503);
    const { name } = c.req.param();
    const connector = deps.connectors.getConnector(name);
    if (!connector) return c.json({ error: `Unknown connector: ${name}` }, 404);

    const grantId = c.req.query('grantId');
    if (!grantId) return c.json({ error: 'grantId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'owner', 'delete connector browser sessions');
    if (roleDenied) return roleDenied;

    const ownership = await requireOwnedGrant(deps, c, name, grantId);
    if (ownership instanceof Response) return ownership;

    const evidenceItemId = await appendConnectorEvidence(deps, {
      workspaceId: ownership.workspaceId,
      connector,
      evidenceType: 'connector_session_delete_intent',
      title: `Connector session delete requested: ${connector.name}`,
      summary: `Stored browser session deletion was requested for ${name}`,
      replayRef: `connector:${name}:session-delete-intent:${grantId}`,
      hashContent: {
        connectorId: name,
        grantId,
        requestedAction: 'delete_session',
      },
      metadata: {
        grantId,
        effectOrder: 'before_session_delete',
        requestedAction: 'delete_session',
      },
    });
    await deps.connectors.deleteSession(grantId);
    return c.json({ deleted: true, evidenceItemId });
  });

  app.get('/:name/oauth/initiate', async (c) => {
    if (!deps.oauth) return c.json({ error: 'OAuth not configured' }, 503);
    const { name } = c.req.param();
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'owner', 'start connector OAuth');
    if (roleDenied) return roleDenied;

    const provider = deps.oauth.getProvider(name);
    if (!provider) return c.json({ error: `No OAuth provider for connector: ${name}` }, 404);
    if (!provider.clientId) {
      return c.json(
        {
          error: `OAuth not configured for ${name}. Set ${provider.clientIdEnv ?? 'CLIENT_ID'} in .env`,
        },
        503,
      );
    }

    try {
      const scopes = c.req.query('scopes')?.split(',').filter(Boolean);
      const { authUrl } = deps.oauth.initiateFlow({
        connectorId: name,
        workspaceId,
        scopes,
      });
      const evidenceItemId = await appendConnectorEvidence(deps, {
        workspaceId,
        connector: {
          id: name,
          name,
          description: name,
          authType: 'oauth2',
          requiredScopes: scopes ?? [],
          requiresApproval: true,
        },
        evidenceType: 'connector_oauth_initiated',
        title: `Connector OAuth initiated: ${name}`,
        summary: `OAuth flow was initiated for ${name}`,
        replayRef: `connector:${name}:oauth:initiate`,
        hashContent: {
          connectorId: name,
          scopes: scopes ?? [],
          redirectRequested: c.req.query('redirect') === 'true',
        },
        metadata: {
          scopes: scopes ?? [],
          redirectRequested: c.req.query('redirect') === 'true',
          credentialBoundary: 'oauth_url_not_stored_in_evidence',
        },
      });
      if (c.req.query('redirect') === 'true') {
        return c.redirect(authUrl);
      }
      return c.json({ authUrl, connector: name, evidenceItemId });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'OAuth initiation failed';
      return c.json({ error: message }, 400);
    }
  });

  app.get('/:name/oauth/callback', async (c) => {
    if (!deps.oauth) return c.json({ error: 'OAuth not configured' }, 503);

    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');

    if (error) {
      const errorDesc = c.req.query('error_description') ?? error;
      return c.html(oauthResultPage(false, `Authorization denied: ${errorDesc}`));
    }

    if (!code || !state) {
      return c.json({ error: 'Missing code or state parameter' }, 400);
    }

    try {
      const result = await deps.oauth.handleCallback({ code, state });
      await appendConnectorEvidence(deps, {
        workspaceId: result.workspaceId,
        connector: {
          id: result.connectorId,
          name: result.connectorId,
          description: result.connectorId,
          authType: 'oauth2',
          requiredScopes: [],
          requiresApproval: true,
        },
        evidenceType: 'connector_oauth_connected',
        title: `Connector OAuth connected: ${result.connectorId}`,
        summary: `OAuth callback completed for ${result.connectorId}`,
        replayRef: `connector:${result.connectorId}:oauth:callback:${result.grantId}`,
        hashContent: {
          connectorId: result.connectorId,
          grantId: result.grantId,
        },
        metadata: {
          grantId: result.grantId,
          credentialBoundary: 'oauth_callback_no_raw_token_evidence',
        },
      });
      return c.html(oauthResultPage(true, `Connected ${result.connectorId} successfully!`, result));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'OAuth callback failed';
      return c.html(oauthResultPage(false, message));
    }
  });

  app.post('/:name/oauth/refresh', async (c) => {
    if (!deps.oauth) return c.json({ error: 'OAuth not configured' }, 503);
    const { name } = c.req.param();
    const body = await c.req.json();
    const { grantId } = body as { grantId: string };
    if (!grantId) return c.json({ error: 'grantId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'owner', 'refresh connector OAuth tokens');
    if (roleDenied) return roleDenied;

    const ownership = await requireOwnedGrant(deps, c, name, grantId);
    if (ownership instanceof Response) return ownership;

    const newToken = await deps.oauth.refreshToken(grantId, name);
    if (!newToken) {
      const evidenceItemId = await appendConnectorEvidence(deps, {
        workspaceId: ownership.workspaceId,
        connector: {
          id: name,
          name,
          description: name,
          authType: 'oauth2',
          requiredScopes: [],
          requiresApproval: true,
        },
        evidenceType: 'connector_oauth_refresh_failed',
        title: `Connector OAuth refresh failed: ${name}`,
        summary: `OAuth refresh failed for ${name}; reauthorization is required`,
        replayRef: `connector:${name}:oauth-refresh-failed:${grantId}`,
        hashContent: {
          connectorId: name,
          grantId,
          refreshed: false,
        },
        metadata: {
          grantId,
          credentialBoundary: 'no_raw_tokens_in_evidence',
        },
      });
      return c.json(
        { error: 'Token refresh failed. Re-authorize the connector.', evidenceItemId },
        401,
      );
    }
    const evidenceItemId = await appendConnectorEvidence(deps, {
      workspaceId: ownership.workspaceId,
      connector: {
        id: name,
        name,
        description: name,
        authType: 'oauth2',
        requiredScopes: [],
        requiresApproval: true,
      },
      evidenceType: 'connector_oauth_refreshed',
      title: `Connector OAuth refreshed: ${name}`,
      summary: `OAuth token was refreshed for ${name} without raw token evidence`,
      replayRef: `connector:${name}:oauth-refresh:${grantId}`,
      hashContent: {
        connectorId: name,
        grantId,
        refreshed: true,
      },
      metadata: {
        grantId,
        credentialBoundary: 'no_raw_tokens_in_evidence',
      },
    });
    return c.json({ refreshed: true, evidenceItemId });
  });

  app.get('/:name', async (c) => {
    if (!deps.connectors) return c.json({ error: 'Connectors not configured' }, 503);
    const { name } = c.req.param();
    const connector = deps.connectors.getConnector(name);
    if (!connector) return c.json({ error: `Unknown connector: ${name}` }, 404);

    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) {
      return c.json(serializeConnector(connector, deps, null, null, null));
    }
    const roleDenied = requireWorkspaceRole(c, 'partner', 'view workspace connector status');
    if (roleDenied) return roleDenied;

    return c.json(await getConnectorStatus(deps, connector, workspaceId));
  });

  return app;
}

async function getConnectorStatus(deps: GatewayDeps, connector: Connector, workspaceId: string) {
  const grant = await deps.connectors?.getGrantByWorkspaceConnector(workspaceId, connector.id);
  const token = grant ? await deps.connectors?.getTokenRecord(grant.id) : null;
  const session = grant ? await deps.connectors?.getSessionRecord(grant.id) : null;
  return serializeConnector(connector, deps, grant ?? null, token ?? null, session ?? null);
}

function serializeConnector(
  connector: Connector,
  deps: GatewayDeps,
  grant: {
    id: string;
    workspaceId: string;
    scopes: unknown;
    grantedAt?: Date | string;
  } | null,
  token: {
    expiresAt?: Date | string | null;
    updatedAt?: Date | string;
  } | null,
  session: {
    sessionType?: string;
    lastValidatedAt?: Date | string | null;
    updatedAt?: Date | string;
  } | null,
) {
  const provider = deps.oauth?.getProvider(connector.id);
  const configured = connector.authType !== 'oauth2' || Boolean(provider?.clientId);
  const hasGrant = Boolean(grant);
  const hasSession = Boolean(session);
  const hasToken =
    connector.authType === 'none'
      ? hasGrant
      : connector.authType === 'session'
        ? hasSession
        : Boolean(token);
  const expiresAt = token?.expiresAt ? new Date(token.expiresAt).toISOString() : null;
  const isExpired = expiresAt ? new Date(expiresAt).getTime() <= Date.now() : false;
  const lastValidatedAt = session?.lastValidatedAt
    ? new Date(session.lastValidatedAt).toISOString()
    : null;

  let connectionState: ConnectorConnectionState = 'available';
  if (!configured) {
    connectionState = 'configuration_required';
  } else if (connector.authType === 'none' && hasGrant) {
    connectionState = 'enabled';
  } else if (connector.authType === 'session' && hasGrant && hasSession) {
    connectionState = 'connected';
  } else if (hasGrant && connector.authType === 'session') {
    connectionState = 'awaiting_session';
  } else if (hasGrant && hasToken && !isExpired) {
    connectionState = 'connected';
  } else if (hasGrant && isExpired) {
    connectionState = 'reauthorization_required';
  } else if (hasGrant && connector.authType === 'oauth2') {
    connectionState = 'granted';
  } else if (hasGrant) {
    connectionState = 'awaiting_token';
  }

  return {
    id: connector.id,
    name: connector.name,
    description: connector.description,
    authType: connector.authType,
    requiredScopes: connector.requiredScopes,
    requiresApproval: connector.requiresApproval,
    configured,
    oauthEnabled: connector.authType === 'oauth2' && configured,
    connectionState,
    grantId: grant?.id ?? null,
    grantedAt: grant?.grantedAt ? new Date(grant.grantedAt).toISOString() : null,
    scopes: Array.isArray(grant?.scopes) ? grant.scopes : [],
    expiresAt,
    lastValidatedAt,
    sessionType: session?.sessionType ?? null,
    hasGrant,
    hasToken,
    hasSession,
  };
}

type ConnectorConnectionState =
  | 'available'
  | 'enabled'
  | 'granted'
  | 'awaiting_token'
  | 'awaiting_session'
  | 'connected'
  | 'reauthorization_required'
  | 'configuration_required';

async function requireOwnedGrant(
  deps: GatewayDeps,
  c: Context,
  connectorName: string,
  grantId: string,
): Promise<{ workspaceId: string } | Response> {
  if (!deps.connectors) return c.json({ error: 'Connectors not configured' }, 503);
  const workspaceId = getWorkspaceId(c);
  if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);

  const grant = await deps.connectors.getGrantByWorkspaceConnector(workspaceId, connectorName);
  if (!grant || grant.id !== grantId) {
    return c.json({ error: 'Connector grant not found' }, 404);
  }

  return { workspaceId };
}

async function appendConnectorEvidence(
  deps: GatewayDeps,
  input: {
    workspaceId: string;
    connector?: Connector | null;
    evidenceType: string;
    title: string;
    summary: string;
    replayRef: string;
    hashContent: unknown;
    metadata: Record<string, unknown>;
  },
) {
  return (await appendConnectorEvidenceProof(deps, input)).evidenceItemId;
}

async function appendConnectorEvidenceProof(
  deps: GatewayDeps,
  input: {
    workspaceId: string;
    connector?: Connector | null;
    evidenceType: string;
    title: string;
    summary: string;
    replayRef: string;
    hashContent: unknown;
    metadata: Record<string, unknown>;
  },
): Promise<{ auditEventId: string; evidenceItemId: string }> {
  const auditEventId = randomUUID();
  const evidenceMetadata = {
    connectorId: input.connector?.id ?? null,
    connectorName: input.connector?.name ?? null,
    authType: input.connector?.authType ?? null,
    requiresApproval: input.connector?.requiresApproval ?? null,
    productionReady: false,
    ...input.metadata,
  };
  const auditMetadata = {
    evidenceType: input.evidenceType,
    replayRef: input.replayRef,
    ...evidenceMetadata,
  };

  const evidenceItemId = await deps.db.transaction(async (tx) => {
    await tx.insert(auditLog).values({
      id: auditEventId,
      workspaceId: input.workspaceId,
      action: input.evidenceType.toUpperCase(),
      actor: `workspace:${input.workspaceId}`,
      target: input.connector?.id ?? input.connector?.name ?? input.evidenceType,
      verdict: 'recorded',
      reason: input.summary,
      metadata: auditMetadata,
    });

    const createdEvidenceItemId = await appendEvidenceItem(tx, {
      workspaceId: input.workspaceId,
      auditEventId,
      evidenceType: input.evidenceType,
      sourceType: 'gateway_connector',
      title: input.title,
      summary: input.summary,
      redactionState: 'redacted',
      sensitivity: 'sensitive',
      contentHash: hashJson(input.hashContent),
      replayRef: input.replayRef,
      metadata: evidenceMetadata,
    });

    await tx
      .update(auditLog)
      .set({
        metadata: {
          ...auditMetadata,
          evidenceItemId: createdEvidenceItemId,
        },
      })
      .where(and(eq(auditLog.workspaceId, input.workspaceId), eq(auditLog.id, auditEventId)));

    return createdEvidenceItemId;
  });

  return { auditEventId, evidenceItemId };
}

function sortedKeys(value: Record<string, unknown> | undefined) {
  return Object.keys(value ?? {}).sort((a, b) => a.localeCompare(b));
}

function hashJson(value: unknown) {
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

function oauthResultPage(
  success: boolean,
  message: string,
  result?: { connectorId: string; workspaceId: string; grantId: string },
): string {
  const icon = success ? '✅' : '❌';
  const color = success ? '#22c55e' : '#ef4444';

  return `<!DOCTYPE html>
<html>
<head>
  <title>Pilot — ${success ? 'Connected' : 'Error'}</title>
  <meta charset="utf-8">
  <style>
    body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #0a0a0a; color: #fafafa; }
    .card { text-align: center; padding: 2rem 3rem; border-radius: 12px; background: #1a1a1a; border: 1px solid #333; max-width: 400px; }
    .icon { font-size: 3rem; margin-bottom: 1rem; }
    h2 { color: ${color}; margin: 0 0 0.5rem; font-size: 1.25rem; }
    p { color: #aaa; margin: 0.5rem 0 0; font-size: 0.875rem; }
    .close { margin-top: 1.5rem; padding: 0.5rem 2rem; background: #333; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-size: 0.875rem; }
    .close:hover { background: #444; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h2>${message}</h2>
    <p>${success ? 'You can close this window.' : 'Please try again.'}</p>
    <button class="close" onclick="window.close()">Close</button>
  </div>
  <script>
    ${
      success && result
        ? `
    if (window.opener) {
      window.opener.postMessage({
        type: 'pilot-oauth-success',
        connectorId: '${result.connectorId}',
        workspaceId: '${result.workspaceId}',
        grantId: '${result.grantId}',
      }, '*');
      setTimeout(() => window.close(), 1500);
    }`
        : ''
    }
  </script>
</body>
</html>`;
}
