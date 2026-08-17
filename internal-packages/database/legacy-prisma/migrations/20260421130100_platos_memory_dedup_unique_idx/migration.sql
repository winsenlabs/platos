-- EOBD.46 — composite unique index for extractor dedupe.
-- Postgres treats NULL as distinct, so legacy rows (contentHash IS NULL
-- or sourceThreadId IS NULL) do NOT fire the constraint. Only extractor
-- rows with both columns populated are deduped.
--
-- CONCURRENTLY because the table exists pre-migration; separate migration
-- per the database-safety rules.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "platos_mem_dedup_uniq"
  ON "public"."PlatosMemory"
  ("organizationId", "projectId", "environmentId", "userId", "sourceThreadId", "contentHash");
