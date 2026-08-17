-- PIFSP-22 follow-up: add entity-issued token storage to PlatosMcpOidcSession.
-- entityAccessToken / entityRefreshToken are AES-256 encrypted and forwarded
-- as X-Platos-Entity-Token on tool dispatch so entity backends can verify the
-- real user identity without Platos seeing the underlying credentials.

ALTER TABLE "PlatosMcpOidcSession"
  ADD COLUMN IF NOT EXISTS "entityAccessToken" TEXT,
  ADD COLUMN IF NOT EXISTS "entityRefreshToken" TEXT,
  ADD COLUMN IF NOT EXISTS "entityTokenExpiresAt" TIMESTAMP(3);
