-- CreateEnum
CREATE TYPE "public"."ExternalCutoverStatus" AS ENUM ('STUB_BLOCKED', 'PLANNED', 'WRITERS_FENCED', 'COPYING', 'COPY_VERIFIED', 'SWAPPED', 'OBJECTS_RECONCILING', 'VERIFIED', 'COMPLETED', 'ROLLBACK_REQUIRED', 'ROLLED_BACK', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."ExternalCutoverDomain" AS ENUM ('CLICKHOUSE', 'OBJECT_STORE');

-- CreateEnum
CREATE TYPE "public"."ExternalCutoverAction" AS ENUM ('PLAN', 'FENCE_WRITERS', 'COPY', 'VERIFY', 'SWAP', 'RECONCILE', 'COMPLETE', 'ROLLBACK');

-- CreateEnum
CREATE TYPE "public"."ExternalCutoverOutcome" AS ENUM ('SUCCEEDED', 'BLOCKED', 'FAILED', 'MATCH', 'MISMATCH', 'MISSING', 'INDETERMINATE', 'ROLLED_BACK');

-- CreateTable
CREATE TABLE "public"."ExternalCutoverRun" (
    "id" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "public"."ExternalCutoverStatus" NOT NULL DEFAULT 'STUB_BLOCKED',
    "manifestSha256" TEXT NOT NULL,
    "report" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalCutoverRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ExternalCutoverEvidence" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "runAttempt" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "domain" "public"."ExternalCutoverDomain" NOT NULL,
    "action" "public"."ExternalCutoverAction" NOT NULL,
    "outcome" "public"."ExternalCutoverOutcome" NOT NULL,
    "resourceName" TEXT,
    "expectedMetadata" JSONB NOT NULL DEFAULT '{}',
    "observedMetadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalCutoverEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ObjectKeyReconciliation" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "runAttempt" INTEGER NOT NULL,
    "metadataModel" TEXT NOT NULL,
    "metadataRowId" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "action" "public"."ExternalCutoverAction" NOT NULL DEFAULT 'RECONCILE',
    "outcome" "public"."ExternalCutoverOutcome" NOT NULL,
    "sourceObjectKeySha256" TEXT NOT NULL,
    "targetObjectKeySha256" TEXT NOT NULL,
    "expectedMetadata" JSONB NOT NULL DEFAULT '{}',
    "observedMetadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ObjectKeyReconciliation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalCutoverRun_status_createdAt_idx" ON "public"."ExternalCutoverRun"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ExternalCutoverRun_idempotencyKey_createdAt_idx" ON "public"."ExternalCutoverRun"("idempotencyKey", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalCutoverRun_id_attempt_key" ON "public"."ExternalCutoverRun"("id", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalCutoverRun_idempotencyKey_attempt_key" ON "public"."ExternalCutoverRun"("idempotencyKey", "attempt");

-- CreateIndex
CREATE INDEX "ExternalCutoverEvidence_runId_domain_action_outcome_idx" ON "public"."ExternalCutoverEvidence"("runId", "domain", "action", "outcome");

-- CreateIndex
CREATE INDEX "ExternalCutoverEvidence_domain_action_outcome_createdAt_idx" ON "public"."ExternalCutoverEvidence"("domain", "action", "outcome", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalCutoverEvidence_runId_sequence_key" ON "public"."ExternalCutoverEvidence"("runId", "sequence");

-- CreateIndex
CREATE INDEX "ObjectKeyReconciliation_runId_outcome_createdAt_idx" ON "public"."ObjectKeyReconciliation"("runId", "outcome", "createdAt");

-- CreateIndex
CREATE INDEX "ObjectKeyReconciliation_metadataModel_metadataRowId_created_idx" ON "public"."ObjectKeyReconciliation"("metadataModel", "metadataRowId", "createdAt");

-- CreateIndex
CREATE INDEX "ObjectKeyReconciliation_targetObjectKeySha256_idx" ON "public"."ObjectKeyReconciliation"("targetObjectKeySha256");

-- CreateIndex
CREATE UNIQUE INDEX "ObjectKeyReconciliation_runId_metadataModel_metadataRowId_a_key" ON "public"."ObjectKeyReconciliation"("runId", "metadataModel", "metadataRowId", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "ObjectKeyReconciliation_runId_sourceObjectKeySha256_targetO_key" ON "public"."ObjectKeyReconciliation"("runId", "sourceObjectKeySha256", "targetObjectKeySha256", "attempt");

-- AddForeignKey
ALTER TABLE "public"."ExternalCutoverEvidence" ADD CONSTRAINT "ExternalCutoverEvidence_runId_runAttempt_fkey" FOREIGN KEY ("runId", "runAttempt") REFERENCES "public"."ExternalCutoverRun"("id", "attempt") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ObjectKeyReconciliation" ADD CONSTRAINT "ObjectKeyReconciliation_runId_runAttempt_fkey" FOREIGN KEY ("runId", "runAttempt") REFERENCES "public"."ExternalCutoverRun"("id", "attempt") ON DELETE RESTRICT ON UPDATE CASCADE;

-- PostgreSQL is the canonical authority for external cutover state. Routine
-- metadata is deliberately closed over counts and SHA-256 digests so neither
-- object keys nor credentials can enter evidence through an untyped JSON bag.
CREATE FUNCTION "public"."external_cutover_metadata_is_safe"(metadata JSONB)
RETURNS BOOLEAN AS $$
  SELECT
    jsonb_typeof(metadata) = 'object' AND
    NOT EXISTS (
      SELECT 1
      FROM jsonb_each(metadata) AS entry(key, value)
      WHERE entry.key NOT IN (
        'rowCount',
        'objectCount',
        'byteLength',
        'rowsSha256',
        'objectsSha256',
        'contentSha256',
        'manifestSha256'
      ) OR CASE
        WHEN entry.key IN ('rowCount', 'objectCount', 'byteLength') THEN
          jsonb_typeof(entry.value) <> 'string' OR
          entry.value #>> '{}' !~ '^(0|[1-9][0-9]*)$'
        ELSE
          jsonb_typeof(entry.value) <> 'string' OR
          entry.value #>> '{}' !~ '^[0-9a-f]{64}$'
      END
    );
$$ LANGUAGE SQL IMMUTABLE STRICT;

-- Only the already-validated STUB report contract may be persisted in this
-- migration. Enabling implemented reports requires a later explicit migration
-- together with the external execution path.
CREATE FUNCTION "public"."external_cutover_stub_report_is_valid"(report JSONB)
RETURNS BOOLEAN AS $$
  SELECT
    jsonb_typeof(report) = 'object' AND
    (SELECT count(*) FROM jsonb_object_keys(report)) = 6 AND
    report ?& ARRAY[
      'contractVersion',
      'implementation',
      'state',
      'manifestSha256',
      'clickHouseTables',
      'objectStoreObjects'
    ] AND
    report -> 'contractVersion' = '1'::jsonb AND
    report ->> 'implementation' = 'STUB' AND
    report ->> 'state' = 'STUB_BLOCKED' AND
    report ->> 'manifestSha256' ~ '^[0-9a-f]{64}$' AND
    report -> 'clickHouseTables' = '[]'::jsonb AND
    report -> 'objectStoreObjects' = '[]'::jsonb;
$$ LANGUAGE SQL IMMUTABLE STRICT;

ALTER TABLE "public"."ExternalCutoverRun"
  ADD CONSTRAINT "ExternalCutoverRun_idempotency_key_check" CHECK (
    length(btrim("idempotencyKey")) BETWEEN 1 AND 256
  ),
  ADD CONSTRAINT "ExternalCutoverRun_attempt_check" CHECK ("attempt" > 0),
  ADD CONSTRAINT "ExternalCutoverRun_manifest_sha256_check" CHECK (
    "manifestSha256" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "ExternalCutoverRun_timestamps_check" CHECK (
    "finishedAt" IS NULL OR "finishedAt" >= "startedAt"
  ),
  ADD CONSTRAINT "ExternalCutoverRun_report_json_root" CHECK (
    "report" IS NULL OR jsonb_typeof("report") = 'object'
  ),
  ADD CONSTRAINT "ExternalCutoverRun_report_check" CHECK (
    "report" IS NULL OR (
      "status" = 'STUB_BLOCKED' AND
      "report" ->> 'manifestSha256' = "manifestSha256" AND
      "public"."external_cutover_stub_report_is_valid"("report")
    )
  );

ALTER TABLE "public"."ExternalCutoverEvidence"
  ADD CONSTRAINT "ExternalCutoverEvidence_sequence_check" CHECK ("sequence" > 0),
  ADD CONSTRAINT "ExternalCutoverEvidence_resource_check" CHECK (
    ("domain" = 'CLICKHOUSE' AND "resourceName" ~ '^[a-z][a-z0-9_]*$') OR
    ("domain" = 'OBJECT_STORE' AND "resourceName" IS NULL)
  ),
  ADD CONSTRAINT "ExternalCutoverEvidence_expectedMetadata_json_root" CHECK (
    jsonb_typeof("expectedMetadata") = 'object'
  ),
  ADD CONSTRAINT "ExternalCutoverEvidence_observedMetadata_json_root" CHECK (
    jsonb_typeof("observedMetadata") = 'object'
  ),
  ADD CONSTRAINT "ExternalCutoverEvidence_metadata_check" CHECK (
    "public"."external_cutover_metadata_is_safe"("expectedMetadata") AND
    "public"."external_cutover_metadata_is_safe"("observedMetadata")
  );

ALTER TABLE "public"."ObjectKeyReconciliation"
  ADD CONSTRAINT "ObjectKeyReconciliation_attempt_check" CHECK ("attempt" > 0),
  ADD CONSTRAINT "ObjectKeyReconciliation_metadata_model_check" CHECK (
    "metadataModel" IN ('MessageAttachment', 'AttachmentUploadReservation')
  ),
  ADD CONSTRAINT "ObjectKeyReconciliation_action_check" CHECK ("action" = 'RECONCILE'),
  ADD CONSTRAINT "ObjectKeyReconciliation_outcome_check" CHECK (
    "outcome" IN ('BLOCKED', 'FAILED', 'MATCH', 'MISMATCH', 'MISSING', 'INDETERMINATE')
  ),
  ADD CONSTRAINT "ObjectKeyReconciliation_source_key_sha256_check" CHECK (
    "sourceObjectKeySha256" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "ObjectKeyReconciliation_target_key_sha256_check" CHECK (
    "targetObjectKeySha256" ~ '^[0-9a-f]{64}$'
  ),
  ADD CONSTRAINT "ObjectKeyReconciliation_expectedMetadata_json_root" CHECK (
    jsonb_typeof("expectedMetadata") = 'object'
  ),
  ADD CONSTRAINT "ObjectKeyReconciliation_observedMetadata_json_root" CHECK (
    jsonb_typeof("observedMetadata") = 'object'
  ),
  ADD CONSTRAINT "ObjectKeyReconciliation_metadata_check" CHECK (
    "public"."external_cutover_metadata_is_safe"("expectedMetadata") AND
    "public"."external_cutover_metadata_is_safe"("observedMetadata") AND
    "expectedMetadata" ? 'byteLength' AND
    NOT "expectedMetadata" ?| ARRAY[
      'rowCount', 'objectCount', 'rowsSha256', 'objectsSha256', 'manifestSha256'
    ] AND
    NOT "observedMetadata" ?| ARRAY[
      'rowCount', 'objectCount', 'rowsSha256', 'objectsSha256', 'manifestSha256'
    ] AND
    (
      "outcome" NOT IN ('MATCH', 'MISMATCH') OR
      "observedMetadata" ? 'byteLength'
    )
  );

CREATE FUNCTION "public"."enforce_external_cutover_run_attempt_sequence"()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."idempotencyKey", 0));
  IF NEW."attempt" > 1 AND NOT EXISTS (
    SELECT 1
    FROM "public"."ExternalCutoverRun" predecessor
    WHERE predecessor."idempotencyKey" = NEW."idempotencyKey"
      AND predecessor."attempt" = NEW."attempt" - 1
  ) THEN
    RAISE EXCEPTION 'ExternalCutoverRun attempts must be sequential'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ExternalCutoverRun_attempt_sequence"
  BEFORE INSERT ON "public"."ExternalCutoverRun"
  FOR EACH ROW EXECUTE FUNCTION "public"."enforce_external_cutover_run_attempt_sequence"();

CREATE FUNCTION "public"."enforce_external_cutover_evidence_sequence"()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW."runId"::text, 1));
  IF NEW."sequence" > 1 AND NOT EXISTS (
    SELECT 1
    FROM "public"."ExternalCutoverEvidence" predecessor
    WHERE predecessor."runId" = NEW."runId"
      AND predecessor."sequence" = NEW."sequence" - 1
  ) THEN
    RAISE EXCEPTION 'ExternalCutoverEvidence entries must be sequential'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ExternalCutoverEvidence_sequence"
  BEFORE INSERT ON "public"."ExternalCutoverEvidence"
  FOR EACH ROW EXECUTE FUNCTION "public"."enforce_external_cutover_evidence_sequence"();

CREATE FUNCTION "public"."enforce_object_key_reconciliation_attempt_sequence"()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    NEW."runId"::text || ':' || NEW."metadataModel" || ':' || NEW."metadataRowId"::text,
    2
  ));
  IF NEW."attempt" > 1 AND NOT EXISTS (
    SELECT 1
    FROM "public"."ObjectKeyReconciliation" predecessor
    WHERE predecessor."runId" = NEW."runId"
      AND predecessor."metadataModel" = NEW."metadataModel"
      AND predecessor."metadataRowId" = NEW."metadataRowId"
      AND predecessor."attempt" = NEW."attempt" - 1
  ) THEN
    RAISE EXCEPTION 'ObjectKeyReconciliation attempts must be sequential'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ObjectKeyReconciliation_attempt_sequence"
  BEFORE INSERT ON "public"."ObjectKeyReconciliation"
  FOR EACH ROW EXECUTE FUNCTION "public"."enforce_object_key_reconciliation_attempt_sequence"();

CREATE FUNCTION "public"."reject_external_cutover_ledger_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ExternalCutoverRun_immutable_update"
  BEFORE UPDATE ON "public"."ExternalCutoverRun"
  FOR EACH ROW EXECUTE FUNCTION "public"."reject_external_cutover_ledger_mutation"();
CREATE TRIGGER "ExternalCutoverRun_immutable_delete"
  BEFORE DELETE ON "public"."ExternalCutoverRun"
  FOR EACH ROW EXECUTE FUNCTION "public"."reject_external_cutover_ledger_mutation"();
CREATE TRIGGER "ExternalCutoverRun_immutable_truncate"
  BEFORE TRUNCATE ON "public"."ExternalCutoverRun"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."reject_external_cutover_ledger_mutation"();

CREATE TRIGGER "ExternalCutoverEvidence_immutable_update"
  BEFORE UPDATE ON "public"."ExternalCutoverEvidence"
  FOR EACH ROW EXECUTE FUNCTION "public"."reject_external_cutover_ledger_mutation"();
CREATE TRIGGER "ExternalCutoverEvidence_immutable_delete"
  BEFORE DELETE ON "public"."ExternalCutoverEvidence"
  FOR EACH ROW EXECUTE FUNCTION "public"."reject_external_cutover_ledger_mutation"();
CREATE TRIGGER "ExternalCutoverEvidence_immutable_truncate"
  BEFORE TRUNCATE ON "public"."ExternalCutoverEvidence"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."reject_external_cutover_ledger_mutation"();

CREATE TRIGGER "ObjectKeyReconciliation_immutable_update"
  BEFORE UPDATE ON "public"."ObjectKeyReconciliation"
  FOR EACH ROW EXECUTE FUNCTION "public"."reject_external_cutover_ledger_mutation"();
CREATE TRIGGER "ObjectKeyReconciliation_immutable_delete"
  BEFORE DELETE ON "public"."ObjectKeyReconciliation"
  FOR EACH ROW EXECUTE FUNCTION "public"."reject_external_cutover_ledger_mutation"();
CREATE TRIGGER "ObjectKeyReconciliation_immutable_truncate"
  BEFORE TRUNCATE ON "public"."ObjectKeyReconciliation"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."reject_external_cutover_ledger_mutation"();

REVOKE UPDATE, DELETE, TRUNCATE
ON TABLE "public"."ExternalCutoverRun", "public"."ExternalCutoverEvidence", "public"."ObjectKeyReconciliation"
FROM PUBLIC;
