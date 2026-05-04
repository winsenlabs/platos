-- PIFSP-22: MCP identity session tables

CREATE TABLE "PlatosMcpAnonSession" (
    "id" TEXT NOT NULL,
    "entityPk" TEXT NOT NULL,
    "mcpUserId" TEXT NOT NULL,
    "firstSeenIp" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "PlatosMcpAnonSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatosMcpAnonSession_mcpUserId_key" ON "PlatosMcpAnonSession"("mcpUserId");
CREATE INDEX "platos_mcp_anon_entity_user_idx" ON "PlatosMcpAnonSession"("entityPk", "mcpUserId");

CREATE TABLE "PlatosMcpOidcSession" (
    "id" TEXT NOT NULL,
    "entityPk" TEXT NOT NULL,
    "mcpUserId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "email" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "externalSub" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "firstLoginAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "PlatosMcpOidcSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatosMcpOidcSession_mcpUserId_key" ON "PlatosMcpOidcSession"("mcpUserId");
CREATE INDEX "platos_mcp_oidc_entity_user_idx" ON "PlatosMcpOidcSession"("entityPk", "mcpUserId");
CREATE INDEX "platos_mcp_oidc_entity_email_idx" ON "PlatosMcpOidcSession"("entityPk", "email");

CREATE TABLE "PlatosMcpBearerToken" (
    "id" TEXT NOT NULL,
    "entityPk" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "mcpUserId" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY['mcp:tools']::TEXT[],
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "PlatosMcpBearerToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatosMcpBearerToken_tokenHash_key" ON "PlatosMcpBearerToken"("tokenHash");
CREATE INDEX "platos_mcp_bearer_hash_idx" ON "PlatosMcpBearerToken"("tokenHash");
CREATE INDEX "platos_mcp_bearer_entity_idx" ON "PlatosMcpBearerToken"("entityPk", "revokedAt");
