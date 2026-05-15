import { z } from 'zod';

// ─── Compliance frameworks (Phase 14 Track B) ───
//
// Metadata for each regulated compliance pack available in helm-ai-kernel.
// Workspaces opt in by adding a framework code to
// `workspaces.compliance_frameworks` (migration 0013).
//
// Retention days drive the cleanup scheduler in
// `services/orchestrator/src/retention.ts` — evidence packs older than
// the max retention of any enabled framework are preserved; packs for
// workspaces with no enabled framework default to the base (30d).

export const ComplianceFrameworkCodeSchema = z.enum([
  'soc2_type2',
  'hipaa_covered_entity',
  'pci_dss_4',
  'eu_ai_act_high_risk',
  'iso_42001',
]);
export type ComplianceFrameworkCode = z.infer<typeof ComplianceFrameworkCodeSchema>;

export interface ComplianceFramework {
  code: ComplianceFrameworkCode;
  label: string;
  description: string;
  /** Retention window for evidence packs under this framework, in days. */
  retentionDays: number;
  /** helm-ai-kernel reference pack file name (for overlay composition). */
  helmPack: string;
  /** One-word category for dashboard grouping. */
  category: 'security' | 'health' | 'finance' | 'ai' | 'general';
  /** Human-readable jurisdictions this framework covers. */
  jurisdictions: string[];
}

export const FRAMEWORKS: ComplianceFramework[] = [
  {
    code: 'soc2_type2',
    label: 'SOC 2 Type II',
    description:
      'AICPA Trust Services Criteria (CC6/CC7/CC8). Most enterprise B2B contracts require this.',
    retentionDays: 365,
    helmPack: 'soc2_type2.v1.json',
    category: 'security',
    jurisdictions: ['US'],
  },
  {
    code: 'hipaa_covered_entity',
    label: 'HIPAA Covered Entity',
    description:
      'Protected Health Information handling + minimum-necessary + breach notification. Required for US healthtech.',
    retentionDays: 2190,
    helmPack: 'hipaa_covered_entity.v1.json',
    category: 'health',
    jurisdictions: ['US'],
  },
  {
    code: 'pci_dss_4',
    label: 'PCI DSS 4.0',
    description:
      'Cardholder data handling, segmentation, incident response. Required when processing credit cards.',
    retentionDays: 365,
    helmPack: 'pci_dss_4.v1.json',
    category: 'finance',
    jurisdictions: ['global'],
  },
  {
    code: 'eu_ai_act_high_risk',
    label: 'EU AI Act (High-Risk systems)',
    description:
      'Model confidence thresholds, explainability, human override, transparency. Required in EU for high-risk deployments.',
    retentionDays: 1095,
    helmPack: 'eu_ai_act_high_risk.v1.json',
    category: 'ai',
    jurisdictions: ['EU'],
  },
  {
    code: 'iso_42001',
    label: 'ISO/IEC 42001 (AI Management System)',
    description:
      'AI governance, corrective action tracking, continuous compliance scoring.',
    retentionDays: 1825,
    helmPack: 'iso_42001.v1.json',
    category: 'ai',
    jurisdictions: ['global'],
  },
];

const BY_CODE = new Map(FRAMEWORKS.map((f) => [f.code, f]));

export function getFramework(code: string): ComplianceFramework | undefined {
  return BY_CODE.get(code as ComplianceFrameworkCode);
}

/**
 * Resolve the max retention window across all enabled frameworks for a
 * workspace. Returns the base default (30 days) when none are enabled.
 */
export function maxRetentionDays(enabled: string[], baseDays = 30): number {
  let max = baseDays;
  for (const code of enabled) {
    const f = BY_CODE.get(code as ComplianceFrameworkCode);
    if (f && f.retentionDays > max) max = f.retentionDays;
  }
  return max;
}
