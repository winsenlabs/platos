-- Theme R2: drop V1 from RunEngineVersion enum.
--
-- EOBD.24: add data-backfill prelude so operators on earlier Platos releases
-- with existing V1 rows can upgrade without hitting
-- `invalid input value for enum "RunEngineVersion": "V1"` on the USING cast.
-- These UPDATEs are idempotent on a fresh DB (zero rows match).
UPDATE "Project" SET "engine" = 'V2' WHERE "engine" = 'V1';
UPDATE "BackgroundWorker" SET "engine" = 'V2' WHERE "engine" = 'V1';
UPDATE "TaskRun" SET "engine" = 'V2' WHERE "engine" = 'V1';
UPDATE "TaskRunExecutionSnapshot" SET "engine" = 'V2' WHERE "engine" = 'V1';

ALTER TYPE "RunEngineVersion" RENAME TO "RunEngineVersion_old";
CREATE TYPE "RunEngineVersion" AS ENUM ('V2');

ALTER TABLE "Project" ALTER COLUMN "engine" DROP DEFAULT;
ALTER TABLE "Project" ALTER COLUMN "engine" TYPE "RunEngineVersion" USING ("engine"::text::"RunEngineVersion");
ALTER TABLE "Project" ALTER COLUMN "engine" SET DEFAULT 'V2';

ALTER TABLE "BackgroundWorker" ALTER COLUMN "engine" DROP DEFAULT;
ALTER TABLE "BackgroundWorker" ALTER COLUMN "engine" TYPE "RunEngineVersion" USING ("engine"::text::"RunEngineVersion");
ALTER TABLE "BackgroundWorker" ALTER COLUMN "engine" SET DEFAULT 'V2';

ALTER TABLE "TaskRun" ALTER COLUMN "engine" DROP DEFAULT;
ALTER TABLE "TaskRun" ALTER COLUMN "engine" TYPE "RunEngineVersion" USING ("engine"::text::"RunEngineVersion");
ALTER TABLE "TaskRun" ALTER COLUMN "engine" SET DEFAULT 'V2';

ALTER TABLE "TaskRunExecutionSnapshot" ALTER COLUMN "engine" DROP DEFAULT;
ALTER TABLE "TaskRunExecutionSnapshot" ALTER COLUMN "engine" TYPE "RunEngineVersion" USING ("engine"::text::"RunEngineVersion");
ALTER TABLE "TaskRunExecutionSnapshot" ALTER COLUMN "engine" SET DEFAULT 'V2';

DROP TYPE "RunEngineVersion_old";
