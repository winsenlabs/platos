-- Theme EA (Entity ↔ Agents allow-list) — add `linkedAgentIds` column to
-- PlatosConnectedEntity. Empty array = unrestricted (every agent in the
-- scope sees this entity's tools). Non-empty = allow-list of agent IDs
-- that can see the entity's tools via the scoped matrix.
--
-- Idempotent: IF NOT EXISTS keeps re-runs safe in environments where the
-- column was pre-applied by hand.
ALTER TABLE "PlatosConnectedEntity"
  ADD COLUMN IF NOT EXISTS "linkedAgentIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
