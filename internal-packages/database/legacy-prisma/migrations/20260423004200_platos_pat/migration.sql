-- Theme K.9 — Platos Personal Access Tokens (`plt_pat_...`).
--
-- Distinct from PlatosMCPToken (MCP-only, scope-pinned) and the legacy
-- PersonalAccessToken (tr_pat_, engine/CLI management surface). PlatosPAT
-- authenticates AS a user against the full webapp REST API. May be pinned
-- to a single (org, project, env) tuple or left unpinned. We store only
-- sha256(raw token); raw is returned at mint once and never again.

CREATE TABLE "public"."PlatosPAT" (
    "id"             TEXT NOT NULL,
    "tokenHash"      TEXT NOT NULL,
    "name"           TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    "organizationId" TEXT,
    "projectId"      TEXT,
    "environmentId"  TEXT,
    "role"           TEXT NOT NULL DEFAULT 'write',
    "lastUsedAt"     TIMESTAMP(3),
    "expiresAt"      TIMESTAMP(3),
    "revokedAt"      TIMESTAMP(3),
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatosPAT_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PlatosPAT_tokenHash_key" ON "public"."PlatosPAT"("tokenHash");

-- Secondary indexes live in the same migration since they attach to a
-- newly created table (per `.claude/rules/database-safety.md` — no
-- CONCURRENTLY needed).
CREATE INDEX "platos_pat_user_idx" ON "public"."PlatosPAT"("userId", "revokedAt");
CREATE INDEX "platos_pat_token_hash_idx" ON "public"."PlatosPAT"("tokenHash");
