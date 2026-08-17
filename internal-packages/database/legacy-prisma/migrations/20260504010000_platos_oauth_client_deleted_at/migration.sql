-- Theme MCPF-W3: PlatosOAuthClient.deletedAt soft-delete marker.
-- The `oauth.delete_client` MCP tool sets `deletedAt = now()` and cascades a
-- token revocation across PlatosOAuthAccessToken + PlatosOAuthRefreshToken
-- for the same clientId. Reads (`findClient`, `verifyClientSecret`) filter
-- `deletedAt IS NULL` so a deleted client cannot be used to mint or refresh
-- tokens — but the row stays around for audit-history reconstruction.

ALTER TABLE "PlatosOAuthClient" ADD COLUMN "deletedAt" TIMESTAMP(3);
