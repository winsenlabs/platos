-- Platos — End-user identity resolution (link-not-merge).
--
-- Adds the PlatosEndUserIdentity table: channel-native identity claims
-- ("this person is `handle` on `channel`") that fan multiple identities into
-- one canonical PlatosEndUser. A (org, project, env, channel, handle) is
-- unique and never re-pointed once claimed. Also adds a free-form `metadata`
-- JSONB column to PlatosEndUser.
--
-- All statements use `IF NOT EXISTS` / `DROP ... IF EXISTS` so the migration is
-- idempotent on databases carrying partial state (branch juggling / migration
-- drift on the deploy target, which may apply this via psql directly).

-- ═══════════════════════════════════════════════════════════════════════════════
-- PlatosEndUser: free-form metadata
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE "public"."PlatosEndUser"
    ADD COLUMN IF NOT EXISTS "metadata" JSONB;

-- ═══════════════════════════════════════════════════════════════════════════════
-- PlatosEndUserIdentity: new table
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "public"."PlatosEndUserIdentity" (
    "id"              TEXT NOT NULL,
    "organizationId"  TEXT NOT NULL,
    "projectId"       TEXT NOT NULL,
    "environmentId"   TEXT NOT NULL,
    "platosEndUserId" TEXT NOT NULL,
    "channel"         TEXT NOT NULL,
    "handle"          TEXT NOT NULL,
    "verified"        BOOLEAN NOT NULL DEFAULT false,
    "sourceEntityId"  TEXT,
    "metadata"        JSONB,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosEndUserIdentity_pkey" PRIMARY KEY ("id")
);

-- NOTE: index name is pre-truncated to Postgres' 63-char identifier limit,
-- matching EXACTLY the name Prisma generates for the @@unique (59-char prefix
-- + "_key", same pattern as "BatchTaskRun_..._idempotenc_key"). Using the
-- untruncated 80-char name would let Postgres truncate it differently and
-- cause `prisma migrate dev` to report schema drift.
CREATE UNIQUE INDEX IF NOT EXISTS "PlatosEndUserIdentity_organizationId_projectId_environmentI_key"
    ON "public"."PlatosEndUserIdentity"("organizationId", "projectId", "environmentId", "channel", "handle");

CREATE INDEX IF NOT EXISTS "PlatosEndUserIdentity_platosEndUserId_idx"
    ON "public"."PlatosEndUserIdentity"("platosEndUserId");

ALTER TABLE "public"."PlatosEndUserIdentity"
    DROP CONSTRAINT IF EXISTS "PlatosEndUserIdentity_platosEndUserId_fkey",
    ADD CONSTRAINT "PlatosEndUserIdentity_platosEndUserId_fkey"
        FOREIGN KEY ("platosEndUserId") REFERENCES "public"."PlatosEndUser"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
