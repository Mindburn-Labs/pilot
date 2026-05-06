import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  auditLog,
  cofounderCandidates,
  evidenceItems,
  founderAssessments,
  founderProfiles,
} from '@pilot/db/schema';
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

function createFounderProfileDb(
  workspaceId: string,
  options: { failEvidence?: boolean; profile?: Record<string, unknown> } = {},
) {
  const profile = options.profile ?? {
    id: 'fp-1',
    workspaceId,
    name: 'Test Founder',
    background: null,
    experience: null,
    interests: [],
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
          limit: vi.fn(async () => []),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertSink.push({ table, value });
        if (table === founderProfiles) {
          return {
            onConflictDoUpdate: vi.fn(() => ({
              returning: vi.fn(async () => [profile]),
            })),
            returning: vi.fn(async () => [profile]),
            then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
              Promise.resolve([profile]).then(resolve, reject),
            catch: (reject: (reason: unknown) => void) => Promise.resolve([profile]).catch(reject),
          };
        }
        return {
          returning: vi.fn(async () => {
            if (table === evidenceItems) {
              if (options.failEvidence) throw new Error('evidence unavailable');
              return [{ id: 'evidence-founder-profile-1' }];
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
            returning: vi.fn(async () => []),
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

  return { db, inserts, updates, profile };
}

function createFounderAssessmentDb(
  workspaceId: string,
  options: {
    failEvidence?: boolean;
    existingProfile?: Record<string, unknown> | null;
    assessment?: Record<string, unknown>;
  } = {},
) {
  const existingProfile =
    'existingProfile' in options ? options.existingProfile : { id: 'fp-1', workspaceId };
  const assessment = options.assessment ?? {
    id: 'fa-1',
    founderId: 'fp-1',
    assessmentType: 'personality',
    responses: { q1: 'a1', q2: 'a2' },
    analysis: null,
    createdAt: new Date('2026-01-01'),
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
          limit: vi.fn(async () => (existingProfile ? [existingProfile] : [])),
        })),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertSink.push({ table, value });
        return {
          returning: vi.fn(async () => {
            if (table === founderAssessments) return [assessment];
            if (table === evidenceItems) {
              if (options.failEvidence) throw new Error('evidence unavailable');
              return [{ id: 'evidence-founder-assessment-1' }];
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
            returning: vi.fn(async () => []),
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

  return { db, inserts, updates, assessment };
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
    it('denies members from upserting founder profiles', async () => {
      const res = await fetch(
        'POST',
        '/ws-1',
        {
          name: 'Test Founder',
        },
        { ...wsHeader, 'X-Workspace-Role': 'member' },
      );
      const json = await expectJson<{ error: string; requiredRole: string }>(res, 403);

      expect(json.error).toBe('insufficient workspace role');
      expect(json.requiredRole).toBe('partner');
      expect(deps.db.insert).not.toHaveBeenCalled();
    });

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
      const { db, inserts, updates } = createFounderProfileDb('ws-1');
      const scoped = testApp(founderRoutes, createMockDeps({ db: db as never }));

      const res = await scoped.fetch(
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
      expect(json.evidenceItemId).toBe('evidence-founder-profile-1');
      expect(inserts.map((insert) => insert.table)).toEqual([
        founderProfiles,
        auditLog,
        evidenceItems,
      ]);
      expect(updates.map((update) => update.table)).toEqual([auditLog]);
      const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
        id: string;
      };
      expect(auditInsert).toMatchObject({
        workspaceId: 'ws-1',
        action: 'FOUNDER_PROFILE_UPSERTED',
        actor: 'user:user-1',
        target: 'fp-1',
        verdict: 'allow',
        metadata: {
          evidenceType: 'founder_profile_upserted',
          replayRef: 'founder-profile:ws-1:fp-1:upsert',
          founderProfileId: 'fp-1',
          fields: ['name', 'interests'],
          evidenceContract: 'founder_profile_evidence_required',
        },
      });
      expect(inserts.find((insert) => insert.table === evidenceItems)?.value).toMatchObject({
        workspaceId: 'ws-1',
        auditEventId: auditInsert.id,
        evidenceType: 'founder_profile_upserted',
        sourceType: 'gateway_founder',
        replayRef: 'founder-profile:ws-1:fp-1:upsert',
        metadata: {
          founderProfileId: 'fp-1',
          fields: ['name', 'interests'],
          evidenceContract: 'founder_profile_evidence_required',
        },
      });
      expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
        metadata: {
          evidenceItemId: 'evidence-founder-profile-1',
        },
      });
    });

    it('fails closed without committing profile when evidence persistence fails', async () => {
      const { db, inserts, updates } = createFounderProfileDb('ws-1', { failEvidence: true });
      const scoped = testApp(founderRoutes, createMockDeps({ db: db as never }));

      const res = await scoped.fetch(
        'POST',
        '/ws-1',
        {
          name: 'Test Founder',
        },
        wsHeader,
      );
      const json = await expectJson<{ error: string }>(res, 500);

      expect(json.error).toContain('Failed to upsert founder profile evidence');
      expect(inserts).toEqual([]);
      expect(updates).toEqual([]);
    });
  });

  // ── POST /:founderId/assessment ──

  describe('POST /:founderId/assessment', () => {
    it('denies members from creating founder assessments', async () => {
      const res = await fetch(
        'POST',
        '/fp-1/assessment',
        {
          assessmentType: 'personality',
          responses: { q1: 'a1', q2: 'a2' },
        },
        { ...wsHeader, 'X-Workspace-Role': 'member' },
      );
      const json = await expectJson<{ error: string; requiredRole: string }>(res, 403);

      expect(json.error).toBe('insufficient workspace role');
      expect(json.requiredRole).toBe('partner');
      expect(deps.db.insert).not.toHaveBeenCalled();
    });

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

    it('returns 404 when the founder profile is outside the workspace', async () => {
      const { db } = createFounderAssessmentDb('ws-1', { existingProfile: null });
      const scoped = testApp(founderRoutes, createMockDeps({ db: db as never }));

      const res = await scoped.fetch(
        'POST',
        '/fp-1/assessment',
        {
          assessmentType: 'personality',
          responses: { q1: 'a1', q2: 'a2' },
        },
        wsHeader,
      );
      const json = await expectJson<{ error: string }>(res, 404);

      expect(json.error).toBe('Founder profile not found');
    });

    it('creates assessment and returns 201', async () => {
      const { db, inserts, updates } = createFounderAssessmentDb('ws-1');
      const scoped = testApp(founderRoutes, createMockDeps({ db: db as never }));

      const res = await scoped.fetch(
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
      expect(json.evidenceItemId).toBe('evidence-founder-assessment-1');
      expect(inserts.map((insert) => insert.table)).toEqual([
        founderAssessments,
        auditLog,
        evidenceItems,
      ]);
      expect(updates.map((update) => update.table)).toEqual([auditLog]);
      const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
        id: string;
      };
      expect(auditInsert).toMatchObject({
        workspaceId: 'ws-1',
        action: 'FOUNDER_ASSESSMENT_CREATED',
        actor: 'user:user-1',
        target: 'fa-1',
        verdict: 'allow',
        metadata: {
          evidenceType: 'founder_assessment_created',
          replayRef: 'founder-assessment:ws-1:fp-1:fa-1',
          founderId: 'fp-1',
          assessmentId: 'fa-1',
          assessmentType: 'personality',
          evidenceContract: 'founder_assessment_evidence_required',
        },
      });
      expect(inserts.find((insert) => insert.table === evidenceItems)?.value).toMatchObject({
        workspaceId: 'ws-1',
        auditEventId: auditInsert.id,
        evidenceType: 'founder_assessment_created',
        sourceType: 'gateway_founder',
        replayRef: 'founder-assessment:ws-1:fp-1:fa-1',
        metadata: {
          founderId: 'fp-1',
          assessmentId: 'fa-1',
          assessmentType: 'personality',
          evidenceContract: 'founder_assessment_evidence_required',
        },
      });
      expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
        metadata: {
          evidenceItemId: 'evidence-founder-assessment-1',
        },
      });
    });

    it('fails closed without committing assessment when evidence persistence fails', async () => {
      const { db, inserts, updates } = createFounderAssessmentDb('ws-1', { failEvidence: true });
      const scoped = testApp(founderRoutes, createMockDeps({ db: db as never }));

      const res = await scoped.fetch(
        'POST',
        '/fp-1/assessment',
        {
          assessmentType: 'personality',
          responses: { q1: 'a1', q2: 'a2' },
        },
        wsHeader,
      );
      const json = await expectJson<{ error: string }>(res, 500);

      expect(json.error).toContain('Failed to create founder assessment evidence');
      expect(inserts).toEqual([]);
      expect(updates).toEqual([]);
    });
  });

  describe('POST /candidates', () => {
    it('denies members from creating cofounder candidates', async () => {
      const res = await fetch(
        'POST',
        '/candidates',
        {
          name: 'Candidate One',
        },
        { ...wsHeader, 'X-Workspace-Role': 'member' },
      );
      const json = await expectJson<{ error: string; requiredRole: string }>(res, 403);

      expect(json.error).toBe('insufficient workspace role');
      expect(json.requiredRole).toBe('partner');
    });

    it('passes actor context and returns candidate evidence metadata', async () => {
      const createCandidate = vi.fn(async () => ({
        id: 'cand-1',
        workspaceId: 'ws-1',
        name: 'Candidate One',
        evidenceItemId: 'evidence-candidate-created-1',
      }));
      const scoped = testApp(
        founderRoutes,
        createMockDeps({
          cofounderEngine: { createCandidate } as never,
        }),
      );

      const res = await scoped.fetch(
        'POST',
        '/candidates',
        {
          name: 'Candidate One',
        },
        wsHeader,
      );
      const json = await expectJson<Record<string, unknown>>(res, 201);

      expect(json).toMatchObject({
        id: 'cand-1',
        evidenceItemId: 'evidence-candidate-created-1',
      });
      expect(createCandidate).toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({
          source: 'manual',
          name: 'Candidate One',
          strengths: [],
          interests: [],
          preferredRoles: [],
        }),
        { actorUserId: 'user-1' },
      );
    });

    it('fails closed when candidate creation evidence fails', async () => {
      const createCandidate = vi.fn(async () => {
        throw new Error('evidence unavailable');
      });
      const scoped = testApp(
        founderRoutes,
        createMockDeps({
          cofounderEngine: { createCandidate } as never,
        }),
      );

      const res = await scoped.fetch(
        'POST',
        '/candidates',
        {
          name: 'Candidate One',
        },
        wsHeader,
      );
      const json = await expectJson<{ error: string }>(res, 500);

      expect(json.error).toContain('Failed to create candidate evidence');
    });
  });

  describe('POST /candidates/:id/score', () => {
    it('denies members from scoring cofounder candidates', async () => {
      const res = await fetch(
        'POST',
        '/candidates/cand-1/score',
        undefined,
        { ...wsHeader, 'X-Workspace-Role': 'member' },
      );
      const json = await expectJson<{ error: string; requiredRole: string }>(res, 403);

      expect(json.error).toBe('insufficient workspace role');
      expect(json.requiredRole).toBe('partner');
    });

    it('passes actor context and returns score evidence metadata', async () => {
      const scoreCandidate = vi.fn(async () => ({
        id: 'eval-1',
        workspaceId: 'ws-1',
        candidateId: 'cand-1',
        overallScore: 82,
        evidenceItemId: 'evidence-candidate-score-1',
      }));
      const scoped = testApp(
        founderRoutes,
        createMockDeps({
          cofounderEngine: { scoreCandidate } as never,
        }),
      );

      const res = await scoped.fetch('POST', '/candidates/cand-1/score', undefined, wsHeader);
      const json = await expectJson<Record<string, unknown>>(res, 201);

      expect(json).toMatchObject({
        id: 'eval-1',
        evidenceItemId: 'evidence-candidate-score-1',
      });
      expect(scoreCandidate).toHaveBeenCalledWith('ws-1', 'cand-1', { actorUserId: 'user-1' });
    });

    it('returns 404 when the candidate is not in the workspace', async () => {
      const scoreCandidate = vi.fn(async () => {
        throw new Error('Candidate not found');
      });
      const scoped = testApp(
        founderRoutes,
        createMockDeps({
          cofounderEngine: { scoreCandidate } as never,
        }),
      );

      const res = await scoped.fetch('POST', '/candidates/cand-1/score', undefined, wsHeader);
      const json = await expectJson<{ error: string }>(res, 404);

      expect(json.error).toBe('Candidate not found');
    });

    it('fails closed when score evidence fails', async () => {
      const scoreCandidate = vi.fn(async () => {
        throw new Error('evidence unavailable');
      });
      const scoped = testApp(
        founderRoutes,
        createMockDeps({
          cofounderEngine: { scoreCandidate } as never,
        }),
      );

      const res = await scoped.fetch('POST', '/candidates/cand-1/score', undefined, wsHeader);
      const json = await expectJson<{ error: string }>(res, 500);

      expect(json.error).toContain('Failed to score candidate evidence');
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
