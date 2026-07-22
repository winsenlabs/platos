-- ═══════════════════════════════════════════════════════════════════════════════
-- Connect v3 (Phase D) — OAuth token rotation flag on a channel APP.
--
-- `tokenRotation` mirrors Slack's app-level `token_rotation_enabled` setting
-- (declared in the manifest `settings.token_rotation_enabled`, which is
-- ONE-WAY). When enabled, oauth.v2.access returns a 12h `xoxe.` bot token, a
-- single-use `xoxe-1-` refresh token, and expires_in=43200; the runtime must
-- refresh the bot token before it expires (getFreshBotToken + a per-installation
-- Redis lock so two concurrent events can't double-refresh — refresh tokens are
-- single-use with a 2-active cap). The `refreshToken` + `tokenExpiresAt` columns
-- that carry the rotating grant already exist on PlatosChannelInstallation
-- (Phase A migration 20260722090000_channel_apps), and Phase A already tolerates
-- a refresh_token's absence, so `false` is a zero-behavior-change default.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS) so a partial re-run — or a deploy target
-- that applies this via psql directly — is safe.
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE "public"."PlatosChannelApp"
    ADD COLUMN IF NOT EXISTS "tokenRotation" BOOLEAN NOT NULL DEFAULT false;
