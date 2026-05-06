import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { appendEvidenceItem } from '@pilot/db';
import { type Db } from '@pilot/db/client';
import { auditLog, founderProfiles, founderAssessments, founderStrengths } from '@pilot/db/schema';

export interface FounderIntakeResult {
  profileId: string;
  evidenceItemId: string;
  name: string;
  background: string;
  experience: string;
  interests: string[];
  strengths: StrengthScore[];
  startupVector: string;
}

export interface StrengthScore {
  dimension: string;
  score: number;
  evidence: string;
}

export interface LlmProvider {
  complete(prompt: string): Promise<string>;
}

interface FounderIntelAuditContext {
  actorUserId?: string;
}

/**
 * FounderIntelService — Profile intake, strength inference, startup vector.
 *
 * Takes free-text founder descriptions, uses LLM to extract structured data,
 * scores strengths across 5 dimensions, and infers a startup direction.
 */
export class FounderIntelService {
  constructor(
    private readonly db: Db,
    private readonly llm: LlmProvider,
  ) {}

  /**
   * Process a free-text founder intake message.
   * Extracts structured profile, infers strengths, generates startup vector.
   */
  async processIntake(
    workspaceId: string,
    rawText: string,
    auditContext: FounderIntelAuditContext = {},
  ): Promise<FounderIntakeResult> {
    // Step 1: Extract structured profile from free text
    const extracted = await this.extractProfile(rawText);

    return this.db.transaction(async (tx) => {
      // Step 2: Upsert founder profile
      const [profile] = await tx
        .insert(founderProfiles)
        .values({
          workspaceId,
          name: extracted.name,
          background: extracted.background,
          experience: extracted.experience,
          interests: extracted.interests,
          startupVector: extracted.startupVector,
        })
        .onConflictDoUpdate({
          target: founderProfiles.workspaceId,
          set: {
            name: extracted.name,
            background: extracted.background,
            experience: extracted.experience,
            interests: extracted.interests,
            startupVector: extracted.startupVector,
            updatedAt: new Date(),
          },
        })
        .returning();

      if (!profile) throw new Error('Failed to upsert founder profile');

      // Step 3: Save assessment record (provenance)
      await tx.insert(founderAssessments).values({
        founderId: profile.id,
        assessmentType: 'intake',
        responses: { rawText },
        analysis: extracted.startupVector,
      });

      // Step 4: Upsert strength scores — delete existing, then insert fresh
      await tx
        .delete(founderStrengths)
        .where(eq(founderStrengths.founderId, profile.id));

      for (const strength of extracted.strengths) {
        await tx.insert(founderStrengths).values({
          founderId: profile.id,
          dimension: strength.dimension,
          score: strength.score,
          evidence: strength.evidence,
        });
      }

      const auditEventId = randomUUID();
      const replayRef = `founder-intake:${workspaceId}:${profile.id}`;
      const auditMetadata = {
        profileId: profile.id,
        assessmentType: 'intake',
        rawTextLength: rawText.length,
        interestCount: extracted.interests.length,
        strengthCount: extracted.strengths.length,
        startupVectorPresent: Boolean(extracted.startupVector),
        evidenceContract: 'founder_intake_evidence_required',
      };

      await tx.insert(auditLog).values({
        id: auditEventId,
        workspaceId,
        action: 'FOUNDER_INTAKE_ANALYZED',
        actor: `user:${auditContext.actorUserId ?? 'unknown'}`,
        target: profile.id,
        verdict: 'allow',
        metadata: {
          evidenceType: 'founder_intake_analyzed',
          replayRef,
          ...auditMetadata,
        },
      });

      const evidenceItemId = await appendEvidenceItem(tx, {
        workspaceId,
        auditEventId,
        evidenceType: 'founder_intake_analyzed',
        sourceType: 'founder_intel',
        title: `Founder intake analyzed: ${profile.id}`,
        summary: `Founder intake updated profile ${profile.id} and ${extracted.strengths.length} strength scores.`,
        redactionState: 'redacted',
        sensitivity: 'internal',
        replayRef,
        metadata: auditMetadata,
      });

      await tx
        .update(auditLog)
        .set({
          metadata: {
            evidenceType: 'founder_intake_analyzed',
            replayRef,
            evidenceItemId,
            ...auditMetadata,
          },
        })
        .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

      return {
        profileId: profile.id,
        evidenceItemId,
        name: extracted.name,
        background: extracted.background,
        experience: extracted.experience,
        interests: extracted.interests,
        strengths: extracted.strengths,
        startupVector: extracted.startupVector,
      };
    });
  }

  /**
   * Get existing profile for a workspace.
   */
  async getProfile(workspaceId: string) {
    const [profile] = await this.db
      .select()
      .from(founderProfiles)
      .where(eq(founderProfiles.workspaceId, workspaceId))
      .limit(1);
    if (!profile) return null;

    const strengths = await this.db
      .select()
      .from(founderStrengths)
      .where(eq(founderStrengths.founderId, profile.id));

    return { ...profile, strengths };
  }

  /**
   * Use LLM to extract structured founder data from free text.
   */
  private async extractProfile(rawText: string): Promise<{
    name: string;
    background: string;
    experience: string;
    interests: string[];
    strengths: StrengthScore[];
    startupVector: string;
  }> {
    const prompt = buildExtractionPrompt(rawText);
    const response = await this.llm.complete(prompt);
    return parseExtractionResponse(response);
  }
}

// ─── Prompt Engineering ───

function buildExtractionPrompt(rawText: string): string {
  return `You are a founder profiling assistant for an autonomous startup operating system.

Analyze the following founder description and extract structured data.

<founder_description>
${rawText}
</founder_description>

Respond with a JSON object (no markdown, no code fences, just raw JSON):

{
  "name": "the founder's name (use 'Founder' if not mentioned)",
  "background": "1-2 sentence summary of professional/educational background",
  "experience": "1-2 sentence summary of relevant startup/industry experience",
  "interests": ["array", "of", "interest", "areas"],
  "strengths": [
    {"dimension": "technical", "score": 0-100, "evidence": "brief reason"},
    {"dimension": "sales", "score": 0-100, "evidence": "brief reason"},
    {"dimension": "design", "score": 0-100, "evidence": "brief reason"},
    {"dimension": "ops", "score": 0-100, "evidence": "brief reason"},
    {"dimension": "domain", "score": 0-100, "evidence": "brief reason"}
  ],
  "startupVector": "1-2 sentence recommendation of what kind of startup this founder should pursue based on their strengths and interests"
}

Scoring guide:
- 0-20: No evidence of capability
- 21-40: Some awareness, no practice
- 41-60: Moderate practical experience
- 61-80: Strong demonstrated skill
- 81-100: Expert/deep professional experience

Be honest in scoring. Infer from context. If information is sparse, score conservatively.`;
}

function parseExtractionResponse(response: string): {
  name: string;
  background: string;
  experience: string;
  interests: string[];
  strengths: StrengthScore[];
  startupVector: string;
} {
  // Strip potential markdown code fences
  const cleaned = response.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    return {
      name: String(parsed.name ?? 'Founder'),
      background: String(parsed.background ?? ''),
      experience: String(parsed.experience ?? ''),
      interests: Array.isArray(parsed.interests)
        ? parsed.interests.map(String)
        : [],
      strengths: Array.isArray(parsed.strengths)
        ? parsed.strengths.map((s: Record<string, unknown>) => ({
            dimension: String(s.dimension ?? 'unknown'),
            score: Math.max(0, Math.min(100, Number(s.score ?? 0))),
            evidence: String(s.evidence ?? ''),
          }))
        : defaultStrengths(),
      startupVector: String(parsed.startupVector ?? ''),
    };
  } catch {
    // Fallback: parse failed, return defaults with raw text as background
    return {
      name: 'Founder',
      background: response.slice(0, 200),
      experience: '',
      interests: [],
      strengths: defaultStrengths(),
      startupVector: '',
    };
  }
}

function defaultStrengths(): StrengthScore[] {
  return ['technical', 'sales', 'design', 'ops', 'domain'].map((d) => ({
    dimension: d,
    score: 25,
    evidence: 'Not enough information to assess',
  }));
}
