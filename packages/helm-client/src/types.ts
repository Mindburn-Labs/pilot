/**
 * HELM governance client types.
 *
 * These types mirror what helm-ai-kernel v0.3.0 exposes via:
 *   - POST /v1/chat/completions   → LLM call with Guardian enforcement
 *   - GET  /healthz               → health
 *   - GET  /api/v1/version        → version
 *
 * Generic tool/deploy governance uses `POST /api/v1/evaluate`.
 */

/** CPI verdict — matches helm-ai-kernel `core/pkg/contracts/verdict.go`. */
export type HelmVerdict = 'ALLOW' | 'DENY' | 'ESCALATE';

/**
 * Receipt attached to every HELM governance decision.
 *
 * For chat completions the fields are parsed from response headers:
 *   X-Helm-Decision-ID    → decisionId
 *   X-Helm-Verdict        → verdict
 *   X-Helm-Policy-Version → policyVersion
 *   X-Helm-Decision-Hash  → decisionHash
 */
export interface HelmReceipt {
  decisionId: string;
  /** HELM receipt identifier when the endpoint returns one separately. */
  receiptId?: string;
  verdict: HelmVerdict;
  policyVersion: string;
  decisionHash?: string;
  /** Wall-clock capture time in the client. Useful for replay when HELM didn't emit one. */
  receivedAt: Date;
  /** The action recorded in the decision request (e.g. 'LLM_INFERENCE'). */
  action: string;
  /** The resource — model name for LLM, tool name for tool calls. */
  resource: string;
  /** Principal presented to HELM. */
  principal: string;
  /** Optional human-readable reason populated on DENY/ESCALATE. */
  reason?: string;
  /** Raw signed receipt blob/signature when HELM returns one. */
  signedBlob?: unknown;
}

export interface HealthSnapshot {
  gatewayOk: boolean;
  version?: string;
  latencyMs: number;
  checkedAt: Date;
  /** Only populated when gatewayOk is false. */
  error?: string;
}

/**
 * Chat completion request — matches the OpenAI Chat Completions schema that
 * HELM proxies at `POST /v1/chat/completions`.
 */
export interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    name?: string;
    tool_call_id?: string;
  }>;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: false;
  [key: string]: unknown;
}

export interface ChatCompletionResult {
  /** Raw OpenAI-shaped response body (choices, usage, id, model, etc.). */
  body: ChatCompletionBody;
  /** Governance receipt parsed from the response headers. */
  receipt: HelmReceipt;
}

export interface ChatCompletionBody {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface EvaluateRequest {
  principal: string;
  action: string;
  resource: string;
  args?: Record<string, unknown>;
  effectLevel?: string;
  sessionId?: string;
  context?: Record<string, unknown>;
}

export interface EvaluateResult {
  receipt: HelmReceipt;
  /** Evidence pack identifier (when HELM is configured to persist them). */
  evidencePackId?: string;
}

export interface OperatorComputerUseRequest {
  principal: string;
  workspaceId: string;
  objective: string;
  targetUrl?: string;
  environment?: 'local' | 'sandbox';
  operation: 'terminal_command' | 'file_read' | 'file_write' | 'dev_server_status';
  maxSteps?: number;
  taskId?: string;
  operatorId?: string;
  approvalCheckpoint?: string;
  evidencePackId?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  path?: string;
  contentHash?: string;
  expectedCurrentHash?: string;
  maxBytes?: number;
  timeoutMs?: number;
  devServerUrl?: string;
}

export interface OperatorComputerUseResult {
  status: 'approved_for_execution';
  receipt: HelmReceipt;
  evidencePackId?: string;
  request: {
    workspaceId: string;
    objective: string;
    targetUrl?: string;
    environment: 'local' | 'sandbox';
    operation: OperatorComputerUseRequest['operation'];
    maxSteps: number;
    taskId?: string;
    operatorId?: string;
    approvalCheckpoint?: string;
    command?: string;
    args?: string[];
    cwd?: string;
    path?: string;
    contentHash?: string;
    expectedCurrentHash?: string;
    maxBytes?: number;
    timeoutMs?: number;
    devServerUrl?: string;
  };
}

export interface OperatorBrowserReadRequest {
  principal: string;
  workspaceId: string;
  sessionId: string;
  grantId: string;
  objective?: string;
  url: string;
  taskId?: string;
  operatorId?: string;
}

export interface OperatorBrowserReadResult {
  status: 'approved_for_read';
  receipt: HelmReceipt;
  evidencePackId?: string;
  request: {
    workspaceId: string;
    sessionId: string;
    grantId: string;
    objective?: string;
    url: string;
    taskId?: string;
    operatorId?: string;
  };
}

export interface HelmClientConfig {
  /** Base URL of HELM's governed API, e.g. http://helm:8080 */
  baseUrl: string;
  /** Base URL of HELM's health server, e.g. http://helm:8081 */
  healthUrl?: string;
  /** Default principal if not supplied per-call (e.g. 'workspace:abc/operator:engineering'). */
  defaultPrincipal?: string;
  /** Admin API key injected as Authorization: Bearer … for admin endpoints. */
  adminApiKey?: string;
  /** Per-request timeout in ms. Defaults to 30000. */
  timeoutMs?: number;
  /** Max attempts per governed call (including the first). Defaults to 3. */
  maxRetries?: number;
  /** Deprecated: generic evaluate is always enabled for production callers. */
  evaluateEnabled?: boolean;
  /** Base backoff in ms for exponential retry. Defaults to 100. */
  baseBackoffMs?: number;
  /** Fail closed when true (default): any non-200 / non-403 error denies the call. */
  failClosed?: boolean;
  /**
   * Receipt persistence contract.
   *
   * - best_effort: emit receipts when a sink exists; sink failures do not fail the call.
   * - required_for_elevated: medium/high/restricted evaluate actions require a sink and
   *   fail closed when persistence fails.
   * - required: every emitted receipt requires durable sink persistence.
   */
  receiptPersistence?: 'best_effort' | 'required_for_elevated' | 'required';
  /** Optional fetch implementation for tests. */
  fetchImpl?: typeof fetch;
  /** Optional receipt callback (e.g. persist to evidence_packs table). */
  onReceipt?: (receipt: HelmReceipt) => void | Promise<void>;
}

// ─── Phase 14 Track F — helm-ai-kernel endpoint response shapes ───
// These types mirror the helm-ai-kernel HTTP endpoint payloads Pilot consumes.

export interface Soc2BundleResult {
  /** JCS-canonical bundle, base64-encoded tar.gz for transport. */
  bundleBase64: string;
  manifestHash: string;
  generatedAt: string;
}

export interface MerkleRootResult {
  root: string;
  generatedAt: string;
}

export interface BudgetStatusResult {
  enforcer: string;
  status: 'active' | 'degraded' | 'unconfigured';
  dailyRemainingUsd?: number;
  dailyLimitUsd?: number;
  monthlyRemainingUsd?: number;
  monthlyLimitUsd?: number;
  alerts?: Array<{ level: 'info' | 'warn' | 'critical'; message: string }>;
}

export interface ObligationRequest {
  workspaceId: string;
  decisionId: string;
  obligation: string;
  retentionDays?: number;
  metadata?: Record<string, unknown>;
}

export interface ObligationResult {
  obligationId: string;
  registeredAt: string;
  expiresAt?: string;
  governance?: HelmAdminWriteGovernance;
}

export interface BoundaryCheckResult {
  ok: boolean;
  violations: Array<{ kind: string; detail: string; severity: 'warn' | 'critical' }>;
  checkedAt: string;
}

export interface MemoryEntry {
  id: string;
  scope: 'workspace' | 'shared';
  title: string;
  createdAt: string;
  checksum: string;
}

export interface MemoryListResult {
  entries: MemoryEntry[];
  nextCursor?: string;
}

export interface MemoryPromoteResult {
  sharedMemoryId: string;
  promotedAt: string;
  governance?: HelmAdminWriteGovernance;
}

export interface HelmAdminWriteGovernance {
  receipt: HelmReceipt;
  evidencePackId?: string;
  policyDecisionId: string;
  policyVersion: string;
  helmDocumentVersionPins: Record<string, string>;
}

export interface ContextBundle {
  id: string;
  name: string;
  size: number;
  checksum: string;
  createdAt: string;
}

export interface ContextBundleListResult {
  bundles: ContextBundle[];
}

export interface EconomicCharge {
  id: string;
  workspaceId: string;
  centerLabel?: string;
  amountUsd: number;
  currency: string;
  occurredAt: string;
  reason?: string;
}

export interface EconomicChargesResult {
  charges: EconomicCharge[];
  totalUsd: number;
  window: { from: string; to: string };
}

export interface EconomicAllocation {
  workspaceId: string;
  allocatedUsd: number;
  consumedUsd: number;
  window: { from: string; to: string };
}

export interface EconomicAllocationsResult {
  allocations: EconomicAllocation[];
}
