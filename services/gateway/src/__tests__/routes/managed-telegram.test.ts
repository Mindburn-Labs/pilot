import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import {
  approvals,
  auditLog,
  evidenceItems,
  managedTelegramBotLeads,
  managedTelegramBotMessages,
  managedTelegramBotProvisioningRequests,
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
type ManagedTelegramApprovalRequester = {
  requestReplyApproval(message: Record<string, unknown>, draft: string): Promise<void>;
};

function makeManagedTelegramActionDb(
  options: { failEvidenceInsert?: boolean; failEvidenceType?: string; activeBot?: boolean } = {},
) {
  const inserts: Array<{ table: unknown; value: unknown }> = [];
  const updates: Array<{ table: unknown; value: unknown }> = [];
  const operations: Array<{ kind: 'insert' | 'update'; table: unknown; value: unknown }> = [];
  const state: {
    workspace: Record<string, unknown>;
    membership: Record<string, unknown>;
    bot: Record<string, unknown>;
    provisioningRequest: Record<string, unknown> | null;
    lead: Record<string, unknown> | null;
    message: Record<string, unknown>;
  } = {
    workspace: { id: 'ws-1', ownerId: 'user-1', name: 'Acme Labs' },
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
    provisioningRequest: null,
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
    if (table === managedTelegramBots) return options.activeBot === false ? [] : [state.bot];
    if (table === managedTelegramBotProvisioningRequests) {
      return state.provisioningRequest ? [state.provisioningRequest] : [];
    }
    return [];
  };

  const updateTable = (table: unknown, values: Record<string, unknown>) => {
    updates.push({ table, value: values });
    operations.push({ kind: 'update', table, value: values });
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
    if (table === managedTelegramBotProvisioningRequests) {
      state.provisioningRequest = { ...(state.provisioningRequest ?? {}), ...values };
      return state.provisioningRequest ? [state.provisioningRequest] : [];
    }
    return [];
  };

  const insertTable = (table: unknown, values: Record<string, unknown>) => {
    inserts.push({ table, value: values });
    operations.push({ kind: 'insert', table, value: values });
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
    if (table === managedTelegramBotProvisioningRequests) {
      state.provisioningRequest = {
        ...values,
        id: values['id'] ?? 'request-1',
        status: values['status'] ?? 'pending',
        createdAt: new Date('2026-05-05T00:00:00Z'),
        updatedAt: new Date('2026-05-05T00:00:00Z'),
      };
      return [state.provisioningRequest];
    }
    if (table === managedTelegramBots) {
      state.bot = {
        ...values,
        id: values['id'] ?? 'bot-1',
        createdAt: new Date('2026-05-05T00:00:00Z'),
        updatedAt: new Date('2026-05-05T00:00:00Z'),
        disabledAt: null,
        lastError: values['lastError'] ?? null,
      };
      return [state.bot];
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
      if (
        options.failEvidenceInsert ||
        options.failEvidenceType === (values as { evidenceType?: string }).evidenceType
      ) {
        throw new Error('send evidence unavailable');
      }
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

  return { db: db as never, state, inserts, updates, operations };
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

  it('persists audit-linked evidence before requesting managed Telegram send approval', async () => {
    const { db, state, inserts, operations } = makeManagedTelegramActionDb();
    const service = new ManagedTelegramBotService({ db });
    const notifier = vi.fn(async () => {});
    service.setApprovalNotifier(notifier);

    await (service as unknown as ManagedTelegramApprovalRequester).requestReplyApproval(
      state.message,
      'Draft approval reply',
    );

    expect(state.message).toMatchObject({
      approvalId: 'approval-1',
      replyText: 'Draft approval reply',
      replyStatus: 'awaiting_approval',
      governanceMetadata: {
        approvalRequestEvidence: {
          auditEventId: expect.any(String),
          evidenceItemId: 'evidence-send-item',
        },
      },
    });
    expect(notifier).toHaveBeenCalledWith(
      'ws-1',
      'approval-1',
      TELEGRAM_MANAGED_ACTIONS.SEND_MESSAGE,
      'Support reply draft for Telegram user tg-user-1',
    );

    const auditInsert = inserts.find(
      (insert) =>
        insert.table === auditLog &&
        (insert.value as { action?: string }).action ===
          TELEGRAM_MANAGED_ACTIONS.REQUEST_SEND_APPROVAL,
    )?.value as { id: string; metadata: Record<string, unknown> };
    expect(auditInsert).toMatchObject({
      workspaceId: 'ws-1',
      actor: 'managed_telegram_bot:bot-1',
      target: 'msg-1',
      verdict: 'pending',
    });

    const evidenceInsert = inserts.find(
      (insert) =>
        insert.table === evidenceItems &&
        (insert.value as { evidenceType?: string }).evidenceType ===
          'managed_telegram_send_approval_requested',
    )?.value as { auditEventId: string; metadata: Record<string, unknown> };
    expect(evidenceInsert).toMatchObject({
      workspaceId: 'ws-1',
      auditEventId: auditInsert.id,
      evidenceType: 'managed_telegram_send_approval_requested',
      sourceType: 'managed_telegram_control',
      sensitivity: 'restricted',
      metadata: expect.objectContaining({
        managedBotId: 'bot-1',
        messageId: 'msg-1',
        rawTelegramChatIdStoredInEvidence: false,
        rawTelegramUserIdStoredInEvidence: false,
        rawInboundTextStoredInEvidence: false,
        rawDraftStoredInEvidence: false,
      }),
    });
    expect(JSON.stringify(evidenceInsert.metadata)).not.toContain('Draft approval reply');
    expect(JSON.stringify(evidenceInsert.metadata)).not.toContain('Need help');
    expect(JSON.stringify(evidenceInsert.metadata)).not.toContain('tg-user-1');

    const evidenceIndex = operations.findIndex(
      (operation) =>
        operation.kind === 'insert' &&
        operation.table === evidenceItems &&
        (operation.value as { evidenceType?: string }).evidenceType ===
          'managed_telegram_send_approval_requested',
    );
    const approvalIndex = operations.findIndex(
      (operation) => operation.kind === 'insert' && operation.table === approvals,
    );
    const messageUpdateIndex = operations.findIndex(
      (operation) =>
        operation.kind === 'update' &&
        operation.table === managedTelegramBotMessages &&
        (operation.value as { replyStatus?: string }).replyStatus === 'awaiting_approval',
    );
    expect(evidenceIndex).toBeGreaterThanOrEqual(0);
    expect(approvalIndex).toBeGreaterThan(evidenceIndex);
    expect(messageUpdateIndex).toBeGreaterThan(approvalIndex);
  });

  it('fails closed before requesting managed Telegram send approval when evidence fails', async () => {
    const { db, state, inserts, updates } = makeManagedTelegramActionDb({
      failEvidenceType: 'managed_telegram_send_approval_requested',
    });
    const service = new ManagedTelegramBotService({ db });
    const notifier = vi.fn(async () => {});
    service.setApprovalNotifier(notifier);

    await expect(
      (service as unknown as ManagedTelegramApprovalRequester).requestReplyApproval(
        state.message,
        'Draft approval reply',
      ),
    ).rejects.toThrow('send evidence unavailable');

    expect(inserts.some((insert) => insert.table === approvals)).toBe(false);
    expect(
      updates.some(
        (update) =>
          update.table === managedTelegramBotMessages &&
          (update.value as { replyStatus?: string }).replyStatus === 'awaiting_approval',
      ),
    ).toBe(false);
    expect(notifier).not.toHaveBeenCalled();
    expect(state.message['replyStatus']).toBe('drafted');
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
        (insert.value as { action?: string }).action === 'TELEGRAM_CHILD_SUPPORT_MESSAGE_CAPTURED',
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

  it('persists audit-linked evidence before creating managed Telegram provisioning requests', async () => {
    const { db, state, inserts, operations } = makeManagedTelegramActionDb({ activeBot: false });
    const service = new ManagedTelegramBotService({
      db,
      managerBotToken: 'manager-token',
      managerBotUsername: 'Manager',
    });

    const request = await service.createProvisioningRequest({
      workspaceId: 'ws-1',
      userId: 'user-1',
      creatorTelegramId: '999',
    });

    expect(request.id).toBe(state.provisioningRequest?.['id']);
    expect(state.provisioningRequest).toMatchObject({
      workspaceId: 'ws-1',
      requestedByUserId: 'user-1',
      creatorTelegramId: '999',
      status: 'pending',
    });

    const auditInsert = inserts.find(
      (insert) =>
        insert.table === auditLog &&
        (insert.value as { action?: string }).action ===
          'TELEGRAM_MANAGED_BOT_PROVISIONING_REQUESTED',
    )?.value as { id: string; metadata: Record<string, unknown> };
    expect(auditInsert).toMatchObject({
      workspaceId: 'ws-1',
      actor: 'user:user-1',
      target: state.provisioningRequest?.['id'],
      verdict: 'pending',
      metadata: expect.objectContaining({
        rawCreatorTelegramIdStoredInEvidence: false,
        rawCreationUrlStoredInEvidence: false,
      }),
    });

    const evidenceInsert = inserts.find(
      (insert) =>
        insert.table === evidenceItems &&
        (insert.value as { evidenceType?: string }).evidenceType ===
          'managed_telegram_provisioning_requested',
    )?.value as { auditEventId: string; metadata: Record<string, unknown> };
    expect(evidenceInsert).toMatchObject({
      auditEventId: auditInsert.id,
      metadata: expect.objectContaining({
        evidenceContract: 'managed_telegram_control_audit_before_mutation',
        credentialBoundary: 'no_raw_credentials_or_session_payloads_in_evidence',
      }),
    });
    expect(JSON.stringify(evidenceInsert.metadata)).not.toContain('999');
    expect(JSON.stringify(evidenceInsert.metadata)).not.toContain('https://t.me');

    const evidenceIndex = operations.findIndex(
      (operation) =>
        operation.kind === 'insert' &&
        operation.table === evidenceItems &&
        (operation.value as { evidenceType?: string }).evidenceType ===
          'managed_telegram_provisioning_requested',
    );
    const requestIndex = operations.findIndex(
      (operation) =>
        operation.kind === 'insert' && operation.table === managedTelegramBotProvisioningRequests,
    );
    expect(evidenceIndex).toBeGreaterThanOrEqual(0);
    expect(requestIndex).toBeGreaterThan(evidenceIndex);
  });

  it('fails closed before provisioning request creation when control evidence fails', async () => {
    const { db, state, inserts } = makeManagedTelegramActionDb({
      activeBot: false,
      failEvidenceInsert: true,
    });
    const service = new ManagedTelegramBotService({
      db,
      managerBotToken: 'manager-token',
      managerBotUsername: 'Manager',
    });

    await expect(
      service.createProvisioningRequest({
        workspaceId: 'ws-1',
        userId: 'user-1',
        creatorTelegramId: '999',
      }),
    ).rejects.toThrow('send evidence unavailable');

    expect(state.provisioningRequest).toBeNull();
    expect(inserts.some((insert) => insert.table === managedTelegramBotProvisioningRequests)).toBe(
      false,
    );
  });

  it('persists redacted claim and webhook evidence before managed Telegram activation', async () => {
    const { db, state, inserts, operations } = makeManagedTelegramActionDb({ activeBot: false });
    state.provisioningRequest = {
      id: 'request-1',
      workspaceId: 'ws-1',
      requestedByUserId: 'user-1',
      creatorTelegramId: '999',
      suggestedName: 'Acme Launch Support',
      suggestedUsername: 'acme_launch_bot',
      managerBotUsername: 'Manager',
      creationUrl: 'https://t.me/newbot/Manager/acme_launch_bot?name=Acme',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date('2026-05-05T00:00:00Z'),
      updatedAt: new Date('2026-05-05T00:00:00Z'),
    };
    const helmClient = {
      evaluate: vi.fn(async (input: { action: string }) => ({
        receipt: {
          decisionId: input.action === TELEGRAM_MANAGED_ACTIONS.CLAIM ? 'dec-claim' : 'dec-webhook',
          verdict: 'ALLOW',
          reason: 'allowed',
          policyVersion: 'founder-ops-v1',
        },
      })),
    };
    const secrets = {
      set: vi.fn(async () => true),
    };
    const service = new ManagedTelegramBotService({
      db,
      helmClient: helmClient as never,
      managerBotToken: 'manager-token',
      appUrl: 'https://pilot.example.com/',
    });
    Object.defineProperty(service as unknown as { secrets?: unknown }, 'secrets', {
      value: secrets,
    });
    const fetch = vi.fn(async (url: URL | RequestInfo) => {
      const target = String(url);
      if (target.includes('/getManagedBotToken')) {
        return Response.json({ ok: true, result: 'child-token' });
      }
      return Response.json({ ok: true, result: true });
    });
    vi.stubGlobal('fetch', fetch);

    const bot = await service.claimManagedBot({
      creatorTelegramId: '999',
      bot: { id: 123, username: 'pilot_launch_bot', firstName: 'Pilot Launch Bot' },
    });

    expect(bot.status).toBe('active');
    expect(secrets.set).toHaveBeenCalledWith(
      'ws-1',
      expect.stringMatching(/^custom_telegram_managed_bot_token_/),
      'child-token',
    );
    expect(state.bot['governanceMetadata']).toMatchObject({
      claim: expect.objectContaining({ policyDecisionId: 'dec-claim' }),
      claimEvidence: {
        auditEventId: expect.any(String),
        evidenceItemId: 'evidence-send-item',
      },
      setWebhook: expect.objectContaining({
        policyDecisionId: 'dec-webhook',
        evidence: {
          auditEventId: expect.any(String),
          evidenceItemId: 'evidence-send-item',
        },
      }),
    });

    const claimEvidence = inserts.find(
      (insert) =>
        insert.table === evidenceItems &&
        (insert.value as { evidenceType?: string }).evidenceType ===
          'managed_telegram_claim_requested',
    )?.value as { metadata: Record<string, unknown> };
    expect(claimEvidence).toMatchObject({
      workspaceId: 'ws-1',
      evidenceType: 'managed_telegram_claim_requested',
      sourceType: 'managed_telegram_control',
      sensitivity: 'restricted',
      metadata: expect.objectContaining({
        requestId: 'request-1',
        policyDecisionId: 'dec-claim',
        rawTelegramBotIdStoredInEvidence: false,
        rawTelegramBotUsernameStoredInEvidence: false,
        rawTokenSecretRefStoredInEvidence: false,
      }),
    });
    const webhookEvidence = inserts.find(
      (insert) =>
        insert.table === evidenceItems &&
        (insert.value as { evidenceType?: string }).evidenceType ===
          'managed_telegram_webhook_config_requested',
    )?.value as { metadata: Record<string, unknown> };
    expect(webhookEvidence).toMatchObject({
      workspaceId: 'ws-1',
      evidenceType: 'managed_telegram_webhook_config_requested',
      sourceType: 'managed_telegram_control',
      sensitivity: 'restricted',
      metadata: expect.objectContaining({
        policyDecisionId: 'dec-webhook',
        rawTelegramBotIdStoredInEvidence: false,
        rawTokenSecretRefStoredInEvidence: false,
        rawWebhookUrlStoredInEvidence: false,
        rawWebhookSecretStoredInEvidence: false,
      }),
    });
    expect(JSON.stringify(claimEvidence.metadata)).not.toContain('123');
    expect(JSON.stringify(claimEvidence.metadata)).not.toContain('pilot_launch_bot');
    expect(JSON.stringify(webhookEvidence.metadata)).not.toContain('123');
    expect(JSON.stringify(webhookEvidence.metadata)).not.toContain('pilot.example.com');

    const claimEvidenceIndex = operations.findIndex(
      (operation) =>
        operation.kind === 'insert' &&
        operation.table === evidenceItems &&
        (operation.value as { evidenceType?: string }).evidenceType ===
          'managed_telegram_claim_requested',
    );
    const botInsertIndex = operations.findIndex(
      (operation) => operation.kind === 'insert' && operation.table === managedTelegramBots,
    );
    const webhookEvidenceIndex = operations.findIndex(
      (operation) =>
        operation.kind === 'insert' &&
        operation.table === evidenceItems &&
        (operation.value as { evidenceType?: string }).evidenceType ===
          'managed_telegram_webhook_config_requested',
    );
    const activeIndex = operations.findIndex(
      (operation) =>
        operation.kind === 'update' &&
        operation.table === managedTelegramBots &&
        (operation.value as { status?: string }).status === 'active',
    );
    expect(claimEvidenceIndex).toBeGreaterThanOrEqual(0);
    expect(botInsertIndex).toBeGreaterThan(claimEvidenceIndex);
    expect(webhookEvidenceIndex).toBeGreaterThan(botInsertIndex);
    expect(activeIndex).toBeGreaterThan(webhookEvidenceIndex);
  });

  it('fails closed before claiming managed Telegram bots when claim evidence fails', async () => {
    const { db, state, inserts } = makeManagedTelegramActionDb({
      activeBot: false,
      failEvidenceType: 'managed_telegram_claim_requested',
    });
    state.provisioningRequest = {
      id: 'request-1',
      workspaceId: 'ws-1',
      requestedByUserId: 'user-1',
      creatorTelegramId: '999',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
    };
    const service = new ManagedTelegramBotService({
      db,
      helmClient: {
        evaluate: vi.fn(async () => ({
          receipt: {
            decisionId: 'dec-claim',
            verdict: 'ALLOW',
            reason: 'allowed',
            policyVersion: 'founder-ops-v1',
          },
        })),
      } as never,
      managerBotToken: 'manager-token',
      appUrl: 'https://pilot.example.com',
    });
    const secrets = {
      set: vi.fn(async () => true),
    };
    Object.defineProperty(service as unknown as { secrets?: unknown }, 'secrets', {
      value: secrets,
    });
    const fetch = vi.fn(async () => Response.json({ ok: true, result: 'child-token' }));
    vi.stubGlobal('fetch', fetch);

    await expect(
      service.claimManagedBot({
        creatorTelegramId: '999',
        bot: { id: 123, username: 'pilot_launch_bot' },
      }),
    ).rejects.toThrow('send evidence unavailable');

    expect(fetch).not.toHaveBeenCalled();
    expect(secrets.set).not.toHaveBeenCalled();
    expect(inserts.some((insert) => insert.table === managedTelegramBots)).toBe(false);
  });

  it('fails closed before external Telegram webhook setup when webhook evidence fails', async () => {
    const { db, state } = makeManagedTelegramActionDb({
      activeBot: false,
      failEvidenceType: 'managed_telegram_webhook_config_requested',
    });
    state.provisioningRequest = {
      id: 'request-1',
      workspaceId: 'ws-1',
      requestedByUserId: 'user-1',
      creatorTelegramId: '999',
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
    };
    const service = new ManagedTelegramBotService({
      db,
      helmClient: {
        evaluate: vi.fn(async (input: { action: string }) => ({
          receipt: {
            decisionId:
              input.action === TELEGRAM_MANAGED_ACTIONS.CLAIM ? 'dec-claim' : 'dec-webhook',
            verdict: 'ALLOW',
            reason: 'allowed',
            policyVersion: 'founder-ops-v1',
          },
        })),
      } as never,
      managerBotToken: 'manager-token',
      appUrl: 'https://pilot.example.com',
    });
    const secrets = {
      set: vi.fn(async () => true),
    };
    Object.defineProperty(service as unknown as { secrets?: unknown }, 'secrets', {
      value: secrets,
    });
    const fetch = vi.fn(async (url: URL | RequestInfo) => {
      const target = String(url);
      if (target.includes('/getManagedBotToken')) {
        return Response.json({ ok: true, result: 'child-token' });
      }
      return Response.json({ ok: true, result: true });
    });
    vi.stubGlobal('fetch', fetch);

    await expect(
      service.claimManagedBot({
        creatorTelegramId: '999',
        bot: { id: 123, username: 'pilot_launch_bot' },
      }),
    ).rejects.toThrow('send evidence unavailable');

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/getManagedBotToken');
    expect(fetch.mock.calls.some((call) => String(call[0]).includes('/setWebhook'))).toBe(false);
    expect(fetch.mock.calls.some((call) => String(call[0]).includes('/setMyCommands'))).toBe(false);
    expect(state.bot['status']).toBe('error');
  });

  it('persists audit-linked evidence before managed Telegram settings updates', async () => {
    const { db, state, inserts, operations } = makeManagedTelegramActionDb();
    const service = new ManagedTelegramBotService({ db });

    await service.updateSettings('ws-1', 'user-1', {
      responseMode: 'approval_required',
      welcomeCopy: 'Welcome to the private launch.',
      launchUrl: 'https://launch.example.com/private',
      supportPrompt: 'Ask the launch team for help.',
    });

    expect(state.bot['welcomeCopy']).toBe('Welcome to the private launch.');
    expect(state.bot['launchUrl']).toBe('https://launch.example.com/private');
    const evidenceInsert = inserts.find(
      (insert) =>
        insert.table === evidenceItems &&
        (insert.value as { evidenceType?: string }).evidenceType ===
          'managed_telegram_settings_update_requested',
    )?.value as { metadata: Record<string, unknown> };
    expect(evidenceInsert).toMatchObject({
      workspaceId: 'ws-1',
      evidenceType: 'managed_telegram_settings_update_requested',
      sourceType: 'managed_telegram_control',
      redactionState: 'redacted',
      metadata: expect.objectContaining({
        managedBotId: 'bot-1',
        rawSettingsValuesStoredInEvidence: false,
        changedFields: ['launchUrl', 'responseMode', 'supportPrompt', 'welcomeCopy'],
      }),
    });
    expect(JSON.stringify(evidenceInsert.metadata)).not.toContain('Welcome to the private launch.');
    expect(JSON.stringify(evidenceInsert.metadata)).not.toContain('launch.example.com');
    expect(JSON.stringify(evidenceInsert.metadata)).not.toContain('Ask the launch team');

    const evidenceIndex = operations.findIndex(
      (operation) =>
        operation.kind === 'insert' &&
        operation.table === evidenceItems &&
        (operation.value as { evidenceType?: string }).evidenceType ===
          'managed_telegram_settings_update_requested',
    );
    const updateIndex = operations.findIndex(
      (operation) =>
        operation.kind === 'update' &&
        operation.table === managedTelegramBots &&
        (operation.value as { welcomeCopy?: string }).welcomeCopy ===
          'Welcome to the private launch.',
    );
    expect(evidenceIndex).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeGreaterThan(evidenceIndex);
  });

  it('fails closed before settings update when control evidence fails', async () => {
    const { db, state, updates } = makeManagedTelegramActionDb({ failEvidenceInsert: true });
    const service = new ManagedTelegramBotService({ db });

    await expect(
      service.updateSettings('ws-1', 'user-1', {
        welcomeCopy: 'This should not persist.',
      }),
    ).rejects.toThrow('send evidence unavailable');

    expect(state.bot['welcomeCopy']).toBe('Welcome.');
    expect(
      updates.some(
        (update) =>
          update.table === managedTelegramBots &&
          (update.value as { welcomeCopy?: string }).welcomeCopy === 'This should not persist.',
      ),
    ).toBe(false);
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

  it('persists HELM policy pins and evidence before disabling managed Telegram bots', async () => {
    const { db, state, inserts, operations } = makeManagedTelegramActionDb();
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
      disableEvidence: {
        auditEventId: expect.any(String),
        evidenceItemId: 'evidence-send-item',
      },
    });
    const evidenceInsert = inserts.find(
      (insert) =>
        insert.table === evidenceItems &&
        (insert.value as { evidenceType?: string }).evidenceType ===
          'managed_telegram_disable_requested',
    )?.value as { metadata: Record<string, unknown> };
    expect(evidenceInsert).toMatchObject({
      workspaceId: 'ws-1',
      evidenceType: 'managed_telegram_disable_requested',
      sourceType: 'managed_telegram_control',
      sensitivity: 'restricted',
      metadata: expect.objectContaining({
        managedBotId: 'bot-1',
        policyDecisionId: 'dec-disable',
        rawTelegramBotIdStoredInEvidence: false,
        rawTokenSecretRefStoredInEvidence: false,
      }),
    });
    expect(JSON.stringify(evidenceInsert.metadata)).not.toContain('123');
    expect(JSON.stringify(evidenceInsert.metadata)).not.toContain(
      'custom_telegram_managed_bot_token_bot-1',
    );
    const evidenceIndex = operations.findIndex(
      (operation) =>
        operation.kind === 'insert' &&
        operation.table === evidenceItems &&
        (operation.value as { evidenceType?: string }).evidenceType ===
          'managed_telegram_disable_requested',
    );
    const disableIndex = operations.findIndex(
      (operation) =>
        operation.kind === 'update' &&
        operation.table === managedTelegramBots &&
        (operation.value as { status?: string }).status === 'disabled',
    );
    expect(evidenceIndex).toBeGreaterThanOrEqual(0);
    expect(disableIndex).toBeGreaterThan(evidenceIndex);
  });

  it('fails closed before disabling when disable evidence cannot be persisted', async () => {
    const { db, state, updates } = makeManagedTelegramActionDb({ failEvidenceInsert: true });
    const helmClient = {
      evaluate: vi.fn(async () => ({
        receipt: {
          decisionId: 'dec-disable',
          verdict: 'ALLOW',
          reason: 'allowed',
          policyVersion: 'founder-ops-v1',
        },
      })),
    };
    const secrets = {
      get: vi.fn(async () => 'child-token'),
      delete: vi.fn(async () => true),
    };
    const service = new ManagedTelegramBotService({
      db,
      helmClient: helmClient as never,
    });
    Object.defineProperty(service as unknown as { secrets?: unknown }, 'secrets', {
      value: secrets,
    });
    const fetch = vi.fn(async () => Response.json({ ok: true, result: true }));
    vi.stubGlobal('fetch', fetch);

    await expect(service.disable('ws-1', 'user-1')).rejects.toThrow('send evidence unavailable');

    expect(fetch).not.toHaveBeenCalled();
    expect(secrets.get).not.toHaveBeenCalled();
    expect(secrets.delete).not.toHaveBeenCalled();
    expect(state.bot['status']).toBe('active');
    expect(
      updates.some(
        (update) =>
          update.table === managedTelegramBots &&
          (update.value as { status?: string }).status === 'disabled',
      ),
    ).toBe(false);
  });

  it('fails closed before rotating managed Telegram tokens when rotation evidence fails', async () => {
    const { db, state } = makeManagedTelegramActionDb({ failEvidenceInsert: true });
    const helmClient = {
      evaluate: vi.fn(async () => ({
        receipt: {
          decisionId: 'dec-rotate',
          verdict: 'ALLOW',
          reason: 'allowed',
          policyVersion: 'founder-ops-v1',
        },
      })),
    };
    const secrets = {
      set: vi.fn(async () => true),
    };
    const service = new ManagedTelegramBotService({
      db,
      helmClient: helmClient as never,
      managerBotToken: 'manager-token',
    });
    Object.defineProperty(service as unknown as { secrets?: unknown }, 'secrets', {
      value: secrets,
    });
    const fetch = vi.fn(async () => Response.json({ ok: true, result: 'new-child-token' }));
    vi.stubGlobal('fetch', fetch);

    await expect(service.rotateToken('ws-1', 'user-1')).rejects.toThrow(
      'send evidence unavailable',
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(secrets.set).not.toHaveBeenCalled();
    expect(state.bot['webhookSecretHash']).toBe('hash');
  });
});
