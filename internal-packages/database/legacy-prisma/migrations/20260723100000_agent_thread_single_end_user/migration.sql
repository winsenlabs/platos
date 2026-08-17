-- IDENTITY-CORE §C — single-end-user gate representation.
--
-- Adds PlatosAgentThread.singleEndUser: true ⇒ exactly one human owns this
-- thread, so `{{endUserId}}` (Composio user_id) may resolve; false ⇒ the
-- thread is multi-human (shared channel / group DM / any non-Slack channel
-- thread with no DM predicate) and per-user Composio-MCP fails closed.
--
-- Additive with a NOT NULL DEFAULT true. Every EXISTING row becomes `true`
-- on apply — which is WRONG for existing multi-human channel threads. The
-- backfill that flips those to `false` ships in the §C-gate commit (a
-- separate migration) so this column-add stays a clean, independently
-- reviewable structural change. Web/API/direct threads correctly stay `true`
-- (one token = one end user); no behaviour change for them.
--
-- IF NOT EXISTS keeps the migration idempotent on a database carrying partial
-- state (branch juggling / direct-psql apply on the deploy target).

ALTER TABLE "public"."PlatosAgentThread"
    ADD COLUMN IF NOT EXISTS "singleEndUser" BOOLEAN NOT NULL DEFAULT true;
