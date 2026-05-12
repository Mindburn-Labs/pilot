import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  approvals,
  auditLog,
  evidenceItems,
  managedTelegramBotLeads,
  managedTelegramBotMessages,
  managedTelegramBots,
  workspaceMembers,
  workspaces,
} from '@pilot/db/schema';
import { launchRoutes } from '../../routes/launch.js';
import { managedTelegramWebhookRoutes } from '../../routes/telegram-managed.js';
import { createMockDeps, expectJson } from '../helpers.js';
import {
  ManagedTelegramBotService,
  TELEGRAM_MANAGED_ACTIONS,
  managedTelegramActionEffectLevel,
} from '../../services/managed-telegram-bots.js';

type ManagedTelegramActionEvaluator = {
  evaluateAction(input: {
    workspaceId: string;
    action: string;
    resource: string;
    context?: Record<string, unknown>;
  }): Promise<unknown>;
};

type ManagedTelegramDraftBuilder = {
  buildSupportDraft(
    row: Record<string, unknown>,
    inboundText: string,
  ): Promise<{
    text: string;
    governanceMetadata: Record<string, unknown>;
  }>;
};

type ManagedTelegramSupportCapturer = {
  captureSupportMessage(managedBotId: string, ctx: unknown): Promise<void>;
};
type ManagedTelegramLeadCapturer = {
  captureLead(managedBotId: string, ctx: unknown): Promise<void>;
};

function makeManagedTelegramActionDb(options: { failEvidenceInsert?: boolean } = {}) {
  const inserts: Array<{ table: unknown; value: unknown }> = [];
  const updates: Array<{ table: unknown; value: unknown }> = [];
  const state: {
    workspace: Record<string, unknown>;
    membership: Record<string, unknown>;
    bot: Record<string, unknown>;
    lead: Record<string, unknown> | null;
    message: Record<string, unknown>;
  } = {
    workspace: { id: 'ws-1', ownerId: 'user-1' },
    membership: { workspaceId: 'ws-1', userId: 'user-1', role: 'owner' },
    bot: {
      id: 'bot-1',
      workspaceId: 'ws-1',
      creatorUserId: 'user-1',
      creatorTelegramId: '999',
      telegramBotId: '123',
      telegramBotUsername: 'pilot_launch_bot',
      telegramBotName: 'Pilot Launch Bot',
      purpose: 'launch_support',
      status: 'active',
      responseMode: 'approval_required',
      tokenSecretRef: 'custom_telegram_managed_bot_token_bot-1',
      webhookSecretHash: 'hash',
      welcomeCopy: 'Welcome.',
      launchUrl: null,
      supportPrompt: 'Support.',
      lastError: null,
      governanceMetadata: {},
      createdAt: new Date('2026-05-05T00:00:00Z'),
      updatedAt: new Date('2026-05-05T00:00:00Z'),
      disabledAt: null,
    },
    lead: null,
    message: {
      id: 'msg-1',
      managedBotId: 'bot-1',
      workspaceId: 'ws-1',
      telegramChatId: 'chat-1',
      telegramUserId: 'tg-user-1',
      telegramUsername: 'founder_user',
      telegramFirstName: 'Founder',
      inboundText: 'Need help',
      inboundMessageId: 99,
      intent: 'support',
      aiDraft: 'Draft reply',
      approvalId: null,
      replyText: null,
      replyStatus: 'drafted',
      sentMessageId: null,
      error: null,
      governanceMetadata: {},
      createdAt: new Date('2026-05-05T00:00:00Z'),
      updatedAt: new Date('2026-05-05T00:00:00Z'),
      repliedAt: null,
    },
  };

  const resultForTable = (table: unknown) => {
    if (table === workspaces) return [state.workspace];
    if (table === workspaceMembers) return [state.membership];
    if (table === managedTelegramBotLeads) return state.lead ? [state.lead] : [];
    if (table === managedTelegramBotMessages) return [state.message];
    if (table === managedTelegramBots) return [state.bot];
    return [];
  };

  const updateTable = (table: unknown, values: Record<string, unknown>) => {
    updates.push({ table, value: values });
    if (table === managedTelegramBots) {
      state.bot = { ...state.bot, ...values };
      return [state.bot];
    }
    if (table === managedTelegramBotMessages) {
      state.message = { ...state.message, ...values };
      return [state.message];
    }
    if (table === managedTelegramBotLeads) {
      state.lead = { ...(state.lead ?? {}), ...values };
      return [state.lead];
    }
    return [];
  };

  const insertTable = (table: unknown, values: Record<string, unknown>) => {
    inserts.push({ table, value: values });
    if (table === managedTelegramBotMessages) {
      state.message = {
        ...state.message,
        ...values,
        id: values['id'] ?? state.message['id'] ?? 'msg-1',
      };
      return [state.message];
    }
    if (table === managedTelegramBotLeads) {
      state.lead = {
        ...values,
        id: values['id'] ?? 'lead-1',
        createdAt: new Date('2026-05-05T00:00:00Z'),
        updatedAt: new Date('2026-05-05T00:00:00Z'),
      };
      return [state.lead];
    }
    if (table === approvals) {
      return [
        {
          id: 'approval-1',
          workspaceId: values['workspaceId'],
          action: values['action'],
          status: values['status'],
        },
      ];
    }
    if (table === evidenceItems) {
      if (options.failEvidenceInsert) throw new Error('send evidence unavailable');
      return [{ id: 'evidence-send-item' }];
    }
    return [];
  };

  const db: any = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          orderBy: () => ({ limit: () => Promise.resolve(resultForTable(table)) }),
          limit: () => Promise.resolve(resultForTable(table)),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        returning: () => Promise.resolve(insertTable(table, values)),
        then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
          Promise.resolve(insertTable(table, values)).then(resolve, reject),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: () => Promise.resolve(updateTable(table, values)),
          then: (resolve: (value: unknown[]) => void, reject?: (reason: unknown) => void) =>
            Promise.resolve(updateTable(table, values)).then(resolve, reject),
        }),
      }),
    }),
  };
  db.transaction = vi.fn(async (callback: (tx: typeof db) => Promise<unknown>) => callback(db));

  return { db: db as never, state, inserts, updates };
}

function appWithContext(routeFactory: typeof launchRoutes, deps = createMockDeps()) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    c.set('workspaceId', 'ws-1');
    c.set('workspaceRole', 'owner');
    await next();
  });
  app.route('/', routeFactory(deps));
  return {
    deps,
    fetch(method: string, path: string, body?: unknown, headers?: Record<string, string>) {
      return app.fetch(
        new Request(`http://localhost${path}`, {
          method,
          headers: { 'Content-Type': 'application/json', ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
    },
  };
}

describe('managed Telegram launch routes', () => {
  it('returns launch bot state', async () => {
    const managedTelegram = {
      getState: vi.fn(async () => ({ bot: null, pendingRequest: null, leads: [], messages: [] })),
    };
    const { fetch } = appWithContext(launchRoutes, createMockDeps({ managedTelegram } as never));

    const res = await fetch('GET', '/telegram-bot');
    const body = await expectJson<{ bot: null }>(res, 200);

    expect(body.bot).toBeNull();
    expect(managedTelegram.getState).toHaveBeenCalledWith('ws-1');
  });

  it('creates provisioning request only for Telegram-linked users', async () => {
    const managedTelegram = {
      createProvisioningRequest: vi.fn(async () => ({
        id: '00000000-0000-4000-8000-000000000001',
        creationUrl: 'https://t.me/newbot/Manager/acme_launch_bot?name=Acme',
        suggestedUsername: 'acme_launch_bot',
        suggestedName: 'Acme Launch Support',
        managerBotUsername: 'Manager',
        expiresAt: new Date().toISOString(),
      })),
    };
    const deps = createMockDeps({ managedTelegram } as never);
    deps.db._setResult([{ id: 'user-1', telegramId: '999' }]);
    const { fetch } = appWithContext(launchRoutes, deps);

    const res = await fetch('POST', '/telegram-bot/provisioning-request', {});
    await expectJson(res, 201);

    expect(managedTelegram.createProvisioningRequest).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      userId: 'user-1',
      creatorTelegramId: '999',
    });
  });

  it('updates managed bot settings through the service', async () => {
    const managedTelegram = {
      updateSettings: vi.fn(async () => ({
        id: '00000000-0000-4000-8000-000000000001',
        responseMode: 'approval_required',
      })),
    };
    const { fetch } = appWithContext(launchRoutes, createMockDeps({ managedTelegram } as never));

    const res = await fetch('PATCH', '/telegram-bot/settings', {
      responseMode: 'approval_required',
    });
    await expectJson(res, 200);

    expect(managedTelegram.updateSettings).toHaveBeenCalledWith('ws-1', 'user-1', {
      responseMode: 'approval_required',
    });
  });
});

describe('managed Telegram child webhook route', () => {
  it('rejects invalid webhook secrets before handling the update', async () => {
    const managedTelegram = {
      getBotForWebhook: vi.fn(async () => ({ id: 'bot-1', webhookSecretHash: 'hash' })),
      verifyWebhookSecret: vi.fn(() => false),
      handleChildWebhook: vi.fn(),
    };
    const app = new Hono();
    app.route('/', managedTelegramWebhookRoutes(createMockDeps({ managedTelegram } as never)));

    const res = await app.fetch(
      new Request('http://localhost/bot-1/webhook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ update_id: 1 }),
      }),
    );

    await expectJson(res, 403);
    expect(managedTelegram.handleChildWebhook).not.toHaveBeenCalled();
  });

  it('accepts valid webhook secrets and dispatches the update', async () => {
    const managedTelegram = {
      getBotForWebhook: vi.fn(async () => ({ id: 'bot-1', webhookSecretHash: 'hash' })),
      verifyWebhookSecret: vi.fn(() => true),
      handleChildWebhook: vi.fn(async () => {}),
    };
    const app = new Hono();
    app.route('/', managedTelegramWebhookRoutes(createMockDeps({ managedTelegram } as never)));

    const res = await app.fetch(
      new Request('http://localhost/bot-1/webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Telegram-Bot-Api-Secret-Token': 'secret',
        },
        body: JSON.stringify({ update_id: 1 }),
      }),
    );

    await expectJson(res, 200);
    expect(managedTelegram.handleChildWebhook).toHaveBeenCalledWith('bot-1', { update_id: 1 });
  });
});

describe('managed Telegram service governance', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('classifies managed bot actions with explicit HELM effect levels', () => {
    expect(managedTelegramActionEffectLevel(TELEGRAM_MANAGED_ACTIONS.DRAFT_SUPPORT)).toBe('E1');
    expect(managedTelegramActionEffectLevel(TELEGRAM_MANAGED_ACTIONS.SEND_MESSAGE)).toBe('E2');
    expect(managedTelegramActionEffectLevel(TELEGRAM_MANAGED_ACTIONS.CLAIM)).toBe('E3');
    expect(managedTelegramActionEffectLevel(TELEGRAM_MANAGED_ACTIONS.SET_WEBHOOK)).toBe('E3');
    expect(managedTelegramActionEffectLevel(TELEGRAM_MANAGED_ACTIONS.ROTATE_TOKEN)).toBe('E3');
    expect(managedTelegramActionEffectLevel(TELEGRAM_MANAGED_ACTIONS.DISABLE)).toBe('E3');
  });

  it('fails closed for elevated managed bot actions without HELM', async () => {
    const deps = createMockDeps();
    const service = new ManagedTelegramBotService({ db: deps.db as never });

    await expect(
      (service as unknown as ManagedTelegramActionEvaluator).evaluateAction({
        workspaceId: 'ws-1',
        action: TELEGRAM_MANAGED_ACTIONS.SEND_MESSAGE,
        resource: 'telegram-managed-message:msg-1',
      }),
    ).rejects.toMatchObject({
      status: 503,
      message: 'HELM governance client is required for elevated Telegram managed bot actions',
    });
  });

  it('passes managed bot effect levels into HELM evaluation', async () => {
    const deps = createMockDeps();
    const helmClient = {
      evaluate: vi.fn(async () => ({
        receipt: { decisionId: 'dec-1', verdict: 'ALLOW', reason: 'allowed' },
      })),
    };
    const service = new ManagedTelegramBotService({
      db: deps.db as never,
      helmClient: helmClient as never,
    });

    await (service as unknown as ManagedTelegramActionEvaluator).evaluateAction({
      workspaceId: 'ws-1',
      action: TELEGRAM_MANAGED_ACTIONS.SET_WEBHOOK,
      resource: 'telegram:123',
      context: { managedBotId: 'bot-1' },
    });

    expect(helmClient.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: 'workspace:ws-1/operator:launch',
        action: TELEGRAM_MANAGED_ACTIONS.SET_WEBHOOK,
        resource: 'telegram:123',
        effectLevel: 'E3',
        context: expect.objectContaining({
          workspaceId: 'ws-1',
          managedBotId: 'bot-1',
        }),
      }),
    );
  });

  it('persists governed LLM metadata on managed Telegram support drafts', async () => {
    const { db, state } = makeManagedTelegramActionDb();
    const llm = {
      complete: vi.fn(async () => 'Legacy reply'),
      completeWithUsage: vi.fn(async () => ({
        content: 'Governed support reply',
        usage: { tokensIn: 22, tokensOut: 9, model: 'support-model' },
        governance: {
          decisionId: 'dec-draft',
          verdict: 'ALLOW' as const,
          policyVersion: 'founder-ops-v1',
          principal: 'workspace:ws-1/operator:launch',
        },
      })),
    };
    const service = new ManagedTelegramBotService({
      db,
      llm,
    });
    const ctx = {
      from: { id: 777, username: 'founder_user', first_name: 'Founder' },
      chat: { id: 888 },
      message: { message_id: 42, text: 'Can Pilot deploy this?' },
      reply: vi.fn(async () => ({ message_id: 4242 })),
    };

    await (service as unknown as ManagedTelegramSupportCapturer).captureSupportMessage(
      'bot-1',
      ctx,
    );

    expect(llm.completeWithUsage).toHaveBeenCalledOnce();
    expect(llm.complete).not.toHaveBeenCalled();
    expect(state.message['aiDraft']).toBe('Governed support reply');
    expect(state.message['replyStatus']).toBe('awaiting_approval');
    expect(state.message['governanceMetadata']).toMatchObject({
      supportDraft: {
        surface: 'managed_telegram',
        action: TELEGRAM_MANAGED_ACTIONS.DRAFT_SUPPORT,
        method: 'llm',
        policyDecisionId: 'dec-draft',
        policyVersion: 'founder-ops-v1',
        helmDocumentVersionPins: { managedTelegramPolicy: 'founder-ops-v1' },
        modelUsage: { tokensIn: 22, tokensOut: 9, model: 'support-model' },
        credentialBoundary: 'no_raw_credentials_or_session_payloads_in_prompt',
        policyPin: {
          policyDecisionId: 'dec-draft',
          policyVersion: 'founder-ops-v1',
          decisionRequired: true,
          documentVersionPins: { managedTelegramPolicy: 'founder-ops-v1' },
        },
      },
    });
  });

  it('persists audit-linked evidence for managed Telegram lead capture', async () => {
    const { db, state, inserts, updates } = makeManagedTelegramActionDb();
    const service = new ManagedTelegramBotService({ db });
    const ctx = {
      from: { id: 777, username: 'founder_user', first_name: 'Founder' },
      chat: { id: 888 },
    };

    await (service as unknown as ManagedTelegramLeadCapturer).captureLead('bot-1', ctx);

    expect(state.lead).toMatchObject({
      managedBotId: 'bot-1',
      workspaceId: 'ws-1',
      telegramUserId: '777',
    });
    const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
      id: string;
      metadata: Record<string, unknown>;
    };
    expect(auditInsert).toMatchObject({
      workspaceId: 'ws-1',
      action: 'TELEGRAM_CHILD_LEAD_CAPTURED',
      actor: 'managed_telegram_bot:bot-1',
      target: state.lead?.['id'],
      verdict: 'allow',
    });
    expect(JSON.stringify(auditInsert.metadata)).not.toContain('founder_user');
    expect(JSON.stringify(auditInsert.metadata)).not.toContain('Founder');

    const evidenceInsert = inserts.find((insert) => insert.table === evidenceItems)?.value as {
      auditEventId: string;
      evidenceType: string;
      metadata: Record<string, unknown>;
      replayRef: string;
    };
    expect(evidenceInsert).toMatchObject({
      auditEventId: auditInsert.id,
      evidenceType: 'managed_telegram_lead_captured',
      replayRef: `managed-telegram-lead:${state.lead?.['id']}:captured`,
      metadata: expect.objectContaining({
        rawTelegramIdentityStoredInEvidence: false,
        existingLead: false,
        credentialBoundary: 'no_raw_credentials_or_session_payloads_in_evidence',
      }),
    });
    expect(updates.filter((update) => update.table === auditLog).at(-1)?.value).toMatchObject({
      metadata: expect.objectContaining({ evidenceItemId: 'evidence-send-item' }),
    });
  });

  it('persists audit-linked redacted evidence for managed Telegram support intake', async () => {
    const { db, inserts, updates } = makeManagedTelegramActionDb();
    const service = new ManagedTelegramBotService({ db });
    const ctx = {
      from: { id: 777, username: 'founder_user', first_name: 'Founder' },
      chat: { id: 888 },
      message: { message_id: 42, text: 'Can Pilot deploy this?' },
      reply: vi.fn(async () => ({ message_id: 4242 })),
    };

    await (service as unknown as ManagedTelegramSupportCapturer).captureSupportMessage(
      'bot-1',
      ctx,
    );

    const auditInsert = inserts.find(
      (insert) =>
        insert.table === auditLog &&
        (insert.value as { action?: string }).action ===
          'TELEGRAM_CHILD_SUPPORT_MESSAGE_CAPTURED',
    )?.value as { id: string; metadata: Record<string, unknown> };
    expect(auditInsert).toMatchObject({
      workspaceId: 'ws-1',
      actor: 'managed_telegram_bot:bot-1',
      verdict: 'allow',
      metadata: expect.objectContaining({
        rawInboundTextStoredInEvidence: false,
        inboundTextHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        inboundTextLength: 22,
      }),
    });
    expect(JSON.stringify(auditInsert.metadata)).not.toContain('Can Pilot deploy this?');
    expect(JSON.stringify(auditInsert.metadata)).not.toContain('founder_user');

    const evidenceInsert = inserts.find(
      (insert) =>
        insert.table === evidenceItems &&
        (insert.value as { evidenceType?: string }).evidenceType ===
          'managed_telegram_support_message_captured',
    )?.value as { auditEventId: string; metadata: Record<string, unknown> };
    expect(evidenceInsert).toMatchObject({
      auditEventId: auditInsert.id,
      metadata: expect.objectContaining({
        rawInboundTextStoredInEvidence: false,
        evidenceContract: 'managed_telegram_inbound_audit_before_response',
      }),
    });
    expect(updates.filter((update) => update.table === auditLog).at(-1)?.value).toMatchObject({
      metadata: expect.objectContaining({ evidenceItemId: 'evidence-send-item' }),
    });
    expect(ctx.reply).toHaveBeenCalledWith('Thanks. Your message reached the founder team.');
  });

  it('fails closed before acknowledging support intake when evidence persistence fails', async () => {
    const { db, inserts } = makeManagedTelegramActionDb({ failEvidenceInsert: true });
    const service = new ManagedTelegramBotService({ db });
    const ctx = {
      from: { id: 777, username: 'founder_user', first_name: 'Founder' },
      chat: { id: 888 },
      message: { message_id: 42, text: 'Can Pilot deploy this?' },
      reply: vi.fn(async () => ({ message_id: 4242 })),
    };

    await expect(
      (service as unknown as ManagedTelegramSupportCapturer).captureSupportMessage('bot-1', ctx),
    ).rejects.toThrow('send evidence unavailable');

    expect(ctx.reply).not.toHaveBeenCalled();
    expect(inserts.some((insert) => insert.table === approvals)).toBe(false);
  });

  it('fails closed for production support drafts without governed LLM metadata', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('HELM_FAIL_CLOSED', '1');
    const { db, state } = makeManagedTelegramActionDb();
    const llm = {
      complete: vi.fn(async () => 'Legacy reply'),
      completeWithUsage: vi.fn(async () => ({
        content: 'Ungoverned reply',
        usage: { tokensIn: 10, tokensOut: 5, model: 'support-model' },
      })),
    };
    const service = new ManagedTelegramBotService({
      db,
      llm,
    });

    await expect(
      (service as unknown as ManagedTelegramDraftBuilder).buildSupportDraft(
        state.bot,
        'Can Pilot deploy this?',
      ),
    ).rejects.toMatchObject({
      status: 503,
      message: 'HELM-governed LLM metadata is required for production Telegram support drafts',
    });
  });

  it('persists HELM policy pins when sending managed Telegram messages', async () => {
    const { db, state, inserts, updates } = makeManagedTelegramActionDb();
    const helmClient = {
      evaluate: vi.fn(async () => ({
        receipt: {
          decisionId: 'dec-send',
          verdict: 'ALLOW',
          reason: 'allowed',
          policyVersion: 'founder-ops-v1',
        },
        evidencePackId: 'evidence-send',
      })),
    };
    const service = new ManagedTelegramBotService({
      db,
      helmClient: helmClient as never,
    });
    Object.defineProperty(service as unknown as { secrets?: unknown }, 'secrets', {
      value: { get: vi.fn(async () => 'child-token') },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ok: true, result: { message_id: 123 } })),
    );

    await service.sendManualReply('ws-1', 'user-1', 'msg-1', 'Approved reply');

    expect(state.message['governanceMetadata']).toMatchObject({
      sendMessage: {
        surface: 'managed_telegram',
        action: TELEGRAM_MANAGED_ACTIONS.SEND_MESSAGE,
        policyDecisionId: 'dec-send',
        policyVersion: 'founder-ops-v1',
        helmDocumentVersionPins: { managedTelegramPolicy: 'founder-ops-v1' },
        evidencePackId: 'evidence-send',
        policyPin: {
          policyDecisionId: 'dec-send',
          policyVersion: 'founder-ops-v1',
          decisionRequired: true,
          documentVersionPins: { managedTelegramPolicy: 'founder-ops-v1' },
        },
      },
      sendEvidence: {
        auditEventId: expect.any(String),
        evidenceItemId: 'evidence-send-item',
        replayRef: 'managed-telegram-message:msg-1:send',
      },
    });
    const auditInsert = inserts.find((insert) => insert.table === auditLog)?.value as {
      id: string;
      metadata: Record<string, unknown>;
    };
    expect(auditInsert).toMatchObject({
      workspaceId: 'ws-1',
      action: TELEGRAM_MANAGED_ACTIONS.SEND_MESSAGE,
      actor: 'managed_telegram_bot:bot-1',
      target: 'telegram-managed-message:msg-1',
      verdict: 'pending',
      metadata: expect.objectContaining({
        status: 'pending',
        messageId: 'msg-1',
        managedBotId: 'bot-1',
        policyDecisionId: 'dec-send',
        credentialBoundary: 'no_raw_credentials_or_session_payloads_in_evidence',
      }),
    });
    expect(inserts.find((insert) => insert.table === evidenceItems)?.value).toMatchObject({
      workspaceId: 'ws-1',
      auditEventId: auditInsert.id,
      evidenceType: 'managed_telegram_send_intent',
      sourceType: 'managed_telegram',
      redactionState: 'redacted',
      sensitivity: 'confidential',
      metadata: expect.objectContaining({
        messageId: 'msg-1',
        telegramChatIdHash: expect.any(String),
        telegramUserIdHash: expect.any(String),
        replyTextHash: expect.any(String),
      }),
    });
    expect(updates.find((update) => update.table === auditLog)?.value).toMatchObject({
      metadata: expect.objectContaining({
        evidenceItemId: 'evidence-send-item',
      }),
    });
    expect(updates.filter((update) => update.table === auditLog).at(-1)?.value).toMatchObject({
      verdict: 'sent',
      metadata: expect.objectContaining({
        status: 'sent',
        sentMessageId: '123',
        evidenceItemId: 'evidence-send-item',
      }),
    });
  });

  it('fails closed before Telegram send when managed message evidence cannot be persisted', async () => {
    const { db, state } = makeManagedTelegramActionDb({ failEvidenceInsert: true });
    const helmClient = {
      evaluate: vi.fn(async () => ({
        receipt: {
          decisionId: 'dec-send',
          verdict: 'ALLOW',
          reason: 'allowed',
          policyVersion: 'founder-ops-v1',
        },
      })),
    };
    const service = new ManagedTelegramBotService({
      db,
      helmClient: helmClient as never,
    });
    Object.defineProperty(service as unknown as { secrets?: unknown }, 'secrets', {
      value: { get: vi.fn(async () => 'child-token') },
    });
    const fetch = vi.fn(async () => Response.json({ ok: true, result: { message_id: 123 } }));
    vi.stubGlobal('fetch', fetch);

    await expect(
      service.sendManualReply('ws-1', 'user-1', 'msg-1', 'Approved reply'),
    ).rejects.toThrow('send evidence unavailable');

    expect(fetch).not.toHaveBeenCalled();
    expect(state.message['replyStatus']).toBe('drafted');
  });

  it('persists HELM policy pins when disabling managed Telegram bots', async () => {
    const { db, state } = makeManagedTelegramActionDb();
    const helmClient = {
      evaluate: vi.fn(async () => ({
        receipt: {
          decisionId: 'dec-disable',
          verdict: 'ALLOW',
          reason: 'allowed',
          policyVersion: 'founder-ops-v1',
        },
        evidencePackId: 'evidence-disable',
      })),
    };
    const service = new ManagedTelegramBotService({
      db,
      helmClient: helmClient as never,
    });
    Object.defineProperty(service as unknown as { secrets?: unknown }, 'secrets', {
      value: {
        get: vi.fn(async () => null),
        delete: vi.fn(async () => true),
      },
    });

    await service.disable('ws-1', 'user-1');

    expect(state.bot['status']).toBe('disabled');
    expect(state.bot['governanceMetadata']).toMatchObject({
      disable: {
        surface: 'managed_telegram',
        action: TELEGRAM_MANAGED_ACTIONS.DISABLE,
        policyDecisionId: 'dec-disable',
        policyVersion: 'founder-ops-v1',
        helmDocumentVersionPins: { managedTelegramPolicy: 'founder-ops-v1' },
        evidencePackId: 'evidence-disable',
        policyPin: {
          policyDecisionId: 'dec-disable',
          policyVersion: 'founder-ops-v1',
          decisionRequired: true,
          documentVersionPins: { managedTelegramPolicy: 'founder-ops-v1' },
        },
      },
    });
  });
});
