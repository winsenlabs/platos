-- PIFSP-14 — Multi-key provider support.
--
-- 1. New PlatosProviderKey table — stores named API keys per scope.
--    Key values live in the encrypted SecretStore; only the env-var name is here.
-- 2. PlatosAgent.providerKeyId — optional FK to pin an agent to a specific key.

CREATE TABLE IF NOT EXISTS "PlatosProviderKey" (
    "id"             TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId"      TEXT NOT NULL,
    "environmentId"  TEXT NOT NULL,
    "provider"       TEXT NOT NULL,
    "label"          TEXT NOT NULL,
    "envVarName"     TEXT NOT NULL,
    "isDefault"      BOOLEAN NOT NULL DEFAULT false,
    "createdBy"      TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,
    "lastUsedAt"     TIMESTAMP(3),

    CONSTRAINT "PlatosProviderKey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PlatosProviderKey_orgProjEnvProviderEnvVar_key"
    ON "PlatosProviderKey"("organizationId", "projectId", "environmentId", "provider", "envVarName");

CREATE INDEX IF NOT EXISTS "PlatosProviderKey_orgProjEnv_provider_idx"
    ON "PlatosProviderKey"("organizationId", "projectId", "environmentId", "provider");

CREATE INDEX IF NOT EXISTS "PlatosProviderKey_orgProjEnv_isDefault_idx"
    ON "PlatosProviderKey"("organizationId", "projectId", "environmentId", "isDefault");

ALTER TABLE "PlatosProviderKey"
    ADD CONSTRAINT "PlatosProviderKey_environmentId_fkey"
    FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Add providerKeyId column to PlatosAgent (nullable, no FK constraint — loose
-- coupling so deleting a key doesn't cascade-delete the agent row).
ALTER TABLE "PlatosAgent"
    ADD COLUMN IF NOT EXISTS "providerKeyId" TEXT;

-- Back-fill: for each existing PlatosProviderEnabled row that represents a
-- linked provider, create one PlatosProviderKey row with isDefault=true.
-- This ensures the new multi-key UI shows at least one key per linked provider.
-- We use the standard env-var naming convention (ANTHROPIC_API_KEY, etc.).
INSERT INTO "PlatosProviderKey"
    ("id", "organizationId", "projectId", "environmentId", "provider",
     "label", "envVarName", "isDefault", "createdBy", "createdAt", "updatedAt")
SELECT
    'ppk_' || substring(md5("pe"."id"), 1, 20),
    "pe"."organizationId",
    "pe"."projectId",
    "pe"."environmentId",
    "pe"."providerId",
    CASE "pe"."providerId"
        WHEN 'anthropic'      THEN 'Anthropic — primary'
        WHEN 'openai'         THEN 'OpenAI — primary'
        WHEN 'google'         THEN 'Google — primary'
        WHEN 'google-vertex'  THEN 'Google Vertex — primary'
        WHEN 'voyage'         THEN 'Voyage — primary'
        ELSE "pe"."providerId" || ' — primary'
    END,
    CASE "pe"."providerId"
        WHEN 'anthropic'      THEN 'ANTHROPIC_API_KEY'
        WHEN 'openai'         THEN 'OPENAI_API_KEY'
        WHEN 'google'         THEN 'GOOGLE_GENERATIVE_AI_API_KEY'
        WHEN 'google-vertex'  THEN 'GOOGLE_VERTEX_API_KEY'
        WHEN 'voyage'         THEN 'VOYAGE_API_KEY'
        ELSE upper("pe"."providerId") || '_API_KEY'
    END,
    true,
    'system-backfill',
    "pe"."linkedAt",
    "pe"."updatedAt"
FROM "PlatosProviderEnabled" "pe"
ON CONFLICT DO NOTHING;
