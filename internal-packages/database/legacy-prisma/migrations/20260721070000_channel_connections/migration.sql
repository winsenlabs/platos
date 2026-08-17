-- Platos — Connect reimagining: channel doorways.
--
-- (1) PlatosConnectedEntity gains `capabilities TEXT[]` — an entity is a
--     doorway, and its capabilities declare which kinds ("tools" | "channel" |
--     "identity"). Default ARRAY['tools'] preserves the classic tool-sync
--     behaviour for every existing row.
--
-- (2) PlatosChannelConnection — a messaging-channel doorway (Slack / Telegram /
--     WhatsApp / Discord) bound to ONE agent. `credentials` is an ENCRYPTED
--     envelope (MessageCryptoService, opaque base64 → TEXT). `webhookSecret` is
--     a random 32-byte hex first auth factor on the inbound URL. FK to
--     PlatosConnectedEntity is optional (ON DELETE SET NULL) so a channel can
--     outlive its entity.
--
-- (3) PlatosChannelThread — maps a channel-native conversation to a Platos
--     thread; (connectionId, channelThreadKey) is unique. FK to
--     PlatosChannelConnection cascades on delete.
--
-- All statements use `IF NOT EXISTS` / `DROP ... IF EXISTS` so the migration is
-- idempotent on databases carrying partial state (branch juggling / migration
-- drift on the deploy target, which may apply this via psql directly).
--
-- Index / constraint names are pre-truncated to Postgres' 63-char identifier
-- limit, matching EXACTLY the names Prisma generates (base truncated to 59
-- chars + suffix — same rule as PlatosEndUserIdentity's
-- "..._environmentI_key"). Using untruncated names would let Postgres truncate
-- them differently and cause `prisma migrate dev` to report schema drift.

-- ═══════════════════════════════════════════════════════════════════════════════
-- PlatosConnectedEntity: capabilities
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE "public"."PlatosConnectedEntity"
    ADD COLUMN IF NOT EXISTS "capabilities" TEXT[] NOT NULL DEFAULT ARRAY['tools']::TEXT[];

-- ═══════════════════════════════════════════════════════════════════════════════
-- PlatosChannelConnection: new table
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "public"."PlatosChannelConnection" (
    "id"             TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId"      TEXT NOT NULL,
    "environmentId"  TEXT NOT NULL,
    "entityPk"       TEXT,
    "provider"       TEXT NOT NULL,
    "displayName"    TEXT,
    "agentId"        TEXT NOT NULL,
    -- RUNTIME (one connection → many agents, v1): ordered rule list that
    -- overrides `agentId` per-message. Null => every message uses `agentId`.
    -- See schema.prisma PlatosChannelConnection.agentRouting for the shape.
    "agentRouting"   JSONB,
    "enabled"        BOOLEAN NOT NULL DEFAULT true,
    "credentials"    TEXT,
    "config"         JSONB,
    "webhookSecret"  TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosChannelConnection_pkey" PRIMARY KEY ("id")
);

-- Idempotent add for databases that already carry a partial
-- PlatosChannelConnection from earlier branch juggling (the CREATE TABLE
-- above is a no-op via IF NOT EXISTS, so the new column needs its own guard).
ALTER TABLE "public"."PlatosChannelConnection"
    ADD COLUMN IF NOT EXISTS "agentRouting" JSONB;

-- @@index([organizationId, projectId, environmentId, provider]) — truncated
-- (59-char base + "_idx"); full name would be
-- "..._environmentId_provider_idx".
CREATE INDEX IF NOT EXISTS "PlatosChannelConnection_organizationId_projectId_environmen_idx"
    ON "public"."PlatosChannelConnection"("organizationId", "projectId", "environmentId", "provider");

CREATE INDEX IF NOT EXISTS "PlatosChannelConnection_agentId_idx"
    ON "public"."PlatosChannelConnection"("agentId");

-- ═══════════════════════════════════════════════════════════════════════════════
-- PlatosChannelThread: new table
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "public"."PlatosChannelThread" (
    "id"               TEXT NOT NULL,
    "connectionId"     TEXT NOT NULL,
    "channelThreadKey" TEXT NOT NULL,
    "platosThreadId"   TEXT NOT NULL,
    "platosEndUserId"  TEXT,
    -- RUNTIME: the agent PINNED to this channel-native conversation on first
    -- contact (resolved once via PlatosChannelConnection.agentRouting, then
    -- frozen so a conversation never switches agents mid-thread).
    "agentId"          TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosChannelThread_pkey" PRIMARY KEY ("id")
);

-- Idempotent add for databases that already carry a partial
-- PlatosChannelThread (CREATE TABLE above is a no-op via IF NOT EXISTS).
ALTER TABLE "public"."PlatosChannelThread"
    ADD COLUMN IF NOT EXISTS "agentId" TEXT;

-- @@unique([connectionId, channelThreadKey]) — 53 chars, no truncation.
CREATE UNIQUE INDEX IF NOT EXISTS "PlatosChannelThread_connectionId_channelThreadKey_key"
    ON "public"."PlatosChannelThread"("connectionId", "channelThreadKey");

CREATE INDEX IF NOT EXISTS "PlatosChannelThread_platosThreadId_idx"
    ON "public"."PlatosChannelThread"("platosThreadId");

-- @@index([agentId]) — 31 chars, no truncation. Pinned-agent lookups per
-- channel-thread (and agent-scoped sweeps).
CREATE INDEX IF NOT EXISTS "PlatosChannelThread_agentId_idx"
    ON "public"."PlatosChannelThread"("agentId");

-- ═══════════════════════════════════════════════════════════════════════════════
-- Foreign keys
-- ═══════════════════════════════════════════════════════════════════════════════
-- PlatosChannelConnection.entityPk → PlatosConnectedEntity.id (onDelete: SetNull)
ALTER TABLE "public"."PlatosChannelConnection"
    DROP CONSTRAINT IF EXISTS "PlatosChannelConnection_entityPk_fkey",
    ADD CONSTRAINT "PlatosChannelConnection_entityPk_fkey"
        FOREIGN KEY ("entityPk") REFERENCES "public"."PlatosConnectedEntity"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;

-- PlatosChannelThread.connectionId → PlatosChannelConnection.id (onDelete: Cascade)
ALTER TABLE "public"."PlatosChannelThread"
    DROP CONSTRAINT IF EXISTS "PlatosChannelThread_connectionId_fkey",
    ADD CONSTRAINT "PlatosChannelThread_connectionId_fkey"
        FOREIGN KEY ("connectionId") REFERENCES "public"."PlatosChannelConnection"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
