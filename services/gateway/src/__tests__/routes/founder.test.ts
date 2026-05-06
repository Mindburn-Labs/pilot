import { describe, it, expect, vi, beforeEach } from 'vitest';
import { auditLog, cofounderCandidates, evidenceItems } from '@pilot/db/schema';
import { founderRoutes } from '../../routes/founder.js';
import { testApp, expectJson, createMockDeps } from '../helpers.js';

function createCandidateStatusDb(
  workspaceId: string,
  options: { failEvidence?: boolean; existingCandidate?: Record<string, unknown> | null } = {},
) {
  const existingCandidate =
    'existingCandidate' in options
      ? options.existingCandidate
      : {
          id: 'cand-1',
          workspaceId,
          name: 'Candidate One',
          status: 'reviewing',
          createdAt: new Date('2026-01-01'),
          updatedAt: new Date('2026-01-01'),
        };
  const inserts: Array<{ table: unknown; value: unknown }> = [];
  const updates: Array<{ table: unknown; value: unknown }> = [];

  const createDbFacade = (
    insertSink: Array<{ table: unknown; value: unknown }>,
    updateSink: Array<{ table: unknown; value: unknown }>,
  ) => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => (existingCandidate ? [existingCandidate] : [])),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertSink.push({ table, value });
        return {
          returning: vi.fn(async () => {
            if (table === evidenceItems) {
              if (options.failEvidence) throw new Error('evidence unavailable');
              return [{ id: 'evidence-candidate-status-1' }];
            }
            return [];
          }),
          then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
            Promise.resolve([]).then(resolve, reject),
          catch: (reject: (reason: unknown) => void) => Promise.resolve([]).catch(reject),
        };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((value: Record<string, unknown>) => {
        updateSink.push({ table, value });
        return {
          where: vi.fn(() => ({
            returning: vi.fn(async () => {
              if (table === cofounderCandidates && existingCandidate) {
                return [{ ...existingCandidate, ...value }];
              }
              return [];
            }),
            then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
              Promise.resolve([]).then(resolve, reject),
            catch: (reject: (reason: unknown) => void) => Promise.resolve([]).catch(reject),
          })),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async () => []),
    })),
    execute: vi.fn(async () => [{ '?column?': 1 }]),
  });

  const db = {
    ...createDbFacade(inserts, updates),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      const stagedInserts: Array<{ table: unknown; value: unknown }> = [];
      const stagedUpdates: Array<{ table: unknown; value: unknown }> = [];
      const tx = createDbFacade(stagedInserts, stagedUpdates);
      const result = await callback(tx);
      inserts.push(...stagedInserts);
      updates.push(...stagedUpdates);
      return result;
    }),
    _setResult: vi.fn(),
    _reset: vi.fn(),
  };

  return { db, inserts, updates };
}

describe('founderRoutes', () => {
  let deps: ReturnType<typeof createMockDeps>;
  let fetch: ReturnType<typeof testApp>['fetch'];
  const wsHeader = { 'X-Workspace-Id': 'ws-1' };

  beforeEach(() => {
    const t = testApp(founderRoutes);
    deps = t.deps as ReturnType<typeof createMockDeps>;
    fetch = t.fetch;
    deps.db._reset();
  });

  // ── GET /:workspaceId ──

  describe('GET /:workspaceId', () => {
    it('returns founder profile when found', async () => {
      const profile = {
        id: 'fp-1',
        workspaceId: 'ws-1',
        name: 'Jane Founder',
        background: 'Ex-Google',
        experience: '10 years',
        interests: ['AI', 'SaaS'],
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-01-01'),
      };
      deps.db._setResult([profile]);

      const res = await fetch('GET', '/ws-1', undefined, wsHeader);
      const json = await expectJson<Record<string, unknown>>(res, 200);

      expect(json.id).toBe('fp-1');
      expect(json.name).toBe('Jane Founder');
    });

    it('returns 404 when no profile exists', async () => {
      deps.db._setResult([]);

      const res = await fetch('GET', '/ws-2', undefined, wsHeader);
      const json = await expectJson<{ error: string }>(res, 403);

      expect(json.error).toBe('workspaceId does not match authenticated workspace');
    });
  });

  // ── POST /:workspaceId ──

  describe('POST /:workspaceId', () => {
    it('returns 400 on invalid body (empty name)', async () => {
      const res = await fetch(
        'POST',
        '/ws-1',
        {
          name: '',
        },
        wsHeader,
      );
      const json = await expectJson<{ error: string }>(res, 400);

      expect(json.error).toBe('Validation failed');
    });

    it('creates/upserts founder profile and returns 201', async () => {
      const profile = {
        id: 'fp-1',
        workspaceId: 'ws-1',
        name: 'Test Founder',
        background: null,
        experience: null,
        interests: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      deps.db.insert = vi.fn(() => ({
        values: vi.fn(() => ({
          onConflictDoUpdate: vi.fn(() => ({
            returning: vi.fn(async () => [profile]),
            then: (r: any) => r([profile]),
          })),
          returning: vi.fn(async () => [profile]),
          then: (r: any) => r([profile]),
        })),
      })) as any;

      const res = await fetch(
        'POST',
        '/ws-1',
        {
          name: 'Test Founder',
        },
        wsHeader,
      );
      const json = await expectJson<Record<string, unknown>>(res, 201);

      expect(json.id).toBe('fp-1');
      expect(json.name).toBe('Test Founder');
    });
  });

  // ── POST /:founderId/assessment ──

  describe('POST /:founderId/assessment', () => {
    it('returns 400 when required fields are missing', async () => {
      const res = await fetch(
        'POST',
        '/fp-1/assessment',
        {
          assessmentType: 'personality',
          // missing responses
        },
        wsHeader,
      );
      const json = await expectJson<{ error: string }>(res, 400);

      expect(json.error).toBe('assessmentType and responses are required');
    });

    it('creates assessment and returns 201', async () => {
      const assessment = {
        id: 'fa-1',
        founderId: 'fp-1',
        assessmentType: 'personality',
        responses: { q1: 'a1', q2: 'a2' },
        analysis: null,
        createdAt: new Date(),
      };

      deps.db.insert = vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(async () => [assessment]),
          then: (r: any) => r([assessment]),
        })),
      })) as any;
      const origSelect = deps.db.select;
      deps.db.select = vi.fn(() => {
        deps.db._setResult([{ id: 'fp-1' }]);
        return origSelect();
      }) as any;

      const res = await fetch(
        'POST',
        '/fp-1/assessment',
        {
          assessmentType: 'personality',
          responses: { q1: 'a1', q2: 'a2' },
        },
        wsHeader,
      );
      const json = await expectJson<Record<string, unknown>>(res, 201);

      expect(json.id).toBe('fa-1');
      expect(json.assessmentType).toBe('personality');
    });
  });

  describe('PUT /candidates/:id/status', () => {
    it('denies members from mutating candidate status', async () => {
      const res = await fetch(
        'PUT',
        '/candidates/cand-1/status',
        { status: 'shortlisted' },
        { ...wsHeader, 'X-Workspace-Role': 'member' },
      );
      const json = await expectJson<{ error: string; requiredRole: string }>(res, 403);

      expect(json.error).toBe('insufficient workspace role');
      expect(json.requiredRole).toBe('partner');
      expect(deps.db.update).not.toHaveBeenCalled();
    });

    it('returns 404 when the candidate is outside the workspace', async () => {
      const { db } = createCandidateStatusDb('ws-1', { existingCandidate: null });
      const scoped = testApp(founderRoutes, createMockDeps({ db: db as never }));

      const res = await scoped.fetch(
        'PUT',
        '/candidates/cand-1/status',
        { status: 'shortlisted' },
        wsHeader,
      );
      const json = await expectJson<{ error: string }>(res, 404);

      expect(json.error).toBe('Candidate not found');
    });

    it('writes audit-linked evidence on candidate status mutation', async () => {
      const { db, inserts, updates } = createCandidateStatusDb('ws-1');
      const scoped = testApp(founderRoutes, createMockDeps({ db: db as never }));

      const res = await scoped.fetch(
        'PUT',
        '/candidates/cand-1/status',
        { status: 'shortlisted' },
        wsHeader,
      );
      const json = await expectJson<Record<string, unknown>>(res, 200);

      expect(json).toMatchObject({
        id: 'cand-1',
        status: 'shortlisted',
        evidenceItemId: 'evidence-candidate-status-1',
      });
      expect(updates.map((update) => update.table)).toEqual([cofounderCandidates, auditLog]);
      expect(inserts.map((insert) => insert.table)).toEqual([auditLog, evidenceItems]);
      expect(updates.find((update) => update.table === cofounderCandidates)?.value).toMatchObject({
        status: 'shortlisted',
        updatedAt: expect.any(Date),
      });
      const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
        id: string;
      };
      expect(auditInsert).toMatchObject({
        workspaceId: 'ws-1',
        action: 'COFOUNDER_CANDIDATE_STATUS_UPDATED',
        actor: 'user:user-1',
        target: 'cand-1',
        verdict: 'allow',
        metadata: {
          evidenceType: 'cofounder_candidate_status_updated',
          replayRef: 'cofounder-candidate:ws-1:cand-1:status:reviewing->shortlisted',
          candidateId: 'cand-1',
          previousStatus: 'reviewing',
          status: 'shortlisted',
          evidenceContract: 'cofounder_candidate_status_evidence_required',
        },
      });
      expect(inserts.find((insert) => insert.table === evidenceItems)?.value).toMatchObject({
        workspaceId: 'ws-1',
        auditEventId: auditInsert.id,
        evidenceType: 'cofounder_candidate_status_updated',
        sourceType: 'gateway_founder',
        replayRef: 'cofounder-candidate:ws-1:cand-1:status:reviewing->shortlisted',
        metadata: {
          candidateId: 'cand-1',
          previousStatus: 'reviewing',
          status: 'shortlisted',
          evidenceContract: 'cofounder_candidate_status_evidence_required',
        },
      });
      expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
        metadata: {
          evidenceItemId: 'evidence-candidate-status-1',
        },
      });
    });

    it('fails closed without committing status when evidence persistence fails', async () => {
      const { db, inserts, updates } = createCandidateStatusDb('ws-1', { failEvidence: true });
      const scoped = testApp(founderRoutes, createMockDeps({ db: db as never }));

      const res = await scoped.fetch(
        'PUT',
        '/candidates/cand-1/status',
        { status: 'shortlisted' },
        wsHeader,
      );
      const json = await expectJson<{ error: string }>(res, 500);

      expect(json.error).toContain('Failed to update candidate status evidence');
      expect(inserts).toEqual([]);
      expect(updates).toEqual([]);
    });
  });

  // ── GET /:founderId/strengths ──

  describe('GET /:founderId/strengths', () => {
    it('returns founder strengths', async () => {
      const strengths = [
        {
          id: 'fs-1',
          founderId: 'fp-1',
          category: 'technical',
          strength: 'System design',
          score: 0.9,
        },
        {
          id: 'fs-2',
          founderId: 'fp-1',
          category: 'leadership',
          strength: 'Team building',
          score: 0.85,
        },
      ];
      let selectCall = 0;
      const origSelect = deps.db.select;
      deps.db.select = vi.fn(() => {
        selectCall++;
        deps.db._setResult(selectCall === 1 ? [{ id: 'fp-1' }] : strengths);
        return origSelect();
      }) as any;

      const res = await fetch('GET', '/fp-1/strengths', undefined, wsHeader);
      const json = await expectJson<unknown[]>(res, 200);

      expect(json).toHaveLength(2);
      expect(json[0]).toMatchObject({ category: 'technical' });
      expect(json[1]).toMatchObject({ category: 'leadership' });
    });
  });
});
