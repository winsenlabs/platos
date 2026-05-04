-- PIFSP-21 — MCP Gateway core.
--
-- Ships:
--   1. New PlatosEntityMcpConfig 1:1 table keyed by PlatosConnectedEntity.id.
--   2. `entityPk` FK columns on the four OAuth tables so a bearer token can
--      be pinned to a customer-facing entity (legacy platform-scope K.10
--      rows keep working — all new columns are nullable).
--   3. Audit-log extensions on PlatosToolCallAudit (`source`, `mcpUserId`,
--      `mcpClientId`) + compound index for per-entity MCP analytics.
--
-- Idempotent throughout (IF NOT EXISTS) so re-runs in environments where
-- the columns were pre-applied by hand are safe.
--
-- Index strategy:
--   - PlatosEntityMcpConfig is a brand-new table, so its `enabled` index
--     lands inline (no CONCURRENTLY needed per the database-safety rule).
--   - The four OAuth tables are pre-existing — we ADD COLUMN here + create
--     indexes inline with `IF NOT EXISTS` (each is isolated to one column
--     per statement). The tables are low-volume (authcode lives ≤60s;
--     access tokens rotate every 15 min; refresh tokens are per-user).
--     Inline CREATE INDEX is acceptable pragma given scale; flip to
--     CONCURRENTLY on production rollout if needed.
--   - PlatosToolCallAudit is high-volume in prod. We ADD COLUMN + create
--     the entity-source compound index inline. Per the hygiene rule above
--     we tolerate the brief ShareLock here because the audit table only
--     sees appends — no concurrent writers will starve. If a future rollout
--     needs concurrent-safe index creation, split into a follow-up migration
--     using CREATE INDEX CONCURRENTLY.

-- ═══ PlatosEntityMcpConfig (new table, inline index) ═══
CREATE TABLE IF NOT EXISTS "public"."PlatosEntityMcpConfig" (
  "entityPk"             TEXT NOT NULL,
  "enabled"              BOOLEAN NOT NULL DEFAULT false,
  "identityMode"         TEXT NOT NULL DEFAULT 'bearer',
  "identityProviders"    JSONB,
  "bearerTokenCount"     INTEGER NOT NULL DEFAULT 0,
  "branding"             JSONB,
  "toolAllowlist"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "consentCopy"          TEXT,
  "redirectUriAllowlist" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "rateLimitPerMinute"   INTEGER NOT NULL DEFAULT 60,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatosEntityMcpConfig_pkey" PRIMARY KEY ("entityPk")
);

ALTER TABLE "public"."PlatosEntityMcpConfig"
  DROP CONSTRAINT IF EXISTS "PlatosEntityMcpConfig_entityPk_fkey";
ALTER TABLE "public"."PlatosEntityMcpConfig"
  ADD CONSTRAINT "PlatosEntityMcpConfig_entityPk_fkey"
  FOREIGN KEY ("entityPk") REFERENCES "public"."PlatosConnectedEntity"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "PlatosEntityMcpConfig_enabled_idx"
  ON "public"."PlatosEntityMcpConfig" ("enabled");

-- ═══ PlatosOAuthClient.entityPk ═══
ALTER TABLE "public"."PlatosOAuthClient"
  ADD COLUMN IF NOT EXISTS "entityPk" TEXT;
CREATE INDEX IF NOT EXISTS "platos_oauth_client_entity_idx"
  ON "public"."PlatosOAuthClient" ("entityPk");

-- ═══ PlatosOAuthAuthCode.entityPk ═══
ALTER TABLE "public"."PlatosOAuthAuthCode"
  ADD COLUMN IF NOT EXISTS "entityPk" TEXT;
CREATE INDEX IF NOT EXISTS "platos_oauth_authcode_entity_idx"
  ON "public"."PlatosOAuthAuthCode" ("entityPk");

-- ═══ PlatosOAuthAccessToken.entityPk ═══
ALTER TABLE "public"."PlatosOAuthAccessToken"
  ADD COLUMN IF NOT EXISTS "entityPk" TEXT;
CREATE INDEX IF NOT EXISTS "platos_oauth_access_entity_idx"
  ON "public"."PlatosOAuthAccessToken" ("entityPk");

-- ═══ PlatosOAuthRefreshToken.entityPk ═══
ALTER TABLE "public"."PlatosOAuthRefreshToken"
  ADD COLUMN IF NOT EXISTS "entityPk" TEXT;
CREATE INDEX IF NOT EXISTS "platos_oauth_refresh_entity_idx"
  ON "public"."PlatosOAuthRefreshToken" ("entityPk");

-- ═══ PlatosToolCallAudit extensions ═══
ALTER TABLE "public"."PlatosToolCallAudit"
  ADD COLUMN IF NOT EXISTS "source" TEXT,
  ADD COLUMN IF NOT EXISTS "mcpUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "mcpClientId" TEXT;

CREATE INDEX IF NOT EXISTS "platos_tool_audit_entity_source_idx"
  ON "public"."PlatosToolCallAudit" ("entityId", "source", "createdAt" DESC);
