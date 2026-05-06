import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { appendEvidenceItem } from '@pilot/db';
import { registerJobHandlers } from '../jobs.js';

vi.mock('@pilot/db', () => ({
  appendEvidenceItem: vi.fn(async () => 'evidence-item-1'),
}));

vi.mock('@pilot/db/schema', () => ({
  auditLog: 'auditLog',
  opportunities: 'opportunities',
  opportunityScores: 'opportunityScores',
  taskRuns: {
    id: 'taskRuns.id',
    taskId: 'taskRuns.taskId',
    actionTool: 'taskRuns.actionTool',
    lineageKind: 'taskRuns.lineageKind',
    parentTaskRunId: 'taskRuns.parentTaskRunId',
    runSequence: 'taskRuns.runSequence',
    startedAt: 'taskRuns.startedAt',
  },
  tasks: {
    id: 'tasks.id',
    workspaceId: 'tasks.workspaceId',
    status: 'tasks.status',
    updatedAt: 'tasks.updatedAt',
  },
  workspaces: { id: 'workspaces.id' },
  workspaceDeletions: {
    workspaceId: 'workspaceDeletions.workspaceId',
    hardDeletedAt: 'workspaceDeletions.hardDeletedAt',
    hardDeleteAfter: 'workspaceDeletions.hardDeleteAfter',
  },
  founderProfiles: { id: 'founderProfiles.id', workspaceId: 'founderProfiles.workspaceId' },
  founderStrengths: { founderId: 'founderStrengths.founderId' },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn((...conditions: unknown[]) => ({ op: 'and', conditions })),
  asc: vi.fn((col: unknown) => ({ op: 'asc', col })),
  eq: vi.fn((_col: any, val: any) => ({ col: _col, val })),
  isNotNull: vi.fn((col: unknown) => ({ op: 'isNotNull', col })),
  isNull: vi.fn((col: unknown) => ({ op: 'isNull', col })),
  lt: vi.fn((col: unknown, val: unknown) => ({ op: 'lt', col, val })),
}));

vi.mock('@pilot/shared/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

let mockDb: any;
const originalEnv = {
  NODE_ENV: process.env['NODE_ENV'],
  HELM_FAIL_CLOSED: process.env['HELM_FAIL_CLOSED'],
};

function restoreEnv(name: keyof typeof originalEnv) {
  const original = originalEnv[name];
  if (original === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = original;
  }
}

function freshMockDb() {
  const inserts: Array<{ table: unknown; value: Record<string, unknown> }> = [];
  const updates: Array<{ table: unknown; value: unknown }> = [];
  const db: any = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            then: (r: any) => r([]),
          })),
          then: (r: any) => r([]),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        inserts.push({ table, value });
        return {
          then: (r: any) => r([]),
          catch: vi.fn(),
        };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((value: unknown) => ({
        where: vi.fn(() => {
          updates.push({ table, value });
          return Promise.resolve();
        }),
      })),
    })),
    transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(db)),
    _inserts: inserts,
    _updates: updates,
  };
  return db;
}

describe('registerJobHandlers', () => {
  const handlers = new Map<string, Function>();
  const mockBoss = {
    work: vi.fn((name: string, handler: Function) => {
      handlers.set(name, handler);
    }),
    schedule: vi.fn(),
    send: vi.fn(),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    mockDb = freshMockDb();
  });

  afterEach(() => {
    restoreEnv('NODE_ENV');
    restoreEnv('HELM_FAIL_CLOSED');
  });

  it('registers all expected job handlers', () => {
    registerJobHandlers(mockBoss, { db: mockDb });

    const registeredNames = mockBoss.work.mock.calls.map((c: any[]) => c[0]);
    expect(registeredNames).toContain('opportunity.score');
    expect(registeredNames).toContain('knowledge.recompile');
    expect(registeredNames).toContain('task.resume');
    expect(registeredNames).toContain('pipeline.yc-scrape');
    expect(registeredNames).toContain('pipeline.ingest-knowledge');

    // Schedule called for yc-scrape
    expect(mockBoss.schedule).toHaveBeenCalledWith(
      'pipeline.yc-scrape',
      expect.any(String),
      expect.anything(),
      expect.anything(),
    );
  });

  describe('opportunity.score', () => {
    it('skips when opportunity not found', async () => {
      registerJobHandlers(mockBoss, { db: mockDb, llm: { complete: vi.fn() } as any });
      const handler = handlers.get('opportunity.score')!;

      // db.select returns empty array (opportunity not found)
      await handler([{ data: { opportunityId: 'opp-1' } }]);

      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('falls back to heuristic scoring when no LLM configured', async () => {
      // Phase 3a: the job always produces a score — heuristic when no LLM.
      // This is a contract change from the pre-Phase-3a behaviour (which
      // silently no-op'd) so Discover never serves null scores.
      registerJobHandlers(mockBoss, { db: mockDb });
      const handler = handlers.get('opportunity.score')!;

      let selectCount = 0;
      mockDb.select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({
              then: (r: any) => {
                selectCount++;
                if (selectCount === 1)
                  return r([
                    {
                      id: 'opp-1',
                      title: 'Test Opp',
                      description: 'A test',
                      source: 'hn',
                      workspaceId: null,
                    },
                  ]);
                return r([]);
              },
            })),
          })),
        })),
      }));

      await handler([{ data: { opportunityId: 'opp-1' } }]);

      // Heuristic path still inserts a row with scoringMethod='heuristic'.
      expect(mockDb.insert).toHaveBeenCalledWith('opportunityScores');
    });

    it('scores via LLM (completeWithUsage) and inserts scores', async () => {
      let selectCount = 0;
      mockDb.select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({
              then: (r: any) => {
                selectCount++;
                if (selectCount === 1)
                  return r([
                    {
                      id: 'opp-1',
                      title: 'Test Opp',
                      description: 'A test opportunity',
                      source: 'hn',
                      workspaceId: null,
                    },
                  ]);
                return r([]);
              },
            })),
          })),
        })),
      }));

      const mockLlm = {
        complete: vi.fn(),
        completeWithUsage: vi.fn(async () => ({
          content:
            '{"overall":80,"founderFit":70,"marketSignal":75,"timing":60,"feasibility":85,"rationale":"ok"}',
          usage: { tokensIn: 100, tokensOut: 50, model: 'test' },
        })),
      } as any;

      registerJobHandlers(mockBoss, { db: mockDb, llm: mockLlm });
      const handler = handlers.get('opportunity.score')!;

      await handler([{ data: { opportunityId: 'opp-1' } }]);

      expect(mockLlm.completeWithUsage).toHaveBeenCalledOnce();
      expect(mockDb.insert).toHaveBeenCalledWith('opportunityScores');
    });

    it('persists HELM governance metadata and evidence for workspace LLM scores', async () => {
      vi.mocked(appendEvidenceItem).mockClear();
      const insertValues = vi.fn(() => ({
        then: (r: any) => r([]),
        catch: vi.fn(),
      }));
      mockDb.insert = vi.fn(() => ({ values: insertValues }));

      let selectCount = 0;
      mockDb.select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({
              then: (r: any) => {
                selectCount++;
                if (selectCount === 1)
                  return r([
                    {
                      id: 'opp-1',
                      title: 'Test Opp',
                      description: 'A test opportunity',
                      source: 'hn',
                      sourceUrl: 'https://example.com/opp',
                      workspaceId: 'ws-1',
                    },
                  ]);
                return r([]);
              },
            })),
          })),
        })),
      }));

      const mockLlm = {
        complete: vi.fn(),
        completeWithUsage: vi.fn(async () => ({
          content:
            '{"overall":80,"founderFit":70,"marketSignal":75,"timing":60,"feasibility":85,"rationale":"ok"}',
          usage: { tokensIn: 100, tokensOut: 50, model: 'test' },
          governance: {
            decisionId: 'dec-score',
            verdict: 'ALLOW',
            policyVersion: 'founder-ops-v1',
            principal: 'workspace:ws-1/operator:scoring',
          },
        })),
      } as any;

      registerJobHandlers(mockBoss, { db: mockDb, llm: mockLlm });
      const handler = handlers.get('opportunity.score')!;

      await handler([
        {
          id: 'job-score-1',
          data: {
            opportunityId: 'opp-1',
            auditEventId: 'request-audit-1',
            evidenceItemId: 'request-evidence-1',
            replayRef: 'opportunity:ws-1:opp-1:score-requested',
          },
        },
      ]);

      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          opportunityId: 'opp-1',
          scoringMethod: 'llm',
          policyDecisionId: 'dec-score',
          policyVersion: 'founder-ops-v1',
          helmDocumentVersionPins: {
            opportunityScorePolicy: 'founder-ops-v1',
            opportunityScorePrompt: 'opportunity-score.v1',
          },
          modelUsage: { tokensIn: 100, tokensOut: 50, model: 'test' },
        }),
      );
      const auditInsert = insertValues.mock.calls
        .map((call) => call[0])
        .find((value) => value?.action === 'OPPORTUNITY_SCORE_RECORDED');
      expect(auditInsert).toMatchObject({
        id: expect.any(String),
        workspaceId: 'ws-1',
        action: 'OPPORTUNITY_SCORE_RECORDED',
        actor: 'job:opportunity.score',
        target: 'opp-1',
        verdict: 'allow',
        metadata: expect.objectContaining({
          jobId: 'job-score-1',
          requestAuditEventId: 'request-audit-1',
          requestEvidenceItemId: 'request-evidence-1',
          requestReplayRef: 'opportunity:ws-1:opp-1:score-requested',
          evidenceItemId: null,
        }),
      });
      expect(mockDb.insert).toHaveBeenCalledWith('auditLog');
      expect(appendEvidenceItem).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          workspaceId: 'ws-1',
          auditEventId: auditInsert.id,
          evidenceType: 'opportunity_score',
          sourceType: 'opportunity_score_worker',
          replayRef: 'helm:dec-score',
          metadata: expect.objectContaining({
            requestAuditEventId: 'request-audit-1',
            requestEvidenceItemId: 'request-evidence-1',
            requestReplayRef: 'opportunity:ws-1:opp-1:score-requested',
          }),
        }),
      );
      expect(mockDb._updates.at(-1)).toMatchObject({
        table: 'auditLog',
        value: {
          metadata: expect.objectContaining({
            evidenceItemId: 'evidence-item-1',
          }),
        },
      });
    });

    it('does not persist heuristic scores when a configured LLM fails', async () => {
      let selectCount = 0;
      mockDb.select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({
              then: (r: any) => {
                selectCount++;
                if (selectCount === 1)
                  return r([
                    {
                      id: 'opp-1',
                      title: 'Test Opp',
                      description: 'A test opportunity',
                      source: 'hn',
                      workspaceId: 'ws-1',
                    },
                  ]);
                return r([]);
              },
            })),
          })),
        })),
      }));

      const mockLlm = {
        complete: vi.fn(),
        completeWithUsage: vi.fn(async () => {
          throw new Error('HELM unreachable');
        }),
      } as any;

      registerJobHandlers(mockBoss, { db: mockDb, llm: mockLlm });
      const handler = handlers.get('opportunity.score')!;

      await expect(handler([{ data: { opportunityId: 'opp-1' } }])).rejects.toThrow(
        'HELM unreachable',
      );
      expect(mockDb.insert).not.toHaveBeenCalledWith('opportunityScores');
      expect(appendEvidenceItem).not.toHaveBeenCalled();
    });

    it('fails closed in production when no governed LLM provider is configured', async () => {
      process.env['NODE_ENV'] = 'production';
      process.env['HELM_FAIL_CLOSED'] = '1';

      let selectCount = 0;
      mockDb.select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({
              then: (r: any) => {
                selectCount++;
                if (selectCount === 1)
                  return r([
                    {
                      id: 'opp-1',
                      title: 'Production Opp',
                      description: 'A production opportunity',
                      source: 'hn',
                      workspaceId: 'ws-1',
                    },
                  ]);
                return r([]);
              },
            })),
          })),
        })),
      }));

      registerJobHandlers(mockBoss, { db: mockDb });
      const handler = handlers.get('opportunity.score')!;

      await expect(handler([{ data: { opportunityId: 'opp-1' } }])).rejects.toThrow(
        'LLM provider is required for production opportunity scoring',
      );
      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalledWith('opportunityScores');
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(appendEvidenceItem).not.toHaveBeenCalled();
    });

    it('fails closed in production when LLM scoring lacks HELM governance metadata', async () => {
      process.env['NODE_ENV'] = 'production';
      process.env['HELM_FAIL_CLOSED'] = '1';

      let selectCount = 0;
      mockDb.select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({
              then: (r: any) => {
                selectCount++;
                if (selectCount === 1)
                  return r([
                    {
                      id: 'opp-1',
                      title: 'Production Opp',
                      description: 'A production opportunity',
                      source: 'hn',
                      workspaceId: 'ws-1',
                    },
                  ]);
                return r([]);
              },
            })),
          })),
        })),
      }));

      const mockLlm = {
        complete: vi.fn(),
        completeWithUsage: vi.fn(async () => ({
          content:
            '{"overall":80,"founderFit":70,"marketSignal":75,"timing":60,"feasibility":85,"rationale":"ok"}',
          usage: { tokensIn: 100, tokensOut: 50, model: 'test' },
        })),
      } as any;

      registerJobHandlers(mockBoss, { db: mockDb, llm: mockLlm });
      const handler = handlers.get('opportunity.score')!;

      await expect(handler([{ data: { opportunityId: 'opp-1' } }])).rejects.toThrow(
        'Production opportunity scoring requires HELM-governed model metadata',
      );
      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockDb.insert).not.toHaveBeenCalledWith('opportunityScores');
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(appendEvidenceItem).not.toHaveBeenCalled();
    });

    it('persists opportunity score state and evidence in a single transaction', async () => {
      vi.mocked(appendEvidenceItem).mockRejectedValueOnce(new Error('evidence persistence failed'));

      let selectCount = 0;
      mockDb.select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({
              then: (r: any) => {
                selectCount++;
                if (selectCount === 1)
                  return r([
                    {
                      id: 'opp-1',
                      title: 'Test Opp',
                      description: 'A test opportunity',
                      source: 'hn',
                      workspaceId: 'ws-1',
                    },
                  ]);
                return r([]);
              },
            })),
          })),
        })),
      }));

      const txInsert = vi.fn(() => ({
        values: vi.fn(() => Promise.resolve([])),
      }));
      const txUpdate = vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve()),
        })),
      }));
      const txDb = { insert: txInsert, update: txUpdate };
      mockDb.transaction = vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(txDb));

      const mockLlm = {
        complete: vi.fn(),
        completeWithUsage: vi.fn(async () => ({
          content:
            '{"overall":80,"founderFit":70,"marketSignal":75,"timing":60,"feasibility":85,"rationale":"ok"}',
          usage: { tokensIn: 100, tokensOut: 50, model: 'test' },
          governance: {
            decisionId: 'dec-score',
            verdict: 'ALLOW',
            policyVersion: 'founder-ops-v1',
            principal: 'workspace:ws-1/operator:scoring',
          },
        })),
      } as any;

      registerJobHandlers(mockBoss, { db: mockDb, llm: mockLlm });
      const handler = handlers.get('opportunity.score')!;

      await expect(handler([{ data: { opportunityId: 'opp-1' } }])).rejects.toThrow(
        'evidence persistence failed',
      );
      expect(mockDb.transaction).toHaveBeenCalledOnce();
      expect(txInsert).toHaveBeenCalledWith('opportunityScores');
      expect(txInsert).toHaveBeenCalledWith('auditLog');
      expect(txUpdate).toHaveBeenCalledWith('opportunities');
      expect(mockDb.insert).not.toHaveBeenCalled();
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  describe('knowledge.recompile', () => {
    it('calls memory.recompileTruth', async () => {
      const mockMemory = { recompileTruth: vi.fn(async () => {}) } as any;

      registerJobHandlers(mockBoss, { db: mockDb, memory: mockMemory });
      const handler = handlers.get('knowledge.recompile')!;

      await handler([{ data: { pageId: 'page-1' } }]);

      expect(mockMemory.recompileTruth).toHaveBeenCalledWith('page-1');
    });

    it('skips when memory not available', async () => {
      registerJobHandlers(mockBoss, { db: mockDb });
      const handler = handlers.get('knowledge.recompile')!;

      // Should not throw
      await expect(handler([{ data: { pageId: 'page-1' } }])).resolves.toBeUndefined();
    });
  });

  describe('task.resume', () => {
    it('calls orchestrator.resumeTask', async () => {
      const mockOrchestrator = {
        resumeTask: vi.fn(async () => ({
          status: 'completed',
          iterationsUsed: 1,
          iterationBudget: 50,
          actions: [],
        })),
      } as any;
      let selectCount = 0;
      mockDb.select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => {
              selectCount++;
              return selectCount === 1 ? [{ id: 'task-1' }] : [];
            }),
            orderBy: vi.fn(async () => []),
          })),
        })),
      }));

      registerJobHandlers(mockBoss, { db: mockDb, orchestrator: mockOrchestrator });
      const handler = handlers.get('task.resume')!;

      await handler([{ data: { taskId: 'task-1', workspaceId: 'ws-1', context: 'test' } }]);

      expect(mockOrchestrator.resumeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          workspaceId: 'ws-1',
          context: 'test',
          priorActions: [],
        }),
      );
    });

    it('skips when orchestrator not available', async () => {
      registerJobHandlers(mockBoss, { db: mockDb });
      const handler = handlers.get('task.resume')!;

      // Should not throw
      await expect(
        handler([{ data: { taskId: 'task-1', workspaceId: 'ws-1', context: 'test' } }]),
      ).resolves.toBeUndefined();
    });
  });

  describe('pipeline evidence', () => {
    it('indexes successful workspace pipeline jobs as redacted evidence', async () => {
      const pipelineRunner = vi.fn(async (name: string, extraArgs: string[]) => ({
        scriptPath: `pipelines/${name}.py`,
        args: [`/repo/pipelines/${name}.py`, ...extraArgs],
        stdoutPreview: 'completed',
        stderrPreview: null,
      }));

      registerJobHandlers(mockBoss, { db: mockDb, pipelineRunner });
      const handler = handlers.get('pipeline.yc-scrape')!;

      await handler([
        {
          id: 'job-1',
          data: {
            workspaceId: 'ws-1',
            replayPath: '/tmp/raw-captures/private.html',
            batch: 'W24',
            limit: 3,
            auditEventId: 'request-audit-1',
            evidenceItemId: 'request-evidence-1',
            replayRef: 'yc-ingestion:ws-1:public:request-1',
          },
        },
      ]);

      expect(pipelineRunner).toHaveBeenCalledWith('pipeline.yc-scrape', [
        '--replay',
        '/tmp/raw-captures/private.html',
        '--batch',
        'W24',
        '--limit',
        '3',
        '--workspace-id',
        'ws-1',
      ]);
      expect(mockDb._inserts).toHaveLength(1);
      expect(mockDb._inserts[0]).toMatchObject({
        table: 'auditLog',
        value: {
          workspaceId: 'ws-1',
          action: 'PIPELINE_JOB_SUCCEEDED',
          actor: 'job:pipeline.yc-scrape',
          target: 'job-1',
          verdict: 'allow',
        },
      });
      expect(appendEvidenceItem).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          workspaceId: 'ws-1',
          auditEventId: mockDb._inserts[0].value.id,
          evidenceType: 'pipeline_job_succeeded',
          sourceType: 'pipeline_worker',
          redactionState: 'redacted',
          sensitivity: 'internal',
          replayRef: 'pipeline:pipeline.yc-scrape:job-1:pipeline_job_succeeded',
        }),
      );
      const metadata = vi.mocked(appendEvidenceItem).mock.calls[0]?.[1].metadata;
      expect(metadata).toMatchObject({
        pipeline: 'pipeline.yc-scrape',
        jobId: 'job-1',
        status: 'pipeline_job_succeeded',
        requestAuditEventId: 'request-audit-1',
        requestEvidenceItemId: 'request-evidence-1',
        requestReplayRef: 'yc-ingestion:ws-1:public:request-1',
        credentialBoundary: 'no_raw_credentials_or_session_payloads_in_evidence',
      });
      expect(JSON.stringify(metadata)).not.toContain('/tmp/raw-captures/private.html');
      expect(mockDb._updates[0]).toMatchObject({
        table: 'auditLog',
        value: {
          metadata: expect.objectContaining({
            evidenceItemId: 'evidence-item-1',
            replayRef: 'pipeline:pipeline.yc-scrape:job-1:pipeline_job_succeeded',
          }),
        },
      });
    });

    it('indexes failed workspace pipeline jobs before rethrowing', async () => {
      const pipelineRunner = vi.fn(async () => {
        throw new Error('network denied for grant-secret-id token=abc');
      });

      registerJobHandlers(mockBoss, { db: mockDb, pipelineRunner });
      const handler = handlers.get('pipeline.yc-private')!;

      await expect(
        handler([
          {
            id: 'job-2',
            data: {
              workspaceId: 'ws-2',
              grantId: 'grant-secret-id',
              action: 'sync',
              limit: 2,
              auditEventId: 'request-audit-2',
              evidenceItemId: 'request-evidence-2',
              replayRef: 'yc-ingestion:ws-2:private:request-2',
            },
          },
        ]),
      ).rejects.toThrow('network denied');

      expect(mockDb._inserts[0]).toMatchObject({
        table: 'auditLog',
        value: {
          workspaceId: 'ws-2',
          action: 'PIPELINE_JOB_FAILED',
          actor: 'job:pipeline.yc-private',
          target: 'job-2',
          verdict: 'error',
        },
      });
      expect(appendEvidenceItem).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          workspaceId: 'ws-2',
          auditEventId: mockDb._inserts[0].value.id,
          evidenceType: 'pipeline_job_failed',
          sourceType: 'pipeline_worker',
          redactionState: 'redacted',
          sensitivity: 'sensitive',
          replayRef: 'pipeline:pipeline.yc-private:job-2:pipeline_job_failed',
        }),
      );
      const metadata = vi.mocked(appendEvidenceItem).mock.calls[0]?.[1].metadata;
      expect(metadata).toMatchObject({
        pipeline: 'pipeline.yc-private',
        jobId: 'job-2',
        status: 'pipeline_job_failed',
        requestAuditEventId: 'request-audit-2',
        requestEvidenceItemId: 'request-evidence-2',
        requestReplayRef: 'yc-ingestion:ws-2:private:request-2',
        error: {
          name: 'Error',
          redactedPreview: 'network denied for grant-[redacted] token=[redacted]',
        },
      });
      expect(JSON.stringify(metadata)).not.toContain('grant-secret-id');
      expect(JSON.stringify(metadata)).not.toContain('token=abc');
    });

    it('runs scheduled public ingestion once per workspace so evidence is never workspace-less', async () => {
      const pipelineRunner = vi.fn(async (name: string, extraArgs: string[]) => ({
        scriptPath: `pipelines/${name}.py`,
        args: [`/repo/pipelines/${name}.py`, ...extraArgs],
        stdoutPreview: 'completed',
        stderrPreview: null,
      }));
      mockDb.select = vi.fn(() => ({
        from: vi.fn(async () => [{ id: 'ws-1' }, { id: 'ws-2' }]),
      }));

      registerJobHandlers(mockBoss, { db: mockDb, pipelineRunner });
      const handler = handlers.get('pipeline.yc-scrape')!;

      await handler([{ id: 'job-cron', data: { batch: 'W24', limit: 2 } }]);

      expect(pipelineRunner).toHaveBeenCalledTimes(2);
      expect(pipelineRunner).toHaveBeenNthCalledWith(1, 'pipeline.yc-scrape', [
        '--batch',
        'W24',
        '--limit',
        '2',
        '--workspace-id',
        'ws-1',
      ]);
      expect(pipelineRunner).toHaveBeenNthCalledWith(2, 'pipeline.yc-scrape', [
        '--batch',
        'W24',
        '--limit',
        '2',
        '--workspace-id',
        'ws-2',
      ]);
      expect(appendEvidenceItem).toHaveBeenCalledTimes(2);
      expect(mockDb._inserts).toHaveLength(2);
      expect(mockDb._inserts.map((insert: any) => insert.value.workspaceId)).toEqual([
        'ws-1',
        'ws-2',
      ]);
      expect(mockDb._inserts.map((insert: any) => insert.value.action)).toEqual([
        'PIPELINE_JOB_SUCCEEDED',
        'PIPELINE_JOB_SUCCEEDED',
      ]);
      expect(vi.mocked(appendEvidenceItem).mock.calls.map((call) => call[1].workspaceId)).toEqual([
        'ws-1',
        'ws-2',
      ]);
      expect(vi.mocked(appendEvidenceItem).mock.calls.map((call) => call[1].replayRef)).toEqual([
        'pipeline:pipeline.yc-scrape:job-cron:pipeline_job_succeeded',
        'pipeline:pipeline.yc-scrape:job-cron:pipeline_job_succeeded',
      ]);
    });

    it('does not create pipeline evidence without a workspace scope', async () => {
      const pipelineRunner = vi.fn(async (name: string, extraArgs: string[]) => ({
        scriptPath: `pipelines/${name}.py`,
        args: [`/repo/pipelines/${name}.py`, ...extraArgs],
        stdoutPreview: 'completed',
        stderrPreview: null,
      }));

      registerJobHandlers(mockBoss, { db: mockDb, pipelineRunner });
      const handler = handlers.get('pipeline.ingest-knowledge')!;

      await handler([{ id: 'job-3', data: {} }]);

      expect(pipelineRunner).toHaveBeenCalledWith('pipeline.ingest-knowledge', []);
      expect(appendEvidenceItem).not.toHaveBeenCalled();
      expect(mockDb._inserts).toEqual([]);
    });
  });
});
