// ─── Conformance types (Phase 15 Track M) ───
//
// Minimal certification surface for Pilot subagents. Levels mirror
// helm-ai-kernel's L1/L2/L3 ladder:
//
//   L1 — structural integrity. Evidence pack has required fields,
//        JCS-canonical manifest, SHA-256 decision hash, signed blob
//        present (even if unverified locally).
//   L2 — deterministic replay. Every iteration produces the same
//        decisionHash when replayed with the same inputs; parent
//        chain reconciles without gaps.
//   L3 — adversarial resilience. 60+ tests across 6 gates — NOT
//        implemented in Pilot; certification requires the helm-ai-kernel
//        Go harness. We ship the hook so operators can opt in.

export type CertificationLevel = 'L1' | 'L2' | 'L3';

export interface EvidencePackLite {
  id: string;
  decisionId: string;
  verdict: 'ALLOW' | 'DENY' | 'ESCALATE';
  policyVersion: string;
  action: string;
  resource: string;
  principal: string;
  receivedAt: string | Date;
  decisionHash?: string | null;
  signedBlob?: unknown;
  parentEvidencePackId?: string | null;
  taskRunId?: string | null;
}

export interface ValidationFinding {
  code: string;
  level: 'error' | 'warn' | 'info';
  message: string;
  field?: string;
}

export interface ValidationResult {
  level: CertificationLevel;
  passed: boolean;
  findings: ValidationFinding[];
}

export class ConformanceError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_input' | 'fixture_missing' | 'unknown' = 'unknown',
  ) {
    super(message);
    this.name = 'ConformanceError';
  }
}
