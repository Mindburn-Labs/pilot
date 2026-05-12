import { serve } from '@hono/node-server';
import PgBoss from 'pg-boss';
import { createDb, runMigrations } from '@pilot/db/client';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Orchestrator } from '@pilot/orchestrator';
import { MemoryService } from '@pilot/memory';
import { FounderIntelService } from '@pilot/founder-intel';
import { ConnectorRegistry, OAuthFlowManager } from '@pilot/connectors';
import { CofounderEngine } from '@pilot/cofounder-engine';
import { type PolicyConfig } from '@pilot/shared/schemas';
import { createLlmProvider, type LlmProvider } from '@pilot/shared/llm';
import { createTenantLlmResolver } from '@pilot/shared/llm/tenant-resolver';
import { createEmbeddingProvider } from '@pilot/shared/embeddings';
import { createLogger } from '@pilot/shared/logger';
import { TenantSecretStore } from '@pilot/db/tenant-secret-store';
import { HelmClient, HelmLlmProvider } from '@pilot/helm-client';
import type { RefreshNotifier } from '@pilot/connectors';
import { SubagentRegistry } from '@pilot/shared/subagents';
import { SkillRegistry } from '@pilot/shared/skills';
import { McpServerRegistry } from '@pilot/shared/mcp';
import { createGateway } from './index.js';
import { persistHelmReceipt } from './helm-receipts.js';
import { configureRateLimit } from './middleware/rate-limit.js';
import { EventBus } from './events/bus.js';
import { createEmailProvider } from './services/email-provider.js';
import { ManagedTelegramBotService } from './services/managed-telegram-bots.js';
import { initSentry, flushSentry } from '@pilot/shared/errors/sentry';

const log = createLogger('pilot');

const PLACEHOLDER_SECRET_VALUES = new Set([
  'change-me-in-production',
  'change-me-with-openssl-rand-hex-32',
  'dev-state-secret-change-me',
  'dev-encryption-key-change-me',
  'pilot-dev-ephemeral-key-change-me',
]);

function requireProductionSecret(name: string) {
  const value = process.env[name];
  if (!value || PLACEHOLDER_SECRET_VALUES.has(value) || value.startsWith('change-me')) {
    log.fatal({ name }, `${name} must be set to a non-placeholder production secret`);
    process.exit(1);
  }
}

async function main() {
  // Initialize Sentry first — captures errors even during startup
  await initSentry();

  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    log.fatal('DATABASE_URL is required');
    process.exit(1);
  }
  if (process.env['NODE_ENV'] === 'production') {
    requireProductionSecret('SESSION_SECRET');
    requireProductionSecret('ENCRYPTION_KEY');
    const evidenceSigningKey = process.env['EVIDENCE_SIGNING_KEY'];
    if (evidenceSigningKey && PLACEHOLDER_SECRET_VALUES.has(evidenceSigningKey)) {
      log.fatal('EVIDENCE_SIGNING_KEY must not be a placeholder in production');
      process.exit(1);
    }
    if (process.env['TELEGRAM_BOT_TOKEN']) {
      requireProductionSecret('TELEGRAM_WEBHOOK_SECRET');
    }
    if (!process.env['HELM_GOVERNANCE_URL']) {
      log.fatal('HELM_GOVERNANCE_URL is required in production');
      process.exit(1);
    }
    const directProviderKeys = [
      'OPENROUTER_API_KEY',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'VOYAGE_API_KEY',
    ].filter((key) => !!process.env[key]);
    if (directProviderKeys.length > 0) {
      log.fatal(
        { keys: directProviderKeys },
        'Direct provider keys must not be present in Pilot production env; keep them on the HELM sidecar',
      );
      process.exit(1);
    }
    const origins = process.env['ALLOWED_ORIGINS'];
    if (!origins || origins.split(',').some((origin) => origin.trim() === '*')) {
      log.fatal('ALLOWED_ORIGINS must be explicit in production');
      process.exit(1);
    }
  }

  // ─── Apply pending migrations (fail-fast) ───
  const runMigrationsEnv = (process.env['RUN_MIGRATIONS_ON_STARTUP'] ?? 'true').toLowerCase();
  if (runMigrationsEnv !== 'false') {
    try {
      const here = dirname(fileURLToPath(import.meta.url));
      const migrationsFolder = resolve(here, '../../../packages/db/migrations');
      await runMigrations(databaseUrl, migrationsFolder);
      log.info('Migrations applied');
    } catch (err) {
      log.fatal({ err }, 'Migration failed — refusing to start');
      process.exit(1);
    }
  }

  // ─── Initialize services ───
  const { db, close: dbClose } = createDb(databaseUrl);

  // ─── Redis (optional, for distributed rate limiting) ───
  let redis: { quit: () => Promise<unknown> } | null = null;
  const redisUrl = process.env['REDIS_URL'];
  if (redisUrl) {
    try {
      const ioredis = await import('ioredis');
      const RedisCtor =
        ioredis.Redis ?? (ioredis as unknown as { default: typeof ioredis.Redis }).default;
      redis = new RedisCtor(redisUrl, {
        maxRetriesPerRequest: 3,
        enableOfflineQueue: false,
      });
      log.info('Redis connected');
    } catch (err) {
      log.warn({ err }, 'Redis connection failed — falling back to in-memory rate limiter');
    }
  }
  configureRateLimit(redis as never);

  const defaultPolicy: PolicyConfig = {
    killSwitch: false,
    budget: {
      dailyTotalMax: Number(process.env['DAILY_BUDGET_MAX'] ?? '500'),
      perTaskMax: Number(process.env['PER_TASK_BUDGET_MAX'] ?? '100'),
      perOperatorMax: 200,
      emergencyKill: 1500,
      currency: 'EUR',
    },
    toolBlocklist: [],
    contentBans: [],
    connectorAllowlist: [],
    requireApprovalFor: [],
    failClosed: true,
  };

  const memory = new MemoryService(db);
  const connectors = new ConnectorRegistry(db);
  const oauth = new OAuthFlowManager(connectors, db);
  oauth.validateProviders(); // Fail-fast in prod if enabled connectors lack credentials

  // ─── HELM governance sidecar (optional but vision-critical) ───
  // When HELM_GOVERNANCE_URL is set, every LLM call is routed through the
  // HELM sidecar's Guardian pipeline. The orchestrator persists each receipt
  // to evidence_packs + task_runs for offline audit.
  let helmClient: HelmClient | undefined;
  const helmUrl = process.env['HELM_GOVERNANCE_URL'];
  if (helmUrl) {
    helmClient = new HelmClient({
      baseUrl: helmUrl,
      healthUrl: process.env['HELM_HEALTH_URL'],
      failClosed: process.env['HELM_FAIL_CLOSED'] !== '0',
      receiptPersistence: 'required_for_elevated',
      onReceipt: (receipt) => persistHelmReceipt(db, receipt),
    });
    log.info({ helmUrl }, 'HELM governance client configured');
  } else {
    log.warn(
      'HELM_GOVERNANCE_URL not set — LLM calls run without HELM Guardian. ' +
        'Production deployments MUST configure the sidecar.',
    );
  }

  // LLM provider (optional — gracefully degrades). When HELM is configured,
  // the provider is a HelmLlmProvider that routes every call through the
  // sidecar; otherwise falls back to direct OpenRouter/Anthropic/OpenAI.
  let llm: LlmProvider | undefined;
  let founderIntel: FounderIntelService | undefined;
  try {
    if (helmClient) {
      llm = new HelmLlmProvider({
        helm: helmClient,
        defaultPrincipal: 'workspace:pilot/operator:system',
        model: process.env['PILOT_LLM_MODEL'] ?? 'anthropic/claude-sonnet-4',
      });
      log.info('LLM provider: HELM-governed (proxied through sidecar)');
    } else {
      llm = createLlmProvider({
        openrouterApiKey: process.env['OPENROUTER_API_KEY'],
        anthropicApiKey: process.env['ANTHROPIC_API_KEY'],
        openaiApiKey: process.env['OPENAI_API_KEY'],
        ollamaBaseUrl: process.env['OLLAMA_BASE_URL'],
        ollamaModel: process.env['OLLAMA_MODEL'],
      });
      log.info('LLM provider: direct (no HELM)');
    }
    founderIntel = new FounderIntelService(db, llm);
    memory.setLlm(llm);
  } catch {
    log.warn('No LLM API key configured — agent loop + founder intake degraded');
  }

  // Embedding provider (optional — falls back to hash-based dev provider)
  const embeddings = createEmbeddingProvider({
    openaiApiKey: process.env['OPENAI_API_KEY'],
    voyageApiKey: process.env['VOYAGE_API_KEY'],
  });
  memory.setEmbeddings(embeddings);
  log.info({ model: embeddings.model }, 'Embedding provider configured');

  // ─── pg-boss background jobs ───
  const boss = new PgBoss(databaseUrl);
  await boss.start();
  log.info('pg-boss started');

  // ─── Per-tenant LLM resolver (Phase 2b) ───
  // Founders can store their own provider key via PUT /api/workspace/secrets.
  // When they have one the resolver returns a provider spending the founder's
  // credits; when they don't, it falls through to `llm` (the platform key).
  const tenantSecretStore = new TenantSecretStore(db);
  const llmResolver = createTenantLlmResolver({
    getSecret: (workspaceId, kind) => tenantSecretStore.get(workspaceId, kind as never),
    platformFallback: llm,
    model: process.env['PILOT_LLM_MODEL'] ?? 'anthropic/claude-sonnet-4',
    allowDirectTenantProviders: process.env['NODE_ENV'] !== 'production',
  });

  // Phase 12 — load governed subagent registry from packs/subagents/*.md.
  // Empty registry is fine; conductor tools just return a clear error.
  const subagentRegistry = SubagentRegistry.loadFromDisk();
  log.info({ count: subagentRegistry.size() }, 'Subagent registry loaded');

  // Gate 3 — load runtime skills from packs/skills + ~/.pilot/skills and
  // thread them into conductor/subagent execution. Missing registry would
  // make declared skills runtime-dead, so surface the count at boot.
  const skillRegistry = SkillRegistry.loadFromDisk();
  log.info(
    { count: skillRegistry.size(), skills: skillRegistry.list().map((skill) => skill.name) },
    'Skill registry loaded',
  );

  // Phase 14 (Track A) — load MCP server registry. Absent config file
  // → empty registry, subagents with `mcp_servers:` frontmatter boot
  // without upstream tools (silent-skip inside SubagentLoop).
  const mcpRegistry = McpServerRegistry.loadFromDisk();
  log.info(
    { count: mcpRegistry.listNames().length, servers: mcpRegistry.listNames() },
    'MCP server registry loaded',
  );

  // Phase 13 (Track B) — late-bound re-auth notifier. The Telegram bot is
  // initialized AFTER the Orchestrator, but the refresh worker registered
  // inside the Orchestrator needs a notifier now. Use an adapter that
  // delegates to whichever NotificationService is later assigned.
  let notificationsRef: import('@pilot/telegram-bot/notifications').NotificationService | null =
    null;
  const refreshNotifier: RefreshNotifier = {
    async reauthRequired(workspaceId, connectorName) {
      if (!notificationsRef) {
        log.warn(
          { workspaceId, connectorName },
          'Connector needs re-auth but Telegram bot is not configured',
        );
        return;
      }
      await notificationsRef.requestReauth(workspaceId, connectorName);
    },
  };

  const orchestrator = new Orchestrator({
    db,
    policy: defaultPolicy,
    llm,
    memory,
    boss,
    helmClient,
    llmResolver,
    subagentRegistry,
    skillRegistry,
    mcpRegistry,
    oauth,
    refreshNotifier,
  });
  const cofounderEngine = new CofounderEngine(db, llm);

  for (const connector of connectors.listConnectors()) {
    await connectors.ensureDbRecord(connector);
  }
  await cofounderEngine.seedRoles();

  // ─── Event bus (pg LISTEN/NOTIFY for real-time SSE) ───
  const eventBus = new EventBus(databaseUrl);
  try {
    await eventBus.start();
    log.info('Event bus connected (pg LISTEN/NOTIFY)');
  } catch (err) {
    log.warn({ err }, 'Event bus failed to start — SSE will fall back to polling');
  }

  // ─── Email provider (transactional emails: magic link, notifications) ───
  const emailProvider = createEmailProvider({
    provider: process.env['EMAIL_PROVIDER'] ?? 'noop',
    from: process.env['EMAIL_FROM'],
    resendApiKey: process.env['RESEND_API_KEY'],
    smtp: process.env['SMTP_HOST']
      ? {
          host: process.env['SMTP_HOST'],
          port: Number(process.env['SMTP_PORT'] ?? '587'),
          user: process.env['SMTP_USER'],
          pass: process.env['SMTP_PASS'],
          secure: process.env['SMTP_SECURE'] === 'true',
        }
      : undefined,
  });
  log.info({ emailProvider: emailProvider.kind }, 'Email provider configured');

  const botToken = process.env['TELEGRAM_BOT_TOKEN'];
  const managedTelegram = new ManagedTelegramBotService({
    db,
    helmClient,
    managerBotToken: botToken,
    managerBotUsername: process.env['TELEGRAM_MANAGER_BOT_USERNAME'],
    appUrl: process.env['APP_URL'],
    llm,
  });

  const app = createGateway({
    db,
    orchestrator,
    memory,
    founderIntel,
    connectors,
    oauth,
    cofounderEngine,
    eventBus,
    emailProvider,
    helmClient,
    managedTelegram,
  });

  // ─── Telegram bot (webhook mode) ───
  if (botToken) {
    const { webhookCallback } = await import('grammy');
    const { createBot } = await import('@pilot/telegram-bot');
    const { NotificationService } = await import('@pilot/telegram-bot/notifications');
    const bot = createBot(botToken, db, {
      founderIntel,
      runTask: (params) => orchestrator.runTask(params),
      runConduct: (params) => orchestrator.runConduct(params),
      createLaunchBotProvisioning: (params) => managedTelegram.createProvisioningRequest(params),
      claimLaunchBot: (params) => managedTelegram.claimManagedBot(params),
      resolveApproval: async ({ approvalId, workspaceId, status, resolvedBy }) => {
        const { approvals, tasks } = await import('@pilot/db/schema');
        const { and, eq } = await import('drizzle-orm');
        const [updated] = await db
          .update(approvals)
          .set({ status, resolvedBy, resolvedAt: new Date() })
          .where(and(eq(approvals.id, approvalId), eq(approvals.workspaceId, workspaceId)))
          .returning();
        if (!updated) throw new Error('Approval not found');
        if (status === 'approved' && updated.taskId) {
          const [task] = await db.select().from(tasks).where(eq(tasks.id, updated.taskId)).limit(1);
          await boss.send('task.resume', {
            taskId: updated.taskId,
            workspaceId: updated.workspaceId,
            operatorId: task?.operatorId ?? undefined,
            context: task?.description ?? `Resumed after approval of: ${updated.action}`,
          });
        }
        if (status === 'approved' && !updated.taskId) {
          await managedTelegram.sendApprovedMessage(updated.id);
        }
      },
    });
    await bot.init();
    managedTelegram.setManagerBotUsername(bot.botInfo.username);

    // Wire approval push notifications via Telegram
    const notifications = new NotificationService(bot, db);
    notificationsRef = notifications;
    orchestrator.agentLoop.setApprovalNotifier((workspaceId, approvalId, action, reason) =>
      notifications.requestApproval(workspaceId, approvalId, action, reason),
    );
    managedTelegram.setApprovalNotifier((workspaceId, approvalId, action, reason) =>
      notifications.requestApproval(workspaceId, approvalId, action, reason),
    );
    managedTelegram.setSupportNotifier((workspaceId, _messageId, managedBotUsername) =>
      notifications.notifyWorkspace(
        workspaceId,
        `*Telegram support message received*\n\n@${managedBotUsername} captured a new support message. Open Launch to review and reply.`,
      ),
    );
    log.info('Approval + re-auth notifications enabled via Telegram');

    const handleUpdate = webhookCallback(bot, 'std/http');
    const webhookSecret = process.env['TELEGRAM_WEBHOOK_SECRET'];

    app.post('/api/telegram/webhook', async (c) => {
      // Validate webhook secret if configured
      if (webhookSecret) {
        const header = c.req.header('X-Telegram-Bot-Api-Secret-Token');
        if (header !== webhookSecret) {
          return c.json({ error: 'Forbidden' }, 403);
        }
      }
      const response = await handleUpdate(c.req.raw);
      return new Response(response.body, response);
    });

    log.info('Telegram bot embedded (webhook mode)');
  }

  // ─── Start server ───
  const port = Number(process.env['PORT'] ?? '3100');
  const server = serve({ fetch: app.fetch, port }, (info) => {
    log.info({ port: info.port }, 'Pilot running');
  });

  // ─── Graceful shutdown ───
  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutting down...');
    server.close();
    await boss.stop({ graceful: true });
    await eventBus.stop().catch(() => {});
    if (redis) {
      try {
        await redis.quit();
      } catch {
        /* ignore */
      }
    }
    await flushSentry();
    await dbClose();
    log.info('Shutdown complete');
    process.exit(0);
  };

  const hardTimeout = () => setTimeout(() => process.exit(1), 8000).unref();

  process.on('SIGTERM', () => {
    hardTimeout();
    shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    hardTimeout();
    shutdown('SIGINT');
  });
}

main().catch((err) => {
  log.fatal({ err }, 'Failed to start Pilot');
  process.exit(1);
});
