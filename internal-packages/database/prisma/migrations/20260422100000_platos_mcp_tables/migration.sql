-- Theme K — Universal MCP Gateway tables.
-- New tables only; all indexes inline since there's no pre-existing data.

-- ═══ PlatosMCPToken ═══
CREATE TABLE IF NOT EXISTS "public"."PlatosMCPToken" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "environmentId" TEXT NOT NULL,
  "mintedByUserId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "permissions" TEXT[] NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "revokedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatosMCPToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatosMCPToken_tokenHash_key"
  ON "public"."PlatosMCPToken" ("tokenHash");
CREATE INDEX "platos_mcp_token_scope_idx"
  ON "public"."PlatosMCPToken" ("organizationId", "projectId", "environmentId");
CREATE INDEX "platos_mcp_token_expires_idx"
  ON "public"."PlatosMCPToken" ("expiresAt");

ALTER TABLE "public"."PlatosMCPToken"
  ADD CONSTRAINT "PlatosMCPToken_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══ PlatosMCPServer ═══
CREATE TABLE IF NOT EXISTS "public"."PlatosMCPServer" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "environmentId" TEXT NOT NULL,
  "agentId" TEXT,
  "slug" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "transport" TEXT NOT NULL,
  "url" TEXT,
  "command" TEXT,
  "args" JSONB,
  "envVars" JSONB,
  "credsSecretKey" TEXT,
  "lastDiscoveryAt" TIMESTAMP(3),
  "discoveryError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatosMCPServer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platos_mcp_server_uniq"
  ON "public"."PlatosMCPServer" ("organizationId", "projectId", "environmentId", "agentId", "slug");
CREATE INDEX "platos_mcp_server_scope_idx"
  ON "public"."PlatosMCPServer" ("organizationId", "projectId", "environmentId");

ALTER TABLE "public"."PlatosMCPServer"
  ADD CONSTRAINT "PlatosMCPServer_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══ PlatosMCPServerTool ═══
CREATE TABLE IF NOT EXISTS "public"."PlatosMCPServerTool" (
  "id" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "inputSchema" JSONB NOT NULL,
  "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatosMCPServerTool_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platos_mcp_server_tool_uniq"
  ON "public"."PlatosMCPServerTool" ("serverId", "name");

ALTER TABLE "public"."PlatosMCPServerTool"
  ADD CONSTRAINT "PlatosMCPServerTool_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "public"."PlatosMCPServer"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══ PlatosAgentMCPBinding ═══
CREATE TABLE IF NOT EXISTS "public"."PlatosAgentMCPBinding" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "environmentId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "serverId" TEXT NOT NULL,
  "enabledTools" TEXT[] NOT NULL,
  "allToolsEnabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatosAgentMCPBinding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "platos_mcp_binding_uniq"
  ON "public"."PlatosAgentMCPBinding" ("organizationId", "projectId", "environmentId", "agentId", "serverId");
CREATE INDEX "platos_mcp_binding_agent_idx"
  ON "public"."PlatosAgentMCPBinding" ("organizationId", "projectId", "environmentId", "agentId");

ALTER TABLE "public"."PlatosAgentMCPBinding"
  ADD CONSTRAINT "PlatosAgentMCPBinding_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."PlatosAgentMCPBinding"
  ADD CONSTRAINT "PlatosAgentMCPBinding_serverId_fkey"
  FOREIGN KEY ("serverId") REFERENCES "public"."PlatosMCPServer"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ═══ PlatosOrgMcpPolicy ═══
CREATE TABLE IF NOT EXISTS "public"."PlatosOrgMcpPolicy" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "environmentId" TEXT NOT NULL,
  "pattern" TEXT NOT NULL,
  "policy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PlatosOrgMcpPolicy_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platos_mcp_policy_scope_idx"
  ON "public"."PlatosOrgMcpPolicy" ("organizationId", "projectId", "environmentId", "pattern");

ALTER TABLE "public"."PlatosOrgMcpPolicy"
  ADD CONSTRAINT "PlatosOrgMcpPolicy_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
