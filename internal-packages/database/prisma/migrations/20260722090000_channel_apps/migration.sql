-- Platos — Connect v3 (Phase A): marketplace-grade channel apps.
--
-- (1) PlatosChannelApp — the PUBLISHABLE, platform-owned app identity (per
--     provider) installed into N external workspaces via OAuth V2. Where
--     PlatosChannelConnection (v2) is one customer-owned channel bound to one
--     agent, this is the "Add to Slack" marketplace tier. Scope
--     (organizationId/projectId/environmentId) is the AGENT OWNER's; the
--     installations are external workspaces talking to that owner's agent.
--     `clientSecret` + `signingSecret` are ENCRYPTED envelopes
--     (MessageCryptoService, opaque base64 → TEXT) — same pattern as
--     PlatosChannelConnection.credentials.
--
-- (2) PlatosChannelInstallation — one row per external workspace that
--     installed a PlatosChannelApp. Keyed by (appId, teamId, enterpriseId): a
--     classic workspace install has teamId + enterpriseId NULL; an Enterprise
--     Grid org-install has teamId NULL + enterpriseId set. `botToken` +
--     `refreshToken` are ENCRYPTED envelopes. Uninstall is SOFT
--     (status=revoked) — app_uninstalled / tokens_revoked arrive in an
--     unguaranteed order, so we never hard-delete. FK to PlatosChannelApp
--     cascades on delete.
--
-- (3) PlatosChannelAppThread — maps a channel-native conversation inside an
--     installed workspace to a Platos thread; (installationId,
--     channelThreadKey) is unique. FK to PlatosChannelInstallation cascades.
--
-- All statements use `IF NOT EXISTS` / `DROP ... IF EXISTS` so the migration is
-- idempotent on databases carrying partial state (branch juggling / migration
-- drift on the deploy target, which may apply this via psql directly).
--
-- Index / constraint names are pre-truncated to Postgres' 63-char identifier
-- limit, matching EXACTLY the names Prisma generates (base truncated to 59
-- chars + suffix — same rule as PlatosChannelConnection's
-- "..._environmen_idx"). Using untruncated names would let Postgres truncate
-- them differently and cause `prisma migrate dev` to report schema drift.

-- ═══════════════════════════════════════════════════════════════════════════════
-- PlatosChannelApp: new table
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "public"."PlatosChannelApp" (
    "id"             TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId"      TEXT NOT NULL,
    "environmentId"  TEXT NOT NULL,
    "provider"       TEXT NOT NULL,
    "displayName"    TEXT,
    "clientId"       TEXT NOT NULL,
    "clientSecret"   TEXT NOT NULL,
    "signingSecret"  TEXT NOT NULL,
    "scopes"         TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "distribution"   TEXT NOT NULL DEFAULT 'private',
    "aiAppsSurface"  BOOLEAN NOT NULL DEFAULT true,
    "defaultAgentId" TEXT,
    "agentRouting"   JSONB,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosChannelApp_pkey" PRIMARY KEY ("id")
);

-- @@index([organizationId, projectId, environmentId, provider]) — truncated
-- (59-char base + "_idx"); full name would be
-- "..._environmentId_provider_idx".
CREATE INDEX IF NOT EXISTS "PlatosChannelApp_organizationId_projectId_environmentId_pro_idx"
    ON "public"."PlatosChannelApp"("organizationId", "projectId", "environmentId", "provider");

-- ═══════════════════════════════════════════════════════════════════════════════
-- PlatosChannelInstallation: new table
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "public"."PlatosChannelInstallation" (
    "id"                  TEXT NOT NULL,
    "appId"               TEXT NOT NULL,
    "teamId"              TEXT,
    "enterpriseId"        TEXT,
    "isEnterpriseInstall" BOOLEAN NOT NULL DEFAULT false,
    "teamName"            TEXT,
    "botToken"            TEXT NOT NULL,
    "refreshToken"        TEXT,
    "tokenExpiresAt"      TIMESTAMP(3),
    "botUserId"           TEXT,
    "grantedScopes"       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "agentId"             TEXT,
    "agentRouting"        JSONB,
    "installedByUserId"   TEXT,
    "status"              TEXT NOT NULL DEFAULT 'active',
    "revokedAt"           TIMESTAMP(3),
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosChannelInstallation_pkey" PRIMARY KEY ("id")
);

-- @@unique([appId, teamId, enterpriseId]) — 55 chars, no truncation.
-- NULL teamId/enterpriseId are DISTINCT in Postgres' default unique-index
-- semantics; the (appId, team.id ?? null, enterprise.id ?? null) upsert key is
-- always fully-specified by the OAuth callback, so this is the intended shape.
CREATE UNIQUE INDEX IF NOT EXISTS "PlatosChannelInstallation_appId_teamId_enterpriseId_key"
    ON "public"."PlatosChannelInstallation"("appId", "teamId", "enterpriseId");

-- @@index([appId, status]) — 42 chars, no truncation. Active-installation
-- lookups when routing an inbound event to a workspace.
CREATE INDEX IF NOT EXISTS "PlatosChannelInstallation_appId_status_idx"
    ON "public"."PlatosChannelInstallation"("appId", "status");

-- ═══════════════════════════════════════════════════════════════════════════════
-- PlatosChannelAppThread: new table
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "public"."PlatosChannelAppThread" (
    "id"               TEXT NOT NULL,
    "installationId"   TEXT NOT NULL,
    "channelThreadKey" TEXT NOT NULL,
    "platosThreadId"   TEXT NOT NULL,
    "platosEndUserId"  TEXT,
    "agentId"          TEXT,
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosChannelAppThread_pkey" PRIMARY KEY ("id")
);

-- @@unique([installationId, channelThreadKey]) — 58 chars, no truncation.
CREATE UNIQUE INDEX IF NOT EXISTS "PlatosChannelAppThread_installationId_channelThreadKey_key"
    ON "public"."PlatosChannelAppThread"("installationId", "channelThreadKey");

-- @@index([platosThreadId]) — 41 chars, no truncation.
CREATE INDEX IF NOT EXISTS "PlatosChannelAppThread_platosThreadId_idx"
    ON "public"."PlatosChannelAppThread"("platosThreadId");

-- ═══════════════════════════════════════════════════════════════════════════════
-- Foreign keys
-- ═══════════════════════════════════════════════════════════════════════════════
-- PlatosChannelInstallation.appId → PlatosChannelApp.id (onDelete: Cascade)
ALTER TABLE "public"."PlatosChannelInstallation"
    DROP CONSTRAINT IF EXISTS "PlatosChannelInstallation_appId_fkey",
    ADD CONSTRAINT "PlatosChannelInstallation_appId_fkey"
        FOREIGN KEY ("appId") REFERENCES "public"."PlatosChannelApp"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

-- PlatosChannelAppThread.installationId → PlatosChannelInstallation.id (onDelete: Cascade)
ALTER TABLE "public"."PlatosChannelAppThread"
    DROP CONSTRAINT IF EXISTS "PlatosChannelAppThread_installationId_fkey",
    ADD CONSTRAINT "PlatosChannelAppThread_installationId_fkey"
        FOREIGN KEY ("installationId") REFERENCES "public"."PlatosChannelInstallation"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
