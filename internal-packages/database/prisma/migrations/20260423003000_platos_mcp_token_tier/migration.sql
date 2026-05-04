-- Theme K.18 — PlatosMCPToken tier column.
--
-- "scope" (default) tokens are pinned to exactly one (org, project, env)
-- tuple and cannot see anything outside it. "admin" tokens can walk
-- every scope within the minting org; every non-block tool call they
-- issue auto-escalates to `require_approval` in the permission gateway.
-- Only org ADMIN members are allowed to mint admin-tier tokens
-- (enforced in PlatosMCPTokenService.mint()).
--
-- Column is NOT NULL with a default of 'scope' so existing rows remain
-- valid after backfill — the safe, non-breaking direction.

ALTER TABLE "public"."PlatosMCPToken"
  ADD COLUMN IF NOT EXISTS "tier" TEXT NOT NULL DEFAULT 'scope';
