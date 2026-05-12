import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { and, eq } from 'drizzle-orm';
import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { appendEvidenceItem } from '@pilot/db';
import { users, sessions, apiKeys, workspaces, workspaceMembers, auditLog } from '@pilot/db/schema';
import {
  clearSessionCookies,
  generateApiKey,
  generateToken,
  hashApiKey,
  SESSION_COOKIE_NAME,
  setSessionCookies,
} from '../middleware/auth.js';
import { type GatewayDeps } from '../index.js';
import { getWorkspaceId, requireWorkspaceRole } from '../lib/workspace.js';

const TELEGRAM_AUTH_MAX_AGE_SECONDS = 24 * 60 * 60;
const TELEGRAM_AUTH_FUTURE_SKEW_SECONDS = 60;
const EMAIL_CODE_TTL_MS = 15 * 60 * 1000;
const EMAIL_CODE_MAX_ATTEMPTS = 5;

export function authRoutes(deps: GatewayDeps) {
  const app = new Hono();

  // POST /api/auth/telegram — Validate Telegram Web App init data, create session
  app.post('/telegram', async (c) => {
    const body = await c.req.json();
    const initData: string | undefined = body.initData;
    if (!initData) {
      return c.json({ error: 'initData required' }, 400);
    }

    const botToken = process.env['TELEGRAM_BOT_TOKEN'];
    if (!botToken) {
      return c.json({ error: 'Telegram not configured' }, 503);
    }

    // Validate Telegram Web App initData (HMAC)
    const parsed = validateTelegramInitData(initData, botToken);
    if (!parsed) {
      return c.json({ error: 'Invalid Telegram initData' }, 401);
    }

    const telegramId = parsed.id.toString();
    const name = [parsed.first_name, parsed.last_name].filter(Boolean).join(' ') || 'Founder';

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const verified = await deps.db
      .transaction(async (tx) => {
        let [user] = await tx.select().from(users).where(eq(users.telegramId, telegramId)).limit(1);
        let userCreated = false;

        if (!user) {
          [user] = await tx.insert(users).values({ telegramId, name }).returning();
          userCreated = Boolean(user);
        }

        if (!user) throw new Error('failed to resolve telegram user');

        let [membership] = await tx
          .select()
          .from(workspaceMembers)
          .where(eq(workspaceMembers.userId, user.id))
          .limit(1);
        let workspaceCreated = false;

        if (!membership) {
          const [ws] = await tx
            .insert(workspaces)
            .values({ name: `${name}'s Workspace`, ownerId: user.id })
            .returning();
          if (ws) {
            workspaceCreated = true;
            [membership] = await tx
              .insert(workspaceMembers)
              .values({ workspaceId: ws.id, userId: user.id, role: 'owner' })
              .returning();
          }
        }

        if (!membership) throw new Error('failed to resolve telegram workspace');

        await tx.insert(sessions).values({
          userId: user.id,
          token,
          channel: 'telegram',
          expiresAt,
        });

        const auditEventId = randomUUID();
        const replayRef = `auth-telegram:${membership.workspaceId}:${user.id}:verified`;
        const evidenceMetadata = {
          workspaceId: membership.workspaceId,
          userId: user.id,
          userCreated,
          workspaceCreated,
          telegramIdHash: stableAuthEvidenceHash(telegramId),
          telegramAuthDate: parsed.authDate,
          initDataStoredInEvidence: false,
          botTokenStoredInEvidence: false,
          telegramIdStoredInEvidence: false,
          sessionTokenStoredInEvidence: false,
        };

        await tx.insert(auditLog).values({
          id: auditEventId,
          workspaceId: membership.workspaceId,
          action: 'AUTH_TELEGRAM_VERIFIED',
          actor: `user:${user.id}`,
          target: membership.workspaceId,
          verdict: 'allow',
          metadata: {
            evidenceType: 'auth_telegram_verified',
            replayRef,
            evidenceItemId: null,
            ...evidenceMetadata,
          },
        });

        const evidenceItemId = await appendEvidenceItem(tx, {
          workspaceId: membership.workspaceId,
          auditEventId,
          evidenceType: 'auth_telegram_verified',
          sourceType: 'gateway_auth',
          title: 'Telegram login verified',
          summary:
            'A Telegram Web App login was verified; init data, bot token, Telegram ID, and session token were not stored in evidence.',
          redactionState: 'redacted',
          sensitivity: 'sensitive',
          contentHash: `sha256:${stableAuthEvidenceHash(JSON.stringify(evidenceMetadata))}`,
          replayRef,
          metadata: evidenceMetadata,
        });

        await tx
          .update(auditLog)
          .set({
            metadata: {
              evidenceType: 'auth_telegram_verified',
              replayRef,
              evidenceItemId,
              ...evidenceMetadata,
            },
          })
          .where(
            and(eq(auditLog.workspaceId, membership.workspaceId), eq(auditLog.id, auditEventId)),
          );

        return { user, membership, evidenceItemId };
      })
      .catch(() => null);

    if (!verified) {
      return c.json({ error: 'failed to persist telegram auth evidence' }, 500);
    }

    const csrfToken = setSessionCookies(c, token, expiresAt);

    // Resolve workspace name for the response
    let workspaceName = 'Workspace';
    const [ws] = await deps.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, verified.membership.workspaceId))
      .limit(1);
    if (ws) workspaceName = ws.name;

    return c.json({
      token,
      csrfToken,
      user: { id: verified.user.id, name: verified.user.name, telegramId },
      workspace: { id: verified.membership.workspaceId, name: workspaceName },
      expiresAt: expiresAt.toISOString(),
      evidenceItemId: verified.evidenceItemId,
    });
  });

  // POST /api/auth/email/request — Request magic link
  app.post('/email/request', async (c) => {
    const body = await c.req.json();
    const rawEmail = (body as { email: string }).email;
    const email = normalizeEmail(rawEmail);
    if (!email || !email.includes('@')) {
      return c.json({ error: 'Valid email required' }, 400);
    }

    // Generate a crypto-backed 6-digit code and store only an HMAC digest.
    const code = randomInt(100000, 1000000).toString();
    const magicToken = createMagicCodeSessionToken(email, code);

    // Store as a session with 'email_pending' channel (15-min expiry)
    // Find or create user by email
    let [user] = await deps.db.select().from(users).where(eq(users.email, email)).limit(1);

    if (!user) {
      [user] = await deps.db
        .insert(users)
        .values({ email, name: email.split('@')[0] ?? 'User' })
        .returning();
    }
    if (!user) return c.json({ error: 'Failed to create user' }, 500);

    // Store magic link token in sessions
    const expiresAt = new Date(Date.now() + EMAIL_CODE_TTL_MS);
    await deps.db.insert(sessions).values({
      userId: user.id,
      token: magicToken,
      channel: 'email_pending',
      expiresAt,
    });

    // Send email with the code + link. In dev (noop provider), also return code in response.
    const appUrl = process.env['APP_URL'] ?? 'http://localhost:3000';
    const linkUrl = `${appUrl}/login?email=${encodeURIComponent(email)}&code=${code}`;
    const isDev = process.env['NODE_ENV'] !== 'production';

    try {
      if (deps.emailProvider) {
        await deps.emailProvider.sendMagicLink({ to: email, code, linkUrl });
      }
      await recordAuthAudit(deps, {
        action: 'auth.email.request',
        actor: email,
        verdict: 'allow',
        reason: 'magic_code_issued',
      });
    } catch (err) {
      const log = (await import('@pilot/shared/logger')).createLogger('auth');
      log.error({ err, email }, 'Failed to send magic link email');
      await recordAuthAudit(deps, {
        action: 'auth.email.request',
        actor: email,
        verdict: 'deny',
        reason: 'email_delivery_failed',
      });
      // In production, fail the request — user has no way to get the code.
      // In dev, still return the code so developers can log in.
      if (!isDev) {
        return c.json({ error: 'Failed to send login email. Please try again.' }, 502);
      }
    }

    return c.json({
      sent: true,
      email,
      // Dev-only: return code in response when the provider is noop.
      // In production (resend/smtp), the code is delivered via email only.
      ...(isDev && deps.emailProvider?.kind === 'noop' ? { code } : {}),
    });
  });

  // POST /api/auth/email/verify — Verify magic link code
  app.post('/email/verify', async (c) => {
    const body = await c.req.json();
    const rawEmail = (body as { email: string; code: string }).email;
    const email = normalizeEmail(rawEmail);
    const { code } = body as { email: string; code: string };
    if (!email || !code) {
      return c.json({ error: 'email and code required' }, 400);
    }

    // Find the user
    const [user] = await deps.db.select().from(users).where(eq(users.email, email)).limit(1);
    if (!user) return c.json({ error: 'Invalid code' }, 401);

    // Find the magic session
    const allSessions = await deps.db.select().from(sessions).where(eq(sessions.userId, user.id));

    const pendingSessions = allSessions.filter(
      (s) => s.channel === 'email_pending' && new Date(s.expiresAt) > new Date(),
    );
    const magicSession = pendingSessions.find((s) => isMagicCodeSessionMatch(email, code, s.token));

    if (!magicSession) {
      await recordFailedMagicCodeAttempt(deps, pendingSessions);
      await recordAuthAudit(deps, {
        action: 'auth.email.verify',
        actor: email,
        verdict: 'deny',
        reason: 'invalid_or_expired_code',
      });
      return c.json({ error: 'Invalid or expired code' }, 401);
    }

    const token = generateToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const verified = await deps.db
      .transaction(async (tx) => {
        await tx.delete(sessions).where(eq(sessions.id, magicSession.id));

        let [membership] = await tx
          .select()
          .from(workspaceMembers)
          .where(eq(workspaceMembers.userId, user.id))
          .limit(1);
        let workspaceCreated = false;

        if (!membership) {
          const name = user.name ?? email.split('@')[0] ?? 'User';
          const [ws] = await tx
            .insert(workspaces)
            .values({ name: `${name}'s Workspace`, ownerId: user.id })
            .returning();
          if (ws) {
            workspaceCreated = true;
            [membership] = await tx
              .insert(workspaceMembers)
              .values({ workspaceId: ws.id, userId: user.id, role: 'owner' })
              .returning();
          }
        }

        if (!membership) throw new Error('failed to resolve email verification workspace');

        await tx.insert(sessions).values({
          userId: user.id,
          token,
          channel: 'email',
          expiresAt,
        });

        const auditEventId = randomUUID();
        const replayRef = `auth-email:${membership.workspaceId}:${user.id}:verified`;
        const evidenceMetadata = {
          workspaceId: membership.workspaceId,
          userId: user.id,
          magicSessionId: magicSession.id,
          workspaceCreated,
          emailHash: stableAuthEvidenceHash(email),
          emailStoredInEvidence: false,
          magicCodeStoredInEvidence: false,
          magicSessionTokenStoredInEvidence: false,
          sessionTokenStoredInEvidence: false,
        };

        await tx.insert(auditLog).values({
          id: auditEventId,
          workspaceId: membership.workspaceId,
          action: 'AUTH_EMAIL_VERIFIED',
          actor: `user:${user.id}`,
          target: membership.workspaceId,
          verdict: 'allow',
          metadata: {
            evidenceType: 'auth_email_verified',
            replayRef,
            evidenceItemId: null,
            ...evidenceMetadata,
          },
        });

        const evidenceItemId = await appendEvidenceItem(tx, {
          workspaceId: membership.workspaceId,
          auditEventId,
          evidenceType: 'auth_email_verified',
          sourceType: 'gateway_auth',
          title: 'Email login verified',
          summary:
            'A magic-code email login was redeemed; code and session tokens were not stored in evidence.',
          redactionState: 'redacted',
          sensitivity: 'sensitive',
          contentHash: `sha256:${stableAuthEvidenceHash(JSON.stringify(evidenceMetadata))}`,
          replayRef,
          metadata: evidenceMetadata,
        });

        await tx
          .update(auditLog)
          .set({
            metadata: {
              evidenceType: 'auth_email_verified',
              replayRef,
              evidenceItemId,
              ...evidenceMetadata,
            },
          })
          .where(
            and(eq(auditLog.workspaceId, membership.workspaceId), eq(auditLog.id, auditEventId)),
          );

        return { membership, evidenceItemId };
      })
      .catch(() => null);

    if (!verified) {
      return c.json({ error: 'failed to persist email verification evidence' }, 500);
    }

    const csrfToken = setSessionCookies(c, token, expiresAt);

    let workspaceName = 'Workspace';
    const [ws] = await deps.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, verified.membership.workspaceId))
      .limit(1);
    if (ws) workspaceName = ws.name;

    return c.json({
      token,
      csrfToken,
      user: { id: user.id, name: user.name, email },
      workspace: { id: verified.membership.workspaceId, name: workspaceName },
      expiresAt: expiresAt.toISOString(),
      evidenceItemId: verified.evidenceItemId,
    });
  });

  // DELETE /api/auth/session — Logout
  app.delete('/session', async (c) => {
    const authHeader = c.req.header('Authorization');
    const cookieToken = getCookie(c, SESSION_COOKIE_NAME);
    if (!authHeader?.startsWith('Bearer ') && !cookieToken) {
      return c.json({ error: 'No session' }, 400);
    }
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : cookieToken;
    if (!token) return c.json({ error: 'No session' }, 400);

    const [session] = await deps.db
      .select()
      .from(sessions)
      .where(eq(sessions.token, token))
      .limit(1);
    if (!session) {
      await deps.db.delete(sessions).where(eq(sessions.token, token));
      clearSessionCookies(c);
      return c.json({ ok: true });
    }

    const [membership] = await deps.db
      .select()
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, session.userId))
      .limit(1);

    if (!membership) {
      await deps.db.delete(sessions).where(eq(sessions.id, session.id));
      clearSessionCookies(c);
      return c.json({ ok: true });
    }

    const evidenceItemId = await deps.db
      .transaction(async (tx) => {
        const auditEventId = randomUUID();
        const replayRef = `auth-session:${membership.workspaceId}:${session.userId}:deleted`;
        const evidenceMetadata = {
          workspaceId: membership.workspaceId,
          userId: session.userId,
          sessionId: session.id,
          channel: session.channel,
          tokenHash: stableAuthEvidenceHash(token),
          tokenStoredInEvidence: false,
          cookieTokenStoredInEvidence: false,
        };

        await tx.insert(auditLog).values({
          id: auditEventId,
          workspaceId: membership.workspaceId,
          action: 'AUTH_SESSION_DELETED',
          actor: `user:${session.userId}`,
          target: session.id,
          verdict: 'allow',
          metadata: {
            evidenceType: 'auth_session_deleted',
            replayRef,
            evidenceItemId: null,
            ...evidenceMetadata,
          },
        });

        const createdEvidenceItemId = await appendEvidenceItem(tx, {
          workspaceId: membership.workspaceId,
          auditEventId,
          evidenceType: 'auth_session_deleted',
          sourceType: 'gateway_auth',
          title: 'Auth session deleted',
          summary: 'A user session was deleted; session token material was not stored in evidence.',
          redactionState: 'redacted',
          sensitivity: 'sensitive',
          contentHash: `sha256:${stableAuthEvidenceHash(JSON.stringify(evidenceMetadata))}`,
          replayRef,
          metadata: evidenceMetadata,
        });

        await tx
          .update(auditLog)
          .set({
            metadata: {
              evidenceType: 'auth_session_deleted',
              replayRef,
              evidenceItemId: createdEvidenceItemId,
              ...evidenceMetadata,
            },
          })
          .where(
            and(eq(auditLog.workspaceId, membership.workspaceId), eq(auditLog.id, auditEventId)),
          );

        await tx.delete(sessions).where(eq(sessions.id, session.id));

        return createdEvidenceItemId;
      })
      .catch(() => null);

    if (!evidenceItemId) {
      return c.json({ error: 'failed to persist session logout evidence' }, 500);
    }

    clearSessionCookies(c);
    return c.json({ ok: true, evidenceItemId });
  });

  // POST /api/auth/invite/:token — Accept workspace invite
  // Token format: invite:{workspaceId}:{role}:{randomToken}
  app.post('/invite/:token', async (c) => {
    const { token: inviteToken } = c.req.param();
    const body = await c.req.json();
    const { email } = body as { email?: string };
    if (!email) return c.json({ error: 'email required' }, 400);

    // Find the pending invite session by token prefix match
    const fullToken = `invite:${inviteToken}`;
    const [inviteSession] = await deps.db
      .select()
      .from(sessions)
      .where(eq(sessions.token, fullToken))
      .limit(1);

    if (
      !inviteSession ||
      inviteSession.channel !== 'invite' ||
      new Date(inviteSession.expiresAt) < new Date()
    ) {
      return c.json({ error: 'Invalid or expired invite' }, 401);
    }

    // Parse workspaceId and role from token
    // Token stored as: invite:{wsId}:{role}:{random}
    const parts = inviteSession.token.split(':');
    const workspaceId = parts[1];
    const role = parts[2] ?? 'member';

    if (!workspaceId) return c.json({ error: 'Malformed invite token' }, 400);

    const sessionToken = generateToken();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const accepted = await deps.db
      .transaction(async (tx) => {
        let [user] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
        if (!user) {
          [user] = await tx
            .insert(users)
            .values({ email, name: email.split('@')[0] ?? 'User' })
            .returning();
        }
        if (!user) throw new Error('failed to create invite user');

        await tx
          .insert(workspaceMembers)
          .values({ workspaceId, userId: user.id, role })
          .onConflictDoNothing();

        await tx.delete(sessions).where(eq(sessions.id, inviteSession.id));

        await tx.insert(sessions).values({
          userId: user.id,
          token: sessionToken,
          channel: 'email',
          expiresAt,
        });

        const auditEventId = randomUUID();
        const replayRef = `workspace-invite:${workspaceId}:${user.id}:accepted`;
        const evidenceMetadata = {
          workspaceId,
          userId: user.id,
          role,
          inviteSessionId: inviteSession.id,
          emailHash: stableAuthEvidenceHash(email),
          emailStoredInEvidence: false,
          inviteTokenStoredInEvidence: false,
          sessionTokenStoredInEvidence: false,
        };

        await tx.insert(auditLog).values({
          id: auditEventId,
          workspaceId,
          action: 'WORKSPACE_INVITE_ACCEPTED',
          actor: `user:${user.id}`,
          target: workspaceId,
          verdict: 'allow',
          metadata: {
            evidenceType: 'workspace_invite_accepted',
            replayRef,
            evidenceItemId: null,
            ...evidenceMetadata,
          },
        });

        const evidenceItemId = await appendEvidenceItem(tx, {
          workspaceId,
          auditEventId,
          evidenceType: 'workspace_invite_accepted',
          sourceType: 'gateway_auth',
          title: 'Workspace invite accepted',
          summary:
            'A user accepted a workspace invite; invite token, email, and session token were not stored in evidence.',
          redactionState: 'redacted',
          sensitivity: 'sensitive',
          contentHash: `sha256:${stableAuthEvidenceHash(JSON.stringify(evidenceMetadata))}`,
          replayRef,
          metadata: evidenceMetadata,
        });

        await tx
          .update(auditLog)
          .set({
            metadata: {
              evidenceType: 'workspace_invite_accepted',
              replayRef,
              evidenceItemId,
              ...evidenceMetadata,
            },
          })
          .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

        return { user, evidenceItemId };
      })
      .catch(() => null);

    if (!accepted) return c.json({ error: 'failed to persist invite acceptance evidence' }, 500);

    const csrfToken = setSessionCookies(c, sessionToken, expiresAt);

    return c.json({
      token: sessionToken,
      csrfToken,
      user: { id: accepted.user.id, name: accepted.user.name, email: accepted.user.email },
      workspaceId,
      role,
      evidenceItemId: accepted.evidenceItemId,
    });
  });

  return app;
}

export function authenticatedAuthRoutes(deps: GatewayDeps) {
  const app = new Hono();

  // POST /api/auth/apikey — Create an API key (requires auth)
  app.post('/apikey', async (c) => {
    const userId = c.get('userId') as string | undefined;
    if (!userId) return c.json({ error: 'Unauthorized' }, 401);
    const workspaceId = getWorkspaceId(c);
    if (!workspaceId) return c.json({ error: 'workspaceId required' }, 400);
    const roleDenied = requireWorkspaceRole(c, 'owner', 'create API keys');
    if (roleDenied) return roleDenied;

    const body = await c.req.json().catch(() => ({}));
    const name = (body as { name?: string }).name ?? 'default';

    const rawKey = generateApiKey();
    const keyHash = hashApiKey(rawKey);
    const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

    const evidenceItemId = await deps.db
      .transaction(async (tx) => {
        await tx.insert(apiKeys).values({ userId, name, keyHash, expiresAt });

        const auditEventId = randomUUID();
        const replayRef = `api-key:${workspaceId}:${userId}:${name}:created`;
        const evidenceMetadata = {
          apiKeyName: name,
          expiresAt: expiresAt.toISOString(),
          userId,
          keyMaterialStoredInEvidence: false,
          keyHashStoredInEvidence: false,
        };

        await tx.insert(auditLog).values({
          id: auditEventId,
          workspaceId,
          action: 'API_KEY_CREATED',
          actor: `user:${userId}`,
          target: name,
          verdict: 'allow',
          metadata: {
            evidenceType: 'api_key_created',
            replayRef,
            ...evidenceMetadata,
          },
        });

        const createdEvidenceItemId = await appendEvidenceItem(tx, {
          workspaceId,
          auditEventId,
          evidenceType: 'api_key_created',
          sourceType: 'gateway_auth',
          title: `API key created: ${name}`,
          summary:
            'A workspace-scoped API key was created; key material was not stored in evidence.',
          redactionState: 'redacted',
          sensitivity: 'restricted',
          replayRef,
          metadata: evidenceMetadata,
        });

        await tx
          .update(auditLog)
          .set({
            metadata: {
              evidenceType: 'api_key_created',
              replayRef,
              evidenceItemId: createdEvidenceItemId,
              ...evidenceMetadata,
            },
          })
          .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));

        return createdEvidenceItemId;
      })
      .catch(() => null);

    if (!evidenceItemId) {
      return c.json({ error: 'failed to persist api key evidence' }, 500);
    }

    return c.json({ key: rawKey, name, expiresAt: expiresAt.toISOString(), evidenceItemId }, 201);
  });

  return app;
}

function normalizeEmail(email: unknown): string {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function stableAuthEvidenceHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createMagicCodeSessionToken(email: string, code: string): string {
  const salt = randomBytes(16).toString('base64url');
  const digest = hashMagicCode(email, code, salt);
  return `magic:v2:${salt}:${digest}:0:${generateToken()}`;
}

function hashMagicCode(email: string, code: string, salt: string): string {
  const secret = process.env['SESSION_SECRET'] ?? 'dev-session-secret';
  return createHmac('sha256', secret)
    .update('pilot:email-code:v2')
    .update('\0')
    .update(email)
    .update('\0')
    .update(salt)
    .update('\0')
    .update(code)
    .digest('hex');
}

function isMagicCodeSessionMatch(email: string, code: string, token: string): boolean {
  const parsed = parseMagicCodeSessionToken(token);
  if (!parsed) return false;

  if (parsed.version === 'legacy') {
    return timingSafeStringEqual(code, parsed.code);
  }

  if (parsed.attempts >= EMAIL_CODE_MAX_ATTEMPTS) return false;
  return timingSafeHexEqual(hashMagicCode(email, code, parsed.salt), parsed.digest);
}

function parseMagicCodeSessionToken(
  token: string,
):
  | { version: 'v2'; salt: string; digest: string; attempts: number; nonce: string }
  | { version: 'legacy'; code: string }
  | null {
  const parts = token.split(':');
  if (parts[0] !== 'magic') return null;

  if (parts[1] === 'v2') {
    const [, , salt, digest, attemptsRaw, nonce] = parts;
    const attempts = Number(attemptsRaw);
    if (!salt || !digest || !Number.isInteger(attempts) || !nonce) return null;
    return { version: 'v2', salt, digest, attempts, nonce };
  }

  if (parts.length >= 3 && /^\d{6}$/.test(parts[1] ?? '')) {
    return { version: 'legacy', code: parts[1] ?? '' };
  }

  return null;
}

async function recordFailedMagicCodeAttempt(
  deps: GatewayDeps,
  pendingSessions: Array<{ id: string; token: string }>,
) {
  for (const session of pendingSessions) {
    const parsed = parseMagicCodeSessionToken(session.token);
    if (!parsed || parsed.version !== 'v2') continue;

    const attempts = parsed.attempts + 1;
    if (attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
      await deps.db.delete(sessions).where(eq(sessions.id, session.id));
      continue;
    }

    const nextToken = `magic:v2:${parsed.salt}:${parsed.digest}:${attempts}:${parsed.nonce}`;
    await deps.db.update(sessions).set({ token: nextToken }).where(eq(sessions.id, session.id));
  }
}

function timingSafeHexEqual(leftHex: string, rightHex: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(leftHex) || !/^[0-9a-f]{64}$/i.test(rightHex)) return false;
  const left = Buffer.from(leftHex, 'hex');
  const right = Buffer.from(rightHex, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function recordAuthAudit(
  deps: GatewayDeps,
  entry: { action: string; actor: string; verdict: string; reason: string },
) {
  try {
    await deps.db.insert(auditLog).values({
      workspaceId: null,
      action: entry.action,
      actor: entry.actor,
      target: 'email_login',
      verdict: entry.verdict,
      reason: entry.reason,
      metadata: {},
    });
  } catch {
    // Public auth must not fail closed because an audit insert failed.
  }
}

// ─── Telegram Init Data Validation ───

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  authDate: number;
}

function validateTelegramInitData(initData: string, botToken: string): TelegramUser | null {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;

    const authDateRaw = params.get('auth_date');
    if (!authDateRaw || !/^\d+$/.test(authDateRaw)) return null;
    const authDate = Number(authDateRaw);
    const now = Math.floor(Date.now() / 1000);
    const age = now - authDate;
    if (age > TELEGRAM_AUTH_MAX_AGE_SECONDS || age < -TELEGRAM_AUTH_FUTURE_SKEW_SECONDS) {
      return null;
    }

    params.delete('hash');
    const entries = [...params.entries()].sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join('\n');

    const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = createHmac('sha256', secretKey).update(dataCheckString).digest();
    const providedHash = Buffer.from(hash, 'hex');

    if (
      providedHash.length !== computedHash.length ||
      !timingSafeEqual(providedHash, computedHash)
    ) {
      return null;
    }

    const userStr = params.get('user');
    if (!userStr) return null;

    return { ...(JSON.parse(userStr) as Omit<TelegramUser, 'authDate'>), authDate };
  } catch {
    return null;
  }
}
