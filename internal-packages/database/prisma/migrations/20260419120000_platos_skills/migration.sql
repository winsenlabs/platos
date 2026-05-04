-- Platos Theme S — Skills framework (S.1).
--
-- Two tables:
--   - PlatosSkill       : registered skill manifest (official, community, custom)
--   - PlatosAgentSkill  : per-agent enablement (join)
--
-- Scope: every row is keyed by (organizationId, projectId, environmentId).
-- Official skills set projectId + environmentId NULL so every project/env
-- within the organization can enable them without duplicating the row.
--
-- Required env vars (JSON array of strings) are checked at enable-time in
-- SkillRegistryService — never at runtime (THEME_S §5, PLATOS_SPEC §10 #7).

-- CreateTable PlatosSkill
CREATE TABLE "public"."PlatosSkill" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "environmentId" TEXT,
    "skillId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '0.0.1',
    "author" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'custom',
    "isOfficial" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "promptBlock" TEXT NOT NULL,
    "providesTools" JSONB,
    "requiredEnv" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "optionalEnv" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "importedFrom" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosSkill_pkey" PRIMARY KEY ("id")
);

-- Unique skill id per scope tuple. NULLS NOT DISTINCT so the official-skill
-- rows (projectId/environmentId NULL) collapse on (org, skillId) alone.
-- Requires PostgreSQL 15+, which matches the Platos deploy target.
CREATE UNIQUE INDEX "PlatosSkill_organizationId_projectId_environmentId_skillId_key"
    ON "public"."PlatosSkill"("organizationId", "projectId", "environmentId", "skillId") NULLS NOT DISTINCT;

CREATE INDEX "PlatosSkill_organizationId_projectId_environmentId_idx"
    ON "public"."PlatosSkill"("organizationId", "projectId", "environmentId");

CREATE INDEX "PlatosSkill_isOfficial_idx"
    ON "public"."PlatosSkill"("isOfficial");

CREATE INDEX "PlatosSkill_skillId_idx"
    ON "public"."PlatosSkill"("skillId");

ALTER TABLE "public"."PlatosSkill"
    ADD CONSTRAINT "PlatosSkill_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."PlatosSkill"
    ADD CONSTRAINT "PlatosSkill_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."PlatosSkill"
    ADD CONSTRAINT "PlatosSkill_environmentId_fkey"
    FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable PlatosAgentSkill
CREATE TABLE "public"."PlatosAgentSkill" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB,
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosAgentSkill_pkey" PRIMARY KEY ("id")
);

-- One row per (agent, skill) — a skill is either on or off for an agent.
CREATE UNIQUE INDEX "PlatosAgentSkill_agentId_skillId_key"
    ON "public"."PlatosAgentSkill"("agentId", "skillId");

CREATE INDEX "PlatosAgentSkill_skillId_idx"
    ON "public"."PlatosAgentSkill"("skillId");

CREATE INDEX "PlatosAgentSkill_organizationId_projectId_environmentId_idx"
    ON "public"."PlatosAgentSkill"("organizationId", "projectId", "environmentId");

ALTER TABLE "public"."PlatosAgentSkill"
    ADD CONSTRAINT "PlatosAgentSkill_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "public"."PlatosAgent"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."PlatosAgentSkill"
    ADD CONSTRAINT "PlatosAgentSkill_skillId_fkey"
    FOREIGN KEY ("skillId") REFERENCES "public"."PlatosSkill"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
