-- PIFSP-17 — Compaction observability + mutex columns on PlatosAgentThread.
--
-- Adds three nullable columns:
--   compactedAt             — when the last successful compaction ran
--   compactedUpToMessageId  — which message the summary covers through
--   compactionInFlight      — optimistic mutex (prevents duplicate workers)
--
-- All additive + idempotent (IF NOT EXISTS). The existing compactedSummary
-- column is untouched; these columns extend its bookkeeping.

ALTER TABLE "PlatosAgentThread"
  ADD COLUMN IF NOT EXISTS "compactedAt"            TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "compactedUpToMessageId" TEXT,
  ADD COLUMN IF NOT EXISTS "compactionInFlight"     BOOLEAN NOT NULL DEFAULT false;
