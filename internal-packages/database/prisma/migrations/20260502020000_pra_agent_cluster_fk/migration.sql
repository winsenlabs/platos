-- PRA-AC.1: Add clusteringId FK to PlatosAgent.
-- NULL = standalone agent. Non-null = member of a cluster.

ALTER TABLE "PlatosAgent"
  ADD COLUMN IF NOT EXISTS "clusteringId" TEXT;

ALTER TABLE "PlatosAgent"
  ADD CONSTRAINT "PlatosAgent_clusteringId_fkey"
  FOREIGN KEY ("clusteringId")
  REFERENCES "PlatosAgentCluster"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
