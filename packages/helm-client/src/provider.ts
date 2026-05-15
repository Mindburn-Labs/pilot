import type { LlmGovernance, LlmProvider, LlmResult } from '@pilot/shared/llm';
import { HelmClient } from './client.js';
import { HelmDeniedError, HelmEscalationError } from './errors.js';
import type { HelmReceipt } from './types.js';

export interface HelmLlmProviderOptions {
  /**
   * Required. HELM-governed client that owns the proxy hop to helm-ai-kernel.
   */
  helm: HelmClient;
  /**
   * Principal presented on every request. The AgentLoop overrides this per
   * invocation; the constructor-level default is used when no caller supplies
   * one (fallback for offline tools, health probes, etc.).
   */
  defaultPrincipal: string;
  /**
   * Model to request from HELM's upstream. HELM enforces its own `allowed
   * models` policy; this is just the model field in the request body.
   */
  model: string;
  /**
   * Temperature, max_tokens, etc. passed through to HELM which forwards to the
   * upstream. Defaults match the direct providers' behaviour for parity.
   */
  temperature?: number;
  maxTokens?: number;
}

/**
 * LLM provider whose every call is proxied through HELM's Guardian pipeline.
 *
 * Differences vs the direct providers:
 *   - Every returned LlmResult carries a `governance` field with the decision
 *     id, verdict, policy version, and signed blob when present.
 *   - DENY responses throw (caught by the AgentLoop and converted to a
 *     `verdict: 'deny'` action record with the receipt id attached).
 *   - ESCALATE throws a distinct error so the orchestrator can route through
 *     the existing approval flow.
 *   - HELM unreachability is fail-closed: the provider rethrows the error so
 *     the AgentLoop ends the iteration with `status: 'blocked'` instead of
 *     silently executing.
 */
export class HelmLlmProvider implements LlmProvider {
  constructor(private readonly opts: HelmLlmProviderOptions) {}

  async complete(prompt: string): Promise<string> {
    const result = await this.completeWithUsage(prompt);
    return result.content;
  }

  async completeWithUsage(prompt: string): Promise<LlmResult> {
    // Passing the principal via options.defaultPrincipal only today. A future
    // slice will plumb an optional per-call principal through LlmProvider once
    // operators carry a stable identity.
    const { body, receipt } = await this.opts.helm.chatCompletion(this.opts.defaultPrincipal, {
      model: this.opts.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: this.opts.temperature ?? 0.3,
      max_tokens: this.opts.maxTokens ?? 2000,
    });

    const content = body.choices?.[0]?.message?.content;
    if (!content) throw new Error('HelmLlmProvider: upstream returned no content');

    return {
      content,
      usage: {
        tokensIn: body.usage?.prompt_tokens ?? 0,
        tokensOut: body.usage?.completion_tokens ?? 0,
        model: body.model ?? this.opts.model,
      },
      governance: toGovernance(receipt),
    };
  }
}

function toGovernance(r: HelmReceipt): LlmGovernance {
  return {
    decisionId: r.decisionId,
    verdict: r.verdict,
    policyVersion: r.policyVersion,
    decisionHash: r.decisionHash,
    reason: r.reason,
    principal: r.principal,
  };
}

/**
 * Re-export for callers who want to distinguish HELM-origin errors without
 * importing from @pilot/helm-client/errors.
 */
export { HelmDeniedError, HelmEscalationError };
