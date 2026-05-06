import { eq } from 'drizzle-orm';
import { type Db } from '@pilot/db/client';
import { taskRuns } from '@pilot/db/schema';
import type { ActionRecord } from './agent-loop.js';

// ─── AgentLoop checkpointing (Phase 16 Track N) ───
//
// Every N iterations the executing loop snapshots a minimal rehydration
// payload into `task_runs.checkpoint_state`. On crash + restart, the
// orchestrator rehydrates from the most recent snapshot and resumes.
// No full-context replay — the compact checkpoint carries only what's
// needed to reconstruct iteration state.

export const CHECKPOINT_EVERY_N_ITERATIONS = 10;

/** Compact rehydration payload. Trimmed to avoid 8h runs bloating rows. */
export interface CheckpointState {
  iteration: number;
  /** Last ~100 actions — older iterations are safe to drop for replay-from-now. */
  actions: ActionRecord[];
  runUsage: { tokensIn: number; tokensOut: number; model?: string };
  runCost: number;
  /** Wall-clock time the checkpoint was taken. */
  takenAt: string;
}

/**
 * Persist a checkpoint for a task_runs row. Fail-soft by default so
 * watchdog/inspection callers stay tolerant, but runtime loops can request
 * fail-closed semantics for durable resume guarantees.
 */
export async function writeCheckpoint(
  db: Db,
  taskRunId: string,
  state: Omit<CheckpointState, 'takenAt'>,
  options: { required?: boolean } = {},
): Promise<void> {
  if (!taskRunId) return;
  try {
    const trimmed: CheckpointState = {
      ...state,
      actions: state.actions.slice(-100),
      takenAt: new Date().toISOString(),
    };
    await db
      .update(taskRuns)
      .set({
        checkpointState: trimmed,
        lastCheckpointAt: new Date(),
      })
      .where(eq(taskRuns.id, taskRunId));
  } catch (err) {
    if (options.required) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Checkpoint persistence failed for task run ${taskRunId}: ${detail}`);
    }
  }
}

/**
 * Load the most recent checkpoint for a taskRunId, if any.
 * Returns null when the row has no checkpoint yet or doesn't exist.
 */
export async function loadCheckpoint(db: Db, taskRunId: string): Promise<CheckpointState | null> {
  if (!taskRunId) return null;
  try {
    const [row] = await db
      .select({ state: taskRuns.checkpointState })
      .from(taskRuns)
      .where(eq(taskRuns.id, taskRunId))
      .limit(1);
    return (row?.state as CheckpointState | null) ?? null;
  } catch {
    return null;
  }
}

/**
 * Scan `task_runs` for rows still in `status='running'` that haven't
 * been checkpointed in `stalledMinutes` minutes. The caller (pg-boss
 * job) alerts on each row and stamps `watchdog_alerted_at` so we
 * don't alert twice on the same stuck run.
 */
export async function findStalledRuns(
  db: Db,
  stalledMinutes: number,
): Promise<Array<{ id: string; taskId: string; lastActivityAt: Date | null }>> {
  const cutoff = new Date(Date.now() - stalledMinutes * 60_000);
  try {
    const { lt, and, or, isNull, sql } = await import('drizzle-orm');
    // "last activity" = COALESCE(last_checkpoint_at, started_at).
    const rows = await db
      .select({
        id: taskRuns.id,
        taskId: taskRuns.taskId,
        lastActivityAt: sql<Date | null>`COALESCE(${taskRuns.lastCheckpointAt}, ${taskRuns.startedAt})`,
      })
      .from(taskRuns)
      .where(
        and(
          eq(taskRuns.status, 'running'),
          isNull(taskRuns.watchdogAlertedAt),
          or(
            lt(taskRuns.lastCheckpointAt, cutoff),
            and(isNull(taskRuns.lastCheckpointAt), lt(taskRuns.startedAt, cutoff)),
          ),
        ),
      )
      .limit(50);
    return rows;
  } catch {
    return [];
  }
}

/** Mark a stalled run as alerted so the watchdog won't re-trigger. */
export async function markWatchdogAlerted(db: Db, taskRunId: string): Promise<void> {
  try {
    await db
      .update(taskRuns)
      .set({ watchdogAlertedAt: new Date() })
      .where(eq(taskRuns.id, taskRunId));
  } catch {
    /* fail-soft */
  }
}
