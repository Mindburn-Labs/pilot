import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PolicyReloader, type PolicySnapshot } from '../policy-reload.js';

// Build a minimal Db mock that the PolicyReloader uses for its dynamic import
// of pages table + drizzle-orm operators.
function createMockDb(rows: Array<{ content: string | null; compiledTruth: string | null }>) {
  const mockLimit = vi.fn().mockResolvedValue(rows);
  const mockWhere = vi.fn().mockReturnValue({ limit: mockLimit });
  const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
  const mockSelect = vi.fn().mockReturnValue({ from: mockFrom });

  return { select: mockSelect } as any;
}

describe('PolicyReloader', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('constructs with no initial snapshot', () => {
    const db = createMockDb([]);
    const reloader = new PolicyReloader(db, 'ws-test');
    expect(reloader.get()).toBeNull();
  });

  it('constructs with initial snapshot', () => {
    const db = createMockDb([]);
    const initial: PolicySnapshot = {
      workflow: {
        name: 'test-agent',
        version: '1.0.0',
        orchestrator: {
          max_concurrent: 10,
          max_turns: 1,
          poll_interval_ms: 30_000,
          stall_timeout_ms: 300_000,
          retry: { max_attempts: 3, initial_delay_ms: 10_000, backoff_multiplier: 2, max_delay_ms: 300_000 },
        },
        workspace: { root: '.' },
        active_states: ['pending', 'in_progress'],
        terminal_states: ['completed', 'failed', 'cancelled'],
      },
      promptBody: 'You are a helpful agent.',
      contentHash: 'sha256:abc123',
      loadedAt: new Date(),
    };
    const reloader = new PolicyReloader(db, 'ws-test', 30_000, initial);
    expect(reloader.get()).toBe(initial);
    expect(reloader.get()?.workflow.name).toBe('test-agent');
  });

  it('start and stop are idempotent', () => {
    const db = createMockDb([]);
    const reloader = new PolicyReloader(db, 'ws-test', 60_000);

    // Multiple starts should not throw
    reloader.start();
    reloader.start();

    // Multiple stops should not throw
    reloader.stop();
    reloader.stop();

    expect(reloader.get()).toBeNull();
  });

  it('stop clears the timer', () => {
    const clearSpy = vi.spyOn(global, 'clearInterval');
    const db = createMockDb([]);
    const reloader = new PolicyReloader(db, 'ws-test', 60_000);
    reloader.start();
    reloader.stop();
    expect(clearSpy).toHaveBeenCalled();
  });
});
