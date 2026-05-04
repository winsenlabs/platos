-- Platos Theme E.5 — Tool-call audit + replay.
--
-- Adds the PlatosToolCallAudit table. One row per dispatched tool call, stamped
-- with the full scope tuple + routing target so the /monitoring/tool-audit
-- endpoint can filter without cross-joins and the replay action can re-route
-- through the same entity PK even if the human-readable slug is renamed.
--
-- All statements use `IF NOT EXISTS` so the migration is idempotent on databases
-- that may already carry a partial state (common during branch juggling).

CREATE TABLE IF NOT EXISTS "public"."PlatosToolCallAudit" (
    "id"             TEXT NOT NULL,

    "organizationId" TEXT NOT NULL,
    "projectId"      TEXT NOT NULL,
    "environmentId"  TEXT NOT NULL,

    "toolId"         TEXT,
    "toolName"       TEXT NOT NULL,

    "entityId"       TEXT,
    "entityPk"       TEXT,

    "agentId"        TEXT,
    "threadId"       TEXT,
    "userId"         TEXT,

    "traceId"        TEXT,
    "spanId"         TEXT,
    "parentSpanId"   TEXT,

    "args"           JSONB NOT NULL,
    "result"         JSONB,
    "error"          TEXT,
    "status"         TEXT NOT NULL,
    "latencyMs"      INTEGER NOT NULL,

    "costCents"      DOUBLE PRECISION,

    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatosToolCallAudit_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."PlatosToolCallAudit"
    DROP CONSTRAINT IF EXISTS "PlatosToolCallAudit_environmentId_fkey",
    ADD CONSTRAINT "PlatosToolCallAudit_environmentId_fkey"
        FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

-- Indexes for the /monitoring/tool-audit list filters.
CREATE INDEX IF NOT EXISTS "PlatosToolCallAudit_scope_createdAt_idx"
    ON "public"."PlatosToolCallAudit"("organizationId", "projectId", "environmentId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "PlatosToolCallAudit_scope_threadId_idx"
    ON "public"."PlatosToolCallAudit"("organizationId", "projectId", "environmentId", "threadId");

CREATE INDEX IF NOT EXISTS "PlatosToolCallAudit_scope_agentId_idx"
    ON "public"."PlatosToolCallAudit"("organizationId", "projectId", "environmentId", "agentId");

CREATE INDEX IF NOT EXISTS "PlatosToolCallAudit_scope_toolName_idx"
    ON "public"."PlatosToolCallAudit"("organizationId", "projectId", "environmentId", "toolName");

CREATE INDEX IF NOT EXISTS "PlatosToolCallAudit_scope_status_idx"
    ON "public"."PlatosToolCallAudit"("organizationId", "projectId", "environmentId", "status");
