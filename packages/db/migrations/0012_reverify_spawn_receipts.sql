-- 0012 — Phase 13.5: re-verify Path-A SUBAGENT_SPAWN receipts
--
-- Phase 12 shipped Path A (plan §"Open upstream dependency"): local
-- unsigned markers for SUBAGENT_SPAWN evidence packs because helm-ai-kernel
-- v0.3.0 did not expose POST /api/v1/guardian/evaluate. Phase 13.5
-- adds a real HelmClient.evaluate() implementation gated on the
-- PILOT_HELM_EVALUATE_ENABLED=1 env var. Once operators flip the flag (after
-- upgrading the sidecar to v0.3.1+), every existing Path-A row needs
-- to be re-verified via evaluate(). Clearing verified_at forces the
-- orchestrator's next health pass to re-sign them.
--
-- Safe on fresh installs: the outer guard matches zero rows.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'evidence_packs'
  ) THEN
    UPDATE evidence_packs
    SET verified_at = NULL
    WHERE action = 'SUBAGENT_SPAWN'
      AND signed_blob IS NULL;
  END IF;
END$$;
