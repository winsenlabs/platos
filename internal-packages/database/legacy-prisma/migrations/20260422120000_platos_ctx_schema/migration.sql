-- Theme CTX.1 — session-context primitive (schema only; runtime wiring in CTX.2).
--
-- `PlatosAgentThread.sessionContext`  — arbitrary key=value bag set by the
--   playground / consumer SDK / internal callers. Persists per-thread so every
--   turn shares the same context.
--
-- `PlatosAgent.contextMapping` — per-agent declaration of which context keys
--   play which role (prompt substitution, tool-arg auto-injection, envelope
--   forwarding, and tool-matrix routing via entity_ids). Null = default
--   behavior (no auto-injection, no matrix routing, all in-scope tools visible).

ALTER TABLE "public"."PlatosAgentThread"
  ADD COLUMN IF NOT EXISTS "sessionContext" JSONB;

ALTER TABLE "public"."PlatosAgent"
  ADD COLUMN IF NOT EXISTS "contextMapping" JSONB;
