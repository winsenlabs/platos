-- Multi-tenant CORS: each PlatosConnectedEntity declares its own list
-- of browser origins it can be embedded from. The agent's CORS handler
-- unions every entity's allowedOrigins with the operator-trusted
-- PLATOS_CORS_ORIGIN list, refreshed in-memory every 30s.
--
-- Default `[]` = backend-only (browser preflights rejected even with a
-- valid session token), preserving the prior posture for existing rows.

ALTER TABLE "PlatosConnectedEntity"
  ADD COLUMN IF NOT EXISTS "allowedOrigins" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
