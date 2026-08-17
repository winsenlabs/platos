-- DropIndex
DROP INDEX "public"."SecretStore_key_idx";

-- DropIndex
DROP INDEX "public"."TaskRun_runtimeEnvironmentId_createdAt_idx";

-- AlterTable
ALTER TABLE "public"."FeatureFlag" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "public"."IntegrationDeployment" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "public"."_BackgroundWorkerToBackgroundWorkerFile" ADD CONSTRAINT "_BackgroundWorkerToBackgroundWorkerFile_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "public"."_BackgroundWorkerToBackgroundWorkerFile_AB_unique";

-- AlterTable
ALTER TABLE "public"."_BackgroundWorkerToTaskQueue" ADD CONSTRAINT "_BackgroundWorkerToTaskQueue_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "public"."_BackgroundWorkerToTaskQueue_AB_unique";

-- AlterTable
ALTER TABLE "public"."_TaskRunToTaskRunTag" ADD CONSTRAINT "_TaskRunToTaskRunTag_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "public"."_TaskRunToTaskRunTag_AB_unique";

-- AlterTable
ALTER TABLE "public"."_WaitpointRunConnections" ADD CONSTRAINT "_WaitpointRunConnections_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "public"."_WaitpointRunConnections_AB_unique";

-- AlterTable
ALTER TABLE "public"."_completedWaitpoints" ADD CONSTRAINT "_completedWaitpoints_AB_pkey" PRIMARY KEY ("A", "B");

-- DropIndex
DROP INDEX "public"."_completedWaitpoints_AB_unique";

-- CreateTable
CREATE TABLE "public"."PlatosAgent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "systemPrompt" TEXT,
    "maxSteps" INTEGER NOT NULL DEFAULT 20,
    "toolMode" TEXT NOT NULL DEFAULT 'direct',
    "memoryConfig" JSONB,
    "metaTools" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "orgId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PlatosAgentThread" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosAgentThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PlatosAgentMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT,
    "toolCalls" JSONB,
    "thinkingContent" TEXT,
    "responseJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatosAgentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PlatosConnectedOrg" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "mcpUrls" TEXT[],
    "serviceSecret" TEXT NOT NULL,
    "customParams" JSONB,
    "connectionStatus" TEXT NOT NULL DEFAULT 'disconnected',
    "lastConnectedAt" TIMESTAMP(3),
    "disconnectAlertSent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosConnectedOrg_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PlatosToolDefinition" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "paramSchema" JSONB NOT NULL,
    "category" TEXT,
    "schemaHash" TEXT NOT NULL,
    "bm25Tokens" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosToolDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PlatosOrgToolMapping" (
    "id" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "callbackUrl" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosOrgToolMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PlatosToolHealth" (
    "id" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "lastCalledAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "totalCalls" INTEGER NOT NULL DEFAULT 0,
    "totalFailures" INTEGER NOT NULL DEFAULT 0,
    "p95LatencyMs" INTEGER,
    "avgLatencyMs" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosToolHealth_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatosAgent_slug_key" ON "public"."PlatosAgent"("slug");

-- CreateIndex
CREATE INDEX "PlatosAgent_orgId_idx" ON "public"."PlatosAgent"("orgId");

-- CreateIndex
CREATE INDEX "PlatosAgentThread_orgId_userId_idx" ON "public"."PlatosAgentThread"("orgId", "userId");

-- CreateIndex
CREATE INDEX "PlatosAgentThread_agentId_idx" ON "public"."PlatosAgentThread"("agentId");

-- CreateIndex
CREATE INDEX "PlatosAgentMessage_threadId_createdAt_idx" ON "public"."PlatosAgentMessage"("threadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlatosConnectedOrg_orgId_key" ON "public"."PlatosConnectedOrg"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatosToolDefinition_name_key" ON "public"."PlatosToolDefinition"("name");

-- CreateIndex
CREATE INDEX "PlatosToolDefinition_category_idx" ON "public"."PlatosToolDefinition"("category");

-- CreateIndex
CREATE INDEX "PlatosOrgToolMapping_orgId_enabled_idx" ON "public"."PlatosOrgToolMapping"("orgId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "PlatosOrgToolMapping_toolId_orgId_key" ON "public"."PlatosOrgToolMapping"("toolId", "orgId");

-- CreateIndex
CREATE INDEX "PlatosToolHealth_orgId_idx" ON "public"."PlatosToolHealth"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "PlatosToolHealth_toolId_orgId_key" ON "public"."PlatosToolHealth"("toolId", "orgId");

-- CreateIndex
CREATE INDEX "SecretStore_key_idx" ON "public"."SecretStore"("key" text_pattern_ops);

-- CreateIndex
CREATE INDEX "TaskRun_runtimeEnvironmentId_createdAt_idx" ON "public"."TaskRun"("runtimeEnvironmentId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "public"."TaskRun" ADD CONSTRAINT "TaskRun_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRun" ADD CONSTRAINT "TaskRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRun" ADD CONSTRAINT "TaskRun_lockedById_fkey" FOREIGN KEY ("lockedById") REFERENCES "public"."BackgroundWorkerTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRun" ADD CONSTRAINT "TaskRun_lockedToVersionId_fkey" FOREIGN KEY ("lockedToVersionId") REFERENCES "public"."BackgroundWorker"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRun" ADD CONSTRAINT "TaskRun_rootTaskRunId_fkey" FOREIGN KEY ("rootTaskRunId") REFERENCES "public"."TaskRun"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."TaskRun" ADD CONSTRAINT "TaskRun_parentTaskRunId_fkey" FOREIGN KEY ("parentTaskRunId") REFERENCES "public"."TaskRun"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."TaskRun" ADD CONSTRAINT "TaskRun_parentTaskRunAttemptId_fkey" FOREIGN KEY ("parentTaskRunAttemptId") REFERENCES "public"."TaskRunAttempt"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."TaskRun" ADD CONSTRAINT "TaskRun_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "public"."BatchTaskRun"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."PlatosAgent" ADD CONSTRAINT "PlatosAgent_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."PlatosConnectedOrg"("orgId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatosAgentThread" ADD CONSTRAINT "PlatosAgentThread_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."PlatosAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatosAgentMessage" ADD CONSTRAINT "PlatosAgentMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."PlatosAgentThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatosOrgToolMapping" ADD CONSTRAINT "PlatosOrgToolMapping_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "public"."PlatosToolDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatosOrgToolMapping" ADD CONSTRAINT "PlatosOrgToolMapping_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "public"."PlatosConnectedOrg"("orgId") ON DELETE CASCADE ON UPDATE CASCADE;
