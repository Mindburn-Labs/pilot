import { Hono } from 'hono';
import { type Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { DigitalOceanProvider, LaunchEngine, type DeployProvider } from '@pilot/launch-engine';
import {
  HelmDeniedError,
  HelmEscalationError,
  HelmUnreachableError,
  type EvaluateResult,
} from '@pilot/helm-client';
import { and, eq } from 'drizzle-orm';
import { appendEvidenceItem } from '@pilot/db';
import { auditLog, deployTargets, users } from '@pilot/db/schema';
import { ManagedTelegramReplyInput } from '@pilot/shared/schemas';
import { type GatewayDeps } from '../index.js';
import { getWorkspaceId, requireWorkspaceRole, workspaceIdMismatch } from '../lib/workspace.js';
import { ManagedTelegramBotError } from '../services/managed-telegram-bots.js';

export function launchRoutes(deps: GatewayDeps) {
  const engine = new LaunchEngine(deps.db);
  const app = new Hono();

  // GET /api/launch/telegram-bot — Managed Telegram launch/support bot state
  app.get('/telegram-bot', async (c) => {
    if (!deps.managedTelegram) return c.json({ error: 'Managed Telegram bots unavailable' }, 503);
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    return c.json(await deps.managedTelegram.getState(workspaceId));
  });

  // POST /api/launch/telegram-bot/provisioning-request
  app.post('/telegram-bot/provisioning-request', async (c) => {
    if (!deps.managedTelegram) return c.json({ error: 'Managed Telegram bots unavailable' }, 503);
    const workspaceId = getWorkspaceId(c);
    const userId = c.get('userId');
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    if (!userId) return c.json({ error: 'userId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'owner', 'create managed launch bot');
    if (roleDenied) return roleDenied;

    const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user?.telegramId) {
      return c.json({ error: 'Telegram-authenticated owner required to create a launch bot' }, 400);
    }

    try {
      const request = await deps.managedTelegram.createProvisioningRequest({
        workspaceId,
        userId,
        creatorTelegramId: user.telegramId,
      });
      return c.json(request, 201);
    } catch (err) {
      return managedTelegramError(c, err);
    }
  });

  // PATCH /api/launch/telegram-bot/settings
  app.patch('/telegram-bot/settings', async (c) => {
    if (!deps.managedTelegram) return c.json({ error: 'Managed Telegram bots unavailable' }, 503);
    const workspaceId = getWorkspaceId(c);
    const userId = c.get('userId');
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    if (!userId) return c.json({ error: 'userId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'owner', 'update managed launch bot settings');
    if (roleDenied) return roleDenied;
    const body = await c.req.json().catch(() => null);
    try {
      const bot = await deps.managedTelegram.updateSettings(workspaceId, userId, body);
      return c.json(bot);
    } catch (err) {
      return managedTelegramError(c, err);
    }
  });

  // GET /api/launch/telegram-bot/messages
  app.get('/telegram-bot/messages', async (c) => {
    if (!deps.managedTelegram) return c.json({ error: 'Managed Telegram bots unavailable' }, 503);
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const messages = await deps.managedTelegram.listMessages(workspaceId);
    return c.json(messages);
  });

  // POST /api/launch/telegram-bot/messages/:id/reply
  app.post('/telegram-bot/messages/:id/reply', async (c) => {
    if (!deps.managedTelegram) return c.json({ error: 'Managed Telegram bots unavailable' }, 503);
    const workspaceId = getWorkspaceId(c);
    const userId = c.get('userId');
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    if (!userId) return c.json({ error: 'userId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'owner', 'send managed launch bot replies');
    if (roleDenied) return roleDenied;
    const parsed = ManagedTelegramReplyInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    try {
      const message = await deps.managedTelegram.sendManualReply(
        workspaceId,
        userId,
        c.req.param('id'),
        parsed.data.text,
      );
      return c.json(message);
    } catch (err) {
      return managedTelegramError(c, err);
    }
  });

  // POST /api/launch/telegram-bot/rotate-token
  app.post('/telegram-bot/rotate-token', async (c) => {
    if (!deps.managedTelegram) return c.json({ error: 'Managed Telegram bots unavailable' }, 503);
    const workspaceId = getWorkspaceId(c);
    const userId = c.get('userId');
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    if (!userId) return c.json({ error: 'userId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'owner', 'rotate managed launch bot token');
    if (roleDenied) return roleDenied;
    try {
      return c.json(await deps.managedTelegram.rotateToken(workspaceId, userId));
    } catch (err) {
      return managedTelegramError(c, err);
    }
  });

  // POST /api/launch/telegram-bot/disable
  app.post('/telegram-bot/disable', async (c) => {
    if (!deps.managedTelegram) return c.json({ error: 'Managed Telegram bots unavailable' }, 503);
    const workspaceId = getWorkspaceId(c);
    const userId = c.get('userId');
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    if (!userId) return c.json({ error: 'userId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'owner', 'disable managed launch bot');
    if (roleDenied) return roleDenied;
    try {
      return c.json(await deps.managedTelegram.disable(workspaceId, userId));
    } catch (err) {
      return managedTelegramError(c, err);
    }
  });

  // GET /api/launch/artifacts?workspaceId=...
  app.get('/artifacts', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const list = await engine.listArtifacts(workspaceId);
    return c.json(list);
  });

  // GET /api/launch/artifacts/:id
  app.get('/artifacts/:id', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const artifact = await engine.getArtifact(c.req.param('id'), workspaceId);
    if (!artifact) return c.json({ error: 'Not found' }, 404);
    return c.json(artifact);
  });

  // GET /api/launch/deployments?workspaceId=...
  app.get('/deployments', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const list = await engine.listDeployments(workspaceId);
    return c.json(list);
  });

  // GET /api/launch/targets?workspaceId=...
  app.get('/targets', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const targets = await engine.listDeployTargets(workspaceId);
    return c.json(targets);
  });

  // POST /api/launch/targets — Create a deploy target
  app.post('/targets', async (c) => {
    const body = await c.req.json();
    const { name, provider, config } = body as {
      workspaceId?: string;
      name: string;
      provider: string;
      config?: Record<string, unknown>;
    };
    const workspaceId = getWorkspaceId(c);
    if (workspaceIdMismatch(c, (body as { workspaceId?: string }).workspaceId)) {
      return c.json({ error: 'workspaceId does not match authenticated workspace' }, 403);
    }
    if (!workspaceId || !name || !provider) {
      return c.json({ error: 'workspaceId, name, and provider required' }, 400);
    }
    const roleDenied = requireWorkspaceRole(c, 'owner', 'create deploy targets');
    if (roleDenied) return roleDenied;
    const created = await deps.db
      .transaction(async (tx) => {
        const [target] = await tx
          .insert(deployTargets)
          .values({
            workspaceId,
            name,
            provider,
            config: config ?? {},
          })
          .returning();
        if (!target) throw new Error('failed to create deploy target');

        const auditEventId = randomUUID();
        const replayRef = `deploy-target:${workspaceId}:${target.id}:created`;
        const evidenceMetadata = {
          targetId: target.id,
          targetName: name,
          provider,
          configKeys: Object.keys(config ?? {}).sort(),
          configValuesStoredInEvidence: false,
        };

        await tx.insert(auditLog).values({
          id: auditEventId,
          workspaceId,
          action: 'DEPLOY_TARGET_CREATED',
          actor: `user:${(c.get('userId') as string | undefined) ?? 'unknown'}`,
          target: target.id,
          verdict: 'allow',
          metadata: {
            evidenceType: 'deploy_target_created',
            replayRef,
            ...evidenceMetadata,
          },
        });

        const evidenceItemId = await appendEvidenceItem(tx, {
          workspaceId,
          auditEventId,
          evidenceType: 'deploy_target_created',
          sourceType: 'gateway_launch',
          title: `Deploy target created: ${name}`,
          summary:
            'Workspace deploy target was created; provider config values were not stored in evidence.',
          redactionState: 'redacted',
          sensitivity: 'restricted',
          replayRef,
          metadata: evidenceMetadata,
        });

        await tx
          .update(auditLog)
          .set({
            metadata: {
              evidenceType: 'deploy_target_created',
              replayRef,
              evidenceItemId,
              ...evidenceMetadata,
            },
          })
          .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

        return { target, evidenceItemId };
      })
      .catch(() => null);

    if (!created) return c.json({ error: 'failed to persist deploy target evidence' }, 500);
    return c.json({ ...created.target, evidenceItemId: created.evidenceItemId }, 201);
  });

  // POST /api/launch/deployments — Execute a provider deployment
  app.post('/deployments', async (c) => {
    const body = await c.req.json();
    const { targetId, artifactId, version, image, appName, region, envVars } = body as {
      workspaceId?: string;
      targetId: string;
      artifactId?: string;
      version?: string;
      image?: string;
      appName?: string;
      region?: string;
      envVars?: Record<string, string>;
    };
    const workspaceId = getWorkspaceId(c);
    if (workspaceIdMismatch(c, (body as { workspaceId?: string }).workspaceId)) {
      return c.json({ error: 'workspaceId does not match authenticated workspace' }, 403);
    }
    if (!workspaceId || !targetId) {
      return c.json({ error: 'workspaceId and targetId required' }, 400);
    }
    const roleDenied = requireWorkspaceRole(c, 'owner', 'execute deployments');
    if (roleDenied) return roleDenied;
    const target = await engine.getDeployTarget(targetId, workspaceId);
    if (!target) {
      return c.json({ error: 'Deploy target not found' }, 404);
    }
    const provider = providerFor(target.provider);
    if (!provider) {
      return c.json({ error: `Unsupported deploy provider: ${target.provider}` }, 400);
    }

    const governed = await evaluateLaunchAction(deps, {
      workspaceId,
      action: 'DEPLOY',
      resource: `${target.provider}:${targetId}`,
      context: { targetId, artifactId, version, image, appName, region },
    });
    if (governed instanceof Response) return governed;

    const executionAudit = await persistLaunchExecutionAudit(c, deps, {
      workspaceId,
      action: 'DEPLOY',
      target: `${target.provider}:${targetId}`,
      evidenceType: 'launch_deployment_requested',
      title: 'Launch deployment provider call requested',
      summary:
        'HELM-approved deployment provider call was durably recorded before dispatch; environment values were not stored in evidence.',
      metadata: {
        targetId,
        provider: target.provider,
        artifactId: artifactId ?? null,
        version: version ?? null,
        imageProvided: Boolean(image),
        appNameProvided: Boolean(appName),
        region: region ?? null,
        envVarKeys: Object.keys(envVars ?? {}).sort(),
        governance: governed ? launchGovernanceMetadata('DEPLOY', governed) : null,
      },
    }).catch(() => null);
    if (!executionAudit) {
      return c.json({ error: 'failed to persist launch deployment evidence' }, 500);
    }

    try {
      const result = await engine.deployToTarget(
        workspaceId,
        { targetId, artifactId, version, image, appName, region, envVars },
        provider,
        governed ? launchGovernanceMetadata('DEPLOY', governed) : undefined,
      );
      await markLaunchExecutionAudit(deps, workspaceId, executionAudit, 'allow', {
        executionStatus: 'completed',
        deploymentId: result.deployment.id,
        providerDeploymentId: result.providerDeployment.deploymentId,
        providerStatus: result.providerDeployment.status,
        urlRecorded: Boolean(result.providerDeployment.url),
      });
      return c.json(
        {
          ...result,
          helmReceipt: governed?.receipt,
          auditEventId: executionAudit.auditEventId,
          evidenceItemId: executionAudit.evidenceItemId,
          replayRef: executionAudit.replayRef,
        },
        201,
      );
    } catch (err) {
      await markLaunchExecutionAudit(deps, workspaceId, executionAudit, 'failed', {
        executionStatus: 'failed',
        error: err instanceof Error ? err.message : 'Deployment failed',
      }).catch(() => undefined);
      return c.json(
        {
          error: err instanceof Error ? err.message : 'Deployment failed',
          helmReceipt: governed?.receipt,
          auditEventId: executionAudit.auditEventId,
          evidenceItemId: executionAudit.evidenceItemId,
          replayRef: executionAudit.replayRef,
        },
        502,
      );
    }
  });

  // PUT /api/launch/deployments/:id/status — Update deployment status
  app.put('/deployments/:id/status', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'owner', 'update deployment status');
    if (roleDenied) return roleDenied;

    const { id } = c.req.param();
    const body = await c.req.json();
    const { status, url } = body as { status: string; url?: string };
    const deployment = await engine.getDeployment(id, workspaceId);
    if (!deployment) {
      return c.json({ error: 'Deployment not found' }, 404);
    }
    const updated = await engine.updateDeploymentStatus(id, status, url, undefined, workspaceId);
    if (!updated) return c.json({ error: 'Deployment not found' }, 404);
    return c.json(updated);
  });

  // POST /api/launch/deployments/:id/health — Run a provider health check
  app.post('/deployments/:id/health', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'owner', 'run deployment health checks');
    if (roleDenied) return roleDenied;

    const { id } = c.req.param();
    const deployment = await engine.getDeployment(id, workspaceId);
    if (!deployment) return c.json({ error: 'Deployment not found' }, 404);
    const target = await engine.getDeployTarget(deployment.targetId, workspaceId);
    if (!target) return c.json({ error: 'Deploy target not found' }, 404);
    const provider = providerFor(target.provider);
    if (!provider) return c.json({ error: `Unsupported deploy provider: ${target.provider}` }, 400);

    const governed = await evaluateLaunchAction(deps, {
      workspaceId: deployment.workspaceId,
      action: 'DEPLOY_HEALTH_CHECK',
      resource: `${target.provider}:${target.id}`,
      context: { deploymentId: id },
    });
    if (governed instanceof Response) return governed;

    const executionAudit = await persistLaunchExecutionAudit(c, deps, {
      workspaceId,
      action: 'DEPLOY_HEALTH_CHECK',
      target: `${target.provider}:${target.id}`,
      evidenceType: 'launch_deployment_health_check_requested',
      title: 'Launch deployment health check requested',
      summary:
        'HELM-approved deployment health check was durably recorded before provider dispatch.',
      metadata: {
        deploymentId: id,
        targetId: target.id,
        provider: target.provider,
        governance: governed ? launchGovernanceMetadata('DEPLOY_HEALTH_CHECK', governed) : null,
      },
    }).catch(() => null);
    if (!executionAudit) {
      return c.json({ error: 'failed to persist launch health-check evidence' }, 500);
    }

    try {
      const result = await engine.runDeploymentHealthCheck(
        id,
        provider,
        workspaceId,
        governed ? launchGovernanceMetadata('DEPLOY_HEALTH_CHECK', governed) : undefined,
      );
      await markLaunchExecutionAudit(deps, workspaceId, executionAudit, 'allow', {
        executionStatus: 'completed',
        deploymentId: id,
        healthStatus: result.check.status,
        providerStatus: result.result.status,
        responseTimeMs: result.result.responseTimeMs,
      });
      return c.json(
        {
          ...result,
          helmReceipt: governed?.receipt,
          auditEventId: executionAudit.auditEventId,
          evidenceItemId: executionAudit.evidenceItemId,
          replayRef: executionAudit.replayRef,
        },
        201,
      );
    } catch (err) {
      await markLaunchExecutionAudit(deps, workspaceId, executionAudit, 'failed', {
        executionStatus: 'failed',
        deploymentId: id,
        error: err instanceof Error ? err.message : 'Health check failed',
      }).catch(() => undefined);
      return c.json(
        {
          error: err instanceof Error ? err.message : 'Health check failed',
          helmReceipt: governed?.receipt,
          auditEventId: executionAudit.auditEventId,
          evidenceItemId: executionAudit.evidenceItemId,
          replayRef: executionAudit.replayRef,
        },
        502,
      );
    }
  });

  // POST /api/launch/deployments/:id/rollback — Roll back a provider deployment
  app.post('/deployments/:id/rollback', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'owner', 'rollback deployments');
    if (roleDenied) return roleDenied;

    const { id } = c.req.param();
    const body = await c.req.json();
    const { targetVersion } = body as { targetVersion?: string };
    if (!targetVersion) return c.json({ error: 'targetVersion required' }, 400);

    const deployment = await engine.getDeployment(id, workspaceId);
    if (!deployment) return c.json({ error: 'Deployment not found' }, 404);
    const target = await engine.getDeployTarget(deployment.targetId, workspaceId);
    if (!target) return c.json({ error: 'Deploy target not found' }, 404);
    const provider = providerFor(target.provider);
    if (!provider) return c.json({ error: `Unsupported deploy provider: ${target.provider}` }, 400);

    const governed = await evaluateLaunchAction(deps, {
      workspaceId: deployment.workspaceId,
      action: 'DEPLOY_ROLLBACK',
      resource: `${target.provider}:${target.id}`,
      context: { deploymentId: id, targetVersion },
    });
    if (governed instanceof Response) return governed;

    const executionAudit = await persistLaunchExecutionAudit(c, deps, {
      workspaceId,
      action: 'DEPLOY_ROLLBACK',
      target: `${target.provider}:${target.id}`,
      evidenceType: 'launch_deployment_rollback_requested',
      title: 'Launch deployment rollback requested',
      summary: 'HELM-approved deployment rollback was durably recorded before provider dispatch.',
      metadata: {
        deploymentId: id,
        targetId: target.id,
        targetVersion,
        provider: target.provider,
        governance: governed ? launchGovernanceMetadata('DEPLOY_ROLLBACK', governed) : null,
      },
    }).catch(() => null);
    if (!executionAudit) {
      return c.json({ error: 'failed to persist launch rollback evidence' }, 500);
    }

    try {
      const result = await engine.rollbackDeployment(
        id,
        targetVersion,
        provider,
        workspaceId,
        governed ? launchGovernanceMetadata('DEPLOY_ROLLBACK', governed) : undefined,
      );
      await markLaunchExecutionAudit(deps, workspaceId, executionAudit, 'allow', {
        executionStatus: 'completed',
        deploymentId: id,
        targetVersion,
        rollbackStatus: result.result.status,
        deploymentStatus: result.deployment?.status ?? null,
      });
      return c.json({
        ...result,
        helmReceipt: governed?.receipt,
        auditEventId: executionAudit.auditEventId,
        evidenceItemId: executionAudit.evidenceItemId,
        replayRef: executionAudit.replayRef,
      });
    } catch (err) {
      await markLaunchExecutionAudit(deps, workspaceId, executionAudit, 'failed', {
        executionStatus: 'failed',
        deploymentId: id,
        targetVersion,
        error: err instanceof Error ? err.message : 'Rollback failed',
      }).catch(() => undefined);
      return c.json(
        {
          error: err instanceof Error ? err.message : 'Rollback failed',
          helmReceipt: governed?.receipt,
          auditEventId: executionAudit.auditEventId,
          evidenceItemId: executionAudit.evidenceItemId,
          replayRef: executionAudit.replayRef,
        },
        502,
      );
    }
  });

  return app;
}

function providerFor(name: string): DeployProvider | null {
  if (name === 'digitalocean') return new DigitalOceanProvider();
  return null;
}

function managedTelegramError(c: Context, err: unknown) {
  if (err instanceof ManagedTelegramBotError) {
    return c.json({ error: err.message, receipt: err.receipt }, err.status as never);
  }
  throw err;
}

type LaunchExecutionAudit = {
  auditEventId: string;
  evidenceItemId: string;
  replayRef: string;
  metadata: Record<string, unknown>;
};

async function persistLaunchExecutionAudit(
  c: Context,
  deps: GatewayDeps,
  input: {
    workspaceId: string;
    action: string;
    target: string;
    evidenceType: string;
    title: string;
    summary: string;
    metadata: Record<string, unknown>;
  },
): Promise<LaunchExecutionAudit> {
  const auditEventId = randomUUID();
  const replayRef = `launch:${input.workspaceId}:${input.action.toLowerCase()}:${auditEventId}`;
  const actor = `user:${(c.get('userId') as string | undefined) ?? 'unknown'}`;
  const metadata = {
    evidenceType: input.evidenceType,
    replayRef,
    action: input.action,
    executionStatus: 'pending',
    ...input.metadata,
  };

  return deps.db.transaction(async (tx) => {
    await tx.insert(auditLog).values({
      id: auditEventId,
      workspaceId: input.workspaceId,
      action: input.action,
      actor,
      target: input.target,
      verdict: 'pending',
      metadata,
    });

    const evidenceItemId = await appendEvidenceItem(tx, {
      workspaceId: input.workspaceId,
      auditEventId,
      evidenceType: input.evidenceType,
      sourceType: 'gateway_launch',
      title: input.title,
      summary: input.summary,
      redactionState: 'redacted',
      sensitivity: 'restricted',
      replayRef,
      metadata: {
        ...metadata,
        secretValuesStoredInEvidence: false,
      },
    });

    await tx
      .update(auditLog)
      .set({
        metadata: {
          ...metadata,
          evidenceItemId,
          secretValuesStoredInEvidence: false,
        },
      })
      .where(and(eq(auditLog.workspaceId, input.workspaceId), eq(auditLog.id, auditEventId)));

    return {
      auditEventId,
      evidenceItemId,
      replayRef,
      metadata: {
        ...metadata,
        evidenceItemId,
        secretValuesStoredInEvidence: false,
      },
    };
  });
}

async function markLaunchExecutionAudit(
  deps: GatewayDeps,
  workspaceId: string,
  executionAudit: LaunchExecutionAudit,
  verdict: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await deps.db
    .update(auditLog)
    .set({
      verdict,
      metadata: {
        ...executionAudit.metadata,
        ...metadata,
      },
    })
    .where(
      and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, executionAudit.auditEventId)),
    );
}

async function evaluateLaunchAction(
  deps: GatewayDeps,
  input: {
    workspaceId: string;
    action: string;
    resource: string;
    context: Record<string, unknown>;
  },
) {
  const effectLevel = launchActionEffectLevel(input.action);
  if (!deps.helmClient) {
    const requireHelm =
      process.env['NODE_ENV'] === 'production' && process.env['HELM_FAIL_CLOSED'] !== '0';
    if (requireHelm || isElevatedLaunchEffectLevel(effectLevel)) {
      return Response.json(
        {
          error: isElevatedLaunchEffectLevel(effectLevel)
            ? 'HELM governance client is required for elevated launch actions'
            : 'HELM governance client is required for production launch actions',
        },
        { status: 503 },
      );
    }
    return null;
  }

  try {
    return await deps.helmClient.evaluate({
      principal: `workspace:${input.workspaceId}/operator:launch`,
      action: input.action,
      resource: input.resource,
      effectLevel,
      context: { ...input.context, workspaceId: input.workspaceId },
    });
  } catch (err) {
    if (err instanceof HelmDeniedError) {
      return Response.json({ error: err.reason, receipt: err.receipt }, { status: 403 });
    }
    if (err instanceof HelmEscalationError) {
      return Response.json({ error: err.reason, receipt: err.receipt }, { status: 409 });
    }
    if (err instanceof HelmUnreachableError) {
      return Response.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}

function launchActionEffectLevel(action: string): 'E1' | 'E2' | 'E3' | 'E4' {
  if (action === 'DEPLOY' || action === 'DEPLOY_ROLLBACK') return 'E3';
  if (action === 'DEPLOY_HEALTH_CHECK') return 'E2';
  return 'E1';
}

function isElevatedLaunchEffectLevel(effectLevel: string): boolean {
  return effectLevel === 'E2' || effectLevel === 'E3' || effectLevel === 'E4';
}

function launchGovernanceMetadata(action: string, governed: EvaluateResult) {
  return {
    surface: 'launch',
    action,
    policyDecisionId: governed.receipt.decisionId,
    policyVersion: governed.receipt.policyVersion,
    evidencePackId: governed.evidencePackId ?? null,
    policyPin: {
      policyDecisionId: governed.receipt.decisionId,
      policyVersion: governed.receipt.policyVersion,
      decisionRequired: true,
      documentVersionPins: {
        deploymentPolicy: governed.receipt.policyVersion,
      },
    },
  };
}
