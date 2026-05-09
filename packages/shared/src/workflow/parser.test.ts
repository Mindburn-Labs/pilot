import { describe, it, expect } from 'vitest';
import { parseWorkflow, WorkflowParseError } from './parser.js';

describe('WORKFLOW.md parser', () => {
  it('parses valid front matter + body', () => {
    const raw = `---
name: test-agent
version: 2.0.0
orchestrator:
  max_concurrent: 5
  stall_timeout_ms: 120000
  max_turns: 3
---

# System Prompt
You are a helpful research assistant.`;

    const result = parseWorkflow(raw);
    expect(result.config.name).toBe('test-agent');
    expect(result.config.version).toBe('2.0.0');
    expect(result.config.orchestrator.max_concurrent).toBe(5);
    expect(result.config.orchestrator.stall_timeout_ms).toBe(120000);
    expect(result.config.orchestrator.max_turns).toBe(3);
    expect(result.promptBody).toContain('System Prompt');
    expect(result.promptBody).toContain('helpful research assistant');
    expect(result.contentHash).toMatch(/^sha256:/);
  });

  it('applies defaults for missing orchestrator fields', () => {
    const raw = `---
name: minimal-agent
---
Do something.`;

    const result = parseWorkflow(raw);
    expect(result.config.name).toBe('minimal-agent');
    expect(result.config.version).toBe('1.0.0');
    expect(result.config.orchestrator.max_concurrent).toBe(10);
    expect(result.config.orchestrator.stall_timeout_ms).toBe(300000);
    expect(result.config.orchestrator.max_turns).toBe(1);
    expect(result.config.orchestrator.retry.max_attempts).toBe(3);
  });

  it('rejects missing front matter', () => {
    expect(() => parseWorkflow('Just markdown.')).toThrow(WorkflowParseError);
  });

  it('rejects unclosed front matter', () => {
    expect(() => parseWorkflow('---\nname: broken\n')).toThrow(WorkflowParseError);
  });

  it('rejects missing name', () => {
    expect(() => parseWorkflow('---\nversion: 1.0.0\n---\nBody')).toThrow(WorkflowParseError);
  });

  it('produces stable content hashes', () => {
    const raw = `---\nname: hash-test\n---\nBody`;
    const h1 = parseWorkflow(raw).contentHash;
    const h2 = parseWorkflow(raw).contentHash;
    expect(h1).toBe(h2);
  });

  it('produces different hashes for different content', () => {
    const h1 = parseWorkflow('---\nname: a\n---\nA').contentHash;
    const h2 = parseWorkflow('---\nname: b\n---\nB').contentHash;
    expect(h1).not.toBe(h2);
  });

  it('parses active and terminal states', () => {
    const raw = `---
name: states-test
active_states: [pending, working]
terminal_states: [done, error]
---
Body`;

    const result = parseWorkflow(raw);
    expect(result.config.active_states).toEqual(['pending', 'working']);
    expect(result.config.terminal_states).toEqual(['done', 'error']);
  });
});
