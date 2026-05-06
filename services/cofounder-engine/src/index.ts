import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { appendEvidenceItem } from '@pilot/db';
import { type Db } from '@pilot/db/client';
import {
  auditLog,
  operators,
  operatorRoles,
  operatorConfigs,
  founderProfiles,
  founderStrengths,
  cofounderCandidateSources,
  cofounderCandidates,
  cofounderMatchEvaluations,
  cofounderCandidateNotes,
  cofounderOutreachDrafts,
  cofounderFollowUps,
} from '@pilot/db/schema';
import { type LlmProvider } from '@pilot/shared/llm';

type CofounderAuditContext = {
  actorUserId?: string;
};

/**
 * CofounderEngine — creates and manages digital co-founder operators.
 *
 * Responsibilities:
 * - Define operator roles (Engineering, Product, Growth, Design, Ops)
 * - Score founder/operator complement (what roles fill the gaps)
 * - Create operators with role-specific goals, tools, constraints
 * - Recommend operator configurations based on founder strengths
 */
export class CofounderEngine {
  constructor(
    private readonly db: Db,
    readonly llm?: LlmProvider,
  ) {}

  /**
   * Seed the default operator roles into the database.
   * Idempotent — skips existing roles.
   */
  async seedRoles(): Promise<number> {
    let seeded = 0;
    for (const role of DEFAULT_ROLES) {
      const [existing] = await this.db
        .select()
        .from(operatorRoles)
        .where(eq(operatorRoles.name, role.name))
        .limit(1);
      if (existing) continue;

      await this.db.insert(operatorRoles).values(role);
      seeded++;
    }
    return seeded;
  }

  /**
   * List all available operator roles.
   */
  async listRoles() {
    return this.db.select().from(operatorRoles);
  }

  /**
   * Create an operator for a workspace using a role template.
   */
  async createOperator(params: {
    workspaceId: string;
    roleName: string;
    name?: string;
    goalOverride?: string;
  }) {
    const [role] = await this.db
      .select()
      .from(operatorRoles)
      .where(eq(operatorRoles.name, params.roleName))
      .limit(1);

    if (!role) throw new Error(`Unknown role: ${params.roleName}`);

    const [operator] = await this.db
      .insert(operators)
      .values({
        workspaceId: params.workspaceId,
        name: params.name ?? `${role.name} Operator`,
        role: role.name,
        goal: params.goalOverride ?? role.defaultGoal,
        constraints: role.defaultConstraints,
        tools: role.defaultTools,
      })
      .returning();

    if (!operator) throw new Error('Failed to create operator');

    // Create default config
    await this.db.insert(operatorConfigs).values({
      operatorId: operator.id,
      modelPreference: null,
      iterationBudget: { maxIterations: 50 },
      skillFiles: [],
    });

    return operator;
  }

  /**
   * List operators for a workspace.
   */
  async listOperators(workspaceId: string) {
    return this.db
      .select()
      .from(operators)
      .where(eq(operators.workspaceId, workspaceId));
  }

  /**
   * Score which operator roles would best complement a founder's strengths.
   * Returns roles sorted by priority (highest gap = highest priority).
   */
  async scoreComplement(strengths: StrengthInput[]): Promise<ComplementScore[]> {
    // Map strength dimensions to operator roles
    const roleMapping: Record<string, string> = {
      technical: 'engineering',
      sales: 'growth',
      design: 'design',
      ops: 'ops',
      domain: 'product',
    };

    const scores: ComplementScore[] = [];
    for (const strength of strengths) {
      const roleName = roleMapping[strength.dimension];
      if (!roleName) continue;

      // Gap = 100 - founder's score in that dimension
      // Higher gap = more need for that operator
      const gap = 100 - strength.score;
      const priority = gap >= 60 ? 'critical' : gap >= 40 ? 'recommended' : 'optional';

      scores.push({
        roleName,
        founderScore: strength.score,
        gap,
        priority,
        reason: gap >= 60
          ? `Your ${strength.dimension} score is ${strength.score}/100 — a ${roleName} operator would fill a critical gap`
          : gap >= 40
            ? `Moderate gap in ${strength.dimension} — a ${roleName} operator would strengthen your team`
            : `You're strong in ${strength.dimension} — ${roleName} operator is optional`,
      });
    }

    return scores.sort((a, b) => b.gap - a.gap);
  }

  /**
   * Auto-create the recommended operator team for a workspace
   * based on founder strength gaps.
   */
  async autoCreateTeam(
    workspaceId: string,
    strengths: StrengthInput[],
    maxOperators = 3,
  ) {
    const complements = await this.scoreComplement(strengths);
    const created = [];

    for (const c of complements.slice(0, maxOperators)) {
      if (c.priority === 'optional') continue;
      const op = await this.createOperator({
        workspaceId,
        roleName: c.roleName,
      });
      created.push({ operator: op, complement: c });
    }

    return created;
  }

  /**
   * List real-world co-founder candidates for a workspace with their latest score.
   */
  async listCandidates(workspaceId: string) {
    const candidates = await this.db
      .select()
      .from(cofounderCandidates)
      .where(eq(cofounderCandidates.workspaceId, workspaceId))
      .orderBy(desc(cofounderCandidates.updatedAt));

    const enriched = await Promise.all(
      candidates.map(async (candidate) => {
        const [latestScore] = await this.db
          .select()
          .from(cofounderMatchEvaluations)
          .where(eq(cofounderMatchEvaluations.candidateId, candidate.id))
          .orderBy(desc(cofounderMatchEvaluations.createdAt))
          .limit(1);

        return { ...candidate, latestScore };
      }),
    );

    return enriched;
  }

  async getCandidate(candidateId: string) {
    const [candidate] = await this.db
      .select()
      .from(cofounderCandidates)
      .where(eq(cofounderCandidates.id, candidateId))
      .limit(1);

    if (!candidate) return null;

    const [latestScore] = await this.db
      .select()
      .from(cofounderMatchEvaluations)
      .where(eq(cofounderMatchEvaluations.candidateId, candidateId))
      .orderBy(desc(cofounderMatchEvaluations.createdAt))
      .limit(1);

    const notes = await this.db
      .select()
      .from(cofounderCandidateNotes)
      .where(eq(cofounderCandidateNotes.candidateId, candidateId))
      .orderBy(desc(cofounderCandidateNotes.createdAt));

    const outreachDrafts = await this.db
      .select()
      .from(cofounderOutreachDrafts)
      .where(eq(cofounderOutreachDrafts.candidateId, candidateId))
      .orderBy(desc(cofounderOutreachDrafts.updatedAt));

    const followUps = await this.db
      .select()
      .from(cofounderFollowUps)
      .where(eq(cofounderFollowUps.candidateId, candidateId))
      .orderBy(desc(cofounderFollowUps.createdAt));

    return { ...candidate, latestScore, notes, outreachDrafts, followUps };
  }

  async createCandidate(
    workspaceId: string,
    input: CofounderCandidateInput,
    auditContext: CofounderAuditContext = {},
  ) {
    return this.db.transaction(async (tx) => {
      let sourceId: string | null = null;

      if (input.rawProfile || input.profileUrl || input.externalId) {
        const [source] = await tx
          .insert(cofounderCandidateSources)
          .values({
            workspaceId,
            source: input.source ?? 'manual',
            externalId: input.externalId,
            profileUrl: input.profileUrl,
            rawProfile: input.rawProfile ?? {},
          })
          .returning();
        sourceId = source?.id ?? null;
      }

      const [candidate] = await tx
        .insert(cofounderCandidates)
        .values({
          workspaceId,
          sourceId,
          name: input.name,
          headline: input.headline,
          location: input.location,
          bio: input.bio,
          profileUrl: input.profileUrl,
          strengths: input.strengths ?? [],
          interests: input.interests ?? [],
          preferredRoles: input.preferredRoles ?? [],
          metadata: input.metadata ?? {},
        })
        .returning();

      if (!candidate) throw new Error('Failed to create cofounder candidate');

      const auditEventId = randomUUID();
      const replayRef = `cofounder-candidate:${workspaceId}:${candidate.id}:created`;
      const auditMetadata = {
        candidateId: candidate.id,
        sourceId,
        source: input.source ?? 'manual',
        hasExternalProfile: Boolean(input.profileUrl || input.externalId),
        hasRawProfile: Boolean(input.rawProfile),
        evidenceContract: 'cofounder_candidate_creation_evidence_required',
      };

      await tx.insert(auditLog).values({
        id: auditEventId,
        workspaceId,
        action: 'COFOUNDER_CANDIDATE_CREATED',
        actor: `user:${auditContext.actorUserId ?? 'unknown'}`,
        target: candidate.id,
        verdict: 'allow',
        metadata: {
          evidenceType: 'cofounder_candidate_created',
          replayRef,
          ...auditMetadata,
        },
      });

      const evidenceItemId = await appendEvidenceItem(tx, {
        workspaceId,
        auditEventId,
        evidenceType: 'cofounder_candidate_created',
        sourceType: 'cofounder_engine',
        title: `Cofounder candidate created: ${candidate.id}`,
        summary: `Cofounder candidate ${candidate.id} was created from ${auditMetadata.source}.`,
        redactionState: 'none',
        sensitivity: 'internal',
        replayRef,
        metadata: auditMetadata,
      });

      await tx
        .update(auditLog)
        .set({
          metadata: {
            evidenceType: 'cofounder_candidate_created',
            replayRef,
            evidenceItemId,
            ...auditMetadata,
          },
        })
        .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

      return { ...candidate, evidenceItemId };
    });
  }

  /**
   * Score a real-world co-founder candidate against the workspace founder.
   */
  async scoreCandidate(
    workspaceId: string,
    candidateId: string,
    auditContext: CofounderAuditContext = {},
  ) {
    const [candidate] = await this.db
      .select()
      .from(cofounderCandidates)
      .where(eq(cofounderCandidates.id, candidateId))
      .limit(1);

    if (!candidate || candidate.workspaceId !== workspaceId) {
      throw new Error('Candidate not found');
    }

    const [founder] = await this.db
      .select()
      .from(founderProfiles)
      .where(eq(founderProfiles.workspaceId, workspaceId))
      .limit(1);

    const founderScores = founder
      ? await this.db
          .select()
          .from(founderStrengths)
          .where(eq(founderStrengths.founderId, founder.id))
      : [];

    const heuristic = scoreCandidateHeuristically(founder, founderScores, candidate);
    let resolved = heuristic;

    if (this.llm) {
      try {
        const response = await this.llm.complete(buildCandidateScoringPrompt(founder, founderScores, candidate));
        const parsed = JSON.parse(stripCodeFence(response)) as Partial<CofounderMatchScore>;
        resolved = {
          overallScore: clampScore(parsed.overallScore ?? heuristic.overallScore),
          complementScore: clampScore(parsed.complementScore ?? heuristic.complementScore),
          executionScore: clampScore(parsed.executionScore ?? heuristic.executionScore),
          ycFitScore: clampScore(parsed.ycFitScore ?? heuristic.ycFitScore),
          riskScore: clampScore(parsed.riskScore ?? heuristic.riskScore),
          reasoning: String(parsed.reasoning ?? heuristic.reasoning),
          scoringMethod: 'llm',
        };
      } catch {
        resolved = heuristic;
      }
    }

    return this.db.transaction(async (tx) => {
      const [evaluation] = await tx
        .insert(cofounderMatchEvaluations)
        .values({
          workspaceId,
          founderId: founder?.id,
          candidateId,
          overallScore: resolved.overallScore,
          complementScore: resolved.complementScore,
          executionScore: resolved.executionScore,
          ycFitScore: resolved.ycFitScore,
          riskScore: resolved.riskScore,
          reasoning: resolved.reasoning,
          scoringMethod: resolved.scoringMethod,
        })
        .returning();

      if (!evaluation) throw new Error('Failed to score cofounder candidate');

      const nextStatus = candidate.status === 'new' ? 'reviewing' : candidate.status;
      await tx
        .update(cofounderCandidates)
        .set({
          fitSummary: resolved.reasoning,
          status: nextStatus,
          updatedAt: new Date(),
        })
        .where(and(eq(cofounderCandidates.workspaceId, workspaceId), eq(cofounderCandidates.id, candidateId)));

      const auditEventId = randomUUID();
      const replayRef = `cofounder-candidate:${workspaceId}:${candidateId}:score:${evaluation.id}`;
      const auditMetadata = {
        candidateId,
        evaluationId: evaluation.id,
        founderId: founder?.id ?? null,
        scoringMethod: resolved.scoringMethod,
        previousStatus: candidate.status,
        nextStatus,
        scores: {
          overallScore: resolved.overallScore,
          complementScore: resolved.complementScore,
          executionScore: resolved.executionScore,
          ycFitScore: resolved.ycFitScore,
          riskScore: resolved.riskScore,
        },
        evidenceContract: 'cofounder_candidate_score_evidence_required',
      };

      await tx.insert(auditLog).values({
        id: auditEventId,
        workspaceId,
        action: 'COFOUNDER_CANDIDATE_SCORED',
        actor: `user:${auditContext.actorUserId ?? 'unknown'}`,
        target: candidateId,
        verdict: 'allow',
        metadata: {
          evidenceType: 'cofounder_candidate_scored',
          replayRef,
          ...auditMetadata,
        },
      });

      const evidenceItemId = await appendEvidenceItem(tx, {
        workspaceId,
        auditEventId,
        evidenceType: 'cofounder_candidate_scored',
        sourceType: 'cofounder_engine',
        title: `Cofounder candidate scored: ${candidateId}`,
        summary: `Cofounder candidate ${candidateId} was scored with ${resolved.scoringMethod} evaluation ${evaluation.id}.`,
        redactionState: 'none',
        sensitivity: 'internal',
        replayRef,
        metadata: auditMetadata,
      });

      await tx
        .update(auditLog)
        .set({
          metadata: {
            evidenceType: 'cofounder_candidate_scored',
            replayRef,
            evidenceItemId,
            ...auditMetadata,
          },
        })
        .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

      return { ...evaluation, evidenceItemId };
    });
  }

  async addCandidateNote(
    workspaceId: string,
    candidateId: string,
    content: string,
    noteType = 'note',
    userId?: string,
    auditContext: CofounderAuditContext = {},
  ) {
    const [candidate] = await this.db
      .select()
      .from(cofounderCandidates)
      .where(eq(cofounderCandidates.id, candidateId))
      .limit(1);

    if (!candidate || candidate.workspaceId !== workspaceId) {
      throw new Error('Candidate not found');
    }

    return this.db.transaction(async (tx) => {
      const [note] = await tx
        .insert(cofounderCandidateNotes)
        .values({
          workspaceId,
          candidateId,
          userId,
          noteType,
          content,
        })
        .returning();

      if (!note) throw new Error('Failed to add cofounder candidate note');

      const auditEventId = randomUUID();
      const replayRef = `cofounder-candidate:${workspaceId}:${candidateId}:note:${note.id}`;
      const auditMetadata = {
        candidateId,
        noteId: note.id,
        noteType,
        hasUserId: Boolean(userId),
        contentLength: content.length,
        evidenceContract: 'cofounder_candidate_note_evidence_required',
      };

      await tx.insert(auditLog).values({
        id: auditEventId,
        workspaceId,
        action: 'COFOUNDER_CANDIDATE_NOTE_ADDED',
        actor: `user:${auditContext.actorUserId ?? userId ?? 'unknown'}`,
        target: candidateId,
        verdict: 'allow',
        metadata: {
          evidenceType: 'cofounder_candidate_note_added',
          replayRef,
          ...auditMetadata,
        },
      });

      const evidenceItemId = await appendEvidenceItem(tx, {
        workspaceId,
        auditEventId,
        evidenceType: 'cofounder_candidate_note_added',
        sourceType: 'cofounder_engine',
        title: `Cofounder candidate note added: ${candidateId}`,
        summary: `A ${noteType} note was added to cofounder candidate ${candidateId}.`,
        redactionState: 'redacted',
        sensitivity: 'internal',
        replayRef,
        metadata: auditMetadata,
      });

      await tx
        .update(auditLog)
        .set({
          metadata: {
            evidenceType: 'cofounder_candidate_note_added',
            replayRef,
            evidenceItemId,
            ...auditMetadata,
          },
        })
        .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

      return { ...note, evidenceItemId };
    });
  }

  async createOutreachDraft(
    workspaceId: string,
    candidateId: string,
    input: { channel?: string; subject?: string; content: string },
  ) {
    const [draft] = await this.db
      .insert(cofounderOutreachDrafts)
      .values({
        workspaceId,
        candidateId,
        channel: input.channel ?? 'email',
        subject: input.subject,
        content: input.content,
      })
      .returning();

    return draft;
  }

  async createFollowUp(
    workspaceId: string,
    candidateId: string,
    input: { dueAt?: Date; note?: string },
  ) {
    const [followUp] = await this.db
      .insert(cofounderFollowUps)
      .values({
        workspaceId,
        candidateId,
        dueAt: input.dueAt,
        note: input.note,
      })
      .returning();

    return followUp;
  }
}

// ─── Default Role Definitions ───

const DEFAULT_ROLES = [
  {
    name: 'engineering',
    description: 'Technical co-founder. Builds products, writes code, manages infrastructure.',
    defaultGoal: 'Build and ship the technical product. Write specs, create prototypes, manage code quality.',
    defaultConstraints: [
      'No production deployments without approval',
      'External API integrations require approval',
      'Budget limit per task applies',
    ],
    defaultTools: [
      'search_knowledge',
      'create_note',
      'draft_text',
      'analyze',
    ],
    systemPrompt: 'You are a technical co-founder operator. Focus on building, shipping, and technical quality. Break complex builds into small, testable steps.',
  },
  {
    name: 'product',
    description: 'Product co-founder. Defines what to build, validates market fit, prioritizes features.',
    defaultGoal: 'Define product direction. Validate opportunities, write specs, prioritize features, track user needs.',
    defaultConstraints: [
      'User research outreach requires approval',
      'Public-facing content requires approval',
    ],
    defaultTools: [
      'search_knowledge',
      'create_note',
      'draft_text',
      'analyze',
      'list_opportunities',
    ],
    systemPrompt: 'You are a product co-founder operator. Focus on what to build and why. Validate hypotheses before building. Think in terms of user problems, not solutions.',
  },
  {
    name: 'growth',
    description: 'Growth co-founder. Acquires users, runs experiments, manages distribution channels.',
    defaultGoal: 'Grow the user base. Identify channels, run experiments, create marketing content, track metrics.',
    defaultConstraints: [
      'All external communications require approval',
      'Ad spend requires approval',
      'Social media posts require approval',
    ],
    defaultTools: [
      'search_knowledge',
      'create_note',
      'draft_text',
      'analyze',
    ],
    systemPrompt: 'You are a growth co-founder operator. Focus on distribution and user acquisition. Think in terms of channels, experiments, and metrics.',
  },
  {
    name: 'design',
    description: 'Design co-founder. Creates UX/UI, brand assets, and visual identity.',
    defaultGoal: 'Design the product experience. Create wireframes, define brand, ensure usability.',
    defaultConstraints: [
      'Brand-facing assets require approval',
    ],
    defaultTools: [
      'search_knowledge',
      'create_note',
      'draft_text',
      'analyze',
    ],
    systemPrompt: 'You are a design co-founder operator. Focus on user experience, visual clarity, and brand consistency. Simple beats complex.',
  },
  {
    name: 'ops',
    description: 'Operations co-founder. Manages processes, finances, compliance, and team coordination.',
    defaultGoal: 'Keep operations running. Track budget, manage processes, ensure compliance, coordinate work.',
    defaultConstraints: [
      'Financial transactions require approval',
      'Legal/compliance decisions require approval',
    ],
    defaultTools: [
      'search_knowledge',
      'create_note',
      'draft_text',
      'analyze',
    ],
    systemPrompt: 'You are an operations co-founder operator. Focus on process, efficiency, and coordination. Track what matters, automate what you can.',
  },
];

// ─── Types ───

export interface StrengthInput {
  dimension: string;
  score: number;
}

export interface ComplementScore {
  roleName: string;
  founderScore: number;
  gap: number;
  priority: 'critical' | 'recommended' | 'optional';
  reason: string;
}

export interface CofounderCandidateInput {
  source?: string;
  externalId?: string;
  profileUrl?: string;
  name: string;
  headline?: string;
  location?: string;
  bio?: string;
  strengths?: string[];
  interests?: string[];
  preferredRoles?: string[];
  rawProfile?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface CofounderMatchScore {
  overallScore: number;
  complementScore: number;
  executionScore: number;
  ycFitScore: number;
  riskScore: number;
  reasoning: string;
  scoringMethod: 'heuristic' | 'llm';
}

type CandidateDimension = keyof ReturnType<typeof inferCandidateDimensions>;

function scoreCandidateHeuristically(
  founder: { interests?: unknown; experience?: string | null; startupVector?: string | null } | undefined,
  founderScores: Array<{ dimension: string; score: number }>,
  candidate: {
    strengths?: unknown;
    interests?: unknown;
    preferredRoles?: unknown;
    headline?: string | null;
    bio?: string | null;
  },
): CofounderMatchScore {
  const candidateDimensions = inferCandidateDimensions(candidate);
  const founderMap = new Map(founderScores.map((score) => [score.dimension, score.score]));

  const weakAreas = (['technical', 'sales', 'design', 'ops', 'domain'] as CandidateDimension[]).map((dimension) => ({
    dimension,
    gap: 100 - (founderMap.get(dimension) ?? 40),
  }));

  const complementScore = weakAreas.reduce((acc, area) => {
    const candidateScore = candidateDimensions[area.dimension] ?? 20;
    return acc + (candidateScore * area.gap) / 100;
  }, 0) / Math.max(weakAreas.length, 1);

  const executionScore =
    ((candidateDimensions['technical'] ?? 20) +
      (candidateDimensions['ops'] ?? 20) +
      (candidateDimensions['domain'] ?? 20)) /
    3;

  const founderInterestTerms = normaliseTerms(founder?.interests);
  const candidateInterestTerms = normaliseTerms(candidate.interests);
  const sharedInterestCount = candidateInterestTerms.filter((term) => founderInterestTerms.includes(term)).length;
  const ycFitScore = clampScore(
    40 +
      sharedInterestCount * 8 +
      ((candidateDimensions['product'] ?? 0) + (candidateDimensions['growth'] ?? 0)) / 4,
  );

  const missingBioPenalty = candidate.bio ? 0 : 12;
  const lowSignalPenalty = Object.values(candidateDimensions).every((value) => value < 30) ? 18 : 0;
  const riskScore = clampScore(20 + missingBioPenalty + lowSignalPenalty);

  const overallScore = clampScore(
    complementScore * 0.4 +
      executionScore * 0.25 +
      ycFitScore * 0.25 +
      (100 - riskScore) * 0.1,
  );

  const strongestDimension = Object.entries(candidateDimensions).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'domain';
  const founderVector = founder?.startupVector?.trim() || 'the current startup direction';
  const reasoning = `${candidate.headline ?? candidate.bio?.slice(0, 120) ?? 'Candidate'} appears strongest in ${strongestDimension}. They complement the founder most around ${weakAreas.sort((a, b) => b.gap - a.gap)[0]?.dimension ?? 'execution'} and look ${overallScore >= 70 ? 'like a strong' : overallScore >= 55 ? 'like a plausible' : 'like a weak'} fit for ${founderVector}.`;

  return {
    overallScore,
    complementScore: clampScore(complementScore),
    executionScore: clampScore(executionScore),
    ycFitScore,
    riskScore,
    reasoning,
    scoringMethod: 'heuristic',
  };
}

function inferCandidateDimensions(candidate: {
  strengths?: unknown;
  preferredRoles?: unknown;
  headline?: string | null;
  bio?: string | null;
}) {
  const corpus = [
    ...normaliseTerms(candidate.strengths),
    ...normaliseTerms(candidate.preferredRoles),
    ...normaliseTerms(candidate.headline),
    ...normaliseTerms(candidate.bio),
  ].join(' ');

  const scoreFromKeywords = (keywords: string[]) =>
    clampScore(20 + keywords.filter((keyword) => corpus.includes(keyword)).length * 18);

  return {
    technical: scoreFromKeywords(['engineer', 'technical', 'backend', 'frontend', 'ai', 'ml', 'cto', 'full-stack']),
    sales: scoreFromKeywords(['sales', 'revenue', 'closing', 'enterprise', 'bd', 'account']),
    design: scoreFromKeywords(['design', 'ux', 'ui', 'brand', 'visual']),
    ops: scoreFromKeywords(['ops', 'operations', 'finance', 'legal', 'project', 'execution']),
    domain: scoreFromKeywords(['industry', 'domain', 'market', 'research', 'expert']),
    product: scoreFromKeywords(['product', 'pm', 'roadmap', 'spec', 'discovery']),
    growth: scoreFromKeywords(['growth', 'marketing', 'distribution', 'community', 'seo']),
  };
}

function normaliseTerms(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).toLowerCase());
  }

  if (typeof value === 'string') {
    return value.toLowerCase().split(/[^a-z0-9+.-]+/).filter(Boolean);
  }

  return [];
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function stripCodeFence(value: string) {
  return value.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
}

function buildCandidateScoringPrompt(
  founder: { name: string; background: string | null; experience: string | null; startupVector: string | null } | undefined,
  founderScores: Array<{ dimension: string; score: number; evidence?: string | null }>,
  candidate: {
    name: string;
    headline: string | null;
    bio: string | null;
    strengths?: unknown;
    interests?: unknown;
    preferredRoles?: unknown;
  },
) {
  return `You are scoring a real human co-founder candidate for Pilot.

Founder:
${JSON.stringify({
    founder,
    strengths: founderScores,
  })}

Candidate:
${JSON.stringify(candidate)}

Return JSON only:
{
  "overallScore": 0-100,
  "complementScore": 0-100,
  "executionScore": 0-100,
  "ycFitScore": 0-100,
  "riskScore": 0-100,
  "reasoning": "2-3 sentence explanation"
}

Prioritize complementarity, founder gap coverage, ability to build or sell quickly, and fit for an ambitious YC-style startup journey.`;
}
