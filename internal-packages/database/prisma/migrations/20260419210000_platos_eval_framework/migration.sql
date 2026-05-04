-- Platos Theme J — Eval framework.
--
-- Ships three new tables for J.1 (thumbs ratings), J.3 (eval criteria),
-- J.5 (judge-LLM scoring results), and J.8 (golden-set regression runs).
--
-- All four tables carry the full scope tuple (organizationId, projectId,
-- environmentId) per Theme A invariant §5.1. All queries filter by the
-- full tuple; cross-scope reads are structurally impossible.
--
-- Every CREATE is idempotent (IF NOT EXISTS) so partial-branch databases
-- apply cleanly.

-- ═══════════════════════════════════════════════════════
-- J.1 — PlatosMessageRating
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "public"."PlatosMessageRating" (
    "id"             TEXT NOT NULL,

    "organizationId" TEXT NOT NULL,
    "projectId"      TEXT NOT NULL,
    "environmentId"  TEXT NOT NULL,

    "messageId"      TEXT NOT NULL,
    "threadId"       TEXT NOT NULL,
    "agentId"        TEXT NOT NULL,
    "agentVersionId" TEXT,

    "userId"         TEXT NOT NULL,
    "rating"         INTEGER NOT NULL,
    "comment"        TEXT,

    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosMessageRating_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."PlatosMessageRating"
    DROP CONSTRAINT IF EXISTS "PlatosMessageRating_environmentId_fkey",
    ADD CONSTRAINT "PlatosMessageRating_environmentId_fkey"
        FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "PlatosMessageRating_messageId_userId_key"
    ON "public"."PlatosMessageRating"("messageId", "userId");

CREATE INDEX IF NOT EXISTS "PlatosMessageRating_scope_agentId_idx"
    ON "public"."PlatosMessageRating"("organizationId", "projectId", "environmentId", "agentId");

CREATE INDEX IF NOT EXISTS "PlatosMessageRating_scope_agentVersionId_idx"
    ON "public"."PlatosMessageRating"("organizationId", "projectId", "environmentId", "agentVersionId");

CREATE INDEX IF NOT EXISTS "PlatosMessageRating_threadId_idx"
    ON "public"."PlatosMessageRating"("threadId");

-- ═══════════════════════════════════════════════════════
-- J.3 — PlatosEvalCriterion
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "public"."PlatosEvalCriterion" (
    "id"             TEXT NOT NULL,

    "organizationId" TEXT NOT NULL,
    "projectId"      TEXT NOT NULL,
    "environmentId"  TEXT NOT NULL,

    "agentId"        TEXT,

    "name"           TEXT NOT NULL,
    "description"    TEXT,

    "judgePrompt"    TEXT NOT NULL,
    "rubric"         TEXT,
    "judgeModel"     TEXT,

    "scoreScaleMin"  INTEGER NOT NULL DEFAULT 0,
    "scoreScaleMax"  INTEGER NOT NULL DEFAULT 100,

    "isActive"       BOOLEAN NOT NULL DEFAULT true,

    "createdBy"      TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosEvalCriterion_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."PlatosEvalCriterion"
    DROP CONSTRAINT IF EXISTS "PlatosEvalCriterion_environmentId_fkey",
    ADD CONSTRAINT "PlatosEvalCriterion_environmentId_fkey"
        FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "PlatosEvalCriterion_scope_idx"
    ON "public"."PlatosEvalCriterion"("organizationId", "projectId", "environmentId");

CREATE INDEX IF NOT EXISTS "PlatosEvalCriterion_scope_agentId_idx"
    ON "public"."PlatosEvalCriterion"("organizationId", "projectId", "environmentId", "agentId");

-- ═══════════════════════════════════════════════════════
-- J.5 — PlatosAgentEval
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "public"."PlatosAgentEval" (
    "id"                TEXT NOT NULL,

    "organizationId"    TEXT NOT NULL,
    "projectId"         TEXT NOT NULL,
    "environmentId"     TEXT NOT NULL,

    "agentId"           TEXT NOT NULL,
    "agentVersionId"    TEXT,
    "threadId"          TEXT NOT NULL,
    "messageId"         TEXT,

    "criterionId"       TEXT NOT NULL,
    "criterionSnapshot" JSONB NOT NULL,

    "judgeModel"        TEXT NOT NULL,
    "judgePromptUsed"   TEXT NOT NULL,
    "rawResponse"       TEXT,

    "score"             DOUBLE PRECISION NOT NULL,
    "rationale"         TEXT,
    "passed"            BOOLEAN NOT NULL DEFAULT false,

    "runId"             TEXT,
    "baselineVersionId" TEXT,

    "costCents"         DOUBLE PRECISION,
    "latencyMs"         INTEGER,

    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatosAgentEval_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."PlatosAgentEval"
    DROP CONSTRAINT IF EXISTS "PlatosAgentEval_environmentId_fkey",
    ADD CONSTRAINT "PlatosAgentEval_environmentId_fkey"
        FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."PlatosAgentEval"
    DROP CONSTRAINT IF EXISTS "PlatosAgentEval_criterionId_fkey",
    ADD CONSTRAINT "PlatosAgentEval_criterionId_fkey"
        FOREIGN KEY ("criterionId") REFERENCES "public"."PlatosEvalCriterion"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "PlatosAgentEval_scope_agent_createdAt_idx"
    ON "public"."PlatosAgentEval"("organizationId", "projectId", "environmentId", "agentId", "createdAt" DESC);

CREATE INDEX IF NOT EXISTS "PlatosAgentEval_scope_version_idx"
    ON "public"."PlatosAgentEval"("organizationId", "projectId", "environmentId", "agentVersionId");

CREATE INDEX IF NOT EXISTS "PlatosAgentEval_scope_criterion_idx"
    ON "public"."PlatosAgentEval"("organizationId", "projectId", "environmentId", "criterionId");

CREATE INDEX IF NOT EXISTS "PlatosAgentEval_threadId_idx"
    ON "public"."PlatosAgentEval"("threadId");

CREATE INDEX IF NOT EXISTS "PlatosAgentEval_runId_idx"
    ON "public"."PlatosAgentEval"("runId");

-- ═══════════════════════════════════════════════════════
-- J.8 — PlatosGoldenSet
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS "public"."PlatosGoldenSet" (
    "id"             TEXT NOT NULL,

    "organizationId" TEXT NOT NULL,
    "projectId"      TEXT NOT NULL,
    "environmentId"  TEXT NOT NULL,

    "agentId"        TEXT NOT NULL,

    "name"           TEXT NOT NULL,
    "description"    TEXT,

    "threadIds"      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "criterionIds"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    "createdBy"      TEXT NOT NULL,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosGoldenSet_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "public"."PlatosGoldenSet"
    DROP CONSTRAINT IF EXISTS "PlatosGoldenSet_environmentId_fkey",
    ADD CONSTRAINT "PlatosGoldenSet_environmentId_fkey"
        FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "PlatosGoldenSet_scope_agentId_idx"
    ON "public"."PlatosGoldenSet"("organizationId", "projectId", "environmentId", "agentId");
