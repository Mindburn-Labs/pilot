import { z } from 'zod';
import { CapabilityStateSchema } from '../capabilities/index.js';

export const StartupLifecycleStageValues = [
  'founder_onboarding',
  'ideation',
  'market_research',
  'pmf_discovery',
  'product_definition',
  'brand_domain_planning',
  'engineering',
  'infrastructure_deployment',
  'stripe_setup_prep',
  'company_formation_prep',
  'growth_experiments',
  'sales_outreach_drafts',
  'fundraising_packet',
  'operations_recovery',
] as const;

export const StartupLifecycleStageSchema = z.enum(StartupLifecycleStageValues);

export const StartupLifecycleAutonomyModeSchema = z.enum([
  'observe',
  'assist',
  'review',
  'autopilot',
  'founder_off_grid',
]);

export const StartupLifecycleNodeSchema = z.object({
  id: z.string().min(1),
  stage: StartupLifecycleStageSchema,
  title: z.string().min(1),
  objective: z.string().min(1),
  dependsOn: z.array(z.string().min(1)).default([]),
  requiredAgents: z.array(z.string().min(1)).min(1),
  requiredSkills: z.array(z.string().min(1)).min(1),
  requiredTools: z.array(z.string().min(1)).min(1),
  requiredEvidence: z.array(z.string().min(1)).min(1),
  helmPolicyClasses: z.array(z.string().min(1)).min(1),
  escalationConditions: z.array(z.string().min(1)),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
});

export const StartupLifecycleEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  reason: z.string().min(1),
});

export const CompileStartupLifecycleInputSchema = z.object({
  workspaceId: z.string().uuid(),
  founderGoal: z.string().min(10).max(4000),
  ventureContext: z.string().max(4000).optional(),
  constraints: z.array(z.string().min(1).max(500)).max(30).default([]),
  autonomyMode: StartupLifecycleAutonomyModeSchema.default('review'),
});

export const PersistStartupLifecycleInputSchema = CompileStartupLifecycleInputSchema.extend({
  ventureName: z.string().min(1).max(160).optional(),
  createNodeTasks: z.boolean().default(true),
});

export const ScheduleStartupMissionInputSchema = z.object({
  workspaceId: z.string().uuid(),
  missionId: z.string().uuid(),
  maxNodes: z.coerce.number().int().min(1).max(10).default(3),
});

export const ExecuteStartupMissionNodeInputSchema = z.object({
  workspaceId: z.string().uuid(),
  missionId: z.string().uuid(),
  nodeId: z.string().uuid(),
  context: z.string().max(10000).optional(),
  iterationBudget: z.coerce.number().int().min(1).max(100).default(10),
});

export const ExecuteStartupMissionInputSchema = z.object({
  workspaceId: z.string().uuid(),
  missionId: z.string().uuid(),
  maxNodes: z.coerce.number().int().min(1).max(5).default(1),
  context: z.string().max(10000).optional(),
  iterationBudget: z.coerce.number().int().min(1).max(100).default(10),
});

export const CheckpointStartupMissionInputSchema = z.object({
  workspaceId: z.string().uuid(),
  missionId: z.string().uuid(),
  reason: z.string().min(1).max(500).optional(),
});

export const PlanStartupMissionRecoveryInputSchema = z.object({
  workspaceId: z.string().uuid(),
  missionId: z.string().uuid(),
  reason: z.string().min(1).max(500).optional(),
});

export const ApplyStartupMissionRecoveryInputSchema = z.object({
  workspaceId: z.string().uuid(),
  missionId: z.string().uuid(),
  recoveryPlanReplayRef: z.string().min(1).max(500).optional(),
  retryNodeKeys: z.array(z.string().min(1).max(160)).max(20).optional(),
  reason: z.string().min(1).max(500).optional(),
});

export const MissionRuntimeCheckpointKindSchema = z.enum([
  'manual_checkpoint',
  'pre_recovery',
  'pre_rollback',
]);

export const RollbackStartupMissionInputSchema = z.object({
  workspaceId: z.string().uuid(),
  missionId: z.string().uuid(),
  scope: z.literal('failed_blocked_to_ready').default('failed_blocked_to_ready'),
  reason: z.string().min(1).max(1000),
});

export const CompiledStartupLifecycleMissionSchema = z.object({
  workspaceId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  compilerVersion: z.literal('startup-lifecycle.v1'),
  capabilityState: CapabilityStateSchema,
  productionReady: z.literal(false),
  mission: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: z.literal('compiled_not_persisted'),
    founderGoal: z.string().min(1),
    autonomyMode: StartupLifecycleAutonomyModeSchema,
    ventureContext: z.string().optional(),
    constraints: z.array(z.string()),
    nodes: z.array(StartupLifecycleNodeSchema).min(1),
    edges: z.array(StartupLifecycleEdgeSchema),
    assumptions: z.array(z.string().min(1)),
    blockers: z.array(z.string().min(1)),
  }),
});

export const PersistedStartupLifecycleMissionSchema = z.object({
  workspaceId: z.string().uuid(),
  generatedAt: z.string().datetime(),
  compilerVersion: z.literal('startup-lifecycle.v1'),
  capabilityState: CapabilityStateSchema,
  productionReady: z.literal(false),
  evidenceItemIds: z.array(z.string().uuid()).default([]),
  persisted: z.object({
    ventureId: z.string().uuid(),
    goalId: z.string().uuid(),
    missionId: z.string().uuid(),
    nodeCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
    taskCount: z.number().int().nonnegative(),
  }),
  mission: CompiledStartupLifecycleMissionSchema.shape.mission.extend({
    status: z.literal('persisted_not_executing'),
  }),
});

export const ScheduledStartupMissionNodeSchema = z.object({
  nodeId: z.string().uuid(),
  nodeKey: z.string().min(1),
  stage: StartupLifecycleStageSchema,
  title: z.string().min(1),
  taskId: z.string().uuid().optional(),
  waitingOn: z.array(z.string().min(1)).default([]),
});

export const ScheduledStartupMissionSchema = z.object({
  workspaceId: z.string().uuid(),
  missionId: z.string().uuid(),
  schedulerVersion: z.literal('mission-scheduler.v1'),
  productionReady: z.literal(false),
  status: z.literal('scheduled_not_executing'),
  readyNodes: z.array(ScheduledStartupMissionNodeSchema),
  blockedNodes: z.array(ScheduledStartupMissionNodeSchema),
  queuedTaskIds: z.array(z.string().uuid()),
  evidenceItemIds: z.array(z.string().uuid()).default([]),
  executionStarted: z.literal(false),
  blockers: z.array(z.string().min(1)),
});

export const ExecutedStartupMissionNodeSchema = z.object({
  workspaceId: z.string().uuid(),
  missionId: z.string().uuid(),
  nodeId: z.string().uuid(),
  nodeKey: z.string().min(1),
  taskId: z.string().uuid(),
  executorVersion: z.literal('mission-node-executor.v1'),
  productionReady: z.literal(false),
  executionStarted: z.literal(true),
  status: z.enum(['completed', 'failed', 'awaiting_approval', 'blocked']),
  missionStatus: z.enum(['completed', 'scheduled_not_executing', 'blocked', 'awaiting_approval']),
  run: z.object({
    status: z.enum(['completed', 'budget_exhausted', 'blocked', 'awaiting_approval', 'stalled']),
    iterationsUsed: z.number().int().nonnegative(),
    iterationBudget: z.number().int().positive(),
    actionCount: z.number().int().nonnegative(),
  }),
  advancedReadyNodes: z.array(ScheduledStartupMissionNodeSchema),
  evidenceItemIds: z.array(z.string().uuid()).default([]),
  blockers: z.array(z.string().min(1)),
});

export const ExecutedStartupMissionSchema = z.object({
  workspaceId: z.string().uuid(),
  missionId: z.string().uuid(),
  executorVersion: z.literal('mission-executor.v1'),
  productionReady: z.literal(false),
  executionStarted: z.boolean(),
  missionStatus: z.enum(['completed', 'scheduled_not_executing', 'blocked', 'awaiting_approval']),
  executedNodes: z.array(ExecutedStartupMissionNodeSchema),
  remainingReadyNodeIds: z.array(z.string().uuid()),
  evidenceItemIds: z.array(z.string().uuid()).default([]),
  blockers: z.array(z.string().min(1)),
});

export const CheckpointedStartupMissionSchema = z.object({
  workspaceId: z.string().uuid(),
  missionId: z.string().uuid(),
  checkpointId: z.string().min(1),
  runtimeCheckpointId: z.string().uuid(),
  checkpointVersion: z.literal('mission-checkpoint.v1'),
  productionReady: z.literal(false),
  status: z.literal('checkpointed_not_recovered'),
  missionStatus: z.string().min(1),
  replayRef: z.string().min(1),
  evidenceItemIds: z.array(z.string().uuid()).default([]),
  snapshot: z.object({
    missionId: z.string().uuid(),
    status: z.string().min(1),
    nodeCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
    taskLinkCount: z.number().int().nonnegative(),
    nodeStatuses: z.record(z.string(), z.number().int().nonnegative()),
  }),
  blockers: z.array(z.string().min(1)),
});

export const PlannedStartupMissionRecoverySchema = z.object({
  workspaceId: z.string().uuid(),
  missionId: z.string().uuid(),
  recoveryPlanId: z.string().min(1),
  recoveryPlanVersion: z.literal('mission-recovery-plan.v1'),
  productionReady: z.literal(false),
  status: z.literal('planned_not_executed'),
  missionStatus: z.string().min(1),
  recoveryExecuted: z.literal(false),
  checkpointId: z.string().min(1).nullable(),
  checkpointReplayRef: z.string().min(1).nullable(),
  replayRef: z.string().min(1),
  evidenceItemIds: z.array(z.string().uuid()).default([]),
  plan: z.object({
    changedNodeKeys: z.array(z.string().min(1)),
    blockedNodeKeys: z.array(z.string().min(1)),
    failedNodeKeys: z.array(z.string().min(1)),
    awaitingApprovalNodeKeys: z.array(z.string().min(1)),
    readyNodeKeys: z.array(z.string().min(1)),
    currentNodeStatuses: z.record(z.string(), z.string().min(1)),
    checkpointNodeStatuses: z.record(z.string(), z.string().min(1)),
    recommendedNextActions: z.array(z.string().min(1)),
  }),
  blockers: z.array(z.string().min(1)),
});

export const AppliedStartupMissionRecoveryNodeSchema = z.object({
  nodeId: z.string().uuid(),
  nodeKey: z.string().min(1),
  previousStatus: z.string().min(1),
  nextStatus: z.literal('ready'),
  taskId: z.string().uuid().optional(),
});

export const SkippedStartupMissionRecoveryNodeSchema = z.object({
  nodeId: z.string().uuid().optional(),
  nodeKey: z.string().min(1),
  status: z.string().min(1).optional(),
  reason: z.string().min(1),
});

export const AppliedStartupMissionRecoverySchema = z.object({
  workspaceId: z.string().uuid(),
  missionId: z.string().uuid(),
  recoveryApplyId: z.string().min(1),
  recoveryApplyVersion: z.literal('mission-recovery-apply.v1'),
  productionReady: z.literal(false),
  status: z.enum(['recovery_applied_not_executed', 'recovery_noop_not_executed']),
  missionStatus: z.string().min(1),
  recoveryPlanReplayRef: z.string().min(1).nullable(),
  executionStarted: z.literal(false),
  recoveredNodes: z.array(AppliedStartupMissionRecoveryNodeSchema),
  skippedNodes: z.array(SkippedStartupMissionRecoveryNodeSchema),
  evidenceItemIds: z.array(z.string().uuid()).default([]),
  blockers: z.array(z.string().min(1)),
});

export const MissionRuntimeCheckpointSchema = z.object({
  checkpointId: z.string().uuid(),
  checkpointKind: MissionRuntimeCheckpointKindSchema,
  replayRef: z.string().min(1),
  missionId: z.string().uuid(),
  missionStatus: z.string().min(1),
  cursorNodeId: z.string().uuid().optional(),
  cursorNodeKey: z.string().min(1).optional(),
  nodeStatusCounts: z.record(z.string(), z.number().int().nonnegative()),
  readyNodeIds: z.array(z.string().uuid()),
  blockedNodeIds: z.array(z.string().uuid()),
  failedNodeIds: z.array(z.string().uuid()),
  awaitingApprovalNodeIds: z.array(z.string().uuid()),
  taskRunCheckpointRefs: z.array(z.record(z.string(), z.unknown())),
  recoveryPlan: z.record(z.string(), z.unknown()),
  rollbackPlan: z.record(z.string(), z.unknown()),
  evidenceItemIds: z.array(z.string().uuid()).default([]),
  productionReady: z.literal(false),
  createdAt: z.string().datetime(),
});

export const RolledBackStartupMissionSchema = z.object({
  workspaceId: z.string().uuid(),
  missionId: z.string().uuid(),
  rollbackVersion: z.literal('mission-rollback.v1'),
  productionReady: z.literal(false),
  rollbackApplied: z.literal(true),
  checkpoint: MissionRuntimeCheckpointSchema,
  rolledBackNodes: z.array(ScheduledStartupMissionNodeSchema),
  missionStatus: z.enum(['scheduled_not_executing', 'blocked']),
  evidenceItemIds: z.array(z.string().uuid()).default([]),
  blockers: z.array(z.string().min(1)),
});

export type StartupLifecycleStage = z.infer<typeof StartupLifecycleStageSchema>;
export type StartupLifecycleNode = z.infer<typeof StartupLifecycleNodeSchema>;
export type StartupLifecycleEdge = z.infer<typeof StartupLifecycleEdgeSchema>;
export type CompileStartupLifecycleInput = z.infer<typeof CompileStartupLifecycleInputSchema>;
export type PersistStartupLifecycleInput = z.infer<typeof PersistStartupLifecycleInputSchema>;
export type ScheduleStartupMissionInput = z.infer<typeof ScheduleStartupMissionInputSchema>;
export type ExecuteStartupMissionNodeInput = z.infer<typeof ExecuteStartupMissionNodeInputSchema>;
export type ExecuteStartupMissionInput = z.infer<typeof ExecuteStartupMissionInputSchema>;
export type CheckpointStartupMissionInput = z.infer<typeof CheckpointStartupMissionInputSchema>;
export type PlanStartupMissionRecoveryInput = z.infer<typeof PlanStartupMissionRecoveryInputSchema>;
export type ApplyStartupMissionRecoveryInput = z.infer<
  typeof ApplyStartupMissionRecoveryInputSchema
>;
export type MissionRuntimeCheckpointKind = z.infer<typeof MissionRuntimeCheckpointKindSchema>;
export type RollbackStartupMissionInput = z.infer<typeof RollbackStartupMissionInputSchema>;
export type CompiledStartupLifecycleMission = z.infer<typeof CompiledStartupLifecycleMissionSchema>;
export type PersistedStartupLifecycleMission = z.infer<
  typeof PersistedStartupLifecycleMissionSchema
>;
export type ScheduledStartupMissionNode = z.infer<typeof ScheduledStartupMissionNodeSchema>;
export type ScheduledStartupMission = z.infer<typeof ScheduledStartupMissionSchema>;
export type ExecutedStartupMissionNode = z.infer<typeof ExecutedStartupMissionNodeSchema>;
export type ExecutedStartupMission = z.infer<typeof ExecutedStartupMissionSchema>;
export type CheckpointedStartupMission = z.infer<typeof CheckpointedStartupMissionSchema>;
export type PlannedStartupMissionRecovery = z.infer<typeof PlannedStartupMissionRecoverySchema>;
export type AppliedStartupMissionRecovery = z.infer<typeof AppliedStartupMissionRecoverySchema>;
export type MissionRuntimeCheckpoint = z.infer<typeof MissionRuntimeCheckpointSchema>;
export type RolledBackStartupMission = z.infer<typeof RolledBackStartupMissionSchema>;

const startupLifecycleTemplates: readonly StartupLifecycleNode[] = [
  {
    id: 'founder_onboarding',
    stage: 'founder_onboarding',
    title: 'Founder DNA and access charter',
    objective:
      'Convert the founder goal, constraints, budget, risk posture, assets, and delegated access into canonical operating context.',
    dependsOn: [],
    requiredAgents: ['Founder Strategy Agent', 'HELM DNA Agent', 'HELM Policy Agent'],
    requiredSkills: [
      'founder_dna_generation',
      'access_charter_generation',
      'risk_tolerance_mapping',
    ],
    requiredTools: ['capability_registry', 'helm_document_store', 'permission_graph_writer'],
    requiredEvidence: ['founder goal intake', 'constraint list', 'access grant receipt'],
    helmPolicyClasses: ['access', 'data_handling', 'escalation', 'audit'],
    escalationConditions: [
      'Founder goal is ambiguous enough to change venture direction',
      'Jurisdiction, budget, or risk tolerance is missing',
    ],
    acceptanceCriteria: [
      'Founder DNA draft exists',
      'Autonomy Consent Manifest draft exists',
      'Unknown access boundaries are explicit blockers',
    ],
  },
  {
    id: 'ideation',
    stage: 'ideation',
    title: 'Venture hypothesis generation',
    objective:
      'Generate and score venture hypotheses against founder-market fit, urgency, monetization, distribution, feasibility, and evidence confidence.',
    dependsOn: ['founder_onboarding'],
    requiredAgents: ['Founder Strategy Agent', 'Market Research Agent', 'Critic Agent'],
    requiredSkills: ['idea_generation', 'opportunity_scoring', 'founder_market_fit_analysis'],
    requiredTools: ['score_opportunity', 'memory_search', 'research_source_collector'],
    requiredEvidence: ['scored opportunity cards', 'assumptions', 'citations'],
    helmPolicyClasses: ['tool', 'data_handling', 'audit', 'evaluation'],
    escalationConditions: ['Top opportunities are strategically incompatible with Founder DNA'],
    acceptanceCriteria: [
      'Ranked venture hypotheses exist',
      'Each score has evidence links',
      'Rejected assumptions are recorded',
    ],
  },
  {
    id: 'market_research',
    stage: 'market_research',
    title: 'Market and competitor map',
    objective:
      'Research competitors, customer pain, pricing, communities, search demand, and distribution paths with source-backed evidence.',
    dependsOn: ['ideation'],
    requiredAgents: [
      'Market Research Agent',
      'Competitive Intelligence Agent',
      'Data Extraction Agent',
    ],
    requiredSkills: ['competitive_analysis', 'review_mining', 'source_backed_research'],
    requiredTools: ['web_search', 'scrapling_ingestion', 'browser_read_extract'],
    requiredEvidence: ['source bibliography', 'competitor table', 'pain evidence'],
    helmPolicyClasses: ['research', 'browser', 'data_handling', 'audit'],
    escalationConditions: [
      'Required source is behind identity, payment, CAPTCHA, or restricted policy boundary',
    ],
    acceptanceCriteria: [
      'Market map exists',
      'Claims have citations',
      'Evidence quality is scored',
    ],
  },
  {
    id: 'pmf_discovery',
    stage: 'pmf_discovery',
    title: 'PMF discovery plan',
    objective:
      'Define ICPs, pain hypotheses, discovery questions, survey/interview paths, and signal thresholds for product-market-fit discovery.',
    dependsOn: ['market_research'],
    requiredAgents: ['PMF Agent', 'Customer Discovery Agent', 'Growth Agent'],
    requiredSkills: ['icp_definition', 'pain_hypothesis_generation', 'discovery_workflow_design'],
    requiredTools: ['contact_list_builder', 'survey_draft_generator', 'analytics_event_planner'],
    requiredEvidence: ['ICP rationale', 'pain hypotheses', 'discovery script'],
    helmPolicyClasses: ['external_communication', 'privacy', 'data_handling', 'audit'],
    escalationConditions: [
      'Any outreach send, public post, or personal-data enrichment exceeds HELM external communication policy',
    ],
    acceptanceCriteria: [
      'ICP definition exists',
      'Signal thresholds exist',
      'Outreach drafts are queued rather than sent unless policy allows',
    ],
  },
  {
    id: 'product_definition',
    stage: 'product_definition',
    title: 'MVP definition and product DNA',
    objective:
      'Convert PMF hypotheses into MVP scope, user flows, success metrics, analytics events, and Product DNA.',
    dependsOn: ['pmf_discovery'],
    requiredAgents: ['Product Manager Agent', 'UX Research Agent', 'Analytics Agent'],
    requiredSkills: ['prd_generation', 'mvp_scoping', 'analytics_planning'],
    requiredTools: ['artifact_writer', 'memory_writer', 'analytics_schema_generator'],
    requiredEvidence: ['PRD artifact', 'MVP scope', 'analytics event plan'],
    helmPolicyClasses: ['product', 'data_handling', 'audit', 'evaluation'],
    escalationConditions: ['MVP direction conflicts with Venture DNA or budget caps'],
    acceptanceCriteria: [
      'Product DNA is drafted',
      'MVP is scoped to test PMF hypotheses',
      'Metrics map to lifecycle goals',
    ],
  },
  {
    id: 'brand_domain_planning',
    stage: 'brand_domain_planning',
    title: 'Brand, positioning, and domain plan',
    objective:
      'Create positioning, naming options, landing copy, brand direction, and domain/DNS plan.',
    dependsOn: ['product_definition'],
    requiredAgents: ['Content Agent', 'UI Designer Agent', 'Growth Agent'],
    requiredSkills: ['positioning', 'landing_copy_generation', 'domain_research'],
    requiredTools: ['domain_availability_check', 'artifact_writer', 'design_asset_generator'],
    requiredEvidence: ['positioning rationale', 'domain availability evidence', 'brand artifact'],
    helmPolicyClasses: ['public_publishing', 'financial', 'external_visibility', 'audit'],
    escalationConditions: [
      'Domain purchase, trademark-sensitive name, or public publishing exceeds policy caps',
    ],
    acceptanceCriteria: [
      'Positioning artifact exists',
      'Domain recommendation includes policy gate',
      'Public copy is reviewable',
    ],
  },
  {
    id: 'engineering',
    stage: 'engineering',
    title: 'Product build plan',
    objective:
      'Generate architecture, repository plan, implementation tasks, tests, security checks, and rollback strategy.',
    dependsOn: ['product_definition', 'brand_domain_planning'],
    requiredAgents: [
      'Full-Stack Engineer Agent',
      'Frontend Engineer Agent',
      'Backend Engineer Agent',
      'QA Agent',
      'Security Agent',
    ],
    requiredSkills: [
      'architecture_generation',
      'frontend_implementation',
      'backend_implementation',
      'test_planning',
    ],
    requiredTools: ['github_repo_tool', 'computer_safe_execute', 'artifact_writer', 'tool_broker'],
    requiredEvidence: ['architecture artifact', 'test plan', 'security review checklist'],
    helmPolicyClasses: ['code', 'deployment', 'secrets', 'audit'],
    escalationConditions: [
      'Secret creation, production deployment, or destructive repo action exceeds deployment policy',
    ],
    acceptanceCriteria: [
      'Build plan exists',
      'Tests and rollback are specified',
      'Secrets are referenced by vault refs only',
    ],
  },
  {
    id: 'infrastructure_deployment',
    stage: 'infrastructure_deployment',
    title: 'Infrastructure and deployment plan',
    objective:
      'Prepare hosting, database, DNS, analytics, monitoring, backup, and rollback operations.',
    dependsOn: ['engineering'],
    requiredAgents: ['DevOps Agent', 'Database Agent', 'Security Agent'],
    requiredSkills: ['hosting_setup', 'dns_setup', 'monitoring_setup', 'rollback_planning'],
    requiredTools: [
      'vercel_connector',
      'cloudflare_connector',
      'posthog_connector',
      'computer_safe_execute',
    ],
    requiredEvidence: ['deployment checklist', 'DNS plan', 'monitoring plan'],
    helmPolicyClasses: ['deployment', 'financial', 'secrets', 'audit'],
    escalationConditions: [
      'DNS mutation, paid hosting, production deploy, or secret rotation exceeds policy limits',
    ],
    acceptanceCriteria: [
      'Deployment path is policy gated',
      'Monitoring and rollback criteria exist',
      'No irreversible infra change is auto-executed without HELM allow',
    ],
  },
  {
    id: 'stripe_setup_prep',
    stage: 'stripe_setup_prep',
    title: 'Stripe setup preparation',
    objective:
      'Prepare payment model, Stripe setup fields, products/prices, webhook plan, and human-required identity or financial steps.',
    dependsOn: ['product_definition', 'infrastructure_deployment'],
    requiredAgents: ['Finance Agent', 'Backend Engineer Agent', 'Legal Workflow Agent'],
    requiredSkills: ['payment_setup_planning', 'pricing_hypothesis', 'webhook_design'],
    requiredTools: ['stripe_connector', 'artifact_writer', 'browser_read_extract'],
    requiredEvidence: ['pricing rationale', 'Stripe setup checklist', 'human gate list'],
    helmPolicyClasses: ['financial', 'legal', 'credential_handling', 'audit'],
    escalationConditions: [
      'Identity verification, bank information, charges, payouts, or legal attestations are required',
    ],
    acceptanceCriteria: [
      'Stripe prep artifact exists',
      'Human-required steps are isolated',
      'No raw credentials or financial secrets are stored',
    ],
  },
  {
    id: 'company_formation_prep',
    stage: 'company_formation_prep',
    title: 'Company formation preparation',
    objective:
      'Research formation options, prepare incorporation packet fields, legal document drafts, and required human confirmation points.',
    dependsOn: ['founder_onboarding', 'product_definition'],
    requiredAgents: ['Legal Workflow Agent', 'Incorporation Agent', 'Finance Agent'],
    requiredSkills: [
      'formation_option_research',
      'legal_document_generation',
      'human_gate_classification',
    ],
    requiredTools: ['stripe_atlas_browser_workflow', 'clerky_browser_workflow', 'artifact_writer'],
    requiredEvidence: [
      'formation comparison',
      'draft incorporation packet',
      'required signature list',
    ],
    helmPolicyClasses: ['legal', 'financial', 'browser', 'audit'],
    escalationConditions: [
      'Signature, legal attestation, government filing, payment, or identity verification is required',
    ],
    acceptanceCriteria: [
      'Formation prep is complete up to human gates',
      'Policy blocks irreversible legal filing unless explicitly allowed',
      'Documents are versioned artifacts',
    ],
  },
  {
    id: 'growth_experiments',
    stage: 'growth_experiments',
    title: 'Growth experiment backlog',
    objective:
      'Create evidence-backed growth experiments across landing page, SEO, content, social, outreach, and analytics loops.',
    dependsOn: ['market_research', 'brand_domain_planning', 'infrastructure_deployment'],
    requiredAgents: ['Growth Agent', 'SEO Agent', 'Content Agent', 'Analytics Agent'],
    requiredSkills: ['experiment_design', 'seo_research', 'conversion_optimization'],
    requiredTools: ['analytics_connector', 'content_calendar_writer', 'artifact_writer'],
    requiredEvidence: ['experiment hypotheses', 'channel evidence', 'success metrics'],
    helmPolicyClasses: ['external_communication', 'public_publishing', 'privacy', 'audit'],
    escalationConditions: [
      'Public post, ad spend, cold outreach send, or personal-data use exceeds policy limits',
    ],
    acceptanceCriteria: [
      'Experiment backlog exists',
      'Each experiment has metric and rollback criteria',
      'Launch actions are queued behind policy gates',
    ],
  },
  {
    id: 'sales_outreach_drafts',
    stage: 'sales_outreach_drafts',
    title: 'Sales and outreach drafts',
    objective:
      'Build target account hypotheses, outreach sequences, objection handling, and CRM update plan without sending restricted communications.',
    dependsOn: ['pmf_discovery', 'growth_experiments'],
    requiredAgents: ['Sales Agent', 'Outreach Agent', 'Customer Discovery Agent'],
    requiredSkills: ['lead_list_generation', 'outreach_sequence_drafting', 'objection_handling'],
    requiredTools: ['crm_connector', 'email_draft_tool', 'artifact_writer'],
    requiredEvidence: ['lead source evidence', 'draft sequence', 'policy review state'],
    helmPolicyClasses: ['external_communication', 'privacy', 'data_sharing', 'audit'],
    escalationConditions: [
      'Sending email/messages, scraping gated personal data, or updating external CRM exceeds HELM policy',
    ],
    acceptanceCriteria: [
      'Outreach drafts exist',
      'Lead provenance is recorded',
      'Sends are blocked or queued unless policy explicitly allows',
    ],
  },
  {
    id: 'fundraising_packet',
    stage: 'fundraising_packet',
    title: 'Fundraising packet',
    objective:
      'Prepare investor thesis, pitch narrative, data room checklist, traction evidence, and investor outreach drafts.',
    dependsOn: ['product_definition', 'growth_experiments', 'operations_recovery'],
    requiredAgents: ['Fundraising Agent', 'Finance Agent', 'Content Agent'],
    requiredSkills: ['pitch_deck_creation', 'investor_research', 'metrics_storytelling'],
    requiredTools: ['artifact_writer', 'investor_list_builder', 'drive_docs_connector'],
    requiredEvidence: ['traction summary', 'investor list sources', 'deck outline'],
    helmPolicyClasses: ['external_communication', 'data_sharing', 'financial', 'audit'],
    escalationConditions: ['Investor outreach send or sensitive data-room sharing exceeds policy'],
    acceptanceCriteria: [
      'Pitch packet draft exists',
      'Sensitive metrics are classified',
      'Investor communication is queued behind policy gates',
    ],
  },
  {
    id: 'operations_recovery',
    stage: 'operations_recovery',
    title: 'Operations, monitoring, and recovery',
    objective:
      'Define product health monitoring, incident response, cost review, feedback triage, recurring reporting, and DNA/phenotype update loops.',
    dependsOn: ['infrastructure_deployment'],
    requiredAgents: [
      'Operations Agent',
      'Recovery Agent',
      'Analytics Agent',
      'HELM Phenotype Agent',
    ],
    requiredSkills: ['incident_recovery', 'operational_reporting', 'phenotype_update'],
    requiredTools: ['observability_connector', 'audit_ledger_reader', 'artifact_writer'],
    requiredEvidence: ['incident checklist', 'operational report template', 'phenotype update log'],
    helmPolicyClasses: ['deployment', 'financial', 'audit', 'evaluation'],
    escalationConditions: [
      'Incident remediation requires destructive action, production rollback, spending, or public communication',
    ],
    acceptanceCriteria: [
      'Recovery plan exists',
      'Operational report template exists',
      'Phenotype update triggers are defined',
    ],
  },
];

export function getStartupLifecycleTemplates(): readonly StartupLifecycleNode[] {
  return startupLifecycleTemplates;
}

export function compileStartupLifecycleMission(
  input: CompileStartupLifecycleInput,
): CompiledStartupLifecycleMission {
  const parsed = CompileStartupLifecycleInputSchema.parse(input);
  const nodes = startupLifecycleTemplates.map((node) => ({ ...node }));
  const edges = nodes.flatMap((node) =>
    node.dependsOn.map((dependency) => ({
      id: `${dependency}->${node.id}`,
      from: dependency,
      to: node.id,
      reason: `${node.title} depends on ${dependency.replace(/_/g, ' ')}`,
    })),
  );

  return CompiledStartupLifecycleMissionSchema.parse({
    workspaceId: parsed.workspaceId,
    generatedAt: new Date().toISOString(),
    compilerVersion: 'startup-lifecycle.v1',
    capabilityState: 'prototype',
    productionReady: false,
    mission: {
      id: `startup_lifecycle_${hashString(`${parsed.workspaceId}:${parsed.founderGoal}`)}`,
      title: 'Governed startup lifecycle mission draft',
      status: 'compiled_not_persisted',
      founderGoal: parsed.founderGoal,
      autonomyMode: parsed.autonomyMode,
      ventureContext: parsed.ventureContext,
      constraints: parsed.constraints,
      nodes,
      edges,
      assumptions: [
        'This compiler creates an execution plan only; it does not start autonomous execution.',
        'Legal, financial, deployment, public publishing, and external communication actions remain policy-gated.',
        'Mission runtime persistence and startup launch eval promotion are still required before production-ready claims.',
      ],
      blockers: [
        'Mission DAG is not persisted as the runtime backbone yet',
        'Lifecycle nodes are not bound to durable venture/mission/action records yet',
        'Full Startup Launch Eval has not promoted startup_lifecycle to production_ready',
      ],
    },
  });
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
