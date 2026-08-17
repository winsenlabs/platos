-- Theme K.10 — OAuth 2.1 + Dynamic Client Registration (RFC 7591 / 6749 / 7636 / 7662 / 7009).
-- All indexes inline — new tables, no pre-existing rows.

-- ═══ PlatosOAuthClient ═══
CREATE TABLE IF NOT EXISTS "public"."PlatosOAuthClient" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "clientSecretHash" TEXT,
  "clientName" TEXT NOT NULL,
  "redirectUris" TEXT[] NOT NULL,
  "tokenEndpointAuthMethod" TEXT NOT NULL DEFAULT 'client_secret_basic',
  "grantTypes" TEXT[] NOT NULL DEFAULT ARRAY['authorization_code','refresh_token']::TEXT[],
  "scope" TEXT,
  "registeredByUserId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatosOAuthClient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatosOAuthClient_clientId_key"
  ON "public"."PlatosOAuthClient" ("clientId");
CREATE INDEX "platos_oauth_client_org_idx"
  ON "public"."PlatosOAuthClient" ("organizationId");

-- ═══ PlatosOAuthAuthCode ═══
CREATE TABLE IF NOT EXISTS "public"."PlatosOAuthAuthCode" (
  "code" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "scopeTuple" JSONB NOT NULL,
  "codeChallenge" TEXT NOT NULL,
  "codeChallengeMethod" TEXT NOT NULL DEFAULT 'S256',
  "redirectUri" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatosOAuthAuthCode_pkey" PRIMARY KEY ("code")
);

CREATE INDEX "platos_oauth_authcode_client_user_idx"
  ON "public"."PlatosOAuthAuthCode" ("clientId", "userId");
CREATE INDEX "platos_oauth_authcode_expires_idx"
  ON "public"."PlatosOAuthAuthCode" ("expiresAt");

-- ═══ PlatosOAuthAccessToken ═══
CREATE TABLE IF NOT EXISTS "public"."PlatosOAuthAccessToken" (
  "tokenHash" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "scopeTuple" JSONB NOT NULL,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "PlatosOAuthAccessToken_pkey" PRIMARY KEY ("tokenHash")
);

CREATE INDEX "platos_oauth_access_client_user_idx"
  ON "public"."PlatosOAuthAccessToken" ("clientId", "userId");
CREATE INDEX "platos_oauth_access_expires_idx"
  ON "public"."PlatosOAuthAccessToken" ("expiresAt");

-- ═══ PlatosOAuthRefreshToken ═══
CREATE TABLE IF NOT EXISTS "public"."PlatosOAuthRefreshToken" (
  "tokenHash" TEXT NOT NULL,
  "accessTokenHash" TEXT,
  "clientId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "scopeTuple" JSONB NOT NULL,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "PlatosOAuthRefreshToken_pkey" PRIMARY KEY ("tokenHash")
);

CREATE INDEX "platos_oauth_refresh_client_user_idx"
  ON "public"."PlatosOAuthRefreshToken" ("clientId", "userId");
CREATE INDEX "platos_oauth_refresh_expires_idx"
  ON "public"."PlatosOAuthRefreshToken" ("expiresAt");
