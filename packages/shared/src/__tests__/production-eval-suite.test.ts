import { describe, expect, it } from 'vitest';
import { capabilityKeyValues, getCapabilityRecord } from '../capabilities/index.js';
import {
  buildCapabilityEvalReadinessInventory,
  checkCapabilityPromotionReadiness,
  executePilotProductionEval,
  getPilotProductionEvalSuite,
  getRequiredEvalForCapability,
  getRequiredEvalsForCapability,
  PRODUCTION_READY_EXECUTION_MODE,
  RecordPilotEvalRunInputSchema,
} from '../eval/index.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const realExternalMetadata = { executionMode: PRODUCTION_READY_EXECUTION_MODE };

describe('production eval suite', () => {
  it('defines the required production autonomy evals with evidence and audit requirements', () => {
    const suite = getPilotProductionEvalSuite();
    const names = new Set(suite.map((scenario) => scenario.name));

    expect(names).toContain('Full Startup Launch Eval');
    expect(names).toContain('YC Logged-In Browser Extraction Eval');
    expect(names).toContain('Domain-to-Deployment Eval');
    expect(names).toContain('Stripe Setup Prep Eval');
    expect(names).toContain('Company Formation Prep Eval');
    expect(names).toContain('PMF Discovery Eval');
    expect(names).toContain('Multi-Agent Parallel Build Eval');
    expect(names).toContain('HELM Governance Eval');
    expect(names).toContain('Recovery Eval');
    expect(names).toContain('Founder-Off-Grid Eval');

    for (const scenario of suite) {
      expect(scenario.capabilityKeys.length).toBeGreaterThan(0);
      expect(scenario.requiredHelmPolicies.length).toBeGreaterThan(0);
      expect(scenario.successCriteria.length).toBeGreaterThan(0);
      expect(scenario.failureCriteria.length).toBeGreaterThan(0);
      expect(scenario.evidenceRequirements.length).toBeGreaterThan(0);
      expect(scenario.auditRequirements.length).toBeGreaterThan(0);
    }
  });

  it('maps every capability key to at least one production eval scenario', () => {
    for (const key of capabilityKeyValues) {
      expect(getRequiredEvalForCapability(key)?.id, key).toBeTruthy();
    }
  });

  it('uses explicit required eval mappings for ambiguous capability ownership', () => {
    expect(getRequiredEvalsForCapability('evidence_ledger').map((scenario) => scenario.id)).toEqual(
      ['helm_governance', 'recovery'],
    );
    expect(getRequiredEvalForCapability('computer_use')?.id).toBe('safe_computer_sandbox_action');
  });

  it('reports real external eval readiness without treating control-plane proofs as production', () => {
    const inventory = buildCapabilityEvalReadinessInventory([
      {
        evalId: 'helm_governance',
        workspaceId,
        status: 'passed',
        capabilityKey: 'helm_receipts',
        evidenceRefs: ['evidence:helm'],
        auditReceiptRefs: ['audit:helm'],
        metadata: { executionMode: 'control_plane_proof_check' },
        completedAt: '2026-05-05T00:00:00.000Z',
      },
    ]);

    const helm = inventory.items.find((item) => item.capability.key === 'helm_receipts');
    if (!helm) throw new Error('helm_receipts readiness missing');

    expect(inventory.currentExecutorMode).toBe('control_plane_proof_check');
    expect(inventory.requiredExecutionMode).toBe('real_external_eval');
    expect(inventory.productionReadyCapabilities).toBe(0);
    expect(helm.missingRealEvalIds).toEqual(['helm_governance']);
    expect(helm.productionReadyBlocked).toBe(true);
    expect(helm.blockers.join(' ')).toContain('real_external_eval');
  });

  it('blocks promotion without a matching passed eval run, evidence, and audit receipt', () => {
    const capability = getCapabilityRecord('startup_lifecycle');
    if (!capability) throw new Error('startup_lifecycle capability missing');

    expect(checkCapabilityPromotionReadiness({ capability, runs: [] }).canPromote).toBe(false);

    const failedEvidence = checkCapabilityPromotionReadiness({
      capability,
      runs: [
        {
          evalId: 'full_startup_launch',
          workspaceId,
          status: 'passed',
          capabilityKey: 'startup_lifecycle',
          evidenceRefs: [],
          auditReceiptRefs: ['audit:1'],
          metadata: realExternalMetadata,
          completedAt: '2026-05-05T00:00:00.000Z',
        },
      ],
    });
    expect(failedEvidence.canPromote).toBe(false);
    expect(failedEvidence.blockers.join(' ')).toContain('evidence');

    const passed = checkCapabilityPromotionReadiness({
      capability,
      runs: [
        {
          evalId: 'full_startup_launch',
          workspaceId,
          status: 'passed',
          capabilityKey: 'startup_lifecycle',
          evidenceRefs: ['evidence:startup-launch'],
          auditReceiptRefs: ['audit:startup-launch'],
          metadata: realExternalMetadata,
          completedAt: '2026-05-05T00:00:00.000Z',
        },
        {
          evalId: 'stripe_setup_prep',
          workspaceId,
          status: 'passed',
          capabilityKey: 'startup_lifecycle',
          evidenceRefs: ['evidence:stripe-setup-prep'],
          auditReceiptRefs: ['audit:stripe-setup-prep'],
          metadata: realExternalMetadata,
          completedAt: '2026-05-05T00:01:00.000Z',
        },
      ],
    });

    expect(passed.canPromote).toBe(true);
    expect(passed.matchedEvalId).toBe('full_startup_launch');
    expect(passed.matchedEvalIds).toEqual(['full_startup_launch', 'stripe_setup_prep']);
  });

  it('blocks promotion from control-plane proof checks even with evidence and audit receipts', () => {
    const capability = getCapabilityRecord('startup_lifecycle');
    if (!capability) throw new Error('startup_lifecycle capability missing');

    const check = checkCapabilityPromotionReadiness({
      capability,
      runs: [
        {
          evalId: 'full_startup_launch',
          workspaceId,
          status: 'passed',
          capabilityKey: 'startup_lifecycle',
          evidenceRefs: ['evidence:startup-launch'],
          auditReceiptRefs: ['audit:startup-launch'],
          metadata: { executionMode: 'control_plane_proof_check' },
          completedAt: '2026-05-05T00:00:00.000Z',
        },
      ],
    });

    expect(check.canPromote).toBe(false);
    expect(check.blockers.join(' ')).toContain(`executionMode ${PRODUCTION_READY_EXECUTION_MODE}`);
  });

  it('treats capability-less eval runs as scenario-wide proof for covered capabilities', () => {
    const capability = getCapabilityRecord('startup_lifecycle');
    if (!capability) throw new Error('startup_lifecycle capability missing');

    const passed = checkCapabilityPromotionReadiness({
      capability,
      runs: [
        {
          evalId: 'full_startup_launch',
          workspaceId,
          status: 'passed',
          evidenceRefs: ['evidence:startup-launch'],
          auditReceiptRefs: ['audit:startup-launch'],
          metadata: realExternalMetadata,
          completedAt: '2026-05-05T00:00:00.000Z',
        },
        {
          evalId: 'stripe_setup_prep',
          workspaceId,
          status: 'passed',
          evidenceRefs: ['evidence:stripe-setup-prep'],
          auditReceiptRefs: ['audit:stripe-setup-prep'],
          metadata: realExternalMetadata,
          completedAt: '2026-05-05T00:01:00.000Z',
        },
      ],
    });

    expect(passed.canPromote).toBe(true);
    expect(passed.matchedEvalId).toBe('full_startup_launch');
    expect(passed.matchedEvalIds).toEqual(['full_startup_launch', 'stripe_setup_prep']);
  });

  it('requires every mapped eval before evidence ledger promotion is eligible', () => {
    const capability = getCapabilityRecord('evidence_ledger');
    if (!capability) throw new Error('evidence_ledger capability missing');

    const onlyHelm = checkCapabilityPromotionReadiness({
      capability,
      runs: [
        {
          evalId: 'helm_governance',
          workspaceId,
          status: 'passed',
          capabilityKey: 'evidence_ledger',
          evidenceRefs: ['evidence:helm'],
          auditReceiptRefs: ['audit:helm'],
          metadata: realExternalMetadata,
          completedAt: '2026-05-05T00:00:00.000Z',
        },
      ],
    });

    expect(onlyHelm.canPromote).toBe(false);
    expect(onlyHelm.requiredEvals).toEqual(['HELM Governance Eval', 'Recovery Eval']);
    expect(onlyHelm.blockers.join(' ')).toContain('Recovery Eval');

    const bothRequired = checkCapabilityPromotionReadiness({
      capability,
      runs: [
        {
          evalId: 'helm_governance',
          workspaceId,
          status: 'passed',
          capabilityKey: 'evidence_ledger',
          evidenceRefs: ['evidence:helm'],
          auditReceiptRefs: ['audit:helm'],
          metadata: realExternalMetadata,
          completedAt: '2026-05-05T00:00:00.000Z',
        },
        {
          evalId: 'recovery',
          workspaceId,
          status: 'passed',
          capabilityKey: 'evidence_ledger',
          evidenceRefs: ['evidence:recovery'],
          auditReceiptRefs: ['audit:recovery'],
          metadata: realExternalMetadata,
          completedAt: '2026-05-05T00:00:01.000Z',
        },
      ],
    });

    expect(bothRequired.canPromote).toBe(true);
    expect(bothRequired.matchedEvalIds).toEqual(['helm_governance', 'recovery']);
    expect(bothRequired.evidenceRefs).toEqual(['evidence:helm', 'evidence:recovery']);
    expect(bothRequired.auditReceiptRefs).toEqual(['audit:helm', 'audit:recovery']);
  });

  it('does not promote mission runtime from the startup launch eval alone', () => {
    const capability = getCapabilityRecord('mission_runtime');
    if (!capability) throw new Error('mission_runtime capability missing');

    const check = checkCapabilityPromotionReadiness({
      capability,
      runs: [
        {
          evalId: 'full_startup_launch',
          workspaceId,
          status: 'passed',
          capabilityKey: 'mission_runtime',
          evidenceRefs: ['evidence:startup-launch'],
          auditReceiptRefs: ['audit:startup-launch'],
          metadata: realExternalMetadata,
          completedAt: '2026-05-05T00:00:00.000Z',
        },
      ],
    });

    expect(check.canPromote).toBe(false);
    expect(check.requiredEvals).toEqual([
      'Full Startup Launch Eval',
      'Multi-Agent Parallel Build Eval',
    ]);
    expect(check.blockers.join(' ')).toContain('Multi-Agent Parallel Build Eval');
  });

  it('blocks production promotion from control-plane proof checks even when proof is complete', () => {
    const capability = getCapabilityRecord('helm_receipts');
    if (!capability) throw new Error('helm_receipts capability missing');

    const check = checkCapabilityPromotionReadiness({
      capability,
      runs: [
        {
          evalId: 'helm_governance',
          workspaceId,
          status: 'passed',
          capabilityKey: 'helm_receipts',
          evidenceRefs: ['evidence:helm'],
          auditReceiptRefs: ['audit:helm'],
          metadata: { executionMode: 'control_plane_proof_check' },
          completedAt: '2026-05-05T00:00:00.000Z',
        },
      ],
    });

    expect(check.canPromote).toBe(false);
    expect(check.blockers.join(' ')).toContain('executionMode real_external_eval');
  });

  it('validates recordable eval runs before promotion checks can use them', () => {
    expect(
      RecordPilotEvalRunInputSchema.safeParse({
        evalId: 'helm_governance',
        status: 'passed',
        evidenceRefs: ['evidence:helm'],
        auditReceiptRefs: ['audit:helm'],
      }).success,
    ).toBe(true);

    const missingEvidence = RecordPilotEvalRunInputSchema.safeParse({
      evalId: 'helm_governance',
      status: 'passed',
      evidenceRefs: [],
      auditReceiptRefs: ['audit:helm'],
    });
    expect(missingEvidence.success).toBe(false);

    const failedWithoutReason = RecordPilotEvalRunInputSchema.safeParse({
      evalId: 'helm_governance',
      status: 'failed',
    });
    expect(failedWithoutReason.success).toBe(false);

    const passedWithFailedStep = RecordPilotEvalRunInputSchema.safeParse({
      evalId: 'helm_governance',
      status: 'passed',
      evidenceRefs: ['evidence:helm'],
      auditReceiptRefs: ['audit:helm'],
      steps: [
        {
          stepKey: 'restricted-action-denial',
          status: 'failed',
          evidenceRefs: ['evidence:step'],
          auditReceiptRefs: ['audit:step'],
          completedAt: '2026-05-05T00:00:00.000Z',
        },
      ],
    });
    expect(passedWithFailedStep.success).toBe(false);

    const passedWithIncompleteStep = RecordPilotEvalRunInputSchema.safeParse({
      evalId: 'helm_governance',
      status: 'passed',
      evidenceRefs: ['evidence:helm'],
      auditReceiptRefs: ['audit:helm'],
      steps: [
        {
          stepKey: 'restricted-action-denial',
          status: 'passed',
          evidenceRefs: [],
          auditReceiptRefs: ['audit:step'],
        },
      ],
    });
    expect(passedWithIncompleteStep.success).toBe(false);
  });

  it('executes a control-plane production eval and fails closed without proof coverage', () => {
    const executed = executePilotProductionEval({
      evalId: 'helm_governance',
      capabilityKey: 'helm_receipts',
      completedAt: '2026-05-05T00:00:00.000Z',
    });

    expect(executed.executionMode).toBe('control_plane_proof_check');
    expect(executed.run.status).toBe('failed');
    expect(executed.blockers.join(' ')).toContain('No evidence references');
    expect(executed.blockers.join(' ')).toContain('Missing evidence coverage');
  });

  it('does not let the control-plane executor simulate real external evals', () => {
    const scenario = getRequiredEvalForCapability('startup_lifecycle');
    if (!scenario) throw new Error('startup_lifecycle eval missing');

    const executed = executePilotProductionEval({
      evalId: scenario.id,
      capabilityKey: 'startup_lifecycle',
      executionMode: PRODUCTION_READY_EXECUTION_MODE,
      evidenceRefs: ['evidence:startup-launch'],
      auditReceiptRefs: ['audit:startup-launch'],
      evidenceCoverage: scenario.evidenceRequirements,
      auditCoverage: scenario.auditRequirements,
      completedAt: '2026-05-05T00:00:00.000Z',
    });

    expect(executed.executionMode).toBe('control_plane_proof_check');
    expect(executed.run.status).toBe('failed');
    expect(executed.blockers.join(' ')).toContain('real_external_eval requires a trusted runtime');
    expect(executed.run.metadata['executionMode']).toBe('control_plane_proof_check');
  });

  it('fails closed when an eval is executed for an unrelated capability', () => {
    const scenario = getRequiredEvalForCapability('helm_receipts');
    if (!scenario) throw new Error('helm_receipts eval missing');

    const executed = executePilotProductionEval({
      evalId: scenario.id,
      capabilityKey: 'browser_execution',
      evidenceRefs: ['evidence:helm-governance'],
      auditReceiptRefs: ['audit:helm-governance'],
      evidenceCoverage: scenario.evidenceRequirements,
      auditCoverage: scenario.auditRequirements,
      completedAt: '2026-05-05T00:00:00.000Z',
    });

    expect(executed.run.status).toBe('failed');
    expect(executed.run.capabilityKey).toBe('browser_execution');
    expect(executed.blockers.join(' ')).toContain(
      'HELM Governance Eval does not evaluate capability browser_execution',
    );
  });

  it('keeps executed scenario-wide evals capability-less instead of pinning the first capability', () => {
    const scenario = getRequiredEvalForCapability('startup_lifecycle');
    if (!scenario) throw new Error('startup_lifecycle eval missing');

    const executed = executePilotProductionEval({
      evalId: scenario.id,
      evidenceRefs: ['evidence:startup-launch'],
      auditReceiptRefs: ['audit:startup-launch'],
      evidenceCoverage: scenario.evidenceRequirements,
      auditCoverage: scenario.auditRequirements,
      completedAt: '2026-05-05T00:00:00.000Z',
    });

    expect(executed.run.status).toBe('passed');
    expect(executed.run.capabilityKey).toBeUndefined();
    expect(executed.blockers).toEqual([]);
  });

  it('executes a control-plane production eval and only passes with evidence and audit coverage', () => {
    const scenario = getRequiredEvalForCapability('helm_receipts');
    if (!scenario) throw new Error('helm_receipts eval missing');

    const executed = executePilotProductionEval({
      evalId: scenario.id,
      capabilityKey: 'helm_receipts',
      evidenceRefs: ['evidence:helm-governance'],
      auditReceiptRefs: ['audit:helm-governance'],
      evidenceCoverage: scenario.evidenceRequirements,
      auditCoverage: scenario.auditRequirements,
      completedAt: '2026-05-05T00:00:00.000Z',
    });

    expect(executed.run.status).toBe('passed');
    expect(executed.blockers).toEqual([]);
    expect(executed.run.metadata['executionMode']).toBe('control_plane_proof_check');
  });

  it('fails a control-plane eval when a submitted proof step failed or is incomplete', () => {
    const scenario = getRequiredEvalForCapability('helm_receipts');
    if (!scenario) throw new Error('helm_receipts eval missing');

    const executed = executePilotProductionEval({
      evalId: scenario.id,
      capabilityKey: 'helm_receipts',
      evidenceRefs: ['evidence:helm-governance'],
      auditReceiptRefs: ['audit:helm-governance'],
      evidenceCoverage: scenario.evidenceRequirements,
      auditCoverage: scenario.auditRequirements,
      completedAt: '2026-05-05T00:00:00.000Z',
      steps: [
        {
          stepKey: 'restricted-action-denial',
          status: 'failed',
          evidenceRefs: ['evidence:step'],
          auditReceiptRefs: ['audit:step'],
          completedAt: '2026-05-05T00:00:00.000Z',
        },
        {
          stepKey: 'receipt-persistence',
          status: 'passed',
          evidenceRefs: [],
          auditReceiptRefs: ['audit:step-2'],
        },
      ],
    });

    expect(executed.run.status).toBe('failed');
    expect(executed.blockers.join(' ')).toContain(
      'Eval step restricted-action-denial status is failed',
    );
    expect(executed.blockers.join(' ')).toContain(
      'Eval step receipt-persistence is missing evidence references',
    );
    expect(executed.blockers.join(' ')).toContain(
      'Eval step receipt-persistence is missing completedAt',
    );
  });
});
