import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HELM_ADMIN_ENDPOINT_ACTION_CATALOG,
  HelmClient,
  HelmDeniedError,
  HelmEscalationError,
  HelmUnreachableError,
  parseReceiptHeaders,
  normalizeVerdict,
} from '../index.js';

function makeResponse(opts: {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}): Response {
  return new Response(JSON.stringify(opts.body ?? {}), {
    status: opts.status,
    headers: opts.headers,
  });
}

function goodReceiptHeaders(
  verdict = 'ALLOW',
  extras: Record<string, string> = {},
): Record<string, string> {
  return {
    'x-helm-decision-id': 'dec-123',
    'x-helm-verdict': verdict,
    'x-helm-policy-version': 'founder-ops-v1',
    'x-helm-decision-hash': 'sha256:abc',
    'content-type': 'application/json',
    ...extras,
  };
}

function sampleChatBody() {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'gpt-4',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' } }],
  };
}

describe('HelmClient.chatCompletion', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
  });

  it('returns body + receipt on ALLOW', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({ status: 200, body: sampleChatBody(), headers: goodReceiptHeaders('ALLOW') }),
    );
    const client = new HelmClient({ baseUrl: 'http://helm:8080', fetchImpl: fetchMock });
    const { body, receipt } = await client.chatCompletion('workspace:w1/op:eng', {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(body.id).toBe('chatcmpl-1');
    expect(receipt.verdict).toBe('ALLOW');
    expect(receipt.decisionId).toBe('dec-123');
    expect(receipt.action).toBe('LLM_INFERENCE');
    expect(receipt.resource).toBe('gpt-4');
    expect(receipt.principal).toBe('workspace:w1/op:eng');
  });

  it('throws HelmDeniedError on 403 DENY', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        status: 403,
        body: { reason: 'budget exceeded' },
        headers: goodReceiptHeaders('DENY'),
      }),
    );
    const client = new HelmClient({ baseUrl: 'http://helm:8080', fetchImpl: fetchMock });
    await expect(
      client.chatCompletion('p', { model: 'gpt-4', messages: [] }),
    ).rejects.toBeInstanceOf(HelmDeniedError);
  });

  it('throws HelmEscalationError on 403 ESCALATE', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        status: 403,
        body: { reason: 'human approval required' },
        headers: goodReceiptHeaders('ESCALATE'),
      }),
    );
    const client = new HelmClient({ baseUrl: 'http://helm:8080', fetchImpl: fetchMock });
    await expect(
      client.chatCompletion('p', { model: 'gpt-4', messages: [] }),
    ).rejects.toBeInstanceOf(HelmEscalationError);
  });

  it('invokes onReceipt callback on both ALLOW and DENY', async () => {
    const onReceipt = vi.fn();
    const client = new HelmClient({
      baseUrl: 'http://helm:8080',
      fetchImpl: fetchMock,
      onReceipt,
    });

    // ALLOW
    fetchMock.mockResolvedValueOnce(
      makeResponse({ status: 200, body: sampleChatBody(), headers: goodReceiptHeaders('ALLOW') }),
    );
    await client.chatCompletion('p', { model: 'gpt-4', messages: [] });

    // DENY
    fetchMock.mockResolvedValueOnce(
      makeResponse({ status: 403, body: { reason: 'nope' }, headers: goodReceiptHeaders('DENY') }),
    );
    await expect(
      client.chatCompletion('p', { model: 'gpt-4', messages: [] }),
    ).rejects.toBeInstanceOf(HelmDeniedError);

    expect(onReceipt).toHaveBeenCalledTimes(2);
    expect(onReceipt.mock.calls[0][0].verdict).toBe('ALLOW');
    expect(onReceipt.mock.calls[1][0].verdict).toBe('DENY');
  });

  it('requires a receipt sink before governed LLM inference when elevated receipts are required', async () => {
    const client = new HelmClient({
      baseUrl: 'http://helm:8080',
      fetchImpl: fetchMock,
      receiptPersistence: 'required_for_elevated',
    });

    await expect(client.chatCompletion('p', { model: 'gpt-4', messages: [] })).rejects.toThrow(
      'HELM receipt sink is required before evaluating LLM_INFERENCE:gpt-4',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when required LLM receipt persistence fails', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({ status: 200, body: sampleChatBody(), headers: goodReceiptHeaders('ALLOW') }),
    );
    const client = new HelmClient({
      baseUrl: 'http://helm:8080',
      fetchImpl: fetchMock,
      receiptPersistence: 'required_for_elevated',
      onReceipt: vi.fn(async () => {
        throw new Error('receipt db down');
      }),
    });

    await expect(client.chatCompletion('p', { model: 'gpt-4', messages: [] })).rejects.toThrow(
      'HELM receipt persistence failed for LLM_INFERENCE:gpt-4',
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('fails closed when 2xx response is missing governance headers (protocol violation)', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        status: 200,
        body: sampleChatBody(),
        headers: { 'content-type': 'application/json' }, // no x-helm-* headers
      }),
    );
    const client = new HelmClient({ baseUrl: 'http://helm:8080', fetchImpl: fetchMock });
    await expect(
      client.chatCompletion('p', { model: 'gpt-4', messages: [] }),
    ).rejects.toBeInstanceOf(HelmUnreachableError);
  });

  it('fails closed when 403 is missing governance headers', async () => {
    fetchMock.mockResolvedValue(makeResponse({ status: 403, body: { reason: 'rogue deny' } }));
    const client = new HelmClient({ baseUrl: 'http://helm:8080', fetchImpl: fetchMock });
    await expect(
      client.chatCompletion('p', { model: 'gpt-4', messages: [] }),
    ).rejects.toBeInstanceOf(HelmUnreachableError);
  });

  it('retries on 5xx and succeeds on later attempt', async () => {
    fetchMock
      .mockResolvedValueOnce(makeResponse({ status: 502 }))
      .mockResolvedValueOnce(makeResponse({ status: 503 }))
      .mockResolvedValueOnce(
        makeResponse({ status: 200, body: sampleChatBody(), headers: goodReceiptHeaders('ALLOW') }),
      );
    const client = new HelmClient({
      baseUrl: 'http://helm:8080',
      fetchImpl: fetchMock,
      maxRetries: 3,
      baseBackoffMs: 1,
    });
    const result = await client.chatCompletion('p', { model: 'gpt-4', messages: [] });
    expect(result.receipt.verdict).toBe('ALLOW');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('fails closed when all retries exhaust on 5xx', async () => {
    fetchMock.mockResolvedValue(makeResponse({ status: 500 }));
    const client = new HelmClient({
      baseUrl: 'http://helm:8080',
      fetchImpl: fetchMock,
      maxRetries: 2,
      baseBackoffMs: 1,
    });
    await expect(
      client.chatCompletion('p', { model: 'gpt-4', messages: [] }),
    ).rejects.toBeInstanceOf(HelmUnreachableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on 403 (definitive verdict)', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({
        status: 403,
        body: { reason: 'blocked' },
        headers: goodReceiptHeaders('DENY'),
      }),
    );
    const client = new HelmClient({
      baseUrl: 'http://helm:8080',
      fetchImpl: fetchMock,
      maxRetries: 5,
      baseBackoffMs: 1,
    });
    await expect(
      client.chatCompletion('p', { model: 'gpt-4', messages: [] }),
    ).rejects.toBeInstanceOf(HelmDeniedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends X-Helm-Principal header and uses defaultPrincipal fallback', async () => {
    fetchMock.mockResolvedValue(
      makeResponse({ status: 200, body: sampleChatBody(), headers: goodReceiptHeaders('ALLOW') }),
    );
    const client = new HelmClient({
      baseUrl: 'http://helm:8080',
      fetchImpl: fetchMock,
      defaultPrincipal: 'default-principal',
    });
    await client.chatCompletion(undefined, { model: 'gpt-4', messages: [] });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Helm-Principal']).toBe('default-principal');
  });

  it('network error propagates as HelmUnreachableError after retries', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const client = new HelmClient({
      baseUrl: 'http://helm:8080',
      fetchImpl: fetchMock,
      maxRetries: 2,
      baseBackoffMs: 1,
    });
    await expect(
      client.chatCompletion('p', { model: 'gpt-4', messages: [] }),
    ).rejects.toBeInstanceOf(HelmUnreachableError);
  });
});

describe('HelmClient.health', () => {
  it('returns ok + latency on 200', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(makeResponse({ status: 200, body: { status: 'ok', version: '0.3.0' } }));
    const client = new HelmClient({
      baseUrl: 'http://helm:8080',
      healthUrl: 'http://helm:8081',
      fetchImpl: fetchMock,
    });
    const snap = await client.health();
    expect(snap.gatewayOk).toBe(true);
    expect(snap.version).toBe('0.3.0');
    expect(snap.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('returns not-ok on HTTP error without throwing', async () => {
    const fetchMock = vi.fn().mockResolvedValue(makeResponse({ status: 500 }));
    const client = new HelmClient({ baseUrl: 'http://helm:8080', fetchImpl: fetchMock });
    const snap = await client.health();
    expect(snap.gatewayOk).toBe(false);
    expect(snap.error).toBe('HTTP 500');
  });

  it('returns not-ok on network failure without throwing', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    const client = new HelmClient({ baseUrl: 'http://helm:8080', fetchImpl: fetchMock });
    const snap = await client.health();
    expect(snap.gatewayOk).toBe(false);
    expect(snap.error).toBe('connect ECONNREFUSED');
  });
});

describe('HelmClient.evaluate', () => {
  const originalNodeEnv = process.env['NODE_ENV'];

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env['NODE_ENV'];
    } else {
      process.env['NODE_ENV'] = originalNodeEnv;
    }
  });

  it('posts to canonical helm-ai-kernel evaluate and returns a synthesized receipt', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: {
          allow: true,
          verdict: 'ALLOW',
          receipt_id: 'rcpt-1',
          decision_id: 'dec-1',
          decision_hash: 'sha256:abc',
          policy_ref: 'founder-ops-v1',
          reason_code: 'ALLOW',
        },
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new HelmClient({ baseUrl: 'http://helm:8080', fetchImpl: fetchMock });
    const result = await client.evaluate({
      principal: 'workspace:ws-1/operator:agent',
      action: 'TOOL_USE',
      resource: 'scrapling_fetch',
      args: { url: 'https://example.com' },
      effectLevel: 'E2',
      sessionId: 'task-1',
    });

    expect(result.receipt.decisionId).toBe('dec-1');
    expect(result.receipt.receiptId).toBe('rcpt-1');
    expect(result.receipt.verdict).toBe('ALLOW');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://helm:8080/api/v1/evaluate',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws HelmDeniedError when helm-ai-kernel returns allow=false', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: {
          allow: false,
          receipt_id: 'rcpt-2',
          decision_id: 'dec-2',
          decision_hash: 'sha256:def',
          policy_ref: 'founder-ops-v1',
          reason_code: 'TOOL_BLOCKED',
        },
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new HelmClient({ baseUrl: 'http://helm:8080', fetchImpl: fetchMock });
    await expect(
      client.evaluate({ principal: 'p', action: 'TOOL_USE', resource: 'github.commit' }),
    ).rejects.toBeInstanceOf(HelmDeniedError);
  });

  it('fails closed before elevated production evaluate when no receipt sink exists', async () => {
    process.env['NODE_ENV'] = 'production';
    const fetchMock = vi.fn();
    const client = new HelmClient({ baseUrl: 'http://helm:8080', fetchImpl: fetchMock });

    await expect(
      client.evaluate({
        principal: 'workspace:ws-1/operator:agent',
        action: 'TOOL_USE',
        resource: 'github.commit',
        effectLevel: 'E2',
      }),
    ).rejects.toBeInstanceOf(HelmUnreachableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when elevated receipt persistence fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: {
          allow: true,
          verdict: 'ALLOW',
          receipt_id: 'rcpt-3',
          decision_id: 'dec-3',
          decision_hash: 'sha256:ghi',
          policy_ref: 'founder-ops-v1',
        },
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new HelmClient({
      baseUrl: 'http://helm:8080',
      fetchImpl: fetchMock,
      receiptPersistence: 'required_for_elevated',
      onReceipt: vi.fn(async () => {
        throw new Error('db unavailable');
      }),
    });

    await expect(
      client.evaluate({
        principal: 'workspace:ws-1/operator:agent',
        action: 'TOOL_USE',
        resource: 'github.commit',
        effectLevel: 'E2',
      }),
    ).rejects.toBeInstanceOf(HelmUnreachableError);
  });

  it('allows low-risk evaluate without a receipt sink outside production', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: {
          allow: true,
          verdict: 'ALLOW',
          receipt_id: 'rcpt-low',
          decision_id: 'dec-low',
          decision_hash: 'sha256:low',
          policy_ref: 'founder-ops-v1',
        },
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new HelmClient({ baseUrl: 'http://helm:8080', fetchImpl: fetchMock });

    const result = await client.evaluate({
      principal: 'workspace:ws-1/operator:agent',
      action: 'TOOL_USE',
      resource: 'read_status',
      effectLevel: 'E1',
    });

    expect(result.receipt.decisionId).toBe('dec-low');
  });
});

describe('HelmClient.evaluateOperatorComputerUse', () => {
  it('fails closed before computer-use helper fetch when elevated receipts have no sink', async () => {
    const fetchMock = vi.fn();
    const client = new HelmClient({
      baseUrl: 'http://helm:8080',
      fetchImpl: fetchMock,
      receiptPersistence: 'required_for_elevated',
    });

    await expect(
      client.evaluateOperatorComputerUse({
        principal: 'workspace:ws-1/operator:agent',
        workspaceId: 'ws-1',
        taskId: 'task-1',
        objective: 'Check project status',
        environment: 'local',
        operation: 'terminal_command',
        command: 'git',
        args: ['status', '--short'],
      }),
    ).rejects.toBeInstanceOf(HelmUnreachableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes Operator computer-use requests through HELM evaluate', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: {
          allow: true,
          verdict: 'ALLOW',
          receipt_id: 'rcpt-operator',
          decision_id: 'dec-operator',
          decision_hash: 'sha256:operator',
          policy_ref: 'founder-ops-v1',
          evidence_pack_id: 'pack-operator',
        },
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new HelmClient({ baseUrl: 'http://helm:8080', fetchImpl: fetchMock });

    const result = await client.evaluateOperatorComputerUse({
      principal: 'workspace:ws-1/operator:agent',
      workspaceId: 'ws-1',
      taskId: 'task-1',
      objective: 'Check project status',
      environment: 'local',
      operation: 'terminal_command',
      command: 'git',
      args: ['status', '--short'],
      cwd: '.',
      maxSteps: 8,
      approvalCheckpoint: 'before file writes',
    });

    expect(result.status).toBe('approved_for_execution');
    expect(result.receipt.decisionId).toBe('dec-operator');
    expect(result.evidencePackId).toBe('pack-operator');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.tool).toBe('OPERATOR_COMPUTER_USE');
    expect(body.effect_level).toBe('E3');
    expect(body.args.operation).toBe('terminal_command');
    expect(body.args.command).toBe('git');
    expect(body.context.source).toBe('@pilot/helm-client.evaluateOperatorComputerUse');
  });
});

describe('HelmClient.evaluateOperatorBrowserRead', () => {
  it('fails closed when elevated browser-read receipt persistence fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: {
          allow: true,
          verdict: 'ALLOW',
          receipt_id: 'rcpt-browser-fail',
          decision_id: 'dec-browser-fail',
          decision_hash: 'sha256:browser-fail',
          policy_ref: 'founder-ops-v1',
          evidence_pack_id: 'pack-browser-fail',
        },
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new HelmClient({
      baseUrl: 'http://helm:8080',
      fetchImpl: fetchMock,
      receiptPersistence: 'required_for_elevated',
      onReceipt: vi.fn(async () => {
        throw new Error('receipt sink unavailable');
      }),
    });

    await expect(
      client.evaluateOperatorBrowserRead({
        principal: 'workspace:ws-1/browser:session-1',
        workspaceId: 'ws-1',
        sessionId: 'session-1',
        grantId: 'grant-1',
        objective: 'Read YC profile',
        url: 'https://www.ycombinator.com/account',
        taskId: 'task-1',
      }),
    ).rejects.toBeInstanceOf(HelmUnreachableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('routes read-only browser observations through HELM evaluate', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: {
          allow: true,
          verdict: 'ALLOW',
          receipt_id: 'rcpt-browser',
          decision_id: 'dec-browser',
          decision_hash: 'sha256:browser',
          policy_ref: 'founder-ops-v1',
          evidence_pack_id: 'pack-browser',
        },
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new HelmClient({ baseUrl: 'http://helm:8080', fetchImpl: fetchMock });

    const result = await client.evaluateOperatorBrowserRead({
      principal: 'workspace:ws-1/browser:session-1',
      workspaceId: 'ws-1',
      sessionId: 'session-1',
      grantId: 'grant-1',
      objective: 'Read YC profile',
      url: 'https://www.ycombinator.com/account',
      taskId: 'task-1',
    });

    expect(result.status).toBe('approved_for_read');
    expect(result.receipt.decisionId).toBe('dec-browser');
    expect(result.evidencePackId).toBe('pack-browser');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.tool).toBe('OPERATOR_BROWSER_READ');
    expect(body.effect_level).toBe('E2');
    expect(body.args).toMatchObject({
      sessionId: 'session-1',
      grantId: 'grant-1',
      url: 'https://www.ycombinator.com/account',
    });
    expect(body.context.source).toBe('@pilot/helm-client.evaluateOperatorBrowserRead');
  });
});

describe('HelmClient HELM admin endpoint action catalog', () => {
  it('classifies read-only inspection endpoints separately from governed writes', () => {
    expect(HELM_ADMIN_ENDPOINT_ACTION_CATALOG.getBudgetStatus).toMatchObject({
      mode: 'read_only_inspection',
      effectLevel: 'E1',
      receiptRequired: false,
    });
    expect(HELM_ADMIN_ENDPOINT_ACTION_CATALOG.createObligation).toMatchObject({
      mode: 'governed_write',
      action: 'HELM_OBLIGATION_CREATE',
      effectLevel: 'E2',
      receiptRequired: true,
    });
    expect(HELM_ADMIN_ENDPOINT_ACTION_CATALOG.promoteMemory).toMatchObject({
      mode: 'governed_write',
      action: 'HELM_MEMORY_PROMOTE',
      effectLevel: 'E3',
      receiptRequired: true,
    });
  });

  it('allows classified read-only admin inspection without a receipt sink', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      makeResponse({
        status: 200,
        body: { enforcer: 'helm', status: 'active' },
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new HelmClient({
      baseUrl: 'http://helm:8080',
      fetchImpl: fetchMock,
      receiptPersistence: 'required_for_elevated',
    });

    const result = await client.getBudgetStatus();

    expect(result.status).toBe('active');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://helm:8080/api/v1/budget/status',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('governs obligation creation before mutating HELM-side state', async () => {
    const onReceipt = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          status: 200,
          body: {
            allow: true,
            verdict: 'ALLOW',
            receipt_id: 'rcpt-obligation-gate',
            decision_id: 'dec-obligation-gate',
            decision_hash: 'sha256:obligation-gate',
            policy_ref: 'founder-ops-v1',
            evidence_pack_id: 'pack-obligation-gate',
          },
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          status: 200,
          body: { obligationId: 'obl-1', registeredAt: '2026-05-05T00:00:00.000Z' },
          headers: { 'content-type': 'application/json' },
        }),
      );
    const client = new HelmClient({
      baseUrl: 'http://helm:8080',
      fetchImpl: fetchMock,
      receiptPersistence: 'required_for_elevated',
      onReceipt,
    });

    const result = await client.createObligation({
      workspaceId: 'ws-1',
      decisionId: 'dec-1',
      obligation: 'retain-access-log',
      retentionDays: 365,
    });

    expect(result.obligationId).toBe('obl-1');
    expect(result.governance).toMatchObject({
      policyDecisionId: 'dec-obligation-gate',
      policyVersion: 'founder-ops-v1',
      evidencePackId: 'pack-obligation-gate',
      helmDocumentVersionPins: {
        helmAdminPolicy: 'founder-ops-v1',
        HELM_OBLIGATION_CREATE: 'founder-ops-v1',
      },
      receipt: expect.objectContaining({
        decisionId: 'dec-obligation-gate',
        receiptId: 'rcpt-obligation-gate',
      }),
    });
    expect(onReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ decisionId: 'dec-obligation-gate' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [evaluateUrl, evaluateInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(evaluateUrl).toBe('http://helm:8080/api/v1/evaluate');
    const evaluateBody = JSON.parse(evaluateInit.body as string);
    expect(evaluateBody.tool).toBe('HELM_OBLIGATION_CREATE');
    expect(evaluateBody.effect_level).toBe('E2');
    expect(evaluateBody.context).toMatchObject({
      workspaceId: 'ws-1',
      endpoint: 'POST /api/v1/obligation/create',
      endpointMode: 'governed_write',
      source: '@pilot/helm-client.createObligation',
    });
    expect(fetchMock.mock.calls[1]![0]).toBe('http://helm:8080/api/v1/obligation/create');
  });

  it('returns governance metadata when promoting memory after HELM preflight', async () => {
    const onReceipt = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        makeResponse({
          status: 200,
          body: {
            allow: true,
            verdict: 'ALLOW',
            receipt_id: 'rcpt-promote-gate',
            decision_id: 'dec-promote-gate',
            decision_hash: 'sha256:promote-gate',
            policy_ref: 'founder-ops-v2',
            evidence_pack_id: 'pack-promote-gate',
          },
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          status: 200,
          body: { sharedMemoryId: 'shared-1', promotedAt: '2026-05-05T00:00:00.000Z' },
          headers: { 'content-type': 'application/json' },
        }),
      );
    const client = new HelmClient({
      baseUrl: 'http://helm:8080',
      fetchImpl: fetchMock,
      receiptPersistence: 'required_for_elevated',
      onReceipt,
    });

    const result = await client.promoteMemory('ws-1', 'page-1');

    expect(result.sharedMemoryId).toBe('shared-1');
    expect(result.governance).toMatchObject({
      policyDecisionId: 'dec-promote-gate',
      policyVersion: 'founder-ops-v2',
      evidencePackId: 'pack-promote-gate',
      helmDocumentVersionPins: {
        helmAdminPolicy: 'founder-ops-v2',
        HELM_MEMORY_PROMOTE: 'founder-ops-v2',
      },
      receipt: expect.objectContaining({
        decisionId: 'dec-promote-gate',
        receiptId: 'rcpt-promote-gate',
      }),
    });
    expect(onReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ decisionId: 'dec-promote-gate' }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [evaluateUrl, evaluateInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(evaluateUrl).toBe('http://helm:8080/api/v1/evaluate');
    const evaluateBody = JSON.parse(evaluateInit.body as string);
    expect(evaluateBody.tool).toBe('HELM_MEMORY_PROMOTE');
    expect(evaluateBody.effect_level).toBe('E3');
    expect(evaluateBody.context).toMatchObject({
      workspaceId: 'ws-1',
      pageId: 'page-1',
      endpoint: 'POST /api/v1/memory/promote',
      endpointMode: 'governed_write',
      source: '@pilot/helm-client.promoteMemory',
    });
    expect(fetchMock.mock.calls[1]![0]).toBe('http://helm:8080/api/v1/memory/promote');
  });

  it('fails closed before memory promotion when elevated receipts have no sink', async () => {
    const fetchMock = vi.fn();
    const client = new HelmClient({
      baseUrl: 'http://helm:8080',
      fetchImpl: fetchMock,
      receiptPersistence: 'required_for_elevated',
    });

    await expect(client.promoteMemory('ws-1', 'page-1')).rejects.toBeInstanceOf(
      HelmUnreachableError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('parseReceiptHeaders', () => {
  it('parses a full set of headers', () => {
    const headers = new Headers({
      'x-helm-decision-id': 'd1',
      'x-helm-verdict': 'ALLOW',
      'x-helm-policy-version': 'v1',
      'x-helm-decision-hash': 'sha256:xx',
    });
    const r = parseReceiptHeaders(headers, {
      action: 'LLM_INFERENCE',
      resource: 'gpt-4',
      principal: 'p',
    });
    expect(r).not.toBeNull();
    expect(r!.verdict).toBe('ALLOW');
    expect(r!.decisionHash).toBe('sha256:xx');
  });

  it('returns null when required headers are missing', () => {
    const headers = new Headers({ 'x-helm-verdict': 'ALLOW' });
    expect(parseReceiptHeaders(headers, { action: 'x', resource: 'y', principal: 'z' })).toBeNull();
  });

  it('returns null on unknown verdict', () => {
    const headers = new Headers({
      'x-helm-decision-id': 'd1',
      'x-helm-verdict': 'MAYBE',
      'x-helm-policy-version': 'v1',
    });
    expect(parseReceiptHeaders(headers, { action: 'x', resource: 'y', principal: 'z' })).toBeNull();
  });
});

describe('normalizeVerdict', () => {
  it('accepts canonical forms', () => {
    expect(normalizeVerdict('ALLOW')).toBe('ALLOW');
    expect(normalizeVerdict('DENY')).toBe('DENY');
    expect(normalizeVerdict('ESCALATE')).toBe('ESCALATE');
  });
  it('normalizes casing', () => {
    expect(normalizeVerdict('allow')).toBe('ALLOW');
    expect(normalizeVerdict(' Deny ')).toBe('DENY');
  });
  it('returns null on nonsense', () => {
    expect(normalizeVerdict('MAYBE')).toBeNull();
    expect(normalizeVerdict('')).toBeNull();
  });
});
