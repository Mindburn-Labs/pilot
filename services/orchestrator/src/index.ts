import PgBoss from 'pg-boss';
import { type Db } from '@pilot/db/client';
import { type LlmProvider } from '@pilot/shared/llm';
import { type TenantLlmResolver } from '@pilot/shared/llm/tenant-resolver';
import { type PolicyConfig } from '@pilot/shared/schemas';
import { type MemoryService } from '@pilot/memory';
import { type HelmClient } from '@pilot/helm-client';
import { type OAuthFlowManager, type RefreshNotifier } from '@pilot/connectors';
import { type SubagentRegistry } from '@pilot/shared/subagents';
import { type SkillRegistry } from '@pilot/shared/skills';
import { type McpServerRegistry } from '@pilot/shared/mcp';
import { TrustBoundary } from './trust.js';
import { AgentLoop } from './agent-loop.js';
import { ToolRegistry } from './tools.js';
import { Conductor, type ParentContext } from './conductor.js';
import { registerJobHandlers } from './jobs.js';

export interface OrchestratorConfig {
  db: Db;
  policy: PolicyConfig;
  llm?: LlmProvider;
  memory?: MemoryService;
  boss?: PgBoss;
  /**
   * HELM client. When present the orchestrator emits governance receipts and
   * can be surfaced via the gateway's /api/governance routes. The LLM provider
   * passed in should be wired to this client (see HelmLlmProvider in
   * @pilot/helm-client) so every inference call goes through HELM.
   */
  helmClient?: HelmClient;
  /**
   * Per-workspace LLM resolver (Phase 2b). When present the orchestrator
   * swaps to the founder's own key at run time; the constructor-provided
   * `llm` becomes the fallback for workspaces that have not configured a
   * BYO key. Undefined preserves legacy single-provider behaviour.
   */
  llmResolver?: TenantLlmResolver;
  /**
   * Phase 12 — governed subagent registry loaded from packs/subagents/*.md.
   * When present the orchestrator wires a Conductor and exposes
   * `runConduct()` + registers `subagent.spawn`/`subagent.parallel` tools.
   * When absent the main orchestrator path is unchanged.
   */
  subagentRegistry?: SubagentRegistry;
  /**
   * Gate 3 — runtime skill registry loaded from packs/skills and user
   * overrides. When present, Conductor validates and activates skills for
   * subagent runs.
   */
  skillRegistry?: SkillRegistry;
  /**
   * Phase 13 (Track B) — OAuth flow manager. When present the background
   * refresh worker is registered; connector tokens get proactively renewed
   * when they're <30 minutes from expiry, and the re-auth banner is
   * surfaced after 3 consecutive permanent failures.
   */
  oauth?: OAuthFlowManager;
  /**
   * Phase 13 (Track B) — notifier for permanent refresh failures. Typically
   * wired to Telegram bot's `NotificationService.requestReauth`.
   */
  refreshNotifier?: RefreshNotifier;
  /**
   * Phase 14 (Track A) — upstream MCP server registry. When present the
   * Conductor threads it into every subagent spawn so tools declared in
   * `mcp_servers:` frontmatter are resolved + injected into the scoped
   * tool registry. Absent → MCP tooling is disabled (built-ins only).
   */
  mcpRegistry?: McpServerRegistry;
}

/**
 * Orchestrator service — the brain of Pilot.
 *
 * Responsibilities:
 * - Agent loop with iteration budget (Hermes pattern)
 * - Task delegation to operators
 * - Trust boundary enforcement (fail-closed, ported from pretooluse.py)
 * - Approval flows for dangerous actions
 * - Session lifecycle (start, run, teardown with reflection)
 * - Background job dispatch via pg-boss
 */
export class Orchestrator {
  readonly trust: TrustBoundary;
  readonly agentLoop: AgentLoop;
  readonly tools: ToolRegistry;
  readonly db: Db;
  readonly boss?: PgBoss;
  readonly helmClient?: HelmClient;
  readonly llmResolver?: TenantLlmResolver;
  readonly conductor?: Conductor;
  private readonly basePolicy: PolicyConfig;
  private readonly fallbackLlm: LlmProvider | undefined;

  constructor(config: OrchestratorConfig) {
    this.db = config.db;
    this.boss = config.boss;
    this.helmClient = config.helmClient;
    this.llmResolver = config.llmResolver;
    this.fallbackLlm = config.llm;
    this.basePolicy = config.policy;
    this.trust = new TrustBoundary(config.policy);
    this.tools = new ToolRegistry(config.db, config.memory, {
      helmClient: config.helmClient,
      skillRegistry: config.skillRegistry,
    });
    this.agentLoop = new AgentLoop(config.db, this.trust, config.helmClient);

    // Wire LLM + tools into agent loop if available. This is the baseline
    // provider used when no per-tenant resolver returns a hit; resolvers
    // override it per-run via this.swapLlm(workspaceId) below.
    if (config.llm) {
      this.agentLoop.setLlm(config.llm);
    }
    this.agentLoop.setTools(this.tools);

    // Phase 12 — wire the Conductor when a registry is provided.
    if (config.subagentRegistry && config.llm) {
      this.conductor = new Conductor(
        config.db,
        config.subagentRegistry,
        this.tools,
        config.policy,
        config.llm,
        config.helmClient,
        config.skillRegistry,
        config.mcpRegistry,
      );
      this.tools.setConductor(this.conductor);
    }

    // Register background job handlers (async — fire and forget with error log)
    if (config.boss) {
      registerJobHandlers(config.boss, {
        db: config.db,
        memory: config.memory,
        llm: config.llm,
        orchestrator: this,
        oauth: config.oauth,
        refreshNotifier: config.refreshNotifier,
      }).catch((err) => {
        // Non-fatal: schedule errors are logged inside registerJobHandlers;
        // anything reaching here is unexpected.
        console.error('registerJobHandlers failed:', err);
      });
    }
  }

  /**
   * Run a task through the agent loop.
   *
   * Enriches params with:
   * - Workspace's current mode (for tool filtering)
   * - Operator's system prompt + goal (for personality)
   */
  async runTask(params: {
    taskId: string;
    workspaceId: string;
    ventureId?: string;
    missionId?: string;
    operatorId?: string;
    context: string;
    iterationBudget?: number;
  }) {
    const runtime = await this.resolveRuntime(
      params.workspaceId,
      params.operatorId,
      params.iterationBudget,
    );
    this.trust.setPolicy(runtime.policy);
    await this.swapLlm(params.workspaceId);

    return this.agentLoop.execute({
      ...params,
      iterationBudget: runtime.iterationBudget,
      mode: runtime.mode,
      systemPrompt: runtime.systemPrompt,
      operatorGoal: runtime.operatorGoal,
    });
  }

  /**
   * Phase 12 — run an agent loop with the Conductor live, so the LLM can
   * call `subagent.spawn` / `subagent.parallel`. Identical shape to
   * runTask(); the only difference is that parent context is threaded
   * into the ToolRegistry for the duration of the run so the conductor
   * tools know which workspace / task / budget they're operating against.
   *
   * If no Conductor is configured this falls back to runTask() and the
   * LLM's spawn calls will return an error via the tool.
   */
  async runConduct(params: {
    taskId: string;
    workspaceId: string;
    ventureId?: string;
    missionId?: string;
    operatorId?: string;
    context: string;
    iterationBudget?: number;
  }) {
    if (!this.conductor) {
      return this.runTask(params);
    }

    const runtime = await this.resolveRuntime(
      params.workspaceId,
      params.operatorId,
      params.iterationBudget,
    );
    this.trust.setPolicy(runtime.policy);
    await this.swapLlm(params.workspaceId);

    const parentCtx: ParentContext = {
      workspaceId: params.workspaceId,
      taskId: params.taskId,
      parentTaskRunId: null,
      operatorRole: runtime.systemPrompt ? 'operator' : 'conductor',
      policyVersion: 'founder-ops-v1',
      remainingBudgetUsd: runtime.policy.budget.perTaskMax,
      mode: runtime.mode,
      ...(params.ventureId ? { ventureId: params.ventureId } : {}),
      ...(params.missionId ? { missionId: params.missionId } : {}),
    };
    this.tools.setParentContext(parentCtx);
    try {
      return await this.agentLoop.execute({
        ...params,
        iterationBudget: runtime.iterationBudget,
        mode: runtime.mode,
        systemPrompt: runtime.systemPrompt,
        operatorGoal: runtime.operatorGoal,
      });
    } finally {
      this.tools.setParentContext(null);
    }
  }

  async resumeTask(params: {
    taskId: string;
    workspaceId: string;
    ventureId?: string;
    missionId?: string;
    operatorId?: string;
    context: string;
    iterationBudget?: number;
    priorActions: import('./agent-loop.js').ActionRecord[];
  }) {
    const runtime = await this.resolveRuntime(
      params.workspaceId,
      params.operatorId,
      params.iterationBudget,
    );
    this.trust.setPolicy(runtime.policy);
    await this.swapLlm(params.workspaceId);

    return this.agentLoop.resume({
      ...params,
      iterationBudget: runtime.iterationBudget,
      mode: runtime.mode,
      systemPrompt: runtime.systemPrompt,
      operatorGoal: runtime.operatorGoal,
    });
  }

  /**
   * Per-run LLM swap (Phase 2b). When an llmResolver is configured we swap
   * the AgentLoop's provider to whatever the workspace has — either its
   * BYO-key provider or the platform fallback the resolver was built with.
   * When no resolver exists this is a no-op and the constructor-provided
   * fallback LLM is used.
   */
  private async swapLlm(workspaceId: string): Promise<void> {
    if (!this.llmResolver) return;
    const provider = await this.llmResolver.resolve(workspaceId);
    if (provider) {
      this.agentLoop.setLlm(provider);
    } else if (this.fallbackLlm) {
      this.agentLoop.setLlm(this.fallbackLlm);
    }
  }

  private async resolveRuntime(
    workspaceId: string,
    operatorId?: string,
    requestedIterationBudget?: number,
  ) {
    const { workspaces, workspaceSettings, operators, operatorRoles, operatorConfigs } =
      await import('@pilot/db/schema');
    const { and, eq } = await import('drizzle-orm');

    // Look up workspace mode
    let mode: string | undefined;
    let runtimePolicy: PolicyConfig = structuredClone(this.basePolicy);
    let workspaceIterationBudget: number | undefined;
    const [ws] = await this.db
      .select({ currentMode: workspaces.currentMode })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (ws) mode = ws.currentMode;

    const [settings] = await this.db
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId))
      .limit(1);

    if (settings) {
      const policyConfig = (settings.policyConfig ?? {}) as Record<string, unknown>;
      const budgetConfig = (settings.budgetConfig ?? {}) as Record<string, unknown>;

      runtimePolicy = {
        ...runtimePolicy,
        killSwitch:
          typeof policyConfig['killSwitch'] === 'boolean'
            ? policyConfig['killSwitch']
            : runtimePolicy.killSwitch,
        toolBlocklist: Array.isArray(policyConfig['toolBlocklist'])
          ? policyConfig['toolBlocklist'].map(String)
          : Array.isArray(policyConfig['blockedTools'])
            ? policyConfig['blockedTools'].map(String)
            : runtimePolicy.toolBlocklist,
        contentBans: Array.isArray(policyConfig['contentBans'])
          ? policyConfig['contentBans'].map(String)
          : runtimePolicy.contentBans,
        connectorAllowlist: Array.isArray(policyConfig['connectorAllowlist'])
          ? policyConfig['connectorAllowlist'].map(String)
          : runtimePolicy.connectorAllowlist,
        requireApprovalFor: Array.isArray(policyConfig['requireApprovalFor'])
          ? policyConfig['requireApprovalFor'].map(String)
          : runtimePolicy.requireApprovalFor,
        failClosed:
          typeof policyConfig['failClosed'] === 'boolean'
            ? policyConfig['failClosed']
            : runtimePolicy.failClosed,
        budget: {
          ...runtimePolicy.budget,
          dailyTotalMax:
            toFiniteNumber(budgetConfig['dailyTotalMax']) ?? runtimePolicy.budget.dailyTotalMax,
          perTaskMax: toFiniteNumber(budgetConfig['perTaskMax']) ?? runtimePolicy.budget.perTaskMax,
          perOperatorMax:
            toFiniteNumber(budgetConfig['perOperatorMax']) ?? runtimePolicy.budget.perOperatorMax,
          emergencyKill:
            toFiniteNumber(budgetConfig['emergencyKill']) ?? runtimePolicy.budget.emergencyKill,
          currency:
            typeof budgetConfig['currency'] === 'string'
              ? budgetConfig['currency']
              : runtimePolicy.budget.currency,
        },
      };

      workspaceIterationBudget = toFiniteNumber(policyConfig['maxIterationBudget']) ?? undefined;
    }

    // Look up operator system prompt + goal
    let systemPrompt: string | undefined;
    let operatorGoal: string | undefined;
    let operatorIterationBudget: number | undefined;
    if (operatorId) {
      const [op] = await this.db
        .select()
        .from(operators)
        .where(and(eq(operators.id, operatorId), eq(operators.workspaceId, workspaceId)))
        .limit(1);
      if (!op) {
        throw new Error('operatorId does not belong to workspace');
      }
      operatorGoal = op.goal;
      // Look up the role definition for the system prompt
      const [role] = await this.db
        .select()
        .from(operatorRoles)
        .where(eq(operatorRoles.name, op.role))
        .limit(1);
      if (role?.systemPrompt) systemPrompt = role.systemPrompt;

      const [config] = await this.db
        .select()
        .from(operatorConfigs)
        .where(eq(operatorConfigs.operatorId, op.id))
        .limit(1);
      const rawMaxIterations = (
        config?.iterationBudget as Record<string, unknown> | null | undefined
      )?.['maxIterations'];
      operatorIterationBudget = toFiniteNumber(rawMaxIterations) ?? undefined;
    }

    const iterationBudget = clampIterationBudget(
      requestedIterationBudget,
      operatorIterationBudget,
      workspaceIterationBudget,
    );

    return {
      policy: runtimePolicy,
      iterationBudget,
      mode,
      systemPrompt,
      operatorGoal,
    };
  }
}

export { TrustBoundary } from './trust.js';
export { AgentLoop } from './agent-loop.js';
export { ToolRegistry } from './tools.js';
export { Conductor, type ParentContext } from './conductor.js';
export { SubagentLoop } from './subagent-loop.js';
export {
  conductStream,
  emitConductEvent,
  ConductEventStream,
  type ConductEvent,
  type ConductEventType,
} from './conduct-stream.js';
export {
  PolicyReloader,
  type PolicySnapshot,
} from './policy-reload.js';
export {
  AmbientEventListener,
  DEFAULT_EVENT_CONFIG,
  type AmbientEvent,
  type EventHandler,
  type EventListenerConfig,
} from './event-listener.js';

function toFiniteNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

function clampIterationBudget(...values: Array<number | undefined>) {
  const defined = values.filter((value): value is number => typeof value === 'number' && value > 0);
  if (defined.length === 0) return 50;
  return Math.min(...defined);
}
