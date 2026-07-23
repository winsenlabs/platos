-- IDENTITY-CORE §C — single-end-user gate BACKFILL.
--
-- The column-add migration (20260723100000) set `singleEndUser = true` on
-- EVERY existing PlatosAgentThread via its NOT NULL DEFAULT. That is wrong for
-- existing MULTI-HUMAN channel threads (shared channels / group DMs), which
-- would otherwise fail OPEN the day per-user Composio goes live. This migration
-- flips those to `false` so no latent cross-user bleed exists.
--
-- Rule (mirrors the runtime G1 + G6 predicate in channel-runtime.service.ts):
--   * A Platos thread reachable from a channel/app thread is single-end-user
--     ONLY when it is a Slack DM — i.e. the platform channel id (the 2nd
--     colon-delimited segment of the channelThreadKey, matching
--     extractPlatformChannelId) begins with "D".
--   * Slack group DMs ("G"/mpim) and channels ("C") ⇒ false (multi-human).
--   * Any NON-SLACK provider on the v1 channel-thread path has NO DM predicate,
--     so a "D"-prefix test is meaningless ⇒ FAIL CLOSED (false) for ALL of its
--     threads (same rule as G6).
--   * App-tier (PlatosChannelAppThread) is Slack-only, so the Slack DM
--     predicate applies directly.
--
-- Web/API/direct threads are NOT reachable from any channel/app thread, so they
-- are untouched and correctly keep `true`. Only sets values to `false`, so the
-- migration is safe to re-run (idempotent).
--
-- split_part(key, ':', 2) returns '' for a malformed key with no 2nd segment;
-- '' LIKE 'D%' is false, so such rows fall to `false` (fail closed) — the
-- intended conservative outcome.

-- v1 channel threads (any provider). False for everything EXCEPT Slack DMs.
UPDATE "public"."PlatosAgentThread" AS t
SET "singleEndUser" = false
FROM "public"."PlatosChannelThread" ct
JOIN "public"."PlatosChannelConnection" cc ON cc."id" = ct."connectionId"
WHERE ct."platosThreadId" = t."id"
  AND NOT (cc."provider" = 'slack' AND split_part(ct."channelThreadKey", ':', 2) LIKE 'D%');

-- App-tier channel threads (Slack-only). False for non-DM channel ids.
UPDATE "public"."PlatosAgentThread" AS t
SET "singleEndUser" = false
FROM "public"."PlatosChannelAppThread" cat
WHERE cat."platosThreadId" = t."id"
  AND split_part(cat."channelThreadKey", ':', 2) NOT LIKE 'D%';
