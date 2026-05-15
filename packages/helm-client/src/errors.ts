import type { HelmReceipt } from './types.js';

/**
 * Thrown when HELM is unreachable, timed out, or returns a non-governance
 * error (5xx). Fail-closed semantics: callers MUST treat this as a DENY.
 */
export class HelmUnreachableError extends Error {
  public readonly code = 'HELM_UNREACHABLE';
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly lastAttempt?: number,
  ) {
    super(message);
    this.name = 'HelmUnreachableError';
  }
}

/**
 * Thrown when HELM returns a definitive DENY verdict (HTTP 403 with governance
 * headers). Contains the receipt for persistence + auditing.
 */
export class HelmDeniedError extends Error {
  public readonly code = 'HELM_DENIED';
  constructor(
    public readonly receipt: HelmReceipt,
    public readonly reason: string,
  ) {
    super(`HELM DENY (${receipt.decisionId}): ${reason}`);
    this.name = 'HelmDeniedError';
  }
}

/**
 * Thrown when HELM returns ESCALATE — human approval required. Callers should
 * route the action through the approvals queue and retry on approval.
 */
export class HelmEscalationError extends Error {
  public readonly code = 'HELM_ESCALATE';
  constructor(
    public readonly receipt: HelmReceipt,
    public readonly reason: string,
  ) {
    super(`HELM ESCALATE (${receipt.decisionId}): ${reason}`);
    this.name = 'HelmEscalationError';
  }
}

/**
 * Thrown when the client is asked to perform an operation that the installed
 * helm-ai-kernel version does not yet support (e.g. generic evaluate() against
 * helm-ai-kernel v0.3.0 before the upstream `/api/v1/guardian/evaluate` endpoint
 * ships).
 */
export class HelmNotImplementedError extends Error {
  public readonly code = 'HELM_NOT_IMPLEMENTED';
  constructor(message: string) {
    super(message);
    this.name = 'HelmNotImplementedError';
  }
}
