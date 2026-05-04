-- PRA-AC.1: Create PlatosAgentCluster table.
-- Groups agents into a shared-context envelope (shared memory + thread history).
-- Indexes on new table — no CONCURRENTLY needed.

CREATE TABLE "PlatosAgentCluster" (
  "id"              TEXT NOT NULL,
  "organizationId"  TEXT NOT NULL,
  "projectId"       TEXT NOT NULL,
  "environmentId"   TEXT NOT NULL,
  "name"            TEXT NOT NULL,
  "slug"            TEXT NOT NULL,
  "description"     TEXT,
  "metadata"        JSONB,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PlatosAgentCluster_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PlatosAgentCluster"
  ADD CONSTRAINT "PlatosAgentCluster_environmentId_fkey"
  FOREIGN KEY ("environmentId")
  REFERENCES "RuntimeEnvironment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "PlatosAgentCluster_projectId_environmentId_slug_key"
  ON "PlatosAgentCluster" ("projectId", "environmentId", "slug");

CREATE INDEX "PlatosAgentCluster_organizationId_projectId_environmentId_idx"
  ON "PlatosAgentCluster" ("organizationId", "projectId", "environmentId");
