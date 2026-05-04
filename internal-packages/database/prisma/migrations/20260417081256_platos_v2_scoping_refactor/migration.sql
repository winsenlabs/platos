-- Platos V2 — scoping refactor (PLV2-66).
-- Wipes all Platos rows first (pre-launch; single test agent recreated
-- from the UI after migration), then applies the new scoped schema with
-- PlatosConnectedEntity replacing PlatosConnectedOrg.

TRUNCATE TABLE
  "PlatosAgentMessage",
  "PlatosAgentThread",
  "PlatosAgent",
  "PlatosToolHealth",
  "PlatosOrgToolMapping",
  "PlatosConnectedOrg"
RESTART IDENTITY CASCADE;

-- DropForeignKey
ALTER TABLE "public"."PlatosAgent" DROP CONSTRAINT "PlatosAgent_orgId_fkey";

-- DropForeignKey
ALTER TABLE "public"."PlatosOrgToolMapping" DROP CONSTRAINT "PlatosOrgToolMapping_orgId_fkey";

-- DropForeignKey
ALTER TABLE "public"."PlatosOrgToolMapping" DROP CONSTRAINT "PlatosOrgToolMapping_toolId_fkey";

-- DropIndex
DROP INDEX "public"."PlatosAgent_orgId_idx";

-- DropIndex
DROP INDEX "public"."PlatosAgent_slug_key";

-- DropIndex
DROP INDEX "public"."PlatosAgentThread_orgId_userId_idx";

-- DropIndex
DROP INDEX "public"."PlatosToolHealth_orgId_idx";

-- DropIndex
DROP INDEX "public"."PlatosToolHealth_toolId_orgId_key";

-- DropIndex

-- AlterTable
ALTER TABLE "public"."PlatosAgent" DROP COLUMN "orgId",
ADD COLUMN     "compactThreshold" INTEGER NOT NULL DEFAULT 40,
ADD COLUMN     "contextLimit" INTEGER NOT NULL DEFAULT 20,
ADD COLUMN     "dynamicBlocks" JSONB,
ADD COLUMN     "enableUserProfiling" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "environmentId" TEXT NOT NULL,
ADD COLUMN     "historyMode" TEXT NOT NULL DEFAULT 'rolling',
ADD COLUMN     "organizationId" TEXT NOT NULL,
ADD COLUMN     "projectId" TEXT NOT NULL,
ADD COLUMN     "subAgentConfig" JSONB,
ADD COLUMN     "toolsBlockConfig" JSONB;

-- AlterTable
ALTER TABLE "public"."PlatosAgentThread" DROP COLUMN "orgId",
ADD COLUMN     "compactedSummary" TEXT,
ADD COLUMN     "environmentId" TEXT NOT NULL,
ADD COLUMN     "organizationId" TEXT NOT NULL,
ADD COLUMN     "projectId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "public"."PlatosToolHealth" DROP COLUMN "orgId",
ADD COLUMN     "entityId" TEXT NOT NULL,
ADD COLUMN     "environmentId" TEXT NOT NULL;

-- DropTable
DROP TABLE "public"."PlatosConnectedOrg";

-- DropTable
DROP TABLE "public"."PlatosOrgToolMapping";

-- CreateTable
CREATE TABLE "public"."PlatosAgentUserProfile" (
    "agentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatosAgentUserProfile_pkey" PRIMARY KEY ("agentId","userId")
);

-- CreateTable
CREATE TABLE "public"."PlatosConnectedEntity" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "mcpUrls" TEXT[],
    "serviceSecret" TEXT NOT NULL,
    "customParams" JSONB,
    "connectionStatus" TEXT NOT NULL DEFAULT 'disconnected',
    "lastConnectedAt" TIMESTAMP(3),
    "disconnectAlertSent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosConnectedEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PlatosEntityToolMapping" (
    "id" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "callbackUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosEntityToolMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlatosAgentUserProfile_organizationId_projectId_environment_idx" ON "public"."PlatosAgentUserProfile"("organizationId", "projectId", "environmentId");

-- CreateIndex
CREATE INDEX "PlatosAgentUserProfile_userId_idx" ON "public"."PlatosAgentUserProfile"("userId");

-- CreateIndex
CREATE INDEX "PlatosConnectedEntity_organizationId_projectId_idx" ON "public"."PlatosConnectedEntity"("organizationId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatosConnectedEntity_organizationId_projectId_entityId_key" ON "public"."PlatosConnectedEntity"("organizationId", "projectId", "entityId");

-- CreateIndex
CREATE INDEX "PlatosEntityToolMapping_entityId_environmentId_enabled_idx" ON "public"."PlatosEntityToolMapping"("entityId", "environmentId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "PlatosEntityToolMapping_toolId_entityId_environmentId_key" ON "public"."PlatosEntityToolMapping"("toolId", "entityId", "environmentId");

-- CreateIndex
CREATE INDEX "PlatosAgent_organizationId_projectId_environmentId_idx" ON "public"."PlatosAgent"("organizationId", "projectId", "environmentId");

-- CreateIndex
CREATE INDEX "PlatosAgent_projectId_environmentId_idx" ON "public"."PlatosAgent"("projectId", "environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatosAgent_projectId_environmentId_slug_key" ON "public"."PlatosAgent"("projectId", "environmentId", "slug");

-- CreateIndex
CREATE INDEX "PlatosAgentThread_organizationId_projectId_environmentId_us_idx" ON "public"."PlatosAgentThread"("organizationId", "projectId", "environmentId", "userId");

-- CreateIndex
CREATE INDEX "PlatosToolHealth_entityId_environmentId_idx" ON "public"."PlatosToolHealth"("entityId", "environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatosToolHealth_toolId_entityId_environmentId_key" ON "public"."PlatosToolHealth"("toolId", "entityId", "environmentId");

-- CreateIndex

-- AddForeignKey
ALTER TABLE "public"."PlatosAgent" ADD CONSTRAINT "PlatosAgent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatosAgent" ADD CONSTRAINT "PlatosAgent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatosAgent" ADD CONSTRAINT "PlatosAgent_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatosAgentThread" ADD CONSTRAINT "PlatosAgentThread_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatosAgentThread" ADD CONSTRAINT "PlatosAgentThread_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatosAgentThread" ADD CONSTRAINT "PlatosAgentThread_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatosAgentUserProfile" ADD CONSTRAINT "PlatosAgentUserProfile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatosAgentUserProfile" ADD CONSTRAINT "PlatosAgentUserProfile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatosAgentUserProfile" ADD CONSTRAINT "PlatosAgentUserProfile_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatosConnectedEntity" ADD CONSTRAINT "PlatosConnectedEntity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatosConnectedEntity" ADD CONSTRAINT "PlatosConnectedEntity_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatosEntityToolMapping" ADD CONSTRAINT "PlatosEntityToolMapping_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "public"."PlatosToolDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatosEntityToolMapping" ADD CONSTRAINT "PlatosEntityToolMapping_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "public"."PlatosConnectedEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatosEntityToolMapping" ADD CONSTRAINT "PlatosEntityToolMapping_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatosToolHealth" ADD CONSTRAINT "PlatosToolHealth_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

