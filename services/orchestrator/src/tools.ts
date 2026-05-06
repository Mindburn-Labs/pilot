import { createHash, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { appendEvidenceItem } from '@pilot/db';
import { auditLog } from '@pilot/db/schema';
import type { Db } from '@pilot/db/client';
import type { MemoryService } from '@pilot/memory';
import {
  BrowserReadObservationInput,
  OperatorComputerUseInput,
  ScraplingFetchInput,
} from '@pilot/shared/schemas';
import { getCapabilityRecord, type CapabilityKey } from '@pilot/shared/capabilities';
import { SkillInvocationInputSchema, type SkillRegistry } from '@pilot/shared/skills';
import { SubagentSpawnRequestSchema, SubagentParallelRequestSchema } from '@pilot/shared/subagents';
import type { HelmClient } from '@pilot/helm-client';
import { withToolSpan } from '@pilot/shared/otel';
import type { McpClient } from '@pilot/shared/mcp';
import { scoreOpportunityEvidence } from '@pilot/shared/scoring';
import type { ToolDef } from './agent-loop.js';
import type { Conductor, ParentContext } from './conductor.js';
import { executeSafeComputerUse } from './computer-use.js';
import { sanitizeToolOutput } from './sanitize-output.js';

/**
 * Tool Registry — dispatch layer for agent actions.
 *
 * Tools are the actions operators can take. Each tool has:
 * - A name (matches what the LLM outputs)
 * - A description (injected into the LLM prompt)
 * - An execute function
 * - Optional mode restrictions (if unset, available in all modes)
 *
 * V1 tools are internal (DB queries, knowledge search, task management).
 * External tools (GitHub, Slack, email) require connectors + approval gates.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  constructor(
    private readonly db: Db,
    private readonly memory?: MemoryService,
    private readonly options?: {
      skipBuiltins?: boolean;
      helmClient?: HelmClient;
      skillRegistry?: SkillRegistry;
    },
  ) {
    this.skillRegistry = options?.skillRegistry;
    if (!options?.skipBuiltins) {
      this.registerBuiltins();
    }
  }

  /** Register a tool */
  register(tool: Tool) {
    this.tools.set(tool.name, tool);
  }

  /**
   * Return a new ToolRegistry containing only the named tools. Used by the
   * Conductor when wrapping a subagent — the child sees a narrowed universe
   * of tools without re-registering builtins or duplicating DB state.
   *
   * If `allowedNames` is empty, the resulting registry has zero tools — the
   * child can then only call `finish`.
   */
  subset(allowedNames: string[]): ToolRegistry {
    const allowed = new Set(allowedNames);
    const scoped = new ToolRegistry(this.db, this.memory, {
      skipBuiltins: true,
      helmClient: this.options?.helmClient,
      skillRegistry: this.skillRegistry,
    });
    for (const [name, tool] of this.tools) {
      if (allowed.has(name)) {
        scoped.tools.set(name, tool);
      }
    }
    return scoped;
  }

  /**
   * Phase 12 — attach the Conductor so the `subagent.spawn` and
   * `subagent.parallel` tools resolve. When unset (e.g. subagent
   * definitions haven't been loaded), both tools return a clear error.
   */
  setConductor(conductor: Conductor): void {
    this.conductor = conductor;
    this.registerSubagentTools();
  }

  /**
   * Phase 12 — set the parent context the conductor-tools use. Called by
   * the Orchestrator at the top of a conduct run; cleared at the end. Each
   * `subagent.spawn`/`.parallel` tool invocation reads from here.
   */
  setParentContext(ctx: ParentContext | null): void {
    this.parentContext = ctx;
  }

  setSkillRegistry(skillRegistry: SkillRegistry | undefined): void {
    this.skillRegistry = skillRegistry;
  }

  /**
   * Phase 14 Track A — register every upstream MCP tool exposed by
   * `client` as a local Tool entry, namespaced `mcp.<serverName>.<toolName>`
   * so they don't collide with native Pilot tools and stay filterable by
   * `tool_scope.allowed_tools`. Each call delegates to `client.callTool`
   * and surfaces the upstream `content`/`isError` shape verbatim — HELM
   * governance still wraps the parent `execute()` call.
   *
   * Caller (SubagentLoop) is responsible for `client.close()` lifecycle.
   */
  async registerMcpTools(serverName: string, client: McpClient): Promise<string[]> {
    const upstream = await client.listTools();
    const registered: string[] = [];
    for (const tool of upstream) {
      const name = `mcp.${serverName}.${tool.name}`;
      registered.push(name);
      this.register({
        name,
        description: `[mcp:${serverName}] ${tool.description ?? tool.name}`,
        execute: async (input) => {
          const args =
            typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
          try {
            const res = await client.callTool({ name: tool.name, arguments: args });
            return res.isError
              ? { error: `mcp ${serverName}.${tool.name} returned an error`, content: res.content }
              : { content: res.content };
          } catch (err) {
            return {
              error: err instanceof Error ? err.message : 'MCP tool call failed',
            };
          }
        },
      });
    }
    return registered;
  }

  private conductor: Conductor | null = null;
  private parentContext: ParentContext | null = null;
  private skillRegistry: SkillRegistry | undefined;

  private registerSubagentTools(): void {
    // subagent.spawn — single delegation
    this.register({
      name: 'subagent.spawn',
      description:
        'Delegate a bounded sub-task to a governed subagent. Input: {"name":"opportunity_scout","task":"scan YC recent batches for fintech"}. Returns: {name, summary, costUsd, iterationsUsed, verdict}.',
      execute: async (input) => {
        if (!this.conductor || !this.parentContext) {
          return { error: 'Subagent conductor not configured for this run' };
        }
        const parsed = SubagentSpawnRequestSchema.safeParse(input);
        if (!parsed.success) {
          return { error: `invalid subagent.spawn input: ${parsed.error.message}` };
        }
        return this.conductor.spawn(
          parentContextFromBrokerInput(this.parentContext, input),
          parsed.data,
        );
      },
    });

    // subagent.parallel — concurrent fan-out
    this.register({
      name: 'subagent.parallel',
      description:
        'Dispatch up to 6 subagents concurrently. Input: {"spawns":[{"name":"opportunity_scout","task":"..."},{"name":"decision_facilitator","task":"..."}]}. Returns an array of SubagentRunResult.',
      execute: async (input) => {
        if (!this.conductor || !this.parentContext) {
          return { error: 'Subagent conductor not configured for this run' };
        }
        const parsed = SubagentParallelRequestSchema.safeParse(input);
        if (!parsed.success) {
          return { error: `invalid subagent.parallel input: ${parsed.error.message}` };
        }
        return this.conductor.parallel(
          parentContextFromBrokerInput(this.parentContext, input),
          parsed.data.spawns,
        );
      },
    });
  }

  /** List all available tools (for LLM prompt injection) */
  listTools(): ToolDef[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  /** List tools available for a specific product mode */
  listToolsForMode(mode: string): ToolDef[] {
    return [...this.tools.values()]
      .filter((t) => !t.modes || t.modes.includes(mode))
      .map((t) => ({ name: t.name, description: t.description }));
  }

  getToolManifest(name: string): ToolManifest | undefined {
    const tool = this.tools.get(name);
    if (!tool) return undefined;
    return normalizeToolManifest(name, tool.manifest);
  }

  /** Execute a tool by name */
  async execute(name: string, input: unknown, context?: ToolExecutionContext): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) return { error: `Unknown tool: ${name}` };
    if (tool.stub && !isExplicitDemoToolMode()) {
      return {
        error: `Tool ${name} is marked as stub-only and is unavailable to autonomous agents outside explicit demo/test mode`,
        capability: tool.capabilityKey ? getCapabilityRecord(tool.capabilityKey) : undefined,
      };
    }
    const manifest = normalizeToolManifest(name, tool.manifest);
    const elevatedContextError = validateElevatedToolExecutionContext(name, manifest, context);
    if (elevatedContextError) return elevatedContextError;
    const boundInput =
      context && !name.startsWith('mcp.') ? bindToolContext(input, context) : input;
    const previousParentContext = this.parentContext;
    if (this.parentContext && context?.parentTaskRunId) {
      this.parentContext = {
        ...this.parentContext,
        parentTaskRunId: context.parentTaskRunId,
        rootTaskRunId:
          context.rootTaskRunId ?? this.parentContext.rootTaskRunId ?? context.parentTaskRunId,
      };
    }
    // Phase 13 (Track D) — emit an `execute_tool` OTel span. Best-effort
    // conversation id pulled from server context first, then input.taskId.
    const conversationId =
      context?.taskId ??
      (typeof boundInput === 'object' && boundInput !== null && 'taskId' in boundInput
        ? String((boundInput as { taskId: unknown }).taskId ?? '')
        : '');
    return withToolSpan({ toolName: name, conversationId }, async () => {
      let raw: unknown;
      try {
        raw = await tool.execute(boundInput);
      } catch (err) {
        return { error: err instanceof Error ? err.message : 'Tool execution failed' };
      } finally {
        this.parentContext = previousParentContext;
      }
      // v1.2.1 — sanitize untrusted tool output (connectors, scrapling, vision)
      // against Trojan Source / zero-width / homoglyph injection. Trusted
      // Pilot-native tools pass through untouched.
      const { sanitized, warnings, tainted } = sanitizeToolOutput(raw, name);
      if (
        tainted &&
        typeof sanitized === 'object' &&
        sanitized !== null &&
        !Array.isArray(sanitized)
      ) {
        return { ...(sanitized as Record<string, unknown>), _sanitizerWarnings: warnings };
      }
      return sanitized;
    });
  }

  private registerBuiltins() {
    // ═══════════════════════════════════════════
    // Universal tools (available in all modes)
    // ═══════════════════════════════════════════

    // ─── Runtime Skill Invocation ───
    this.register({
      name: 'skill.invoke',
      description:
        'Activate a loaded, versioned skill through Tool Broker before using its instruction body. Input: {"skillName":"yc-application-writing","expectedVersion":"1.0.0","activationReason":"explicit","task":"...","subagentName":"application_writer","allowedTools":["search_knowledge"]}.',
      capabilityKey: 'skill_registry_runtime',
      manifest: {
        key: 'skill.invoke',
        version: 'runtime_skill_adapter_v1',
        riskClass: 'medium',
        effectLevel: 'E2',
        requiredEvidence: ['skill_manifest', 'skill_run_record'],
        permissionRequirements: ['skill:invoke'],
        outputSensitivity: 'internal',
      },
      execute: async (input) => {
        const capability = getCapabilityRecord('skill_registry_runtime');
        if (!this.skillRegistry) {
          return { error: 'skill.invoke requires a loaded SkillRegistry', capability };
        }
        const parsed = SkillInvocationInputSchema.safeParse(input);
        if (!parsed.success) {
          return { error: `invalid skill.invoke input: ${parsed.error.message}`, capability };
        }
        const skill = this.skillRegistry.findByName(parsed.data.skillName);
        if (!skill) return { error: `Skill ${parsed.data.skillName} is not loaded`, capability };
        if (parsed.data.expectedVersion && parsed.data.expectedVersion !== skill.version) {
          return {
            error: `Skill ${skill.name} version mismatch: expected ${parsed.data.expectedVersion}, loaded ${skill.version}`,
            capability,
          };
        }
        const allowedTools = new Set(parsed.data.allowedTools);
        const deniedTools = skill.tools.filter((tool) => !allowedTools.has(tool));
        if (deniedTools.length > 0) {
          return {
            error: `Skill ${skill.name} requires tool(s) outside allowed scope: ${deniedTools.join(', ')}`,
            capability,
          };
        }

        return {
          skill: {
            name: skill.name,
            version: skill.version,
            riskProfile: skill.riskProfile,
            permissionRequirements: skill.permissionRequirements,
            evalStatus: skill.evalStatus,
            declaredTools: skill.tools,
            sourcePath: skill.sourcePath,
          },
          activation: {
            reason: parsed.data.activationReason,
            score: parsed.data.score,
            subagentName: parsed.data.subagentName ?? null,
          },
          taskHash: hashText(parsed.data.task),
          instructionHash: hashText(skill.body),
          instructionBlock: skill.body,
          capability,
        };
      },
    });

    // ─── Knowledge Search ───
    this.register({
      name: 'search_knowledge',
      description:
        'Search the knowledge base for information. Input: {"query": "search terms", "limit": 5}',
      execute: async (input) => {
        if (!this.memory) return { error: 'Memory service not available' };
        const { query, limit, workspaceId } = input as {
          query: string;
          limit?: number;
          workspaceId?: string;
        };
        return this.memory.search(query, { limit: limit ?? 5, workspaceId });
      },
    });

    // ─── Scrapling Fetch Bridge ───
    this.register({
      name: 'scrapling_fetch',
      description:
        'Fetch and optionally extract a web page using the internal Scrapling bridge. Input: {"url":"https://...","selector":"main","strategy":"auto|fetcher|dynamic|stealthy","waitSelector":"main","adaptiveDomain":"ycombinator.com","limit":5,"convertMarkdown":false,"developmentMode":false}',
      modes: ['discover', 'build', 'launch', 'apply'],
      execute: async (input) => {
        const parsed = ScraplingFetchInput.safeParse(input);
        if (!parsed.success)
          return { error: `invalid scrapling_fetch input: ${parsed.error.message}` };
        const {
          url,
          selector,
          strategy,
          waitSelector,
          adaptiveDomain,
          limit,
          convertMarkdown,
          developmentMode,
        } = parsed.data;

        const { resolve } = await import('node:path');
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const pythonBin = process.env.PYTHON_BIN || 'python3';
        const scriptPath = resolve(process.cwd(), 'pipelines/scraper/run_fetch.py');
        const args = [
          scriptPath,
          '--url',
          url,
          ...(selector ? ['--selector', selector] : []),
          ...(strategy ? ['--strategy', strategy] : []),
          ...(waitSelector ? ['--wait-selector', waitSelector] : []),
          ...(adaptiveDomain ? ['--adaptive-domain', adaptiveDomain] : []),
          '--limit',
          String(limit),
          ...(developmentMode ? ['--development-mode'] : []),
          ...(convertMarkdown ? ['--convert-markdown'] : []),
        ];

        const { stdout } = await execFileAsync(pythonBin, args, {
          cwd: process.cwd(),
          env: { ...process.env, PYTHONUNBUFFERED: '1' },
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        return JSON.parse(stdout);
      },
    });

    // ─── Governed Operator / Computer Use Prototype ───
    this.register({
      name: 'operator.computer_use',
      description:
        'Run a narrow HELM-governed safe computer action through Tool Broker. Input: {"operation":"terminal_command","objective":"...","cwd":".","command":"pwd","args":[]} or {"operation":"file_read","path":"package.json"} or {"operation":"file_write","path":"tmp.txt","content":"..."} or {"operation":"dev_server_status","devServerUrl":"http://localhost:3000"}.',
      modes: ['discover', 'build', 'launch', 'apply'],
      capabilityKey: 'computer_use',
      manifest: {
        key: 'operator.computer_use',
        version: 'safe_computer_action_v1',
        riskClass: 'high',
        effectLevel: 'E3',
        requiredEvidence: ['computer_action', 'command_or_file_evidence', 'helm_receipt'],
        permissionRequirements: ['computer:safe_execute'],
        outputSensitivity: 'sensitive',
      },
      execute: async (input) => {
        const capability = getCapabilityRecord('computer_use');
        const parsed = OperatorComputerUseInput.safeParse(input);
        if (!parsed.success) {
          return {
            error: `invalid operator.computer_use input: ${parsed.error.message}`,
            capability,
          };
        }
        const helmClient = this.options?.helmClient;
        if (!helmClient) {
          return {
            error:
              'operator.computer_use requires packages/helm-client wiring; refusing to create an out-of-band computer-use path',
            capability,
          };
        }
        const req = parsed.data;
        if (!req.actionId) {
          return {
            error:
              'operator.computer_use requires Tool Broker action context; refusing direct execution without durable action lineage',
            capability,
          };
        }
        if (req.operation === 'dev_server_status' && !(req.devServerUrl ?? req.targetUrl)) {
          return {
            error: 'operator.computer_use dev_server_status requires targetUrl or devServerUrl',
            capability,
          };
        }
        const devServerUrl =
          req.operation === 'dev_server_status' ? (req.devServerUrl ?? req.targetUrl) : undefined;
        const contentHash = req.operation === 'file_write' ? hashText(req.content) : undefined;
        const evaluation = await helmClient.evaluateOperatorComputerUse({
          principal: `workspace:${req.workspaceId}/operator:${req.operatorId ?? 'agent'}`,
          workspaceId: req.workspaceId,
          taskId: req.taskId,
          operatorId: req.operatorId,
          objective: req.objective,
          environment: req.environment,
          operation: req.operation,
          maxSteps: req.maxSteps,
          approvalCheckpoint: req.approvalCheckpoint,
          evidencePackId: req.evidencePackId,
          ...(req.operation === 'terminal_command'
            ? {
                command: req.command,
                args: req.args,
                cwd: req.cwd,
                timeoutMs: req.timeoutMs,
              }
            : {}),
          ...(req.operation === 'file_read' ? { path: req.path, maxBytes: req.maxBytes } : {}),
          ...(req.operation === 'file_write'
            ? { path: req.path, contentHash, expectedCurrentHash: req.expectedCurrentHash }
            : {}),
          ...(devServerUrl ? { targetUrl: devServerUrl, devServerUrl } : {}),
        });
        const result = await executeSafeComputerUse(this.db, req, evaluation);
        return { ...result, capability };
      },
    });

    this.register({
      name: 'operator.browser_read',
      description:
        'Persist a governed read-only browser observation from an already granted logged-in browser session. Input: {"workspaceId":"uuid","sessionId":"uuid","grantId":"uuid","url":"https://...","domSnapshot":"redactable DOM text","extractedData":{...}}',
      modes: ['discover', 'build', 'launch', 'apply'],
      capabilityKey: 'browser_execution',
      manifest: {
        key: 'operator.browser_read',
        version: 'readonly_observation_v1',
        riskClass: 'medium',
        effectLevel: 'E2',
        requiredEvidence: ['browser_observation', 'dom_hash', 'redactions'],
        permissionRequirements: ['browser:read_extract'],
        outputSensitivity: 'sensitive',
      },
      execute: async (input) => {
        const capability = getCapabilityRecord('browser_execution');
        const parsed = BrowserReadObservationInput.safeParse(input);
        if (!parsed.success) {
          return {
            error: `invalid operator.browser_read input: ${parsed.error.message}`,
            capability,
          };
        }
        const helmClient = this.options?.helmClient;
        if (!helmClient) {
          return {
            error:
              'operator.browser_read requires packages/helm-client wiring; refusing to create an out-of-band browser read path',
            capability,
          };
        }

        const req = parsed.data;
        const ownership = await this.loadActiveBrowserGrant(req);
        if ('error' in ownership) return { ...ownership, capability };

        const url = new URL(req.url);
        if (!ownership.allowedOrigins.includes(url.origin)) {
          return {
            error: 'browser observation origin is outside the active grant',
            capability,
          };
        }

        const evaluation = await helmClient.evaluateOperatorBrowserRead({
          principal: `workspace:${req.workspaceId}/browser:${req.sessionId}`,
          workspaceId: req.workspaceId,
          sessionId: req.sessionId,
          grantId: req.grantId,
          objective: req.objective,
          url: req.url,
          taskId: req.taskId,
          operatorId:
            ownership.grantedToType === 'operator' && ownership.grantedToId
              ? ownership.grantedToId
              : undefined,
        });

        const redacted = redactBrowserText(req.domSnapshot ?? '');
        const redactions = Array.from(new Set([...req.redactions, ...redacted.redactions]));
        const helmDocumentVersionPins = browserHelmDocumentVersionPins(
          evaluation.receipt.policyVersion,
        );
        const { browserActions, browserObservations } = await import('@pilot/db/schema');
        const { browserAction, observation, evidenceItemId } = await this.db.transaction(
          async (tx) => {
            const db = tx as unknown as Pick<Db, 'insert'>;
            const [persistedBrowserAction] = await db
              .insert(browserActions)
              .values({
                workspaceId: req.workspaceId,
                sessionId: req.sessionId,
                grantId: req.grantId,
                taskId: req.taskId,
                toolActionId: req.actionId,
                actionType: 'read_extract',
                objective: req.objective,
                url: req.url,
                origin: url.origin,
                status: 'completed',
                policyDecisionId: evaluation.receipt.decisionId,
                policyVersion: evaluation.receipt.policyVersion,
                helmDocumentVersionPins,
                evidencePackId: evaluation.evidencePackId ?? null,
                completedAt: new Date(),
                metadata: {
                  helmDecisionId: evaluation.receipt.decisionId,
                  helmPolicyVersion: evaluation.receipt.policyVersion,
                  helmDocumentVersionPins,
                  credentialBoundary: 'read_only_no_cookie_or_password_export',
                },
              })
              .returning({
                id: browserActions.id,
                replayIndex: browserActions.replayIndex,
                evidencePackId: browserActions.evidencePackId,
              });
            if (!persistedBrowserAction?.id) {
              throw new Error('operator.browser_read could not persist browser action evidence');
            }

            const [persistedObservation] = await db
              .insert(browserObservations)
              .values({
                workspaceId: req.workspaceId,
                sessionId: req.sessionId,
                grantId: req.grantId,
                browserActionId: persistedBrowserAction.id,
                taskId: req.taskId,
                actionId: req.actionId,
                evidencePackId: evaluation.evidencePackId ?? null,
                url: req.url,
                origin: url.origin,
                title: req.title,
                objective: req.objective,
                domHash: req.domSnapshot ? hashText(redacted.text) : null,
                screenshotHash: req.screenshotHash ?? null,
                screenshotRef: req.screenshotRef ?? null,
                redactedDomSnapshot: redacted.text || null,
                extractedData: redactJson(req.extractedData),
                redactions,
                replayIndex: persistedBrowserAction.replayIndex ?? 0,
                metadata: {
                  ...redactRecord(req.metadata),
                  helmDecisionId: evaluation.receipt.decisionId,
                  helmPolicyVersion: evaluation.receipt.policyVersion,
                  helmDocumentVersionPins,
                  credentialBoundary: 'read_only_no_cookie_or_password_export',
                },
              })
              .returning({
                id: browserObservations.id,
                domHash: browserObservations.domHash,
                evidencePackId: browserObservations.evidencePackId,
              });
            if (!persistedObservation?.id) {
              throw new Error('operator.browser_read could not persist browser observation');
            }

            const persistedEvidenceItemId = await appendEvidenceItem(db, {
              workspaceId: req.workspaceId,
              taskId: req.taskId ?? null,
              actionId: req.actionId ?? null,
              evidencePackId: evaluation.evidencePackId ?? null,
              browserObservationId: persistedObservation.id,
              evidenceType: 'browser_observation',
              sourceType: 'browser_operator',
              title: `Browser read: ${req.title ?? url.hostname}`,
              summary: req.objective ?? `Read-only browser extraction from ${url.origin}`,
              redactionState: redactions.length > 0 ? 'redacted' : 'clean',
              sensitivity: 'sensitive',
              contentHash: persistedObservation.domHash ?? req.screenshotHash ?? null,
              storageRef: req.screenshotRef ?? null,
              replayRef: `browser:${req.sessionId}:${persistedBrowserAction.replayIndex ?? 0}`,
              metadata: {
                sessionId: req.sessionId,
                grantId: req.grantId,
                browserActionId: persistedBrowserAction.id,
                url: req.url,
                origin: url.origin,
                helmDecisionId: evaluation.receipt.decisionId,
                helmPolicyVersion: evaluation.receipt.policyVersion,
                helmDocumentVersionPins,
                credentialBoundary: 'read_only_no_cookie_or_password_export',
                redactions,
              },
            });
            return {
              browserAction: persistedBrowserAction,
              observation: persistedObservation,
              evidenceItemId: persistedEvidenceItemId,
            };
          },
        );

        return {
          browserAction,
          observation,
          governance: {
            status: evaluation.status,
            decisionId: evaluation.receipt.decisionId,
            policyVersion: evaluation.receipt.policyVersion,
            helmDocumentVersionPins,
            evidencePackId: evaluation.evidencePackId,
          },
          redactions,
          evidenceItemId,
          capability,
        };
      },
    });

    // ─── Create Note ───
    this.register({
      name: 'create_note',
      description:
        'Save a note or finding to the knowledge base. Input: {"title": "...", "content": "...", "tags": ["..."]}',
      execute: async (input) => {
        if (!this.memory) return { error: 'Memory service not available' };
        const { title, content, tags, workspaceId } = input as {
          title: string;
          content: string;
          tags?: string[];
          workspaceId?: string;
        };
        const id = await this.memory.upsertPage({
          workspaceId,
          type: 'concept',
          title,
          compiledTruth: content.slice(0, 500),
          tags,
          content,
        });
        return { id, title };
      },
    });

    // ─── Generate Text ───
    this.register({
      name: 'draft_text',
      description:
        'Draft text content (copy, descriptions, specs). Input: {"purpose": "what this text is for", "draft": "the drafted text"}',
      execute: async (input) => {
        const { purpose, draft } = input as { purpose: string; draft: string };
        return { purpose, draft, length: draft.length };
      },
    });

    // ─── Analyze ───
    this.register({
      name: 'analyze',
      description:
        'Record an analysis or insight. Input: {"topic": "...", "findings": "...", "confidence": "high|medium|low"}',
      execute: async (input) => {
        return input; // passthrough — analysis is recorded in action history
      },
    });

    // ─── Get Workspace Context ───
    this.register({
      name: 'get_workspace_context',
      description:
        'Get workspace overview (name, current mode, member count, active tasks). Input: {"workspaceId": "..."}',
      execute: async (input) => {
        const { workspaceId } = input as { workspaceId: string };
        const { workspaces, workspaceMembers, tasks } = await import('@pilot/db/schema');
        const { eq, and, count } = await import('drizzle-orm');
        const [ws] = await this.db
          .select()
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .limit(1);
        if (!ws) return { error: 'Workspace not found' };
        const [memberResult] = await this.db
          .select({ count: count() })
          .from(workspaceMembers)
          .where(eq(workspaceMembers.workspaceId, workspaceId));
        const [taskResult] = await this.db
          .select({ count: count() })
          .from(tasks)
          .where(and(eq(tasks.workspaceId, workspaceId), eq(tasks.status, 'pending')));
        return {
          id: ws.id,
          name: ws.name,
          currentMode: ws.currentMode,
          memberCount: memberResult?.count ?? 0,
          activeTaskCount: taskResult?.count ?? 0,
        };
      },
    });

    // ─── Send Notification ───
    this.register({
      name: 'send_notification',
      description:
        'Record a notification in the timeline. Input: {"workspaceId": "...", "message": "...", "eventType": "note|milestone"}',
      execute: async (input) => {
        const { workspaceId, message, eventType } = input as {
          workspaceId: string;
          message: string;
          eventType?: string;
        };
        // Find the workspace project page to attach the timeline entry
        const { pages, timelineEntries } = await import('@pilot/db/schema');
        const { and, eq } = await import('drizzle-orm');
        // Use a workspace-level project page, or create one
        let [page] = await this.db
          .select()
          .from(pages)
          .where(
            and(eq(pages.workspaceId, workspaceId), eq(pages.title, `workspace:${workspaceId}`)),
          )
          .limit(1);
        if (!page) {
          [page] = await this.db
            .insert(pages)
            .values({
              workspaceId,
              type: 'project',
              title: `workspace:${workspaceId}`,
              compiledTruth: '',
            })
            .returning();
        }
        if (!page) return { error: 'Failed to create notification page' };
        const [entry] = await this.db
          .insert(timelineEntries)
          .values({
            pageId: page.id,
            eventType: eventType ?? 'note',
            content: message,
            source: 'agent',
          })
          .returning();
        return { id: entry?.id, message, eventType: eventType ?? 'note' };
      },
    });

    // ═══════════════════════════════════════════
    // Discover mode tools
    // ═══════════════════════════════════════════

    // ─── List Opportunities ───
    this.register({
      name: 'list_opportunities',
      description: 'List startup opportunities for a workspace. Input: {"workspaceId": "..."}',
      modes: ['discover'],
      execute: async (input) => {
        const { workspaceId } = input as { workspaceId: string };
        const { opportunities } = await import('@pilot/db/schema');
        const { eq } = await import('drizzle-orm');
        const results = await this.db
          .select()
          .from(opportunities)
          .where(eq(opportunities.workspaceId, workspaceId))
          .limit(10);
        return results;
      },
    });

    // ─── Create Opportunity ───
    this.register({
      name: 'create_opportunity',
      description:
        'Create a new startup opportunity. Input: {"workspaceId": "...", "title": "...", "description": "...", "source": "agent|manual|scrape"}',
      modes: ['discover'],
      execute: async (input) => {
        const { workspaceId, title, description, source } = input as {
          workspaceId: string;
          title: string;
          description: string;
          source?: string;
        };
        const { opportunities } = await import('@pilot/db/schema');
        const [opp] = await this.db
          .insert(opportunities)
          .values({
            workspaceId,
            title,
            description,
            source: source ?? 'agent',
          })
          .returning();
        return opp ? { id: opp.id, title: opp.title } : { error: 'Failed to create opportunity' };
      },
    });

    // ─── Score Opportunity ───
    this.register({
      name: 'score_opportunity',
      description:
        'Score an opportunity with evidence-backed startup criteria. Input: {"opportunityId": "...", "founderSignals": ["..."], "citations": [{"url":"...","title":"...","note":"..."}]}',
      modes: ['discover'],
      capabilityKey: 'opportunity_scoring',
      manifest: {
        key: 'score_opportunity',
        version: 'evidence_v1',
        riskClass: 'low',
        effectLevel: 'E1',
        requiredEvidence: ['opportunity_score', 'citations'],
        permissionRequirements: ['opportunity:score'],
        outputSensitivity: 'internal',
      },
      execute: async (input) => {
        const capability = getCapabilityRecord('opportunity_scoring');
        const {
          opportunityId,
          workspaceId,
          founderSignals,
          citations,
          policyDecisionId,
          policyVersion,
          helmDocumentVersionPins,
        } = input as {
          opportunityId: string;
          workspaceId?: string;
          founderSignals?: string[];
          citations?: Array<{ url?: string; title?: string; note?: string }>;
          policyDecisionId?: string;
          policyVersion?: string;
          helmDocumentVersionPins?: Record<string, string>;
        };
        // Verify opportunity exists
        const { opportunities, opportunityScores } = await import('@pilot/db/schema');
        const { and, eq } = await import('drizzle-orm');
        const [opp] = await this.db
          .select()
          .from(opportunities)
          .where(
            workspaceId
              ? and(eq(opportunities.id, opportunityId), eq(opportunities.workspaceId, workspaceId))
              : eq(opportunities.id, opportunityId),
          )
          .limit(1);
        if (!opp) return { error: 'Opportunity not found', capability };
        const score = scoreOpportunityEvidence({
          title: opp.title,
          description: opp.description,
          source: opp.source,
          sourceUrl: opp.sourceUrl ?? undefined,
          rawData: opp.rawData,
          aiFriendlyOk: Boolean(opp.aiFriendlyOk),
          founderSignals: Array.isArray(founderSignals) ? founderSignals : [],
          citations: Array.isArray(citations) ? citations : [],
        });
        await this.db.transaction(async (tx) => {
          const db = tx as unknown as Db;
          await db.insert(opportunityScores).values({
            opportunityId,
            overallScore: score.overall,
            founderFitScore: score.dimensions.founderFit,
            marketSignal: score.dimensions.marketPain,
            feasibility: score.dimensions.technicalFeasibility,
            timing: score.dimensions.urgency,
            scoringMethod: 'evidence_v1',
            policyDecisionId: policyDecisionId ?? null,
            policyVersion: policyVersion ?? null,
            helmDocumentVersionPins: helmDocumentVersionPins ?? {},
            modelUsage: {},
          });
          await db
            .update(opportunities)
            .set({ status: 'scored' })
            .where(eq(opportunities.id, opportunityId));
        });
        return {
          opportunityId,
          method: 'evidence_v1',
          ...score,
          capability,
        };
      },
    });

    // ─── Search YC Intelligence ───
    this.register({
      name: 'search_yc',
      description:
        'Search YC companies and advice for inspiration. Input: {"query": "...", "limit": 5}',
      modes: ['discover', 'apply'],
      execute: async (input) => {
        const { query, limit } = input as { query: string; limit?: number };
        const { ycCompanies, ycAdvice } = await import('@pilot/db/schema');
        const { ilike, or } = await import('drizzle-orm');
        const pattern = `%${query}%`;
        const companies = await this.db
          .select()
          .from(ycCompanies)
          .where(
            or(
              ilike(ycCompanies.name, pattern),
              ilike(ycCompanies.description, pattern),
              ilike(ycCompanies.industry, pattern),
            ),
          )
          .limit(limit ?? 5);
        const advice = await this.db
          .select()
          .from(ycAdvice)
          .where(or(ilike(ycAdvice.title, pattern), ilike(ycAdvice.content, pattern)))
          .limit(3);
        return { companies, advice };
      },
    });

    // ═══════════════════════════════════════════
    // Decide mode tools
    // ═══════════════════════════════════════════

    // ─── Get Founder Profile ───
    this.register({
      name: 'get_founder_profile',
      description:
        'Get the founder profile and strengths for a workspace. Input: {"workspaceId": "..."}',
      modes: ['decide'],
      execute: async (input) => {
        const { workspaceId } = input as { workspaceId: string };
        const { founderProfiles, founderStrengths } = await import('@pilot/db/schema');
        const { eq } = await import('drizzle-orm');
        const [profile] = await this.db
          .select()
          .from(founderProfiles)
          .where(eq(founderProfiles.workspaceId, workspaceId))
          .limit(1);
        if (!profile) return { error: 'No founder profile found' };
        const strengths = await this.db
          .select()
          .from(founderStrengths)
          .where(eq(founderStrengths.founderId, profile.id));
        return { profile, strengths };
      },
    });

    // ═══════════════════════════════════════════
    // Build mode tools
    // ═══════════════════════════════════════════

    // ─── Create Task ───
    this.register({
      name: 'create_task',
      description:
        'Create a new task. Input: {"workspaceId": "...", "title": "...", "description": "...", "mode": "build|launch|...", "priority": 0}',
      modes: ['build'],
      execute: async (input) => {
        const { workspaceId, title, description, mode, priority } = input as {
          workspaceId: string;
          title: string;
          description: string;
          mode?: string;
          priority?: number;
        };
        const { tasks } = await import('@pilot/db/schema');
        const [task] = await this.db
          .insert(tasks)
          .values({
            workspaceId,
            title,
            description,
            mode: mode ?? 'build',
            status: 'pending',
            priority: priority ?? 0,
          })
          .returning();
        return task
          ? { id: task.id, title: task.title, status: task.status }
          : { error: 'Failed to create task' };
      },
    });

    // ─── Update Task Status ───
    this.register({
      name: 'update_task_status',
      description:
        'Update a task status. Input: {"taskId": "...", "status": "pending|in_progress|completed|blocked"}',
      modes: ['build'],
      execute: async (input) => {
        const { taskId, status } = input as { taskId: string; status: string };
        const { tasks } = await import('@pilot/db/schema');
        const { eq } = await import('drizzle-orm');
        const values: Record<string, unknown> = { status, updatedAt: new Date() };
        if (status === 'completed') {
          values['completedAt'] = new Date();
        }
        const [updated] = await this.db
          .update(tasks)
          .set(values)
          .where(eq(tasks.id, taskId))
          .returning();
        return updated ? { id: updated.id, status: updated.status } : { error: 'Task not found' };
      },
    });

    // ─── List Tasks ───
    this.register({
      name: 'list_tasks',
      description:
        'List tasks for a workspace. Input: {"workspaceId": "...", "status": "pending|in_progress|completed"}',
      modes: ['build', 'launch'],
      execute: async (input) => {
        const { workspaceId, status } = input as { workspaceId: string; status?: string };
        const { tasks } = await import('@pilot/db/schema');
        const { eq, and, desc } = await import('drizzle-orm');
        const conditions = [eq(tasks.workspaceId, workspaceId)];
        if (status) conditions.push(eq(tasks.status, status));
        const results = await this.db
          .select()
          .from(tasks)
          .where(and(...conditions))
          .orderBy(desc(tasks.priority))
          .limit(20);
        return results;
      },
    });

    // ─── Create Plan ───
    this.register({
      name: 'create_plan',
      description:
        'Create a plan with milestones. Input: {"workspaceId": "...", "title": "...", "description": "...", "milestones": [{"title": "...", "description": "..."}]}',
      modes: ['build'],
      execute: async (input) => {
        const {
          workspaceId,
          title,
          description,
          milestones: milestoneInputs,
        } = input as {
          workspaceId: string;
          title: string;
          description?: string;
          milestones?: Array<{ title: string; description?: string }>;
        };
        const { plans, milestones } = await import('@pilot/db/schema');
        const [plan] = await this.db
          .insert(plans)
          .values({ workspaceId, title, description: description ?? '' })
          .returning();
        if (!plan) return { error: 'Failed to create plan' };
        const createdMilestones: Array<{ id: string; title: string }> = [];
        if (milestoneInputs && milestoneInputs.length > 0) {
          for (let i = 0; i < milestoneInputs.length; i++) {
            const m = milestoneInputs[i]!;
            const [ms] = await this.db
              .insert(milestones)
              .values({
                planId: plan.id,
                title: m.title,
                description: m.description,
                sortOrder: i,
              })
              .returning();
            if (ms) createdMilestones.push({ id: ms.id, title: ms.title });
          }
        }
        return { id: plan.id, title: plan.title, milestones: createdMilestones };
      },
    });

    // ─── Create Artifact ───
    this.register({
      name: 'create_artifact',
      description:
        'Create an artifact (document, code, design). Input: {"workspaceId": "...", "type": "landing_page|pdf|code|design|copy|pitch_deck", "name": "...", "description": "...", "content": "..."}',
      modes: ['build', 'launch'],
      execute: async (input) => {
        const { workspaceId, taskId, actionId, type, name, description, content } = input as {
          workspaceId: string;
          taskId?: string;
          actionId?: string;
          type: string;
          name: string;
          description?: string;
          content?: string;
        };
        const { artifacts, artifactVersions } = await import('@pilot/db/schema');
        // V1: store content inline as storage path (real storage client in Phase C)
        const storagePath = `inline://${name}`;
        return await this.db.transaction(async (tx) => {
          const [artifact] = await tx
            .insert(artifacts)
            .values({
              workspaceId,
              type,
              name,
              description,
              storagePath,
              mimeType: 'text/plain',
              sizeBytes: content?.length ?? 0,
              metadata: content ? { content } : {},
            })
            .returning();
          if (!artifact) return { error: 'Failed to create artifact' };
          // Create initial version
          await tx.insert(artifactVersions).values({
            artifactId: artifact.id,
            version: 1,
            storagePath,
            sizeBytes: content?.length ?? 0,
            changelog: 'Initial version',
          });
          const auditEventId = randomUUID();
          const replayRef = `artifact:${artifact.id}:1`;
          const evidenceMetadata = {
            artifactType: type,
            version: 1,
            mimeType: 'text/plain',
            sizeBytes: content?.length ?? 0,
            storageMode: 'inline_artifact_metadata',
            tool: 'create_artifact',
          };
          const auditMetadata = {
            evidenceType: 'artifact_created',
            replayRef,
            artifactId: artifact.id,
            taskId: taskId ?? null,
            actionId: actionId ?? null,
            ...evidenceMetadata,
          };
          await tx.insert(auditLog).values({
            id: auditEventId,
            workspaceId,
            action: 'ARTIFACT_CREATED',
            actor: `workspace:${workspaceId}`,
            target: artifact.id,
            verdict: 'created',
            reason: description ?? `Created ${type} artifact`,
            metadata: auditMetadata,
          });
          const evidenceItemId = await appendEvidenceItem(tx, {
            workspaceId,
            taskId: taskId ?? null,
            actionId: actionId ?? null,
            auditEventId,
            artifactId: artifact.id,
            evidenceType: 'artifact_created',
            sourceType: 'tool_registry',
            title: `Artifact created: ${artifact.name}`,
            summary: description ?? `Created ${type} artifact`,
            redactionState: 'redacted',
            sensitivity: 'internal',
            contentHash: content ? hashText(content) : null,
            storageRef: storagePath,
            replayRef,
            metadata: evidenceMetadata,
          });
          await tx
            .update(auditLog)
            .set({
              metadata: {
                ...auditMetadata,
                evidenceItemId,
              },
            })
            .where(and(eq(auditLog.workspaceId, workspaceId), eq(auditLog.id, auditEventId)));
          return {
            id: artifact.id,
            name: artifact.name,
            type: artifact.type,
            version: 1,
            evidenceItemId,
          };
        });
      },
    });

    // ═══════════════════════════════════════════
    // Apply mode tools
    // ═══════════════════════════════════════════

    // ─── Create Application Draft ───
    this.register({
      name: 'create_application_draft',
      description:
        'Create or update an application draft section. Input: {"workspaceId": "...", "targetProgram": "yc|techstars|custom", "section": "company_description|problem|solution|traction|team|market|pitch", "content": "..."}',
      modes: ['apply'],
      execute: async (input) => {
        const { workspaceId, targetProgram, section, content } = input as {
          workspaceId: string;
          targetProgram: string;
          section: string;
          content: string;
        };
        const { applications, applicationDrafts } = await import('@pilot/db/schema');
        const { eq, and } = await import('drizzle-orm');
        // Find or create the application
        let [app] = await this.db
          .select()
          .from(applications)
          .where(
            and(
              eq(applications.workspaceId, workspaceId),
              eq(applications.targetProgram, targetProgram),
            ),
          )
          .limit(1);
        if (!app) {
          [app] = await this.db
            .insert(applications)
            .values({ workspaceId, targetProgram })
            .returning();
        }
        if (!app) return { error: 'Failed to create application' };
        // Upsert draft section
        const [draft] = await this.db
          .insert(applicationDrafts)
          .values({ applicationId: app.id, section, content })
          .returning();
        return draft
          ? { applicationId: app.id, draftId: draft.id, section, length: content.length }
          : { error: 'Failed to create draft' };
      },
    });

    // ═══════════════════════════════════════════
    // External Connector Tools
    // ═══════════════════════════════════════════
    // These tools require active connector grants.
    // Token resolution happens at execution time.

    // ─── GitHub: Create Repository ───
    this.register({
      name: 'github_create_repo',
      description:
        'Create a GitHub repository. Requires GitHub connector. Input: {"workspaceId": "...", "name": "repo-name", "private": true, "description": "..."}',
      modes: ['build', 'launch'],
      execute: async (input) => {
        const {
          workspaceId,
          name,
          private: isPrivate,
          description,
        } = input as {
          workspaceId: string;
          name: string;
          private?: boolean;
          description?: string;
        };
        const token = await this.resolveConnectorToken(workspaceId, 'github');
        if (!token)
          return {
            error:
              'GitHub connector not authorized. Connect via /api/connectors/github/oauth/initiate',
          };
        const { GitHubConnector } = await import('@pilot/connectors');
        const gh = new GitHubConnector(token);
        return gh.createRepo(name, { private: isPrivate, description });
      },
    });

    // ─── GitHub: Create Issue ───
    this.register({
      name: 'github_create_issue',
      description:
        'Create a GitHub issue. Input: {"workspaceId": "...", "repo": "owner/repo", "title": "...", "body": "...", "labels": ["bug"]}',
      modes: ['build'],
      execute: async (input) => {
        const { workspaceId, repo, title, body, labels } = input as {
          workspaceId: string;
          repo: string;
          title: string;
          body: string;
          labels?: string[];
        };
        const token = await this.resolveConnectorToken(workspaceId, 'github');
        if (!token) return { error: 'GitHub connector not authorized' };
        const { GitHubConnector } = await import('@pilot/connectors');
        const gh = new GitHubConnector(token);
        return gh.createIssue(repo, title, body, labels);
      },
    });

    // ─── GitHub: List Issues ───
    this.register({
      name: 'github_list_issues',
      description:
        'List GitHub issues. Input: {"workspaceId": "...", "repo": "owner/repo", "state": "open|closed|all"}',
      modes: ['build'],
      execute: async (input) => {
        const { workspaceId, repo, state } = input as {
          workspaceId: string;
          repo: string;
          state?: 'open' | 'closed' | 'all';
        };
        const token = await this.resolveConnectorToken(workspaceId, 'github');
        if (!token) return { error: 'GitHub connector not authorized' };
        const { GitHubConnector } = await import('@pilot/connectors');
        const gh = new GitHubConnector(token);
        return gh.listIssues(repo, state);
      },
    });

    // ─── Gmail: Send Email ───
    this.register({
      name: 'gmail_send',
      description:
        'Send an email via Gmail. Input: {"workspaceId": "...", "to": "email@example.com", "subject": "...", "body": "...", "isHtml": false}',
      modes: ['build', 'launch', 'apply'],
      execute: async (input) => {
        const { workspaceId, to, subject, body, isHtml } = input as {
          workspaceId: string;
          to: string;
          subject: string;
          body: string;
          isHtml?: boolean;
        };
        const token = await this.resolveConnectorToken(workspaceId, 'gmail');
        if (!token)
          return {
            error:
              'Gmail connector not authorized. Connect via /api/connectors/gmail/oauth/initiate',
          };
        const { GmailConnector } = await import('@pilot/connectors');
        const gmail = new GmailConnector(token);
        return gmail.sendEmail({ to, subject, body, isHtml });
      },
    });

    // ─── Gmail: Search Messages ───
    this.register({
      name: 'gmail_search',
      description:
        'Search Gmail messages. Input: {"workspaceId": "...", "query": "is:unread from:investor", "limit": 10}',
      modes: ['build', 'launch', 'apply'],
      execute: async (input) => {
        const { workspaceId, query, limit } = input as {
          workspaceId: string;
          query: string;
          limit?: number;
        };
        const token = await this.resolveConnectorToken(workspaceId, 'gmail');
        if (!token) return { error: 'Gmail connector not authorized' };
        const { GmailConnector } = await import('@pilot/connectors');
        const gmail = new GmailConnector(token);
        return gmail.listMessages(query, limit);
      },
    });

    // ─── Gmail: Read Message ───
    this.register({
      name: 'gmail_read',
      description:
        'Read a specific Gmail message. Input: {"workspaceId": "...", "messageId": "..."}',
      modes: ['build', 'launch', 'apply'],
      execute: async (input) => {
        const { workspaceId, messageId } = input as { workspaceId: string; messageId: string };
        const token = await this.resolveConnectorToken(workspaceId, 'gmail');
        if (!token) return { error: 'Gmail connector not authorized' };
        const { GmailConnector } = await import('@pilot/connectors');
        const gmail = new GmailConnector(token);
        return gmail.getMessage(messageId);
      },
    });

    // ─── Google Drive: List Files ───
    this.register({
      name: 'gdrive_list',
      description:
        'List files in Google Drive. Input: {"workspaceId": "...", "query": "name contains \'report\'", "limit": 20}',
      modes: ['build', 'launch'],
      execute: async (input) => {
        const { workspaceId, query, limit } = input as {
          workspaceId: string;
          query?: string;
          limit?: number;
        };
        const token = await this.resolveConnectorToken(workspaceId, 'gdrive');
        if (!token) return { error: 'Google Drive connector not authorized' };
        const { DriveConnector } = await import('@pilot/connectors');
        const drive = new DriveConnector(token);
        return drive.listFiles({ query, pageSize: limit });
      },
    });

    // ─── Google Drive: Create File ───
    this.register({
      name: 'gdrive_create',
      description:
        'Create a file in Google Drive. Input: {"workspaceId": "...", "name": "filename.md", "content": "...", "mimeType": "text/markdown"}',
      modes: ['build', 'launch'],
      execute: async (input) => {
        const { workspaceId, name, content, mimeType, folderId } = input as {
          workspaceId: string;
          name: string;
          content: string;
          mimeType?: string;
          folderId?: string;
        };
        const token = await this.resolveConnectorToken(workspaceId, 'gdrive');
        if (!token) return { error: 'Google Drive connector not authorized' };
        const { DriveConnector } = await import('@pilot/connectors');
        const drive = new DriveConnector(token);
        return drive.createFile({ name, content, mimeType, folderId });
      },
    });

    // ─── Linear: Create Issue ───
    this.register({
      name: 'linear_create_issue',
      description:
        'Create a Linear issue. Input: {"workspaceId":"...","teamId":"...","title":"...","description":"...","priority":0-4,"assigneeId":"optional"}',
      modes: ['build', 'launch'],
      execute: async (input) => {
        const { workspaceId, teamId, title, description, priority, assigneeId, labelIds } =
          input as {
            workspaceId: string;
            teamId: string;
            title: string;
            description?: string;
            priority?: 0 | 1 | 2 | 3 | 4;
            assigneeId?: string;
            labelIds?: string[];
          };
        const token = await this.resolveConnectorToken(workspaceId, 'linear');
        if (!token) return { error: 'Linear connector not authorized' };
        const { LinearConnector } = await import('@pilot/connectors');
        return new LinearConnector(token).createIssue({
          teamId,
          title,
          description,
          priority,
          assigneeId,
          labelIds,
        });
      },
    });

    // ─── Linear: List Issues ───
    this.register({
      name: 'linear_list_issues',
      description:
        'List Linear issues. Input: {"workspaceId":"...","teamId":"optional","limit":50,"stateNames":["Started","Completed"]}',
      modes: ['build', 'launch'],
      execute: async (input) => {
        const { workspaceId, teamId, limit, stateNames } = input as {
          workspaceId: string;
          teamId?: string;
          limit?: number;
          stateNames?: string[];
        };
        const token = await this.resolveConnectorToken(workspaceId, 'linear');
        if (!token) return { error: 'Linear connector not authorized' };
        const { LinearConnector } = await import('@pilot/connectors');
        return new LinearConnector(token).listIssues({ teamId, limit, stateNames });
      },
    });

    // ─── Linear: Update Issue ───
    this.register({
      name: 'linear_update_issue',
      description:
        'Update a Linear issue. Input: {"workspaceId":"...","issueId":"...","title":"optional","stateId":"optional","priority":0-4}',
      modes: ['build', 'launch'],
      execute: async (input) => {
        const { workspaceId, issueId, ...updates } = input as {
          workspaceId: string;
          issueId: string;
          title?: string;
          description?: string;
          stateId?: string;
          priority?: 0 | 1 | 2 | 3 | 4;
          assigneeId?: string;
        };
        const token = await this.resolveConnectorToken(workspaceId, 'linear');
        if (!token) return { error: 'Linear connector not authorized' };
        const { LinearConnector } = await import('@pilot/connectors');
        return new LinearConnector(token).updateIssue(issueId, updates);
      },
    });

    // ─── Linear: List Teams ───
    this.register({
      name: 'linear_list_teams',
      description: 'List Linear teams in the workspace. Input: {"workspaceId":"..."}',
      modes: ['build', 'launch'],
      execute: async (input) => {
        const { workspaceId } = input as { workspaceId: string };
        const token = await this.resolveConnectorToken(workspaceId, 'linear');
        if (!token) return { error: 'Linear connector not authorized' };
        const { LinearConnector } = await import('@pilot/connectors');
        return new LinearConnector(token).listTeams();
      },
    });

    // ─── Slack: Post Message ───
    this.register({
      name: 'slack_post',
      description:
        'Post a message into a Slack channel. Input: {"workspaceId":"...","channel":"#general or C0123…","text":"...","threadTs":"optional"}',
      modes: ['build', 'launch'],
      execute: async (input) => {
        const { workspaceId, channel, text, threadTs } = input as {
          workspaceId: string;
          channel: string;
          text: string;
          threadTs?: string;
        };
        const token = await this.resolveConnectorToken(workspaceId, 'slack');
        if (!token)
          return {
            error:
              'Slack connector not authorized. Connect via /api/connectors/slack/oauth/initiate',
          };
        const { SlackConnector } = await import('@pilot/connectors');
        const slack = new SlackConnector(token);
        return slack.postMessage(channel, text, threadTs ? { threadTs } : undefined);
      },
    });

    // ─── Slack: List Channels ───
    this.register({
      name: 'slack_list_channels',
      description:
        'List Slack channels visible to the bot. Input: {"workspaceId":"...","limit":200}',
      modes: ['build', 'launch'],
      execute: async (input) => {
        const { workspaceId, limit } = input as { workspaceId: string; limit?: number };
        const token = await this.resolveConnectorToken(workspaceId, 'slack');
        if (!token) return { error: 'Slack connector not authorized' };
        const { SlackConnector } = await import('@pilot/connectors');
        return new SlackConnector(token).listChannels(limit ? { limit } : undefined);
      },
    });

    // ─── Slack: Search ───
    this.register({
      name: 'slack_search',
      description:
        'Full-text search Slack messages. Input: {"workspaceId":"...","query":"...","limit":20}',
      modes: ['build', 'launch', 'discover'],
      execute: async (input) => {
        const { workspaceId, query, limit } = input as {
          workspaceId: string;
          query: string;
          limit?: number;
        };
        const token = await this.resolveConnectorToken(workspaceId, 'slack');
        if (!token) return { error: 'Slack connector not authorized' };
        const { SlackConnector } = await import('@pilot/connectors');
        return new SlackConnector(token).search(query, limit ? { limit } : undefined);
      },
    });

    // ─── Slack: Workspace Agent Receipt Trail ───
    this.register({
      name: 'slack_workspace_agent_reply',
      description:
        'Post a Pilot workspace-agent run summary into Slack with approval and receipt trail. Input: {"workspaceId":"...","channel":"C0123","title":"...","status":"queued|running|awaiting_approval|completed|blocked","steps":["..."],"approvals":[{"approvalId":"...","action":"...","status":"pending|approved|rejected","receiptId":"optional"}],"threadTs":"optional","evidencePackId":"optional","receiptUrl":"optional"}',
      modes: ['build', 'launch'],
      execute: async (input) => {
        const {
          workspaceId,
          channel,
          title,
          status,
          steps,
          approvals,
          threadTs,
          evidencePackId,
          receiptUrl,
        } = input as {
          workspaceId: string;
          channel: string;
          title: string;
          status: 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'blocked';
          steps?: string[];
          approvals?: Array<{
            approvalId: string;
            action: string;
            status: 'pending' | 'approved' | 'rejected';
            reason?: string;
            receiptId?: string;
          }>;
          threadTs?: string;
          evidencePackId?: string;
          receiptUrl?: string;
        };
        const token = await this.resolveConnectorToken(workspaceId, 'slack');
        if (!token) return { error: 'Slack connector not authorized' };
        const { SlackConnector } = await import('@pilot/connectors');
        const stepLines =
          steps && steps.length > 0
            ? steps.map((step, index) => `${index + 1}. ${step}`)
            : ['No steps reported.'];
        const approvalLines =
          approvals && approvals.length > 0
            ? approvals.map((approval) => {
                const receipt = approval.receiptId ? ` receipt=${approval.receiptId}` : '';
                const reason = approval.reason ? ` reason=${approval.reason}` : '';
                return `- ${approval.status}: ${approval.action} approval=${approval.approvalId}${receipt}${reason}`;
              })
            : ['No approvals required.'];
        const evidenceLines = [
          evidencePackId ? `Evidence pack: ${evidencePackId}` : undefined,
          receiptUrl ? `Receipt trail: ${receiptUrl}` : undefined,
        ].filter((line): line is string => Boolean(line));
        const text = [
          `*${title}*`,
          `Status: ${status}`,
          '',
          '*Steps*',
          ...stepLines,
          '',
          '*HELM approvals and receipts*',
          ...approvalLines,
          ...(evidenceLines.length > 0 ? ['', ...evidenceLines] : []),
        ].join('\n');
        return new SlackConnector(token).postMessage(
          channel,
          text,
          threadTs ? { threadTs } : undefined,
        );
      },
    });

    // ─── Notion: Search ───
    this.register({
      name: 'notion_search',
      description: 'Search Notion pages. Input: {"workspaceId":"...","query":"...","limit":20}',
      modes: ['discover', 'build', 'launch', 'apply'],
      execute: async (input) => {
        const { workspaceId, query, limit } = input as {
          workspaceId: string;
          query: string;
          limit?: number;
        };
        const token = await this.resolveConnectorToken(workspaceId, 'notion');
        if (!token)
          return {
            error:
              'Notion connector not authorized. Connect via /api/connectors/notion/oauth/initiate',
          };
        const { NotionConnector } = await import('@pilot/connectors');
        return new NotionConnector(token).search(query, limit ? { limit } : undefined);
      },
    });

    // ─── Notion: Create Page ───
    this.register({
      name: 'notion_create_page',
      description:
        'Create a Notion page. Input: {"workspaceId":"...","parentPageId":"...","title":"...","bodyParagraphs":["…","…"]}',
      modes: ['build', 'launch', 'apply'],
      execute: async (input) => {
        const { workspaceId, parentPageId, title, bodyParagraphs } = input as {
          workspaceId: string;
          parentPageId: string;
          title: string;
          bodyParagraphs?: string[];
        };
        const token = await this.resolveConnectorToken(workspaceId, 'notion');
        if (!token) return { error: 'Notion connector not authorized' };
        const { NotionConnector } = await import('@pilot/connectors');
        return new NotionConnector(token).createPage(parentPageId, title, bodyParagraphs);
      },
    });

    // ─── Notion: Get Page ───
    this.register({
      name: 'notion_get_page',
      description: 'Fetch a Notion page. Input: {"workspaceId":"...","pageId":"..."}',
      modes: ['discover', 'build', 'launch', 'apply'],
      execute: async (input) => {
        const { workspaceId, pageId } = input as { workspaceId: string; pageId: string };
        const token = await this.resolveConnectorToken(workspaceId, 'notion');
        if (!token) return { error: 'Notion connector not authorized' };
        const { NotionConnector } = await import('@pilot/connectors');
        return new NotionConnector(token).getPage(pageId);
      },
    });

    // ─── Parse PDF (Phase 15 Track K) ───
    this.register({
      name: 'parse_pdf',
      description:
        'Extract text from a PDF. Input: {"base64":"<pdf bytes base64-encoded>","previewChars":2000}. Returns: {text, pageCount, info, preview}. Requires pdf-parse to be installed.',
      execute: async (input) => {
        const { base64, previewChars } = input as {
          base64?: string;
          previewChars?: number;
        };
        if (typeof base64 !== 'string' || base64.length === 0) {
          return { error: 'base64 pdf bytes required' };
        }
        try {
          const { parsePdfBase64 } = await import('@pilot/shared/multimodal');
          return await parsePdfBase64(base64, previewChars ? { previewChars } : undefined);
        } catch (err) {
          return {
            error: err instanceof Error ? err.message : 'pdf parse failed',
          };
        }
      },
    });

    // ─── Analyze image (Phase 15 Track K) ───
    this.register({
      name: 'analyze_image',
      description:
        'Ask a question about an image. In production this tool is disabled unless image analysis is routed through HELM governance. Input: {"imageBase64":"<base64>","mediaType":"image/png|image/jpeg|image/gif|image/webp","question":"..."}.',
      execute: async (input) => {
        const { imageBase64, mediaType, question, maxTokens } = input as {
          imageBase64?: string;
          mediaType?: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
          question?: string;
          maxTokens?: number;
        };
        if (
          typeof imageBase64 !== 'string' ||
          typeof mediaType !== 'string' ||
          typeof question !== 'string'
        ) {
          return { error: 'imageBase64, mediaType, question all required' };
        }
        try {
          const { analyzeImage } = await import('@pilot/shared/multimodal');
          return await analyzeImage({
            imageBase64,
            mediaType,
            question,
            ...(maxTokens != null ? { maxTokens } : {}),
          });
        } catch (err) {
          return {
            error: err instanceof Error ? err.message : 'vision analysis failed',
          };
        }
      },
    });

    // ─── Stripe: List Customers ───
    this.register({
      name: 'stripe_list_customers',
      description: 'List most recent Stripe customers. Input: {"workspaceId":"...","limit":10}',
      modes: ['build', 'launch'],
      execute: async (input) => {
        const { workspaceId, limit } = input as { workspaceId: string; limit?: number };
        const token = await this.resolveConnectorToken(workspaceId, 'stripe');
        if (!token) return { error: 'Stripe connector not authorized' };
        const { StripeConnector } = await import('@pilot/connectors');
        return new StripeConnector(token).listCustomers(limit ? { limit } : undefined);
      },
    });

    // ─── Stripe: Recent Charges ───
    this.register({
      name: 'stripe_recent_charges',
      description: 'List recent Stripe charges. Input: {"workspaceId":"...","limit":10}',
      modes: ['build', 'launch'],
      execute: async (input) => {
        const { workspaceId, limit } = input as { workspaceId: string; limit?: number };
        const token = await this.resolveConnectorToken(workspaceId, 'stripe');
        if (!token) return { error: 'Stripe connector not authorized' };
        const { StripeConnector } = await import('@pilot/connectors');
        return new StripeConnector(token).recentCharges(limit ? { limit } : undefined);
      },
    });

    // ─── Stripe: Balance ───
    this.register({
      name: 'stripe_balance',
      description:
        'Current Stripe balance (available + pending in cents). Input: {"workspaceId":"..."}',
      modes: ['build', 'launch'],
      execute: async (input) => {
        const { workspaceId } = input as { workspaceId: string };
        const token = await this.resolveConnectorToken(workspaceId, 'stripe');
        if (!token) return { error: 'Stripe connector not authorized' };
        const { StripeConnector } = await import('@pilot/connectors');
        return new StripeConnector(token).balance();
      },
    });

    // ─── Calendar: List Events ───
    this.register({
      name: 'calendar_list_events',
      description:
        'List upcoming Google Calendar events. Input: {"workspaceId":"...","timeMinIso":"opt","timeMaxIso":"opt","limit":50}',
      modes: ['build', 'launch', 'apply'],
      execute: async (input) => {
        const { workspaceId, ...opts } = input as {
          workspaceId: string;
          calendarId?: string;
          timeMinIso?: string;
          timeMaxIso?: string;
          limit?: number;
        };
        const token = await this.resolveConnectorToken(workspaceId, 'calendar');
        if (!token) return { error: 'Calendar connector not authorized' };
        const { CalendarConnector } = await import('@pilot/connectors');
        return new CalendarConnector(token).listEvents(opts);
      },
    });

    // ─── Calendar: Create Event ───
    this.register({
      name: 'calendar_create_event',
      description:
        'Create a Google Calendar event. Input: {"workspaceId":"...","summary":"...","startIso":"2026-04-20T10:00:00Z","endIso":"2026-04-20T11:00:00Z","attendees":["a@b"]}',
      modes: ['build', 'launch', 'apply'],
      execute: async (input) => {
        const { workspaceId, ...payload } = input as {
          workspaceId: string;
          summary: string;
          description?: string;
          startIso: string;
          endIso: string;
          timeZone?: string;
          attendees?: string[];
          calendarId?: string;
        };
        const token = await this.resolveConnectorToken(workspaceId, 'calendar');
        if (!token) return { error: 'Calendar connector not authorized' };
        const { CalendarConnector } = await import('@pilot/connectors');
        return new CalendarConnector(token).createEvent(payload);
      },
    });

    // ─── HubSpot: List Contacts ───
    this.register({
      name: 'hubspot_list_contacts',
      description: 'List recent HubSpot contacts. Input: {"workspaceId":"...","limit":25}',
      modes: ['build', 'launch'],
      execute: async (input) => {
        const { workspaceId, limit } = input as { workspaceId: string; limit?: number };
        const token = await this.resolveConnectorToken(workspaceId, 'hubspot');
        if (!token) return { error: 'HubSpot connector not authorized' };
        const { HubSpotConnector } = await import('@pilot/connectors');
        return new HubSpotConnector(token).listContacts(limit ? { limit } : undefined);
      },
    });

    // ─── HubSpot: Create Contact ───
    this.register({
      name: 'hubspot_create_contact',
      description:
        'Create a HubSpot contact. Input: {"workspaceId":"...","email":"...","firstName":"opt","lastName":"opt","company":"opt"}',
      modes: ['build', 'launch'],
      execute: async (input) => {
        const { workspaceId, ...payload } = input as {
          workspaceId: string;
          email: string;
          firstName?: string;
          lastName?: string;
          company?: string;
        };
        const token = await this.resolveConnectorToken(workspaceId, 'hubspot');
        if (!token) return { error: 'HubSpot connector not authorized' };
        const { HubSpotConnector } = await import('@pilot/connectors');
        return new HubSpotConnector(token).createContact(payload);
      },
    });

    // ─── HubSpot: List Deals ───
    this.register({
      name: 'hubspot_list_deals',
      description: 'List recent HubSpot deals. Input: {"workspaceId":"...","limit":25}',
      modes: ['build', 'launch'],
      execute: async (input) => {
        const { workspaceId, limit } = input as { workspaceId: string; limit?: number };
        const token = await this.resolveConnectorToken(workspaceId, 'hubspot');
        if (!token) return { error: 'HubSpot connector not authorized' };
        const { HubSpotConnector } = await import('@pilot/connectors');
        return new HubSpotConnector(token).listDeals(limit ? { limit } : undefined);
      },
    });

    // ─── Google Drive: Read File ───
    this.register({
      name: 'gdrive_read',
      description: 'Read a file from Google Drive. Input: {"workspaceId": "...", "fileId": "..."}',
      modes: ['build', 'launch'],
      execute: async (input) => {
        const { workspaceId, fileId } = input as { workspaceId: string; fileId: string };
        const token = await this.resolveConnectorToken(workspaceId, 'gdrive');
        if (!token) return { error: 'Google Drive connector not authorized' };
        const { DriveConnector } = await import('@pilot/connectors');
        const drive = new DriveConnector(token);
        const content = await drive.readFile(fileId);
        const meta = await drive.getFile(fileId);
        return { name: meta.name, mimeType: meta.mimeType, content: content.slice(0, 10000) };
      },
    });
  }

  /**
   * Resolve an OAuth token for a connector from the workspace's active grant.
   * Returns null if no grant or token exists.
   */
  private async loadActiveBrowserGrant(input: {
    workspaceId: string;
    sessionId: string;
    grantId: string;
  }): Promise<
    | {
        allowedOrigins: string[];
        grantedToType: string;
        grantedToId?: string;
      }
    | { error: string }
  > {
    const { browserSessionGrants, browserSessions } = await import('@pilot/db/schema');
    const { and, eq } = await import('drizzle-orm');
    const [session] = await this.db
      .select()
      .from(browserSessions)
      .where(
        and(
          eq(browserSessions.id, input.sessionId),
          eq(browserSessions.workspaceId, input.workspaceId),
          eq(browserSessions.status, 'active'),
        ),
      )
      .limit(1);
    if (!session) return { error: 'active browser session not found' };

    const [grant] = await this.db
      .select()
      .from(browserSessionGrants)
      .where(
        and(
          eq(browserSessionGrants.id, input.grantId),
          eq(browserSessionGrants.sessionId, input.sessionId),
          eq(browserSessionGrants.workspaceId, input.workspaceId),
          eq(browserSessionGrants.status, 'active'),
        ),
      )
      .limit(1);
    if (!grant) return { error: 'active browser grant not found' };

    const grantOrigins = normalizeOrigins(asStringArray(grant.allowedOrigins));
    const sessionOrigins = normalizeOrigins(asStringArray(session.allowedOrigins));
    const allowedOrigins = grantOrigins.length > 0 ? grantOrigins : sessionOrigins;
    if (allowedOrigins.length === 0) return { error: 'browser grant has no allowed origins' };
    return {
      allowedOrigins,
      grantedToType: String(grant.grantedToType ?? 'agent'),
      grantedToId: typeof grant.grantedToId === 'string' ? grant.grantedToId : undefined,
    };
  }

  private async resolveConnectorToken(
    workspaceId: string,
    connectorName: string,
  ): Promise<string | null> {
    try {
      const { connectors, connectorGrants, connectorTokens } = await import('@pilot/db/schema');
      const { eq, and } = await import('drizzle-orm');
      const { decryptToken } = await import('@pilot/connectors');

      // Find the connector
      const [connector] = await this.db
        .select()
        .from(connectors)
        .where(eq(connectors.name, connectorName))
        .limit(1);
      if (!connector) return null;

      // Find active grant for this workspace
      const [grant] = await this.db
        .select()
        .from(connectorGrants)
        .where(
          and(
            eq(connectorGrants.workspaceId, workspaceId),
            eq(connectorGrants.connectorId, connector.id),
            eq(connectorGrants.isActive, true),
          ),
        )
        .limit(1);
      if (!grant) return null;

      // Get the token
      const [tokenRow] = await this.db
        .select()
        .from(connectorTokens)
        .where(eq(connectorTokens.grantId, grant.id))
        .limit(1);
      if (!tokenRow?.accessTokenEnc) return null;

      try {
        return decryptToken(tokenRow.accessTokenEnc);
      } catch {
        return tokenRow.accessTokenEnc; // fallback: pre-encryption
      }
    } catch {
      return null;
    }
  }
}

export type ToolRiskClass = 'low' | 'medium' | 'high' | 'restricted';
export type ToolEffectLevel = 'E1' | 'E2' | 'E3' | 'E4';

export interface ToolManifest {
  key: string;
  version: string;
  riskClass: ToolRiskClass;
  effectLevel: ToolEffectLevel;
  requiredEvidence: string[];
  permissionRequirements: string[];
  outputSensitivity: 'public' | 'internal' | 'sensitive';
}

export interface Tool {
  name: string;
  description: string;
  /** If set, tool is only available in these product modes. Unset = all modes. */
  modes?: string[];
  manifest?: Partial<ToolManifest>;
  stub?: boolean;
  capabilityKey?: CapabilityKey;
  execute: (input: unknown) => Promise<unknown>;
}

export const BROKERED_TOOL_CONTEXT: unique symbol = Symbol('pilot.tool_broker_context');

export interface ToolExecutionContext {
  workspaceId: string;
  taskId: string;
  userId?: string;
  operatorId?: string;
  approvalId?: string;
  policyVersion?: string;
  policyDecisionId?: string;
  helmDocumentVersionPins?: Record<string, string>;
  actionHash?: string;
  parentTaskRunId?: string;
  rootTaskRunId?: string;
  ventureId?: string;
  missionId?: string;
  actionId?: string;
  evidenceIds?: string[];
  [BROKERED_TOOL_CONTEXT]?: true;
}

export function markBrokeredToolContext(context: ToolExecutionContext): ToolExecutionContext {
  return { ...context, [BROKERED_TOOL_CONTEXT]: true };
}

function normalizeToolManifest(name: string, manifest?: Partial<ToolManifest>): ToolManifest {
  const effectLevel = manifest?.effectLevel ?? inferToolEffectLevel(name);
  return {
    key: manifest?.key ?? name,
    version: manifest?.version ?? 'inferred:v1',
    riskClass: manifest?.riskClass ?? effectLevelToRiskClass(effectLevel),
    effectLevel,
    requiredEvidence: manifest?.requiredEvidence ?? inferRequiredEvidence(name),
    permissionRequirements: manifest?.permissionRequirements ?? [`tool:${name}:execute`],
    outputSensitivity: manifest?.outputSensitivity ?? inferOutputSensitivity(name),
  };
}

function inferToolEffectLevel(name: string): ToolEffectLevel {
  if (
    name.includes('delete') ||
    name.includes('stripe') ||
    name.includes('payment') ||
    name.includes('domain.purchase') ||
    name.includes('company_formation')
  ) {
    return 'E4';
  }
  if (
    name.includes('deploy') ||
    name.includes('rollback') ||
    name.includes('send') ||
    name.includes('write') ||
    name.includes('subagent.')
  ) {
    return 'E3';
  }
  if (name.includes('scrapling') || name.includes('mcp.') || name.includes('fetch')) return 'E2';
  return 'E1';
}

function effectLevelToRiskClass(effectLevel: ToolEffectLevel): ToolRiskClass {
  if (effectLevel === 'E4') return 'restricted';
  if (effectLevel === 'E3') return 'high';
  if (effectLevel === 'E2') return 'medium';
  return 'low';
}

function validateElevatedToolExecutionContext(
  name: string,
  manifest: ToolManifest,
  context?: ToolExecutionContext,
): { error: string; missingContext: string[]; manifest: Partial<ToolManifest> } | null {
  if (!isElevatedToolManifest(manifest)) return null;

  const missingContext = [
    ...(context?.[BROKERED_TOOL_CONTEXT] === true ? [] : ['tool_broker_context']),
    ...(context?.workspaceId ? [] : ['workspaceId']),
    ...(context?.taskId ? [] : ['taskId']),
    ...(context?.actionId ? [] : ['actionId']),
    ...(context?.policyDecisionId ? [] : ['policyDecisionId']),
    ...(context?.policyVersion ? [] : ['policyVersion']),
  ];
  if (missingContext.length === 0) return null;

  return {
    error: `Tool ${name} requires Tool Broker + HELM context for elevated execution`,
    missingContext,
    manifest: {
      key: manifest.key,
      version: manifest.version,
      riskClass: manifest.riskClass,
      effectLevel: manifest.effectLevel,
    },
  };
}

function isElevatedToolManifest(manifest: ToolManifest): boolean {
  return (
    manifest.riskClass === 'medium' ||
    manifest.riskClass === 'high' ||
    manifest.riskClass === 'restricted' ||
    manifest.effectLevel === 'E2' ||
    manifest.effectLevel === 'E3' ||
    manifest.effectLevel === 'E4'
  );
}

function inferRequiredEvidence(name: string): string[] {
  if (name === 'finish') return ['run_summary'];
  if (name === 'score_opportunity') return ['opportunity_score', 'citations'];
  if (name.includes('scrapling') || name.includes('fetch')) return ['source_snapshot'];
  if (name.includes('deploy') || name.includes('rollback')) return ['deployment_log'];
  if (name.includes('subagent.')) return ['subagent_run_summary'];
  return ['tool_result'];
}

function inferOutputSensitivity(name: string): ToolManifest['outputSensitivity'] {
  if (name.includes('connector') || name.includes('email') || name.includes('mcp.')) {
    return 'sensitive';
  }
  return 'internal';
}

function isExplicitDemoToolMode(): boolean {
  return process.env['PILOT_TOOL_DEMO_MODE'] === '1';
}

function bindToolContext(input: unknown, context: ToolExecutionContext): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  return {
    ...(input as Record<string, unknown>),
    workspaceId: context.workspaceId,
    taskId: context.taskId,
    ...(context.userId ? { userId: context.userId } : {}),
    ...(context.operatorId ? { operatorId: context.operatorId } : {}),
    ...(context.approvalId ? { approvalId: context.approvalId } : {}),
    ...(context.policyVersion ? { policyVersion: context.policyVersion } : {}),
    ...(context.policyDecisionId ? { policyDecisionId: context.policyDecisionId } : {}),
    ...(context.helmDocumentVersionPins
      ? { helmDocumentVersionPins: context.helmDocumentVersionPins }
      : {}),
    ...(context.actionHash ? { actionHash: context.actionHash } : {}),
    ...(context.parentTaskRunId ? { parentTaskRunId: context.parentTaskRunId } : {}),
    ...(context.rootTaskRunId ? { rootTaskRunId: context.rootTaskRunId } : {}),
    ...(context.ventureId ? { ventureId: context.ventureId } : {}),
    ...(context.missionId ? { missionId: context.missionId } : {}),
    ...(context.actionId ? { actionId: context.actionId } : {}),
  };
}

function parentContextFromBrokerInput(parentCtx: ParentContext, input: unknown): ParentContext {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return parentCtx;
  const record = input as Record<string, unknown>;
  const policyDecisionId = optionalString(record['policyDecisionId']);
  const policyVersion = optionalString(record['policyVersion']);
  const actionId = optionalString(record['actionId']);
  const ventureId = optionalString(record['ventureId']);
  const missionId = optionalString(record['missionId']);
  const helmDocumentVersionPins = stringRecord(record['helmDocumentVersionPins']);
  return {
    ...parentCtx,
    ...(policyDecisionId ? { policyDecisionId } : {}),
    ...(policyVersion ? { policyVersion } : {}),
    ...(actionId ? { brokeredActionId: actionId } : {}),
    ...(ventureId ? { ventureId } : {}),
    ...(missionId ? { missionId } : {}),
    ...(helmDocumentVersionPins ? { helmDocumentVersionPins } : {}),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, string] =>
      typeof entry[0] === 'string' && typeof entry[1] === 'string',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeOrigins(origins: string[]) {
  return Array.from(
    new Set(
      origins.map((origin) => {
        const url = new URL(origin);
        return url.origin;
      }),
    ),
  );
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function hashText(text: string) {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function browserHelmDocumentVersionPins(policyVersion: string): Record<string, string> {
  return { browserReadPolicy: policyVersion };
}

const SENSITIVE_BROWSER_TEXT_PATTERNS: Array<[RegExp, string]> = [
  [
    /((?:name|id)=["']?(?:password|passwd|pwd|token|secret|cookie|session)[^>]*\bvalue=["']?)[^"'>\s]+/giu,
    '$1[REDACTED]',
  ],
  [/(password|passwd|pwd)(\s*[:=]\s*)(["']?)[^"'\s<>&]+/giu, '$1$2$3[REDACTED]'],
  [/(token|secret|api[_-]?key|authorization)(\s*[:=]\s*)(["']?)[^"'\s<>&]+/giu, '$1$2$3[REDACTED]'],
  [/(session|cookie)(\s*[:=]\s*)(["']?)[^"'\s<>&]+/giu, '$1$2$3[REDACTED]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gu, '$1[REDACTED]'],
];

function redactBrowserText(text: string) {
  let redacted = text;
  const redactions: string[] = [];
  for (const [pattern, replacement] of SENSITIVE_BROWSER_TEXT_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(redacted)) {
      redactions.push(pattern.source);
      pattern.lastIndex = 0;
      redacted = redacted.replace(pattern, replacement);
    }
  }
  return { text: redacted, redactions };
}

function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => {
      if (/password|passwd|pwd|token|secret|api[_-]?key|authorization|cookie|session/iu.test(key)) {
        return [key, '[REDACTED]'];
      }
      if (typeof child === 'string') return [key, redactBrowserText(child).text];
      return [key, redactJson(child)];
    }),
  );
}

function redactRecord(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const redacted = redactJson(value ?? {});
  return redacted && typeof redacted === 'object' && !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : {};
}
