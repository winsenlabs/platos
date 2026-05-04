-- Platos Theme L — Memory L3 (semantic) + L4 (knowledge graph) primitives.
--
-- Adds three tables + pgvector extension for semantic-memory embeddings.
--
-- Prerequisite: the Postgres image ships `pgvector`. The docker-compose
-- config switched from `postgres:16` to `pgvector/pgvector:pg16` in the
-- same PR so this CREATE EXTENSION call is a no-op on fresh clusters
-- and idempotent on upgrades.
--
-- All statements use `IF NOT EXISTS` so the migration is safe to re-run
-- on databases that may already hold a partial state.

CREATE EXTENSION IF NOT EXISTS vector;

-- ─────────────────────────────────────────────────────────────────────
-- PlatosMemory — polymorphic long-term memory row. One row per fact /
-- preference / event / relationship. `embedding` is a 1536-dim vector
-- from the configured embedding provider (default OpenAI
-- text-embedding-3-small).
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "public"."PlatosMemory" (
    "id"                 TEXT        NOT NULL,

    "organizationId"     TEXT        NOT NULL,
    "projectId"          TEXT        NOT NULL,
    "environmentId"      TEXT        NOT NULL,

    "agentId"            TEXT,
    "userId"             TEXT        NOT NULL,

    "kind"               TEXT        NOT NULL,
    "content"            TEXT        NOT NULL,
    "metadata"           JSONB,

    "embedding"          vector(1536),

    "agentVisible"       BOOLEAN     NOT NULL DEFAULT TRUE,
    "source"             TEXT        NOT NULL,

    "sourceThreadId"     TEXT,
    "sourceMessageIds"   TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    "extractorVersion"   TEXT,

    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,
    "lastAccessedAt"     TIMESTAMP(3),

    CONSTRAINT "PlatosMemory_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."PlatosMemory"
    DROP CONSTRAINT IF EXISTS "PlatosMemory_environmentId_fkey",
    ADD CONSTRAINT "PlatosMemory_environmentId_fkey"
        FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "platos_mem_scope_user_idx"
    ON "public"."PlatosMemory"("organizationId", "projectId", "environmentId", "userId");

CREATE INDEX IF NOT EXISTS "platos_mem_scope_agent_idx"
    ON "public"."PlatosMemory"("organizationId", "projectId", "environmentId", "agentId");

CREATE INDEX IF NOT EXISTS "platos_mem_scope_kind_idx"
    ON "public"."PlatosMemory"("organizationId", "projectId", "environmentId", "kind");

CREATE INDEX IF NOT EXISTS "platos_mem_user_created_idx"
    ON "public"."PlatosMemory"("userId", "createdAt" DESC);

-- HNSW index for cosine-similarity semantic search. `vector_cosine_ops`
-- pairs with the `<=>` operator used by MemoryService.semanticSearch.
-- HNSW wins on recall quality at the cost of slightly slower writes;
-- ivfflat is a later-stage optimization for very large corpora.
CREATE INDEX IF NOT EXISTS "platos_mem_embedding_hnsw"
    ON "public"."PlatosMemory" USING hnsw ("embedding" vector_cosine_ops);

-- ─────────────────────────────────────────────────────────────────────
-- PlatosMemoryEntity — knowledge-graph node.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "public"."PlatosMemoryEntity" (
    "id"                 TEXT        NOT NULL,

    "organizationId"     TEXT        NOT NULL,
    "projectId"          TEXT        NOT NULL,
    "environmentId"      TEXT        NOT NULL,

    "userId"             TEXT        NOT NULL,

    "entityKey"          TEXT        NOT NULL,
    "entityType"         TEXT        NOT NULL,
    "label"              TEXT        NOT NULL,
    "aliases"            TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
    "metadata"           JSONB,

    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosMemoryEntity_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."PlatosMemoryEntity"
    DROP CONSTRAINT IF EXISTS "PlatosMemoryEntity_environmentId_fkey",
    ADD CONSTRAINT "PlatosMemoryEntity_environmentId_fkey"
        FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "platos_mem_entity_scope_key_unq"
    ON "public"."PlatosMemoryEntity"("organizationId", "projectId", "environmentId", "userId", "entityKey");

CREATE INDEX IF NOT EXISTS "platos_mem_entity_scope_user_idx"
    ON "public"."PlatosMemoryEntity"("organizationId", "projectId", "environmentId", "userId");

CREATE INDEX IF NOT EXISTS "platos_mem_entity_scope_type_idx"
    ON "public"."PlatosMemoryEntity"("organizationId", "projectId", "environmentId", "entityType");

-- ─────────────────────────────────────────────────────────────────────
-- PlatosMemoryRelationship — knowledge-graph edge.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "public"."PlatosMemoryRelationship" (
    "id"                 TEXT        NOT NULL,

    "organizationId"     TEXT        NOT NULL,
    "projectId"          TEXT        NOT NULL,
    "environmentId"      TEXT        NOT NULL,

    "userId"             TEXT        NOT NULL,

    "fromEntityId"       TEXT        NOT NULL,
    "toEntityId"         TEXT        NOT NULL,

    "relationshipType"   TEXT        NOT NULL,
    "weight"             DOUBLE PRECISION,
    "metadata"           JSONB,

    "sourceMemoryId"     TEXT,

    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatosMemoryRelationship_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."PlatosMemoryRelationship"
    DROP CONSTRAINT IF EXISTS "PlatosMemoryRelationship_environmentId_fkey",
    ADD CONSTRAINT "PlatosMemoryRelationship_environmentId_fkey"
        FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."PlatosMemoryRelationship"
    DROP CONSTRAINT IF EXISTS "PlatosMemoryRelationship_fromEntityId_fkey",
    ADD CONSTRAINT "PlatosMemoryRelationship_fromEntityId_fkey"
        FOREIGN KEY ("fromEntityId") REFERENCES "public"."PlatosMemoryEntity"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."PlatosMemoryRelationship"
    DROP CONSTRAINT IF EXISTS "PlatosMemoryRelationship_toEntityId_fkey",
    ADD CONSTRAINT "PlatosMemoryRelationship_toEntityId_fkey"
        FOREIGN KEY ("toEntityId") REFERENCES "public"."PlatosMemoryEntity"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "platos_mem_rel_scope_user_idx"
    ON "public"."PlatosMemoryRelationship"("organizationId", "projectId", "environmentId", "userId");

CREATE INDEX IF NOT EXISTS "platos_mem_rel_from_idx"
    ON "public"."PlatosMemoryRelationship"("fromEntityId");

CREATE INDEX IF NOT EXISTS "platos_mem_rel_to_idx"
    ON "public"."PlatosMemoryRelationship"("toEntityId");

CREATE INDEX IF NOT EXISTS "platos_mem_rel_scope_type_idx"
    ON "public"."PlatosMemoryRelationship"("organizationId", "projectId", "environmentId", "relationshipType");
