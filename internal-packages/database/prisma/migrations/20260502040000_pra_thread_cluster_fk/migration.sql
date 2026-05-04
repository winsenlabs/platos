-- PRA-AC.1: Add clusteringId to PlatosAgentThread.
-- Denormalized from the creating agent's cluster for fast cross-agent thread queries.

ALTER TABLE "PlatosAgentThread"
  ADD COLUMN IF NOT EXISTS "clusteringId" TEXT;

ALTER TABLE "PlatosAgentThread"
  ADD CONSTRAINT "PlatosAgentThread_clusteringId_fkey"
  FOREIGN KEY ("clusteringId")
  REFERENCES "PlatosAgentCluster"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
