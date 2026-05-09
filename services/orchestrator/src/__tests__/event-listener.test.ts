import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AmbientEventListener,
  DEFAULT_EVENT_CONFIG,
  type AmbientEvent,
  type EventListenerConfig,
} from '../event-listener.js';

describe('AmbientEventListener', () => {
  let listener: AmbientEventListener;
  const config: EventListenerConfig = {
    maxEventsPerMinute: 5,
    pgChannels: [],         // no PG for unit tests
    enableWebhooks: true,
  };

  beforeEach(() => {
    listener = new AmbientEventListener(config);
  });

  afterEach(async () => {
    await listener.stop();
  });

  function makeEvent(overrides?: Partial<AmbientEvent>): AmbientEvent {
    return {
      type: 'task_created',
      source: 'test',
      workspaceId: 'ws-1',
      payload: {},
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  it('dispatches to registered handler', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    listener.on('task_created', handler);

    const event = makeEvent();
    const result = await listener.processEvent(event);

    expect(result).toBe(true);
    expect(handler).toHaveBeenCalledWith(event);
  });

  it('dispatches to wildcard handler', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    listener.on('*', handler);

    await listener.processEvent(makeEvent({ type: 'any_type' }));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('dispatches to both specific and wildcard handlers', async () => {
    const specific = vi.fn().mockResolvedValue(undefined);
    const wildcard = vi.fn().mockResolvedValue(undefined);
    listener.on('task_created', specific);
    listener.on('*', wildcard);

    await listener.processEvent(makeEvent());
    expect(specific).toHaveBeenCalledTimes(1);
    expect(wildcard).toHaveBeenCalledTimes(1);
  });

  it('rate-limits by workspace', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    listener.on('*', handler);

    // config.maxEventsPerMinute = 5, so 5 should succeed
    for (let i = 0; i < 5; i++) {
      const result = await listener.processEvent(makeEvent());
      expect(result).toBe(true);
    }

    // 6th should be rate-limited
    const result = await listener.processEvent(makeEvent());
    expect(result).toBe(false);
    expect(handler).toHaveBeenCalledTimes(5); // not 6
  });

  it('rate limits are per-workspace', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    listener.on('*', handler);

    // Fill ws-1's bucket
    for (let i = 0; i < 5; i++) {
      await listener.processEvent(makeEvent({ workspaceId: 'ws-1' }));
    }

    // ws-2 should still work
    const result = await listener.processEvent(makeEvent({ workspaceId: 'ws-2' }));
    expect(result).toBe(true);
    expect(handler).toHaveBeenCalledTimes(6);
  });

  it('handler errors do not crash processing', async () => {
    const badHandler = vi.fn().mockRejectedValue(new Error('boom'));
    const goodHandler = vi.fn().mockResolvedValue(undefined);
    listener.on('task_created', badHandler);
    listener.on('task_created', goodHandler);

    const result = await listener.processEvent(makeEvent());
    expect(result).toBe(true);
    expect(badHandler).toHaveBeenCalledTimes(1);
    expect(goodHandler).toHaveBeenCalledTimes(1);
  });

  describe('webhook handler', () => {
    it('returns 400 for missing fields', async () => {
      const webhookHandler = listener.createWebhookHandler();
      const res = { status: vi.fn().mockReturnValue({ json: vi.fn() }) };
      await webhookHandler({ body: {} }, res as any);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 202 for valid events', async () => {
      const jsonFn = vi.fn();
      const webhookHandler = listener.createWebhookHandler();
      const res = { status: vi.fn().mockReturnValue({ json: jsonFn }) };
      await webhookHandler(
        {
          body: {
            type: 'test_event',
            workspaceId: 'ws-1',
            payload: {},
          },
        },
        res as any,
      );
      expect(res.status).toHaveBeenCalledWith(202);
      expect(jsonFn).toHaveBeenCalledWith(
        expect.objectContaining({ accepted: true }),
      );
    });

    it('returns 404 when webhooks disabled', async () => {
      const noWebhookListener = new AmbientEventListener({
        ...config,
        enableWebhooks: false,
      });
      const webhookHandler = noWebhookListener.createWebhookHandler();
      const jsonFn = vi.fn();
      const res = { status: vi.fn().mockReturnValue({ json: jsonFn }) };
      await webhookHandler({ body: {} }, res as any);
      expect(res.status).toHaveBeenCalledWith(404);
      await noWebhookListener.stop();
    });
  });

  it('DEFAULT_EVENT_CONFIG has reasonable defaults', () => {
    expect(DEFAULT_EVENT_CONFIG.maxEventsPerMinute).toBe(60);
    expect(DEFAULT_EVENT_CONFIG.pgChannels.length).toBeGreaterThan(0);
    expect(DEFAULT_EVENT_CONFIG.enableWebhooks).toBe(true);
  });
});
