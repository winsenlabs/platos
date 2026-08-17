-- Theme MCPF-W2: archived-memory filter index.
-- Partial index — only stores rows that are archived, since the read paths
-- always filter `archivedAt IS NULL` in the hot path. Smaller index, no cost
-- to active-row queries.
-- CONCURRENTLY in its own file (cannot run inside a transaction block).

CREATE INDEX CONCURRENTLY IF NOT EXISTS "PlatosMemory_archivedAt_idx"
  ON "PlatosMemory" ("archivedAt")
  WHERE "archivedAt" IS NOT NULL;
