import { eq, and, or, sql, desc } from 'drizzle-orm';
import { type Db } from '@pilot/db/client';
import { pages, contentChunks, timelineEntries, links, tags } from '@pilot/db/schema';
import { type LlmProvider } from '@pilot/shared/llm';
import { type EmbeddingProvider } from '@pilot/shared/embeddings';

/**
 * Memory Service — GBrain-style knowledge layer.
 *
 * Responsibilities:
 * - Compiled truth + timeline per entity (MECE entity registry)
 * - Typed entity graph (pages + links)
 * - Hybrid search: keyword (tsvector) + vector (pgvector) with RRF
 * - Content chunking and embedding for semantic retrieval
 * - Timeline entry management (operational memory)
 *
 * Any service can write timeline entries. Only memory service
 * updates compiled truth (canonical summaries).
 */
export class MemoryService {
  private llm?: LlmProvider;
  private embeddings?: EmbeddingProvider;
  /** True once we've confirmed the `embedding_vec` column exists in the DB. */
  private vectorColumnAvailable = false;
  private vectorProbePromise: Promise<boolean> | null = null;

  constructor(readonly db: Db) {}

  /** Set LLM provider for truth recompilation */
  setLlm(llm: LlmProvider) {
    this.llm = llm;
  }

  /** Set embedding provider for semantic search + chunk indexing. */
  setEmbeddings(provider: EmbeddingProvider) {
    this.embeddings = provider;
  }

  /**
   * Detect whether the `embedding_vec` column exists (pgvector installed).
   * Cached after first call. Falls back to keyword-only search if absent.
   */
  private async isVectorColumnAvailable(): Promise<boolean> {
    if (this.vectorProbePromise) return this.vectorProbePromise;
    this.vectorProbePromise = (async () => {
      try {
        const result = await this.db.execute(sql`
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'content_chunks' AND column_name = 'embedding_vec'
        `);
        const rows = result as unknown as unknown[];
        this.vectorColumnAvailable = rows.length > 0;
        return this.vectorColumnAvailable;
      } catch {
        this.vectorColumnAvailable = false;
        return false;
      }
    })();
    return this.vectorProbePromise;
  }

  /**
   * Search knowledge using keyword, vector, or hybrid (RRF-combined) search.
   *
   * - 'keyword' (default): PostgreSQL tsvector full-text.
   * - 'vector': pgvector cosine similarity on chunk embeddings.
   * - 'hybrid': Reciprocal Rank Fusion of keyword + vector.
   */
  async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
    const limit = Math.min(options?.limit ?? 10, 100);
    const method = options?.method ?? 'keyword';

    if (method === 'keyword') {
      return this.keywordSearch(query, options?.types, options?.tags, limit, options?.workspaceId);
    }

    if (method === 'vector') {
      if (!this.embeddings) return [];
      return this.vectorSearch(query, options?.types, limit, options?.workspaceId);
    }

    // Hybrid: run both, combine with Reciprocal Rank Fusion
    const keywordResults = await this.keywordSearch(
      query,
      options?.types,
      options?.tags,
      limit * 2,
      options?.workspaceId,
    );
    if (!this.embeddings) return keywordResults.slice(0, limit);
    const vectorResults = await this.vectorSearch(query, options?.types, limit * 2, options?.workspaceId);
    return reciprocalRankFusion(keywordResults, vectorResults, limit);
  }

  /**
   * Semantic search using pgvector cosine similarity.
   * Embeds the query and finds the most similar chunks.
   */
  private async vectorSearch(
    query: string,
    types?: string[],
    limit = 10,
    workspaceId?: string,
  ): Promise<SearchResult[]> {
    if (!this.embeddings) return [];
    if (!(await this.isVectorColumnAvailable())) return [];
    const trimmed = query.trim();
    if (!trimmed) return [];

    const queryVec = await this.embeddings.embed(trimmed);
    const queryVecLiteral = `[${queryVec.join(',')}]`;

    const typeFilter = types?.length ? sql`AND p.type = ANY(${types})` : sql``;
    const workspaceFilter = workspaceId
      ? sql`AND (p.workspace_id = ${workspaceId} OR p.workspace_id IS NULL)`
      : sql``;

    // Cosine distance (<=>) — smaller is more similar. Convert to similarity score.
    const results = await this.db.execute(sql`
      SELECT
        p.id AS page_id,
        p.title,
        p.type,
        SUBSTRING(cc.content, 1, 300) AS content,
        1 - (cc.embedding_vec <=> ${queryVecLiteral}::vector) AS score
      FROM content_chunks cc
      JOIN pages p ON p.id = cc.page_id
      WHERE cc.embedding_vec IS NOT NULL
        ${typeFilter}
        ${workspaceFilter}
      ORDER BY cc.embedding_vec <=> ${queryVecLiteral}::vector
      LIMIT ${limit}
    `);

    type Row = { page_id: string; title: string; type: string; content: string; score: number };
    const rows = results as unknown as Row[];

    return [...rows].map((r) => ({
      pageId: r.page_id,
      title: r.title,
      excerpt: r.content,
      score: Number(r.score),
      type: r.type,
    }));
  }

  /**
   * Keyword search using PostgreSQL full-text search.
   * Uses a LATERAL subquery to get the best-matching chunk per page,
   * avoiding the DISTINCT ON ranking bug.
   */
  private async keywordSearch(
    query: string,
    types?: string[],
    _tags?: string[],
    limit = 10,
    workspaceId?: string,
  ): Promise<SearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];

    // Build parameterized type filter
    const typeFilter = types?.length
      ? sql`AND p.type = ANY(${types})`
      : sql``;
    const workspaceFilter = workspaceId
      ? sql`AND (p.workspace_id = ${workspaceId} OR p.workspace_id IS NULL)`
      : sql``;

    // Use LATERAL to get the best chunk per page — avoids DISTINCT ON ranking bug
    const results = await this.db.execute(sql`
      SELECT
        p.id AS page_id,
        p.title,
        p.type,
        best_chunk.content,
        best_chunk.rank
      FROM pages p
      CROSS JOIN LATERAL (
        SELECT
          SUBSTRING(cc.content, 1, 300) AS content,
          ts_rank(
            to_tsvector('english', COALESCE(p.title, '') || ' ' || COALESCE(cc.content, '')),
            plainto_tsquery('english', ${trimmed})
          ) AS rank
        FROM content_chunks cc
        WHERE cc.page_id = p.id
          AND to_tsvector('english', COALESCE(p.title, '') || ' ' || COALESCE(cc.content, ''))
              @@ plainto_tsquery('english', ${trimmed})
        ORDER BY rank DESC
        LIMIT 1
      ) best_chunk
      WHERE 1=1
        ${typeFilter}
        ${workspaceFilter}
      ORDER BY best_chunk.rank DESC
      LIMIT ${limit}
    `);

    type Row = { page_id: string; title: string; type: string; content: string; rank: number };
    const rows = results as unknown as Row[];

    return [...rows].map((r) => ({
      pageId: r.page_id,
      title: r.title,
      excerpt: r.content,
      score: r.rank,
      type: r.type,
    }));
  }

  /**
   * Create or update a knowledge page.
   * Checks for existing page by (type, title) before inserting to maintain
   * MECE invariant: one page per entity.
   * If content is provided, it will be chunked and stored.
   */
  async upsertPage(page: PageInput): Promise<string> {
    // Check for existing page with same type + title
    const [existing] = await this.db
      .select({ id: pages.id })
      .from(pages)
      .where(
        and(
          eq(pages.type, page.type),
          eq(pages.title, page.title),
          page.workspaceId ? eq(pages.workspaceId, page.workspaceId) : sql`pages.workspace_id IS NULL`,
        ),
      )
      .limit(1);

    if (existing) {
      // Update existing page
      await this.db
        .update(pages)
        .set({
          workspaceId: page.workspaceId,
          compiledTruth: page.compiledTruth ?? '',
          tags: page.tags ?? [],
          updatedAt: new Date(),
        })
        .where(eq(pages.id, existing.id));

      // Replace chunks if new content provided
      if (page.content) {
        await this.db.delete(contentChunks).where(eq(contentChunks.pageId, existing.id));
        await this.insertChunks(existing.id, page.content);
      }

      return existing.id;
    }

    // Insert new page
    const [result] = await this.db
      .insert(pages)
      .values({
        workspaceId: page.workspaceId,
        type: page.type,
        title: page.title,
        compiledTruth: page.compiledTruth ?? '',
        tags: page.tags ?? [],
      })
      .returning({ id: pages.id });

    if (!result) throw new Error('Failed to create page');

    // Chunk and store content if provided
    if (page.content) {
      await this.insertChunks(result.id, page.content);
    }

    return result.id;
  }

  /**
   * Chunk text, generate embeddings (if provider available), and insert into DB.
   * Embedding failures are non-fatal — chunks still get saved for keyword search.
   */
  private async insertChunks(pageId: string, content: string): Promise<void> {
    const chunks = chunkText(content);
    if (chunks.length === 0) return;

    const vectorOk = await this.isVectorColumnAvailable();
    let embeddings: (number[] | undefined)[] = new Array(chunks.length).fill(undefined);
    if (this.embeddings && vectorOk) {
      try {
        embeddings = await this.embeddings.embedBatch(chunks);
      } catch {
        // Embedding failure is non-fatal; chunks still work for keyword search
      }
    }

    for (let i = 0; i < chunks.length; i++) {
      const row: Record<string, unknown> = {
        pageId,
        content: chunks[i]!,
        chunkIndex: i,
        metadata: {},
      };
      if (vectorOk) row['embeddingVec'] = embeddings[i] ?? null;
      await this.db.insert(contentChunks).values(row as typeof contentChunks.$inferInsert);
    }
  }

  /**
   * Append a timeline entry to a page.
   */
  async addTimeline(pageId: string, entry: TimelineInput): Promise<void> {
    await this.db.insert(timelineEntries).values({
      pageId,
      eventType: entry.eventType,
      content: entry.content,
      source: entry.source,
    });
  }

  /**
   * Get a page with its timeline entries.
   */
  async getPage(pageId: string) {
    const [page] = await this.db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
    if (!page) return null;

    const timeline = await this.db
      .select()
      .from(timelineEntries)
      .where(eq(timelineEntries.pageId, pageId))
      .orderBy(desc(timelineEntries.occurredAt));

    return { ...page, timeline };
  }

  /**
   * Recompile the truth summary for a page from its timeline entries.
   * Uses LLM if available, otherwise concatenates recent entries.
   */
  async recompileTruth(pageId: string, workspaceId?: string): Promise<void> {
    const pageScope = workspaceId
      ? and(eq(pages.id, pageId), eq(pages.workspaceId, workspaceId))
      : eq(pages.id, pageId);
    const [page] = await this.db.select().from(pages).where(pageScope).limit(1);
    if (!page) return;

    const entries = await this.db
      .select()
      .from(timelineEntries)
      .where(eq(timelineEntries.pageId, pageId))
      .orderBy(desc(timelineEntries.occurredAt))
      .limit(20);

    if (entries.length === 0) return;

    let compiledTruth: string;

    if (this.llm) {
      const entriesText = entries
        .map((e) => `[${e.eventType}] ${e.content}`)
        .join('\n');

      const prompt = `Summarize the following timeline entries for "${page.title}" into a concise truth summary (max 500 chars). Focus on the most important facts and current state:\n\n${entriesText}\n\nSummary:`;

      try {
        compiledTruth = await this.llm.complete(prompt);
        compiledTruth = compiledTruth.slice(0, 500);
      } catch {
        // Fallback to non-LLM compilation
        compiledTruth = entries
          .slice(0, 5)
          .map((e) => e.content)
          .join(' | ')
          .slice(0, 500);
      }
    } else {
      // No LLM: concatenate last 5 entries
      compiledTruth = entries
        .slice(0, 5)
        .map((e) => e.content)
        .join(' | ')
        .slice(0, 500);
    }

    await this.db
      .update(pages)
      .set({ compiledTruth, updatedAt: new Date() })
      .where(pageScope);
  }

  // ─── Knowledge Graph: Links ───

  /**
   * Create a link between two pages.
   */
  async createLink(
    fromPageId: string,
    toPageId: string,
    relation: string,
  ): Promise<string> {
    const [link] = await this.db
      .insert(links)
      .values({ fromPageId, toPageId, relation })
      .returning({ id: links.id });
    if (!link) throw new Error('Failed to create link');
    return link.id;
  }

  /**
   * Get all links for a page (both incoming and outgoing).
   */
  async getLinks(pageId: string) {
    const results = await this.db
      .select()
      .from(links)
      .where(or(eq(links.fromPageId, pageId), eq(links.toPageId, pageId)));
    return results;
  }

  // ─── Knowledge Graph: Tags ───

  /**
   * Add a tag to a page. Creates the tag if it doesn't exist.
   * Tags are stored in the page's tags JSONB array.
   */
  async addTag(pageId: string, tagName: string, category?: string): Promise<void> {
    // Ensure tag exists in the tags table
    const [existing] = await this.db
      .select()
      .from(tags)
      .where(eq(tags.name, tagName))
      .limit(1);

    if (!existing) {
      await this.db.insert(tags).values({ name: tagName, category }).onConflictDoNothing();
    }

    // Add tag to page's tags array if not already present
    const [page] = await this.db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
    if (!page) return;

    const currentTags = (page.tags ?? []) as string[];
    if (!currentTags.includes(tagName)) {
      await this.db
        .update(pages)
        .set({ tags: [...currentTags, tagName], updatedAt: new Date() })
        .where(eq(pages.id, pageId));
    }
  }

  /**
   * Get all tags for a page.
   */
  async getPageTags(pageId: string): Promise<string[]> {
    const [page] = await this.db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
    if (!page) return [];
    return (page.tags ?? []) as string[];
  }

  /**
   * List all tags in the system with optional category filter.
   */
  async listTags(category?: string) {
    if (category) {
      return this.db.select().from(tags).where(eq(tags.category, category));
    }
    return this.db.select().from(tags);
  }
}

// ─── Reciprocal Rank Fusion (RRF) ───

/**
 * Combine two ranked result sets using Reciprocal Rank Fusion.
 *
 * RRF score for each result = sum over lists of 1 / (k + rank).
 * k=60 is a common default that smooths out rank differences.
 */
function reciprocalRankFusion(
  keywordResults: SearchResult[],
  vectorResults: SearchResult[],
  limit: number,
  k = 60,
): SearchResult[] {
  const scores = new Map<string, { result: SearchResult; score: number }>();

  const accumulate = (list: SearchResult[]) => {
    list.forEach((result, rank) => {
      const existing = scores.get(result.pageId);
      const rrfScore = 1 / (k + rank + 1);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(result.pageId, { result: { ...result, score: rrfScore }, score: rrfScore });
      }
    });
  };

  accumulate(keywordResults);
  accumulate(vectorResults);

  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ result, score }) => ({ ...result, score }));
}

// ─── Text Chunking ───

const CHUNK_SIZE = 1500;
const CHUNK_OVERLAP = 200;

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = start + CHUNK_SIZE;
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    start = end - CHUNK_OVERLAP;
  }
  return chunks;
}

// ─── Types ───

export interface SearchOptions {
  types?: string[];
  tags?: string[];
  limit?: number;
  method?: 'keyword' | 'vector' | 'hybrid';
  workspaceId?: string;
}

export interface SearchResult {
  pageId: string;
  title: string;
  excerpt: string;
  score: number;
  type: string;
}

export interface PageInput {
  workspaceId?: string;
  type: string;
  title: string;
  compiledTruth?: string;
  tags?: string[];
  content?: string;
}

export interface TimelineInput {
  eventType: string;
  content: string;
  source: string;
}
