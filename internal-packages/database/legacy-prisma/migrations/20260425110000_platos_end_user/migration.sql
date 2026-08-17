-- PlatosEndUser registry: one row per unique (org, project, env, externalUserId).
-- Lazily created on first thread creation; FK columns on Thread/Memory/Audit are nullable
-- so all existing rows stay valid.

-- CreateTable
CREATE TABLE "PlatosEndUser" (
    "id"             TEXT        NOT NULL,
    "organizationId" TEXT        NOT NULL,
    "projectId"      TEXT        NOT NULL,
    "environmentId"  TEXT        NOT NULL,
    "externalUserId" TEXT        NOT NULL,
    "displayName"    TEXT,
    "email"          TEXT,
    "threadCount"    INTEGER     NOT NULL DEFAULT 0,
    "lastActiveAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatosEndUser_pkey" PRIMARY KEY ("id")
);

-- CreateUniqueIndex
CREATE UNIQUE INDEX "platos_end_user_scope_ext_uniq"
    ON "PlatosEndUser"("organizationId", "projectId", "environmentId", "externalUserId");

-- CreateIndex
CREATE INDEX "platos_end_user_scope_last_active_idx"
    ON "PlatosEndUser"("organizationId", "projectId", "environmentId", "lastActiveAt" DESC);

-- AddForeignKey (PlatosEndUser → RuntimeEnvironment)
ALTER TABLE "PlatosEndUser"
    ADD CONSTRAINT "PlatosEndUser_environmentId_fkey"
    FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Add nullable platosEndUserId columns to existing tables (non-blocking ADD COLUMN IF NOT EXISTS)
ALTER TABLE "PlatosAgentThread"   ADD COLUMN IF NOT EXISTS "platosEndUserId" TEXT;
ALTER TABLE "PlatosMemory"        ADD COLUMN IF NOT EXISTS "platosEndUserId" TEXT;
ALTER TABLE "PlatosToolCallAudit" ADD COLUMN IF NOT EXISTS "platosEndUserId" TEXT;

-- AddForeignKey (PlatosAgentThread → PlatosEndUser)
ALTER TABLE "PlatosAgentThread"
    ADD CONSTRAINT "PlatosAgentThread_platosEndUserId_fkey"
    FOREIGN KEY ("platosEndUserId") REFERENCES "PlatosEndUser"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey (PlatosMemory → PlatosEndUser)
ALTER TABLE "PlatosMemory"
    ADD CONSTRAINT "PlatosMemory_platosEndUserId_fkey"
    FOREIGN KEY ("platosEndUserId") REFERENCES "PlatosEndUser"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey (PlatosToolCallAudit → PlatosEndUser)
ALTER TABLE "PlatosToolCallAudit"
    ADD CONSTRAINT "PlatosToolCallAudit_platosEndUserId_fkey"
    FOREIGN KEY ("platosEndUserId") REFERENCES "PlatosEndUser"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
