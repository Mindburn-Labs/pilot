import { describe, expect, it, vi } from 'vitest';
import {
  auditLog,
  cofounderCandidates,
  cofounderCandidateSources,
  cofounderMatchEvaluations,
  evidenceItems,
  founderProfiles,
  founderStrengths,
} from '@pilot/db/schema';
import { CofounderEngine } from '../index.js';

function createCandidateCreationDb(options: { failEvidence?: boolean } = {}) {
  const inserts: Array<{ table: unknown; value: unknown }> = [];
  const updates: Array<{ table: unknown; value: unknown }> = [];
  const source = { id: 'source-1' };
  const candidate = {
    id: 'candidate-1',
    workspaceId: 'ws-1',
    sourceId: 'source-1',
    name: 'Candidate One',
    status: 'new',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };

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
        return {
          returning: vi.fn(async () => {
            if (table === cofounderCandidateSources) return [source];
            if (table === cofounderCandidates) return [candidate];
            if (table === evidenceItems) {
              if (options.failEvidence) throw new Error('evidence unavailable');
              return [{ id: 'evidence-candidate-created-1' }];
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
  };

  return { db, inserts, updates };
}

function createCandidateScoreDb(
  options: {
    failEvidence?: boolean;
    existingCandidate?: Record<string, unknown> | null;
    founder?: Record<string, unknown> | null;
    founderScores?: Array<Record<string, unknown>>;
  } = {},
) {
  const inserts: Array<{ table: unknown; value: unknown }> = [];
  const updates: Array<{ table: unknown; value: unknown }> = [];
  const existingCandidate =
    'existingCandidate' in options
      ? options.existingCandidate
      : {
          id: 'candidate-1',
          workspaceId: 'ws-1',
          name: 'Candidate One',
          status: 'new',
          headline: 'AI engineer',
          bio: 'Technical founder with product sense',
          strengths: ['technical'],
          interests: ['ai'],
          preferredRoles: ['cto'],
          createdAt: new Date('2026-01-01'),
          updatedAt: new Date('2026-01-01'),
        };
  const founder =
    'founder' in options
      ? options.founder
      : {
          id: 'founder-1',
          workspaceId: 'ws-1',
          name: 'Founder One',
          interests: ['ai'],
          startupVector: 'AI infrastructure',
        };
  const founderScores = options.founderScores ?? [
    { founderId: 'founder-1', dimension: 'technical', score: 30 },
    { founderId: 'founder-1', dimension: 'sales', score: 40 },
  ];

  const selectRows = (table: unknown) => {
    if (table === cofounderCandidates) return existingCandidate ? [existingCandidate] : [];
    if (table === founderProfiles) return founder ? [founder] : [];
    if (table === founderStrengths) return founderScores;
    return [];
  };

  const createDbFacade = (
    insertSink: Array<{ table: unknown; value: unknown }>,
    updateSink: Array<{ table: unknown; value: unknown }>,
  ) => ({
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => {
          const rows = selectRows(table);
          return {
            limit: vi.fn(async () => rows),
            then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
              Promise.resolve(rows).then(resolve, reject),
            catch: (reject: (reason: unknown) => void) => Promise.resolve(rows).catch(reject),
          };
        }),
      })),
    })),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        insertSink.push({ table, value });
        return {
          returning: vi.fn(async () => {
            if (table === cofounderMatchEvaluations) {
              return [
                {
                  id: 'evaluation-1',
                  ...value,
                  createdAt: new Date('2026-01-02'),
                },
              ];
            }
            if (table === evidenceItems) {
              if (options.failEvidence) throw new Error('evidence unavailable');
              return [{ id: 'evidence-candidate-score-1' }];
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
  };

  return { db, inserts, updates };
}

describe('CofounderEngine candidate creation evidence', () => {
  it('writes audit-linked evidence when creating a candidate', async () => {
    const { db, inserts, updates } = createCandidateCreationDb();
    const engine = new CofounderEngine(db as never);

    const result = await engine.createCandidate(
      'ws-1',
      {
        source: 'manual',
        externalId: 'ext-1',
        profileUrl: 'https://example.com/candidate',
        rawProfile: { headline: 'Builder' },
        name: 'Candidate One',
        headline: 'Builder',
        strengths: [],
        interests: [],
        preferredRoles: [],
      },
      { actorUserId: 'user-1' },
    );

    expect(result).toMatchObject({
      id: 'candidate-1',
      evidenceItemId: 'evidence-candidate-created-1',
    });
    expect(inserts.map((insert) => insert.table)).toEqual([
      cofounderCandidateSources,
      cofounderCandidates,
      auditLog,
      evidenceItems,
    ]);
    expect(updates.map((update) => update.table)).toEqual([auditLog]);

    const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
      id: string;
    };
    expect(auditInsert).toMatchObject({
      workspaceId: 'ws-1',
      action: 'COFOUNDER_CANDIDATE_CREATED',
      actor: 'user:user-1',
      target: 'candidate-1',
      verdict: 'allow',
      metadata: {
        evidenceType: 'cofounder_candidate_created',
        replayRef: 'cofounder-candidate:ws-1:candidate-1:created',
        candidateId: 'candidate-1',
        sourceId: 'source-1',
        source: 'manual',
        hasExternalProfile: true,
        hasRawProfile: true,
        evidenceContract: 'cofounder_candidate_creation_evidence_required',
      },
    });
    expect(inserts.find((insert) => insert.table === evidenceItems)?.value).toMatchObject({
      workspaceId: 'ws-1',
      auditEventId: auditInsert.id,
      evidenceType: 'cofounder_candidate_created',
      sourceType: 'cofounder_engine',
      replayRef: 'cofounder-candidate:ws-1:candidate-1:created',
      metadata: {
        candidateId: 'candidate-1',
        sourceId: 'source-1',
        source: 'manual',
        evidenceContract: 'cofounder_candidate_creation_evidence_required',
      },
    });
    expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
      metadata: {
        evidenceItemId: 'evidence-candidate-created-1',
      },
    });
  });

  it('rolls back candidate creation when evidence persistence fails', async () => {
    const { db, inserts, updates } = createCandidateCreationDb({ failEvidence: true });
    const engine = new CofounderEngine(db as never);

    await expect(
      engine.createCandidate(
        'ws-1',
        {
          source: 'manual',
          externalId: 'ext-1',
          profileUrl: 'https://example.com/candidate',
          rawProfile: { headline: 'Builder' },
          name: 'Candidate One',
          headline: 'Builder',
          strengths: [],
          interests: [],
          preferredRoles: [],
        },
        { actorUserId: 'user-1' },
      ),
    ).rejects.toThrow('evidence unavailable');

    expect(inserts).toEqual([]);
    expect(updates).toEqual([]);
  });
});

describe('CofounderEngine candidate score evidence', () => {
  it('writes audit-linked evidence when scoring a candidate', async () => {
    const { db, inserts, updates } = createCandidateScoreDb();
    const engine = new CofounderEngine(db as never);

    const result = await engine.scoreCandidate('ws-1', 'candidate-1', { actorUserId: 'user-1' });

    expect(result).toMatchObject({
      id: 'evaluation-1',
      candidateId: 'candidate-1',
      evidenceItemId: 'evidence-candidate-score-1',
    });
    expect(inserts.map((insert) => insert.table)).toEqual([
      cofounderMatchEvaluations,
      auditLog,
      evidenceItems,
    ]);
    expect(updates.map((update) => update.table)).toEqual([cofounderCandidates, auditLog]);

    expect(updates.find((update) => update.table === cofounderCandidates)?.value).toMatchObject({
      status: 'reviewing',
    });

    const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
      id: string;
    };
    expect(auditInsert).toMatchObject({
      workspaceId: 'ws-1',
      action: 'COFOUNDER_CANDIDATE_SCORED',
      actor: 'user:user-1',
      target: 'candidate-1',
      verdict: 'allow',
      metadata: {
        evidenceType: 'cofounder_candidate_scored',
        replayRef: 'cofounder-candidate:ws-1:candidate-1:score:evaluation-1',
        candidateId: 'candidate-1',
        evaluationId: 'evaluation-1',
        founderId: 'founder-1',
        scoringMethod: 'heuristic',
        previousStatus: 'new',
        nextStatus: 'reviewing',
        evidenceContract: 'cofounder_candidate_score_evidence_required',
      },
    });
    expect(inserts.find((insert) => insert.table === evidenceItems)?.value).toMatchObject({
      workspaceId: 'ws-1',
      auditEventId: auditInsert.id,
      evidenceType: 'cofounder_candidate_scored',
      sourceType: 'cofounder_engine',
      replayRef: 'cofounder-candidate:ws-1:candidate-1:score:evaluation-1',
      metadata: {
        candidateId: 'candidate-1',
        evaluationId: 'evaluation-1',
        evidenceContract: 'cofounder_candidate_score_evidence_required',
      },
    });
    expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
      metadata: {
        evidenceItemId: 'evidence-candidate-score-1',
      },
    });
  });

  it('rolls back score persistence when evidence persistence fails', async () => {
    const { db, inserts, updates } = createCandidateScoreDb({ failEvidence: true });
    const engine = new CofounderEngine(db as never);

    await expect(
      engine.scoreCandidate('ws-1', 'candidate-1', { actorUserId: 'user-1' }),
    ).rejects.toThrow('evidence unavailable');

    expect(inserts).toEqual([]);
    expect(updates).toEqual([]);
  });
});
