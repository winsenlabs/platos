-- Different metadata rows may legitimately reference the same immutable object.
-- Metadata-row identity remains the append-only observation key; object digests
-- remain indexed for investigation but are not an identity constraint.
ALTER TYPE "public"."ExternalCutoverOutcome" ADD VALUE IF NOT EXISTS 'STARTED' BEFORE 'SUCCEEDED';

DROP INDEX "public"."ObjectKeyReconciliation_runId_sourceObjectKeySha256_targetO_key";

REVOKE UPDATE, DELETE, TRUNCATE
ON TABLE "public"."ExternalCutoverRun", "public"."ExternalCutoverEvidence", "public"."ObjectKeyReconciliation"
FROM PUBLIC;
