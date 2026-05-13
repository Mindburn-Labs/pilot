# Pilot Production Readiness Checklist

Source of truth: `packages/shared/src/capabilities/index.ts`.

This checklist is operational. It does not make production autonomy claims. A capability is production-ready only when the shared registry marks it `production_ready` with passing eval metadata and evidence references.

## Current Status

- Production-ready capabilities: `0/18`.
- Current eval executor: `control_plane_proof_check`.
- Required promotion executor: `real_external_eval`.
- Promotion rule: local tests, GitHub checks, and control-plane proof checks are necessary regression evidence but are not sufficient for production promotion.
- Current merge-process blockers: GitHub Gitleaks requires the organization `GITLEAKS_LICENSE` secret, and Claude async review requires workflow OIDC permission configuration.

## Capability Promotion Gates

| Capability                   | Current state | Required production evidence                                                                                                                                                                |
| ---------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mission_runtime`            | `prototype`   | Full Startup Launch Eval plus Multi-Agent Parallel Build Eval with durable mission replay, retry, resume, evidence, and receipt coverage                                                    |
| `helm_receipts`              | `implemented` | HELM Governance Eval proving medium/high/restricted actions fail closed when policy evaluation, receipt persistence, authorization, or evidence persistence fails                           |
| `workspace_rbac`             | `implemented` | HELM Governance Eval plus RBAC regressions for governance, secrets, connectors, approvals, invites, browser/computer sessions, operators, policy docs, and workspace mode changes           |
| `operator_scoping`           | `implemented` | Cross-workspace operator rejection regression over gateway ingress and runtime resolution                                                                                                   |
| `decision_court`             | `implemented` | Decision Court Governed Model Eval with governed bull, bear, referee calls, costs, receipts, evidence, and refusal on provider/HELM/referee failure                                         |
| `skill_registry_runtime`     | `implemented` | Skill Invocation Governance Eval proving loaded, versioned, permitted, Tool Broker-governed, auditable skills                                                                               |
| `opportunity_scoring`        | `implemented` | PMF Discovery Eval with evidence-backed scorecards, assumptions, citations, and durable tool execution records                                                                              |
| `browser_metadata_connector` | `implemented` | YC Logged-In Browser Extraction Eval with scoped session/grant metadata and no credential export                                                                                            |
| `browser_execution`          | `prototype`   | YC Logged-In Browser Extraction Eval with active tab observation, screenshots, DOM hash, extraction, redaction, evidence, receipts, and replay                                              |
| `computer_use`               | `prototype`   | Safe Computer/Sandbox Action Eval with governed command/file/dev-server actions, deny rules, diffs, evidence, receipts, and replay                                                          |
| `a2a_durable_state`          | `implemented` | Multi-Agent Parallel Build Eval proving durable A2A state across restart and mission handoff recovery                                                                                       |
| `subagent_lineage`           | `implemented` | Proof DAG Lineage Regression proving parent mission, subagent, skill, tool, evidence, and receipt linkage                                                                                   |
| `approval_resume`            | `implemented` | Approval Resume Isolation Regression proving deterministic parent-only replay and child-row exclusion                                                                                       |
| `evidence_ledger`            | `prototype`   | HELM Governance Eval plus Recovery Eval proving every meaningful action has durable evidence/audit linkage or fails closed                                                                  |
| `command_center`             | `prototype`   | Command Center Real-State UX Eval proving durable state surfaces answer what Pilot is doing, why allowed, evidence, outcome, and founder requirements                                       |
| `startup_lifecycle`          | `prototype`   | Full Startup Launch Eval, Stripe Setup Prep Eval, and Company Formation Prep Eval over compiled lifecycle DAGs, escalation contracts, recovery, payment/legal prep, and acceptance criteria |
| `founder_off_grid`           | `blocked`     | Controlled Founder-Off-Grid Eval with budget/risk limits, escalation inbox, recovery, emergency stop, evidence, and receipts                                                                |
| `polsia_outperformance`      | `blocked`     | Polsia Outperformance Proof plus external-world autonomy eval results                                                                                                                       |

## Required Real Eval Scenarios

- Full Startup Launch
- YC Logged-In Browser Extraction
- Domain-to-Deployment
- Stripe Setup Prep
- Company Formation Prep
- PMF Discovery
- Multi-Agent Parallel Build
- HELM Governance
- Recovery
- Founder-Off-Grid
- Decision Court Governed Model
- Safe Computer Sandbox Action
- Polsia Outperformance

## Merge Evidence Checklist

Every implementation PR should record:

- Focused tests for touched packages.
- `npm run typecheck`.
- `npm run lint`.
- `npm test`.
- Schema or migration tests when database models change.
- E2E or eval commands when runtime/browser/computer behavior changes.
- Exact remote blockers if GitHub checks cannot complete because of repository configuration.
- A statement that no capability was marked `production_ready`, unless the PR includes persisted passing `real_external_eval` evidence and registry promotion.

## Fail-Closed Checklist

Medium, high, and restricted actions must not execute if any of these fail:

- Workspace authorization.
- Operator ownership validation.
- HELM policy evaluation.
- HELM receipt persistence.
- Evidence item persistence.
- Audit linkage.
- Required approval or escalation gate.
- Tool Broker manifest validation.
- Skill permission validation.
- Browser/computer grant validation.

## Current Non-Production Reasons

- Real external eval adapters are not complete for the required production scenarios.
- Browser execution is limited to governed read-only observation and lacks a productized bridge/eval pass.
- Computer use is limited to safe local actions plus provider-backed sandbox command/file actions and lacks sandbox dev-server eval promotion.
- Mission runtime has explicit bounded execution and recovery controls, but not a production long-running founder-off-grid loop.
- Evidence ledger coverage still has non-broker legacy writer gaps.
- Command center surfaces real state, but mission autonomy is still prototype-only.
- Founder-off-grid now has a server-owned durable-proof runner for controlled founder-absent evidence packs, but the capability remains blocked until a real eval run passes and long-running off-grid runtime controls are complete. Polsia outperformance remains blocked.
