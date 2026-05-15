-- 0013 — Phase 14 Track B: compliance framework overlays
--
-- Per-workspace enablement of helm-ai-kernel-defined compliance packs
-- (SOC2 Type II, HIPAA Covered Entity, PCI DSS 4, EU AI Act
-- High-Risk, ISO 42001). Each framework:
--   - Extends retention for evidence_packs via the retention scheduler
--     (services/orchestrator/src/retention.ts, follow-up commit).
--   - Pulls a P2 overlay fragment from helm-ai-kernel reference_packs/*.v1.json
--     and composes it on top of founder_ops. P2 overlays narrow only,
--     never widen — the guardian enforces this.
--   - Unlocks a framework-specific dashboard panel at /compliance/<id>.
--
-- Idempotent via IF NOT EXISTS + constraint-guards.

-- ═══════════════════════════════════════════════════════════════════════
-- workspaces — enabled-frameworks list
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "compliance_frameworks" jsonb NOT NULL DEFAULT '[]';

-- ═══════════════════════════════════════════════════════════════════════
-- compliance_attestations — audit log of generated bundles
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "compliance_attestations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" uuid NOT NULL,
  "framework" text NOT NULL,
  "attested_at" timestamptz NOT NULL DEFAULT now(),
  "evidence_pack_id" uuid,
  "expires_at" timestamptz,
  "bundle_hash" text,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'compliance_attestations_workspace_fk'
      AND table_name = 'compliance_attestations'
  ) THEN
    ALTER TABLE "compliance_attestations"
      ADD CONSTRAINT "compliance_attestations_workspace_fk"
      FOREIGN KEY ("workspace_id")
      REFERENCES "public"."workspaces"("id") ON DELETE cascade;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'compliance_attestations_evidence_fk'
      AND table_name = 'compliance_attestations'
  ) THEN
    ALTER TABLE "compliance_attestations"
      ADD CONSTRAINT "compliance_attestations_evidence_fk"
      FOREIGN KEY ("evidence_pack_id")
      REFERENCES "public"."evidence_packs"("id") ON DELETE set null;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "compliance_attestations_workspace_idx"
  ON "compliance_attestations" ("workspace_id", "framework");

CREATE INDEX IF NOT EXISTS "compliance_attestations_attested_idx"
  ON "compliance_attestations" ("attested_at");
