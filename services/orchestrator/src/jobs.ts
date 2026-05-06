import PgBoss from 'pg-boss';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull, lt } from 'drizzle-orm';
import { appendEvidenceItem } from '@pilot/db';
import { type Db } from '@pilot/db/client';
import {
  auditLog,
  opportunityScores,
  opportunities,
  tasks,
  taskRuns,
  workspaces,
  workspaceDeletions,
  founderProfiles,
  founderStrengths,
} from '@pilot/db/schema';
import { scoreOpportunity, type ScoringResult } from '@pilot/shared/scoring';
import { type MemoryService } from '@pilot/memory';
import { type LlmProvider } from '@pilot/shared/llm';
import {
  type OAuthFlowManager,
  type RefreshNotifier,
  registerRefreshJobs,
} from '@pilot/connectors';
import { createLogger } from '@pilot/shared/logger';
import { type Orchestrator } from './index.js';
import { loadParentRunHistory } from './run-history.js';

const log = createLogger('jobs');

export interface JobDeps {
  db: Db;
  memory?: MemoryService;
  llm?: LlmProvider;
  orchestrator?: Orchestrator;
  /**
   * OAuth flow manager. When present, the connector-refresh background worker
   * is registered alongside the other jobs. When absent, no refresh worker
   * runs — appropriate for tests and dev instances without OAuth configured.
   */
  oauth?: OAuthFlowManager;
  /**
   * Notifier for permanent refresh failures. When a grant hits
   * PERMANENT_AFTER_ATTEMPTS the worker calls `notifier.reauthRequired(
   * workspaceId, connectorName)` so the re-auth banner surfaces.
   */
  refreshNotifier?: RefreshNotifier;
  /**
   * Test seam for pipeline execution. Production uses the allowlisted Python
   * runner below; tests can inject a deterministic runner without spawning
   * Scrapling or intelligence scripts.
   */
  pipelineRunner?: (name: string, extraArgs: string[]) => Promise<PipelineRunResult>;
}

type OpportunityScorePersistenceDb = Pick<Db, 'insert' | 'update'>;

interface PipelineRunResult {
  scriptPath: string;
  args: string[];
  stdoutPreview: string;
  stderrPreview: string | null;
}

type PipelineJobData = {
  workspaceId?: string;
  auditEventId?: string;
  evidenceItemId?: string;
  replayRef?: string;
};

/**
 * Register background job handlers on a pg-boss instance.
 */
export async function registerJobHandlers(boss: PgBoss, deps: JobDeps): Promise<void> {
  // ─── Opportunity Scoring (Phase 3a) ───
  // Uses the versioned scoring engine in @pilot/shared/scoring with
  // the founder's profile + strengths plumbed through for founder-fit.
  // Uses heuristic scoring only when no LLM is configured. Once a governed
  // model provider is configured, model/HELM failures propagate so production
  // cannot persist a fake autonomous score.
  boss.work('opportunity.score', async (jobs: PgBoss.Job<{ opportunityId: string }>[]) => {
    for (const job of jobs) {
      const { opportunityId } = job.data;
      log.info({ opportunityId }, 'Scoring opportunity');

      // lint-tenancy: ok — opportunityId is workspace-scoped by the job
      //   producer (enqueuers verify the opportunity belongs to the caller's
      //   workspace before calling boss.send). The founder-profile join below
      //   is explicitly scoped by opp.workspaceId after the initial lookup.
      const [opp] = await deps.db
        .select()
        .from(opportunities)
        .where(eq(opportunities.id, opportunityId))
        .limit(1);

      if (!opp) {
        log.warn({ opportunityId }, 'Opportunity not found');
        continue;
      }

      // Pull founder profile + strengths so the scoring engine can compute
      // a meaningful founder-fit number. Optional — heuristic score fires
      // without them. founderStrengths is keyed by founderId, so two
      // sequential queries are cheaper than a join that returns
      // workspaceId multiple times.
      let profile: typeof founderProfiles.$inferSelect | undefined;
      let strengths: Array<{ dimension: string; score: number }> = [];
      if (opp.workspaceId) {
        const profileRows = await deps.db
          .select()
          .from(founderProfiles)
          .where(eq(founderProfiles.workspaceId, opp.workspaceId))
          .limit(1);
        profile = profileRows[0];
        if (profile) {
          const strengthRows = await deps.db
            .select()
            .from(founderStrengths)
            .where(eq(founderStrengths.founderId, profile.id));
          strengths = strengthRows.map((r) => ({
            dimension: r.dimension,
            score: Number(r.score ?? 0),
          }));
        }
      }

      try {
        if (!deps.llm && requiresProductionGovernedScoring()) {
          throw new Error('LLM provider is required for production opportunity scoring');
        }

        const result = await scoreOpportunity(
          {
            title: opp.title,
            description: opp.description,
            source: opp.source,
            sourceUrl: opp.sourceUrl ?? null,
            founderProfile: profile
              ? {
                  background: profile.background ?? null,
                  experience: profile.experience ?? null,
                  interests: (profile.interests as string[] | null) ?? null,
                  startupVector: profile.startupVector ?? null,
                }
              : null,
            founderStrengths: strengths,
          },
          deps.llm,
        );
        assertProductionScoreGovernance(result);

        await deps.db.transaction(async (tx) => {
          await tx.insert(opportunityScores).values({
            opportunityId,
            overallScore: result.overall,
            founderFitScore: result.founderFit,
            marketSignal: result.marketSignal,
            feasibility: result.feasibility,
            timing: result.timing,
            scoringMethod: result.method,
            policyDecisionId: result.governance?.decisionId ?? null,
            policyVersion: result.governance?.policyVersion ?? null,
            helmDocumentVersionPins: opportunityScoreDocumentPins(result),
            modelUsage: result.usage ? { ...result.usage } : {},
          });

          await tx
            .update(opportunities)
            .set({ status: 'scored' })
            .where(eq(opportunities.id, opportunityId));

          await appendOpportunityScoreGovernanceEvidence({
            db: tx,
            opportunity: opp,
            result,
          });
        });

        log.info(
          {
            opportunityId,
            method: result.method,
            overall: result.overall,
            promptVersion: result.promptVersion,
          },
          'Opportunity scored',
        );
      } catch (err) {
        log.error({ err, opportunityId }, 'Failed to score opportunity');
        throw err;
      }
    }
  });

  async function appendOpportunityScoreGovernanceEvidence(input: {
    db: OpportunityScorePersistenceDb;
    opportunity: typeof opportunities.$inferSelect;
    result: ScoringResult;
  }): Promise<void> {
    const workspaceId = input.opportunity.workspaceId;
    if (!workspaceId) return;

    const helmDocumentVersionPins = opportunityScoreDocumentPins(input.result);
    const metadata = {
      opportunityId: input.opportunity.id,
      method: input.result.method,
      promptVersion: input.result.promptVersion,
      overall: input.result.overall,
      founderFit: input.result.founderFit,
      marketSignal: input.result.marketSignal,
      feasibility: input.result.feasibility,
      timing: input.result.timing,
      policyDecisionId: input.result.governance?.decisionId ?? null,
      policyVersion: input.result.governance?.policyVersion ?? null,
      helmDocumentVersionPins,
      modelUsage: input.result.usage ?? null,
      credentialBoundary: 'no_raw_credentials_or_session_payloads_in_evidence',
    };

    await input.db.insert(auditLog).values({
      workspaceId,
      action: 'OPPORTUNITY_SCORE_RECORDED',
      actor: 'job:opportunity.score',
      target: input.opportunity.id,
      verdict: 'allow',
      metadata,
    });

    await appendEvidenceItem(input.db, {
      workspaceId,
      evidenceType: 'opportunity_score',
      sourceType: 'opportunity_score_worker',
      title: `Opportunity scored: ${input.opportunity.title}`,
      summary: input.result.rationale,
      redactionState: 'redacted',
      sensitivity: 'internal',
      contentHash: `sha256:${hashJson(metadata)}`,
      replayRef: input.result.governance?.decisionId
        ? `helm:${input.result.governance.decisionId}`
        : `opportunity-score:${input.opportunity.id}:${hashJson(metadata).slice(0, 16)}`,
      metadata,
    });
  }

  // ─── Knowledge Recompilation ───
  boss.work('knowledge.recompile', async (jobs: PgBoss.Job<{ pageId: string }>[]) => {
    for (const job of jobs) {
      const { pageId } = job.data;
      log.info({ pageId }, 'Recompiling knowledge page');

      if (!deps.memory) {
        log.warn('Memory service not available');
        continue;
      }

      try {
        await deps.memory.recompileTruth(pageId);
        log.info({ pageId }, 'Knowledge page recompiled');
      } catch (err) {
        log.error({ err, pageId }, 'Failed to recompile knowledge page');
        throw err;
      }
    }
  });

  // ─── Task Resume (after approval) ───
  boss.work(
    'task.resume',
    async (
      jobs: PgBoss.Job<{
        taskId: string;
        workspaceId: string;
        operatorId?: string;
        context: string;
      }>[],
    ) => {
      for (const job of jobs) {
        const { taskId, workspaceId, operatorId, context } = job.data;
        log.info({ taskId }, 'Resuming task after approval');

        if (!deps.orchestrator) {
          log.warn('Orchestrator not available for task resume');
          continue;
        }

        try {
          const history = await loadParentRunHistory(deps.db, { taskId, workspaceId });
          if (!history.taskFound) {
            log.warn({ taskId, workspaceId }, 'Skipping resume for task outside workspace');
            continue;
          }

          const result = await deps.orchestrator.resumeTask({
            taskId,
            workspaceId,
            operatorId,
            context,
            priorActions: history.priorActions,
          });

          log.info(
            { taskId, status: result.status, iterations: result.iterationsUsed },
            'Task resumed',
          );
        } catch (err) {
          log.error({ err, taskId }, 'Failed to resume task');
          throw err;
        }
      }
    },
  );

  // ─── Pipeline Execution (Python scripts) ───
  //
  // Security: Only scripts in the allowlist can be executed.
  // Paths are resolved relative to cwd and validated against traversal.
  const PIPELINE_ALLOWLIST: Record<string, string> = {
    'pipeline.yc-scrape': 'pipelines/yc-scraper/scrape_yc.py',
    'pipeline.startup-school': 'pipelines/yc-scraper/scrape_startup_school.py',
    'pipeline.yc-private': 'pipelines/yc-scraper/scrape_yc_private.py',
    'pipeline.ingest-knowledge': 'pipelines/intelligence/ingest_ccunpacked.py',
    'pipeline.cluster': 'pipelines/intelligence/cluster.py',
  };
  const PIPELINE_TIMEOUT = 900_000; // 15 min (Startup school scrape can take time)
  const pythonBin = process.env.PYTHON_BIN || 'python3';

  async function runPipeline(name: string, extraArgs: string[] = []): Promise<PipelineRunResult> {
    if (deps.pipelineRunner) {
      return deps.pipelineRunner(name, extraArgs);
    }

    const scriptPath = PIPELINE_ALLOWLIST[name];
    if (!scriptPath) {
      throw new Error(`Pipeline ${name} is not in the allowlist`);
    }

    // Guard against path traversal
    const { resolve, relative } = await import('node:path');
    const cwd = process.cwd();
    const resolved = resolve(cwd, scriptPath);
    const rel = relative(cwd, resolved);
    if (rel.startsWith('..') || resolve(cwd, rel) !== resolved) {
      throw new Error(`Pipeline path traversal blocked: ${scriptPath}`);
    }

    // Verify the script file exists before execution
    const { access } = await import('node:fs/promises');
    await access(resolved).catch(() => {
      throw new Error(`Pipeline script not found: ${resolved}`);
    });

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    log.info({ pipeline: name, script: scriptPath, extraArgs }, 'Running pipeline');
    const args = [resolved, ...extraArgs];
    const { stdout, stderr } = await execFileAsync(pythonBin, args, {
      timeout: PIPELINE_TIMEOUT,
      cwd,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      maxBuffer: 20 * 1024 * 1024, // 20MB max output
    });
    if (stderr) log.warn({ stderr: stderr.slice(0, 500), pipeline: name }, 'Pipeline stderr');
    log.info({ stdout: stdout.slice(0, 200), pipeline: name }, 'Pipeline completed');
    return {
      scriptPath,
      args,
      stdoutPreview: stdout.slice(0, 500),
      stderrPreview: stderr ? stderr.slice(0, 500) : null,
    };
  }

  async function runPipelineWithEvidence(
    name: keyof typeof PIPELINE_ALLOWLIST,
    job: PgBoss.Job<PipelineJobData>,
    extraArgs: string[] = [],
  ): Promise<PipelineRunResult> {
    const workspaceId = job.data?.workspaceId;
    try {
      const result = await runPipeline(name, extraArgs);
      await appendPipelineEvidence({
        name,
        job,
        workspaceId,
        status: 'pipeline_job_succeeded',
        result,
      });
      return result;
    } catch (err) {
      await appendPipelineEvidence({
        name,
        job,
        workspaceId,
        status: 'pipeline_job_failed',
        error: err,
        fallbackArgs: extraArgs,
      });
      throw err;
    }
  }

  async function runPublicPipelineForAllWorkspaces(
    name: 'pipeline.yc-scrape' | 'pipeline.startup-school',
    job: PgBoss.Job<PipelineJobData>,
    baseArgs: string[] = [],
  ): Promise<void> {
    const rows = await deps.db.select({ id: workspaces.id }).from(workspaces);
    if (rows.length === 0) {
      log.warn({ pipeline: name, jobId: job.id }, 'Skipping scheduled pipeline; no workspaces');
      return;
    }

    for (const row of rows) {
      try {
        await runPipelineWithEvidence(
          name,
          { ...job, data: { ...(job.data ?? {}), workspaceId: row.id } },
          [...baseArgs, '--workspace-id', row.id],
        );
      } catch (err) {
        log.error({ err, pipeline: name, workspaceId: row.id }, 'Scheduled pipeline failed');
      }
    }
  }

  async function appendPipelineEvidence(input: {
    name: keyof typeof PIPELINE_ALLOWLIST;
    job: PgBoss.Job<PipelineJobData>;
    workspaceId?: string;
    status: 'pipeline_job_succeeded' | 'pipeline_job_failed';
    result?: PipelineRunResult;
    error?: unknown;
    fallbackArgs?: string[];
  }): Promise<void> {
    if (!input.workspaceId) {
      log.warn(
        { pipeline: input.name, jobId: input.job.id, status: input.status },
        'Skipping pipeline evidence item without workspace scope',
      );
      return;
    }

    const workspaceId = input.workspaceId;
    const args = input.result?.args ?? input.fallbackArgs ?? [];
    const sanitizedArgs = sanitizePipelineArgs(args);
    const auditEventId = randomUUID();
    const replayRef = `pipeline:${input.name}:${input.job.id ?? hashJson(args).slice(0, 16)}:${input.status}`;
    const metadata = {
      pipeline: input.name,
      jobId: input.job.id ?? null,
      status: input.status,
      requestAuditEventId: input.job.data?.auditEventId ?? null,
      requestEvidenceItemId: input.job.data?.evidenceItemId ?? null,
      requestReplayRef: input.job.data?.replayRef ?? null,
      scriptPath: input.result?.scriptPath ?? PIPELINE_ALLOWLIST[input.name],
      args: sanitizedArgs,
      stdoutPreview: input.result?.stdoutPreview ?? null,
      stderrPreview: input.result?.stderrPreview ?? null,
      error: input.error ? sanitizeError(input.error) : null,
      credentialBoundary: 'no_raw_credentials_or_session_payloads_in_evidence',
    };

    await deps.db.transaction(async (tx) => {
      await tx.insert(auditLog).values({
        id: auditEventId,
        workspaceId,
        action:
          input.status === 'pipeline_job_succeeded'
            ? 'PIPELINE_JOB_SUCCEEDED'
            : 'PIPELINE_JOB_FAILED',
        actor: `job:${input.name}`,
        target: input.job.id ?? input.name,
        verdict: input.status === 'pipeline_job_succeeded' ? 'allow' : 'error',
        metadata: {
          evidenceType: input.status,
          replayRef,
          evidenceItemId: null,
          ...metadata,
        },
      });

      const evidenceItemId = await appendEvidenceItem(tx, {
        workspaceId,
        auditEventId,
        evidenceType: input.status,
        sourceType: 'pipeline_worker',
        title:
          input.status === 'pipeline_job_succeeded'
            ? `${input.name} completed`
            : `${input.name} failed`,
        summary:
          input.status === 'pipeline_job_succeeded'
            ? 'Workspace-scoped background ingestion pipeline completed.'
            : 'Workspace-scoped background ingestion pipeline failed before completion.',
        redactionState: 'redacted',
        sensitivity: input.name === 'pipeline.yc-private' ? 'sensitive' : 'internal',
        contentHash: hashJson(metadata),
        replayRef,
        metadata,
      });

      await tx
        .update(auditLog)
        .set({
          metadata: {
            evidenceType: input.status,
            replayRef,
            evidenceItemId,
            ...metadata,
          },
        })
        .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));
    });
  }

  boss.work(
    'pipeline.yc-scrape',
    async (
      jobs: PgBoss.Job<{
        replayPath?: string;
        batch?: string;
        limit?: number;
        workspaceId?: string;
        auditEventId?: string;
        evidenceItemId?: string;
        replayRef?: string;
      }>[],
    ) => {
      for (const job of jobs) {
        try {
          const args = [
            ...(job.data?.replayPath ? ['--replay', job.data.replayPath] : []),
            ...(job.data?.batch ? ['--batch', job.data.batch] : []),
            ...(job.data?.limit ? ['--limit', String(job.data.limit)] : []),
          ];
          if (!job.data?.workspaceId) {
            await runPublicPipelineForAllWorkspaces('pipeline.yc-scrape', job, args);
            continue;
          }
          args.push('--workspace-id', job.data.workspaceId);
          await runPipelineWithEvidence('pipeline.yc-scrape', job, args);
        } catch (err) {
          log.error({ err }, 'YC scraper pipeline failed');
          throw err;
        }
      }
    },
  );

  boss.work(
    'pipeline.startup-school',
    async (
      jobs: PgBoss.Job<{
        replayPath?: string;
        limit?: number;
        workspaceId?: string;
        auditEventId?: string;
        evidenceItemId?: string;
        replayRef?: string;
      }>[],
    ) => {
      for (const job of jobs) {
        try {
          const args = [
            ...(job.data?.replayPath ? ['--replay', job.data.replayPath] : []),
            ...(job.data?.limit ? ['--limit', String(job.data.limit)] : []),
          ];
          if (!job.data?.workspaceId) {
            await runPublicPipelineForAllWorkspaces('pipeline.startup-school', job, args);
            continue;
          }
          args.push('--workspace-id', job.data.workspaceId);
          await runPipelineWithEvidence('pipeline.startup-school', job, args);
        } catch (err) {
          log.error({ err }, 'Startup School pipeline failed');
          throw err;
        }
      }
    },
  );

  boss.work('pipeline.ingest-knowledge', async (jobs: PgBoss.Job[]) => {
    for (const job of jobs as Array<PgBoss.Job<{ workspaceId?: string }>>) {
      try {
        await runPipelineWithEvidence('pipeline.ingest-knowledge', job);
      } catch (err) {
        log.error({ err }, 'Knowledge ingestion pipeline failed');
        throw err;
      }
    }
  });

  boss.work(
    'pipeline.yc-private',
    async (
      jobs: PgBoss.Job<{
        grantId: string;
        action?: 'validate' | 'sync';
        limit?: number;
        workspaceId?: string;
        auditEventId?: string;
        evidenceItemId?: string;
        replayRef?: string;
      }>[],
    ) => {
      for (const job of jobs) {
        try {
          const args = [
            '--grant-id',
            job.data.grantId,
            '--action',
            job.data.action ?? 'sync',
            ...(job.data.limit ? ['--limit', String(job.data.limit)] : []),
            ...(job.data.workspaceId ? ['--workspace-id', job.data.workspaceId] : []),
          ];
          await runPipelineWithEvidence('pipeline.yc-private', job, args);
        } catch (err) {
          log.error({ err }, 'YC private pipeline failed');
          throw err;
        }
      }
    },
  );

  // ─── Crashed-Task Reaper ───
  // If the gateway/orchestrator crashes mid-agent-loop, a task row stays in
  // 'running' forever. This job reaps anything stuck for >10min.
  boss.work('tasks.reap_stuck', async (jobs: PgBoss.Job[]) => {
    for (const _job of jobs) {
      try {
        const cutoff = new Date(Date.now() - 10 * 60 * 1000);
        const stuck = await deps.db
          .update(tasks)
          .set({ status: 'failed', updatedAt: new Date() })
          .where(and(eq(tasks.status, 'running'), lt(tasks.updatedAt, cutoff)))
          .returning({ id: tasks.id });

        if (stuck.length === 0) continue;

        for (const row of stuck) {
          await deps.db.insert(taskRuns).values({
            taskId: row.id,
            status: 'failed',
            verdict: 'reaped',
            error: 'Task reaped after 10min without progress — presumed crashed',
            completedAt: new Date(),
          });
        }
        log.warn({ count: stuck.length, taskIds: stuck.map((r) => r.id) }, 'Reaped stuck tasks');
      } catch (err) {
        log.error({ err }, 'Task reaper failed');
        throw err;
      }
    }
  });

  // ─── Tenant Hard-Delete Sweep (Phase 2d) ───
  // Looks for workspaces whose `hard_delete_after` window has passed and
  // tears them down with a single cascading DELETE. Runs on a schedule so
  // operators don't have to poke the admin endpoint; the admin endpoint
  // calls the same logic for manual drills.
  boss.work('tenant.hard-delete-sweep', async (jobs: PgBoss.Job<{ limit?: number }>[]) => {
    for (const job of jobs) {
      const limit = Math.max(1, Math.min(500, job.data?.limit ?? 50));
      try {
        const pending = await deps.db
          .select()
          .from(workspaceDeletions)
          .where(
            and(
              isNull(workspaceDeletions.hardDeletedAt),
              lt(workspaceDeletions.hardDeleteAfter, new Date()),
            ),
          )
          .limit(limit);
        let deleted = 0;
        for (const row of pending) {
          // lint-tenancy: ok — scheduled platform cleanup is the only task
          //   allowed to issue cross-tenant hard deletes.
          await deps.db.delete(workspaces).where(eq(workspaces.id, row.workspaceId));
          deleted++;
        }
        if (deleted > 0) log.info({ deleted, pending: pending.length }, 'tenant hard-delete sweep');
      } catch (err) {
        log.error({ err }, 'tenant hard-delete sweep failed');
        throw err;
      }
    }
  });

  // ─── Cluster Generation (Phase 3b) ───
  // Rebuilds opportunity clusters for every workspace that has ≥3 scored
  // opportunities. Runs nightly at 2am UTC via cron. Can also be triggered
  // ad-hoc via `POST /api/opportunities/cluster` which enqueues a job
  // with a specific workspaceId.
  boss.work('pipeline.cluster', async (jobs: PgBoss.Job<{ workspaceId?: string }>[]) => {
    for (const job of jobs) {
      const workspaceId = job.data?.workspaceId;
      if (!workspaceId) {
        // Cron trigger — run for all workspaces (admin operation)
        log.info('Cluster cron: enumerating workspaces for cluster rebuild');
        const allWorkspaces = await deps.db.select({ id: workspaces.id }).from(workspaces);
        for (const ws of allWorkspaces) {
          try {
            await runPipelineWithEvidence(
              'pipeline.cluster',
              { ...job, data: { ...(job.data ?? {}), workspaceId: ws.id } },
              ['--workspace-id', ws.id],
            );
          } catch (err) {
            log.error({ err, workspaceId: ws.id }, 'Cluster generation failed for workspace');
          }
        }
        return;
      }
      try {
        await runPipelineWithEvidence('pipeline.cluster', job, ['--workspace-id', workspaceId]);
        log.info({ workspaceId }, 'Cluster generation complete');
      } catch (err) {
        log.error({ err, workspaceId }, 'Cluster generation failed');
        throw err;
      }
    }
  });

  // ─── Scheduled Jobs ───
  // pg-boss v10 requires queues to exist before scheduling. createQueue is idempotent
  // on already-existing queues but errors if not called first for a new queue.
  const scheduledJobs: Array<[string, string]> = [
    ['pipeline.yc-scrape', '0 3 * * 0'], // Weekly Sunday 3am UTC
    ['pipeline.startup-school', '0 4 * * 0'], // Weekly Sunday 4am UTC
    ['pipeline.cluster', '0 2 * * *'], // Daily 2am UTC — rebuild workspace clusters
    ['tasks.reap_stuck', '*/5 * * * *'], // Every 5 minutes
    ['tenant.hard-delete-sweep', '0 5 * * *'], // Daily 5am UTC — past-grace hard delete
  ];
  for (const [name, cron] of scheduledJobs) {
    try {
      await boss.createQueue(name);
    } catch {
      // Queue already exists — continue to schedule
    }
    try {
      await boss.schedule(name, cron, {}, { tz: 'UTC' });
    } catch (err) {
      log.warn({ err, name, cron }, 'Failed to schedule job — continuing without it');
    }
  }

  // ─── Connector token refresh worker (Phase 13, Track B) ───
  // Runs only when OAuth is configured. Idempotent — registers the two
  // refresh queues + schedules the tick cron.
  if (deps.oauth) {
    try {
      await registerRefreshJobs(boss, {
        db: deps.db,
        oauth: deps.oauth,
        notifier: deps.refreshNotifier,
      });
    } catch (err) {
      log.warn({ err }, 'Failed to register connector refresh worker — continuing');
    }
  }

  log.info('Background job handlers registered');
}

function sanitizePipelineArgs(args: string[]): string[] {
  const sensitiveValueFlags = new Set(['--grant-id', '--replay']);
  return args.map((arg, index) => {
    const previous = args[index - 1];
    if (previous && sensitiveValueFlags.has(previous)) {
      return `sha256:${hashJson(arg).slice(0, 16)}`;
    }
    return arg;
  });
}

function assertProductionScoreGovernance(result: ScoringResult): void {
  if (!requiresProductionGovernedScoring()) return;
  if (result.method === 'llm' && !result.governance) {
    throw new Error('Production opportunity scoring requires HELM-governed model metadata');
  }
}

function requiresProductionGovernedScoring(): boolean {
  return process.env['NODE_ENV'] === 'production' && process.env['HELM_FAIL_CLOSED'] !== '0';
}

function opportunityScoreDocumentPins(result: ScoringResult): Record<string, string> {
  return {
    opportunityScorePrompt: result.promptVersion,
    ...(result.governance?.policyVersion
      ? { opportunityScorePolicy: result.governance.policyVersion }
      : {}),
  };
}

function sanitizeError(error: unknown): {
  name: string;
  messageHash: string;
  redactedPreview: string;
} {
  const name = error instanceof Error ? error.name : 'Error';
  const rawMessage = error instanceof Error ? error.message : String(error);
  return {
    name,
    messageHash: `sha256:${hashJson(rawMessage)}`,
    redactedPreview: redactSensitiveText(rawMessage).slice(0, 1_000),
  };
}

function redactSensitiveText(input: string): string {
  return input
    .replace(/(--(?:grant-id|replay)\s+)(\S+)/gi, '$1[redacted]')
    .replace(/\b(grant)-[A-Za-z0-9_-]+/g, '$1-[redacted]')
    .replace(/\b(token|secret|password|cookie|session)=([^&\s]+)/gi, '$1=[redacted]')
    .replace(/\/[^\s]*raw-captures\/[^\s]+/g, '[redacted-path]');
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
