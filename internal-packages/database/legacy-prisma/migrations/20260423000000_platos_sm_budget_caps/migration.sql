-- Theme SM.3 — Extend budget caps with skill + per-agent dimensions.
--
-- `tier`      — "llm" (default, preserves existing rows) | "skill". Future
--               tiers slot in without migration.
-- `skillSlug` — when tier="skill", optionally pin to one skill slug (e.g.
--               "platos.web_search"). NULL = every skill in scope.
-- `agentId`   — optionally pin the cap to a single agent. NULL = all agents.
--               Orthogonal to scopeType (scopeType drives Redis counter
--               selection; agentId filters which caps fire for a turn).
--
-- Runtime wiring lands in SM.4 (admin UI) + skill-runtime.service.ts
-- `checkSkillBudget`. Migration is additive + safe to defer.

ALTER TABLE "public"."PlatosBudgetCap"
  ADD COLUMN IF NOT EXISTS "tier" TEXT NOT NULL DEFAULT 'llm';

ALTER TABLE "public"."PlatosBudgetCap"
  ADD COLUMN IF NOT EXISTS "skillSlug" TEXT;

ALTER TABLE "public"."PlatosBudgetCap"
  ADD COLUMN IF NOT EXISTS "agentId" TEXT;
