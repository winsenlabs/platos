-- PRIVACY: durable receipt for hard-erasure operations.
--
-- Additive only. No existing table is touched, so this is safe to apply to a
-- running deployment.
--
-- Deliberately NOT foreign-keyed to RuntimeEnvironment with a cascade: deleting
-- an environment must not destroy the evidence that a person was erased from
-- it. The receipt outlives the data it describes -- that is its purpose.
CREATE TABLE IF NOT EXISTS "PlatosErasureOperation" (
    "id"                TEXT NOT NULL,
    "idempotencyKey"    TEXT NOT NULL,
    "subjectKeyHash"    TEXT NOT NULL,
    "organizationId"    TEXT NOT NULL,
    "status"            TEXT NOT NULL DEFAULT 'pending',
    "scopes"            JSONB NOT NULL,
    "stores"            JSONB NOT NULL,
    "inventory"         JSONB,
    "policyVersion"     TEXT NOT NULL,
    "legalHoldPolicyId" TEXT,
    "attempts"          INTEGER NOT NULL DEFAULT 0,
    "requestedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt"         TIMESTAMP(3),
    "completedAt"       TIMESTAMP(3),
    "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlatosErasureOperation_pkey" PRIMARY KEY ("id")
);

-- Idempotency: a repeated request must return the existing operation rather
-- than racing a second purge against the same person.
CREATE UNIQUE INDEX IF NOT EXISTS "PlatosErasureOperation_idempotencyKey_key"
    ON "PlatosErasureOperation"("idempotencyKey");

CREATE INDEX IF NOT EXISTS "PlatosErasureOperation_subjectKeyHash_idx"
    ON "PlatosErasureOperation"("subjectKeyHash");
CREATE INDEX IF NOT EXISTS "PlatosErasureOperation_organizationId_status_idx"
    ON "PlatosErasureOperation"("organizationId", "status");
CREATE INDEX IF NOT EXISTS "PlatosErasureOperation_status_requestedAt_idx"
    ON "PlatosErasureOperation"("status", "requestedAt");
