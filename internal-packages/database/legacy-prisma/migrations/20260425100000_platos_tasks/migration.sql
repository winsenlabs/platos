-- PIFSP-12 — Operator-authored custom tasks (PlatosTask model).
--
-- Stores task definitions including the JS handler source and compiled output.
-- The `platos-custom-task` trigger.dev task looks up this row at runtime and
-- executes `compiledHandler` inside a Node vm sandbox.

CREATE TABLE IF NOT EXISTS "PlatosTask" (
    "id"               TEXT NOT NULL,
    "organizationId"   TEXT NOT NULL,
    "projectId"        TEXT NOT NULL,
    "environmentId"    TEXT NOT NULL,
    "taskId"           TEXT NOT NULL,
    "displayName"      TEXT NOT NULL,
    "description"      TEXT,
    "triggerType"      TEXT NOT NULL DEFAULT 'manual',
    "scheduleCron"     TEXT,
    "scheduleTimezone" TEXT,
    "webhookSecret"    TEXT,
    "allowedAgentIds"  TEXT[] NOT NULL DEFAULT '{}',
    "payloadSchema"    JSONB,
    "handler"          TEXT NOT NULL,
    "compiledHandler"  TEXT,
    "handlerVersion"   INTEGER NOT NULL DEFAULT 1,
    "timeout"          INTEGER NOT NULL DEFAULT 300,
    "maxRetries"       INTEGER NOT NULL DEFAULT 3,
    "isActive"         BOOLEAN NOT NULL DEFAULT true,
    "createdBy"        TEXT NOT NULL,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,
    "lastRunAt"        TIMESTAMP(3),

    CONSTRAINT "PlatosTask_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PlatosTask_orgProjEnvTaskId_key"
    ON "PlatosTask"("organizationId", "projectId", "environmentId", "taskId");

CREATE INDEX IF NOT EXISTS "PlatosTask_orgProjEnv_idx"
    ON "PlatosTask"("organizationId", "projectId", "environmentId");

CREATE INDEX IF NOT EXISTS "PlatosTask_triggerType_isActive_idx"
    ON "PlatosTask"("triggerType", "isActive");

ALTER TABLE "PlatosTask"
    ADD CONSTRAINT "PlatosTask_environmentId_fkey"
    FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
