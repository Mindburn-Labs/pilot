import { validateL1 } from './l1.js';
import {
  ConformanceError,
  type EvidencePackLite,
  type ValidationFinding,
  type ValidationResult,
} from './types.js';

// ─── L2 — deterministic replay + chain reconciliation ───
//
// Operates over a full chain of packs (typically one task's worth of
// rows ordered by receivedAt asc). Verifies:
//
//   1. Every pack passes L1.
//   2. `decisionId` is unique across the set.
//   3. Every `parentEvidencePackId` resolves to a pack in the set or
//      is null for roots — no orphan references, no cycles.
//   4. `receivedAt` is monotone non-decreasing from parent → child.
//
// Replay verification against a deterministic engine is out of scope
// for Pilot-side L2; helm-ai-kernel ships the canonical replay harness. We
// assert the evidence is REPLAY-READY — any downstream verifier can
// pick the chain up and rehash.

export function validateL2(packs: EvidencePackLite[]): ValidationResult {
  if (!Array.isArray(packs)) {
    throw new ConformanceError(
      'validateL2 requires an array of packs',
      'invalid_input',
    );
  }
  const findings: ValidationFinding[] = [];

  // 1. Every pack must pass L1 first.
  for (const pack of packs) {
    const l1 = validateL1(pack);
    if (!l1.passed) {
      for (const f of l1.findings.filter((x) => x.level === 'error')) {
        findings.push({
          ...f,
          code: `l2.prerequisite.${f.code}`,
          message: `[${pack.id ?? 'unknown'}] ${f.message}`,
        });
      }
    }
  }

  // 2. Unique decisionId.
  const seenDecisions = new Map<string, string>();
  for (const pack of packs) {
    const existing = seenDecisions.get(pack.decisionId);
    if (existing && existing !== pack.id) {
      findings.push({
        code: 'l2.duplicate_decision_id',
        level: 'error',
        message: `decisionId "${pack.decisionId}" reused across packs ${existing} and ${pack.id}`,
        field: 'decisionId',
      });
    }
    seenDecisions.set(pack.decisionId, pack.id);
  }

  // 3. Parent chain — every parentEvidencePackId must resolve or be null.
  const byId = new Map(packs.map((p) => [p.id, p]));
  for (const pack of packs) {
    if (
      pack.parentEvidencePackId != null &&
      pack.parentEvidencePackId !== '' &&
      !byId.has(pack.parentEvidencePackId)
    ) {
      findings.push({
        code: 'l2.orphan_parent_ref',
        level: 'error',
        message: `pack ${pack.id} references missing parent ${pack.parentEvidencePackId}`,
        field: 'parentEvidencePackId',
      });
    }
  }

  // Cycle detection — 3-color DFS following parent pointers.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(packs.map((p) => [p.id, WHITE]));
  for (const root of packs) {
    if (color.get(root.id) !== WHITE) continue;
    let cursor: string | null | undefined = root.id;
    const path: string[] = [];
    while (cursor) {
      if (color.get(cursor) === GRAY) {
        findings.push({
          code: 'l2.parent_cycle',
          level: 'error',
          message: `parent chain cycle detected at ${cursor} (path: ${path.join('→')})`,
          field: 'parentEvidencePackId',
        });
        break;
      }
      if (color.get(cursor) === BLACK) break;
      color.set(cursor, GRAY);
      path.push(cursor);
      const node = byId.get(cursor);
      cursor = node?.parentEvidencePackId ?? null;
    }
    for (const id of path) color.set(id, BLACK);
  }

  // 4. Monotone non-decreasing timestamp along parent → child.
  for (const pack of packs) {
    if (!pack.parentEvidencePackId) continue;
    const parent = byId.get(pack.parentEvidencePackId);
    if (!parent) continue;
    const parentTs = toMs(parent.receivedAt);
    const childTs = toMs(pack.receivedAt);
    if (parentTs > childTs) {
      findings.push({
        code: 'l2.timestamp_regression',
        level: 'warn',
        message: `child ${pack.id} receivedAt precedes parent ${parent.id} by ${parentTs - childTs}ms`,
        field: 'receivedAt',
      });
    }
  }

  const passed = !findings.some((f) => f.level === 'error');
  return { level: 'L2', passed, findings };
}

function toMs(value: string | Date): number {
  if (value instanceof Date) return value.getTime();
  const t = new Date(value as string).getTime();
  return Number.isFinite(t) ? t : 0;
}
