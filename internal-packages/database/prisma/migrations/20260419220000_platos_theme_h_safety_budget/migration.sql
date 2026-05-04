-- Theme H — safety + budget + message encryption.
--
-- Adds:
--   1. PlatosAgentMessage.encKeyVersion — int key-version marker for at-rest
--      AES-256-GCM encryption (H.4). Null/0 = plaintext (legacy / no key).
--   2. PlatosBudgetCap — per-scope / per-agent / per-user budget caps (H.5).
--   3. PlatosSafetyEvent — detector hit ledger (H.1-3, H.9).
--
-- Column adds on an existing table (PlatosAgentMessage) use IF NOT EXISTS
-- so re-running is idempotent. CREATE TABLE statements create fresh tables
-- so indexes on them ship in the same migration per the monorepo rule
-- (see internal-packages/database/CLAUDE.md §"Index Migration Rules").

-- 1. PlatosAgentMessage.encKeyVersion
ALTER TABLE "public"."PlatosAgentMessage"
  ADD COLUMN IF NOT EXISTS "encKeyVersion" INTEGER;

-- 2. PlatosBudgetCap
CREATE TABLE "public"."PlatosBudgetCap" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL DEFAULT '',
    "period" TEXT NOT NULL,
    "limitCents" INTEGER NOT NULL,
    "runsLimit" INTEGER NOT NULL DEFAULT 0,
    "alertThresholds" JSONB NOT NULL DEFAULT '[50, 80, 100]',
    "alertWebhookUrl" TEXT,
    "alertEmails" TEXT,
    "overrideUntil" TIMESTAMP(3),
    "overrideBy" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosBudgetCap_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatosBudgetCap_scope_target_period_key"
  ON "public"."PlatosBudgetCap"("organizationId", "projectId", "environmentId", "scopeType", "targetId", "period");

CREATE INDEX "PlatosBudgetCap_scope_idx"
  ON "public"."PlatosBudgetCap"("organizationId", "projectId", "environmentId");

CREATE INDEX "PlatosBudgetCap_scope_scopeType_idx"
  ON "public"."PlatosBudgetCap"("organizationId", "projectId", "environmentId", "scopeType");

ALTER TABLE "public"."PlatosBudgetCap"
  ADD CONSTRAINT "PlatosBudgetCap_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 3. PlatosSafetyEvent
CREATE TABLE "public"."PlatosSafetyEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "agentId" TEXT,
    "threadId" TEXT,
    "messageId" TEXT,
    "userId" TEXT,
    "detector" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "detail" TEXT,
    "meta" JSONB,
    "toolName" TEXT,
    "toolCallId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatosSafetyEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PlatosSafetyEvent_scope_createdAt_idx"
  ON "public"."PlatosSafetyEvent"("organizationId", "projectId", "environmentId", "createdAt" DESC);

CREATE INDEX "PlatosSafetyEvent_scope_detector_idx"
  ON "public"."PlatosSafetyEvent"("organizationId", "projectId", "environmentId", "detector");

CREATE INDEX "PlatosSafetyEvent_scope_threadId_idx"
  ON "public"."PlatosSafetyEvent"("organizationId", "projectId", "environmentId", "threadId");

CREATE INDEX "PlatosSafetyEvent_scope_agentId_idx"
  ON "public"."PlatosSafetyEvent"("organizationId", "projectId", "environmentId", "agentId");

ALTER TABLE "public"."PlatosSafetyEvent"
  ADD CONSTRAINT "PlatosSafetyEvent_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
