-- PlatosAccessKey
CREATE TABLE "PlatosAccessKey" (
    "id"             TEXT        NOT NULL,
    "organizationId" TEXT        NOT NULL,
    "projectId"      TEXT        NOT NULL,
    "environmentId"  TEXT        NOT NULL,
    "keyPrefix"      TEXT        NOT NULL,
    "keyHash"        TEXT        NOT NULL,
    "allowedOrigins" TEXT[]      NOT NULL DEFAULT '{}',
    "lastUsedAt"     TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatosAccessKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "platos_access_key_scope_uniq" ON "PlatosAccessKey"("organizationId","projectId","environmentId");
CREATE INDEX "platos_access_key_scope_idx" ON "PlatosAccessKey"("organizationId","projectId","environmentId");
ALTER TABLE "PlatosAccessKey" ADD CONSTRAINT "PlatosAccessKey_environmentId_fkey"
    FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- PlatosPostmanTemplate
CREATE TABLE "PlatosPostmanTemplate" (
    "id"             TEXT        NOT NULL,
    "organizationId" TEXT        NOT NULL,
    "projectId"      TEXT        NOT NULL,
    "environmentId"  TEXT        NOT NULL,
    "agentId"        TEXT        NOT NULL,
    "name"           TEXT        NOT NULL,
    "simulateUserId" TEXT        NOT NULL,
    "sessionContext" JSONB,
    "createdBy"      TEXT        NOT NULL,
    "isDefault"      BOOLEAN     NOT NULL DEFAULT false,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatosPostmanTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "platos_postman_tmpl_scope_agent_idx" ON "PlatosPostmanTemplate"("organizationId","projectId","environmentId","agentId");
ALTER TABLE "PlatosPostmanTemplate" ADD CONSTRAINT "PlatosPostmanTemplate_environmentId_fkey"
    FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlatosPostmanTemplate" ADD CONSTRAINT "PlatosPostmanTemplate_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "PlatosAgent"("id") ON DELETE CASCADE;
