-- PIFSP-18 — Per-agent PII governance configuration.
--
-- Adds governanceConfig JSONB column to PlatosAgent. Shape:
--   { pii?: { enabled, filters: [{kind, mode, applyTo, ...}], secondaryLlmValidation? } }
--
-- Null = all PII filters OFF (opt-in, not a platform default).
-- Idempotent (IF NOT EXISTS).

ALTER TABLE "PlatosAgent"
  ADD COLUMN IF NOT EXISTS "governanceConfig" JSONB;
