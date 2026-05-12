import { createLogger } from '@pilot/shared/logger';
import { emitConductEvent } from './conduct-stream.js';

// ─── Ambient Event Listener (Symphony-adopted) ───
//
// Extends Pilot's background processing with event-stream listeners
// that can trigger orchestrator runs. Supports:
//   - PostgreSQL LISTEN/NOTIFY for internal events
//   - Webhook receiver for external system events
//
// Rate-limited per workspace to prevent event storms.

const logger = createLogger('event-listener');

export interface EventListenerConfig {
  /** Maximum events processed per minute per workspace. Default: 60. */
  maxEventsPerMinute: number;
  /** PostgreSQL channels to listen on. Must match ^[a-z_]+$ */
  pgChannels: string[];
  /** Whether to enable the webhook receiver. */
  enableWebhooks: boolean;
}

export const DEFAULT_EVENT_CONFIG: EventListenerConfig = {
  maxEventsPerMinute: 60,
  pgChannels: ['task_created', 'approval_resolved', 'evidence_pack_created'],
  enableWebhooks: true,
};

export interface AmbientEvent {
  type: string;
  source: string;
  workspaceId: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export type EventHandler = (event: AmbientEvent) => Promise<void>;

const VALID_CHANNEL_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * AmbientEventListener manages event-driven agent activation.
 * Converts external events into ConductEvents and optionally triggers runs.
 */
export class AmbientEventListener {
  private handlers = new Map<string, EventHandler[]>();
  private rateLimiter = new Map<string, { count: number; resetAt: number }>();
  private pgCleanup: (() => void) | null = null;

  constructor(private readonly config: EventListenerConfig = DEFAULT_EVENT_CONFIG) {}

  /** Register a handler for a specific event type. */
  on(eventType: string, handler: EventHandler): void {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  /** Start listening for events. */
  async start(): Promise<void> {
    logger.info(
      {
        channels: this.config.pgChannels,
        webhooks: this.config.enableWebhooks,
      },
      'Starting ambient event listener',
    );

    // PostgreSQL LISTEN/NOTIFY
    if (this.config.pgChannels.length > 0) {
      await this.startPgListener();
    }
  }

  /** Stop listening. */
  async stop(): Promise<void> {
    if (this.pgCleanup) {
      this.pgCleanup();
      this.pgCleanup = null;
    }
    logger.info('Ambient event listener stopped');
  }

  /** Process an incoming event (from PG or webhook). */
  async processEvent(event: AmbientEvent): Promise<boolean> {
    // Rate limiting
    if (!this.checkRateLimit(event.workspaceId)) {
      logger.warn(
        {
          workspaceId: event.workspaceId,
          eventType: event.type,
        },
        'Event rate limit exceeded',
      );
      return false;
    }

    // Emit as ConductEvent for observability
    emitConductEvent({
      type: 'ambient.event',
      taskId: `ambient:${event.type}:${Date.now()}`,
      iteration: 0,
      payload: {
        eventType: event.type,
        source: event.source,
        workspaceId: event.workspaceId,
      },
    });

    // Dispatch to registered handlers
    const handlers = this.handlers.get(event.type) ?? [];
    const wildcardHandlers = this.handlers.get('*') ?? [];
    const allHandlers = [...handlers, ...wildcardHandlers];

    for (const handler of allHandlers) {
      try {
        await handler(event);
      } catch (err) {
        logger.error(
          {
            eventType: event.type,
            error: err instanceof Error ? err.message : String(err),
          },
          'Event handler failed',
        );
      }
    }

    return true;
  }

  /** Handle incoming webhook. Returns the handler for Express/Fastify. */
  createWebhookHandler() {
    return async (
      req: { body: unknown },
      res: { status: (code: number) => { json: (body: unknown) => void } },
    ) => {
      if (!this.config.enableWebhooks) {
        res.status(404).json({ error: 'Webhooks disabled' });
        return;
      }

      const event = req.body as AmbientEvent;
      if (!event.type || !event.workspaceId) {
        res.status(400).json({ error: 'Missing type or workspaceId' });
        return;
      }

      event.timestamp = event.timestamp || new Date().toISOString();
      event.source = event.source || 'webhook';

      const processed = await this.processEvent(event);
      res.status(processed ? 202 : 429).json({
        accepted: processed,
        eventType: event.type,
      });
    };
  }

  private async startPgListener(): Promise<void> {
    // Use the raw pg client for LISTEN/NOTIFY (drizzle doesn't expose this)
    try {
      const { Pool } = await import('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      const client = await pool.connect();

      for (const channel of this.config.pgChannels) {
        if (!VALID_CHANNEL_RE.test(channel)) {
          logger.error({ channel }, 'Invalid PG channel name, skipping');
          continue;
        }
        await client.query(`LISTEN "${channel}"`);
      }

      client.on('notification', (msg) => {
        try {
          const payload = msg.payload ? JSON.parse(msg.payload) : {};
          const event: AmbientEvent = {
            type: msg.channel ?? 'unknown',
            source: 'postgresql',
            workspaceId: payload.workspace_id ?? payload.workspaceId ?? 'unknown',
            payload,
            timestamp: new Date().toISOString(),
          };
          void this.processEvent(event);
        } catch (err) {
          logger.error(
            {
              channel: msg.channel,
              error: err instanceof Error ? err.message : String(err),
            },
            'PG notification parse error',
          );
        }
      });

      this.pgCleanup = () => {
        client.release();
        void pool.end();
      };

      logger.info({ channels: this.config.pgChannels }, 'PG LISTEN started');
    } catch (err) {
      logger.error(
        {
          error: err instanceof Error ? err.message : String(err),
        },
        'Failed to start PG listener',
      );
    }
  }

  private checkRateLimit(workspaceId: string): boolean {
    const now = Date.now();
    let bucket = this.rateLimiter.get(workspaceId);

    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + 60_000 };
      this.rateLimiter.set(workspaceId, bucket);
    }

    if (bucket.count >= this.config.maxEventsPerMinute) {
      return false;
    }

    bucket.count++;
    return true;
  }
}
