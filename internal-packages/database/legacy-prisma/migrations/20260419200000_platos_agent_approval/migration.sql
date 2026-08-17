-- Platos Theme E.6 — HITL approval ledger.
--
-- Adds the PlatosAgentApproval table. One row per `request_approval` /
-- `cancel_run` waitpoint the agent opens, stamped with the full scope tuple.
-- The agent runtime writes rows on waitpoint open + transitions status to
-- approved/rejected/timed_out as responses arrive. The `/monitoring/approvals`
-- endpoint filters on (org, project, env) so cross-scope enumeration is
-- structurally impossible.
--
-- All statements use `IF NOT EXISTS` so the migration is idempotent on databases
-- that may already carry a partial state (common during branch juggling).

CREATE TABLE IF NOT EXISTS "public"."PlatosAgentApproval" (
    "id"             TEXT NOT NULL,

    "approvalId"     TEXT NOT NULL,

    "organizationId" TEXT NOT NULL,
    "projectId"      TEXT NOT NULL,
    "environmentId"  TEXT NOT NULL,

    "source"         TEXT NOT NULL,

    "agentId"        TEXT,
    "threadId"       TEXT,
    "requestedBy"    TEXT,

    "action"         TEXT NOT NULL,
    "details"        TEXT,

    "status"         TEXT NOT NULL DEFAULT 'pending',

    "timeoutSeconds" INTEGER NOT NULL DEFAULT 300,

    "resolvedAt"     TIMESTAMP(3),
    "respondedBy"    TEXT,
    "comment"        TEXT,

    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosAgentApproval_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."PlatosAgentApproval"
    DROP CONSTRAINT IF EXISTS "PlatosAgentApproval_environmentId_fkey",
    ADD CONSTRAINT "PlatosAgentApproval_environmentId_fkey"
        FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

-- Unique on the human-readable approvalId inside a scope. The approvalId
-- is constructed by the agent runtime with enough entropy to be globally
-- unique, but we enforce per-scope uniqueness to protect against typos /
-- collisions in hand-authored replays.
CREATE UNIQUE INDEX IF NOT EXISTS "PlatosAgentApproval_scope_approvalId_key"
    ON "public"."PlatosAgentApproval"("organizationId", "projectId", "environmentId", "approvalId");

-- Index for the default `/monitoring/approvals` query: filter by
-- (scope, status, createdAt DESC). Covers the governance dashboard's
-- "open approvals" panel which is always status=pending.
CREATE INDEX IF NOT EXISTS "PlatosAgentApproval_scope_status_createdAt_idx"
    ON "public"."PlatosAgentApproval"("organizationId", "projectId", "environmentId", "status", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "PlatosAgentApproval_scope_agentId_idx"
    ON "public"."PlatosAgentApproval"("organizationId", "projectId", "environmentId", "agentId");

CREATE INDEX IF NOT EXISTS "PlatosAgentApproval_scope_threadId_idx"
    ON "public"."PlatosAgentApproval"("organizationId", "projectId", "environmentId", "threadId");

CREATE INDEX IF NOT EXISTS "PlatosAgentApproval_scope_createdAt_idx"
    ON "public"."PlatosAgentApproval"("organizationId", "projectId", "environmentId", "createdAt" DESC);
