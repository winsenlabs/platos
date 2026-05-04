-- PRA-AC.1 (idx): Composite index on PlatosAgentThread(clusteringId, userId).
-- Powers the cluster-scoped thread list: all threads in a cluster for a specific user.
-- CONCURRENTLY in its own file.

CREATE INDEX IF NOT EXISTS "PlatosAgentThread_clusteringId_userId_idx"
  ON "PlatosAgentThread" ("clusteringId", "userId");
