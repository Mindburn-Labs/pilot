import { describe, expect, it } from 'vitest';
import {
  ExecutedStartupMissionNodeSchema,
  StartupLifecycleStageValues,
  compileStartupLifecycleMission,
  getStartupLifecycleTemplates,
} from '../schemas/index.js';

const workspaceId = '00000000-0000-4000-8000-000000000001';

describe('startup lifecycle compiler', () => {
  it('covers the required startup lifecycle with governed node contracts', () => {
    const templates = getStartupLifecycleTemplates();
    const stages = new Set(templates.map((node) => node.stage));

    expect(stages).toEqual(new Set(StartupLifecycleStageValues));
    for (const node of templates) {
      expect(node.requiredAgents.length).toBeGreaterThan(0);
      expect(node.requiredSkills.length).toBeGreaterThan(0);
      expect(node.requiredTools.length).toBeGreaterThan(0);
      expect(node.requiredEvidence.length).toBeGreaterThan(0);
      expect(node.helmPolicyClasses.length).toBeGreaterThan(0);
      expect(node.acceptanceCriteria.length).toBeGreaterThan(0);
    }
  });

  it('keeps legal, financial, deployment, and communication actions behind escalation gates', () => {
    const compiled = compileStartupLifecycleMission({
      workspaceId,
      founderGoal:
        'Build and launch a governed AI tool that helps small law firms triage inbound leads.',
      autonomyMode: 'autopilot',
      constraints: ['No paid external actions without approval'],
    });

    expect(compiled.productionReady).toBe(false);
    expect(compiled.capabilityState).toBe('prototype');
    expect(compiled.mission.status).toBe('compiled_not_persisted');
    expect(compiled.mission.nodes).toHaveLength(StartupLifecycleStageValues.length);
    expect(compiled.mission.edges.length).toBeGreaterThan(0);
    expect(compiled.mission.blockers.join(' ')).toContain('not persisted');

    const gatedStages = [
      'brand_domain_planning',
      'infrastructure_deployment',
      'stripe_setup_prep',
      'company_formation_prep',
      'growth_experiments',
      'sales_outreach_drafts',
      'fundraising_packet',
    ];

    for (const stage of gatedStages) {
      const node = compiled.mission.nodes.find((item) => item.stage === stage);
      expect(node?.escalationConditions.join(' ').toLowerCase()).toMatch(
        /policy|payment|identity|signature|send|deployment|purchase|filing|sharing|public/,
      );
    }
  });

  it('accepts stalled governed runtime results without promoting the node', () => {
    const parsed = ExecutedStartupMissionNodeSchema.parse({
      workspaceId,
      missionId: '00000000-0000-4000-8000-000000000002',
      nodeId: '00000000-0000-4000-8000-000000000003',
      nodeKey: 'market_research',
      taskId: '00000000-0000-4000-8000-000000000004',
      executorVersion: 'mission-node-executor.v1',
      productionReady: false,
      executionStarted: true,
      status: 'failed',
      missionStatus: 'blocked',
      run: {
        status: 'stalled',
        iterationsUsed: 1,
        iterationBudget: 10,
        actionCount: 1,
      },
      advancedReadyNodes: [],
      evidenceItemIds: ['00000000-0000-4000-8000-000000000005'],
      blockers: ['Agent run stalled before completing node acceptance criteria'],
    });

    expect(parsed.run.status).toBe('stalled');
    expect(parsed.productionReady).toBe(false);
  });
});
