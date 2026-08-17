-- PRELAUNCH-A3-6 — extend PlatosBudgetCap composite unique key with
-- tier / skillSlug / agentId so an LLM cap and a skill cap (or an
-- agent-specific cap and an everyone cap) at the same scope/period
-- coexist without one silently overwriting the other.
--
-- The pre-existing key was:
--   (organizationId, projectId, environmentId, scopeType, targetId, period)
--
-- Two scope-wide day caps differing ONLY by tier or skillSlug both hashed
-- onto that key; the second upsert overwrote the first row. Tightening
-- the key unblocks the SM.3 tier ladder and the future per-agent cap UX.
--
-- Postgres treats NULL as DISTINCT in btree unique indexes by default,
-- which is exactly the COALESCE-style semantics we want: two rows
-- differing only by `skillSlug` (NULL vs "tavily") collide as expected,
-- but two rows BOTH at NULL/NULL/NULL ARE distinct from each other.
-- That's fine here because the application layer (BudgetService.upsert)
-- looks the row up by (scope, scopeType, targetId, period, tier,
-- skillSlug, agentId) before deciding insert vs update — there's no path
-- that creates two NULL/NULL/NULL rows for the same scope.
--
-- DATA SAFETY: this migration is additive — the old constraint is dropped
-- and the new one is created. Any existing row stays in place; only the
-- index/constraint changes. If two stray rows happen to violate the
-- tighter key, the migration fails cleanly and an operator can dedupe
-- them by hand. The SM.3 column rollout shipped tier='llm' default for
-- every pre-existing row, and skillSlug + agentId are NULL by default —
-- so every existing row has the same tuple shape and no historical
-- collisions exist in practice.

ALTER TABLE "public"."PlatosBudgetCap"
  DROP CONSTRAINT IF EXISTS "platos_budget_cap_scope_period_uk";

DROP INDEX IF EXISTS "public"."platos_budget_cap_scope_period_uk";

ALTER TABLE "public"."PlatosBudgetCap"
  ADD CONSTRAINT "platos_budget_cap_scope_period_tier_uk"
  UNIQUE ("organizationId", "projectId", "environmentId", "scopeType", "targetId", "period", "tier", "skillSlug", "agentId");
