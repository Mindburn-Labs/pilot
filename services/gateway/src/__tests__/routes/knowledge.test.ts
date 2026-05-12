import { describe, it, expect, vi, beforeEach } from 'vitest';
import { evidenceItems } from '@pilot/db/schema';
import { knowledgeRoutes } from '../../routes/knowledge.js';
import { testApp, expectJson, createMockDeps } from '../helpers.js';

function createRecordingProofDb() {
  const inserts: Array<{ table: unknown; value: Record<string, unknown> }> = [];
  const db = {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((value: Record<string, unknown>) => {
        inserts.push({ table, value });
        return {
          returning: vi.fn(async () => (table === evidenceItems ? [{ id: 'evidence-1' }] : [])),
        };
      }),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(db)),
  };
  return { db, inserts };
}

describe('knowledgeRoutes', () => {
  const workspaceId = '00000000-0000-4000-8000-000000000001';
  const wsHeader = { 'X-Workspace-Id': workspaceId };

  // ─── GET /search ───

  describe('GET /search', () => {
    it('returns 400 when q is missing', async () => {
      const { fetch } = testApp(knowledgeRoutes);
      const res = await fetch('GET', '/search');
      const json = await expectJson(res, 400);
      expect(json).toHaveProperty('error', 'q parameter required');
    });

    it('calls memory.search and returns results', async () => {
      const deps = createMockDeps();
      const mockResults = [
        { id: 'page-1', title: 'React Best Practices', score: 0.95 },
        { id: 'page-2', title: 'React Hooks Guide', score: 0.82 },
      ];
      vi.mocked(deps.memory.search).mockResolvedValueOnce(mockResults as any);

      const { fetch } = testApp(knowledgeRoutes, deps);
      const res = await fetch('GET', '/search?q=react', undefined, wsHeader);
      const json = await expectJson<typeof mockResults>(res, 200);

      expect(deps.memory.search).toHaveBeenCalledWith('react', {
        types: undefined,
        limit: 20,
        workspaceId,
      });
      expect(json).toEqual(mockResults);
    });

    it('respects type and limit params', async () => {
      const deps = createMockDeps();
      vi.mocked(deps.memory.search).mockResolvedValueOnce([] as any);

      const { fetch } = testApp(knowledgeRoutes, deps);
      await fetch('GET', '/search?q=test&type=doc,note&limit=5', undefined, wsHeader);

      expect(deps.memory.search).toHaveBeenCalledWith('test', {
        types: ['doc', 'note'],
        limit: 5,
        workspaceId,
      });
    });
  });

  // ─── POST /pages ───

  describe('POST /pages', () => {
    it('returns 400 on invalid body', async () => {
      const { fetch } = testApp(knowledgeRoutes);
      const res = await fetch('POST', '/pages', { title: '' }, wsHeader);
      const json = await expectJson(res, 400);
      expect(json).toHaveProperty('error', 'Validation failed');
      expect(json).toHaveProperty('details');
    });

    it('returns 403 when body workspaceId mismatches the bound workspace', async () => {
      const { fetch } = testApp(knowledgeRoutes);
      const res = await fetch(
        'POST',
        '/pages',
        {
          workspaceId: '00000000-0000-4000-8000-000000000002',
          type: 'doc',
          title: 'Getting Started',
        },
        wsHeader,
      );
      const json = await expectJson<{ error: string }>(res, 403);
      expect(json.error).toContain('does not match');
    });

    it('requires partner role for page mutation', async () => {
      const { fetch } = testApp(knowledgeRoutes);
      const res = await fetch(
        'POST',
        '/pages',
        {
          type: 'doc',
          title: 'Getting Started',
          content: 'Welcome to Pilot.',
        },
        { ...wsHeader, 'X-Workspace-Role': 'member' },
      );
      const json = await expectJson<{ error: string; requiredRole: string }>(res, 403);
      expect(json.error).toBe('insufficient workspace role');
      expect(json.requiredRole).toBe('partner');
    });

    it('returns 201 with page id on success', async () => {
      const deps = createMockDeps();
      deps.db._setResult([{ id: 'evidence-1' }]);
      vi.mocked(deps.memory.upsertPage).mockResolvedValueOnce('page-42');

      const { fetch } = testApp(knowledgeRoutes, deps);
      const res = await fetch(
        'POST',
        '/pages',
        {
          type: 'doc',
          title: 'Getting Started',
          content: 'Welcome to Pilot.',
        },
        wsHeader,
      );
      const json = await expectJson<{ id: string }>(res, 201);

      expect(json.id).toBe('page-42');
      expect(json).toHaveProperty('evidenceItemId', 'evidence-1');
      expect(deps.memory.upsertPage).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId,
          type: 'doc',
          title: 'Getting Started',
          content: 'Welcome to Pilot.',
        }),
      );
    });

    it('persists redacted page evidence without raw content', async () => {
      const { db, inserts } = createRecordingProofDb();
      const deps = createMockDeps({ db: db as never });
      vi.mocked(deps.memory.upsertPage).mockResolvedValueOnce('page-42');

      const { fetch } = testApp(knowledgeRoutes, deps);
      const res = await fetch(
        'POST',
        '/pages',
        {
          type: 'doc',
          title: 'Getting Started',
          content: 'Welcome to Pilot.',
        },
        wsHeader,
      );
      const json = await expectJson<{ id: string; evidenceItemId: string }>(res, 201);

      expect(json.evidenceItemId).toBe('evidence-1');
      const evidenceInsert = inserts.find((insert) => insert.table === evidenceItems);
      expect(evidenceInsert?.value).toMatchObject({
        evidenceType: 'knowledge_page_upserted',
        sourceType: 'gateway_knowledge_route',
        redactionState: 'redacted',
      });
      expect(evidenceInsert?.value.contentHash).toMatch(/^sha256:/);
      expect(JSON.stringify(evidenceInsert?.value)).not.toContain('Welcome to Pilot.');
    });

    it('fails closed without mutating memory when page evidence persistence fails', async () => {
      const deps = createMockDeps();
      deps.db.transaction = vi.fn(async () => {
        throw new Error('evidence unavailable');
      }) as never;

      const { fetch } = testApp(knowledgeRoutes, deps);
      const res = await fetch(
        'POST',
        '/pages',
        {
          type: 'doc',
          title: 'Getting Started',
          content: 'Welcome to Pilot.',
        },
        wsHeader,
      );
      const json = await expectJson<{ error: string }>(res, 500);

      expect(json.error).toBe('Failed to persist knowledge evidence');
      expect(deps.memory.upsertPage).not.toHaveBeenCalled();
    });
  });

  // ─── POST /pages/:pageId/timeline ───

  describe('POST /pages/:pageId/timeline', () => {
    it('returns 400 on invalid body', async () => {
      const deps = createMockDeps();
      vi.mocked(deps.memory.getPage).mockResolvedValueOnce({ id: 'page-1', workspaceId } as any);
      const { fetch } = testApp(knowledgeRoutes, deps);
      const res = await fetch('POST', '/pages/page-1/timeline', {}, wsHeader);
      const json = await expectJson(res, 400);
      expect(json).toHaveProperty('error', 'Validation failed');
    });

    it('returns 201 on success', async () => {
      const deps = createMockDeps();
      deps.db._setResult([{ id: 'evidence-1' }]);
      vi.mocked(deps.memory.getPage).mockResolvedValueOnce({ id: 'page-1', workspaceId } as any);
      const { fetch } = testApp(knowledgeRoutes, deps);

      const res = await fetch(
        'POST',
        '/pages/page-1/timeline',
        {
          eventType: 'note',
          content: 'Updated the roadmap section.',
        },
        wsHeader,
      );
      const json = await expectJson<{ ok: boolean; evidenceItemId: string }>(res, 201);

      expect(json.ok).toBe(true);
      expect(json.evidenceItemId).toBe('evidence-1');
      expect(deps.memory.addTimeline).toHaveBeenCalledWith('page-1', {
        eventType: 'note',
        content: 'Updated the roadmap section.',
        source: 'api', // Zod default
      });
    });

    it('fails closed without mutating memory when timeline evidence persistence fails', async () => {
      const deps = createMockDeps();
      vi.mocked(deps.memory.getPage).mockResolvedValueOnce({ id: 'page-1', workspaceId } as any);
      deps.db.transaction = vi.fn(async () => {
        throw new Error('evidence unavailable');
      }) as never;
      const { fetch } = testApp(knowledgeRoutes, deps);

      const res = await fetch(
        'POST',
        '/pages/page-1/timeline',
        {
          eventType: 'note',
          content: 'Updated the roadmap section.',
        },
        wsHeader,
      );
      const json = await expectJson<{ error: string }>(res, 500);

      expect(json.error).toBe('Failed to persist knowledge evidence');
      expect(deps.memory.addTimeline).not.toHaveBeenCalled();
    });
  });
});
