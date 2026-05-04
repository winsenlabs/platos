-- Platos Theme O — Memory as a product.
--
-- Builds on Theme L.3/L.4 primitives:
--   1. Adds `extractionPolicy` JSONB to `PlatosAgent` so each agent can opt
--      in / out of automatic memory extraction and tune kinds + confidence
--      threshold.
--   2. Adds `visibility` TEXT to `PlatosMemory`. Supersedes `agentVisible`
--      as the authoritative signal; the boolean is still maintained in
--      application code so existing reads keep working.
--
-- All statements use `IF NOT EXISTS` so the migration is safe to re-run.

-- ─────────────────────────────────────────────────────────────────────
-- PlatosAgent.extractionPolicy — Theme O.2
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE "public"."PlatosAgent"
    ADD COLUMN IF NOT EXISTS "extractionPolicy" JSONB;

-- ─────────────────────────────────────────────────────────────────────
-- PlatosMemory.visibility — Theme O.6
-- Default back-fills existing rows to the `agent_visible` state, matching
-- the existing `agentVisible = TRUE` default. Rows with `agentVisible =
-- FALSE` are migrated to the new `hidden` bucket via the one-shot UPDATE
-- below so the visibility column is immediately consistent.
-- ─────────────────────────────────────────────────────────────────────
ALTER TABLE "public"."PlatosMemory"
    ADD COLUMN IF NOT EXISTS "visibility" TEXT NOT NULL DEFAULT 'agent_visible';

UPDATE "public"."PlatosMemory"
   SET "visibility" = 'hidden'
 WHERE "agentVisible" = FALSE
   AND "visibility" = 'agent_visible';
