-- L6 (security audit 2026-07-16) — knowledge-graph agent isolation.
--
-- The KG entity + relationship tables scope on
-- (organizationId, projectId, environmentId, userId) but carry NO agentId,
-- unlike PlatosMemory (which gained it in the L5 wave). Today this is a
-- LATENT leak: the turn-time `relate` meta-tool and the extractor WRITE
-- these tables, but no turn-time path READS them yet. Add the nullable
-- isolation column BEFORE any KG-in-prompt recall is wired, so the column
-- exists before it is relied upon.
--
-- Nullable + additive: existing rows get agentId = NULL (identical to the
-- semantics of pre-L5 PlatosMemory rows). No backfill required; no existing
-- query changes (every current read filters on scope + userId only).
-- Mirrors 20260717010000_platos_tool_definition_scope (additive scope cols).

ALTER TABLE "PlatosMemoryEntity" ADD COLUMN IF NOT EXISTS "agentId" TEXT;
ALTER TABLE "PlatosMemoryRelationship" ADD COLUMN IF NOT EXISTS "agentId" TEXT;

-- Agent-scoped read index. Matches the @@index maps added to schema.prisma
-- so a future `(scope, userId, agentId)` KG recall is index-backed. agentId
-- is nullable — a b-tree index stores NULLs fine and NULL rows stay
-- reachable via the existing scope_user indexes.
CREATE INDEX IF NOT EXISTS "platos_mem_entity_scope_agent_idx"
  ON "PlatosMemoryEntity" ("organizationId", "projectId", "environmentId", "userId", "agentId");

CREATE INDEX IF NOT EXISTS "platos_mem_rel_scope_agent_idx"
  ON "PlatosMemoryRelationship" ("organizationId", "projectId", "environmentId", "userId", "agentId");
