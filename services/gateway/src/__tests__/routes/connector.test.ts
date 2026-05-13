import { describe, it, expect, vi } from 'vitest';
import { auditLog, evidenceItems } from '@pilot/db/schema';
import { connectorRoutes } from '../../routes/connector.js';
import { testApp, expectJson, createMockDeps } from '../helpers.js';

function createConnectorsMock() {
  return {
    listConnectors: vi.fn(() => [
      {
        id: 'github',
        name: 'GitHub',
        description: 'GitHub',
        authType: 'oauth2',
        requiredScopes: ['repo'],
        requiresApproval: true,
      },
      {
        id: 'yc',
        name: 'YC Matching',
        description: 'YC private session connector',
        authType: 'session',
        requiredScopes: ['matching:read'],
        requiresApproval: true,
      },
    ]),
    listWorkspaceGrants: vi.fn(async () => []),
    getConnector: vi.fn((name: string) =>
      name === 'github'
        ? {
            id: 'github',
            name: 'GitHub',
            description: 'GitHub',
            authType: 'oauth2',
            requiredScopes: ['repo'],
            requiresApproval: true,
          }
        : name === 'yc'
          ? {
              id: 'yc',
              name: 'YC Matching',
              description: 'YC private session connector',
              authType: 'session',
              requiredScopes: ['matching:read'],
              requiresApproval: true,
            }
          : null,
    ),
    grantConnector: vi.fn(async () => 'grant-1'),
    revokeConnector: vi.fn(async () => {}),
    storeToken: vi.fn(async () => {}),
    storeSession: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    markSessionValidated: vi.fn(async () => {}),
    getGrantByWorkspaceConnector: vi.fn(async () => null),
    getTokenRecord: vi.fn(async () => null),
    getSessionRecord: vi.fn(async () => null),
  };
}

function captureEvidenceItemInserts(
  deps: ReturnType<typeof createMockDeps>,
  options: { failEvidence?: boolean } = {},
) {
  const insertedEvidenceItems: Array<Record<string, unknown>> = [];
  const originalInsert = deps.db.insert;

  deps.db.insert = vi.fn((table: unknown) => {
    if (table === evidenceItems) {
      return {
        values: vi.fn((value: unknown) => {
          insertedEvidenceItems.push(value as Record<string, unknown>);
          return {
            returning: vi.fn(async () => {
              if (options.failEvidence) throw new Error('evidence unavailable');
              return [{ id: `evidence-item-${insertedEvidenceItems.length}` }];
            }),
          };
        }),
      };
    }
    return originalInsert(table);
  }) as typeof deps.db.insert;

  return insertedEvidenceItems;
}

function insertedValue(deps: ReturnType<typeof createMockDeps>, table: unknown) {
  const insertMock = deps.db.insert as unknown as ReturnType<typeof vi.fn>;
  const index = insertMock.mock.calls.findIndex((call) => call[0] === table);
  if (index === -1) throw new Error('Expected insert was not recorded');
  const builder = insertMock.mock.results[index]?.value as { values: ReturnType<typeof vi.fn> };
  return builder.values.mock.calls[0]?.[0] as Record<string, unknown>;
}

function insertedValues(deps: ReturnType<typeof createMockDeps>, table: unknown) {
  const insertMock = deps.db.insert as unknown as ReturnType<typeof vi.fn>;
  return insertMock.mock.calls
    .map((call, index) => ({ table: call[0], result: insertMock.mock.results[index] }))
    .filter((entry) => entry.table === table)
    .map((entry) => {
      const builder = entry.result?.value as { values: ReturnType<typeof vi.fn> };
      return builder.values.mock.calls[0]?.[0] as Record<string, unknown>;
    });
}

function updatedValue(deps: ReturnType<typeof createMockDeps>, table: unknown) {
  const updateMock = deps.db.update as unknown as ReturnType<typeof vi.fn>;
  const index = updateMock.mock.calls.findIndex((call) => call[0] === table);
  if (index === -1) throw new Error('Expected update was not recorded');
  const builder = updateMock.mock.results[index]?.value as { set: ReturnType<typeof vi.fn> };
  return builder.set.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe('connectorRoutes', () => {
  const wsHeader = { 'X-Workspace-Id': 'ws-1' };
  const ownedGrant = {
    id: 'grant-1',
    workspaceId: 'ws-1',
    scopes: ['repo'],
    grantedAt: new Date('2026-04-15T00:00:00Z'),
  };

  describe('GET /', () => {
    it('returns 503 when connectors are not configured', async () => {
      const { fetch } = testApp(connectorRoutes);
      const res = await fetch('GET', '/');
      const body = await expectJson<{ error: string }>(res, 503);
      expect(body.error).toContain('not configured');
    });

    it('returns connector definitions when no workspace is provided', async () => {
      const connectors = createConnectorsMock();
      const deps = createMockDeps({ connectors: connectors as any });
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch('GET', '/');
      const body = await expectJson<Array<{ id: string; connectionState: string }>>(res, 200);
      expect(body[0]).toMatchObject({
        id: 'github',
        connectionState: 'available',
      });
    });

    it('returns workspace-enriched connector status when workspaceId is provided', async () => {
      const connectors = createConnectorsMock();
      connectors.getGrantByWorkspaceConnector.mockResolvedValue({
        id: 'grant-1',
        workspaceId: 'ws-1',
        scopes: ['repo'],
        grantedAt: new Date('2026-04-15T00:00:00Z'),
      });
      connectors.getTokenRecord.mockResolvedValue({
        expiresAt: new Date('2027-05-01T00:00:00Z'),
        updatedAt: new Date('2026-04-15T00:00:00Z'),
      });
      const deps = createMockDeps({ connectors: connectors as any });
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch('GET', '/', undefined, wsHeader);
      const body = await expectJson<Array<{ connectionState: string; hasToken: boolean }>>(
        res,
        200,
      );
      expect(body[0]).toMatchObject({
        connectionState: 'connected',
        hasToken: true,
      });
    });
  });

  describe('GET /grants', () => {
    it('returns 400 when workspaceId is missing', async () => {
      const connectors = createConnectorsMock();
      const deps = createMockDeps({ connectors: connectors as any });
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch('GET', '/grants');
      const body = await expectJson<{ error: string }>(res, 400);
      expect(body.error).toContain('workspaceId');
    });

    it('returns grants for a workspace', async () => {
      const connectors = createConnectorsMock();
      connectors.listWorkspaceGrants.mockResolvedValue([
        { id: 'grant-1', workspaceId: 'ws-1', connectorId: 'connector-1' },
      ]);
      const deps = createMockDeps({ connectors: connectors as any });
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch('GET', '/grants', undefined, wsHeader);
      const body = await expectJson<unknown[]>(res, 200);
      expect(body).toEqual([{ id: 'grant-1', workspaceId: 'ws-1', connectorId: 'connector-1' }]);
    });
  });

  describe('POST /:name/grant', () => {
    it('returns 404 for unknown connector', async () => {
      const connectors = createConnectorsMock();
      const deps = createMockDeps({ connectors: connectors as any });
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch('POST', '/unknown/grant', { workspaceId: 'ws-1' }, wsHeader);
      const body = await expectJson<{ error: string }>(res, 404);
      expect(body.error).toContain('Unknown connector');
    });

    it('returns 403 when body workspaceId mismatches the bound workspace', async () => {
      const connectors = createConnectorsMock();
      const deps = createMockDeps({ connectors: connectors as any });
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch('POST', '/github/grant', { workspaceId: 'ws-2' }, wsHeader);
      const body = await expectJson<{ error: string }>(res, 403);
      expect(body.error).toContain('does not match');
      expect(connectors.grantConnector).not.toHaveBeenCalled();
    });

    it('grants connector and returns connector status', async () => {
      const connectors = createConnectorsMock();
      connectors.getGrantByWorkspaceConnector.mockResolvedValue(ownedGrant);
      const deps = createMockDeps({ connectors: connectors as any });
      const evidence = captureEvidenceItemInserts(deps);
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch('POST', '/github/grant', { workspaceId: 'ws-1' }, wsHeader);
      const body = await expectJson<{
        grantId: string;
        status: { connectionState: string };
        evidenceItemId: string;
        requestEvidenceItemId: string;
      }>(res, 201);
      expect(body.grantId).toBe('grant-1');
      expect(body.status.connectionState).toBe('granted');
      expect(body.requestEvidenceItemId).toBe('evidence-item-1');
      expect(body.evidenceItemId).toBe('evidence-item-2');
      expect(evidence).toHaveLength(2);
      const insertMock = deps.db.insert as unknown as ReturnType<typeof vi.fn>;
      expect(insertMock.mock.calls.findIndex((call) => call[0] === auditLog)).toBeLessThan(
        insertMock.mock.calls.findIndex((call) => call[0] === evidenceItems),
      );
      const firstEvidenceInsertIndex = insertMock.mock.calls.findIndex(
        (call) => call[0] === evidenceItems,
      );
      expect(insertMock.mock.invocationCallOrder[firstEvidenceInsertIndex]!).toBeLessThan(
        connectors.grantConnector.mock.invocationCallOrder[0]!,
      );
      const auditValues = insertedValues(deps, auditLog);
      expect(evidence[0]).toMatchObject({
        workspaceId: 'ws-1',
        auditEventId: auditValues[0]?.['id'],
        evidenceType: 'connector_grant_requested',
        sourceType: 'gateway_connector',
        redactionState: 'redacted',
        sensitivity: 'sensitive',
        replayRef: expect.stringMatching(/^connector:github:grant-requested:/),
        metadata: expect.objectContaining({
          connectorId: 'github',
          effectOrder: 'before_connector_grant',
          requestedAction: 'grant_connector',
          productionReady: false,
        }),
      });
      expect(evidence[1]).toMatchObject({
        workspaceId: 'ws-1',
        auditEventId: auditValues[1]?.['id'],
        evidenceType: 'connector_granted',
        sourceType: 'gateway_connector',
        redactionState: 'redacted',
        sensitivity: 'sensitive',
        replayRef: 'connector:github:grant:grant-1',
        metadata: expect.objectContaining({
          connectorId: 'github',
          grantId: 'grant-1',
          productionReady: false,
        }),
      });
      expect(auditValues[1]).toMatchObject({
        id: expect.any(String),
        workspaceId: 'ws-1',
        action: 'CONNECTOR_GRANTED',
        actor: 'workspace:ws-1',
        target: 'github',
        verdict: 'recorded',
      });
      expect(auditValues[1]?.['metadata']).toMatchObject({
        evidenceType: 'connector_granted',
        replayRef: 'connector:github:grant:grant-1',
        connectorId: 'github',
        grantId: 'grant-1',
        productionReady: false,
      });
      expect(updatedValue(deps, auditLog)['metadata']).toMatchObject({
        evidenceItemId: 'evidence-item-1',
      });
    });

    it('does not grant connector when request evidence persistence fails', async () => {
      const connectors = createConnectorsMock();
      const deps = createMockDeps({ connectors: connectors as any });
      captureEvidenceItemInserts(deps, { failEvidence: true });
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch('POST', '/github/grant', { workspaceId: 'ws-1' }, wsHeader);

      expect(res.status).toBe(500);
      expect(connectors.grantConnector).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /:name/grant', () => {
    it('revokes grant and returns { revoked: true }', async () => {
      const connectors = createConnectorsMock();
      const deps = createMockDeps({ connectors: connectors as any });
      const evidence = captureEvidenceItemInserts(deps);
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch('DELETE', '/github/grant', undefined, wsHeader);
      const body = await expectJson<{
        revoked: boolean;
        evidenceItemId: string;
        requestEvidenceItemId: string;
      }>(res, 200);
      expect(body.revoked).toBe(true);
      expect(body.requestEvidenceItemId).toBe('evidence-item-1');
      expect(body.evidenceItemId).toBe('evidence-item-2');
      const insertMock = deps.db.insert as unknown as ReturnType<typeof vi.fn>;
      const firstEvidenceInsertIndex = insertMock.mock.calls.findIndex(
        (call) => call[0] === evidenceItems,
      );
      expect(insertMock.mock.invocationCallOrder[firstEvidenceInsertIndex]!).toBeLessThan(
        connectors.revokeConnector.mock.invocationCallOrder[0]!,
      );
      expect(connectors.revokeConnector).toHaveBeenCalledWith('ws-1', 'github');
      expect(evidence[0]).toMatchObject({
        workspaceId: 'ws-1',
        evidenceType: 'connector_revoke_requested',
        replayRef: 'connector:github:grant-revoke-requested',
        metadata: expect.objectContaining({
          connectorId: 'github',
          effectOrder: 'before_connector_revoke',
          requestedAction: 'revoke_connector',
          productionReady: false,
        }),
      });
      expect(evidence[1]).toMatchObject({
        workspaceId: 'ws-1',
        evidenceType: 'connector_revoked',
        replayRef: 'connector:github:grant:revoked',
        metadata: expect.objectContaining({
          connectorId: 'github',
          productionReady: false,
        }),
      });
    });

    it('does not revoke grant when request evidence persistence fails', async () => {
      const connectors = createConnectorsMock();
      const deps = createMockDeps({ connectors: connectors as any });
      captureEvidenceItemInserts(deps, { failEvidence: true });
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch('DELETE', '/github/grant', undefined, wsHeader);

      expect(res.status).toBe(500);
      expect(connectors.revokeConnector).not.toHaveBeenCalled();
    });
  });

  describe('POST /:name/token', () => {
    it('returns 400 when required fields are missing', async () => {
      const connectors = createConnectorsMock();
      const deps = createMockDeps({ connectors: connectors as any });
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch('POST', '/github/token', { grantId: 'grant-1' });
      const body = await expectJson<{ error: string }>(res, 400);
      expect(body.error).toContain('grantId and accessToken');
    });

    it('stores token and returns { stored: true }', async () => {
      const connectors = createConnectorsMock();
      connectors.getGrantByWorkspaceConnector.mockResolvedValue(ownedGrant);
      const deps = createMockDeps({ connectors: connectors as any });
      const evidence = captureEvidenceItemInserts(deps);
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch(
        'POST',
        '/github/token',
        {
          grantId: 'grant-1',
          accessToken: 'ghp_abc123',
        },
        wsHeader,
      );
      const body = await expectJson<{
        stored: boolean;
        evidenceItemId: string;
        requestEvidenceItemId: string;
      }>(res, 200);
      expect(body.stored).toBe(true);
      expect(body.requestEvidenceItemId).toBe('evidence-item-1');
      expect(body.evidenceItemId).toBe('evidence-item-2');
      expect(connectors.storeToken).toHaveBeenCalledWith(
        'grant-1',
        'ghp_abc123',
        undefined,
        undefined,
      );
      const insertMock = deps.db.insert as unknown as ReturnType<typeof vi.fn>;
      const firstEvidenceInsertIndex = insertMock.mock.calls.findIndex(
        (call) => call[0] === evidenceItems,
      );
      expect(insertMock.mock.invocationCallOrder[firstEvidenceInsertIndex]!).toBeLessThan(
        connectors.storeToken.mock.invocationCallOrder[0]!,
      );
      expect(evidence[0]).toMatchObject({
        workspaceId: 'ws-1',
        evidenceType: 'connector_token_store_requested',
        replayRef: 'connector:github:token-store-requested:grant-1',
        metadata: expect.objectContaining({
          connectorId: 'github',
          grantId: 'grant-1',
          effectOrder: 'before_token_store',
          requestedAction: 'store_connector_token',
          credentialBoundary: 'encrypted_at_rest_no_token_material_in_evidence',
        }),
      });
      expect(evidence[1]).toMatchObject({
        workspaceId: 'ws-1',
        evidenceType: 'connector_token_stored',
        replayRef: 'connector:github:token:grant-1',
        metadata: expect.objectContaining({
          connectorId: 'github',
          grantId: 'grant-1',
          credentialBoundary: 'encrypted_at_rest_no_token_material_in_evidence',
        }),
      });
      expect(JSON.stringify(evidence)).not.toContain('ghp_abc123');
    });

    it('does not store token when request evidence persistence fails', async () => {
      const connectors = createConnectorsMock();
      connectors.getGrantByWorkspaceConnector.mockResolvedValue(ownedGrant);
      const deps = createMockDeps({ connectors: connectors as any });
      captureEvidenceItemInserts(deps, { failEvidence: true });
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch(
        'POST',
        '/github/token',
        {
          grantId: 'grant-1',
          accessToken: 'ghp_abc123',
        },
        wsHeader,
      );

      expect(res.status).toBe(500);
      expect(connectors.storeToken).not.toHaveBeenCalled();
    });

    it('rejects token storage for a cross-workspace grantId', async () => {
      const connectors = createConnectorsMock();
      connectors.getGrantByWorkspaceConnector.mockResolvedValue({
        ...ownedGrant,
        id: 'grant-owned',
      });
      const deps = createMockDeps({ connectors: connectors as any });
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch(
        'POST',
        '/github/token',
        {
          grantId: 'grant-foreign',
          accessToken: 'ghp_abc123',
        },
        wsHeader,
      );
      const body = await expectJson<{ error: string }>(res, 404);
      expect(body.error).toContain('Connector grant not found');
      expect(connectors.storeToken).not.toHaveBeenCalled();
    });
  });

  describe('POST /:name/session', () => {
    it('stores session payload for session-auth connectors', async () => {
      const connectors = createConnectorsMock();
      connectors.getGrantByWorkspaceConnector.mockResolvedValue({
        ...ownedGrant,
        id: '00000000-0000-4000-8000-000000000001',
      });
      const deps = createMockDeps({ connectors: connectors as any });
      const evidence = captureEvidenceItemInserts(deps);
      const { fetch } = testApp(connectorRoutes, deps);
      const grantId = '00000000-0000-4000-8000-000000000001';

      const res = await fetch(
        'POST',
        '/yc/session',
        {
          grantId,
          sessionData: { cookies: [] },
          sessionType: 'browser_storage_state',
        },
        wsHeader,
      );
      const body = await expectJson<{
        stored: boolean;
        evidenceItemId: string;
        requestEvidenceItemId: string;
      }>(res, 200);
      expect(body.stored).toBe(true);
      expect(body.requestEvidenceItemId).toBe('evidence-item-1');
      expect(body.evidenceItemId).toBe('evidence-item-2');
      expect(connectors.storeSession).toHaveBeenCalledWith(
        grantId,
        { cookies: [] },
        'browser_storage_state',
        undefined,
      );
      const insertMock = deps.db.insert as unknown as ReturnType<typeof vi.fn>;
      const firstEvidenceInsertIndex = insertMock.mock.calls.findIndex(
        (call) => call[0] === evidenceItems,
      );
      expect(insertMock.mock.invocationCallOrder[firstEvidenceInsertIndex]!).toBeLessThan(
        connectors.storeSession.mock.invocationCallOrder[0]!,
      );
      expect(evidence[0]).toMatchObject({
        workspaceId: 'ws-1',
        evidenceType: 'connector_session_store_requested',
        replayRef: `connector:yc:session-store-requested:${grantId}`,
        metadata: expect.objectContaining({
          connectorId: 'yc',
          grantId,
          sessionType: 'browser_storage_state',
          effectOrder: 'before_session_store',
          requestedAction: 'store_connector_session',
          credentialBoundary: 'session_encrypted_at_rest_no_cookie_export_in_evidence',
        }),
      });
      expect(evidence[1]).toMatchObject({
        workspaceId: 'ws-1',
        evidenceType: 'connector_session_stored',
        replayRef: `connector:yc:session:${grantId}`,
        metadata: expect.objectContaining({
          connectorId: 'yc',
          grantId,
          sessionType: 'browser_storage_state',
          credentialBoundary: 'session_encrypted_at_rest_no_cookie_export_in_evidence',
        }),
      });
      expect(JSON.stringify(evidence)).not.toContain('cookies');
    });

    it('does not store session when request evidence persistence fails', async () => {
      const connectors = createConnectorsMock();
      connectors.getGrantByWorkspaceConnector.mockResolvedValue({
        ...ownedGrant,
        id: '00000000-0000-4000-8000-000000000001',
      });
      const deps = createMockDeps({ connectors: connectors as any });
      captureEvidenceItemInserts(deps, { failEvidence: true });
      const { fetch } = testApp(connectorRoutes, deps);
      const grantId = '00000000-0000-4000-8000-000000000001';

      const res = await fetch(
        'POST',
        '/yc/session',
        {
          grantId,
          sessionData: { cookies: [] },
          sessionType: 'browser_storage_state',
        },
        wsHeader,
      );

      expect(res.status).toBe(500);
      expect(connectors.storeSession).not.toHaveBeenCalled();
    });

    it('rejects session storage for a cross-workspace grantId', async () => {
      const connectors = createConnectorsMock();
      connectors.getGrantByWorkspaceConnector.mockResolvedValue({
        ...ownedGrant,
        id: 'grant-owned',
      });
      const deps = createMockDeps({ connectors: connectors as any });
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch(
        'POST',
        '/yc/session',
        {
          grantId: '00000000-0000-4000-8000-000000000009',
          sessionData: { cookies: [] },
          sessionType: 'browser_storage_state',
        },
        wsHeader,
      );
      const body = await expectJson<{ error: string }>(res, 404);
      expect(body.error).toContain('Connector grant not found');
      expect(connectors.storeSession).not.toHaveBeenCalled();
    });
  });

  describe('POST /:name/session/validate', () => {
    it('queues validation for session-auth connectors', async () => {
      const connectors = createConnectorsMock();
      const grantId = '00000000-0000-4000-8000-000000000001';
      connectors.getGrantByWorkspaceConnector.mockResolvedValue({
        ...ownedGrant,
        id: grantId,
      });
      connectors.getSessionRecord.mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000002',
        grantId,
        sessionType: 'browser_storage_state',
      });
      const deps = createMockDeps({ connectors: connectors as any });
      const evidence = captureEvidenceItemInserts(deps);
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch(
        'POST',
        '/yc/session/validate',
        { grantId, action: 'validate', limit: 10 },
        { 'X-Workspace-Id': 'ws-1' },
      );
      const body = await expectJson<{ queued: boolean; queue: string; evidenceItemId: string }>(
        res,
        200,
      );
      expect(body).toMatchObject({ queued: true, queue: 'pipeline.yc-private' });
      expect(body.evidenceItemId).toBe('evidence-item-1');
      const auditValue = insertedValue(deps, auditLog);
      expect(deps.orchestrator.boss.send).toHaveBeenCalledWith('pipeline.yc-private', {
        workspaceId: 'ws-1',
        grantId,
        action: 'validate',
        limit: 10,
        auditEventId: auditValue['id'],
        evidenceItemId: 'evidence-item-1',
        replayRef: `connector:yc:session-validation:${grantId}`,
      });
      expect(connectors.markSessionValidated).toHaveBeenCalled();
      expect(evidence[0]).toMatchObject({
        workspaceId: 'ws-1',
        auditEventId: auditValue['id'],
        evidenceType: 'connector_session_validation_queued',
        replayRef: `connector:yc:session-validation:${grantId}`,
        metadata: expect.objectContaining({
          connectorId: 'yc',
          grantId,
          queue: 'pipeline.yc-private',
          action: 'validate',
          limit: 10,
        }),
      });
      expect(updatedValue(deps, auditLog)['metadata']).toMatchObject({
        evidenceItemId: 'evidence-item-1',
      });
    });

    it('does not queue validation when evidence persistence fails', async () => {
      const connectors = createConnectorsMock();
      const grantId = '00000000-0000-4000-8000-000000000001';
      connectors.getGrantByWorkspaceConnector.mockResolvedValue({
        ...ownedGrant,
        id: grantId,
      });
      connectors.getSessionRecord.mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000002',
        grantId,
        sessionType: 'browser_storage_state',
      });
      const deps = createMockDeps({ connectors: connectors as any });
      captureEvidenceItemInserts(deps, { failEvidence: true });
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch(
        'POST',
        '/yc/session/validate',
        { grantId, action: 'validate', limit: 10 },
        { 'X-Workspace-Id': 'ws-1' },
      );

      expect(res.status).toBe(500);
      expect(deps.orchestrator.boss.send).not.toHaveBeenCalled();
      expect(connectors.markSessionValidated).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /:name/session', () => {
    it('deletes stored connector session', async () => {
      const connectors = createConnectorsMock();
      connectors.getGrantByWorkspaceConnector.mockResolvedValue(ownedGrant);
      const deps = createMockDeps({ connectors: connectors as any });
      const evidence = captureEvidenceItemInserts(deps);
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch('DELETE', '/yc/session?grantId=grant-1', undefined, wsHeader);
      const body = await expectJson<{ deleted: boolean; evidenceItemId: string }>(res, 200);
      expect(body.deleted).toBe(true);
      expect(body.evidenceItemId).toBe('evidence-item-1');
      expect(connectors.deleteSession).toHaveBeenCalledWith('grant-1');
      expect(evidence[0]).toMatchObject({
        workspaceId: 'ws-1',
        evidenceType: 'connector_session_delete_intent',
        replayRef: 'connector:yc:session-delete-intent:grant-1',
        metadata: expect.objectContaining({
          connectorId: 'yc',
          effectOrder: 'before_session_delete',
          grantId: 'grant-1',
          requestedAction: 'delete_session',
        }),
      });
    });

    it('fails closed without deleting the session when evidence persistence fails', async () => {
      const connectors = createConnectorsMock();
      connectors.getGrantByWorkspaceConnector.mockResolvedValue(ownedGrant);
      const deps = createMockDeps({ connectors: connectors as any });
      captureEvidenceItemInserts(deps, { failEvidence: true });
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch('DELETE', '/yc/session?grantId=grant-1', undefined, wsHeader);

      expect(res.status).toBe(500);
      expect(connectors.deleteSession).not.toHaveBeenCalled();
    });
  });

  describe('GET /:name/oauth/initiate', () => {
    it('returns 400 when workspaceId is missing', async () => {
      const deps = createMockDeps({ connectors: createConnectorsMock() as any });
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch('GET', '/github/oauth/initiate');
      const body = await expectJson<{ error: string }>(res, 400);
      expect(body.error).toContain('workspaceId');
    });

    it('returns authUrl when OAuth is configured', async () => {
      const deps = createMockDeps({ connectors: createConnectorsMock() as any });
      const evidence = captureEvidenceItemInserts(deps);
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch('GET', '/github/oauth/initiate', undefined, wsHeader);
      const body = await expectJson<{
        authUrl: string;
        connector: string;
        evidenceItemId: string;
        requestEvidenceItemId: string;
      }>(res, 200);
      expect(body.connector).toBe('github');
      expect(body.authUrl).toContain('auth.example.com');
      expect(body.requestEvidenceItemId).toBe('evidence-item-1');
      expect(body.evidenceItemId).toBe('evidence-item-2');
      const initiateFlow = deps.oauth.initiateFlow as ReturnType<typeof vi.fn>;
      const insertMock = deps.db.insert as unknown as ReturnType<typeof vi.fn>;
      const firstEvidenceInsertIndex = insertMock.mock.calls.findIndex(
        (call) => call[0] === evidenceItems,
      );
      expect(insertMock.mock.invocationCallOrder[firstEvidenceInsertIndex]!).toBeLessThan(
        initiateFlow.mock.invocationCallOrder[0]!,
      );
      expect(evidence[0]).toMatchObject({
        workspaceId: 'ws-1',
        evidenceType: 'connector_oauth_initiate_requested',
        replayRef: expect.stringMatching(/^connector:github:oauth:initiate-requested:/),
        metadata: expect.objectContaining({
          connectorId: 'github',
          effectOrder: 'before_oauth_initiate',
          requestedAction: 'initiate_connector_oauth',
          credentialBoundary: 'oauth_url_not_stored_in_evidence',
        }),
      });
      expect(evidence[1]).toMatchObject({
        workspaceId: 'ws-1',
        evidenceType: 'connector_oauth_initiated',
        replayRef: 'connector:github:oauth:initiate',
        metadata: expect.objectContaining({
          connectorId: 'github',
          credentialBoundary: 'oauth_url_not_stored_in_evidence',
        }),
      });
      expect(JSON.stringify(evidence)).not.toContain('auth.example.com');
    });

    it('does not initiate OAuth when request evidence persistence fails', async () => {
      const deps = createMockDeps({ connectors: createConnectorsMock() as any });
      captureEvidenceItemInserts(deps, { failEvidence: true });
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch('GET', '/github/oauth/initiate', undefined, wsHeader);

      expect(res.status).toBe(500);
      expect(deps.oauth.initiateFlow).not.toHaveBeenCalled();
    });
  });

  describe('GET /:name/oauth/callback', () => {
    it('records OAuth callback evidence without storing raw callback parameters', async () => {
      const deps = createMockDeps({ connectors: createConnectorsMock() as any });
      const evidence = captureEvidenceItemInserts(deps);
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch('GET', '/github/oauth/callback?code=secret-code&state=secret-state');
      const html = await res.text();

      expect(res.status).toBe(200);
      expect(html).toContain('Connected github successfully');
      expect(deps.oauth.inspectCallbackState).toHaveBeenCalledWith('secret-state');
      const handleCallback = deps.oauth.handleCallback as ReturnType<typeof vi.fn>;
      const insertMock = deps.db.insert as unknown as ReturnType<typeof vi.fn>;
      const firstEvidenceInsertIndex = insertMock.mock.calls.findIndex(
        (call) => call[0] === evidenceItems,
      );
      expect(insertMock.mock.invocationCallOrder[firstEvidenceInsertIndex]!).toBeLessThan(
        handleCallback.mock.invocationCallOrder[0]!,
      );
      expect(evidence[0]).toMatchObject({
        workspaceId: 'ws-1',
        evidenceType: 'connector_oauth_callback_requested',
        replayRef: expect.stringMatching(/^connector:github:oauth:callback-requested:/),
        metadata: expect.objectContaining({
          connectorId: 'github',
          effectOrder: 'before_oauth_callback',
          requestedAction: 'complete_connector_oauth_callback',
          credentialBoundary: 'oauth_callback_no_raw_code_or_state_evidence',
        }),
      });
      expect(evidence[1]).toMatchObject({
        workspaceId: 'ws-1',
        evidenceType: 'connector_oauth_connected',
        replayRef: 'connector:github:oauth:callback:grant-1',
        metadata: expect.objectContaining({
          connectorId: 'github',
          grantId: 'grant-1',
          credentialBoundary: 'oauth_callback_no_raw_token_evidence',
        }),
      });
      expect(JSON.stringify(evidence)).not.toContain('secret-code');
      expect(JSON.stringify(evidence)).not.toContain('secret-state');
    });

    it('does not complete OAuth callback when request evidence persistence fails', async () => {
      const deps = createMockDeps({ connectors: createConnectorsMock() as any });
      captureEvidenceItemInserts(deps, { failEvidence: true });
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch('GET', '/github/oauth/callback?code=secret-code&state=secret-state');

      expect(res.status).toBe(500);
      expect(deps.oauth.inspectCallbackState).toHaveBeenCalledWith('secret-state');
      expect(deps.oauth.handleCallback).not.toHaveBeenCalled();
    });
  });

  describe('POST /:name/oauth/refresh', () => {
    it('returns 401 when refresh fails', async () => {
      const deps = createMockDeps({
        connectors: {
          ...createConnectorsMock(),
          getGrantByWorkspaceConnector: vi.fn(async () => ownedGrant),
        } as any,
        oauth: {
          ...createMockDeps().oauth,
          refreshToken: vi.fn(async () => null),
        } as any,
      });
      const evidence = captureEvidenceItemInserts(deps);
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch('POST', '/github/oauth/refresh', { grantId: 'grant-1' }, wsHeader);
      const body = await expectJson<{
        error: string;
        evidenceItemId: string;
        requestEvidenceItemId: string;
      }>(res, 401);
      expect(body.error).toContain('Token refresh failed');
      expect(body.requestEvidenceItemId).toBe('evidence-item-1');
      expect(body.evidenceItemId).toBe('evidence-item-2');
      const refreshToken = deps.oauth.refreshToken as ReturnType<typeof vi.fn>;
      const insertMock = deps.db.insert as unknown as ReturnType<typeof vi.fn>;
      const firstEvidenceInsertIndex = insertMock.mock.calls.findIndex(
        (call) => call[0] === evidenceItems,
      );
      expect(insertMock.mock.invocationCallOrder[firstEvidenceInsertIndex]!).toBeLessThan(
        refreshToken.mock.invocationCallOrder[0]!,
      );
      expect(evidence[0]).toMatchObject({
        workspaceId: 'ws-1',
        evidenceType: 'connector_oauth_refresh_requested',
        replayRef: 'connector:github:oauth-refresh-requested:grant-1',
        metadata: expect.objectContaining({
          connectorId: 'github',
          grantId: 'grant-1',
          effectOrder: 'before_oauth_refresh',
          requestedAction: 'refresh_connector_oauth_token',
          credentialBoundary: 'no_raw_tokens_in_evidence',
        }),
      });
      expect(evidence[1]).toMatchObject({
        workspaceId: 'ws-1',
        evidenceType: 'connector_oauth_refresh_failed',
        replayRef: 'connector:github:oauth-refresh-failed:grant-1',
        metadata: expect.objectContaining({
          connectorId: 'github',
          grantId: 'grant-1',
          credentialBoundary: 'no_raw_tokens_in_evidence',
        }),
      });
    });

    it('records successful token refresh without exposing token material', async () => {
      const deps = createMockDeps({
        connectors: {
          ...createConnectorsMock(),
          getGrantByWorkspaceConnector: vi.fn(async () => ownedGrant),
        } as any,
        oauth: {
          ...createMockDeps().oauth,
          refreshToken: vi.fn(async () => 'new-token'),
        } as any,
      });
      const evidence = captureEvidenceItemInserts(deps);
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch('POST', '/github/oauth/refresh', { grantId: 'grant-1' }, wsHeader);
      const body = await expectJson<{
        refreshed: boolean;
        evidenceItemId: string;
        requestEvidenceItemId: string;
      }>(res, 200);

      expect(body.refreshed).toBe(true);
      expect(body.requestEvidenceItemId).toBe('evidence-item-1');
      expect(body.evidenceItemId).toBe('evidence-item-2');
      expect(evidence[0]).toMatchObject({
        workspaceId: 'ws-1',
        evidenceType: 'connector_oauth_refresh_requested',
        replayRef: 'connector:github:oauth-refresh-requested:grant-1',
        metadata: expect.objectContaining({
          connectorId: 'github',
          grantId: 'grant-1',
          effectOrder: 'before_oauth_refresh',
          requestedAction: 'refresh_connector_oauth_token',
          credentialBoundary: 'no_raw_tokens_in_evidence',
        }),
      });
      expect(evidence[1]).toMatchObject({
        workspaceId: 'ws-1',
        evidenceType: 'connector_oauth_refreshed',
        replayRef: 'connector:github:oauth-refresh:grant-1',
        metadata: expect.objectContaining({
          connectorId: 'github',
          grantId: 'grant-1',
          credentialBoundary: 'no_raw_tokens_in_evidence',
        }),
      });
      expect(JSON.stringify(evidence)).not.toContain('new-token');
    });

    it('does not refresh OAuth token when request evidence persistence fails', async () => {
      const deps = createMockDeps({
        connectors: {
          ...createConnectorsMock(),
          getGrantByWorkspaceConnector: vi.fn(async () => ownedGrant),
        } as any,
        oauth: {
          ...createMockDeps().oauth,
          refreshToken: vi.fn(async () => 'new-token'),
        } as any,
      });
      captureEvidenceItemInserts(deps, { failEvidence: true });
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch('POST', '/github/oauth/refresh', { grantId: 'grant-1' }, wsHeader);

      expect(res.status).toBe(500);
      expect(deps.oauth.refreshToken).not.toHaveBeenCalled();
    });

    it('rejects token refresh for a cross-workspace grantId', async () => {
      const connectors = createConnectorsMock();
      connectors.getGrantByWorkspaceConnector.mockResolvedValue({
        ...ownedGrant,
        id: 'grant-owned',
      });
      const deps = createMockDeps({
        connectors: connectors as any,
        oauth: {
          ...createMockDeps().oauth,
          refreshToken: vi.fn(async () => 'new-token'),
        } as any,
      });
      const { fetch } = testApp(connectorRoutes, deps);

      const res = await fetch(
        'POST',
        '/github/oauth/refresh',
        { grantId: 'grant-foreign' },
        wsHeader,
      );
      const body = await expectJson<{ error: string }>(res, 404);
      expect(body.error).toContain('Connector grant not found');
      expect(deps.oauth.refreshToken).not.toHaveBeenCalled();
    });
  });
});
