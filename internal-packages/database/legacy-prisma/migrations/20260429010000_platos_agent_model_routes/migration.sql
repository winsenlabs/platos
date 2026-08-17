-- Per-request model routing: N named routes per agent, each mapping a label
-- ("alpha", "bravo", "fast") to a (model, providerKeyId, isDefault) triple.
-- Stored as JSONB for flexibility; the runtime resolves per-turn label → route.
-- PlatosAgent.model + providerKeyId remain for full backwards compatibility.

ALTER TABLE "PlatosAgent"
  ADD COLUMN IF NOT EXISTS "modelRoutes" JSONB;
