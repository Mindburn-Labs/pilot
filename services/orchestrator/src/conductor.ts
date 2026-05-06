import { createHash, randomUUID } from 'node:crypto';
import { appendEvidenceItem } from '@pilot/db';
import { type Db } from '@pilot/db/client';
import { type LlmProvider } from '@pilot/shared/llm';
import { type PolicyConfig } from '@pilot/shared/schemas';
import {
  SubagentRegistry,
  type SubagentDefinition,
  type SubagentRunResult,
} from '@pilot/shared/subagents';
import { type SkillMatch, type SkillRegistry } from '@pilot/shared/skills';
import { type McpServerRegistry } from '@pilot/shared/mcp';
import { type HelmClient } from '@pilot/helm-client';
import { validateL1 } from '@pilot/shared/conformance';
import { createLogger } from '@pilot/shared/logger';
import { type SubagentFrame } from './agent-loop.js';
import { type ToolRegistry } from './tools.js';
import { ToolBroker } from './tool-broker.js';
import { SubagentLoop } from './subagent-loop.js';
import { emitConductEvent } from './conduct-stream.js';

const l1Log = createLogger('conductor-l1');

type SpawnFrame = SubagentFrame & { handoffId: string | null };

interface SkillInvocationAudit {
  name: string;
  version: string;
  activationReason: SkillMatch['reason'];
  score: number;
  riskProfile: string;
  permissionRequirements: string[];
  evalStatus: string;
  declaredTools: string[];
  sourcePath: string;
  instructionHash?: string;
  brokeredInvocation?: {
    actionId: string;
    toolExecutionId: string;
    evidenceItemId: string;
    status: 'completed' | 'failed';
    inputHash: string;
    outputHash: string;
    policyDecisionId?: string;
    policyVersion?: string;
  };
}

/**
 * Conductor — orchestrates governed subagent delegations.
 *
 * Exposed as two tools the parent LLM can call:
 *   - `subagent.spawn`    → delegate one sub-task to one subagent
 *   - `subagent.parallel` → dispatch up to 6 subagents concurrently
 *
 * Every spawn:
 *   1. Resolves the subagent definition from the registry (exact by name,
 *      fallback to description match).
 *   2. Writes a local `evidence_packs` row with `action='SUBAGENT_SPAWN'`
 *      anchored to the most recent parent LLM_INFERENCE pack — this row
 *      is the DAG root for every child receipt under the same subagent.
 *   3. Writes a `task_runs` marker row representing the subagent's run
 *      itself (not an iteration within it). Returns its id as the parent
 *      task run id threaded into the SubagentFrame.
 *   4. Allocates a budget slice (weighted with a 5% floor per plan decision
 *      #5) and composes a per-invocation principal suffix so concurrent
 *      spawns of the same subagent resolve to distinct HELM principals.
 *   5. Delegates execution to SubagentLoop.
 *
 * Subagent execution is governed by the child AgentLoop's HELM evaluate calls.
 * The parent SUBAGENT_SPAWN mirror row remains the DAG root for child receipts.
 */
export class Conductor {
  constructor(
    private readonly db: Db,
    private readonly registry: SubagentRegistry,
    private readonly parentTools: ToolRegistry,
    private readonly parentPolicy: PolicyConfig,
    private readonly llm: LlmProvider,
    private readonly helmClient?: HelmClient,
    private readonly skillRegistry?: SkillRegistry,
    /**
     * Phase 14 Track A — optional MCP server registry. When supplied,
     * each subagent spawn propagates it into SubagentLoop so upstream
     * MCP tools declared in `def.mcpServers` are resolved + injected
     * into the child's scoped tool registry.
     */
    private readonly mcpRegistry?: McpServerRegistry,
  ) {
    this.parentTools.setSkillRegistry(this.skillRegistry);
  }

  /**
   * Spawn a single subagent.
   *
   * @param parentCtx  Parent's workspace, taskId, parent task run id,
   *                   operator role, and remaining-budget-USD for this slot.
   */
  async spawn(parentCtx: ParentContext, req: SpawnRequest): Promise<SubagentRunResult> {
    const def = this.resolveDefinition(req.name);
    if (!def) {
      return this.failNotFound(req.name, parentCtx);
    }

    const allocation = this.allocateBudget(parentCtx.remainingBudgetUsd, [
      { weight: req.budgetWeight ?? def.budgetWeight, def },
    ]);
    const allocated = allocation[0]?.allocatedUsd ?? 0;
    const skills = this.resolveSkills(def, req.task, parentCtx);
    if ('errorResult' in skills) return skills.errorResult;

    const frame = await this.beginSpawnOrFail({
      parentCtx,
      def,
      allocatedUsd: allocated,
      task: req.task,
      skills: skills.matches,
    });
    if ('errorResult' in frame) return frame.errorResult;

    const loop = new SubagentLoop(
      this.db,
      this.parentTools,
      this.parentPolicy,
      this.llm,
      this.helmClient,
      this.skillRegistry,
      this.mcpRegistry,
    );
    emitConductEvent({
      type: 'subagent.spawned',
      taskId: parentCtx.taskId,
      payload: { name: def.name, task: req.task, budgetUsd: allocated },
    });
    const result = await loop.run({
      def,
      input: req.task,
      frame,
      skillMatches: skills.matches,
      workspaceId: parentCtx.workspaceId,
      taskId: parentCtx.taskId,
      mode: parentCtx.mode,
    });
    await this.completeHandoff(frame.handoffId, result);
    emitConductEvent({
      type: 'subagent.completed',
      taskId: parentCtx.taskId,
      payload: {
        name: result.name,
        verdict: result.verdict,
        costUsd: result.costUsd,
        iterationsUsed: result.iterationsUsed,
      },
    });
    return result;
  }

  /**
   * Dispatch multiple subagents concurrently.
   * Budget is allocated weighted across all spawns (5% floor per child).
   */
  async parallel(parentCtx: ParentContext, reqs: SpawnRequest[]): Promise<SubagentRunResult[]> {
    const resolved = reqs.map((req) => ({
      req,
      def: this.resolveDefinition(req.name),
    }));

    const missing = resolved.filter((r) => !r.def);
    if (missing.length > 0) {
      // Fail the whole batch rather than mix resolved + unresolved — the
      // parent LLM should get a crisp error it can react to.
      return missing.map((m) => this.failNotFound(m.req.name, parentCtx));
    }

    const allocs = this.allocateBudget(
      parentCtx.remainingBudgetUsd,
      resolved.map((r) => ({
        weight: r.req.budgetWeight ?? r.def!.budgetWeight,
        def: r.def!,
      })),
    );

    const runs = resolved.map(async (r, i) => {
      const allocated = allocs[i]?.allocatedUsd ?? 0;
      const skills = this.resolveSkills(r.def!, r.req.task, parentCtx);
      if ('errorResult' in skills) return skills.errorResult;
      const frame = await this.beginSpawnOrFail({
        parentCtx,
        def: r.def!,
        allocatedUsd: allocated,
        task: r.req.task,
        skills: skills.matches,
      });
      if ('errorResult' in frame) return frame.errorResult;
      const loop = new SubagentLoop(
        this.db,
        this.parentTools,
        this.parentPolicy,
        this.llm,
        this.helmClient,
        this.skillRegistry,
        this.mcpRegistry,
      );
      emitConductEvent({
        type: 'subagent.spawned',
        taskId: parentCtx.taskId,
        payload: { name: r.def!.name, task: r.req.task, budgetUsd: allocated },
      });
      const childResult = await loop.run({
        def: r.def!,
        input: r.req.task,
        frame,
        skillMatches: skills.matches,
        workspaceId: parentCtx.workspaceId,
        taskId: parentCtx.taskId,
        mode: parentCtx.mode,
      });
      await this.completeHandoff(frame.handoffId, childResult);
      emitConductEvent({
        type: 'subagent.completed',
        taskId: parentCtx.taskId,
        payload: {
          name: childResult.name,
          verdict: childResult.verdict,
          costUsd: childResult.costUsd,
          iterationsUsed: childResult.iterationsUsed,
        },
      });
      return childResult;
    });

    return Promise.all(runs);
  }

  list(): SubagentDefinition[] {
    return this.registry.list();
  }

  // ─── internals ───

  private resolveDefinition(ref: string): SubagentDefinition | undefined {
    return this.registry.findByName(ref) ?? this.registry.findByDescription(ref);
  }

  private resolveSkills(
    def: SubagentDefinition,
    task: string,
    parentCtx: ParentContext,
  ): { matches: SkillMatch[] } | { errorResult: SubagentRunResult } {
    if (def.skills.length > 0 && !this.skillRegistry) {
      return {
        errorResult: this.failSkillDenied(
          def.name,
          parentCtx,
          'skill_registry_unavailable',
          `Subagent "${def.name}" declares skills but no SkillRegistry is loaded.`,
        ),
      };
    }

    if (!this.skillRegistry) return { matches: [] };

    const missing = def.skills.filter((name) => !this.skillRegistry?.findByName(name));
    if (missing.length > 0) {
      return {
        errorResult: this.failSkillDenied(
          def.name,
          parentCtx,
          'skill_not_loaded',
          `Subagent "${def.name}" declares unloaded skill(s): ${missing.join(', ')}`,
        ),
      };
    }

    const explicitSkills = new Set(def.skills);
    const allMatches = this.skillRegistry.match(task, def.skills);
    const explicitMatches = allMatches.filter((match) => match.reason === 'explicit');
    const autoMatches = allMatches
      .filter((match) => match.reason === 'auto')
      .slice(0, Math.max(0, 3 - explicitMatches.length));
    const matches = [...explicitMatches, ...autoMatches];
    const allowedTools = new Set(def.toolScope.allowedTools);
    const permittedMatches: SkillMatch[] = [];
    for (const match of matches) {
      const deniedTools = match.skill.tools.filter((tool) => !allowedTools.has(tool));
      if (deniedTools.length > 0) {
        if (!explicitSkills.has(match.skill.name)) continue;
        return {
          errorResult: this.failSkillDenied(
            def.name,
            parentCtx,
            'skill_tool_scope_denied',
            `Skill "${match.skill.name}" requires tool(s) outside ${def.name} scope: ${deniedTools.join(', ')}`,
          ),
        };
      }
      permittedMatches.push(match);
    }

    return { matches: permittedMatches };
  }

  private failSkillDenied(
    name: string,
    parentCtx: ParentContext,
    error: string,
    summary: string,
  ): SubagentRunResult {
    return {
      name,
      summary,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      iterationsUsed: 0,
      taskRunId: parentCtx.parentTaskRunId ?? '',
      spawnEvidencePackId: '',
      verdict: 'failed',
      error,
    };
  }

  private failSpawnPersistence(
    name: string,
    parentCtx: ParentContext,
    summary: string,
  ): SubagentRunResult {
    return {
      name,
      summary,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      iterationsUsed: 0,
      taskRunId: parentCtx.parentTaskRunId ?? '',
      spawnEvidencePackId: '',
      verdict: 'failed',
      error: 'subagent_persistence_failed',
    };
  }

  /**
   * Weighted split with a 5% floor per child. Normalises if the naive
   * weighted sum exceeds remaining budget — prevents the parent LLM from
   * claiming more than it has by proposing huge weights.
   */
  private allocateBudget(
    remainingUsd: number,
    items: Array<{ weight: number; def: SubagentDefinition }>,
  ): Array<{ allocatedUsd: number }> {
    const floor = Math.max(0.01, remainingUsd * 0.05);
    const totalWeight = items.reduce((s, it) => s + it.weight, 0) || 1;

    const raw = items.map((it) => Math.max(floor, (remainingUsd * it.weight) / totalWeight));
    const sum = raw.reduce((s, v) => s + v, 0);
    if (sum <= remainingUsd) {
      return raw.map((v) => ({ allocatedUsd: v }));
    }
    const scale = remainingUsd / sum;
    return raw.map((v) => ({ allocatedUsd: v * scale }));
  }

  private async beginSpawnOrFail(params: {
    parentCtx: ParentContext;
    def: SubagentDefinition;
    allocatedUsd: number;
    task: string;
    skills: SkillMatch[];
  }): Promise<SpawnFrame | { errorResult: SubagentRunResult }> {
    try {
      return await this.beginSpawn(params);
    } catch (err) {
      return {
        errorResult: this.failSpawnPersistence(
          params.def.name,
          params.parentCtx,
          err instanceof Error ? err.message : String(err),
        ),
      };
    }
  }

  private async beginSpawn(params: {
    parentCtx: ParentContext;
    def: SubagentDefinition;
    allocatedUsd: number;
    task: string;
    skills: SkillMatch[];
  }): Promise<SpawnFrame> {
    const { parentCtx, def, allocatedUsd, task, skills } = params;

    const principalSuffix = randomUUID().slice(0, 6);
    const principal =
      `workspace:${parentCtx.workspaceId}/operator:${def.operatorRole}` +
      `/subagent:${def.name}:${principalSuffix}`;

    // 1. Locate parent's most-recent LLM_INFERENCE pack to anchor the spawn.
    const parentEvidencePackId = await this.findParentReceipt(
      parentCtx.workspaceId,
      parentCtx.parentTaskRunId,
    );

    // 2. Write the SUBAGENT_SPAWN evidence pack (Path A: unsigned local marker).
    const spawnPackId = await this.writeSpawnEvidencePack({
      workspaceId: parentCtx.workspaceId,
      parentEvidencePackId,
      principal,
      def,
      policyVersion: parentCtx.policyVersion,
    });
    if (!spawnPackId) {
      throw new Error(`Failed to persist SUBAGENT_SPAWN evidence pack for "${def.name}".`);
    }

    // 3. Write the subagent's parent task_runs row.
    const initialSkillInvocations = skillAuditPayload(skills);
    const subagentTaskRunId = await this.writeSubagentTaskRun({
      taskId: parentCtx.taskId,
      parentTaskRunId: parentCtx.parentTaskRunId,
      rootTaskRunId: parentCtx.rootTaskRunId ?? parentCtx.parentTaskRunId,
      spawnedByActionId: parentCtx.parentTaskRunId,
      def,
      task,
      allocatedUsd,
      skillInvocations: initialSkillInvocations,
    });
    if (!subagentTaskRunId) {
      throw new Error(`Failed to persist subagent task run for "${def.name}".`);
    }
    const evidenceAttached = await this.attachSpawnEvidencePackToTaskRun(
      spawnPackId,
      subagentTaskRunId,
    );
    if (!evidenceAttached) {
      throw new Error(`Failed to anchor SUBAGENT_SPAWN evidence to task run for "${def.name}".`);
    }
    const skillInvocations = await this.invokeSkillsThroughBroker({
      parentCtx,
      def,
      task,
      matches: skills,
      subagentTaskRunId,
      spawnPackId,
      initialSkillInvocations,
    });
    await this.updateSubagentTaskRunSkills(subagentTaskRunId, skillInvocations);
    let handoffId: string | null;
    try {
      handoffId = await this.writeAgentHandoff({
        parentCtx,
        def,
        task,
        childTaskRunId: subagentTaskRunId,
        skillInvocations,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to persist agent handoff for "${def.name}": ${detail}`);
    }
    if (!handoffId) {
      throw new Error(`Failed to persist agent handoff for "${def.name}".`);
    }

    return {
      parentTaskRunId: subagentTaskRunId,
      rootTaskRunId: parentCtx.rootTaskRunId ?? parentCtx.parentTaskRunId ?? subagentTaskRunId,
      spawnedByActionId: subagentTaskRunId,
      parentEvidencePackId: spawnPackId,
      operatorRole: def.operatorRole,
      budgetSliceAllocated: allocatedUsd,
      handoffId,
    };
  }

  private async findParentReceipt(
    workspaceId: string,
    parentTaskRunId: string | null,
  ): Promise<string | null> {
    if (!parentTaskRunId) return null;
    try {
      const { evidencePacks } = await import('@pilot/db/schema');
      const { eq, and, desc } = await import('drizzle-orm');
      const [row] = await this.db
        .select({ id: evidencePacks.id })
        .from(evidencePacks)
        .where(
          and(
            eq(evidencePacks.workspaceId, workspaceId),
            eq(evidencePacks.taskRunId, parentTaskRunId),
          ),
        )
        .orderBy(desc(evidencePacks.receivedAt))
        .limit(1);
      return row?.id ?? null;
    } catch {
      return null;
    }
  }

  private async writeSpawnEvidencePack(params: {
    workspaceId: string;
    parentEvidencePackId: string | null;
    principal: string;
    def: SubagentDefinition;
    policyVersion: string;
  }): Promise<string> {
    try {
      const { evidencePacks } = await import('@pilot/db/schema');
      const decisionId = `local_spawn_${randomUUID()}`;
      const id = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(evidencePacks)
          .values({
            workspaceId: params.workspaceId,
            decisionId,
            verdict: 'ALLOW',
            policyVersion: params.policyVersion,
            action: 'SUBAGENT_SPAWN',
            resource: params.def.name,
            principal: params.principal,
            signedBlob: null,
            parentEvidencePackId: params.parentEvidencePackId,
          })
          .returning({ id: evidencePacks.id });
        const packId = row?.id ?? '';
        if (packId) {
          await appendEvidenceItem(tx, {
            workspaceId: params.workspaceId,
            evidencePackId: packId,
            evidenceType: 'subagent_spawn_receipt',
            sourceType: 'conductor',
            title: `Subagent spawn: ${params.def.name}`,
            summary: params.def.description,
            redactionState: 'redacted',
            sensitivity: 'internal',
            replayRef: `helm:${decisionId}`,
            metadata: {
              decisionId,
              verdict: 'ALLOW',
              policyVersion: params.policyVersion,
              action: 'SUBAGENT_SPAWN',
              resource: params.def.name,
              principal: params.principal,
              parentEvidencePackId: params.parentEvidencePackId,
              subagent: {
                name: params.def.name,
                version: params.def.version,
                operatorRole: params.def.operatorRole,
                maxRiskClass: params.def.maxRiskClass,
              },
            },
          });
        }
        return packId;
      });
      // v1.2.1 — L1 structural integrity check. Non-fatal; warnings
      // logged. Signed-blob check is off until upstream helm-oss#43 lands.
      try {
        const result = validateL1({
          id,
          decisionId,
          verdict: 'ALLOW',
          policyVersion: params.policyVersion,
          action: 'SUBAGENT_SPAWN',
          resource: params.def.name,
          principal: params.principal,
          receivedAt: new Date(),
          signedBlob: null,
          parentEvidencePackId: params.parentEvidencePackId,
        });
        const errors = result.findings.filter((f) => f.level === 'error');
        if (errors.length > 0) {
          l1Log.error({ packId: id, findings: errors }, 'SUBAGENT_SPAWN pack failed L1 validation');
        }
      } catch (err) {
        l1Log.warn({ err }, 'validateL1 threw on SUBAGENT_SPAWN pack');
      }
      return id;
    } catch {
      return '';
    }
  }

  private async attachSpawnEvidencePackToTaskRun(
    spawnPackId: string,
    taskRunId: string,
  ): Promise<boolean> {
    try {
      const { evidencePacks } = await import('@pilot/db/schema');
      const { eq } = await import('drizzle-orm');
      await this.db
        .update(evidencePacks)
        .set({ taskRunId })
        .where(eq(evidencePacks.id, spawnPackId));
      return true;
    } catch {
      return false;
    }
  }

  private async writeAgentHandoff(params: {
    parentCtx: ParentContext;
    def: SubagentDefinition;
    task: string;
    childTaskRunId: string;
    skillInvocations: SkillInvocationAudit[];
  }): Promise<string | null> {
    const { agentHandoffs } = await import('@pilot/db/schema');
    const [row] = await this.db
      .insert(agentHandoffs)
      .values({
        workspaceId: params.parentCtx.workspaceId,
        taskId: params.parentCtx.taskId,
        parentTaskRunId: params.parentCtx.parentTaskRunId,
        childTaskRunId: params.childTaskRunId,
        fromAgent: params.parentCtx.operatorRole,
        toAgent: params.def.name,
        handoffKind: 'subagent_spawn',
        status: 'running',
        skillInvocations: params.skillInvocations,
        input: {
          task: params.task,
          operatorRole: params.def.operatorRole,
          execution: params.def.execution,
          maxRiskClass: params.def.maxRiskClass,
          allowedTools: params.def.toolScope.allowedTools,
        },
      })
      .returning({ id: agentHandoffs.id });
    return row?.id ?? null;
  }

  private async completeHandoff(
    handoffId: string | null,
    result: SubagentRunResult,
  ): Promise<void> {
    if (!handoffId) return;
    try {
      const { agentHandoffs } = await import('@pilot/db/schema');
      const { eq } = await import('drizzle-orm');
      await this.db
        .update(agentHandoffs)
        .set({
          status: result.verdict,
          output: {
            summary: result.summary,
            costUsd: result.costUsd,
            tokensIn: result.tokensIn,
            tokensOut: result.tokensOut,
            iterationsUsed: result.iterationsUsed,
            error: result.error ?? null,
          },
          completedAt: new Date(),
        })
        .where(eq(agentHandoffs.id, handoffId));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to complete agent handoff ${handoffId}: ${detail}`);
    }
  }

  private async writeSubagentTaskRun(params: {
    taskId: string;
    parentTaskRunId: string | null;
    rootTaskRunId: string | null;
    spawnedByActionId: string | null;
    def: SubagentDefinition;
    task: string;
    allocatedUsd: number;
    skillInvocations: SkillInvocationAudit[];
  }): Promise<string> {
    try {
      const { taskRuns } = await import('@pilot/db/schema');
      const [row] = await this.db
        .insert(taskRuns)
        .values({
          taskId: params.taskId,
          status: 'running',
          actionTool: 'subagent.spawn',
          actionInput: { name: params.def.name, task: params.task },
          verdict: 'allow',
          iterationsUsed: 0,
          iterationBudget: params.def.iterationBudget,
          modelUsed: 'conductor',
          parentTaskRunId: params.parentTaskRunId,
          rootTaskRunId: params.rootTaskRunId,
          spawnedByActionId: params.spawnedByActionId,
          lineageKind: 'subagent_spawn',
          runSequence: 0,
          checkpointId: null,
          operatorRole: params.def.operatorRole,
          budgetSliceAllocated: params.allocatedUsd.toFixed(4),
          budgetSliceUsed: '0.0000',
          skillInvocations: params.skillInvocations,
        })
        .returning({ id: taskRuns.id });
      return row?.id ?? '';
    } catch {
      return '';
    }
  }

  private async invokeSkillsThroughBroker(params: {
    parentCtx: ParentContext;
    def: SubagentDefinition;
    task: string;
    matches: SkillMatch[];
    subagentTaskRunId: string;
    spawnPackId: string;
    initialSkillInvocations: SkillInvocationAudit[];
  }): Promise<SkillInvocationAudit[]> {
    if (params.matches.length === 0) return params.initialSkillInvocations;

    const broker = new ToolBroker(this.db);
    const initialByName = new Map(params.initialSkillInvocations.map((item) => [item.name, item]));
    const enriched: SkillInvocationAudit[] = [];
    for (const match of params.matches) {
      const brokered = await broker.execute(
        this.parentTools,
        'skill.invoke',
        {
          skillName: match.skill.name,
          expectedVersion: match.skill.version,
          activationReason: match.reason,
          score: match.score,
          task: params.task,
          subagentName: params.def.name,
          allowedTools: params.def.toolScope.allowedTools,
        },
        {
          workspaceId: params.parentCtx.workspaceId,
          taskId: params.parentCtx.taskId,
          parentTaskRunId: params.subagentTaskRunId,
          rootTaskRunId:
            params.parentCtx.rootTaskRunId ??
            params.parentCtx.parentTaskRunId ??
            params.subagentTaskRunId,
          ventureId: params.parentCtx.ventureId,
          missionId: params.parentCtx.missionId,
          policyDecisionId: params.parentCtx.policyDecisionId,
          policyVersion: params.parentCtx.policyVersion,
          helmDocumentVersionPins: params.parentCtx.helmDocumentVersionPins,
          actionHash: skillInvocationActionHash(params.def.name, params.task, match),
          evidenceIds: [params.spawnPackId],
        },
      );
      const output = isRecord(brokered.output) ? brokered.output : {};
      const base = initialByName.get(match.skill.name) ?? skillAuditPayload([match])[0]!;
      enriched.push({
        ...base,
        ...(typeof output['instructionHash'] === 'string'
          ? { instructionHash: output['instructionHash'] }
          : {}),
        brokeredInvocation: {
          actionId: brokered.actionId,
          toolExecutionId: brokered.toolExecutionId,
          evidenceItemId: brokered.evidenceItemId,
          status: brokered.status,
          inputHash: brokered.inputHash,
          outputHash: brokered.outputHash,
          ...(params.parentCtx.policyDecisionId
            ? { policyDecisionId: params.parentCtx.policyDecisionId }
            : {}),
          ...(params.parentCtx.policyVersion
            ? { policyVersion: params.parentCtx.policyVersion }
            : {}),
        },
      });
    }
    return enriched;
  }

  private async updateSubagentTaskRunSkills(
    taskRunId: string,
    skillInvocations: SkillInvocationAudit[],
  ): Promise<void> {
    if (skillInvocations.length === 0) return;
    const { taskRuns } = await import('@pilot/db/schema');
    const { eq } = await import('drizzle-orm');
    await this.db.update(taskRuns).set({ skillInvocations }).where(eq(taskRuns.id, taskRunId));
  }

  private failNotFound(name: string, parentCtx: ParentContext): SubagentRunResult {
    return {
      name,
      summary: `Subagent "${name}" not found in registry. Available: ${this.registry
        .list()
        .map((d) => d.name)
        .join(', ')}`,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      iterationsUsed: 0,
      taskRunId: parentCtx.parentTaskRunId ?? '',
      spawnEvidencePackId: '',
      verdict: 'failed',
      error: 'subagent_not_found',
    };
  }
}

export interface ParentContext {
  workspaceId: string;
  taskId: string;
  /** task_runs.id of the conductor iteration that produced this spawn. */
  parentTaskRunId: string | null;
  /** Root parent task run for nested subagent proof DAGs. */
  rootTaskRunId?: string | null;
  operatorRole: string;
  policyVersion: string;
  policyDecisionId?: string;
  helmDocumentVersionPins?: Record<string, string>;
  brokeredActionId?: string;
  ventureId?: string;
  missionId?: string;
  /** USD available to the conductor for delegations this iteration. */
  remainingBudgetUsd: number;
  /** Workspace execution mode inherited by child runs for tool filtering. */
  mode?: string;
}

export interface SpawnRequest {
  name: string;
  task: string;
  budgetWeight?: number;
}

function skillAuditPayload(matches: SkillMatch[]): SkillInvocationAudit[] {
  return matches.map((match) => ({
    name: match.skill.name,
    version: match.skill.version,
    activationReason: match.reason,
    score: match.score,
    riskProfile: match.skill.riskProfile,
    permissionRequirements: match.skill.permissionRequirements,
    evalStatus: match.skill.evalStatus,
    declaredTools: match.skill.tools,
    sourcePath: match.skill.sourcePath,
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function skillInvocationActionHash(subagentName: string, task: string, match: SkillMatch): string {
  const payload = [
    'skill.invoke',
    subagentName,
    match.skill.name,
    match.skill.version,
    match.reason,
    String(match.score),
    stableJson({ task }),
  ].join(':');
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortJson);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
