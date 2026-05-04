-- EOBD.89 — PlatosAgent.visibility for public-guest flow.
-- Default "private" preserves existing behaviour; public-guest is opt-in per agent.

ALTER TABLE "public"."PlatosAgent"
  ADD COLUMN IF NOT EXISTS "visibility" TEXT NOT NULL DEFAULT 'private';
