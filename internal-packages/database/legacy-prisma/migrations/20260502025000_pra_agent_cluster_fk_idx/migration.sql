-- PRA-AC.1 (idx): Index on PlatosAgent.clusteringId for cluster member lookups.
-- CONCURRENTLY in its own file (cannot run inside a transaction block).

CREATE INDEX IF NOT EXISTS "PlatosAgent_clusteringId_idx"
  ON "PlatosAgent" ("clusteringId");
