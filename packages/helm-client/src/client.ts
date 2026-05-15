import { HelmDeniedError, HelmEscalationError, HelmUnreachableError } from './errors.js';
import { parseReceiptHeaders } from './receipts.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResult,
  EvaluateRequest,
  EvaluateResult,
  HealthSnapshot,
  HelmClientConfig,
  HelmReceipt,
  Soc2BundleResult,
  MerkleRootResult,
  BudgetStatusResult,
  ObligationRequest,
  ObligationResult,
  BoundaryCheckResult,
  MemoryListResult,
  MemoryPromoteResult,
  HelmAdminWriteGovernance,
  ContextBundleListResult,
  EconomicChargesResult,
  EconomicAllocationsResult,
  OperatorBrowserReadRequest,
  OperatorBrowserReadResult,
  OperatorComputerUseRequest,
  OperatorComputerUseResult,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_BACKOFF_MS = 100;

export const HELM_ADMIN_ENDPOINT_ACTION_CATALOG = {
  exportSoc2: {
    endpoint: 'GET /api/v1/evidence/soc2',
    mode: 'read_only_inspection',
    action: 'HELM_ADMIN_EXPORT_SOC2',
    effectLevel: 'E1',
    receiptRequired: false,
  },
  getMerkleRoot: {
    endpoint: 'GET /api/v1/merkle/root',
    mode: 'read_only_inspection',
    action: 'HELM_ADMIN_MERKLE_ROOT_READ',
    effectLevel: 'E1',
    receiptRequired: false,
  },
  getBudgetStatus: {
    endpoint: 'GET /api/v1/budget/status',
    mode: 'read_only_inspection',
    action: 'HELM_ADMIN_BUDGET_STATUS_READ',
    effectLevel: 'E1',
    receiptRequired: false,
  },
  createObligation: {
    endpoint: 'POST /api/v1/obligation/create',
    mode: 'governed_write',
    action: 'HELM_OBLIGATION_CREATE',
    effectLevel: 'E2',
    receiptRequired: true,
  },
  boundaryCheck: {
    endpoint: 'GET /api/v1/boundary/check',
    mode: 'read_only_inspection',
    action: 'HELM_ADMIN_BOUNDARY_CHECK_READ',
    effectLevel: 'E1',
    receiptRequired: false,
  },
  listMemory: {
    endpoint: 'GET /api/v1/memory/list',
    mode: 'read_only_inspection',
    action: 'HELM_ADMIN_MEMORY_LIST',
    effectLevel: 'E1',
    receiptRequired: false,
  },
  promoteMemory: {
    endpoint: 'POST /api/v1/memory/promote',
    mode: 'governed_write',
    action: 'HELM_MEMORY_PROMOTE',
    effectLevel: 'E3',
    receiptRequired: true,
  },
  getContextBundles: {
    endpoint: 'GET /api/v1/context/bundles',
    mode: 'read_only_inspection',
    action: 'HELM_ADMIN_CONTEXT_BUNDLES_READ',
    effectLevel: 'E1',
    receiptRequired: false,
  },
  getEconomicCharges: {
    endpoint: 'GET /api/v1/economic/charges',
    mode: 'read_only_inspection',
    action: 'HELM_ADMIN_ECONOMIC_CHARGES_READ',
    effectLevel: 'E1',
    receiptRequired: false,
  },
  getEconomicAllocations: {
    endpoint: 'GET /api/v1/economic/allocations',
    mode: 'read_only_inspection',
    action: 'HELM_ADMIN_ECONOMIC_ALLOCATIONS_READ',
    effectLevel: 'E1',
    receiptRequired: false,
  },
} as const;

/**
 * Thin TypeScript client for helm-ai-kernel v0.3.0+.
 *
 * Fail-closed discipline:
 *   - 2xx with governance headers + verdict=ALLOW → return the response + receipt
 *   - 403 with governance headers + verdict=DENY   → throw HelmDeniedError
 *   - 403 with governance headers + verdict=ESCALATE → throw HelmEscalationError
 *   - any other condition (network, 5xx, parse error, missing headers) → treat
 *     as HELM_UNREACHABLE which callers MUST interpret as DENY.
 *
 * Retries apply ONLY to transient unreachability (5xx, timeout, network). A
 * definitive governance verdict (403 with headers) is never retried.
 */
export class HelmClient {
  private readonly cfg: Required<
    Omit<
      HelmClientConfig,
      'healthUrl' | 'defaultPrincipal' | 'adminApiKey' | 'onReceipt' | 'fetchImpl'
    >
  > &
    Pick<
      HelmClientConfig,
      'healthUrl' | 'defaultPrincipal' | 'adminApiKey' | 'onReceipt' | 'fetchImpl'
    >;

  constructor(cfg: HelmClientConfig) {
    if (!cfg.baseUrl) throw new Error('HelmClient: baseUrl is required');
    this.cfg = {
      baseUrl: stripTrailingSlash(cfg.baseUrl),
      healthUrl: cfg.healthUrl ? stripTrailingSlash(cfg.healthUrl) : undefined,
      defaultPrincipal: cfg.defaultPrincipal,
      adminApiKey: cfg.adminApiKey,
      timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: cfg.maxRetries ?? DEFAULT_MAX_RETRIES,
      baseBackoffMs: cfg.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS,
      failClosed: cfg.failClosed ?? true,
      evaluateEnabled: cfg.evaluateEnabled ?? true,
      receiptPersistence:
        cfg.receiptPersistence ??
        (process.env['NODE_ENV'] === 'production' ? 'required_for_elevated' : 'best_effort'),
      onReceipt: cfg.onReceipt,
      fetchImpl: cfg.fetchImpl ?? globalThis.fetch,
    };
  }

  /**
   * Request a HELM-governed chat completion. Pilot's LLM provider should
   * funnel every inference call through here so Guardian can enforce policy
   * and attach signed receipts.
   */
  async chatCompletion(
    principal: string | undefined,
    body: ChatCompletionRequest,
  ): Promise<ChatCompletionResult> {
    const effectivePrincipal = principal ?? this.cfg.defaultPrincipal ?? 'anonymous';
    const url = `${this.cfg.baseUrl}/v1/chat/completions`;
    const receiptRequired = this.receiptRequiredFor('LLM_INFERENCE', body.model, undefined);
    this.assertReceiptSinkConfigured('LLM_INFERENCE', body.model, undefined);

    const response = await this.governedFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Helm-Principal': effectivePrincipal,
        ...(this.cfg.adminApiKey ? { Authorization: `Bearer ${this.cfg.adminApiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });

    const ctx = { action: 'LLM_INFERENCE', resource: body.model, principal: effectivePrincipal };
    const receipt = parseReceiptHeaders(response.headers, ctx);

    if (response.status === 403) {
      await this.handleForbidden(response, receipt, { receiptRequired });
      // handleForbidden always throws — this is unreachable
      throw new Error('unreachable');
    }

    if (!response.ok) {
      // 5xx or unexpected: caller treats as unreachable/fail-closed
      throw new HelmUnreachableError(
        `HELM returned HTTP ${response.status} for chatCompletion`,
        await safeReadText(response),
      );
    }

    if (!receipt) {
      // 200 with missing governance headers is a protocol violation — fail closed
      throw new HelmUnreachableError(
        'HELM response missing governance receipt headers on a 2xx chatCompletion',
      );
    }

    await this.emitReceipt(receipt, { required: receiptRequired });

    const parsed = (await response.json()) as ChatCompletionResult['body'];
    return { body: parsed, receipt };
  }

  /**
   * Check whether HELM is up. Not governed — safe to call from health probes
   * and circuit-breakers.
   */
  async health(): Promise<HealthSnapshot> {
    const started = Date.now();
    const target = this.cfg.healthUrl ?? this.cfg.baseUrl;
    try {
      const response = await this.rawFetch(`${target}/healthz`, { method: 'GET' });
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        return {
          gatewayOk: false,
          latencyMs,
          checkedAt: new Date(),
          error: `HTTP ${response.status}`,
        };
      }
      const text = await safeReadText(response);
      const version = extractVersionFromHealth(text) ?? undefined;
      return { gatewayOk: true, latencyMs, checkedAt: new Date(), version };
    } catch (err) {
      return {
        gatewayOk: false,
        latencyMs: Date.now() - started,
        checkedAt: new Date(),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Generic governance evaluation for tool, deploy, scraping, and external actions. */
  async evaluate(req: EvaluateRequest): Promise<EvaluateResult> {
    const principal = req.principal || this.cfg.defaultPrincipal || 'anonymous';
    const url = `${this.cfg.baseUrl}/api/v1/evaluate`;
    const context = req.context ?? {};
    const effectLevel = req.effectLevel ?? stringContextValue(context, 'effectLevel') ?? req.action;
    const receiptRequired = this.receiptRequiredFor(req.action, req.resource, effectLevel);
    this.assertReceiptSinkConfigured(req.action, req.resource, effectLevel);
    const response = await this.governedFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Helm-Principal': principal,
        ...(this.cfg.adminApiKey ? { Authorization: `Bearer ${this.cfg.adminApiKey}` } : {}),
      },
      body: JSON.stringify({
        tool: req.action,
        args: req.args ?? context,
        agent_id: principal,
        effect_level: effectLevel,
        session_id:
          req.sessionId ??
          stringContextValue(context, 'sessionId') ??
          `${principal}:${req.action}:${req.resource}`,
        context: {
          ...context,
          principal,
          action: req.action,
          resource: req.resource,
        },
      }),
    });

    const ctx = {
      action: req.action,
      resource: req.resource,
      principal,
    };
    const receipt = parseReceiptHeaders(response.headers, ctx);

    if (response.status === 403) {
      await this.handleForbidden(response, receipt, { receiptRequired });
      throw new Error('unreachable');
    }

    if (!response.ok) {
      throw new HelmUnreachableError(
        `HELM returned HTTP ${response.status} for evaluate`,
        await safeReadText(response),
      );
    }

    const body = (await response.json()) as HelmEvaluateBody;
    const effectiveReceipt = receipt ?? receiptFromEvaluateBody(body, ctx);
    if (!effectiveReceipt) {
      throw new HelmUnreachableError('HELM evaluate response missing receipt fields');
    }

    await this.emitReceipt(effectiveReceipt, { required: receiptRequired });

    const verdict = normalizeEvaluateVerdict(body);
    const reason = body.reason_code ?? body.reason ?? body.error ?? 'governance denied';
    if (verdict === 'DENY') throw new HelmDeniedError({ ...effectiveReceipt, reason }, reason);
    if (verdict === 'ESCALATE') {
      throw new HelmEscalationError({ ...effectiveReceipt, reason }, reason);
    }

    const evidencePackId =
      response.headers.get('x-helm-evidence-pack-id') ??
      stringField(body, 'evidence_pack_id') ??
      stringField(body, 'evidencePackId');
    return { receipt: effectiveReceipt, evidencePackId };
  }

  /**
   * Govern a computer-use/Operator request before any browser or desktop
   * action is executed. This adapter intentionally stops at the HELM verdict;
   * callers must wire the actual computer-use runtime separately and keep
   * every resulting action inside the same trust-boundary flow.
   */
  async evaluateOperatorComputerUse(
    req: OperatorComputerUseRequest,
  ): Promise<OperatorComputerUseResult> {
    const environment = req.environment ?? 'local';
    const maxSteps = req.maxSteps ?? 12;
    const result = await this.evaluate({
      principal: req.principal,
      action: 'OPERATOR_COMPUTER_USE',
      resource: req.targetUrl ?? req.path ?? req.command ?? `${environment}:${req.operation}`,
      effectLevel: 'E3',
      sessionId: req.taskId,
      args: {
        workspaceId: req.workspaceId,
        objective: req.objective,
        targetUrl: req.targetUrl,
        environment,
        operation: req.operation,
        maxSteps,
        approvalCheckpoint: req.approvalCheckpoint,
        evidencePackId: req.evidencePackId,
        command: req.command,
        args: req.args,
        cwd: req.cwd,
        path: req.path,
        contentHash: req.contentHash,
        expectedCurrentHash: req.expectedCurrentHash,
        maxBytes: req.maxBytes,
        timeoutMs: req.timeoutMs,
        devServerUrl: req.devServerUrl,
      },
      context: {
        workspaceId: req.workspaceId,
        taskId: req.taskId,
        operatorId: req.operatorId,
        operation: req.operation,
        environment,
        source: '@pilot/helm-client.evaluateOperatorComputerUse',
      },
    });
    return {
      status: 'approved_for_execution',
      receipt: result.receipt,
      evidencePackId: result.evidencePackId,
      request: {
        workspaceId: req.workspaceId,
        objective: req.objective,
        targetUrl: req.targetUrl,
        environment,
        operation: req.operation,
        maxSteps,
        taskId: req.taskId,
        operatorId: req.operatorId,
        approvalCheckpoint: req.approvalCheckpoint,
        command: req.command,
        args: req.args,
        cwd: req.cwd,
        path: req.path,
        contentHash: req.contentHash,
        expectedCurrentHash: req.expectedCurrentHash,
        maxBytes: req.maxBytes,
        timeoutMs: req.timeoutMs,
        devServerUrl: req.devServerUrl,
      },
    };
  }

  /**
   * Govern a read-only browser observation/extraction request. This covers
   * session-backed URL/title/DOM/screenshot/extracted-field reads only;
   * clicking, posting, payments, credential export, and destructive browser
   * operations must use a separate higher-risk policy path.
   */
  async evaluateOperatorBrowserRead(
    req: OperatorBrowserReadRequest,
  ): Promise<OperatorBrowserReadResult> {
    const result = await this.evaluate({
      principal: req.principal,
      action: 'OPERATOR_BROWSER_READ',
      resource: req.url,
      effectLevel: 'E2',
      sessionId: req.grantId,
      args: {
        workspaceId: req.workspaceId,
        sessionId: req.sessionId,
        grantId: req.grantId,
        objective: req.objective,
        url: req.url,
      },
      context: {
        workspaceId: req.workspaceId,
        taskId: req.taskId,
        operatorId: req.operatorId,
        browserSessionId: req.sessionId,
        browserGrantId: req.grantId,
        source: '@pilot/helm-client.evaluateOperatorBrowserRead',
      },
    });
    return {
      status: 'approved_for_read',
      receipt: result.receipt,
      evidencePackId: result.evidencePackId,
      request: {
        workspaceId: req.workspaceId,
        sessionId: req.sessionId,
        grantId: req.grantId,
        objective: req.objective,
        url: req.url,
        taskId: req.taskId,
        operatorId: req.operatorId,
      },
    };
  }

  // ─── Phase 14 Track F — helm-ai-kernel endpoint integration ───
  //
  // Thin wrappers around helm-ai-kernel HTTP endpoints. All use governedFetch
  // for retries + failClosed semantics + 403 handling. Read-only inspection
  // endpoints are explicitly classified in HELM_ADMIN_ENDPOINT_ACTION_CATALOG
  // as E1/no-receipt; write endpoints must pass evaluate() before POST.

  /** Export a SOC2 compliance bundle for a workspace. */
  async exportSoc2(workspaceId: string): Promise<Soc2BundleResult> {
    const url = `${this.cfg.baseUrl}/api/v1/evidence/soc2?workspaceId=${encodeURIComponent(workspaceId)}`;
    const response = await this.governedFetch(url, { method: 'GET', headers: this.adminHeaders() });
    return (await response.json()) as Soc2BundleResult;
  }

  /** Retrieve the current Merkle tree root of the proof-graph. */
  async getMerkleRoot(): Promise<MerkleRootResult> {
    const url = `${this.cfg.baseUrl}/api/v1/merkle/root`;
    const response = await this.governedFetch(url, { method: 'GET', headers: this.adminHeaders() });
    return (await response.json()) as MerkleRootResult;
  }

  /** Current spend, daily/monthly limits, alerts. */
  async getBudgetStatus(): Promise<BudgetStatusResult> {
    const url = `${this.cfg.baseUrl}/api/v1/budget/status`;
    const response = await this.governedFetch(url, { method: 'GET', headers: this.adminHeaders() });
    return (await response.json()) as BudgetStatusResult;
  }

  /** Register a post-decision obligation (e.g. retain PHI access log for 2190 days). */
  async createObligation(req: ObligationRequest): Promise<ObligationResult> {
    const classification = HELM_ADMIN_ENDPOINT_ACTION_CATALOG.createObligation;
    const governance = await this.evaluateAdminEndpointWrite({
      classification,
      workspaceId: req.workspaceId,
      resource: `${req.workspaceId}:${req.decisionId}:${req.obligation}`,
      args: req as unknown as Record<string, unknown>,
      source: '@pilot/helm-client.createObligation',
    });
    const url = `${this.cfg.baseUrl}/api/v1/obligation/create`;
    const response = await this.governedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.adminHeaders() },
      body: JSON.stringify(req),
    });
    const body = (await response.json()) as ObligationResult;
    return { ...body, governance: adminWriteGovernanceMetadata(classification, governance) };
  }

  /** Sandbox / boundary violation status check. */
  async boundaryCheck(): Promise<BoundaryCheckResult> {
    const url = `${this.cfg.baseUrl}/api/v1/boundary/check`;
    const response = await this.governedFetch(url, { method: 'GET', headers: this.adminHeaders() });
    return (await response.json()) as BoundaryCheckResult;
  }

  /** List shared memory entries accessible to a workspace. */
  async listMemory(workspaceId: string, cursor?: string): Promise<MemoryListResult> {
    const qs = new URLSearchParams({ workspaceId });
    if (cursor) qs.set('cursor', cursor);
    const url = `${this.cfg.baseUrl}/api/v1/memory/list?${qs.toString()}`;
    const response = await this.governedFetch(url, { method: 'GET', headers: this.adminHeaders() });
    return (await response.json()) as MemoryListResult;
  }

  /** Promote a workspace-scoped page into shared HELM memory. */
  async promoteMemory(workspaceId: string, pageId: string): Promise<MemoryPromoteResult> {
    const classification = HELM_ADMIN_ENDPOINT_ACTION_CATALOG.promoteMemory;
    const governance = await this.evaluateAdminEndpointWrite({
      classification,
      workspaceId,
      resource: `${workspaceId}:${pageId}`,
      args: { workspaceId, pageId },
      source: '@pilot/helm-client.promoteMemory',
    });
    const url = `${this.cfg.baseUrl}/api/v1/memory/promote`;
    const response = await this.governedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.adminHeaders() },
      body: JSON.stringify({ workspaceId, pageId }),
    });
    const body = (await response.json()) as MemoryPromoteResult;
    return { ...body, governance: adminWriteGovernanceMetadata(classification, governance) };
  }

  /** Reusable context snapshots available to the workspace. */
  async getContextBundles(workspaceId: string): Promise<ContextBundleListResult> {
    const url = `${this.cfg.baseUrl}/api/v1/context/bundles?workspaceId=${encodeURIComponent(workspaceId)}`;
    const response = await this.governedFetch(url, { method: 'GET', headers: this.adminHeaders() });
    return (await response.json()) as ContextBundleListResult;
  }

  /** Per-workspace USD charges in a time window. */
  async getEconomicCharges(
    workspaceId: string,
    from: string,
    to: string,
  ): Promise<EconomicChargesResult> {
    const qs = new URLSearchParams({ workspaceId, from, to });
    const url = `${this.cfg.baseUrl}/api/v1/economic/charges?${qs.toString()}`;
    const response = await this.governedFetch(url, { method: 'GET', headers: this.adminHeaders() });
    return (await response.json()) as EconomicChargesResult;
  }

  /** Per-workspace budget allocations + consumption. */
  async getEconomicAllocations(workspaceId: string): Promise<EconomicAllocationsResult> {
    const url = `${this.cfg.baseUrl}/api/v1/economic/allocations?workspaceId=${encodeURIComponent(workspaceId)}`;
    const response = await this.governedFetch(url, { method: 'GET', headers: this.adminHeaders() });
    return (await response.json()) as EconomicAllocationsResult;
  }

  private adminHeaders(): Record<string, string> {
    return this.cfg.adminApiKey ? { Authorization: `Bearer ${this.cfg.adminApiKey}` } : {};
  }

  // ─── internals ───

  private async evaluateAdminEndpointWrite(input: {
    classification:
      | typeof HELM_ADMIN_ENDPOINT_ACTION_CATALOG.createObligation
      | typeof HELM_ADMIN_ENDPOINT_ACTION_CATALOG.promoteMemory;
    workspaceId: string;
    resource: string;
    args: Record<string, unknown>;
    source: string;
  }): Promise<EvaluateResult> {
    const { classification } = input;
    return await this.evaluate({
      principal: this.cfg.defaultPrincipal ?? `workspace:${input.workspaceId}/helm-admin`,
      action: classification.action,
      resource: input.resource,
      effectLevel: classification.effectLevel,
      sessionId: `${classification.action}:${input.workspaceId}`,
      args: input.args,
      context: {
        ...input.args,
        workspaceId: input.workspaceId,
        endpoint: classification.endpoint,
        endpointMode: classification.mode,
        source: input.source,
      },
    });
  }

  private async governedFetch(url: string, init: RequestInit): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.cfg.maxRetries; attempt++) {
      try {
        const response = await this.rawFetch(url, init);
        // 403 is a definitive verdict, do not retry
        if (response.status === 403) return response;
        // 2xx succeeds, return
        if (response.ok) return response;
        // 5xx / unexpected — retry
        lastErr = new HelmUnreachableError(
          `HELM HTTP ${response.status}`,
          await safeReadText(response),
          attempt,
        );
      } catch (err) {
        lastErr =
          err instanceof HelmUnreachableError
            ? err
            : new HelmUnreachableError(
                err instanceof Error ? err.message : String(err),
                err,
                attempt,
              );
      }
      if (attempt < this.cfg.maxRetries) {
        await sleep(this.backoffFor(attempt));
      }
    }
    throw lastErr instanceof HelmUnreachableError
      ? lastErr
      : new HelmUnreachableError('HELM unreachable after retries', lastErr);
  }

  private async rawFetch(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      return await this.cfg.fetchImpl!(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private backoffFor(attempt: number): number {
    // Exponential backoff with ±25% jitter.
    const base = this.cfg.baseBackoffMs * Math.pow(4, attempt - 1);
    const jitter = base * 0.25;
    return Math.round(base + (Math.random() * 2 - 1) * jitter);
  }

  private async handleForbidden(
    response: Response,
    receipt: HelmReceipt | null,
    options: { receiptRequired?: boolean } = {},
  ): Promise<never> {
    const reason = await readReason(response);
    if (!receipt) {
      throw new HelmUnreachableError(
        'HELM returned 403 without governance receipt headers (protocol violation)',
      );
    }
    const enriched: HelmReceipt = { ...receipt, reason };
    await this.emitReceipt(enriched, { required: options.receiptRequired === true });
    if (enriched.verdict === 'ESCALATE') throw new HelmEscalationError(enriched, reason);
    throw new HelmDeniedError(enriched, reason);
  }

  private async emitReceipt(
    receipt: HelmReceipt,
    options: { required?: boolean } = {},
  ): Promise<void> {
    if (!this.cfg.onReceipt) {
      if (options.required) {
        throw new HelmUnreachableError(
          `HELM receipt sink is required for ${receipt.action}:${receipt.resource}`,
        );
      }
      return;
    }
    try {
      await this.cfg.onReceipt(receipt);
    } catch (err) {
      if (options.required) {
        throw new HelmUnreachableError(
          `HELM receipt persistence failed for ${receipt.action}:${receipt.resource}`,
          err,
        );
      }
      // Best-effort receipt persistence failure must not break the governed call.
    }
  }

  private assertReceiptSinkConfigured(
    action: string,
    resource: string,
    effectLevel?: string,
  ): void {
    if (this.receiptRequiredFor(action, resource, effectLevel) && !this.cfg.onReceipt) {
      throw new HelmUnreachableError(
        `HELM receipt sink is required before evaluating ${action}:${resource}`,
      );
    }
  }

  private receiptRequiredFor(action: string, resource: string, effectLevel?: string): boolean {
    if (this.cfg.receiptPersistence === 'required') return true;
    if (this.cfg.receiptPersistence === 'best_effort') return false;
    return isElevatedGovernedAction(action, resource, effectLevel);
  }
}

// ─── helpers ───

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

async function readReason(response: Response): Promise<string> {
  const text = await safeReadText(response);
  if (!text) return 'governance denied (no body)';
  try {
    const parsed = JSON.parse(text) as { message?: string; reason?: string; error?: string };
    return parsed.reason ?? parsed.message ?? parsed.error ?? text.slice(0, 500);
  } catch {
    return text.slice(0, 500);
  }
}

function extractVersionFromHealth(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface HelmEvaluateBody {
  allow?: boolean;
  verdict?: string;
  receipt_id?: string;
  receiptId?: string;
  decision_id?: string;
  decisionId?: string;
  decision_hash?: string;
  decisionHash?: string;
  reason_code?: string;
  reason?: string;
  error?: string;
  policy_ref?: string;
  policyRef?: string;
  policy_version?: string;
  policyVersion?: string;
  evidence_pack_id?: string;
  evidencePackId?: string;
  signature?: unknown;
  signed_blob?: unknown;
  signedBlob?: unknown;
}

function isElevatedGovernedAction(action: string, resource: string, effectLevel?: string): boolean {
  if (action === 'LLM_INFERENCE') return true;

  const normalizedEffect = (effectLevel ?? '').trim().toUpperCase();
  const effectMatch = /^E(\d+)$/u.exec(normalizedEffect);
  if (effectMatch && Number(effectMatch[1]) >= 2) return true;
  if (
    [
      'MEDIUM',
      'HIGH',
      'RESTRICTED',
      'WRITE',
      'DEPLOY',
      'PUBLISH',
      'DELETE',
      'PAYMENT',
      'EXTERNAL',
      'ELEVATED',
    ].includes(normalizedEffect)
  ) {
    return true;
  }

  const combined = `${action} ${resource}`.toLowerCase();
  return [
    'approval',
    'browser',
    'computer',
    'connector',
    'delete',
    'deploy',
    'invite',
    'launch',
    'operator',
    'policy',
    'rollback',
    'secret',
    'send',
    'stripe',
    'telegram',
    'write',
  ].some((token) => combined.includes(token));
}

function receiptFromEvaluateBody(
  body: HelmEvaluateBody,
  ctx: { action: string; resource: string; principal: string },
): HelmReceipt | null {
  const decisionId =
    stringField(body, 'decision_id') ??
    stringField(body, 'decisionId') ??
    stringField(body, 'receipt_id') ??
    stringField(body, 'receiptId');
  const policyVersion =
    stringField(body, 'policy_ref') ??
    stringField(body, 'policyRef') ??
    stringField(body, 'policy_version') ??
    stringField(body, 'policyVersion');
  if (!decisionId || !policyVersion) return null;
  return {
    decisionId,
    receiptId: stringField(body, 'receipt_id') ?? stringField(body, 'receiptId'),
    verdict: normalizeEvaluateVerdict(body),
    policyVersion,
    decisionHash: stringField(body, 'decision_hash') ?? stringField(body, 'decisionHash'),
    receivedAt: new Date(),
    action: ctx.action,
    resource: ctx.resource,
    principal: ctx.principal,
    reason: body.reason_code ?? body.reason ?? body.error,
    signedBlob: body.signed_blob ?? body.signedBlob ?? body.signature,
  };
}

function adminWriteGovernanceMetadata(
  classification:
    | typeof HELM_ADMIN_ENDPOINT_ACTION_CATALOG.createObligation
    | typeof HELM_ADMIN_ENDPOINT_ACTION_CATALOG.promoteMemory,
  result: EvaluateResult,
): HelmAdminWriteGovernance {
  return {
    receipt: result.receipt,
    evidencePackId: result.evidencePackId,
    policyDecisionId: result.receipt.decisionId,
    policyVersion: result.receipt.policyVersion,
    helmDocumentVersionPins: {
      helmAdminPolicy: result.receipt.policyVersion,
      [classification.action]: result.receipt.policyVersion,
    },
  };
}

function normalizeEvaluateVerdict(body: HelmEvaluateBody): HelmReceipt['verdict'] {
  const raw = body.verdict?.trim().toUpperCase();
  if (raw === 'ALLOW' || raw === 'DENY' || raw === 'ESCALATE') return raw;
  return body.allow === false ? 'DENY' : 'ALLOW';
}

function stringField<T extends object>(body: T, key: keyof T): string | undefined {
  const value = body[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringContextValue(context: Record<string, unknown>, key: string): string | undefined {
  const value = context[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
