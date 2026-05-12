import { type Db } from '@pilot/db/client';
import type { WorkflowConfig } from '@pilot/shared/workflow';
import { parseWorkflow } from '@pilot/shared/workflow';
import { createLogger } from '@pilot/shared/logger';

// ─── PolicyConfig hot-reload (Symphony-adopted) ───
//
// Watches for WORKFLOW.md changes in the database and atomically swaps
// the in-memory PolicyConfig when the content hash changes. Active runs
// continue with their snapshot; new runs pick up the updated policy.

const logger = createLogger('policy-reload');

export interface PolicySnapshot {
  workflow: WorkflowConfig;
  promptBody: string;
  contentHash: string;
  loadedAt: Date;
}

export class PolicyReloader {
  private current: PolicySnapshot | null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    private readonly workspaceId: string,
    private readonly pollIntervalMs: number = 30_000,
    initial?: PolicySnapshot,
  ) {
    this.current = initial ?? null;
  }

  /**
   * Start polling for changes. Idempotent — calling twice is safe.
   */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.checkForUpdates(), this.pollIntervalMs);
    // Do an immediate check at startup
    void this.checkForUpdates();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Get the current policy snapshot. Returns null if no WORKFLOW.md found. */
  get(): PolicySnapshot | null {
    return this.current;
  }

  /**
   * Check for WORKFLOW.md updates in the database.
   * Atomically swaps the in-memory snapshot if content hash differs.
   */
  private async checkForUpdates(): Promise<void> {
    try {
      const { pages } = await import('@pilot/db/schema');
      const { and, eq } = await import('drizzle-orm');

      const [row] = await this.db
        .select({ compiledTruth: pages.compiledTruth })
        .from(pages)
        .where(and(eq(pages.workspaceId, this.workspaceId), eq(pages.type, 'workflow_policy')))
        .limit(1);

      if (!row?.compiledTruth) {
        // No WORKFLOW.md set — keep current policy (or null)
        return;
      }

      const rawContent =
        typeof row.compiledTruth === 'string' ? row.compiledTruth : String(row.compiledTruth);
      const parsed = parseWorkflow(rawContent);

      if (this.current && this.current.contentHash === parsed.contentHash) {
        // No change — skip swap
        return;
      }

      const oldHash = this.current?.contentHash ?? 'none';
      this.current = {
        workflow: parsed.config,
        promptBody: parsed.promptBody,
        contentHash: parsed.contentHash,
        loadedAt: new Date(),
      };

      logger.info(
        {
          workspaceId: this.workspaceId,
          oldHash,
          newHash: parsed.contentHash,
          name: parsed.config.name,
          version: parsed.config.version,
        },
        'Policy reloaded',
      );
    } catch (err) {
      // Fail-soft: log and continue with current policy
      logger.error(
        {
          workspaceId: this.workspaceId,
          error: err instanceof Error ? err.message : String(err),
        },
        'Policy reload check failed',
      );
    }
  }
}
