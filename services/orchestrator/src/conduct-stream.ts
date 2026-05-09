import { EventEmitter } from 'node:events';

// ─── Conduct event stream (Phase 14 Track L) ───
//
// In-memory pub/sub for live conductor iterations. The agent loop
// publishes every step; the gateway SSE endpoint subscribes per taskId
// and pipes to clients. No DB — these events are ephemeral, replayable
// from the proof graph after the fact.
//
// Each hub is keyed by taskId; inactive hubs self-evict after 5 minutes
// so long-running servers don't leak memory on stale task ids.

export type ConductEventType =
  | 'iteration.started'
  | 'action.selected'
  | 'action.completed'
  | 'action.denied'
  | 'action.approval_required'
  | 'subagent.spawned'
  | 'subagent.completed'
  | 'task.verdict'
  | 'ambient.event';

export interface ConductEvent {
  type: ConductEventType;
  taskId: string;
  iteration?: number;
  tool?: string;
  verdict?: 'allow' | 'deny' | 'require_approval';
  payload?: unknown;
  timestamp: string;
}

const INACTIVITY_TTL_MS = 5 * 60_000;

/**
 * Singleton-by-convention. Services that want to emit conduct events
 * pull from `conductStream` so all publishers share the same hub.
 */
export class ConductEventStream {
  private readonly emitters = new Map<string, EventEmitter>();
  private readonly lastActivity = new Map<string, number>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor() {
    // Periodic cleanup of inactive emitters. unref() so it doesn't
    // hold the event loop open during graceful shutdown.
    this.cleanupTimer = setInterval(() => this.gc(), 60_000);
    if (typeof this.cleanupTimer.unref === 'function') {
      this.cleanupTimer.unref();
    }
  }

  /** Publish an event to every subscriber of `taskId`. Silent no-op if none. */
  publish(event: ConductEvent): void {
    const e = this.emitters.get(event.taskId);
    this.lastActivity.set(event.taskId, Date.now());
    if (e) e.emit('event', event);
  }

  /**
   * Subscribe to events for one task. Returns an unsubscribe function.
   * Creates the hub on first subscriber so publishers don't need to know
   * whether anyone is listening.
   */
  subscribe(taskId: string, handler: (event: ConductEvent) => void): () => void {
    let e = this.emitters.get(taskId);
    if (!e) {
      e = new EventEmitter();
      e.setMaxListeners(0); // multiple SSE clients permitted
      this.emitters.set(taskId, e);
    }
    e.on('event', handler);
    this.lastActivity.set(taskId, Date.now());
    return () => {
      e?.off('event', handler);
      if (e && e.listenerCount('event') === 0) {
        this.emitters.delete(taskId);
        this.lastActivity.delete(taskId);
      }
    };
  }

  /** Count active hubs — useful for health metrics + tests. */
  activeTaskCount(): number {
    return this.emitters.size;
  }

  /** Test hook — drop all hubs. */
  reset(): void {
    this.emitters.clear();
    this.lastActivity.clear();
  }

  /** Stop the background cleanup timer. Tests should call this. */
  close(): void {
    clearInterval(this.cleanupTimer);
  }

  private gc(): void {
    const cutoff = Date.now() - INACTIVITY_TTL_MS;
    for (const [taskId, ts] of this.lastActivity) {
      if (ts < cutoff) {
        this.emitters.get(taskId)?.removeAllListeners();
        this.emitters.delete(taskId);
        this.lastActivity.delete(taskId);
      }
    }
  }
}

/** Default shared instance — importers use this unless they're testing. */
export const conductStream = new ConductEventStream();

/**
 * Helper emitting the canonical event shape with timestamp already filled.
 * Publishers should call this rather than building the payload by hand.
 */
export function emitConductEvent(
  partial: Omit<ConductEvent, 'timestamp'>,
  stream: ConductEventStream = conductStream,
): void {
  stream.publish({ ...partial, timestamp: new Date().toISOString() });
}
