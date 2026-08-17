-- Platos Theme G — agent lifecycle (versioning, rollback, canary, feature flags).
--
-- Adds PlatosAgentVersion (immutable snapshot table) + four pointers/flags on
-- PlatosAgent + a per-thread version lock on PlatosAgentThread so canary
-- routing is deterministic for the life of a single conversation.
--
-- G.1 ships schema only — the save-on-update wiring lands in G.2, rollback in
-- G.4, canary routing in G.5, metrics in G.6, feature flags UI in G.7.

-- CreateTable — immutable version snapshots per PlatosAgent.
CREATE TABLE "public"."PlatosAgentVersion" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "createdBy" TEXT NOT NULL,
    "note" TEXT,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatosAgentVersion_pkey" PRIMARY KEY ("id")
);

-- Per-agent uniqueness — `versionNumber` auto-increments at 1 and never gaps.
CREATE UNIQUE INDEX "PlatosAgentVersion_agentId_versionNumber_key"
    ON "public"."PlatosAgentVersion"("agentId", "versionNumber");

-- Look up versions for a single agent (diff view + rollback picker).
CREATE INDEX "PlatosAgentVersion_agentId_idx"
    ON "public"."PlatosAgentVersion"("agentId");

-- FK — deleting an agent cascades its entire version history.
ALTER TABLE "public"."PlatosAgentVersion"
    ADD CONSTRAINT "PlatosAgentVersion_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "public"."PlatosAgent"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable PlatosAgent — add lifecycle pointers.
--
--   currentVersionId : primary version served to traffic
--   canaryVersionId  : optional A/B version
--   canaryPercent    : 0..100; percent of new threads routed to canary
--   featureFlags     : { [key: string]: boolean } for experimental gates
--
-- All four are nullable / default-safe so existing agent rows remain valid.
ALTER TABLE "public"."PlatosAgent"
    ADD COLUMN "currentVersionId" TEXT,
    ADD COLUMN "canaryVersionId"  TEXT,
    ADD COLUMN "canaryPercent"    INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "featureFlags"     JSONB;

-- AlterTable PlatosAgentThread — pin each thread to exactly one version.
--
-- Invariant: once a thread is bound to a versionId on turn 1, it must never
-- flip mid-thread even if canaryPercent changes or a rollback happens. This
-- column is what enforces that property; the runtime writes it once on first
-- message and reads it on every subsequent turn.
ALTER TABLE "public"."PlatosAgentThread"
    ADD COLUMN "lockedVersionId" TEXT;
