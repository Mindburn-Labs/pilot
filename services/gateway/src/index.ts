import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serveStatic } from '@hono/node-server/serve-static';
import { sql } from 'drizzle-orm';
import { type Db } from '@pilot/db/client';
import { type Orchestrator } from '@pilot/orchestrator';
import { type MemoryService } from '@pilot/memory';
import { type FounderIntelService } from '@pilot/founder-intel';
import { createLogger } from '@pilot/shared/logger';
import { secureHeaders } from 'hono/secure-headers';
import { requireAuth } from './middleware/auth.js';
import { rateLimit } from './middleware/rate-limit.js';
import { ROUTE_CLASSES, rateLimitPg } from './middleware/rate-limit-pg.js';
import { auditMiddleware } from './middleware/audit.js';
import { metricsMiddleware, metricsEndpoint } from './middleware/metrics.js';
import { requestId } from './middleware/request-id.js';
import { bodyLimit } from './middleware/body-limit.js';
import { captureException } from '@pilot/shared/errors/sentry';
import { authenticatedAuthRoutes, authRoutes } from './routes/auth.js';
import { founderRoutes } from './routes/founder.js';
import { opportunityRoutes } from './routes/opportunity.js';
import { taskRoutes } from './routes/task.js';
import { operatorRoutes } from './routes/operator.js';
import { knowledgeRoutes } from './routes/knowledge.js';
import { ycRoutes } from './routes/yc.js';
import { productRoutes } from './routes/product.js';
import { launchRoutes } from './routes/launch.js';
import { eventRoutes } from './routes/events.js';
import { workspaceRoutes } from './routes/workspace.js';
import { applicationRoutes } from './routes/application.js';
import { auditRoutes } from './routes/audit.js';
import { connectorRoutes } from './routes/connector.js';
import { statusRoutes } from './routes/status.js';
import { userRoutes } from './routes/users.js';
import { governanceRoutes } from './routes/governance.js';
import { complianceRoutes } from './routes/compliance.js';
import { capabilityRoutes } from './routes/capabilities.js';
import { a2aRoutes } from './routes/a2a.js';
import { decideRoutes } from './routes/decide.js';
import { secretsRoutes } from './routes/secrets.js';
import { adminRoutes } from './routes/admin.js';
import { conductRoutes } from './routes/conduct.js';
import { browserSessionRoutes } from './routes/browser-session.js';
import { commandCenterRoutes } from './routes/command-center.js';
import { evalRoutes } from './routes/evals.js';
import { startupLifecycleRoutes } from './routes/startup-lifecycle.js';
import { managedTelegramWebhookRoutes } from './routes/telegram-managed.js';
import { type ConnectorRegistry, type OAuthFlowManager } from '@pilot/connectors';
import { type CofounderEngine } from '@pilot/cofounder-engine';
import { type HelmClient } from '@pilot/helm-client';
import { type EventBus } from './events/bus.js';
import { type EmailProvider } from './services/email-provider.js';
import { type ManagedTelegramBotService } from './services/managed-telegram-bots.js';
import type { ExecutePilotEvalInput, RecordPilotEvalRunInput } from '@pilot/shared/eval';

const log = createLogger('gateway');

export interface GatewayDeps {
  db: Db;
  orchestrator: Orchestrator;
  memory: MemoryService;
  founderIntel?: FounderIntelService;
  connectors?: ConnectorRegistry;
  oauth?: OAuthFlowManager;
  cofounderEngine?: CofounderEngine;
  eventBus?: EventBus;
  emailProvider?: EmailProvider;
  managedTelegram?: ManagedTelegramBotService;
  /**
   * Trusted internal runner for real external production evals. Route callers
   * can request real_external_eval, but only this server-owned runner can
   * attach trusted real-eval execution metadata for promotion eligibility.
   */
  productionEvalRunner?: {
    execute: (
      input: ExecutePilotEvalInput & {
        workspaceId: string;
        executionMode: 'real_external_eval';
      },
    ) => Promise<{
      run: RecordPilotEvalRunInput;
      blockers?: string[];
    }>;
  };
  /**
   * HELM governance client. When present the orchestrator routes LLM calls
   * through HELM's /v1/chat/completions and persists receipts to
   * `evidence_packs`. When absent the gateway falls back to local-only policy
   * enforcement.
   */
  helmClient?: HelmClient;
}

export function createGateway(deps: GatewayDeps) {
  const app = new Hono();

  // ─── Global error handler ───
  app.onError((err, c) => {
    const requestId = c.res.headers.get('X-Request-Id') ?? undefined;
    log.error({ err, path: c.req.path, method: c.req.method, requestId }, 'Unhandled error');
    if (err instanceof SyntaxError && err.message.includes('JSON')) {
      return c.json({ error: 'Invalid JSON in request body' }, 400);
    }
    captureException(err, {
      tags: { path: c.req.path, method: c.req.method, requestId },
    });
    return c.json({ error: 'Internal server error' }, 500);
  });

  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  // ─── Request ID (generate or propagate) ───
  app.use('*', requestId());

  // ─── Prometheus metrics collection ───
  app.use('*', metricsMiddleware());

  // ─── Body size limits (defense-in-depth) ───
  app.use('*', bodyLimit(1_000_000)); // 1MB global default
  app.use('/api/auth/*', bodyLimit(100_000)); // 100KB on auth endpoints

  // ─── Security headers ───
  app.use('*', secureHeaders());

  // ─── CORS ───
  const origins = process.env['ALLOWED_ORIGINS']?.split(',').filter(Boolean) ?? [];
  app.use(
    '/api/*',
    cors({
      origin: origins.length > 0 ? origins : (origin) => origin || '*',
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: [
        'Content-Type',
        'Authorization',
        'X-API-Key',
        'X-Workspace-Id',
        'X-CSRF-Token',
      ],
      credentials: true,
    }),
  );

  // ─── Structured request logging (with correlation ID) ───
  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const requestId = c.res.headers.get('X-Request-Id') ?? undefined;
    log.info(
      {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Date.now() - start,
      },
      'request',
    );
  });

  // ─── Rate limiting ─────────────────────────────────────────────────
  // Phase 2c: per-(workspace, route-class) Postgres token buckets so a
  // single noisy workspace can't starve the platform. Falls back to the
  // in-memory limiter when the DB is unreachable (fail-open). Route
  // classes have distinct ceilings — auth is strictest, default is most
  // permissive. Anonymous callers are keyed by forwarded IP so pre-auth
  // brute-force remains capped.
  app.use('/api/auth/*', rateLimitPg(deps.db, ROUTE_CLASSES.AUTH));
  app.use('/api/connectors/*/grant', rateLimitPg(deps.db, ROUTE_CLASSES.CONNECTOR_OAUTH));
  app.use('/api/connectors/*/token', rateLimitPg(deps.db, ROUTE_CLASSES.CONNECTOR_OAUTH));
  app.use('/api/tasks', rateLimitPg(deps.db, ROUTE_CLASSES.TASK));
  app.use('/api/*', rateLimitPg(deps.db, ROUTE_CLASSES.DEFAULT));
  // Legacy in-memory limiter retained for tests that mount routes without a
  // real DB. New production paths use rateLimitPg above.
  void rateLimit;

  // ─── Health (public, enriched) ───
  app.get('/health', async (c) => {
    let dbOk = false;
    try {
      await deps.db.execute(sql`SELECT 1`);
      dbOk = true;
    } catch {
      // DB unreachable
    }
    const bossOk = !!deps.orchestrator.boss;
    const eventBusOk = deps.eventBus ? deps.eventBus.isConnected() : false;

    // HELM sub-check — probes the sidecar when configured. A "not_configured"
    // state is distinct from "unreachable" so operators can tell whether HELM
    // is down versus just disabled in dev. When HELM_FAIL_CLOSED=1 and HELM is
    // unreachable, the gateway reports degraded (503) — matching the
    // orchestrator's fail-closed behaviour.
    let helmState: 'ok' | 'unreachable' | 'not_configured' = 'not_configured';
    let helmLatencyMs: number | undefined;
    let helmVersion: string | undefined;
    if (deps.helmClient) {
      const snap = await deps.helmClient.health();
      helmState = snap.gatewayOk ? 'ok' : 'unreachable';
      helmLatencyMs = snap.latencyMs;
      helmVersion = snap.version;
    }

    const failClosed = process.env['HELM_FAIL_CLOSED'] !== '0';
    const helmBlockHealth = failClosed && helmState === 'unreachable';
    const healthy = dbOk && !helmBlockHealth;

    return c.json(
      {
        status: healthy ? 'ok' : 'degraded',
        service: 'pilot',
        version: '0.1.0',
        uptime: Math.floor(process.uptime()),
        checks: {
          db: dbOk,
          pgboss: bossOk,
          eventBus: eventBusOk,
          helm: helmState,
          helmLatencyMs,
          helmVersion,
        },
      },
      healthy ? 200 : 503,
    );
  });

  // ─── Prometheus metrics endpoint (token-gated in production) ───
  app.get('/metrics', metricsEndpoint());

  // ─── Auth routes (public) ───
  app.route('/api/auth', authRoutes(deps));

  // ─── Protected API routes (telegram webhook uses its own secret-token auth) ───
  const auth = requireAuth(deps.db);
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/telegram/webhook') return next();
    if (c.req.path.startsWith('/api/telegram/managed/')) return next();
    return auth(c, next);
  });

  // ─── Audit logging (after auth, logs mutating requests) ───
  app.use('/api/*', auditMiddleware(deps.db));

  app.route('/api/auth', authenticatedAuthRoutes(deps));
  app.route('/api/founder', founderRoutes(deps));
  app.route('/api/opportunities', opportunityRoutes(deps));
  app.route('/api/tasks', taskRoutes(deps));
  app.route('/api/operators', operatorRoutes(deps));
  app.route('/api/knowledge', knowledgeRoutes(deps));
  app.route('/api/yc', ycRoutes(deps));
  app.route('/api/product', productRoutes(deps));
  app.route('/api/launch', launchRoutes(deps));
  app.route('/api/events', eventRoutes(deps));
  app.route('/api/workspace', workspaceRoutes(deps));
  app.route('/api/applications', applicationRoutes(deps));
  app.route('/api/audit', auditRoutes(deps));
  app.route('/api/connectors', connectorRoutes(deps));
  app.route('/api/status', statusRoutes(deps));
  app.route('/api/users', userRoutes(deps));
  app.route('/api/governance', governanceRoutes(deps));
  app.route('/api/compliance', complianceRoutes(deps));
  app.route('/api/capabilities', capabilityRoutes());
  // A2A protocol — root-mounted so /.well-known/agent-card.json resolves.
  app.route('/', a2aRoutes(deps));
  app.route('/api/decide', decideRoutes(deps));
  app.route('/api/orchestrator', conductRoutes(deps));
  app.route('/api/browser-sessions', browserSessionRoutes(deps));
  app.route('/api/command-center', commandCenterRoutes(deps));
  app.route('/api/evals', evalRoutes(deps));
  app.route('/api/startup-lifecycle', startupLifecycleRoutes(deps));
  app.route('/api/workspace/secrets', secretsRoutes(deps));
  app.route('/api/telegram/managed', managedTelegramWebhookRoutes(deps));
  // Admin surface — platform-wide, gated by PILOT_ADMIN_API_KEY. Mounted
  // BEFORE the requireAuth workspace gate could hijack its subtree, and the
  // route file guards itself with a Bearer-token middleware.
  app.route('/api/admin', adminRoutes(deps));

  // ─── Telegram Mini App (static files) ───
  app.get(
    '/app/*',
    serveStatic({
      root: './apps/telegram-miniapp/dist',
      rewriteRequestPath: (path) => path.replace(/^\/app/, ''),
    }),
  );
  // SPA fallback: serve index.html for any /app route that doesn't match a file
  app.get('/app/*', serveStatic({ root: './apps/telegram-miniapp/dist', path: 'index.html' }));

  // ─── Root (public) ───
  app.get('/', (c) =>
    c.json({
      name: 'pilot',
      version: '0.1.0',
      description: 'Open-source autonomous founder operating system',
    }),
  );

  return app;
}
