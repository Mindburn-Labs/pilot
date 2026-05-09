import { z } from 'zod';

// ─── WORKFLOW.md parser (Symphony-adopted) ───
//
// Parses a version-controlled WORKFLOW.md file (YAML front matter + markdown body)
// into a typed WorkflowConfig. This follows the Symphony SPEC pattern where
// teams version their agent prompt and runtime settings in-repo.
//
// Usage:
//   const config = parseWorkflow(rawMarkdownString);
//   const policyConfig = PolicyConfig.fromWorkflow(config);

export const WorkflowRetrySchema = z.object({
  max_attempts: z.number().int().min(1).max(10).default(3),
  initial_delay_ms: z.number().int().min(1000).max(60_000).default(10_000),
  backoff_multiplier: z.number().min(1).max(10).default(2),
  max_delay_ms: z.number().int().min(1000).max(600_000).default(300_000),
});

export const WorkflowOrchestratorSchema = z.object({
  max_concurrent: z.number().int().min(1).max(50).default(10),
  max_turns: z.number().int().min(1).max(100).default(1),
  poll_interval_ms: z.number().int().min(1000).max(300_000).default(30_000),
  stall_timeout_ms: z.number().int().min(10_000).max(3_600_000).default(300_000),
  retry: WorkflowRetrySchema.optional().default({}),
});

export const WorkflowHooksSchema = z.object({
  after_create: z.string().optional(),
  before_run: z.string().optional(),
  after_run: z.string().optional(),
  timeout_ms: z.number().int().min(1000).max(60_000).optional(),
});

export const WorkflowWorkspaceSchema = z.object({
  root: z.string().default('.'),
  hooks: WorkflowHooksSchema.optional(),
});

export const WorkflowConfigSchema = z.object({
  name: z.string().min(1),
  version: z.string().default('1.0.0'),
  orchestrator: WorkflowOrchestratorSchema.optional().default({}),
  workspace: WorkflowWorkspaceSchema.optional().default({}),
  active_states: z.array(z.string()).default(['pending', 'in_progress']),
  terminal_states: z.array(z.string()).default(['completed', 'failed', 'cancelled']),
  allowed_tools: z.array(z.string()).optional(),
  denied_tools: z.array(z.string()).optional(),
});

export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;
export type WorkflowOrchestrator = z.infer<typeof WorkflowOrchestratorSchema>;
export type WorkflowRetry = z.infer<typeof WorkflowRetrySchema>;

/** Result of parsing a WORKFLOW.md file. */
export interface WorkflowParseResult {
  config: WorkflowConfig;
  promptBody: string;
  rawYaml: string;
  contentHash: string;
}

/**
 * Parse a WORKFLOW.md file into typed config + prompt body.
 *
 * Format:
 * ```
 * ---
 * name: my-agent
 * version: 1.0.0
 * orchestrator:
 *   max_concurrent: 5
 *   stall_timeout_ms: 120000
 * ---
 *
 * # System Prompt
 * You are a helpful agent that...
 * ```
 */
export function parseWorkflow(rawContent: string): WorkflowParseResult {
  const { frontMatter, body } = extractFrontMatter(rawContent);

  // Parse YAML front matter
  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(frontMatter);
  } catch (err) {
    throw new WorkflowParseError(
      `Invalid YAML front matter: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Validate with Zod schema
  const result = WorkflowConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new WorkflowParseError(
      `WORKFLOW.md validation failed: ${result.error.message}`,
    );
  }

  // Compute content hash for change detection
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const contentHash = `sha256:${createHash('sha256').update(rawContent).digest('hex')}`;

  return {
    config: result.data,
    promptBody: body.trim(),
    rawYaml: frontMatter,
    contentHash,
  };
}

/** Extract YAML front matter (between --- delimiters) and the markdown body. */
function extractFrontMatter(raw: string): { frontMatter: string; body: string } {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('---')) {
    throw new WorkflowParseError('WORKFLOW.md must start with YAML front matter (---)');
  }

  const endIndex = trimmed.indexOf('---', 3);
  if (endIndex === -1) {
    throw new WorkflowParseError('WORKFLOW.md front matter not closed (missing closing ---)');
  }

  return {
    frontMatter: trimmed.slice(3, endIndex).trim(),
    body: trimmed.slice(endIndex + 3).trim(),
  };
}

/** Minimal YAML parser for flat and nested objects (no full YAML spec). */
function parseYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  let currentKey = '';
  let currentNested: Record<string, unknown> | null = null;

  for (const line of lines) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    const trimmedLine = line.trim();

    if (indent >= 2 && currentKey && currentNested !== null) {
      // Nested property
      const [key, ...valueParts] = trimmedLine.split(':');
      const value = valueParts.join(':').trim();
      if (key && value) {
        currentNested[key.trim()] = parseYamlValue(value);
      }
    } else {
      // Top-level property
      if (currentKey && currentNested !== null) {
        result[currentKey] = currentNested;
        currentNested = null;
      }

      const colonIdx = trimmedLine.indexOf(':');
      if (colonIdx === -1) continue;
      const key = trimmedLine.slice(0, colonIdx).trim();
      const value = trimmedLine.slice(colonIdx + 1).trim();

      if (value === '' || value === '|' || value === '>') {
        // Start nested object
        currentKey = key;
        currentNested = {};
      } else {
        currentKey = '';
        result[key] = parseYamlValue(value);
      }
    }
  }

  // Flush last nested
  if (currentKey && currentNested !== null) {
    result[currentKey] = currentNested;
  }

  return result;
}

function parseYamlValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return parseFloat(raw);
  if (raw.startsWith('[') && raw.endsWith(']')) {
    // Simple array: [a, b, c]
    return raw
      .slice(1, -1)
      .split(',')
      .map((s) => parseYamlValue(s.trim()))
      .filter((v) => v !== '');
  }
  // Strip quotes
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

export class WorkflowParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowParseError';
  }
}
