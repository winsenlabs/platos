-- ═══════════════════════════════════════════════════════════════════════════════
-- Connect v3 (Phase C) — hosted account linking policy on a channel APP.
--
-- `linking` declares whether end-users must attach a VERIFIED email identity
-- (via Sign in with Slack / OIDC) before an agent turn runs:
--   none     — no linking behavior (default; zero behavior change).
--   optional — never blocks a turn; the connect URL is surfaced on demand.
--   required — an unlinked author's turn is withheld until they connect.
--
-- Bindings are PlatosEndUserIdentity rows (existing); the hosted flow's link
-- nonces live in Redis. NO new tables. Idempotent (IF NOT EXISTS) so a partial
-- re-run is safe.
-- ═══════════════════════════════════════════════════════════════════════════════
ALTER TABLE "public"."PlatosChannelApp"
    ADD COLUMN IF NOT EXISTS "linking" TEXT NOT NULL DEFAULT 'none';
