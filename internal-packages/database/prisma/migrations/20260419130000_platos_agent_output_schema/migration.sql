-- Theme F.5 — agent-level default output schema.
--
-- Adds a nullable JSONB column on `PlatosAgent` that captures a JSON-Schema
-- (or Zod-serialised) description of the shape the LLM must return every
-- turn. When populated, the agent runtime routes through Vercel AI SDK's
-- `generateObject` / `streamObject`, validates the response, and retries
-- once on invalid output with the validation errors fed back as a
-- correction prompt. Per-turn `PlatosAgentMessage.outputSchema` takes
-- precedence over this agent-level default.
--
-- Idempotent via IF NOT EXISTS — safe to re-apply.

ALTER TABLE "public"."PlatosAgent"
    ADD COLUMN IF NOT EXISTS "outputSchema" JSONB;
