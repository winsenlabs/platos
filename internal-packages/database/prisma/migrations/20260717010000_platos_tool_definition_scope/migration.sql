-- SECURITY (audit 2026-07-16, finding H15): scope PlatosToolDefinition per
-- tenant. `name` was globally @unique, so one org registering a common tool
-- name (`search`, `send_email`) overwrote the shared row's
-- description/paramSchema/bm25Tokens and re-indexed the shared toolId in the
-- process-wide BM25 index — poisoning another org's ranking + leaking its
-- schema. The registry lookup/create is now scoped to (organizationId,
-- projectId, name); this migration makes the storage layer match.
--
-- ADDITIVE + SAFE TO APPLY AS-IS: the new columns are NULLABLE, so every
-- existing row (at most one per name, since name was globally unique) becomes
-- (NULL, NULL, name) and does NOT violate the new composite unique. New tool
-- registrations write real (organizationId, projectId, name) rows.
--
-- ⚠️ EXISTING DATA (self-host / populated DBs) — backfill BEFORE relying on
-- per-tenant isolation for tools registered prior to this migration:
--   * Rows referenced by exactly ONE (org, project) can be backfilled in place
--     from PlatosEntityToolMapping -> PlatosConnectedEntity scope, e.g.:
--       UPDATE "PlatosToolDefinition" td
--       SET "organizationId" = s.org, "projectId" = s.proj
--       FROM (
--         SELECT m."toolId",
--                min(e."organizationId") org, min(e."projectId") proj,
--                count(distinct e."organizationId"||':'||e."projectId") n
--         FROM "PlatosEntityToolMapping" m
--         JOIN "PlatosConnectedEntity" e ON e.id = m."entityId"
--         GROUP BY m."toolId"
--       ) s
--       WHERE td.id = s."toolId" AND s.n = 1;
--   * Rows genuinely SHARED across scopes (the vulnerable case) must be SPLIT:
--     one row per scope, repointing each scope's PlatosEntityToolMapping to its
--     new row. This is a deliberate data decision — do NOT automate it blindly.
-- On test.platos this table is empty (0 rows), so no backfill is required there.

ALTER TABLE "PlatosToolDefinition" ADD COLUMN "organizationId" TEXT;
ALTER TABLE "PlatosToolDefinition" ADD COLUMN "projectId" TEXT;

-- Replace the global name-unique with a tenant-scoped composite unique.
DROP INDEX "PlatosToolDefinition_name_key";
CREATE UNIQUE INDEX "PlatosToolDefinition_organizationId_projectId_name_key" ON "PlatosToolDefinition"("organizationId", "projectId", "name");
CREATE INDEX "PlatosToolDefinition_organizationId_projectId_idx" ON "PlatosToolDefinition"("organizationId", "projectId");
