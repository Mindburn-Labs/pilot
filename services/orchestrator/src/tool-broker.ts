import { createHash, randomUUID } from 'node:crypto';
import { appendEvidenceItem } from '@pilot/db';
import { actions, auditLog, toolExecutions } from '@pilot/db/schema';
import { and, eq } from 'drizzle-orm';
import { type Db } from '@pilot/db/client';
import {
  markBrokeredToolContext,
  type ToolExecutionContext,
  type ToolManifest,
  type ToolRegistry,
} from './tools.js';

export interface BrokeredToolResult {
  output: unknown;
  actionId: string;
  toolExecutionId: string;
  inputHash: string;
  outputHash: string;
  status: 'completed' | 'failed';
  evidenceItemId: string;
}

type BrokerTx = Pick<Db, 'insert' | 'update'>;
type BrokerDb = BrokerTx & Pick<Db, 'transaction'>;

export class ToolBroker {
  constructor(private readonly db: BrokerDb) {}

  async execute(
    registry: ToolRegistry,
    toolName: string,
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<BrokeredToolResult> {
    const getManifest = (
      registry as { getToolManifest?: (name: string) => ToolManifest | undefined }
    ).getToolManifest;
    const manifest =
      typeof getManifest === 'function'
        ? (getManifest.call(registry, toolName) ?? defaultToolManifest(toolName))
        : defaultToolManifest(toolName);
    assertElevatedPolicyContext(manifest, toolName, context);
    const sanitizedInput = toJsonValue(input);
    const inputHash = hashJson({ tool: toolName, input: sanitizedInput });
    const idempotencyKey = buildIdempotencyKey(context, toolName, inputHash);
    const actorType = context.operatorId ? 'operator' : 'agent';
    const policyPin = buildPolicyPin(manifest, context);

    const [action] = await this.db
      .insert(actions)
      .values({
        workspaceId: context.workspaceId,
        ventureId: context.ventureId ?? null,
        missionId: context.missionId ?? null,
        taskId: context.taskId,
        taskRunId: context.parentTaskRunId ?? null,
        actorType,
        actorId: context.operatorId ?? null,
        actionKey: toolName,
        actionType: 'tool',
        riskClass: manifest.riskClass,
        status: 'running',
        inputHash,
        policyDecisionId: policyPin.policyDecisionId,
        policyVersion: policyPin.policyVersion,
        helmDocumentVersionPins: policyPin.documentVersionPins,
        metadata: {
          broker: 'tool_broker_v1',
          manifest,
          actionHash: context.actionHash ?? null,
          approvalId: context.approvalId ?? null,
          policyPin,
        },
      })
      .returning({ id: actions.id });

    if (!action?.id) throw new Error(`Tool Broker could not persist action for ${toolName}`);

    const [execution] = await this.db
      .insert(toolExecutions)
      .values({
        workspaceId: context.workspaceId,
        ventureId: context.ventureId ?? null,
        missionId: context.missionId ?? null,
        actionId: action.id,
        taskRunId: context.parentTaskRunId ?? null,
        toolKey: toolName,
        inputHash,
        sanitizedInput,
        status: 'running',
        idempotencyKey,
        evidenceIds: context.evidenceIds ?? [],
        policyDecisionId: policyPin.policyDecisionId,
        policyVersion: policyPin.policyVersion,
        helmDocumentVersionPins: policyPin.documentVersionPins,
      })
      .returning({ id: toolExecutions.id });

    if (!execution?.id) {
      throw new Error(`Tool Broker could not persist tool execution for ${toolName}`);
    }

    const output = await registry.execute(
      toolName,
      input,
      markBrokeredToolContext({
        ...context,
        actionId: action.id,
      }),
    );
    const sanitizedOutput = toJsonValue(output);
    const outputHash = hashJson({ tool: toolName, output: sanitizedOutput });
    const status = isToolError(output) ? 'failed' : 'completed';
    const error = status === 'failed' ? stringifyError(output) : null;
    const evidenceIds = uniqueStrings([
      ...(context.evidenceIds ?? []),
      ...collectEvidenceIds(sanitizedOutput),
    ]);

    const auditEventId = randomUUID();
    const evidenceInput = {
      workspaceId: context.workspaceId,
      ventureId: context.ventureId ?? null,
      missionId: context.missionId ?? null,
      taskId: context.taskId,
      taskRunId: context.parentTaskRunId ?? null,
      actionId: action.id,
      toolExecutionId: execution.id,
      auditEventId,
      evidenceType: status === 'completed' ? 'tool_execution_completed' : 'tool_execution_failed',
      sourceType: 'tool_broker',
      title: `Tool execution ${status}: ${toolName}`,
      summary:
        status === 'completed'
          ? `Tool Broker completed ${toolName}.`
          : `Tool Broker recorded a failed ${toolName} result.`,
      redactionState: 'redacted',
      sensitivity: manifest.outputSensitivity,
      contentHash: outputHash,
      replayRef: `tool:${execution.id}`,
      metadata: {
        broker: 'tool_broker_v1',
        toolKey: toolName,
        actionId: action.id,
        toolExecutionId: execution.id,
        idempotencyKey,
        status,
        riskClass: manifest.riskClass,
        effectLevel: manifest.effectLevel,
        manifestVersion: manifest.version,
        requiredEvidence: manifest.requiredEvidence,
        permissionRequirements: manifest.permissionRequirements,
        inputHash,
        outputHash,
        evidenceIds,
        policyDecisionId: policyPin.policyDecisionId,
        policyVersion: policyPin.policyVersion,
        helmDocumentVersionPins: policyPin.documentVersionPins,
        policyPin,
        credentialBoundary: 'sanitized_input_output_only',
      },
    } satisfies Parameters<typeof appendEvidenceItem>[1];

    let finalEvidenceItemId: string;
    try {
      finalEvidenceItemId = await this.db.transaction(async (tx) => {
        const db = tx as unknown as BrokerTx;
        const auditMetadata = {
          broker: 'tool_broker_v1',
          actionId: action.id,
          toolExecutionId: execution.id,
          toolKey: toolName,
          idempotencyKey,
          inputHash,
          outputHash,
          riskClass: manifest.riskClass,
          evidenceIds,
          policyDecisionId: policyPin.policyDecisionId,
          policyVersion: policyPin.policyVersion,
          helmDocumentVersionPins: policyPin.documentVersionPins,
          policyPin,
        };

        await db.insert(auditLog).values({
          id: auditEventId,
          workspaceId: context.workspaceId,
          action: 'TOOL_EXECUTION',
          actor: actorType === 'operator' ? `operator:${context.operatorId}` : 'agent',
          target: toolName,
          verdict: status === 'completed' ? 'allow' : 'error',
          reason: error,
          metadata: auditMetadata,
        });

        const evidenceItemId = await appendEvidenceItem(db, evidenceInput);
        const persistedEvidenceIds = uniqueStrings([...evidenceIds, evidenceItemId]);

        await db
          .update(toolExecutions)
          .set({
            status,
            outputHash,
            sanitizedOutput,
            evidenceIds: persistedEvidenceIds,
            error,
            completedAt: new Date(),
          })
          .where(eq(toolExecutions.id, execution.id));

        await db
          .update(actions)
          .set({
            status,
            outputHash,
            completedAt: new Date(),
          })
          .where(eq(actions.id, action.id));

        await db
          .update(auditLog)
          .set({
            metadata: {
              ...auditMetadata,
              evidenceItemId,
              evidenceIds: persistedEvidenceIds,
            },
          })
          .where(and(eq(auditLog.workspaceId, context.workspaceId), eq(auditLog.id, auditEventId)));

        return evidenceItemId;
      });
    } catch (evidenceError) {
      if (isElevatedManifest(manifest)) {
        try {
          await this.markElevatedEvidencePersistenceFailure({
            actionId: action.id,
            toolExecutionId: execution.id,
            toolName,
            context,
            manifest,
            outputHash,
            sanitizedOutput,
            error: evidenceError,
          });
        } catch (failurePersistenceError) {
          throw new Error(
            `Tool Broker could not persist elevated ${toolName} evidence-failure audit: ${stringifyError(failurePersistenceError)}`,
          );
        }
      }
      throw new Error(
        `Tool Broker blocked ${isElevatedManifest(manifest) ? 'elevated ' : ''}${toolName} completion: ${stringifyError(evidenceError)}`,
      );
    }

    return {
      output,
      actionId: action.id,
      toolExecutionId: execution.id,
      inputHash,
      outputHash,
      status,
      evidenceItemId: finalEvidenceItemId,
    };
  }

  private async markElevatedEvidencePersistenceFailure(params: {
    actionId: string;
    toolExecutionId: string;
    toolName: string;
    context: ToolExecutionContext;
    manifest: ToolManifest;
    outputHash: string;
    sanitizedOutput: unknown;
    error: unknown;
  }) {
    const reason = `evidence persistence failed for elevated tool execution: ${stringifyError(
      params.error,
    )}`;
    const policyPin = buildPolicyPin(params.manifest, params.context);
    await this.db.transaction(async (tx) => {
      const db = tx as unknown as BrokerTx;
      await db
        .update(toolExecutions)
        .set({
          status: 'failed',
          outputHash: params.outputHash,
          sanitizedOutput: params.sanitizedOutput,
          evidenceIds: params.context.evidenceIds ?? [],
          error: reason,
          completedAt: new Date(),
        })
        .where(eq(toolExecutions.id, params.toolExecutionId));

      await db
        .update(actions)
        .set({
          status: 'failed',
          outputHash: params.outputHash,
          completedAt: new Date(),
        })
        .where(eq(actions.id, params.actionId));

      await db.insert(auditLog).values({
        workspaceId: params.context.workspaceId,
        action: 'TOOL_EXECUTION',
        actor: params.context.operatorId ? `operator:${params.context.operatorId}` : 'agent',
        target: params.toolName,
        verdict: 'error',
        reason,
        metadata: {
          broker: 'tool_broker_v1',
          actionId: params.actionId,
          toolExecutionId: params.toolExecutionId,
          toolKey: params.toolName,
          riskClass: params.manifest.riskClass,
          effectLevel: params.manifest.effectLevel,
          evidenceRequired: true,
          evidencePersistenceRequired: 'fail_closed_for_elevated_actions',
          policyDecisionId: params.context.policyDecisionId ?? null,
          policyVersion: policyVersionFor(params.manifest, params.context),
          helmDocumentVersionPins: policyPin.documentVersionPins,
          policyPin,
        },
      });
    });
  }
}

export function defaultToolManifest(toolName: string): ToolManifest {
  const effectLevel = inferEffectLevel(toolName);
  return {
    key: toolName,
    version: 'inferred:v1',
    riskClass: effectLevelToRiskClass(effectLevel),
    effectLevel,
    requiredEvidence: inferRequiredEvidence(toolName),
    permissionRequirements: [`tool:${toolName}:execute`],
    outputSensitivity: inferOutputSensitivity(toolName),
  };
}

function inferEffectLevel(toolName: string): ToolManifest['effectLevel'] {
  if (toolName === 'operator.computer_use') return 'E3';
  if (toolName === 'operator.browser_read') return 'E2';
  if (
    toolName.includes('delete') ||
    toolName.includes('stripe') ||
    toolName.includes('payment') ||
    toolName.includes('domain.purchase') ||
    toolName.includes('company_formation')
  ) {
    return 'E4';
  }
  if (
    toolName.includes('deploy') ||
    toolName.includes('rollback') ||
    toolName.includes('send') ||
    toolName.includes('write') ||
    toolName.includes('subagent.')
  ) {
    return 'E3';
  }
  if (toolName.includes('scrapling') || toolName.includes('mcp.') || toolName.includes('fetch')) {
    return 'E2';
  }
  return 'E1';
}

function effectLevelToRiskClass(effectLevel: ToolManifest['effectLevel']) {
  if (effectLevel === 'E4') return 'restricted';
  if (effectLevel === 'E3') return 'high';
  if (effectLevel === 'E2') return 'medium';
  return 'low';
}

function assertElevatedPolicyContext(
  manifest: ToolManifest,
  toolName: string,
  context: ToolExecutionContext,
): void {
  if (!isElevatedManifest(manifest)) return;
  if (context.policyDecisionId && context.policyVersion) return;

  throw new Error(
    `Tool Broker refused elevated tool ${toolName}: HELM policy decision metadata is required before execution`,
  );
}

function isElevatedManifest(manifest: ToolManifest): boolean {
  return (
    manifest.riskClass === 'medium' ||
    manifest.riskClass === 'high' ||
    manifest.riskClass === 'restricted' ||
    manifest.effectLevel === 'E2' ||
    manifest.effectLevel === 'E3' ||
    manifest.effectLevel === 'E4'
  );
}

function policyVersionFor(manifest: ToolManifest, context: ToolExecutionContext): string {
  return context.policyVersion ?? `local:tool-broker:${manifest.version}:${manifest.effectLevel}`;
}

function buildPolicyPin(manifest: ToolManifest, context: ToolExecutionContext) {
  const policyVersion = policyVersionFor(manifest, context);
  const documentVersionPins = context.helmDocumentVersionPins ?? {
    toolAccessPolicy: policyVersion,
  };
  return {
    policyDecisionId: context.policyDecisionId ?? null,
    policyVersion,
    decisionRequired: isElevatedManifest(manifest),
    documentVersionPins,
  };
}

function inferRequiredEvidence(toolName: string): string[] {
  if (toolName === 'finish') return ['run_summary'];
  if (toolName === 'operator.computer_use') return ['computer_action', 'helm_receipt'];
  if (toolName === 'operator.browser_read') return ['browser_observation', 'helm_receipt'];
  if (toolName === 'score_opportunity') return ['opportunity_score', 'citations'];
  if (toolName.includes('scrapling') || toolName.includes('fetch')) return ['source_snapshot'];
  if (toolName.includes('deploy') || toolName.includes('rollback')) return ['deployment_log'];
  if (toolName.includes('subagent.')) return ['subagent_run_summary'];
  return ['tool_result'];
}

function inferOutputSensitivity(toolName: string): ToolManifest['outputSensitivity'] {
  if (toolName === 'operator.computer_use' || toolName === 'operator.browser_read') {
    return 'sensitive';
  }
  if (toolName.includes('connector') || toolName.includes('email') || toolName.includes('mcp.')) {
    return 'sensitive';
  }
  return 'internal';
}

function buildIdempotencyKey(context: ToolExecutionContext, toolName: string, inputHash: string) {
  return [
    'tool-broker-v1',
    context.workspaceId,
    context.taskId,
    toolName,
    context.actionHash ?? inputHash,
    context.approvalId ?? 'direct',
  ].join(':');
}

function toJsonValue(value: unknown) {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function hashJson(value: unknown) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortJson);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function isToolError(output: unknown): boolean {
  return (
    typeof output === 'object' &&
    output !== null &&
    !Array.isArray(output) &&
    typeof (output as Record<string, unknown>)['error'] === 'string'
  );
}

function stringifyError(value: unknown) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function collectEvidenceIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectEvidenceIds);
  if (!value || typeof value !== 'object') return [];

  const record = value as Record<string, unknown>;
  const direct = [
    typeof record['evidencePackId'] === 'string' ? record['evidencePackId'] : undefined,
    typeof record['evidenceId'] === 'string' ? record['evidenceId'] : undefined,
  ].filter((item): item is string => Boolean(item));
  const listed = Array.isArray(record['evidenceIds'])
    ? record['evidenceIds'].filter((item): item is string => typeof item === 'string')
    : [];

  return [
    ...direct,
    ...listed,
    ...Object.values(record).flatMap((child) =>
      child && typeof child === 'object' ? collectEvidenceIds(child) : [],
    ),
  ];
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}
