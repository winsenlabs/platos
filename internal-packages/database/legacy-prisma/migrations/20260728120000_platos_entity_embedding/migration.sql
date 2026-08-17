-- Context compiler, piece 4 — knowledge-graph node embeddings.
--
-- Adds a nullable pgvector embedding column to PlatosMemoryEntity, mirroring
-- PlatosMemory.embedding. The `vector` extension already exists (created in
-- 20260420120000_platos_memory_l3l4).
--
-- SAFE: a nullable ADD COLUMN with no default is a metadata-only change in
-- Postgres (no table rewrite, only a brief catalog lock). Existing rows stay
-- NULL and are back-filled asynchronously by KnowledgeGraphService.upsertEntity
-- on their next write — no data migration, no downtime. Idempotent via
-- IF NOT EXISTS so a re-run is a no-op.

ALTER TABLE "public"."PlatosMemoryEntity"
    ADD COLUMN IF NOT EXISTS "embedding" vector(1536);
