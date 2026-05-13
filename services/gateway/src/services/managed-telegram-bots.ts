import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Bot, InlineKeyboard, type Context } from 'grammy';
import { and, desc, eq, gt, lt } from 'drizzle-orm';
import { appendEvidenceItem } from '@pilot/db';
import { TenantSecretStore } from '@pilot/db/tenant-secret-store';
import {
  auditLog,
  approvals,
  managedTelegramBotLeads,
  managedTelegramBotMessages,
  managedTelegramBotProvisioningRequests,
  managedTelegramBots,
  workspaces,
  workspaceMembers,
} from '@pilot/db/schema';
import { type Db } from '@pilot/db/client';
import {
  HelmDeniedError,
  HelmEscalationError,
  HelmUnreachableError,
  type HelmClient,
  type EvaluateResult,
} from '@pilot/helm-client';
import {
  type ManagedTelegramBotResponseMode,
  ManagedTelegramBotSettingsInput,
} from '@pilot/shared/schemas';
import { type LlmProvider, type LlmResult } from '@pilot/shared/llm';
import { type SecretKind } from '@pilot/shared/secrets';

const DEFAULT_WELCOME = 'Welcome. Join the launch list or send a support message.';
const DEFAULT_SUPPORT_PROMPT = 'Send your question and we will follow up.';
const PROVISIONING_TTL_MS = 15 * 60 * 1000;
const CHILD_BOT_CACHE_TTL_MS = 5 * 60 * 1000;

export const TELEGRAM_MANAGED_ACTIONS = {
  CLAIM: 'TELEGRAM_MANAGED_BOT_CLAIM',
  SET_WEBHOOK: 'TELEGRAM_CHILD_SET_WEBHOOK',
  DRAFT_SUPPORT: 'TELEGRAM_SUPPORT_DRAFT',
  REQUEST_SEND_APPROVAL: 'TELEGRAM_CHILD_SEND_MESSAGE_APPROVAL_REQUESTED',
  SEND_MESSAGE: 'TELEGRAM_CHILD_SEND_MESSAGE',
  ROTATE_TOKEN: 'TELEGRAM_CHILD_ROTATE_TOKEN',
  DISABLE: 'TELEGRAM_CHILD_DISABLE',
} as const;

type ManagedTelegramEffectLevel = 'E1' | 'E2' | 'E3' | 'E4';
type ManagedTelegramGovernanceMetadata = ReturnType<typeof managedTelegramGovernanceMetadata>;

export function managedTelegramActionEffectLevel(action: string): ManagedTelegramEffectLevel {
  switch (action) {
    case TELEGRAM_MANAGED_ACTIONS.DRAFT_SUPPORT:
      return 'E1';
    case TELEGRAM_MANAGED_ACTIONS.SEND_MESSAGE:
      return 'E2';
    case TELEGRAM_MANAGED_ACTIONS.CLAIM:
    case TELEGRAM_MANAGED_ACTIONS.SET_WEBHOOK:
    case TELEGRAM_MANAGED_ACTIONS.ROTATE_TOKEN:
    case TELEGRAM_MANAGED_ACTIONS.DISABLE:
      return 'E3';
    default:
      return 'E2';
  }
}

function isElevatedManagedTelegramAction(effectLevel: ManagedTelegramEffectLevel) {
  return effectLevel === 'E2' || effectLevel === 'E3' || effectLevel === 'E4';
}

type ManagedBotRow = typeof managedTelegramBots.$inferSelect;
type ManagedMessageRow = typeof managedTelegramBotMessages.$inferSelect;
type ManagedTelegramBotSettings = ReturnType<typeof ManagedTelegramBotSettingsInput.parse>;
type ManagedTelegramSupportDraft = {
  text: string;
  governanceMetadata: Record<string, unknown>;
};
type ManagedTelegramSendAudit = {
  auditEventId: string;
  evidenceItemId: string;
  replayRef: string;
  metadata: Record<string, unknown>;
};
type ManagedTelegramInboundEvidenceInput = {
  workspaceId: string;
  managedBotId: string;
  action: string;
  target: string;
  evidenceType: string;
  title: string;
  summary: string;
  replayRef: string;
  sensitivity: 'internal' | 'sensitive';
  metadata: Record<string, unknown>;
};
type ManagedTelegramControlEvidenceInput = {
  workspaceId: string;
  actor: string;
  action: string;
  target: string;
  evidenceType: string;
  title: string;
  summary: string;
  replayRef: string;
  sensitivity: 'internal' | 'confidential' | 'restricted';
  metadata: Record<string, unknown>;
  auditVerdict?: 'allow' | 'failed';
  auditReason?: string | null;
};
type ManagedTelegramWebhookSetupOptions = {
  actor: string;
  replayRef: string;
  summary: string;
};

export class ManagedTelegramBotError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly receipt?: unknown,
  ) {
    super(message);
  }
}

export interface ManagedTelegramBotServiceOptions {
  db: Db;
  helmClient?: HelmClient;
  managerBotToken?: string;
  managerBotUsername?: string;
  appUrl?: string;
  llm?: LlmProvider;
}

export interface LaunchBotProvisioningInput {
  workspaceId: string;
  userId: string;
  creatorTelegramId: string;
}

export interface ManagedBotClaimInput {
  creatorTelegramId: string;
  bot: {
    id: number | string;
    username?: string;
    firstName?: string;
  };
}

export class ManagedTelegramBotService {
  private readonly secrets: TenantSecretStore;
  private readonly childBotCache = new Map<string, { bot: Bot; token: string; cachedAt: number }>();
  private approvalNotifier:
    | ((workspaceId: string, approvalId: string, action: string, reason: string) => Promise<void>)
    | undefined;
  private supportNotifier:
    | ((workspaceId: string, messageId: string, managedBotUsername: string) => Promise<void>)
    | undefined;

  constructor(private readonly opts: ManagedTelegramBotServiceOptions) {
    this.secrets = new TenantSecretStore(opts.db);
  }

  setApprovalNotifier(
    notifier:
      | ((workspaceId: string, approvalId: string, action: string, reason: string) => Promise<void>)
      | undefined,
  ) {
    this.approvalNotifier = notifier;
  }

  setSupportNotifier(
    notifier:
      | ((workspaceId: string, messageId: string, managedBotUsername: string) => Promise<void>)
      | undefined,
  ) {
    this.supportNotifier = notifier;
  }

  setManagerBotUsername(username: string | undefined) {
    this.opts.managerBotUsername = username;
  }

  async createProvisioningRequest(input: LaunchBotProvisioningInput) {
    await this.ensureOwner(input.workspaceId, input.userId);
    if (!this.opts.managerBotToken) {
      throw new ManagedTelegramBotError('TELEGRAM_BOT_TOKEN is required', 503);
    }
    const managerBotUsername = await this.resolveManagerBotUsername();

    const [active] = await this.opts.db
      .select()
      .from(managedTelegramBots)
      .where(
        and(
          eq(managedTelegramBots.workspaceId, input.workspaceId),
          eq(managedTelegramBots.purpose, 'launch_support'),
          eq(managedTelegramBots.status, 'active'),
        ),
      )
      .limit(1);
    if (active) {
      throw new ManagedTelegramBotError('Workspace already has an active launch/support bot', 409);
    }

    const [workspace] = await this.opts.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .limit(1);
    if (!workspace) throw new ManagedTelegramBotError('Workspace not found', 404);

    const suggestedName = `${workspace.name} Launch Support`.slice(0, 64);
    const suggestedUsername = buildSuggestedBotUsername(workspace.name);
    const creationUrl = buildCreationUrl(managerBotUsername, suggestedUsername, suggestedName);
    const expiresAt = new Date(Date.now() + PROVISIONING_TTL_MS);

    const requestId = randomUUID();
    const [request] = await this.opts.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      await appendManagedTelegramControlEvidence(db, {
        workspaceId: input.workspaceId,
        actor: `user:${input.userId}`,
        action: 'TELEGRAM_MANAGED_BOT_PROVISIONING_REQUESTED',
        target: requestId,
        evidenceType: 'managed_telegram_provisioning_requested',
        title: 'Managed Telegram provisioning requested',
        summary: 'A workspace owner requested a managed Telegram launch bot provisioning link.',
        replayRef: `managed-telegram-provisioning:${requestId}:requested`,
        sensitivity: 'confidential',
        metadata: {
          requestId,
          requestedByUserId: input.userId,
          creatorTelegramIdHash: stableHash(input.creatorTelegramId),
          suggestedUsername,
          suggestedName,
          managerBotUsername,
          creationUrlHash: stableHash(creationUrl),
          expiresAt: expiresAt.toISOString(),
          rawCreatorTelegramIdStoredInEvidence: false,
          rawCreationUrlStoredInEvidence: false,
        },
      });

      await db
        .update(managedTelegramBotProvisioningRequests)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(
          and(
            eq(managedTelegramBotProvisioningRequests.workspaceId, input.workspaceId),
            eq(managedTelegramBotProvisioningRequests.status, 'pending'),
            lt(managedTelegramBotProvisioningRequests.expiresAt, new Date()),
          ),
        );

      return db
        .insert(managedTelegramBotProvisioningRequests)
        .values({
          id: requestId,
          workspaceId: input.workspaceId,
          requestedByUserId: input.userId,
          creatorTelegramId: input.creatorTelegramId,
          suggestedName,
          suggestedUsername,
          managerBotUsername,
          creationUrl,
          status: 'pending',
          expiresAt,
        })
        .returning();
    });

    if (!request) throw new ManagedTelegramBotError('Failed to create provisioning request', 500);
    return serializeProvisioningRequest(request);
  }

  async claimManagedBot(input: ManagedBotClaimInput) {
    const telegramBotId = String(input.bot.id);
    const telegramBotUsername = normalizeTelegramUsername(input.bot.username);
    if (!telegramBotUsername) {
      throw new ManagedTelegramBotError('Telegram did not provide a managed bot username', 400);
    }

    // lint-tenancy: ok — telegram_bot_id is globally unique in Telegram and
    // in managed_telegram_bots; this is an idempotency check before request
    // matching claims the workspace-scoped row.
    const [existing] = await this.opts.db
      .select()
      .from(managedTelegramBots)
      .where(eq(managedTelegramBots.telegramBotId, telegramBotId))
      .limit(1);
    if (existing) {
      if (existing.status === 'error') return this.retryExistingBotActivation(existing);
      return serializeBot(existing);
    }

    const [request] = await this.opts.db
      .select()
      .from(managedTelegramBotProvisioningRequests)
      .where(
        and(
          eq(managedTelegramBotProvisioningRequests.creatorTelegramId, input.creatorTelegramId),
          eq(managedTelegramBotProvisioningRequests.status, 'pending'),
          gt(managedTelegramBotProvisioningRequests.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(managedTelegramBotProvisioningRequests.createdAt))
      .limit(1);
    if (!request) {
      throw new ManagedTelegramBotError(
        'No pending launch bot request matched this Telegram user',
        404,
      );
    }

    const claimGovernance = await this.evaluateAction({
      workspaceId: request.workspaceId,
      action: TELEGRAM_MANAGED_ACTIONS.CLAIM,
      resource: `telegram:${telegramBotId}`,
      context: { telegramBotId, telegramBotUsername, requestId: request.id },
    });
    const claimGovernanceMetadata = claimGovernance
      ? managedTelegramGovernanceMetadata(TELEGRAM_MANAGED_ACTIONS.CLAIM, claimGovernance)
      : undefined;

    const managerBotToken = this.opts.managerBotToken;
    if (!managerBotToken) throw new ManagedTelegramBotError('TELEGRAM_BOT_TOKEN is required', 503);
    const managedBotId = randomUUID();
    const tokenSecretRef = tokenSecretRefFor(managedBotId);
    const claimEvidence = await this.opts.db.transaction(async (tx) =>
      appendManagedTelegramControlEvidence(tx as unknown as Db, {
        workspaceId: request.workspaceId,
        actor: `user:${request.requestedByUserId}`,
        action: TELEGRAM_MANAGED_ACTIONS.CLAIM,
        target: managedBotId,
        evidenceType: 'managed_telegram_claim_requested',
        title: 'Managed Telegram bot claim requested',
        summary:
          'A pending managed Telegram bot provisioning request matched a Telegram child bot before token retrieval or bot activation.',
        replayRef: `managed-telegram-bot:${managedBotId}:claim`,
        sensitivity: 'restricted',
        metadata: managedTelegramClaimControlMetadata({
          requestId: request.id,
          managedBotId,
          telegramBotId,
          telegramBotUsername,
          tokenSecretRef,
          governance: claimGovernanceMetadata,
        }),
      }),
    );
    const token = await getManagedBotToken(managerBotToken, telegramBotId);

    const webhookSecret = randomBytes(32).toString('hex');
    const webhookSecretHash = hashSecret(webhookSecret);
    const initialGovernanceMetadata = appendGovernanceMetadata(
      claimGovernanceMetadata ? { claim: claimGovernanceMetadata } : undefined,
      'claimEvidence',
      managedTelegramControlEvidenceMetadata(claimEvidence),
    );

    const [row] = await this.opts.db
      .insert(managedTelegramBots)
      .values({
        id: managedBotId,
        workspaceId: request.workspaceId,
        creatorUserId: request.requestedByUserId,
        creatorTelegramId: input.creatorTelegramId,
        telegramBotId,
        telegramBotUsername,
        telegramBotName: input.bot.firstName ?? telegramBotUsername,
        purpose: 'launch_support',
        status: 'error',
        responseMode: 'approval_required',
        tokenSecretRef,
        webhookSecretHash,
        welcomeCopy: DEFAULT_WELCOME,
        supportPrompt: DEFAULT_SUPPORT_PROMPT,
        governanceMetadata: initialGovernanceMetadata,
      })
      .returning();
    if (!row) throw new ManagedTelegramBotError('Failed to persist managed Telegram bot', 500);

    try {
      await this.secrets.set(request.workspaceId, tokenSecretRef, token);
      const webhookGovernance = await this.configureChildWebhook(row, token, webhookSecret, {
        actor: `user:${request.requestedByUserId}`,
        replayRef: `managed-telegram-bot:${row.id}:set-webhook-after-claim`,
        summary:
          'Managed Telegram child bot webhook setup was requested before external Telegram webhook configuration.',
      });
      const [updated] = await this.opts.db
        .update(managedTelegramBots)
        .set({
          status: 'active',
          lastError: null,
          governanceMetadata: appendGovernanceMetadata(
            row.governanceMetadata,
            'setWebhook',
            webhookGovernance,
          ),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(managedTelegramBots.id, row.id),
            eq(managedTelegramBots.workspaceId, row.workspaceId),
          ),
        )
        .returning();

      await this.opts.db
        .update(managedTelegramBotProvisioningRequests)
        .set({ status: 'claimed', managedBotId: row.id, updatedAt: new Date() })
        .where(
          and(
            eq(managedTelegramBotProvisioningRequests.id, request.id),
            eq(managedTelegramBotProvisioningRequests.workspaceId, request.workspaceId),
          ),
        );

      return serializeBot(updated ?? { ...row, status: 'active', lastError: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Webhook setup failed';
      await this.opts.db
        .update(managedTelegramBots)
        .set({ status: 'error', lastError: message, updatedAt: new Date() })
        .where(
          and(
            eq(managedTelegramBots.id, row.id),
            eq(managedTelegramBots.workspaceId, row.workspaceId),
          ),
        );
      throw err;
    }
  }

  async getState(workspaceId: string) {
    const bots = await this.opts.db
      .select()
      .from(managedTelegramBots)
      .where(eq(managedTelegramBots.workspaceId, workspaceId))
      .orderBy(desc(managedTelegramBots.createdAt))
      .limit(5);
    const bot = bots.find((row) => row.status !== 'disabled') ?? null;

    const [pending] = await this.opts.db
      .select()
      .from(managedTelegramBotProvisioningRequests)
      .where(
        and(
          eq(managedTelegramBotProvisioningRequests.workspaceId, workspaceId),
          eq(managedTelegramBotProvisioningRequests.status, 'pending'),
          gt(managedTelegramBotProvisioningRequests.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(managedTelegramBotProvisioningRequests.createdAt))
      .limit(1);

    const leads = bot
      ? await this.opts.db
          .select()
          .from(managedTelegramBotLeads)
          .where(eq(managedTelegramBotLeads.managedBotId, bot.id))
          .orderBy(desc(managedTelegramBotLeads.createdAt))
          .limit(10)
      : [];
    const messages = bot
      ? await this.listMessages(workspaceId, { managedBotId: bot.id, limit: 20 })
      : [];

    return {
      bot: bot ? serializeBot(bot) : null,
      pendingRequest: pending ? serializeProvisioningRequest(pending) : null,
      leads: leads.map(serializeLead),
      messages: messages.map(serializeMessage),
    };
  }

  async updateSettings(workspaceId: string, userId: string, raw: unknown) {
    await this.ensureOwner(workspaceId, userId);
    const input = ManagedTelegramBotSettingsInput.parse(raw);
    const bot = await this.getActiveBot(workspaceId);
    if (!bot) throw new ManagedTelegramBotError('Launch/support bot not found', 404);

    const updates: Partial<typeof managedTelegramBots.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (input.responseMode !== undefined) updates.responseMode = input.responseMode;
    if (input.welcomeCopy !== undefined) updates.welcomeCopy = input.welcomeCopy;
    if (input.launchUrl !== undefined) updates.launchUrl = input.launchUrl;
    if (input.supportPrompt !== undefined) updates.supportPrompt = input.supportPrompt;

    const changedFields = Object.keys(updates)
      .filter((key) => key !== 'updatedAt')
      .sort();
    const [updated] = await this.opts.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      await appendManagedTelegramControlEvidence(db, {
        workspaceId,
        actor: `user:${userId}`,
        action: 'TELEGRAM_MANAGED_BOT_SETTINGS_UPDATED',
        target: bot.id,
        evidenceType: 'managed_telegram_settings_update_requested',
        title: 'Managed Telegram settings update requested',
        summary: 'A workspace owner requested a managed Telegram launch bot settings update.',
        replayRef: `managed-telegram-bot:${bot.id}:settings-update:${stableHash(JSON.stringify(changedFields)).slice(0, 16)}`,
        sensitivity: 'internal',
        metadata: managedTelegramSettingsEvidenceMetadata(bot, input, changedFields),
      });

      return db
        .update(managedTelegramBots)
        .set(updates)
        .where(
          and(eq(managedTelegramBots.id, bot.id), eq(managedTelegramBots.workspaceId, workspaceId)),
        )
        .returning();
    });
    return serializeBot(updated ?? bot);
  }

  async listMessages(
    workspaceId: string,
    opts: { managedBotId?: string; limit?: number } = {},
  ): Promise<ManagedMessageRow[]> {
    const conditions = [eq(managedTelegramBotMessages.workspaceId, workspaceId)];
    if (opts.managedBotId) {
      conditions.push(eq(managedTelegramBotMessages.managedBotId, opts.managedBotId));
    }
    return this.opts.db
      .select()
      .from(managedTelegramBotMessages)
      .where(and(...conditions))
      .orderBy(desc(managedTelegramBotMessages.createdAt))
      .limit(Math.min(opts.limit ?? 50, 100));
  }

  async sendManualReply(workspaceId: string, userId: string, messageId: string, text: string) {
    await this.ensureWorkspaceMember(workspaceId, userId);
    // lint-tenancy: ok — approval ids are globally unique and are produced by
    // the workspace-scoped approvals table before this send hook runs.
    const [message] = await this.opts.db
      .select()
      .from(managedTelegramBotMessages)
      .where(
        and(
          eq(managedTelegramBotMessages.id, messageId),
          eq(managedTelegramBotMessages.workspaceId, workspaceId),
        ),
      )
      .limit(1);
    if (!message) throw new ManagedTelegramBotError('Message not found', 404);

    const governed = await this.evaluateAction({
      workspaceId,
      action: TELEGRAM_MANAGED_ACTIONS.SEND_MESSAGE,
      resource: `telegram-managed-message:${message.id}`,
      context: { managedBotId: message.managedBotId, messageId, manual: true },
    });

    return this.sendMessageRow(
      message,
      text,
      governed
        ? managedTelegramGovernanceMetadata(TELEGRAM_MANAGED_ACTIONS.SEND_MESSAGE, governed)
        : undefined,
    );
  }

  async sendApprovedMessage(approvalId: string) {
    const [message] = await this.opts.db
      .select()
      .from(managedTelegramBotMessages)
      .where(eq(managedTelegramBotMessages.approvalId, approvalId))
      .limit(1);
    if (!message || message.replyStatus === 'sent') return false;
    const text = message.replyText ?? message.aiDraft;
    if (!text) return false;

    const governed = await this.evaluateAction({
      workspaceId: message.workspaceId,
      action: TELEGRAM_MANAGED_ACTIONS.SEND_MESSAGE,
      resource: `telegram-managed-message:${message.id}`,
      context: { managedBotId: message.managedBotId, messageId: message.id, approvalId },
    });
    await this.sendMessageRow(
      message,
      text,
      governed
        ? managedTelegramGovernanceMetadata(TELEGRAM_MANAGED_ACTIONS.SEND_MESSAGE, governed)
        : undefined,
    );
    return true;
  }

  async rotateToken(workspaceId: string, userId: string) {
    await this.ensureOwner(workspaceId, userId);
    const bot = await this.getActiveBot(workspaceId);
    if (!bot) throw new ManagedTelegramBotError('Launch/support bot not found', 404);
    const managerBotToken = this.opts.managerBotToken;
    if (!managerBotToken) throw new ManagedTelegramBotError('TELEGRAM_BOT_TOKEN is required', 503);

    const rotateGovernance = await this.evaluateAction({
      workspaceId,
      action: TELEGRAM_MANAGED_ACTIONS.ROTATE_TOKEN,
      resource: `telegram:${bot.telegramBotId}`,
      context: { managedBotId: bot.id },
    });
    const rotateGovernanceMetadata = rotateGovernance
      ? managedTelegramGovernanceMetadata(TELEGRAM_MANAGED_ACTIONS.ROTATE_TOKEN, rotateGovernance)
      : undefined;
    const rotateEvidence = await this.opts.db.transaction(async (tx) =>
      appendManagedTelegramControlEvidence(tx as unknown as Db, {
        workspaceId,
        actor: `user:${userId}`,
        action: TELEGRAM_MANAGED_ACTIONS.ROTATE_TOKEN,
        target: bot.id,
        evidenceType: 'managed_telegram_token_rotation_requested',
        title: 'Managed Telegram token rotation requested',
        summary:
          'A workspace owner requested managed Telegram token rotation before external Telegram token replacement.',
        replayRef: `managed-telegram-bot:${bot.id}:rotate-token`,
        sensitivity: 'restricted',
        metadata: managedTelegramElevatedControlMetadata(bot, rotateGovernanceMetadata),
      }),
    );
    const newToken = await replaceManagedBotToken(managerBotToken, bot.telegramBotId);
    await this.secrets.set(workspaceId, asSecretKind(bot.tokenSecretRef), newToken);

    const webhookSecret = randomBytes(32).toString('hex');
    const webhookGovernance = await this.configureChildWebhook(bot, newToken, webhookSecret, {
      actor: `user:${userId}`,
      replayRef: `managed-telegram-bot:${bot.id}:set-webhook-after-token-rotation`,
      summary:
        'Managed Telegram child bot webhook setup was requested after token rotation and before external Telegram webhook configuration.',
    });
    this.childBotCache.delete(bot.id);

    const [updated] = await this.opts.db
      .update(managedTelegramBots)
      .set({
        webhookSecretHash: hashSecret(webhookSecret),
        lastError: null,
        governanceMetadata: appendGovernanceMetadata(
          appendGovernanceMetadata(
            appendGovernanceMetadata(
              bot.governanceMetadata,
              'rotateToken',
              rotateGovernanceMetadata,
            ),
            'rotateTokenEvidence',
            managedTelegramControlEvidenceMetadata(rotateEvidence),
          ),
          'setWebhook',
          webhookGovernance,
        ),
        updatedAt: new Date(),
      })
      .where(
        and(eq(managedTelegramBots.id, bot.id), eq(managedTelegramBots.workspaceId, workspaceId)),
      )
      .returning();
    return serializeBot(updated ?? bot);
  }

  async disable(workspaceId: string, userId: string) {
    await this.ensureOwner(workspaceId, userId);
    const bot = await this.getActiveBot(workspaceId);
    if (!bot) throw new ManagedTelegramBotError('Launch/support bot not found', 404);

    const governed = await this.evaluateAction({
      workspaceId,
      action: TELEGRAM_MANAGED_ACTIONS.DISABLE,
      resource: `telegram:${bot.telegramBotId}`,
      context: { managedBotId: bot.id },
    });
    const governance = governed
      ? managedTelegramGovernanceMetadata(TELEGRAM_MANAGED_ACTIONS.DISABLE, governed)
      : undefined;
    const disableEvidence = await this.opts.db.transaction(async (tx) =>
      appendManagedTelegramControlEvidence(tx as unknown as Db, {
        workspaceId,
        actor: `user:${userId}`,
        action: TELEGRAM_MANAGED_ACTIONS.DISABLE,
        target: bot.id,
        evidenceType: 'managed_telegram_disable_requested',
        title: 'Managed Telegram disable requested',
        summary:
          'A workspace owner requested managed Telegram bot disable before external webhook deletion or secret deletion.',
        replayRef: `managed-telegram-bot:${bot.id}:disable`,
        sensitivity: 'restricted',
        metadata: managedTelegramElevatedControlMetadata(bot, governance),
      }),
    );

    const token = await this.secrets.get(workspaceId, asSecretKind(bot.tokenSecretRef));
    if (token) {
      try {
        await deleteWebhook(token);
      } catch (err) {
        const cleanupEvidence = await this.opts.db.transaction(async (tx) =>
          appendManagedTelegramControlEvidence(tx as unknown as Db, {
            workspaceId,
            actor: `user:${userId}`,
            action: TELEGRAM_MANAGED_ACTIONS.DISABLE,
            target: bot.id,
            evidenceType: 'managed_telegram_disable_cleanup_failed',
            title: 'Managed Telegram disable cleanup failed',
            summary:
              'Telegram webhook deletion failed after disable was authorized; Pilot kept the bot active and retained the token secret for retry.',
            replayRef: `managed-telegram-bot:${bot.id}:disable-cleanup-failed`,
            sensitivity: 'restricted',
            metadata: {
              ...managedTelegramElevatedControlMetadata(bot, governance),
              cleanupAction: 'deleteWebhook',
              cleanupStatus: 'failed',
              error: errorMessage(err),
              tokenSecretRetainedForRetry: true,
              rawTelegramApiResponseStoredInEvidence: false,
            },
            auditVerdict: 'failed',
            auditReason: errorMessage(err),
          }),
        );
        await this.opts.db
          .update(managedTelegramBots)
          .set({
            lastError: errorMessage(err),
            governanceMetadata: appendGovernanceMetadata(
              appendGovernanceMetadata(bot.governanceMetadata, 'disable', governance),
              'disableCleanupFailedEvidence',
              managedTelegramControlEvidenceMetadata(cleanupEvidence),
            ),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(managedTelegramBots.id, bot.id),
              eq(managedTelegramBots.workspaceId, workspaceId),
            ),
          );
        throw new ManagedTelegramBotError(
          'Managed Telegram webhook deletion failed; bot remains active for retry',
          502,
        );
      }
      await this.secrets.delete(workspaceId, asSecretKind(bot.tokenSecretRef));
    }
    this.childBotCache.delete(bot.id);

    const [updated] = await this.opts.db
      .update(managedTelegramBots)
      .set({
        status: 'disabled',
        webhookSecretHash: null,
        governanceMetadata: appendGovernanceMetadata(
          appendGovernanceMetadata(bot.governanceMetadata, 'disable', governance),
          'disableEvidence',
          managedTelegramControlEvidenceMetadata(disableEvidence),
        ),
        disabledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(managedTelegramBots.id, bot.id), eq(managedTelegramBots.workspaceId, workspaceId)),
      )
      .returning();
    return serializeBot(updated ?? { ...bot, status: 'disabled', disabledAt: new Date() });
  }

  async getBotForWebhook(managedBotId: string) {
    // lint-tenancy: ok — this lookup happens only after Telegram's per-child
    // webhook secret is checked by the route; workspaceId is not in the URL.
    const [bot] = await this.opts.db
      .select()
      .from(managedTelegramBots)
      .where(eq(managedTelegramBots.id, managedBotId))
      .limit(1);
    if (!bot || bot.status !== 'active') return null;
    return bot;
  }

  verifyWebhookSecret(bot: ManagedBotRow, secret: string | undefined) {
    if (!bot.webhookSecretHash || !secret) return false;
    return timingSafeStringEqual(hashSecret(secret), bot.webhookSecretHash);
  }

  async handleChildWebhook(managedBotId: string, update: unknown) {
    const bot = await this.getBotForWebhook(managedBotId);
    if (!bot) throw new ManagedTelegramBotError('Managed bot not found', 404);
    const token = await this.secrets.get(bot.workspaceId, asSecretKind(bot.tokenSecretRef));
    if (!token) throw new ManagedTelegramBotError('Managed bot token not configured', 503);
    const child = await this.getCachedChildBot(bot.id, token);
    await child.handleUpdate(update as never);
  }

  private async getCachedChildBot(managedBotId: string, token: string) {
    const cached = this.childBotCache.get(managedBotId);
    if (cached && cached.token === token && Date.now() - cached.cachedAt < CHILD_BOT_CACHE_TTL_MS) {
      return cached.bot;
    }

    const bot = new Bot(token);
    this.registerChildHandlers(managedBotId, bot);
    await bot.init();
    this.childBotCache.set(managedBotId, { bot, token, cachedAt: Date.now() });
    return bot;
  }

  private registerChildHandlers(managedBotId: string, bot: Bot) {
    bot.command('start', async (ctx) => {
      const row = await this.getBotForWebhook(managedBotId);
      if (!row) return;
      const keyboard = new InlineKeyboard()
        .text('Join launch list', 'lead:join')
        .row()
        .text('Get support', 'support:start');
      if (row.launchUrl) keyboard.row().url('Open launch page', row.launchUrl);
      await ctx.reply(row.welcomeCopy || DEFAULT_WELCOME, { reply_markup: keyboard });
    });

    bot.command('help', async (ctx) => {
      const row = await this.getBotForWebhook(managedBotId);
      await ctx.reply(row?.supportPrompt || DEFAULT_SUPPORT_PROMPT);
    });

    bot.callbackQuery('lead:join', async (ctx) => {
      await this.captureLead(managedBotId, ctx);
      await ctx.answerCallbackQuery({ text: 'You are on the list.' });
      await ctx.editMessageReplyMarkup();
      await ctx.reply('You are on the launch list. We will follow up here.');
    });

    bot.callbackQuery('support:start', async (ctx) => {
      const row = await this.getBotForWebhook(managedBotId);
      await ctx.answerCallbackQuery();
      await ctx.reply(row?.supportPrompt || DEFAULT_SUPPORT_PROMPT);
    });

    bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) return;
      await this.captureSupportMessage(managedBotId, ctx);
    });
  }

  private async captureLead(managedBotId: string, ctx: Context) {
    const row = await this.getBotForWebhook(managedBotId);
    const from = ctx.from;
    const chat = ctx.chat;
    if (!row || !from || !chat) return;

    const [existing] = await this.opts.db
      .select()
      .from(managedTelegramBotLeads)
      .where(
        and(
          eq(managedTelegramBotLeads.managedBotId, row.id),
          eq(managedTelegramBotLeads.telegramUserId, String(from.id)),
        ),
      )
      .limit(1);
    if (existing) {
      await this.opts.db.transaction(async (tx) => {
        await tx
          .update(managedTelegramBotLeads)
          .set({ status: 'captured', updatedAt: new Date() })
          .where(
            and(
              eq(managedTelegramBotLeads.id, existing.id),
              eq(managedTelegramBotLeads.workspaceId, row.workspaceId),
            ),
          );
        await appendManagedTelegramInboundEvidence(tx, {
          workspaceId: row.workspaceId,
          managedBotId: row.id,
          action: 'TELEGRAM_CHILD_LEAD_CAPTURED',
          target: existing.id,
          evidenceType: 'managed_telegram_lead_captured',
          title: 'Managed Telegram lead recaptured',
          summary: 'An existing launch bot lead was recaptured from an inbound Telegram webhook.',
          replayRef: `managed-telegram-lead:${existing.id}:recaptured`,
          sensitivity: 'sensitive',
          metadata: managedTelegramInboundMetadata(row, from, chat, {
            leadId: existing.id,
            existingLead: true,
          }),
        });
      });
      return;
    }

    const leadId = randomUUID();
    await this.opts.db.transaction(async (tx) => {
      await tx.insert(managedTelegramBotLeads).values({
        id: leadId,
        managedBotId: row.id,
        workspaceId: row.workspaceId,
        telegramChatId: String(chat.id),
        telegramUserId: String(from.id),
        telegramUsername: from.username ?? null,
        name: [from.first_name, from.last_name].filter(Boolean).join(' ') || null,
      });
      await appendManagedTelegramInboundEvidence(tx, {
        workspaceId: row.workspaceId,
        managedBotId: row.id,
        action: 'TELEGRAM_CHILD_LEAD_CAPTURED',
        target: leadId,
        evidenceType: 'managed_telegram_lead_captured',
        title: 'Managed Telegram lead captured',
        summary: 'A launch bot lead was captured from an inbound Telegram webhook.',
        replayRef: `managed-telegram-lead:${leadId}:captured`,
        sensitivity: 'sensitive',
        metadata: managedTelegramInboundMetadata(row, from, chat, {
          leadId,
          existingLead: false,
        }),
      });
    });
  }

  private async captureSupportMessage(managedBotId: string, ctx: Context) {
    const row = await this.getBotForWebhook(managedBotId);
    const from = ctx.from;
    const chat = ctx.chat;
    const inbound = ctx.message && 'text' in ctx.message ? ctx.message : undefined;
    const text = inbound?.text;
    if (!row || !from || !chat || !inbound || !text) return;

    const draft =
      row.responseMode === 'intake_only' ? null : await this.buildSupportDraft(row, text);
    const messageId = randomUUID();
    const [message] = await this.opts.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(managedTelegramBotMessages)
        .values({
          id: messageId,
          managedBotId: row.id,
          workspaceId: row.workspaceId,
          telegramChatId: String(chat.id),
          telegramUserId: String(from.id),
          telegramUsername: from.username ?? null,
          telegramFirstName: from.first_name ?? null,
          inboundText: text,
          inboundMessageId: inbound.message_id,
          aiDraft: draft?.text ?? null,
          replyStatus: row.responseMode === 'intake_only' ? 'none' : 'drafted',
          governanceMetadata: draft ? { supportDraft: draft.governanceMetadata } : {},
        })
        .returning();
      await appendManagedTelegramInboundEvidence(tx, {
        workspaceId: row.workspaceId,
        managedBotId: row.id,
        action: 'TELEGRAM_CHILD_SUPPORT_MESSAGE_CAPTURED',
        target: messageId,
        evidenceType: 'managed_telegram_support_message_captured',
        title: 'Managed Telegram support message captured',
        summary: 'A support message was captured from an inbound Telegram webhook.',
        replayRef: `managed-telegram-message:${messageId}:captured`,
        sensitivity: 'sensitive',
        metadata: managedTelegramInboundMetadata(row, from, chat, {
          messageId,
          inboundMessageId: inbound.message_id ?? null,
          inboundTextHash: `sha256:${replyTextHash(text)}`,
          inboundTextLength: text.length,
          rawInboundTextStoredInEvidence: false,
          responseMode: row.responseMode,
          replyStatus: row.responseMode === 'intake_only' ? 'none' : 'drafted',
          draftMethod: draft?.governanceMetadata['method'] ?? null,
          policyDecisionId: draft?.governanceMetadata['policyDecisionId'] ?? null,
          policyVersion: draft?.governanceMetadata['policyVersion'] ?? null,
          helmDocumentVersionPins: draft?.governanceMetadata['helmDocumentVersionPins'] ?? {},
        }),
      });
      return [created];
    });

    await ctx.reply('Thanks. Your message reached the founder team.');
    if (!message) return;
    if (!draft) {
      await this.notifySupportMessage(row, message);
      return;
    }

    if (row.responseMode === 'autonomous_helm') {
      let sendAudit: ManagedTelegramSendAudit | undefined;
      let telegramSent = false;
      try {
        const governed = await this.evaluateAction({
          workspaceId: row.workspaceId,
          action: TELEGRAM_MANAGED_ACTIONS.SEND_MESSAGE,
          resource: `telegram-managed-message:${message.id}`,
          context: { managedBotId: row.id, messageId: message.id, autonomous: true },
        });
        const governance = governed
          ? managedTelegramGovernanceMetadata(TELEGRAM_MANAGED_ACTIONS.SEND_MESSAGE, governed)
          : undefined;
        sendAudit = await this.persistSendAuditIntent(message, draft.text, governance);
        const sent = await ctx.reply(draft.text);
        telegramSent = true;
        await this.markMessageSent(
          message,
          draft.text,
          String(sent.message_id),
          governance,
          sendAudit,
        );
        return;
      } catch (err) {
        if (sendAudit) await this.markSendAuditFailed(message, sendAudit, err);
        if (telegramSent) throw err;
        // Fall back to approval below.
      }
    }

    await this.requestReplyApproval(message, draft.text);
  }

  private async retryExistingBotActivation(row: ManagedBotRow) {
    const token = await this.secrets.get(row.workspaceId, asSecretKind(row.tokenSecretRef));
    if (!token) {
      throw new ManagedTelegramBotError('Managed bot token not configured', 503);
    }
    const webhookSecret = randomBytes(32).toString('hex');
    try {
      const webhookGovernance = await this.configureChildWebhook(row, token, webhookSecret, {
        actor: 'system:managed-telegram',
        replayRef: `managed-telegram-bot:${row.id}:set-webhook-retry`,
        summary:
          'Managed Telegram child bot webhook retry was requested before external Telegram webhook configuration.',
      });
      const [updated] = await this.opts.db
        .update(managedTelegramBots)
        .set({
          status: 'active',
          webhookSecretHash: hashSecret(webhookSecret),
          lastError: null,
          governanceMetadata: appendGovernanceMetadata(
            row.governanceMetadata,
            'setWebhook',
            webhookGovernance,
          ),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(managedTelegramBots.id, row.id),
            eq(managedTelegramBots.workspaceId, row.workspaceId),
          ),
        )
        .returning();
      return serializeBot(updated ?? { ...row, status: 'active', lastError: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Webhook setup failed';
      await this.opts.db
        .update(managedTelegramBots)
        .set({ lastError: message, updatedAt: new Date() })
        .where(
          and(
            eq(managedTelegramBots.id, row.id),
            eq(managedTelegramBots.workspaceId, row.workspaceId),
          ),
        );
      throw err;
    }
  }

  private async notifySupportMessage(row: ManagedBotRow, message: ManagedMessageRow) {
    if (!this.supportNotifier) return;
    try {
      await this.supportNotifier(row.workspaceId, message.id, row.telegramBotUsername);
    } catch (err) {
      await this.recordMessageSideEffectFailure({
        message,
        actor: `managed_telegram_bot:${row.id}`,
        action: 'TELEGRAM_CHILD_SUPPORT_NOTIFICATION_FAILED',
        evidenceType: 'managed_telegram_support_notification_failed',
        title: 'Managed Telegram support notification failed',
        summary:
          'A managed Telegram support message was captured, but founder notification delivery failed after intake evidence was persisted.',
        replayRef: `managed-telegram-message:${message.id}:support-notification-failed`,
        governanceKey: 'supportNotificationFailedEvidence',
        failureMetadata: {
          managedBotId: row.id,
          messageId: message.id,
          telegramBotUsernameHash: stableHash(row.telegramBotUsername),
          telegramChatIdHash: stableHash(message.telegramChatId),
          telegramUserIdHash: stableHash(message.telegramUserId),
          notificationChannel: 'support_notifier',
          notificationStatus: 'failed',
          error: errorMessage(err),
          rawTelegramIdentityStoredInEvidence: false,
          rawNotifierPayloadStoredInEvidence: false,
        },
        error: err,
      });
    }
  }

  private async buildSupportDraft(
    row: ManagedBotRow,
    inboundText: string,
  ): Promise<ManagedTelegramSupportDraft> {
    if (!this.opts.llm) {
      return deterministicSupportDraft('llm_not_configured');
    }
    try {
      const prompt =
        `Draft a concise Telegram support reply for ${row.telegramBotName}.\n` +
        `Do not promise timelines or make unsupported claims.\n\nCustomer message:\n${inboundText}`;
      const result = await this.opts.llm.completeWithUsage(prompt);
      if (requiresProductionGovernedSupportDrafts() && !result.governance) {
        throw new ManagedTelegramBotError(
          'HELM-governed LLM metadata is required for production Telegram support drafts',
          503,
        );
      }
      const text = result.content.trim().slice(0, 4096);
      if (!text) throw new Error('LLM returned an empty support draft');
      return {
        text,
        governanceMetadata: managedTelegramSupportDraftMetadata(result),
      };
    } catch (err) {
      if (requiresProductionGovernedSupportDrafts()) {
        throw err;
      }
      return deterministicSupportDraft(err instanceof Error ? err.message : String(err));
    }
  }

  private async requestReplyApproval(message: ManagedMessageRow, draft: string) {
    const reason = `Support reply draft for Telegram user ${message.telegramUserId}`;
    let approvalId: string | undefined;
    let approvalGovernanceMetadata = message.governanceMetadata;
    await this.opts.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const approvalEvidence = await appendManagedTelegramControlEvidence(db, {
        workspaceId: message.workspaceId,
        actor: `managed_telegram_bot:${message.managedBotId}`,
        action: TELEGRAM_MANAGED_ACTIONS.REQUEST_SEND_APPROVAL,
        target: message.id,
        evidenceType: 'managed_telegram_send_approval_requested',
        title: 'Managed Telegram send approval requested',
        summary:
          'A managed Telegram support reply was drafted and queued for founder approval before notification side effects.',
        replayRef: `managed-telegram-message:${message.id}:approval-requested`,
        sensitivity: 'restricted',
        metadata: managedTelegramApprovalRequestMetadata(message, draft),
      });
      const [approval] = await db
        .insert(approvals)
        .values({
          workspaceId: message.workspaceId,
          action: TELEGRAM_MANAGED_ACTIONS.SEND_MESSAGE,
          reason,
          status: 'pending',
          requestedBy: `managed_telegram_bot:${message.managedBotId}`,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        })
        .returning();
      approvalId = approval?.id;
      approvalGovernanceMetadata = appendGovernanceMetadata(
        message.governanceMetadata,
        'approvalRequestEvidence',
        managedTelegramControlEvidenceMetadata(approvalEvidence),
      );

      await db
        .update(managedTelegramBotMessages)
        .set({
          approvalId,
          replyText: draft,
          replyStatus: 'awaiting_approval',
          governanceMetadata: approvalGovernanceMetadata,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(managedTelegramBotMessages.id, message.id),
            eq(managedTelegramBotMessages.workspaceId, message.workspaceId),
          ),
        );
    });

    if (approvalId && this.approvalNotifier) {
      try {
        await this.approvalNotifier(
          message.workspaceId,
          approvalId,
          TELEGRAM_MANAGED_ACTIONS.SEND_MESSAGE,
          reason,
        );
      } catch (err) {
        await this.recordMessageSideEffectFailure({
          message: { ...message, governanceMetadata: approvalGovernanceMetadata },
          actor: `managed_telegram_bot:${message.managedBotId}`,
          action: 'TELEGRAM_CHILD_SEND_APPROVAL_NOTIFICATION_FAILED',
          evidenceType: 'managed_telegram_send_approval_notification_failed',
          title: 'Managed Telegram send approval notification failed',
          summary:
            'A managed Telegram send approval was created, but founder notification delivery failed after approval evidence was persisted.',
          replayRef: `managed-telegram-message:${message.id}:approval-notification-failed`,
          governanceKey: 'approvalNotificationFailedEvidence',
          failureMetadata: {
            managedBotId: message.managedBotId,
            messageId: message.id,
            approvalId,
            telegramChatIdHash: stableHash(message.telegramChatId),
            telegramUserIdHash: stableHash(message.telegramUserId),
            notificationChannel: 'approval_notifier',
            notificationStatus: 'failed',
            error: errorMessage(err),
            rawTelegramIdentityStoredInEvidence: false,
            rawNotifierPayloadStoredInEvidence: false,
          },
          error: err,
        });
      }
    }
  }

  private async recordMessageSideEffectFailure(input: {
    message: ManagedMessageRow;
    actor: string;
    action: string;
    evidenceType: string;
    title: string;
    summary: string;
    replayRef: string;
    governanceKey: string;
    failureMetadata: Record<string, unknown>;
    error: unknown;
  }) {
    const failureEvidence = await this.opts.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const evidence = await appendManagedTelegramControlEvidence(db, {
        workspaceId: input.message.workspaceId,
        actor: input.actor,
        action: input.action,
        target: input.message.id,
        evidenceType: input.evidenceType,
        title: input.title,
        summary: input.summary,
        replayRef: input.replayRef,
        sensitivity: 'confidential',
        metadata: input.failureMetadata,
        auditVerdict: 'failed',
        auditReason: errorMessage(input.error),
      });

      await db
        .update(managedTelegramBotMessages)
        .set({
          error: errorMessage(input.error),
          governanceMetadata: appendGovernanceMetadata(
            input.message.governanceMetadata,
            input.governanceKey,
            managedTelegramControlEvidenceMetadata(evidence),
          ),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(managedTelegramBotMessages.id, input.message.id),
            eq(managedTelegramBotMessages.workspaceId, input.message.workspaceId),
          ),
        );
      return evidence;
    });
    return failureEvidence;
  }

  private async sendMessageRow(
    message: ManagedMessageRow,
    text: string,
    governance?: ManagedTelegramGovernanceMetadata,
  ) {
    // lint-tenancy: ok — caller has already loaded the workspace-scoped
    // message row; managedBotId is a FK from that row.
    const bot = await this.getManagedBot(message.managedBotId);
    if (!bot) throw new ManagedTelegramBotError('Managed bot not found', 404);
    const token = await this.secrets.get(bot.workspaceId, asSecretKind(bot.tokenSecretRef));
    if (!token) throw new ManagedTelegramBotError('Managed bot token not configured', 503);
    const sendAudit = await this.persistSendAuditIntent(message, text, governance);
    let sent: { message_id?: number };
    try {
      sent = await sendTelegramMessage(token, message.telegramChatId, text);
    } catch (err) {
      await this.markSendAuditFailed(message, sendAudit, err);
      throw err;
    }
    await this.markMessageSent(message, text, String(sent.message_id ?? ''), governance, sendAudit);
    return serializeMessage({
      ...message,
      replyText: text,
      replyStatus: 'sent',
      sentMessageId: String(sent.message_id ?? ''),
      repliedAt: new Date(),
      updatedAt: new Date(),
    });
  }

  private async markMessageSent(
    message: ManagedMessageRow,
    text: string,
    sentMessageId: string,
    governance?: ManagedTelegramGovernanceMetadata,
    sendAudit?: ManagedTelegramSendAudit,
  ) {
    const sentAt = new Date();
    await this.opts.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      await db
        .update(managedTelegramBotMessages)
        .set({
          replyText: text,
          replyStatus: 'sent',
          sentMessageId,
          error: null,
          governanceMetadata: appendGovernanceMetadata(
            appendGovernanceMetadata(message.governanceMetadata, 'sendMessage', governance),
            'sendEvidence',
            sendAudit
              ? {
                  auditEventId: sendAudit.auditEventId,
                  evidenceItemId: sendAudit.evidenceItemId,
                  replayRef: sendAudit.replayRef,
                }
              : undefined,
          ),
          repliedAt: sentAt,
          updatedAt: sentAt,
        })
        .where(
          and(
            eq(managedTelegramBotMessages.id, message.id),
            eq(managedTelegramBotMessages.workspaceId, message.workspaceId),
          ),
        );

      if (sendAudit) {
        await db
          .update(auditLog)
          .set({
            verdict: 'sent',
            reason: null,
            metadata: {
              ...sendAudit.metadata,
              status: 'sent',
              sentMessageId,
              sentAt: sentAt.toISOString(),
              evidenceItemId: sendAudit.evidenceItemId,
            },
          })
          .where(
            and(
              eq(auditLog.workspaceId, message.workspaceId),
              eq(auditLog.id, sendAudit.auditEventId),
            ),
          );
      }
    });
  }

  private async persistSendAuditIntent(
    message: ManagedMessageRow,
    text: string,
    governance?: ManagedTelegramGovernanceMetadata,
  ): Promise<ManagedTelegramSendAudit> {
    const auditEventId = randomUUID();
    const replayRef = `managed-telegram-message:${message.id}:send`;
    const metadata = managedTelegramSendEvidenceMetadata(message, text, governance, {
      status: 'pending',
      replayRef,
    });

    return this.opts.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      await db.insert(auditLog).values({
        id: auditEventId,
        workspaceId: message.workspaceId,
        action: TELEGRAM_MANAGED_ACTIONS.SEND_MESSAGE,
        actor: `managed_telegram_bot:${message.managedBotId}`,
        target: `telegram-managed-message:${message.id}`,
        verdict: 'pending',
        reason: 'Managed Telegram message send intent recorded before external send.',
        metadata,
      });

      const evidenceItemId = await appendEvidenceItem(db, {
        workspaceId: message.workspaceId,
        auditEventId,
        evidenceType: 'managed_telegram_send_intent',
        sourceType: 'managed_telegram',
        title: 'Managed Telegram send intent',
        summary:
          'A governed managed Telegram message send was authorized and recorded before dispatch.',
        redactionState: 'redacted',
        sensitivity: 'confidential',
        contentHash: replyTextHash(text),
        replayRef,
        observedAt: new Date(),
        metadata,
      });

      await db
        .update(auditLog)
        .set({ metadata: { ...metadata, evidenceItemId } })
        .where(and(eq(auditLog.workspaceId, message.workspaceId), eq(auditLog.id, auditEventId)));

      return {
        auditEventId,
        evidenceItemId,
        replayRef,
        metadata: { ...metadata, evidenceItemId },
      };
    });
  }

  private async markSendAuditFailed(
    message: ManagedMessageRow,
    sendAudit: ManagedTelegramSendAudit,
    err: unknown,
  ) {
    await this.opts.db
      .update(auditLog)
      .set({
        verdict: 'failed',
        reason: errorMessage(err),
        metadata: {
          ...sendAudit.metadata,
          status: 'failed',
          error: errorMessage(err),
        },
      })
      .where(
        and(eq(auditLog.workspaceId, message.workspaceId), eq(auditLog.id, sendAudit.auditEventId)),
      );
  }

  private async configureChildWebhook(
    row: ManagedBotRow,
    token: string,
    secret: string,
    options: ManagedTelegramWebhookSetupOptions,
  ): Promise<Record<string, unknown> | undefined> {
    const appUrl = stripTrailingSlash(this.opts.appUrl ?? process.env['APP_URL']);
    if (!appUrl)
      throw new ManagedTelegramBotError('APP_URL is required for child bot webhook setup', 503);

    const governed = await this.evaluateAction({
      workspaceId: row.workspaceId,
      action: TELEGRAM_MANAGED_ACTIONS.SET_WEBHOOK,
      resource: `telegram:${row.telegramBotId}`,
      context: { managedBotId: row.id },
    });

    const url = `${appUrl}/api/telegram/managed/${row.id}/webhook`;
    const governance = governed
      ? managedTelegramGovernanceMetadata(TELEGRAM_MANAGED_ACTIONS.SET_WEBHOOK, governed)
      : undefined;
    const evidence = await this.opts.db.transaction(async (tx) =>
      appendManagedTelegramControlEvidence(tx as unknown as Db, {
        workspaceId: row.workspaceId,
        actor: options.actor,
        action: TELEGRAM_MANAGED_ACTIONS.SET_WEBHOOK,
        target: row.id,
        evidenceType: 'managed_telegram_webhook_config_requested',
        title: 'Managed Telegram webhook configuration requested',
        summary: options.summary,
        replayRef: options.replayRef,
        sensitivity: 'restricted',
        metadata: managedTelegramWebhookControlMetadata(row, url, governance),
      }),
    );
    await setWebhook(token, url, secret);
    let commandFailureEvidence:
      | {
          auditEventId: string;
          evidenceItemId: string;
        }
      | undefined;
    try {
      await setCommands(token);
    } catch (err) {
      commandFailureEvidence = await this.opts.db.transaction(async (tx) =>
        appendManagedTelegramControlEvidence(tx as unknown as Db, {
          workspaceId: row.workspaceId,
          actor: options.actor,
          action: TELEGRAM_MANAGED_ACTIONS.SET_WEBHOOK,
          target: row.id,
          evidenceType: 'managed_telegram_commands_setup_failed',
          title: 'Managed Telegram command setup failed',
          summary:
            'Telegram webhook setup completed, but child bot command registration failed and was recorded for retry.',
          replayRef: `${options.replayRef}:commands-setup-failed`,
          sensitivity: 'restricted',
          metadata: {
            ...managedTelegramWebhookControlMetadata(row, url, governance),
            setupAction: 'setMyCommands',
            setupStatus: 'failed',
            error: errorMessage(err),
            rawTelegramApiResponseStoredInEvidence: false,
          },
          auditVerdict: 'failed',
          auditReason: errorMessage(err),
        }),
      );
    }
    return managedTelegramWebhookGovernanceMetadata(governance, evidence, commandFailureEvidence);
  }

  private async getActiveBot(workspaceId: string) {
    const [bot] = await this.opts.db
      .select()
      .from(managedTelegramBots)
      .where(
        and(
          eq(managedTelegramBots.workspaceId, workspaceId),
          eq(managedTelegramBots.purpose, 'launch_support'),
          eq(managedTelegramBots.status, 'active'),
        ),
      )
      .limit(1);
    return bot ?? null;
  }

  private async getManagedBot(managedBotId: string) {
    const [bot] = await this.opts.db
      .select()
      .from(managedTelegramBots)
      .where(eq(managedTelegramBots.id, managedBotId))
      .limit(1);
    return bot ?? null;
  }

  private async ensureOwner(workspaceId: string, userId: string) {
    const [workspace] = await this.opts.db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!workspace) throw new ManagedTelegramBotError('Workspace not found', 404);
    if (workspace.ownerId === userId) return workspace;

    const [membership] = await this.opts.db
      .select()
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
      )
      .limit(1);
    if (membership?.role === 'owner') return workspace;
    throw new ManagedTelegramBotError('Workspace owner required', 403);
  }

  private async ensureWorkspaceMember(workspaceId: string, userId: string) {
    const [membership] = await this.opts.db
      .select()
      .from(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
      )
      .limit(1);
    if (!membership) throw new ManagedTelegramBotError('Workspace membership required', 403);
  }

  private async resolveManagerBotUsername() {
    const configured = normalizeTelegramUsername(
      this.opts.managerBotUsername ??
        process.env['TELEGRAM_MANAGER_BOT_USERNAME'] ??
        process.env['TELEGRAM_BOT_USERNAME'],
    );
    if (configured) return configured;
    if (!this.opts.managerBotToken) {
      throw new ManagedTelegramBotError('TELEGRAM_MANAGER_BOT_USERNAME is required', 503);
    }
    const me = await telegramApi<{ username?: string }>(this.opts.managerBotToken, 'getMe', {});
    const username = normalizeTelegramUsername(me.username);
    if (!username) throw new ManagedTelegramBotError('Manager bot username is unavailable', 503);
    this.opts.managerBotUsername = username;
    return username;
  }

  private async evaluateAction(input: {
    workspaceId: string;
    action: string;
    resource: string;
    context?: Record<string, unknown>;
  }): Promise<EvaluateResult | null> {
    const effectLevel = managedTelegramActionEffectLevel(input.action);
    if (!this.opts.helmClient) {
      if (
        isElevatedManagedTelegramAction(effectLevel) ||
        (process.env['NODE_ENV'] === 'production' && process.env['HELM_FAIL_CLOSED'] !== '0')
      ) {
        throw new ManagedTelegramBotError(
          'HELM governance client is required for elevated Telegram managed bot actions',
          503,
        );
      }
      return null;
    }
    try {
      return await this.opts.helmClient.evaluate({
        principal: `workspace:${input.workspaceId}/operator:launch`,
        action: input.action,
        resource: input.resource,
        effectLevel,
        context: { ...input.context, workspaceId: input.workspaceId },
      });
    } catch (err) {
      if (err instanceof HelmDeniedError) {
        throw new ManagedTelegramBotError(err.reason, 403, err.receipt);
      }
      if (err instanceof HelmEscalationError) {
        throw new ManagedTelegramBotError(err.reason, 409, err.receipt);
      }
      if (err instanceof HelmUnreachableError) {
        throw new ManagedTelegramBotError(err.message, 503);
      }
      throw err;
    }
  }
}

async function getManagedBotToken(managerToken: string, userId: string) {
  return telegramApi<string>(managerToken, 'getManagedBotToken', { user_id: Number(userId) });
}

async function replaceManagedBotToken(managerToken: string, userId: string) {
  return telegramApi<string>(managerToken, 'replaceManagedBotToken', { user_id: Number(userId) });
}

async function setWebhook(token: string, url: string, secret: string) {
  await telegramApi<boolean>(token, 'setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
  });
}

async function deleteWebhook(token: string) {
  await telegramApi<boolean>(token, 'deleteWebhook', { drop_pending_updates: true });
}

async function setCommands(token: string) {
  await telegramApi<boolean>(token, 'setMyCommands', {
    commands: [
      { command: 'start', description: 'Open launch and support options' },
      { command: 'help', description: 'Get help' },
    ],
  });
}

async function sendTelegramMessage(token: string, chatId: string, text: string) {
  return telegramApi<{ message_id?: number }>(token, 'sendMessage', {
    chat_id: chatId,
    text,
  });
}

function managedTelegramGovernanceMetadata(action: string, governed: EvaluateResult) {
  const helmDocumentVersionPins = managedTelegramHelmDocumentVersionPins(
    governed.receipt.policyVersion,
  );
  return {
    surface: 'managed_telegram',
    action,
    policyDecisionId: governed.receipt.decisionId,
    policyVersion: governed.receipt.policyVersion,
    helmDocumentVersionPins,
    evidencePackId: governed.evidencePackId ?? null,
    policyPin: {
      policyDecisionId: governed.receipt.decisionId,
      policyVersion: governed.receipt.policyVersion,
      decisionRequired: true,
      documentVersionPins: helmDocumentVersionPins,
    },
  };
}

function managedTelegramSupportDraftMetadata(result: LlmResult) {
  const helmDocumentVersionPins = result.governance?.policyVersion
    ? managedTelegramHelmDocumentVersionPins(result.governance.policyVersion)
    : {};
  return {
    surface: 'managed_telegram',
    action: TELEGRAM_MANAGED_ACTIONS.DRAFT_SUPPORT,
    method: 'llm',
    policyDecisionId: result.governance?.decisionId ?? null,
    policyVersion: result.governance?.policyVersion ?? null,
    helmDocumentVersionPins,
    modelUsage: result.usage ?? null,
    credentialBoundary: 'no_raw_credentials_or_session_payloads_in_prompt',
    policyPin: result.governance
      ? {
          policyDecisionId: result.governance.decisionId,
          policyVersion: result.governance.policyVersion,
          decisionRequired: true,
          documentVersionPins: helmDocumentVersionPins,
        }
      : null,
  };
}

async function appendManagedTelegramInboundEvidence(
  db: Pick<Db, 'insert' | 'update'>,
  input: ManagedTelegramInboundEvidenceInput,
) {
  const auditEventId = randomUUID();
  const metadata = {
    ...input.metadata,
    surface: 'managed_telegram',
    managedBotId: input.managedBotId,
    evidenceContract: 'managed_telegram_inbound_audit_before_response',
    credentialBoundary: 'no_raw_credentials_or_session_payloads_in_evidence',
  };

  await db.insert(auditLog).values({
    id: auditEventId,
    workspaceId: input.workspaceId,
    action: input.action,
    actor: `managed_telegram_bot:${input.managedBotId}`,
    target: input.target,
    verdict: 'allow',
    metadata: {
      ...metadata,
      evidenceType: input.evidenceType,
      replayRef: input.replayRef,
      evidenceItemId: null,
    },
  });

  const evidenceItemId = await appendEvidenceItem(db, {
    workspaceId: input.workspaceId,
    auditEventId,
    evidenceType: input.evidenceType,
    sourceType: 'managed_telegram_webhook',
    title: input.title,
    summary: input.summary,
    redactionState: 'redacted',
    sensitivity: input.sensitivity,
    contentHash: `sha256:${stableHash(JSON.stringify(metadata))}`,
    replayRef: input.replayRef,
    metadata,
  });

  await db
    .update(auditLog)
    .set({
      metadata: {
        ...metadata,
        evidenceType: input.evidenceType,
        replayRef: input.replayRef,
        evidenceItemId,
      },
    })
    .where(and(eq(auditLog.workspaceId, input.workspaceId), eq(auditLog.id, auditEventId)));
}

async function appendManagedTelegramControlEvidence(
  db: Pick<Db, 'insert' | 'update'>,
  input: ManagedTelegramControlEvidenceInput,
) {
  const auditEventId = randomUUID();
  const metadata = {
    ...input.metadata,
    surface: 'managed_telegram',
    evidenceContract: 'managed_telegram_control_audit_before_mutation',
    credentialBoundary: 'no_raw_credentials_or_session_payloads_in_evidence',
  };

  await db.insert(auditLog).values({
    id: auditEventId,
    workspaceId: input.workspaceId,
    action: input.action,
    actor: input.actor,
    target: input.target,
    verdict: 'pending',
    reason: 'Managed Telegram control-plane mutation intent recorded before state mutation.',
    metadata: {
      ...metadata,
      evidenceType: input.evidenceType,
      replayRef: input.replayRef,
      evidenceItemId: null,
    },
  });

  const evidenceItemId = await appendEvidenceItem(db, {
    workspaceId: input.workspaceId,
    auditEventId,
    evidenceType: input.evidenceType,
    sourceType: 'managed_telegram_control',
    title: input.title,
    summary: input.summary,
    redactionState: 'redacted',
    sensitivity: input.sensitivity,
    contentHash: `sha256:${stableHash(JSON.stringify(metadata))}`,
    replayRef: input.replayRef,
    metadata,
  });

  await db
    .update(auditLog)
    .set({
      verdict: input.auditVerdict ?? 'allow',
      reason: input.auditReason ?? null,
      metadata: {
        ...metadata,
        evidenceType: input.evidenceType,
        replayRef: input.replayRef,
        evidenceItemId,
      },
    })
    .where(and(eq(auditLog.workspaceId, input.workspaceId), eq(auditLog.id, auditEventId)));

  return { auditEventId, evidenceItemId };
}

function managedTelegramInboundMetadata(
  row: ManagedBotRow,
  from: { id: string | number; username?: string; first_name?: string; last_name?: string },
  chat: { id: string | number },
  extra: Record<string, unknown>,
) {
  const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ');
  return {
    managedBotId: row.id,
    telegramBotUsername: row.telegramBotUsername,
    telegramChatIdHash: stableHash(String(chat.id)),
    telegramUserIdHash: stableHash(String(from.id)),
    telegramUsernameHash: from.username ? stableHash(from.username) : null,
    nameHash: displayName ? stableHash(displayName) : null,
    rawTelegramIdentityStoredInEvidence: false,
    ...extra,
  };
}

function managedTelegramSettingsEvidenceMetadata(
  row: ManagedBotRow,
  input: ManagedTelegramBotSettings,
  changedFields: string[],
) {
  return {
    managedBotId: row.id,
    telegramBotUsername: row.telegramBotUsername,
    changedFields,
    responseMode: input.responseMode ?? null,
    welcomeCopyHash: input.welcomeCopy === undefined ? null : stableHash(input.welcomeCopy),
    welcomeCopyLength: input.welcomeCopy?.length ?? null,
    launchUrlHash: input.launchUrl === undefined ? null : stableHash(input.launchUrl ?? ''),
    launchUrlProvided: input.launchUrl !== undefined,
    supportPromptHash:
      input.supportPrompt === undefined ? null : stableHash(input.supportPrompt ?? ''),
    supportPromptLength: input.supportPrompt?.length ?? null,
    rawSettingsValuesStoredInEvidence: false,
  };
}

function managedTelegramElevatedControlMetadata(
  row: ManagedBotRow,
  governance: ManagedTelegramGovernanceMetadata | undefined,
) {
  return {
    managedBotId: row.id,
    telegramBotIdHash: stableHash(row.telegramBotId),
    tokenSecretRefHash: stableHash(row.tokenSecretRef),
    rawTelegramBotIdStoredInEvidence: false,
    rawTokenSecretRefStoredInEvidence: false,
    policyDecisionId: governance?.policyDecisionId ?? null,
    policyVersion: governance?.policyVersion ?? null,
    evidencePackId: governance?.evidencePackId ?? null,
    helmDocumentVersionPins: governance?.helmDocumentVersionPins ?? {},
  };
}

function managedTelegramClaimControlMetadata(input: {
  requestId: string;
  managedBotId: string;
  telegramBotId: string;
  telegramBotUsername: string;
  tokenSecretRef: string;
  governance: ManagedTelegramGovernanceMetadata | undefined;
}) {
  return {
    requestId: input.requestId,
    managedBotId: input.managedBotId,
    telegramBotIdHash: stableHash(input.telegramBotId),
    telegramBotUsernameHash: stableHash(input.telegramBotUsername),
    tokenSecretRefHash: stableHash(input.tokenSecretRef),
    rawTelegramBotIdStoredInEvidence: false,
    rawTelegramBotUsernameStoredInEvidence: false,
    rawTokenSecretRefStoredInEvidence: false,
    policyDecisionId: input.governance?.policyDecisionId ?? null,
    policyVersion: input.governance?.policyVersion ?? null,
    evidencePackId: input.governance?.evidencePackId ?? null,
    helmDocumentVersionPins: input.governance?.helmDocumentVersionPins ?? {},
  };
}

function managedTelegramWebhookControlMetadata(
  row: ManagedBotRow,
  webhookUrl: string,
  governance: ManagedTelegramGovernanceMetadata | undefined,
) {
  return {
    managedBotId: row.id,
    telegramBotIdHash: stableHash(row.telegramBotId),
    tokenSecretRefHash: stableHash(row.tokenSecretRef),
    webhookUrlHash: stableHash(webhookUrl),
    rawTelegramBotIdStoredInEvidence: false,
    rawTokenSecretRefStoredInEvidence: false,
    rawWebhookUrlStoredInEvidence: false,
    rawWebhookSecretStoredInEvidence: false,
    policyDecisionId: governance?.policyDecisionId ?? null,
    policyVersion: governance?.policyVersion ?? null,
    evidencePackId: governance?.evidencePackId ?? null,
    helmDocumentVersionPins: governance?.helmDocumentVersionPins ?? {},
  };
}

function managedTelegramWebhookGovernanceMetadata(
  governance: ManagedTelegramGovernanceMetadata | undefined,
  evidence: {
    auditEventId: string;
    evidenceItemId: string;
  },
  commandFailureEvidence?: {
    auditEventId: string;
    evidenceItemId: string;
  },
) {
  return {
    ...(governance ?? {
      surface: 'managed_telegram',
      action: TELEGRAM_MANAGED_ACTIONS.SET_WEBHOOK,
      policyDecisionId: null,
      policyVersion: null,
      helmDocumentVersionPins: {},
      evidencePackId: null,
      policyPin: null,
    }),
    evidence: managedTelegramControlEvidenceMetadata(evidence),
    commandSetupFailedEvidence: commandFailureEvidence
      ? managedTelegramControlEvidenceMetadata(commandFailureEvidence)
      : undefined,
  };
}

function managedTelegramApprovalRequestMetadata(message: ManagedMessageRow, draft: string) {
  return {
    managedBotId: message.managedBotId,
    messageId: message.id,
    telegramChatIdHash: stableHash(message.telegramChatId),
    telegramUserIdHash: stableHash(message.telegramUserId),
    inboundMessageIdHash: stableHash(String(message.inboundMessageId)),
    draftHash: replyTextHash(draft),
    rawTelegramChatIdStoredInEvidence: false,
    rawTelegramUserIdStoredInEvidence: false,
    rawInboundTextStoredInEvidence: false,
    rawDraftStoredInEvidence: false,
  };
}

function managedTelegramControlEvidenceMetadata(evidence: {
  auditEventId: string;
  evidenceItemId: string;
}) {
  return {
    auditEventId: evidence.auditEventId,
    evidenceItemId: evidence.evidenceItemId,
  };
}

function managedTelegramSendEvidenceMetadata(
  message: ManagedMessageRow,
  text: string,
  governance: ManagedTelegramGovernanceMetadata | undefined,
  extra: Record<string, unknown>,
) {
  return {
    surface: 'managed_telegram',
    action: TELEGRAM_MANAGED_ACTIONS.SEND_MESSAGE,
    managedBotId: message.managedBotId,
    messageId: message.id,
    telegramChatIdHash: stableHash(message.telegramChatId),
    telegramUserIdHash: stableHash(message.telegramUserId),
    replyTextHash: replyTextHash(text),
    replyTextLength: text.length,
    policyDecisionId: governance?.policyDecisionId ?? null,
    policyVersion: governance?.policyVersion ?? null,
    evidencePackId: governance?.evidencePackId ?? null,
    helmDocumentVersionPins: governance?.helmDocumentVersionPins ?? {},
    credentialBoundary: 'no_raw_credentials_or_session_payloads_in_evidence',
    ...extra,
  };
}

function deterministicSupportDraft(fallbackReason: string): ManagedTelegramSupportDraft {
  return {
    text: 'Thanks for reaching out. I am looking into this and will follow up shortly.',
    governanceMetadata: {
      surface: 'managed_telegram',
      action: TELEGRAM_MANAGED_ACTIONS.DRAFT_SUPPORT,
      method: 'deterministic_fallback',
      fallbackReason,
      policyDecisionId: null,
      policyVersion: null,
      helmDocumentVersionPins: {},
      modelUsage: null,
      credentialBoundary: 'no_raw_credentials_or_session_payloads_in_prompt',
      policyPin: null,
    },
  };
}

function requiresProductionGovernedSupportDrafts(): boolean {
  return process.env['NODE_ENV'] === 'production' && process.env['HELM_FAIL_CLOSED'] !== '0';
}

function managedTelegramHelmDocumentVersionPins(policyVersion: string): Record<string, string> {
  return { managedTelegramPolicy: policyVersion };
}

function appendGovernanceMetadata(
  current: unknown,
  key: string,
  governance: Record<string, unknown> | undefined,
) {
  const base = isRecord(current) ? current : {};
  if (!governance) return base;
  return {
    ...base,
    [key]: governance,
  };
}

function stableHash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function replyTextHash(text: string) {
  return stableHash(text);
}

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function telegramApi<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => null)) as {
    ok: boolean;
    result?: T;
    description?: string;
  } | null;
  if (!response.ok || !data?.ok) {
    throw new ManagedTelegramBotError(
      data?.description ?? `Telegram ${method} failed`,
      response.ok ? 502 : response.status,
    );
  }
  return data.result as T;
}

function serializeBot(row: ManagedBotRow) {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    telegramBotId: row.telegramBotId,
    telegramBotUsername: row.telegramBotUsername,
    telegramBotName: row.telegramBotName,
    purpose: 'launch_support' as const,
    status: row.status as 'active' | 'disabled' | 'error',
    responseMode: row.responseMode as ManagedTelegramBotResponseMode,
    welcomeCopy: row.welcomeCopy,
    launchUrl: row.launchUrl,
    supportPrompt: row.supportPrompt,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    disabledAt: row.disabledAt?.toISOString() ?? null,
  };
}

function serializeProvisioningRequest(
  row: typeof managedTelegramBotProvisioningRequests.$inferSelect,
) {
  return {
    id: row.id,
    creationUrl: row.creationUrl,
    suggestedUsername: row.suggestedUsername,
    suggestedName: row.suggestedName,
    managerBotUsername: row.managerBotUsername,
    expiresAt: row.expiresAt.toISOString(),
  };
}

function serializeLead(row: typeof managedTelegramBotLeads.$inferSelect) {
  return {
    id: row.id,
    managedBotId: row.managedBotId,
    telegramUserId: row.telegramUserId,
    telegramUsername: row.telegramUsername,
    name: row.name,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeMessage(row: ManagedMessageRow) {
  return {
    id: row.id,
    managedBotId: row.managedBotId,
    telegramUserId: row.telegramUserId,
    telegramUsername: row.telegramUsername,
    telegramFirstName: row.telegramFirstName,
    inboundText: row.inboundText,
    aiDraft: row.aiDraft,
    replyText: row.replyText,
    replyStatus: row.replyStatus,
    approvalId: row.approvalId,
    createdAt: row.createdAt.toISOString(),
    repliedAt: row.repliedAt?.toISOString() ?? null,
  };
}

function tokenSecretRefFor(managedBotId: string): `custom_${string}` {
  return `custom_telegram_managed_bot_token_${managedBotId}`;
}

function asSecretKind(value: string): SecretKind {
  return value as SecretKind;
}

function hashSecret(secret: string) {
  return createHash('sha256').update(secret).digest('hex');
}

function timingSafeStringEqual(a: string, b: string) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.length === bBuffer.length && timingSafeEqual(aBuffer, bBuffer);
}

function normalizeTelegramUsername(value: string | undefined) {
  return value?.replace(/^@/, '').trim() || undefined;
}

function buildSuggestedBotUsername(workspaceName: string) {
  const base = workspaceName
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 18);
  const safe = /^[a-z]/.test(base) ? base : `hp_${base || 'pilot'}`;
  return `${safe}_launch_bot`.slice(0, 32);
}

function buildCreationUrl(
  managerBotUsername: string,
  suggestedUsername: string,
  suggestedName: string,
) {
  return `https://t.me/newbot/${managerBotUsername}/${suggestedUsername}?name=${encodeURIComponent(
    suggestedName,
  )}`;
}

function stripTrailingSlash(value: string | undefined) {
  return value?.replace(/\/+$/, '');
}
