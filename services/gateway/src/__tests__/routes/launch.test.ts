import { describe, it, expect, vi, beforeEach } from 'vitest';
import { auditLog, deployTargets, evidenceItems } from '@pilot/db/schema';
import { launchRoutes } from '../../routes/launch.js';
import { createMockDeps, testApp, expectJson } from '../helpers.js';

const mockEngine = {
  listArtifacts: vi.fn(async () => []),
  getArtifact: vi.fn(async () => null),
  listDeployments: vi.fn(async () => []),
  listDeployTargets: vi.fn(async () => []),
  getDeployTarget: vi.fn(async () => ({
    id: 'target-1',
    workspaceId: 'ws-1',
    name: 'prod',
    provider: 'digitalocean',
    config: { image: 'registry.example.com/app:v1' },
  })),
  createDeployTarget: vi.fn(async () => ({
    id: 'target-1',
    name: 'prod',
    provider: 'digitalocean',
  })),
  recordDeployment: vi.fn(async () => ({
    id: 'deploy-1',
    targetId: 'target-1',
    status: 'pending',
  })),
  deployToTarget: vi.fn(async () => ({
    deployment: {
      id: 'deploy-1',
      workspaceId: 'ws-1',
      targetId: 'target-1',
      status: 'live',
      url: 'https://app.ondigitalocean.app',
    },
    providerDeployment: {
      deploymentId: 'do-deploy-1',
      status: 'live',
      url: 'https://app.ondigitalocean.app',
    },
  })),
  getDeployment: vi.fn(async () => ({
    id: 'dep-1',
    workspaceId: 'ws-1',
    targetId: 'target-1',
    metadata: { providerId: 'do-app-1', providerDeploymentId: 'do-deploy-1' },
  })),
  updateDeploymentStatus: vi.fn(async () => null),
  recordHealthCheck: vi.fn(async () => ({ id: 'hc-1', status: 'healthy' })),
  runDeploymentHealthCheck: vi.fn(async () => ({
    check: { id: 'hc-1', status: 'healthy' },
    result: { healthy: true, status: 200, responseTimeMs: 42 },
  })),
  rollbackDeployment: vi.fn(async () => ({
    deployment: { id: 'dep-1', status: 'rolled_back' },
    result: { status: 'rolled_back' },
  })),
};

vi.mock('@pilot/launch-engine', () => ({
  LaunchEngine: vi.fn().mockImplementation(() => mockEngine),
  DigitalOceanProvider: vi.fn().mockImplementation(() => ({ name: 'digitalocean' })),
}));

beforeEach(() => {
  Object.values(mockEngine).forEach((fn) => fn.mockClear());
});

function mockHelmClient() {
  return {
    evaluate: vi.fn(async (req: Record<string, unknown>) => ({
      receipt: {
        decisionId: `dec-${String(req['action']).toLowerCase()}`,
        verdict: 'ALLOW',
        policyVersion: 'founder-ops-v1',
        receivedAt: new Date(),
        action: req['action'],
        resource: req['resource'],
        principal: req['principal'],
      },
    })),
  };
}

function createDeployTargetDb(options: { failEvidence?: boolean } = {}) {
  const inserts: Array<{ table: unknown; value: unknown }> = [];
  const updates: Array<{ table: unknown; value: unknown }> = [];

  const createDbFacade = (
    insertSink: Array<{ table: unknown; value: unknown }>,
    updateSink: Array<{ table: unknown; value: unknown }>,
  ) => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => []),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertSink.push({ table, value });
        return {
          returning: vi.fn(async () => {
            if (table === deployTargets) {
              return [
                {
                  id: 'target-1',
                  workspaceId: value['workspaceId'],
                  name: value['name'],
                  provider: value['provider'],
                  config: value['config'],
                },
              ];
            }
            if (table === evidenceItems) {
              if (options.failEvidence) throw new Error('evidence unavailable');
              return [{ id: 'evidence-deploy-target-1' }];
            }
            return [];
          }),
          then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
            Promise.resolve([]).then(resolve, reject),
          catch: (reject: (reason: unknown) => void) => Promise.resolve([]).catch(reject),
        };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((value: unknown) => {
        updateSink.push({ table, value });
        return {
          where: vi.fn(async () => []),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => []),
    })),
    execute: vi.fn(async () => [{ '?column?': 1 }]),
  });

  const db = {
    ...createDbFacade(inserts, updates),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const stagedInserts: Array<{ table: unknown; value: unknown }> = [];
      const stagedUpdates: Array<{ table: unknown; value: unknown }> = [];
      const tx = createDbFacade(stagedInserts, stagedUpdates);
      const result = await callback(tx);
      inserts.push(...stagedInserts);
      updates.push(...stagedUpdates);
      return result;
    }),
    _setResult: vi.fn(),
    _reset: vi.fn(),
  };

  return { db, inserts, updates };
}

describe('launchRoutes', () => {
  const wsHeader = { 'X-Workspace-Id': 'ws-1' };

  // ─── GET /artifacts ───

  describe('GET /artifacts', () => {
    it('returns 400 without workspaceId', async () => {
      const { fetch } = testApp(launchRoutes);
      const res = await fetch('GET', '/artifacts');
      const json = await expectJson(res, 400);
      expect(json).toHaveProperty('error', 'workspaceId required');
    });

    it('returns list of artifacts', async () => {
      const artifacts = [{ id: 'art-1', name: 'bundle.zip' }];
      mockEngine.listArtifacts.mockResolvedValueOnce(artifacts);

      const { fetch } = testApp(launchRoutes);
      const res = await fetch('GET', '/artifacts', undefined, wsHeader);
      const json = await expectJson(res, 200);

      expect(mockEngine.listArtifacts).toHaveBeenCalledWith('ws-1');
      expect(json).toEqual(artifacts);
    });
  });

  // ─── GET /artifacts/:id ───

  describe('GET /artifacts/:id', () => {
    it('returns 404 when artifact not found', async () => {
      mockEngine.getArtifact.mockResolvedValueOnce(null);

      const { fetch } = testApp(launchRoutes);
      const res = await fetch('GET', '/artifacts/art-999', undefined, wsHeader);
      const json = await expectJson(res, 404);
      expect(json).toHaveProperty('error', 'Not found');
    });

    it('returns 200 when artifact found', async () => {
      const artifact = { id: 'art-1', workspaceId: 'ws-1', name: 'bundle.zip', size: 1024 };
      mockEngine.getArtifact.mockResolvedValueOnce(artifact);

      const { fetch } = testApp(launchRoutes);
      const res = await fetch('GET', '/artifacts/art-1', undefined, wsHeader);
      const json = await expectJson(res, 200);
      expect(json).toEqual(artifact);
    });
  });

  // ─── GET /deployments ───

  describe('GET /deployments', () => {
    it('returns 400 without workspaceId', async () => {
      const { fetch } = testApp(launchRoutes);
      const res = await fetch('GET', '/deployments');
      const json = await expectJson(res, 400);
      expect(json).toHaveProperty('error', 'workspaceId required');
    });

    it('returns list of deployments', async () => {
      const deployments = [{ id: 'dep-1', status: 'running' }];
      mockEngine.listDeployments.mockResolvedValueOnce(deployments);

      const { fetch } = testApp(launchRoutes);
      const res = await fetch('GET', '/deployments', undefined, wsHeader);
      const json = await expectJson(res, 200);

      expect(mockEngine.listDeployments).toHaveBeenCalledWith('ws-1');
      expect(json).toEqual(deployments);
    });
  });

  // ─── GET /targets ───

  describe('GET /targets', () => {
    it('returns 400 without workspaceId', async () => {
      const { fetch } = testApp(launchRoutes);
      const res = await fetch('GET', '/targets');
      const json = await expectJson(res, 400);
      expect(json).toHaveProperty('error', 'workspaceId required');
    });

    it('returns list of targets', async () => {
      const targets = [{ id: 'target-1', name: 'prod', provider: 'digitalocean' }];
      mockEngine.listDeployTargets.mockResolvedValueOnce(targets);

      const { fetch } = testApp(launchRoutes);
      const res = await fetch('GET', '/targets', undefined, wsHeader);
      const json = await expectJson(res, 200);

      expect(mockEngine.listDeployTargets).toHaveBeenCalledWith('ws-1');
      expect(json).toEqual(targets);
    });
  });

  // ─── POST /targets ───

  describe('POST /targets', () => {
    it('returns 400 when required fields are missing', async () => {
      const { fetch } = testApp(launchRoutes);
      const res = await fetch('POST', '/targets', { workspaceId: 'ws-1' }, wsHeader);
      const json = await expectJson(res, 400);
      expect(json).toHaveProperty('error', 'workspaceId, name, and provider required');
    });

    it('returns 403 when body workspaceId mismatches the bound workspace', async () => {
      const { fetch } = testApp(launchRoutes);
      const res = await fetch(
        'POST',
        '/targets',
        {
          workspaceId: 'ws-2',
          name: 'prod',
          provider: 'digitalocean',
        },
        wsHeader,
      );
      const json = await expectJson(res, 403);
      expect(json).toHaveProperty('error', 'workspaceId does not match authenticated workspace');
    });

    it('writes redacted audit-linked evidence on success', async () => {
      const { db, inserts, updates } = createDeployTargetDb();
      const deps = createMockDeps({ db: db as never });
      const { fetch } = testApp(launchRoutes, deps);
      const res = await fetch(
        'POST',
        '/targets',
        {
          workspaceId: 'ws-1',
          name: 'prod',
          provider: 'digitalocean',
          config: {
            image: 'registry.example.com/app:v1',
            envVars: { API_KEY: 'super-secret' },
          },
        },
        wsHeader,
      );
      const json = await expectJson<{
        id: string;
        name: string;
        provider: string;
        evidenceItemId: string;
      }>(res, 201);

      expect(mockEngine.createDeployTarget).not.toHaveBeenCalled();
      expect(json).toMatchObject({
        id: 'target-1',
        name: 'prod',
        provider: 'digitalocean',
      });
      expect(json.evidenceItemId).toBe('evidence-deploy-target-1');
      expect(inserts.map((insert) => insert.table)).toEqual([
        deployTargets,
        auditLog,
        evidenceItems,
      ]);
      expect(inserts.find((insert) => insert.table === deployTargets)?.value).toMatchObject({
        workspaceId: 'ws-1',
        name: 'prod',
        provider: 'digitalocean',
        config: {
          image: 'registry.example.com/app:v1',
          envVars: { API_KEY: 'super-secret' },
        },
      });
      const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
        id: string;
      };
      expect(auditInsert).toMatchObject({
        workspaceId: 'ws-1',
        action: 'DEPLOY_TARGET_CREATED',
        actor: 'user:user-1',
        target: 'target-1',
        verdict: 'allow',
        metadata: {
          evidenceType: 'deploy_target_created',
          targetId: 'target-1',
          targetName: 'prod',
          provider: 'digitalocean',
          configKeys: ['envVars', 'image'],
          configValuesStoredInEvidence: false,
        },
      });
      const evidenceInsert = inserts.find((insert) => insert.table === evidenceItems)?.value;
      expect(evidenceInsert).toMatchObject({
        workspaceId: 'ws-1',
        auditEventId: auditInsert.id,
        evidenceType: 'deploy_target_created',
        sourceType: 'gateway_launch',
        redactionState: 'redacted',
        sensitivity: 'restricted',
        metadata: {
          targetId: 'target-1',
          targetName: 'prod',
          provider: 'digitalocean',
          configKeys: ['envVars', 'image'],
          configValuesStoredInEvidence: false,
        },
      });
      expect(JSON.stringify(evidenceInsert)).not.toContain('super-secret');
      expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
        metadata: {
          evidenceItemId: 'evidence-deploy-target-1',
        },
      });
    });

    it('fails closed without committing deploy target rows when evidence persistence fails', async () => {
      const { db, inserts } = createDeployTargetDb({ failEvidence: true });
      const deps = createMockDeps({ db: db as never });
      const { fetch } = testApp(launchRoutes, deps);
      const res = await fetch(
        'POST',
        '/targets',
        {
          workspaceId: 'ws-1',
          name: 'prod',
          provider: 'digitalocean',
        },
        wsHeader,
      );
      const json = await expectJson<{ error: string }>(res, 500);

      expect(json.error).toContain('failed to persist deploy target evidence');
      expect(inserts).toEqual([]);
    });

    it('denies non-owner deploy target creation', async () => {
      const { fetch } = testApp(launchRoutes);
      const res = await fetch(
        'POST',
        '/targets',
        {
          workspaceId: 'ws-1',
          name: 'prod',
          provider: 'digitalocean',
        },
        { ...wsHeader, 'X-Workspace-Role': 'partner' },
      );
      const json = await expectJson<{ error: string; requiredRole: string }>(res, 403);

      expect(json.error).toBe('insufficient workspace role');
      expect(json.requiredRole).toBe('owner');
      expect(mockEngine.createDeployTarget).not.toHaveBeenCalled();
    });
  });

  // ─── POST /deployments ───

  describe('POST /deployments', () => {
    it('returns 400 when required fields are missing', async () => {
      const { fetch } = testApp(launchRoutes);
      const res = await fetch('POST', '/deployments', { workspaceId: 'ws-1' }, wsHeader);
      const json = await expectJson(res, 400);
      expect(json).toHaveProperty('error', 'workspaceId and targetId required');
    });

    it('blocks elevated deployment execution when HELM is unavailable', async () => {
      const { fetch } = testApp(launchRoutes);
      const res = await fetch(
        'POST',
        '/deployments',
        {
          workspaceId: 'ws-1',
          targetId: 'target-1',
          image: 'registry.example.com/app:v1',
        },
        wsHeader,
      );
      const json = await expectJson<{ error: string }>(res, 503);

      expect(json.error).toBe('HELM governance client is required for elevated launch actions');
      expect(mockEngine.deployToTarget).not.toHaveBeenCalled();
    });

    it('returns 201 with audit-linked evidence on success after HELM approval', async () => {
      const helmClient = mockHelmClient();
      const { db, inserts, updates } = createDeployTargetDb();
      const deps = createMockDeps({ helmClient: helmClient as never, db: db as never });
      const { fetch } = testApp(launchRoutes, deps);
      const res = await fetch(
        'POST',
        '/deployments',
        {
          workspaceId: 'ws-1',
          targetId: 'target-1',
          image: 'registry.example.com/app:v1',
          envVars: { API_KEY: 'super-secret' },
        },
        wsHeader,
      );
      const json = await expectJson<{
        deployment: { status: string };
        evidenceItemId: string;
        auditEventId: string;
        replayRef: string;
      }>(res, 201);

      expect(helmClient.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DEPLOY',
          resource: 'digitalocean:target-1',
          effectLevel: 'E3',
        }),
      );
      expect(mockEngine.deployToTarget).toHaveBeenCalledWith(
        'ws-1',
        {
          targetId: 'target-1',
          artifactId: undefined,
          version: undefined,
          image: 'registry.example.com/app:v1',
          appName: undefined,
          region: undefined,
          envVars: { API_KEY: 'super-secret' },
        },
        expect.objectContaining({ name: 'digitalocean' }),
        expect.objectContaining({
          surface: 'launch',
          action: 'DEPLOY',
          policyDecisionId: 'dec-deploy',
          policyVersion: 'founder-ops-v1',
          policyPin: expect.objectContaining({
            documentVersionPins: { deploymentPolicy: 'founder-ops-v1' },
          }),
        }),
      );
      expect(json.deployment.status).toBe('live');
      expect(json.evidenceItemId).toBe('evidence-deploy-target-1');
      expect(json.auditEventId).toBeTruthy();
      expect(json.replayRef).toContain('launch:ws-1:deploy:');
      expect(inserts.map((insert) => insert.table)).toEqual([auditLog, evidenceItems]);
      const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
        id: string;
      };
      expect(auditInsert).toMatchObject({
        workspaceId: 'ws-1',
        action: 'DEPLOY',
        actor: 'user:user-1',
        target: 'digitalocean:target-1',
        verdict: 'pending',
        metadata: {
          evidenceType: 'launch_deployment_requested',
          executionStatus: 'pending',
          targetId: 'target-1',
          provider: 'digitalocean',
          imageProvided: true,
          envVarKeys: ['API_KEY'],
        },
      });
      const evidenceInsert = inserts.find((insert) => insert.table === evidenceItems)?.value;
      expect(evidenceInsert).toMatchObject({
        workspaceId: 'ws-1',
        auditEventId: auditInsert.id,
        evidenceType: 'launch_deployment_requested',
        sourceType: 'gateway_launch',
        redactionState: 'redacted',
        sensitivity: 'restricted',
        metadata: {
          envVarKeys: ['API_KEY'],
          secretValuesStoredInEvidence: false,
        },
      });
      expect(JSON.stringify(evidenceInsert)).not.toContain('super-secret');
      expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
        metadata: { evidenceItemId: 'evidence-deploy-target-1' },
      });
      expect(updates.at(-1)?.value).toMatchObject({
        verdict: 'allow',
        metadata: {
          executionStatus: 'completed',
          deploymentId: 'deploy-1',
          providerDeploymentId: 'do-deploy-1',
          providerStatus: 'live',
        },
      });
    });

    it('fails closed before deployment dispatch when evidence persistence fails', async () => {
      const helmClient = mockHelmClient();
      const { db, inserts } = createDeployTargetDb({ failEvidence: true });
      const deps = createMockDeps({ helmClient: helmClient as never, db: db as never });
      const { fetch } = testApp(launchRoutes, deps);
      const res = await fetch(
        'POST',
        '/deployments',
        {
          workspaceId: 'ws-1',
          targetId: 'target-1',
          image: 'registry.example.com/app:v1',
        },
        wsHeader,
      );
      const json = await expectJson<{ error: string }>(res, 500);

      expect(json.error).toBe('failed to persist launch deployment evidence');
      expect(mockEngine.deployToTarget).not.toHaveBeenCalled();
      expect(inserts).toEqual([]);
    });
  });

  // ─── PUT /deployments/:id/status ───

  describe('PUT /deployments/:id/status', () => {
    it('returns 404 when deployment not found', async () => {
      mockEngine.updateDeploymentStatus.mockResolvedValueOnce(null);

      const { fetch } = testApp(launchRoutes);
      const res = await fetch(
        'PUT',
        '/deployments/dep-999/status',
        { status: 'running' },
        wsHeader,
      );
      const json = await expectJson(res, 404);
      expect(json).toHaveProperty('error', 'Deployment not found');
    });

    it('returns 200 when updated', async () => {
      const updated = { id: 'dep-1', status: 'running', url: 'https://app.ondigitalocean.app' };
      mockEngine.updateDeploymentStatus.mockResolvedValueOnce(updated);

      const { fetch } = testApp(launchRoutes);
      const res = await fetch(
        'PUT',
        '/deployments/dep-1/status',
        {
          status: 'running',
          url: 'https://app.ondigitalocean.app',
        },
        wsHeader,
      );
      const json = await expectJson(res, 200);

      expect(mockEngine.updateDeploymentStatus).toHaveBeenCalledWith(
        'dep-1',
        'running',
        'https://app.ondigitalocean.app',
        undefined,
        'ws-1',
      );
      expect(json).toEqual(updated);
    });
  });

  // ─── POST /deployments/:id/health ───

  describe('POST /deployments/:id/health', () => {
    it('blocks elevated health checks when HELM is unavailable', async () => {
      const { fetch } = testApp(launchRoutes);
      const res = await fetch('POST', '/deployments/dep-1/health', undefined, wsHeader);
      const json = await expectJson<{ error: string }>(res, 503);

      expect(json.error).toBe('HELM governance client is required for elevated launch actions');
      expect(mockEngine.runDeploymentHealthCheck).not.toHaveBeenCalled();
    });

    it('returns 201 with audit-linked evidence on success', async () => {
      const helmClient = mockHelmClient();
      const { db, inserts, updates } = createDeployTargetDb();
      const deps = createMockDeps({ helmClient: helmClient as never, db: db as never });
      const { fetch } = testApp(launchRoutes, deps);
      const res = await fetch('POST', '/deployments/dep-1/health', undefined, wsHeader);
      const json = await expectJson<{
        check: { id: string; status: string };
        evidenceItemId: string;
        auditEventId: string;
        replayRef: string;
      }>(res, 201);

      expect(helmClient.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DEPLOY_HEALTH_CHECK',
          resource: 'digitalocean:target-1',
          effectLevel: 'E2',
        }),
      );
      expect(mockEngine.runDeploymentHealthCheck).toHaveBeenCalledWith(
        'dep-1',
        expect.objectContaining({ name: 'digitalocean' }),
        'ws-1',
        expect.objectContaining({
          surface: 'launch',
          action: 'DEPLOY_HEALTH_CHECK',
          policyDecisionId: 'dec-deploy_health_check',
          policyVersion: 'founder-ops-v1',
        }),
      );
      expect(json.check).toEqual({ id: 'hc-1', status: 'healthy' });
      expect(json.evidenceItemId).toBe('evidence-deploy-target-1');
      expect(json.auditEventId).toBeTruthy();
      expect(json.replayRef).toContain('launch:ws-1:deploy_health_check:');
      expect(inserts.map((insert) => insert.table)).toEqual([auditLog, evidenceItems]);
      expect(inserts.find((insert) => insert.table === auditLog)?.value).toMatchObject({
        workspaceId: 'ws-1',
        action: 'DEPLOY_HEALTH_CHECK',
        target: 'digitalocean:target-1',
        verdict: 'pending',
        metadata: {
          evidenceType: 'launch_deployment_health_check_requested',
          executionStatus: 'pending',
          deploymentId: 'dep-1',
          provider: 'digitalocean',
        },
      });
      expect(updates.at(-1)?.value).toMatchObject({
        verdict: 'allow',
        metadata: {
          executionStatus: 'completed',
          deploymentId: 'dep-1',
          healthStatus: 'healthy',
          providerStatus: 200,
          responseTimeMs: 42,
        },
      });
    });

    it('fails closed before health-check dispatch when evidence persistence fails', async () => {
      const helmClient = mockHelmClient();
      const { db, inserts } = createDeployTargetDb({ failEvidence: true });
      const deps = createMockDeps({ helmClient: helmClient as never, db: db as never });
      const { fetch } = testApp(launchRoutes, deps);
      const res = await fetch('POST', '/deployments/dep-1/health', undefined, wsHeader);
      const json = await expectJson<{ error: string }>(res, 500);

      expect(json.error).toBe('failed to persist launch health-check evidence');
      expect(mockEngine.runDeploymentHealthCheck).not.toHaveBeenCalled();
      expect(inserts).toEqual([]);
    });
  });

  // ─── POST /deployments/:id/rollback ───

  describe('POST /deployments/:id/rollback', () => {
    it('blocks elevated rollback when HELM is unavailable', async () => {
      const { fetch } = testApp(launchRoutes);
      const res = await fetch(
        'POST',
        '/deployments/dep-1/rollback',
        { targetVersion: 'v1' },
        wsHeader,
      );
      const json = await expectJson<{ error: string }>(res, 503);

      expect(json.error).toBe('HELM governance client is required for elevated launch actions');
      expect(mockEngine.rollbackDeployment).not.toHaveBeenCalled();
    });

    it('runs rollback only after HELM approval and evidence persistence', async () => {
      const helmClient = mockHelmClient();
      const { db, inserts, updates } = createDeployTargetDb();
      const deps = createMockDeps({ helmClient: helmClient as never, db: db as never });
      const { fetch } = testApp(launchRoutes, deps);
      const res = await fetch(
        'POST',
        '/deployments/dep-1/rollback',
        { targetVersion: 'v1' },
        wsHeader,
      );
      const json = await expectJson<{
        deployment: { id: string; status: string };
        evidenceItemId: string;
        auditEventId: string;
        replayRef: string;
      }>(res, 200);

      expect(helmClient.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'DEPLOY_ROLLBACK',
          resource: 'digitalocean:target-1',
          effectLevel: 'E3',
        }),
      );
      expect(mockEngine.rollbackDeployment).toHaveBeenCalledWith(
        'dep-1',
        'v1',
        expect.objectContaining({ name: 'digitalocean' }),
        'ws-1',
        expect.objectContaining({
          surface: 'launch',
          action: 'DEPLOY_ROLLBACK',
          policyDecisionId: 'dec-deploy_rollback',
          policyVersion: 'founder-ops-v1',
        }),
      );
      expect(json.deployment).toEqual({ id: 'dep-1', status: 'rolled_back' });
      expect(json.evidenceItemId).toBe('evidence-deploy-target-1');
      expect(json.auditEventId).toBeTruthy();
      expect(json.replayRef).toContain('launch:ws-1:deploy_rollback:');
      expect(inserts.map((insert) => insert.table)).toEqual([auditLog, evidenceItems]);
      expect(inserts.find((insert) => insert.table === auditLog)?.value).toMatchObject({
        workspaceId: 'ws-1',
        action: 'DEPLOY_ROLLBACK',
        target: 'digitalocean:target-1',
        verdict: 'pending',
        metadata: {
          evidenceType: 'launch_deployment_rollback_requested',
          executionStatus: 'pending',
          deploymentId: 'dep-1',
          targetVersion: 'v1',
          provider: 'digitalocean',
        },
      });
      expect(updates.at(-1)?.value).toMatchObject({
        verdict: 'allow',
        metadata: {
          executionStatus: 'completed',
          deploymentId: 'dep-1',
          targetVersion: 'v1',
          rollbackStatus: 'rolled_back',
          deploymentStatus: 'rolled_back',
        },
      });
    });

    it('fails closed before rollback dispatch when evidence persistence fails', async () => {
      const helmClient = mockHelmClient();
      const { db, inserts } = createDeployTargetDb({ failEvidence: true });
      const deps = createMockDeps({ helmClient: helmClient as never, db: db as never });
      const { fetch } = testApp(launchRoutes, deps);
      const res = await fetch(
        'POST',
        '/deployments/dep-1/rollback',
        { targetVersion: 'v1' },
        wsHeader,
      );
      const json = await expectJson<{ error: string }>(res, 500);

      expect(json.error).toBe('failed to persist launch rollback evidence');
      expect(mockEngine.rollbackDeployment).not.toHaveBeenCalled();
      expect(inserts).toEqual([]);
    });
  });
});
