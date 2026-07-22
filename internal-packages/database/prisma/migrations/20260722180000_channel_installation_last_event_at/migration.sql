-- ═══════════════════════════════════════════════════════════════════════════════
-- Connect v3 (operator install tier) — per-install `lastEventAt` telemetry.
--
-- Additive, nullable column on PlatosChannelInstallation. It powers the
-- operator-facing status surface (channel-apps.controller `installationsStatus`
-- + the channel_apps.installations_status MCP tool): "when did this workspace
-- last send the bot a message?". Stamped fire-and-forget by
-- ChannelRuntimeService.handleAppEvent when a real inbound message is admitted,
-- NEVER on any control-flow branch — so hosted-OAuth event routing / reply
-- behaviour is unchanged and this is a zero-behaviour-change default (NULL until
-- the first inbound event).
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) so a partial re-run — or a deploy target
-- that applies this via psql directly — is safe.
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE "public"."PlatosChannelInstallation"
    ADD COLUMN IF NOT EXISTS "lastEventAt" TIMESTAMP(3);
