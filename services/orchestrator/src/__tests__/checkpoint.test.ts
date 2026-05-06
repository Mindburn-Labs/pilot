import { describe, expect, it, vi } from 'vitest';
import {
  CHECKPOINT_EVERY_N_ITERATIONS,
  findStalledRuns,
  loadCheckpoint,
  markWatchdogAlerted,
  writeCheckpoint,
  type CheckpointState,
} from '../checkpoint.js';

describe('checkpoint helpers', () => {
  it('writes a bounded checkpoint and updates last activity time', async () => {
    const where = vi.fn();
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const db = { update } as any;

    await writeCheckpoint(db, 'run-1', {
      iteration: 125,
      actions: Array.from({ length: 125 }, (_, i) => ({
        tool: 'search',
        input: { i },
        output: { ok: true },
        verdict: 'allow' as const,
        iteration: i + 1,
      })),
      runUsage: { tokensIn: 10, tokensOut: 5, model: 'test-model' },
      runCost: 0.1234,
    });

    expect(update).toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointState: expect.objectContaining({
          iteration: 125,
          runCost: 0.1234,
          actions: expect.any(Array),
        }),
        lastCheckpointAt: expect.any(Date),
      }),
    );
    const checkpoint = set.mock.calls[0]?.[0].checkpointState;
    expect(checkpoint.actions).toHaveLength(100);
    expect(checkpoint.actions[0].iteration).toBe(26);
    expect(where).toHaveBeenCalled();
  });

  it('marks stalled runs as alerted without throwing', async () => {
    const where = vi.fn();
    const set = vi.fn(() => ({ where }));
    const update = vi.fn(() => ({ set }));
    const db = { update } as any;

    await markWatchdogAlerted(db, 'run-1');

    expect(update).toHaveBeenCalled();
    expect(set).toHaveBeenCalledWith({ watchdogAlertedAt: expect.any(Date) });
    expect(where).toHaveBeenCalled();
  });

  it('writeCheckpoint is a no-op for empty taskRunId', async () => {
    const update = vi.fn();
    const db = { update } as any;
    await writeCheckpoint(db, '', {
      iteration: 1,
      actions: [],
      runUsage: { tokensIn: 0, tokensOut: 0 },
      runCost: 0,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('writeCheckpoint swallows DB errors (fail-soft)', async () => {
    const db = {
      update: () => {
        throw new Error('connection refused');
      },
    } as any;
    await expect(
      writeCheckpoint(db, 'run-x', {
        iteration: 1,
        actions: [],
        runUsage: { tokensIn: 0, tokensOut: 0 },
        runCost: 0,
      }),
    ).resolves.toBeUndefined();
  });

  it('writeCheckpoint throws when durable checkpoint persistence is required', async () => {
    const db = {
      update: () => {
        throw new Error('connection refused');
      },
    } as any;
    await expect(
      writeCheckpoint(
        db,
        'run-x',
        {
          iteration: 1,
          actions: [],
          runUsage: { tokensIn: 0, tokensOut: 0 },
          runCost: 0,
        },
        { required: true },
      ),
    ).rejects.toThrow('Checkpoint persistence failed for task run run-x: connection refused');
  });

  it('CHECKPOINT_EVERY_N_ITERATIONS is exported as a positive integer', () => {
    expect(CHECKPOINT_EVERY_N_ITERATIONS).toBeGreaterThan(0);
    expect(Number.isInteger(CHECKPOINT_EVERY_N_ITERATIONS)).toBe(true);
  });

  it('loadCheckpoint returns null for empty taskRunId', async () => {
    const db = {
      select: () => {
        throw new Error('should not be called');
      },
    } as any;
    expect(await loadCheckpoint(db, '')).toBeNull();
  });

  it('loadCheckpoint returns the persisted CheckpointState when present', async () => {
    const fakeState: CheckpointState = {
      iteration: 30,
      actions: [],
      runUsage: { tokensIn: 100, tokensOut: 50, model: 'test-model' },
      runCost: 0.0123,
      takenAt: '2026-04-25T10:00:00.000Z',
    };
    const limit = vi.fn().mockResolvedValue([{ state: fakeState }]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const db = { select } as any;
    expect(await loadCheckpoint(db, 'run-y')).toEqual(fakeState);
  });

  it('loadCheckpoint returns null when no row exists', async () => {
    const limit = vi.fn().mockResolvedValue([]);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const db = { select } as any;
    expect(await loadCheckpoint(db, 'ghost')).toBeNull();
  });

  it('loadCheckpoint returns null when DB throws (fail-soft)', async () => {
    const db = {
      select: () => {
        throw new Error('boom');
      },
    } as any;
    expect(await loadCheckpoint(db, 'run-z')).toBeNull();
  });

  it('findStalledRuns returns rows from the query result', async () => {
    const stalledRows = [
      { id: 'run-a', taskId: 'task-a', lastActivityAt: new Date('2026-04-25T09:00:00Z') },
    ];
    const limit = vi.fn().mockResolvedValue(stalledRows);
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const db = { select } as any;
    const out = await findStalledRuns(db, 30);
    expect(out).toEqual(stalledRows);
    expect(select).toHaveBeenCalled();
  });

  it('findStalledRuns returns [] when DB throws', async () => {
    const db = {
      select: () => {
        throw new Error('connection lost');
      },
    } as any;
    expect(await findStalledRuns(db, 30)).toEqual([]);
  });
});
