-- AccessKey revocation generation fence for already-deployed Environment rows.
--
-- Apply this migration candidate before starting an Agent image that reads or
-- increments Environment.accessKeyRevocationVersion. The release gate runs the
-- migration image to completion before recreating application services.
BEGIN;

ALTER TABLE "public"."Environment"
  ADD COLUMN IF NOT EXISTS "accessKeyRevocationVersion" INTEGER;

UPDATE "public"."Environment"
SET "accessKeyRevocationVersion" = 0
WHERE "accessKeyRevocationVersion" IS NULL;

ALTER TABLE "public"."Environment"
  ALTER COLUMN "accessKeyRevocationVersion" SET DEFAULT 0,
  ALTER COLUMN "accessKeyRevocationVersion" SET NOT NULL;

COMMIT;
