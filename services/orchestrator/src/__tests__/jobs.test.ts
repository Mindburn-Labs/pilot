import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { appendEvidenceItem, appendTenantDeletionReceipt } from '@pilot/db';
import { auditLog, tasks, taskRuns } from '@pilot/db/schema';
import { registerJobHandlers } from '../jobs.js';

vi.mock('@pilot/db', () => ({
  appendEvidenceItem: vi.fn(async () => 'evidence-item-1'),
  appendTenantDeletionReceipt: vi.fn(async () => 'tenant-delete-receipt-1'),
}));

vi.mock('@pilot/db/schema', () => ({
  auditLog: 'auditLog',
  opportunities: 'opportunities',
  opportunityScores: 'opportunityScores',
  pages: {
    id: 'pages.id',
    workspaceId: 'pages.workspaceId',
    type: 'pages.type',
    title: 'pages.title',
  },
  policyViolations: 'policyViolations',
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
  const deletes: Array<{ table: unknown }> = [];
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
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(() => {
        deletes.push({ table });
        return Promise.resolve();
      }),
    })),
    transaction: vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(db)),
    _inserts: inserts,
    _updates: updates,
    _deletes: deletes,
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
    expect(registeredNames).toContain('tasks.reap_stuck');
    expect(registeredNames).toContain('pipeline.yc-scrape');
    expect(registeredNames).toContain('pipeline.ingest-knowledge');
    expect(registeredNames).toContain('tenant.hard-delete-sweep');

    // Schedule called for yc-scrape
    expect(mockBoss.schedule).toHaveBeenCalledWith(
      'pipeline.yc-scrape',
      expect.any(String),
      expect.anything(),
      expect.anything(),
    );
  });

  describe('tenant.hard-delete-sweep', () => {
    const pendingDeletion = {
      id: '00000000-0000-4000-8000-000000000201',
      workspaceId: '00000000-0000-4000-8000-000000000101',
      reason: 'expired test tenant',
      softDeletedAt: new Date('2026-05-01T00:00:00Z'),
      hardDeleteAfter: new Date('2026-05-02T00:00:00Z'),
    };

    function mockPendingTenantDeletion() {
      mockDb.select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => ({
              then: (resolve: (value: unknown[]) => void) => resolve([pendingDeletion]),
            })),
          })),
        })),
      }));
    }

    it('persists retained receipts before deleting tenant rows', async () => {
      mockPendingTenantDeletion();
      registerJobHandlers(mockBoss, { db: mockDb });
      const handler = handlers.get('tenant.hard-delete-sweep')!;

      await handler([{ id: 'hard-delete-job-1', data: { limit: 1 } }]);

      expect(appendTenantDeletionReceipt).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          workspaceId: pendingDeletion.workspaceId,
          deletionId: pendingDeletion.id,
          source: 'orchestrator_job',
          actor: 'job:tenant.hard-delete-sweep',
          reason: pendingDeletion.reason,
          replayRef: `tenant-hard-delete:${pendingDeletion.workspaceId}:${pendingDeletion.id}:scheduled-job`,
          metadata: expect.objectContaining({
            trigger: 'scheduled_pg_boss_cleanup',
            jobId: 'hard-delete-job-1',
            retainedAfterWorkspaceDelete: true,
            workspaceScopedLedgerRowsDeleted: true,
          }),
        }),
      );
      expect(mockDb._deletes.map((entry: { table: unknown }) => entry.table)).toEqual([
        auditLog,
        'policyViolations',
        'opportunities',
        { id: 'workspaces.id' },
      ]);
    });

    it('does not delete tenant rows when retained receipt persistence fails', async () => {
      mockPendingTenantDeletion();
      vi.mocked(appendTenantDeletionReceipt).mockRejectedValueOnce(
        new Error('receipt unavailable'),
      );
      registerJobHandlers(mockBoss, { db: mockDb });
      const handler = handlers.get('tenant.hard-delete-sweep')!;

      await expect(handler([{ id: 'hard-delete-job-1', data: { limit: 1 } }])).rejects.toThrow(
        'receipt unavailable',
      );

      expect(mockDb._deletes).toEqual([]);
    });
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
    it('persists workspace-scoped dispatch evidence before recompiling truth', async () => {
      vi.mocked(appendEvidenceItem).mockClear();
      const mockMemory = { recompileTruth: vi.fn(async () => {}) } as any;
      mockDb.select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => [
              {
                id: 'page-1',
                workspaceId: 'ws-1',
                type: 'source',
                title: 'YC batch notes',
              },
            ]),
          })),
        })),
      }));

      registerJobHandlers(mockBoss, { db: mockDb, memory: mockMemory });
      const handler = handlers.get('knowledge.recompile')!;

      await handler([
        {
          id: 'recompile-job-1',
          data: {
            pageId: 'page-1',
            workspaceId: 'ws-1',
            auditEventId: 'request-audit-1',
            evidenceItemId: 'request-evidence-1',
            replayRef: 'knowledge:ws-1:page:page-1:requested',
          },
        },
      ]);

      expect(mockMemory.recompileTruth).toHaveBeenCalledWith('page-1', 'ws-1');
      expect(mockDb.transaction).toHaveBeenCalledOnce();
      const auditInsert = mockDb._inserts
        .map((entry: any) => entry.value)
        .find((value: any) => value?.action === 'KNOWLEDGE_RECOMPILE_DISPATCHED');
      expect(auditInsert).toMatchObject({
        workspaceId: 'ws-1',
        action: 'KNOWLEDGE_RECOMPILE_DISPATCHED',
        actor: 'job:knowledge.recompile',
        target: 'page-1',
        verdict: 'allow',
        metadata: expect.objectContaining({
          pageId: 'page-1',
          pageType: 'source',
          pageTitle: 'YC batch notes',
          jobId: 'recompile-job-1',
          requestAuditEventId: 'request-audit-1',
          requestEvidenceItemId: 'request-evidence-1',
          requestReplayRef: 'knowledge:ws-1:page:page-1:requested',
          evidenceContract: 'knowledge_recompile_dispatch_before_memory_mutation',
          evidenceItemId: null,
        }),
      });
      expect(appendEvidenceItem).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          workspaceId: 'ws-1',
          auditEventId: auditInsert.id,
          evidenceType: 'knowledge_recompile_dispatched',
          sourceType: 'knowledge_recompile_worker',
          replayRef: 'knowledge:ws-1:page:page-1:requested',
          metadata: expect.objectContaining({
            credentialBoundary: 'no_raw_credentials_or_session_payloads_in_evidence',
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
      expect(vi.mocked(appendEvidenceItem).mock.invocationCallOrder[0]).toBeLessThan(
        mockMemory.recompileTruth.mock.invocationCallOrder[0],
      );
    });

    it('fails closed before recompilation without workspace scope', async () => {
      const mockMemory = { recompileTruth: vi.fn(async () => {}) } as any;

      registerJobHandlers(mockBoss, { db: mockDb, memory: mockMemory });
      const handler = handlers.get('knowledge.recompile')!;

      await expect(handler([{ data: { pageId: 'page-1' } }])).rejects.toThrow(
        'knowledge.recompile requires workspaceId for durable evidence',
      );

      expect(mockDb.select).not.toHaveBeenCalled();
      expect(appendEvidenceItem).not.toHaveBeenCalled();
      expect(mockMemory.recompileTruth).not.toHaveBeenCalled();
    });

    it('rejects cross-workspace page recompilation before memory mutation', async () => {
      const mockMemory = { recompileTruth: vi.fn(async () => {}) } as any;
      mockDb.select = vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => []),
          })),
        })),
      }));

      registerJobHandlers(mockBoss, { db: mockDb, memory: mockMemory });
      const handler = handlers.get('knowledge.recompile')!;

      await expect(
        handler([{ data: { pageId: 'page-foreign', workspaceId: 'ws-1' } }]),
      ).rejects.toThrow('knowledge.recompile page not found in workspace');

      expect(appendEvidenceItem).not.toHaveBeenCalled();
      expect(mockMemory.recompileTruth).not.toHaveBeenCalled();
    });

    it('skips when memory not available', async () => {
      registerJobHandlers(mockBoss, { db: mockDb });
      const handler = handlers.get('knowledge.recompile')!;

      // Should not throw
      await expect(handler([{ data: { pageId: 'page-1' } }])).resolves.toBeUndefined();
    });
  });

  describe('task.resume', () => {
    it('persists resume dispatch evidence before calling orchestrator.resumeTask', async () => {
      vi.mocked(appendEvidenceItem).mockResolvedValueOnce('evidence-resume-1');
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

      const auditInsert = mockDb._inserts
        .map((entry: any) => entry.value)
        .find((value: any) => value?.action === 'TASK_RESUME_DISPATCHED');
      expect(auditInsert).toMatchObject({
        workspaceId: 'ws-1',
        action: 'TASK_RESUME_DISPATCHED',
        actor: 'job:task.resume',
        target: 'task-1',
        verdict: 'allow',
        metadata: expect.objectContaining({
          taskId: 'task-1',
          priorActionCount: 0,
          contextHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          evidenceContract: 'task_resume_dispatch_before_orchestrator_resume',
          evidenceItemId: null,
        }),
      });
      expect(appendEvidenceItem).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          workspaceId: 'ws-1',
          auditEventId: auditInsert.id,
          evidenceType: 'task_resume_dispatched',
          sourceType: 'task_resume_worker',
          metadata: expect.objectContaining({
            credentialBoundary: 'no_raw_credentials_or_session_payloads_in_evidence',
          }),
        }),
      );
      expect(mockDb._updates.at(-1)).toMatchObject({
        table: 'auditLog',
        value: {
          metadata: expect.objectContaining({
            evidenceItemId: 'evidence-resume-1',
          }),
        },
      });
      expect(vi.mocked(appendEvidenceItem).mock.invocationCallOrder[0]).toBeLessThan(
        mockOrchestrator.resumeTask.mock.invocationCallOrder[0],
      );
      expect(mockOrchestrator.resumeTask).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          workspaceId: 'ws-1',
          context: 'test',
          priorActions: [],
        }),
      );
    });

    it('fails closed before resume when resume dispatch evidence cannot be persisted', async () => {
      vi.mocked(appendEvidenceItem).mockRejectedValueOnce(new Error('resume evidence unavailable'));
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

      await expect(
        handler([{ data: { taskId: 'task-1', workspaceId: 'ws-1', context: 'test' } }]),
      ).rejects.toThrow('resume evidence unavailable');

      expect(mockDb.transaction).toHaveBeenCalledOnce();
      expect(mockOrchestrator.resumeTask).not.toHaveBeenCalled();
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

  describe('tasks.reap_stuck', () => {
    it('records reaped tasks with audit-linked evidence in one transaction', async () => {
      vi.mocked(appendEvidenceItem).mockResolvedValueOnce('evidence-item-reaper');
      const inserts: Array<{ table: unknown; value: Record<string, unknown> }> = [];
      const updates: Array<{ table: unknown; value: unknown }> = [];
      const txDb = {
        update: vi.fn((table: unknown) => {
          if (table === tasks) {
            return {
              set: vi.fn((value: unknown) => ({
                where: vi.fn(() => ({
                  returning: vi.fn(async () => {
                    updates.push({ table, value });
                    return [{ id: 'task-1', workspaceId: 'ws-1' }];
                  }),
                })),
              })),
            };
          }
          if (table === auditLog) {
            return {
              set: vi.fn((value: unknown) => ({
                where: vi.fn(async () => {
                  updates.push({ table, value });
                }),
              })),
            };
          }
          throw new Error('unexpected update table');
        }),
        insert: vi.fn((table: unknown) => ({
          values: vi.fn((value: Record<string, unknown>) => {
            inserts.push({ table, value });
            return Promise.resolve([]);
          }),
        })),
      };
      mockDb.transaction = vi.fn(async (callback: (tx: any) => Promise<unknown>) => callback(txDb));

      registerJobHandlers(mockBoss, { db: mockDb });
      const handler = handlers.get('tasks.reap_stuck')!;

      await handler([{ id: 'job-reap-1', data: {} }]);

      expect(mockDb.transaction).toHaveBeenCalledOnce();
      const runInsert = inserts.find((insert) => insert.table === taskRuns);
      expect(runInsert?.value).toMatchObject({
        taskId: 'task-1',
        status: 'failed',
        actionTool: 'system.tasks.reap_stuck',
        verdict: 'reaped',
      });
      const auditInsert = inserts.find((insert) => insert.table === auditLog);
      expect(auditInsert?.value).toMatchObject({
        workspaceId: 'ws-1',
        action: 'TASK_REAPED_STUCK',
        actor: 'job:tasks.reap_stuck',
        target: 'task-1',
        verdict: 'allow',
      });
      expect(appendEvidenceItem).toHaveBeenCalledWith(
        txDb,
        expect.objectContaining({
          workspaceId: 'ws-1',
          taskRunId: runInsert?.value.id,
          auditEventId: auditInsert?.value.id,
          evidenceType: 'task_reaped_stuck',
          sourceType: 'task_reaper',
          redactionState: 'redacted',
          sensitivity: 'internal',
        }),
      );
      expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
        metadata: expect.objectContaining({
          evidenceItemId: 'evidence-item-reaper',
        }),
      });
    });

    it('does not commit reaped task state when reaper evidence persistence fails', async () => {
      vi.mocked(appendEvidenceItem).mockRejectedValueOnce(new Error('reaper evidence unavailable'));
      const committedMutations: Array<{ table: unknown; value: unknown }> = [];
      mockDb.transaction = vi.fn(async (callback: (tx: any) => Promise<unknown>) => {
        const stagedMutations: Array<{ table: unknown; value: unknown }> = [];
        const txDb = {
          update: vi.fn((table: unknown) => {
            if (table === tasks) {
              return {
                set: vi.fn((value: unknown) => ({
                  where: vi.fn(() => ({
                    returning: vi.fn(async () => {
                      stagedMutations.push({ table, value });
                      return [{ id: 'task-1', workspaceId: 'ws-1' }];
                    }),
                  })),
                })),
              };
            }
            return {
              set: vi.fn((value: unknown) => ({
                where: vi.fn(async () => {
                  stagedMutations.push({ table, value });
                }),
              })),
            };
          }),
          insert: vi.fn((table: unknown) => ({
            values: vi.fn((value: unknown) => {
              stagedMutations.push({ table, value });
              return Promise.resolve([]);
            }),
          })),
        };
        const result = await callback(txDb);
        committedMutations.push(...stagedMutations);
        return result;
      });

      registerJobHandlers(mockBoss, { db: mockDb });
      const handler = handlers.get('tasks.reap_stuck')!;

      await expect(handler([{ id: 'job-reap-1', data: {} }])).rejects.toThrow(
        'reaper evidence unavailable',
      );
      expect(mockDb.transaction).toHaveBeenCalledOnce();
      expect(committedMutations).toEqual([]);
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

    it('passes workspace scope into knowledge ingestion before indexing evidence', async () => {
      const pipelineRunner = vi.fn(async (name: string, extraArgs: string[]) => ({
        scriptPath: `pipelines/${name}.py`,
        args: [`/repo/pipelines/${name}.py`, ...extraArgs],
        stdoutPreview: 'completed',
        stderrPreview: null,
      }));

      registerJobHandlers(mockBoss, { db: mockDb, pipelineRunner });
      const handler = handlers.get('pipeline.ingest-knowledge')!;

      await handler([
        {
          id: 'job-3',
          data: {
            workspaceId: 'ws-3',
            auditEventId: 'request-audit-3',
            evidenceItemId: 'request-evidence-3',
            replayRef: 'knowledge-ingestion:ws-3:request',
          },
        },
      ]);

      expect(pipelineRunner).toHaveBeenCalledWith('pipeline.ingest-knowledge', [
        '--workspace-id',
        'ws-3',
      ]);
      expect(mockDb._inserts[0]).toMatchObject({
        table: 'auditLog',
        value: {
          workspaceId: 'ws-3',
          action: 'PIPELINE_JOB_SUCCEEDED',
          actor: 'job:pipeline.ingest-knowledge',
          target: 'job-3',
        },
      });
      expect(appendEvidenceItem).toHaveBeenCalledWith(
        mockDb,
        expect.objectContaining({
          workspaceId: 'ws-3',
          evidenceType: 'pipeline_job_succeeded',
          sourceType: 'pipeline_worker',
          replayRef: 'pipeline:pipeline.ingest-knowledge:job-3:pipeline_job_succeeded',
        }),
      );
      const metadata = vi.mocked(appendEvidenceItem).mock.calls[0]?.[1].metadata;
      expect(metadata).toMatchObject({
        pipeline: 'pipeline.ingest-knowledge',
        requestAuditEventId: 'request-audit-3',
        requestEvidenceItemId: 'request-evidence-3',
        requestReplayRef: 'knowledge-ingestion:ws-3:request',
      });
    });

    it('fails closed before knowledge ingestion without a workspace scope', async () => {
      const pipelineRunner = vi.fn(async (name: string, extraArgs: string[]) => ({
        scriptPath: `pipelines/${name}.py`,
        args: [`/repo/pipelines/${name}.py`, ...extraArgs],
        stdoutPreview: 'completed',
        stderrPreview: null,
      }));

      registerJobHandlers(mockBoss, { db: mockDb, pipelineRunner });
      const handler = handlers.get('pipeline.ingest-knowledge')!;

      await expect(handler([{ id: 'job-3', data: {} }])).rejects.toThrow(
        'pipeline.ingest-knowledge requires workspaceId',
      );

      expect(pipelineRunner).not.toHaveBeenCalled();
      expect(appendEvidenceItem).not.toHaveBeenCalled();
      expect(mockDb._inserts).toEqual([]);
    });

    it('fails closed before private session ingestion without workspace-scoped evidence', async () => {
      const pipelineRunner = vi.fn(async (name: string, extraArgs: string[]) => ({
        scriptPath: `pipelines/${name}.py`,
        args: [`/repo/pipelines/${name}.py`, ...extraArgs],
        stdoutPreview: 'completed',
        stderrPreview: null,
      }));

      registerJobHandlers(mockBoss, { db: mockDb, pipelineRunner });
      const handler = handlers.get('pipeline.yc-private')!;

      await expect(
        handler([{ id: 'job-private-no-workspace', data: { grantId: 'grant-secret-id' } }]),
      ).rejects.toThrow('pipeline.yc-private requires workspaceId for durable pipeline evidence');

      expect(pipelineRunner).not.toHaveBeenCalled();
      expect(appendEvidenceItem).not.toHaveBeenCalled();
      expect(mockDb._inserts).toEqual([]);
    });
  });
});
