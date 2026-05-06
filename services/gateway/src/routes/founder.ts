import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { appendEvidenceItem } from '@pilot/db';
import {
  auditLog,
  cofounderCandidates,
  founderAssessments,
  founderProfiles,
  founderStrengths,
} from '@pilot/db/schema';
import {
  AnalyzeFounderInput,
  CreateCofounderCandidateInput,
  CreateCofounderNoteInput,
  CreateCofounderOutreachDraftInput,
  CreateFounderProfileInput,
} from '@pilot/shared/schemas';
import { type GatewayDeps } from '../index.js';
import { getWorkspaceId, requireWorkspaceRole } from '../lib/workspace.js';

export function founderRoutes(deps: GatewayDeps) {
  const app = new Hono();

  app.get('/profile', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);

    const profile = deps.founderIntel
      ? await deps.founderIntel.getProfile(workspaceId)
      : await getFounderProfileFallback(deps, workspaceId);

    if (!profile) return c.json({ error: 'No founder profile found' }, 404);
    return c.json(profile);
  });

  app.post('/profile', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'mutate founder profile');
    if (roleDenied) return roleDenied;

    const raw = await c.req.json();
    const parsed = CreateFounderProfileInput.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const result = await upsertFounderProfile(
      deps,
      workspaceId,
      parsed.data,
      c.get('userId'),
    ).catch(() => undefined);
    if (!result) return c.json({ error: 'Failed to upsert founder profile evidence' }, 500);
    return c.json({ ...result.profile, evidenceItemId: result.evidenceItemId }, 201);
  });

  app.post('/analyze', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);

    const raw = await c.req.json();
    const parsed = AnalyzeFounderInput.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    if (!deps.founderIntel) {
      return c.json({ error: 'Founder analysis requires an LLM provider' }, 503);
    }

    const result = await deps.founderIntel.processIntake(workspaceId, parsed.data.rawText);
    return c.json(result, 201);
  });

  app.get('/candidates', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    if (!deps.cofounderEngine) return c.json({ error: 'Cofounder engine unavailable' }, 503);

    const candidates = await deps.cofounderEngine.listCandidates(workspaceId);
    return c.json(candidates);
  });

  app.post('/candidates', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    if (!deps.cofounderEngine) return c.json({ error: 'Cofounder engine unavailable' }, 503);

    const raw = await c.req.json();
    const parsed = CreateCofounderCandidateInput.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const candidate = await deps.cofounderEngine.createCandidate(workspaceId, parsed.data);
    return c.json(candidate, 201);
  });

  app.post('/candidates/compare', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    if (!deps.cofounderEngine) return c.json({ error: 'Cofounder engine unavailable' }, 503);

    const body = (await c.req.json().catch(() => ({}))) as { candidateIds?: string[] };
    if (!Array.isArray(body.candidateIds) || body.candidateIds.length < 2) {
      return c.json({ error: 'candidateIds must contain at least two ids' }, 400);
    }

    const results = await Promise.all(
      body.candidateIds.map((candidateId) => deps.cofounderEngine!.getCandidate(candidateId)),
    );
    const filtered = results.filter(
      (candidate) => candidate && candidate.workspaceId === workspaceId,
    );
    return c.json(filtered);
  });

  app.get('/candidates/:id', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    if (!deps.cofounderEngine) return c.json({ error: 'Cofounder engine unavailable' }, 503);

    const { id } = c.req.param();
    const candidate = await deps.cofounderEngine.getCandidate(id);
    if (!candidate || candidate.workspaceId !== workspaceId) {
      return c.json({ error: 'Candidate not found' }, 404);
    }
    return c.json(candidate);
  });

  app.post('/candidates/:id/score', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    if (!deps.cofounderEngine) return c.json({ error: 'Cofounder engine unavailable' }, 503);

    const { id } = c.req.param();
    try {
      const evaluation = await deps.cofounderEngine.scoreCandidate(workspaceId, id);
      return c.json(evaluation, 201);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Failed to score candidate' },
        404,
      );
    }
  });

  app.post('/candidates/:id/notes', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    if (!deps.cofounderEngine) return c.json({ error: 'Cofounder engine unavailable' }, 503);

    const raw = await c.req.json();
    const parsed = CreateCofounderNoteInput.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const { id } = c.req.param();
    const note = await deps.cofounderEngine.addCandidateNote(
      workspaceId,
      id,
      parsed.data.content,
      parsed.data.noteType,
      c.get('userId'),
    );
    return c.json(note, 201);
  });

  app.post('/candidates/:id/outreach', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    if (!deps.cofounderEngine) return c.json({ error: 'Cofounder engine unavailable' }, 503);

    const raw = await c.req.json();
    const parsed = CreateCofounderOutreachDraftInput.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const { id } = c.req.param();
    const draft = await deps.cofounderEngine.createOutreachDraft(workspaceId, id, parsed.data);
    return c.json(draft, 201);
  });

  app.post('/candidates/:id/follow-ups', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    if (!deps.cofounderEngine) return c.json({ error: 'Cofounder engine unavailable' }, 503);

    const { id } = c.req.param();
    const body = (await c.req.json()) as { dueAt?: string; note?: string };
    const followUp = await deps.cofounderEngine.createFollowUp(workspaceId, id, {
      dueAt: body.dueAt ? new Date(body.dueAt) : undefined,
      note: body.note,
    });
    return c.json(followUp, 201);
  });

  app.post('/candidates/:id/conversations', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    if (!deps.cofounderEngine) return c.json({ error: 'Cofounder engine unavailable' }, 503);

    const body = (await c.req.json().catch(() => ({}))) as { content?: string };
    if (!body.content) return c.json({ error: 'content required' }, 400);

    const { id } = c.req.param();
    const note = await deps.cofounderEngine.addCandidateNote(
      workspaceId,
      id,
      body.content,
      'conversation',
      c.get('userId'),
    );
    return c.json(note, 201);
  });

  app.put('/candidates/:id/status', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'mutate cofounder candidate status');
    if (roleDenied) return roleDenied;

    const body = (await c.req.json().catch(() => ({}))) as { status?: string };
    const allowed = new Set([
      'new',
      'reviewing',
      'contacted',
      'interviewing',
      'shortlisted',
      'passed',
    ]);
    if (!body.status || !allowed.has(body.status)) {
      return c.json(
        {
          error:
            'status must be one of new, reviewing, contacted, interviewing, shortlisted, passed',
        },
        400,
      );
    }

    const candidateId = c.req.param('id');
    const result = await deps.db
      .transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(cofounderCandidates)
          .where(
            and(
              eq(cofounderCandidates.id, candidateId),
              eq(cofounderCandidates.workspaceId, workspaceId),
            ),
          )
          .limit(1);

        if (!existing) return null;

        const [candidate] = await tx
          .update(cofounderCandidates)
          .set({ status: body.status, updatedAt: new Date() })
          .where(
            and(
              eq(cofounderCandidates.id, candidateId),
              eq(cofounderCandidates.workspaceId, workspaceId),
            ),
          )
          .returning();

        if (!candidate) throw new Error('failed to update candidate status');

        const auditEventId = randomUUID();
        const replayRef = `cofounder-candidate:${workspaceId}:${candidateId}:status:${existing.status}->${body.status}`;
        const auditMetadata = {
          candidateId,
          previousStatus: existing.status,
          status: body.status,
          evidenceContract: 'cofounder_candidate_status_evidence_required',
        };

        await tx.insert(auditLog).values({
          id: auditEventId,
          workspaceId,
          action: 'COFOUNDER_CANDIDATE_STATUS_UPDATED',
          actor: `user:${c.get('userId') ?? 'unknown'}`,
          target: candidateId,
          verdict: 'allow',
          metadata: {
            evidenceType: 'cofounder_candidate_status_updated',
            replayRef,
            ...auditMetadata,
          },
        });

        const evidenceItemId = await appendEvidenceItem(tx, {
          workspaceId,
          auditEventId,
          evidenceType: 'cofounder_candidate_status_updated',
          sourceType: 'gateway_founder',
          title: `Cofounder candidate status updated: ${candidateId}`,
          summary: `Cofounder candidate status changed from ${existing.status} to ${body.status}.`,
          redactionState: 'none',
          sensitivity: 'internal',
          replayRef,
          metadata: auditMetadata,
        });

        await tx
          .update(auditLog)
          .set({
            metadata: {
              evidenceType: 'cofounder_candidate_status_updated',
              replayRef,
              evidenceItemId,
              ...auditMetadata,
            },
          })
          .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

        return { candidate, evidenceItemId };
      })
      .catch(() => undefined);

    if (result === null) return c.json({ error: 'Candidate not found' }, 404);
    if (result === undefined)
      return c.json({ error: 'Failed to update candidate status evidence' }, 500);

    return c.json({ ...result.candidate, evidenceItemId: result.evidenceItemId });
  });

  // Legacy compatibility routes while surfaces migrate.
  app.get('/:workspaceId', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    if (c.req.param('workspaceId') !== workspaceId) {
      return c.json({ error: 'workspaceId does not match authenticated workspace' }, 403);
    }

    const profile = deps.founderIntel
      ? await deps.founderIntel.getProfile(workspaceId)
      : await getFounderProfileFallback(deps, workspaceId);

    if (!profile) return c.json({ error: 'No founder profile found' }, 404);
    return c.json(profile);
  });

  app.post('/:workspaceId', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    if (c.req.param('workspaceId') !== workspaceId) {
      return c.json({ error: 'workspaceId does not match authenticated workspace' }, 403);
    }
    const roleDenied = requireWorkspaceRole(c, 'partner', 'mutate founder profile');
    if (roleDenied) return roleDenied;

    const raw = await c.req.json();
    const parsed = CreateFounderProfileInput.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }

    const result = await upsertFounderProfile(
      deps,
      workspaceId,
      parsed.data,
      c.get('userId'),
    ).catch(() => undefined);
    if (!result) return c.json({ error: 'Failed to upsert founder profile evidence' }, 500);
    return c.json({ ...result.profile, evidenceItemId: result.evidenceItemId }, 201);
  });

  app.post('/:founderId/assessment', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'partner', 'create founder assessment');
    if (roleDenied) return roleDenied;

    const { founderId } = c.req.param();
    const body = await c.req.json();
    if (!body.assessmentType || !body.responses) {
      return c.json({ error: 'assessmentType and responses are required' }, 400);
    }

    const result = await deps.db
      .transaction(async (tx) => {
        const [profile] = await tx
          .select({ id: founderProfiles.id })
          .from(founderProfiles)
          .where(
            and(eq(founderProfiles.id, founderId), eq(founderProfiles.workspaceId, workspaceId)),
          )
          .limit(1);
        if (!profile) return null;

        const [assessment] = await tx
          .insert(founderAssessments)
          .values({
            founderId,
            assessmentType: body.assessmentType,
            responses: body.responses,
            analysis: body.analysis,
          })
          .returning();
        if (!assessment) throw new Error('failed to create founder assessment');

        const auditEventId = randomUUID();
        const replayRef = `founder-assessment:${workspaceId}:${founderId}:${assessment.id}`;
        const auditMetadata = {
          founderId,
          assessmentId: assessment.id,
          assessmentType: body.assessmentType,
          evidenceContract: 'founder_assessment_evidence_required',
        };

        await tx.insert(auditLog).values({
          id: auditEventId,
          workspaceId,
          action: 'FOUNDER_ASSESSMENT_CREATED',
          actor: `user:${c.get('userId') ?? 'unknown'}`,
          target: assessment.id,
          verdict: 'allow',
          metadata: {
            evidenceType: 'founder_assessment_created',
            replayRef,
            ...auditMetadata,
          },
        });

        const evidenceItemId = await appendEvidenceItem(tx, {
          workspaceId,
          auditEventId,
          evidenceType: 'founder_assessment_created',
          sourceType: 'gateway_founder',
          title: `Founder assessment created: ${body.assessmentType}`,
          summary: `Founder assessment ${assessment.id} was created for founder profile ${founderId}.`,
          redactionState: 'none',
          sensitivity: 'internal',
          replayRef,
          metadata: auditMetadata,
        });

        await tx
          .update(auditLog)
          .set({
            metadata: {
              evidenceType: 'founder_assessment_created',
              replayRef,
              evidenceItemId,
              ...auditMetadata,
            },
          })
          .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

        return { assessment, evidenceItemId };
      })
      .catch(() => undefined);

    if (result === null) return c.json({ error: 'Founder profile not found' }, 404);
    if (result === undefined)
      return c.json({ error: 'Failed to create founder assessment evidence' }, 500);

    return c.json({ ...result.assessment, evidenceItemId: result.evidenceItemId }, 201);
  });

  app.get('/:founderId/strengths', async (c) => {
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);

    const { founderId } = c.req.param();
    const [profile] = await deps.db
      .select({ id: founderProfiles.id })
      .from(founderProfiles)
      .where(and(eq(founderProfiles.id, founderId), eq(founderProfiles.workspaceId, workspaceId)))
      .limit(1);
    if (!profile) return c.json({ error: 'Founder profile not found' }, 404);

    const strengths = await deps.db
      .select()
      .from(founderStrengths)
      .where(eq(founderStrengths.founderId, founderId));
    return c.json(strengths);
  });

  return app;
}

async function upsertFounderProfile(
  deps: GatewayDeps,
  workspaceId: string,
  body: {
    name: string;
    background?: string;
    experience?: string;
    interests: string[];
  },
  userId?: string,
) {
  return deps.db.transaction(async (tx) => {
    const [profile] = await tx
      .insert(founderProfiles)
      .values({
        workspaceId,
        name: body.name,
        background: body.background,
        experience: body.experience,
        interests: body.interests,
      })
      .onConflictDoUpdate({
        target: founderProfiles.workspaceId,
        set: {
          name: body.name,
          background: body.background,
          experience: body.experience,
          interests: body.interests,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!profile) throw new Error('failed to upsert founder profile');

    const auditEventId = randomUUID();
    const replayRef = `founder-profile:${workspaceId}:${profile.id}:upsert`;
    const auditMetadata = {
      founderProfileId: profile.id,
      fields: Object.keys(body).filter((key) => body[key as keyof typeof body] !== undefined),
      evidenceContract: 'founder_profile_evidence_required',
    };

    await tx.insert(auditLog).values({
      id: auditEventId,
      workspaceId,
      action: 'FOUNDER_PROFILE_UPSERTED',
      actor: `user:${userId ?? 'unknown'}`,
      target: profile.id,
      verdict: 'allow',
      metadata: {
        evidenceType: 'founder_profile_upserted',
        replayRef,
        ...auditMetadata,
      },
    });

    const evidenceItemId = await appendEvidenceItem(tx, {
      workspaceId,
      auditEventId,
      evidenceType: 'founder_profile_upserted',
      sourceType: 'gateway_founder',
      title: `Founder profile upserted: ${profile.id}`,
      summary: `Founder profile ${profile.id} was created or updated.`,
      redactionState: 'none',
      sensitivity: 'internal',
      replayRef,
      metadata: auditMetadata,
    });

    await tx
      .update(auditLog)
      .set({
        metadata: {
          evidenceType: 'founder_profile_upserted',
          replayRef,
          evidenceItemId,
          ...auditMetadata,
        },
      })
      .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

    return { profile, evidenceItemId };
  });
}

async function getFounderProfileFallback(deps: GatewayDeps, workspaceId: string) {
  const [profile] = await deps.db
    .select()
    .from(founderProfiles)
    .where(eq(founderProfiles.workspaceId, workspaceId))
    .limit(1);
  if (!profile) return null;

  const strengths = await deps.db
    .select()
    .from(founderStrengths)
    .where(eq(founderStrengths.founderId, profile.id));

  return { ...profile, strengths };
}
