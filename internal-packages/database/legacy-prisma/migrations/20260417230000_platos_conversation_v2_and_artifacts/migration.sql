-- Platos Theme F — Conversation model v2 + artifacts.
--
-- Adds the PlatosAgentArtifact table (markdown/code/html/json/csv/svg/image
-- revisions, scope-stamped), augments PlatosAgentMessage with per-turn
-- `systemPromptOverride` + `outputSchema` plus soft-delete/edit lineage
-- (`status`, `parentMessageId`, `revision`), and augments PlatosAgentThread
-- with tags/pin/archive + fork lineage (`parentThreadId`, `forkedFromMessageId`).
--
-- All columns use `IF NOT EXISTS` so the migration is idempotent on databases
-- that may already carry a partial state (common during branch juggling).

-- ═══════════════════════════════════════════════════════════════════════════════
-- Thread: tags, pin, archive, fork lineage
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE "public"."PlatosAgentThread"
    ADD COLUMN IF NOT EXISTS "tags"                TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN IF NOT EXISTS "pinnedAt"            TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "archivedAt"          TIMESTAMP(3),
    ADD COLUMN IF NOT EXISTS "parentThreadId"      TEXT,
    ADD COLUMN IF NOT EXISTS "forkedFromMessageId" TEXT;

-- Self-referential FK — forked threads point back at their parent, set null
-- on delete so deleting a parent doesn't cascade-remove forks (the fork is
-- self-contained once created).
ALTER TABLE "public"."PlatosAgentThread"
    DROP CONSTRAINT IF EXISTS "PlatosAgentThread_parentThreadId_fkey",
    ADD CONSTRAINT "PlatosAgentThread_parentThreadId_fkey"
        FOREIGN KEY ("parentThreadId") REFERENCES "public"."PlatosAgentThread"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;

-- EOBD.25 — index on pre-existing table PlatosAgentThread moved to its
-- own migration using CREATE INDEX CONCURRENTLY (see
-- 20260421100000_platos_thread_parent_concurrent_idx/migration.sql).
-- Keeping a comment placeholder here so migration ordering is obvious
-- when reading the history.

-- ═══════════════════════════════════════════════════════════════════════════════
-- Message: per-turn override, structured output, edit lineage
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE "public"."PlatosAgentMessage"
    ADD COLUMN IF NOT EXISTS "systemPromptOverride" TEXT,
    ADD COLUMN IF NOT EXISTS "outputSchema"         JSONB,
    ADD COLUMN IF NOT EXISTS "status"               TEXT NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS "parentMessageId"      TEXT,
    ADD COLUMN IF NOT EXISTS "revision"             INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "public"."PlatosAgentMessage"
    DROP CONSTRAINT IF EXISTS "PlatosAgentMessage_parentMessageId_fkey",
    ADD CONSTRAINT "PlatosAgentMessage_parentMessageId_fkey"
        FOREIGN KEY ("parentMessageId") REFERENCES "public"."PlatosAgentMessage"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;

-- EOBD.25 — indexes on pre-existing table PlatosAgentMessage moved to
-- their own separate CONCURRENTLY migrations (one index per file, per
-- .claude/rules/database-safety.md). See:
--   20260421100100_platos_message_thread_status_concurrent_idx/migration.sql
--   20260421100200_platos_message_parent_concurrent_idx/migration.sql

-- ═══════════════════════════════════════════════════════════════════════════════
-- Artifacts: new table
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "public"."PlatosAgentArtifact" (
    "id"                  TEXT NOT NULL,
    "organizationId"      TEXT NOT NULL,
    "projectId"           TEXT NOT NULL,
    "environmentId"       TEXT NOT NULL,
    "threadId"            TEXT NOT NULL,
    "artifactKey"         TEXT NOT NULL,
    "revision"            INTEGER NOT NULL DEFAULT 1,
    "kind"                TEXT NOT NULL,
    "title"               TEXT,
    "language"            TEXT,
    "content"             TEXT NOT NULL,
    "metadata"            JSONB,
    "producedByMessageId" TEXT,
    "createdBy"           TEXT NOT NULL,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatosAgentArtifact_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PlatosAgentArtifact_threadId_artifactKey_revision_key"
    ON "public"."PlatosAgentArtifact"("threadId", "artifactKey", "revision");

CREATE INDEX IF NOT EXISTS "PlatosAgentArtifact_organizationId_projectId_environmentId_idx"
    ON "public"."PlatosAgentArtifact"("organizationId", "projectId", "environmentId");

CREATE INDEX IF NOT EXISTS "PlatosAgentArtifact_threadId_artifactKey_idx"
    ON "public"."PlatosAgentArtifact"("threadId", "artifactKey");

CREATE INDEX IF NOT EXISTS "PlatosAgentArtifact_threadId_createdAt_idx"
    ON "public"."PlatosAgentArtifact"("threadId", "createdAt");

ALTER TABLE "public"."PlatosAgentArtifact"
    DROP CONSTRAINT IF EXISTS "PlatosAgentArtifact_organizationId_fkey",
    ADD CONSTRAINT "PlatosAgentArtifact_organizationId_fkey"
        FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."PlatosAgentArtifact"
    DROP CONSTRAINT IF EXISTS "PlatosAgentArtifact_projectId_fkey",
    ADD CONSTRAINT "PlatosAgentArtifact_projectId_fkey"
        FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."PlatosAgentArtifact"
    DROP CONSTRAINT IF EXISTS "PlatosAgentArtifact_environmentId_fkey",
    ADD CONSTRAINT "PlatosAgentArtifact_environmentId_fkey"
        FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."PlatosAgentArtifact"
    DROP CONSTRAINT IF EXISTS "PlatosAgentArtifact_threadId_fkey",
    ADD CONSTRAINT "PlatosAgentArtifact_threadId_fkey"
        FOREIGN KEY ("threadId") REFERENCES "public"."PlatosAgentThread"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
