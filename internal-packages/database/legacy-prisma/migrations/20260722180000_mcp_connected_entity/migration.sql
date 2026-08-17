-- MCP-as-connected-entity — Commit 1 (schema).
--
-- An external MCP server is modelled as a PlatosConnectedEntity with a new
-- transport discriminator. Three additive, non-destructive changes:
--
--   (a) PlatosConnectedEntity gains `connectionKind TEXT NOT NULL DEFAULT
--       'wire'`. Every existing row backfills to 'wire' (the classic inbound
--       platools/HMAC handshake), so wire dispatch is completely unaffected.
--       'mcp' rows are Platos-as-outbound-MCP-client.
--
--   (b) PlatosEntityMcpClient — new 1:1 table keyed by PlatosConnectedEntity.id
--       (PK = entityPk, ON DELETE CASCADE). Holds the outbound MCP transport
--       config (transport/url/credsSecretKey/headersTemplate) reparented off
--       the deleted standalone MCP-server row. This is the OPPOSITE direction
--       to PlatosEntityMcpConfig (Platos serving MCP) — two 1:1 configs, two
--       directions, same entity. Present iff connectionKind = 'mcp'.
--
--   (c) PlatosEntityToolMapping.callbackUrl becomes nullable (DROP NOT NULL).
--       Wire entities keep a callback URL; mcp-kind entities have none —
--       dispatch is outbound and never reads it. Existing rows keep their
--       values; the drop is non-destructive.
--
-- Idempotent throughout (IF NOT EXISTS / DROP ... IF EXISTS) so re-runs on a
-- database carrying partial state (branch juggling / manual pre-apply) are
-- safe. Mirrors the PlatosEntityMcpConfig migration's 1:1-table + FK style.

-- ═══════════════════════════════════════════════════════════════════════════════
-- (a) PlatosConnectedEntity: connectionKind discriminator
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE "public"."PlatosConnectedEntity"
  ADD COLUMN IF NOT EXISTS "connectionKind" TEXT NOT NULL DEFAULT 'wire';

-- ═══════════════════════════════════════════════════════════════════════════════
-- (b) PlatosEntityMcpClient: new 1:1 table (outbound MCP transport config)
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "public"."PlatosEntityMcpClient" (
  "entityPk"        TEXT NOT NULL,
  "transport"       TEXT NOT NULL,
  "url"             TEXT,
  "credsSecretKey"  TEXT,
  "headersTemplate" JSONB,
  "lastDiscoveryAt" TIMESTAMP(3),
  "discoveryError"  TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatosEntityMcpClient_pkey" PRIMARY KEY ("entityPk")
);

ALTER TABLE "public"."PlatosEntityMcpClient"
  DROP CONSTRAINT IF EXISTS "PlatosEntityMcpClient_entityPk_fkey";
ALTER TABLE "public"."PlatosEntityMcpClient"
  ADD CONSTRAINT "PlatosEntityMcpClient_entityPk_fkey"
  FOREIGN KEY ("entityPk") REFERENCES "public"."PlatosConnectedEntity"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════════════════
-- (c) PlatosEntityToolMapping.callbackUrl → nullable
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE "public"."PlatosEntityToolMapping"
  ALTER COLUMN "callbackUrl" DROP NOT NULL;
