import { describe, expect, it, vi } from 'vitest';
import {
  auditLog,
  cofounderCandidates,
  cofounderCandidateSources,
  evidenceItems,
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
