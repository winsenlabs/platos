ALTER TYPE "public"."ExternalCutoverAction" ADD VALUE IF NOT EXISTS 'MAINTENANCE_ENABLE' AFTER 'FENCE_WRITERS';
ALTER TYPE "public"."ExternalCutoverAction" ADD VALUE IF NOT EXISTS 'MAINTENANCE_DISABLE' AFTER 'MAINTENANCE_ENABLE';
ALTER TYPE "public"."ExternalCutoverAction" ADD VALUE IF NOT EXISTS 'RESTORE_WRITERS' AFTER 'MAINTENANCE_DISABLE';

CREATE TABLE "public"."ExternalClickHouseWriterGrant" (
  "id" UUID NOT NULL,
  "runId" UUID NOT NULL,
  "runAttempt" INTEGER NOT NULL,
  "sequence" INTEGER NOT NULL,
  "principalKind" TEXT NOT NULL,
  "principalName" TEXT NOT NULL,
  "databaseName" TEXT,
  "tableName" TEXT,
  "columnName" TEXT,
  "grantOption" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ExternalClickHouseWriterGrant_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExternalClickHouseWriterGrant_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "ExternalClickHouseWriterGrant_principal_kind_check" CHECK (
    "principalKind" IN ('USER', 'ROLE')
  ),
  CONSTRAINT "ExternalClickHouseWriterGrant_principal_name_check" CHECK (
    length(btrim("principalName")) BETWEEN 1 AND 256
  )
);

CREATE UNIQUE INDEX "ExternalClickHouseWriterGrant_runId_sequence_key"
ON "public"."ExternalClickHouseWriterGrant"("runId", "sequence");

CREATE INDEX "ExternalClickHouseWriterGrant_principal_created_idx"
ON "public"."ExternalClickHouseWriterGrant"("principalKind", "principalName", "createdAt");

ALTER TABLE "public"."ExternalClickHouseWriterGrant"
ADD CONSTRAINT "ExternalClickHouseWriterGrant_runId_runAttempt_fkey" FOREIGN KEY ("runId", "runAttempt")
REFERENCES "public"."ExternalCutoverRun"("id", "attempt")
 ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER "ExternalClickHouseWriterGrant_immutable_update"
BEFORE UPDATE ON "public"."ExternalClickHouseWriterGrant"
FOR EACH ROW EXECUTE FUNCTION "public"."reject_external_cutover_ledger_mutation"();
CREATE TRIGGER "ExternalClickHouseWriterGrant_immutable_delete"
BEFORE DELETE ON "public"."ExternalClickHouseWriterGrant"
FOR EACH ROW EXECUTE FUNCTION "public"."reject_external_cutover_ledger_mutation"();
CREATE TRIGGER "ExternalClickHouseWriterGrant_immutable_truncate"
BEFORE TRUNCATE ON "public"."ExternalClickHouseWriterGrant"
FOR EACH STATEMENT EXECUTE FUNCTION "public"."reject_external_cutover_ledger_mutation"();

REVOKE UPDATE, DELETE, TRUNCATE
ON TABLE "public"."ExternalClickHouseWriterGrant"
FROM PUBLIC;
