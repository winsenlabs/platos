-- Theme M.1 — composite index for rating-weighted ranking. The M.5 reader
-- orders recall results by (cosine, confidence DESC NULLS LAST, lastAccessedAt).
-- This index keeps the confidence sort cheap on the scope-user prefix.
--
-- CONCURRENTLY because the table exists pre-migration; separate migration
-- per the database-safety rules (one index per file, cannot combine with
-- other DDL).

CREATE INDEX CONCURRENTLY IF NOT EXISTS "platos_mem_scope_user_confidence_idx"
  ON "public"."PlatosMemory"
  ("organizationId", "projectId", "environmentId", "userId", "confidence");
