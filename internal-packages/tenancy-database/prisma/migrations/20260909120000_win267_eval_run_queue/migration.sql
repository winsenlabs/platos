-- WIN-267 G1 — the row `governance`'s `EvalRunQueue` port hands a planned run to.
--
-- ADR M0.3 §1 row 14: "eval runs enqueue as durable jobs." The legacy
-- `GoldenSetService.run` loops threads by criteria and awaits one paid judge call
-- per pair INSIDE the request, so a client timeout mid-run leaves the work
-- running, half the evals written, and no handle to ask about it. There is
-- therefore no legacy table to rename: this row is what the sentence needs and
-- the source never had.
--
-- IT IS IN THIS DATABASE BECAUSE §15 PUTS IT HERE. One PostgreSQL database is one
-- client is one adapter directory, which is the same sentence that put
-- `governance`'s five existing stores behind `packages/adapters/postgres-tenancy`.
--
-- WHY TWO IDEMPOTENCY COLUMNS, WHICH IS THE ONE DESIGN DECISION IN THIS FILE.
-- `enqueue-eval-run.ts` builds the key from the set id, EVERY PAIR IN PLAN ORDER
-- and the baseline -- `eval-run/<uuid>/<uuid|no-baseline>/<threadId>:<criterionId>|...`
-- -- and `DEFAULT_GOVERNANCE_POLICY.goldenSets` caps a set at five hundred pairs.
-- At that ceiling the key is roughly 37 kB. A btree index row may not exceed
-- about 2704 bytes (a third of an 8 kB page), so a UNIQUE index over the key
-- ITSELF refuses the insert with `index row size ... exceeds btree version 4
-- maximum` -- naming neither the column nor the run -- and it does so on exactly
-- the large runs the ceiling exists to permit. The port anticipates this in as
-- many words: the key "is a plain joined string rather than a digest because
-- this context owns no hashing port ... the adapter behind `EvalRunQueue` may
-- digest it".
--
-- So the UNIQUE index is over a SHA-256 hex digest, and the key itself is kept
-- beside it, unindexed, in an unbounded `TEXT` column that PostgreSQL will TOAST.
-- Keeping both is what makes a merged run auditable: `alreadyQueued` says a key
-- was seen before, and the stored key is what a reader compares to be sure the
-- digests did not merely collide.
--
-- `status` AND `leaseOwner`/`leaseExpiresAt` ARE THE CONSUMER'S HALF. The port
-- itself is enqueue-only; a dispatcher claims a run with
-- `FOR UPDATE SKIP LOCKED` and holds it under a lease, so a consumer that dies
-- between claiming and acknowledging loses its lease and the run becomes
-- claimable again rather than disappearing. `EvalRun_status_leaseExpiresAt_idx`
-- is the index that claim reads, in the claim's own order.
--
-- IDEMPOTENT, like every migration after the initial one here.
BEGIN;

CREATE TABLE IF NOT EXISTS "public"."EvalRun" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "goldenSetId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "baselineVersionId" UUID,
    "requestedBy" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "idempotencyDigest" TEXT NOT NULL,
    "pairCount" INTEGER NOT NULL,
    "pairs" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvalRun_pkey" PRIMARY KEY ("id")
);

-- The port's `pairs` is a LIST in plan order, so the root is an array and not an
-- object: `jsonShapeRegistry` records it as `array` and this is the constraint
-- that makes that record true of the DATABASE rather than only of the client.
--
-- THE NAME IS THE CONVENTION AND NOT A CHOICE. `00000000000000_initial` carries
-- one `<Model>_<column>_json_root` CHECK per JSONB column, and
-- `json-columns.integration.test.ts` reads them back out of `pg_constraint` and
-- fails on a census entry with no constraint AND on a constraint no census entry
-- names. A differently-named CHECK here would be invisible to both halves.
ALTER TABLE "public"."EvalRun"
  DROP CONSTRAINT IF EXISTS "EvalRun_pairs_json_root";
ALTER TABLE "public"."EvalRun"
  ADD CONSTRAINT "EvalRun_pairs_json_root" CHECK (jsonb_typeof("pairs") = 'array');

-- `pairCount` is what the port answers to a caller, and `pairs` is what a
-- dispatcher reads. A row where they disagree would report a plan that is not
-- the plan, so the database refuses it rather than trusting the writer.
ALTER TABLE "public"."EvalRun"
  DROP CONSTRAINT IF EXISTS "EvalRun_pairCount_check";
ALTER TABLE "public"."EvalRun"
  ADD CONSTRAINT "EvalRun_pairCount_check"
  CHECK ("pairCount" = jsonb_array_length("pairs") AND "pairCount" > 0);

-- A lease is a PAIR. An owner with no expiry is a run nothing will ever reclaim;
-- an expiry with no owner is a lease nobody holds. Both are refused here rather
-- than left to a sweeper to interpret.
ALTER TABLE "public"."EvalRun"
  DROP CONSTRAINT IF EXISTS "EvalRun_lease_check";
ALTER TABLE "public"."EvalRun"
  ADD CONSTRAINT "EvalRun_lease_check"
  CHECK (("leaseOwner" IS NULL) = ("leaseExpiresAt" IS NULL));

ALTER TABLE "public"."EvalRun"
  DROP CONSTRAINT IF EXISTS "EvalRun_status_check";
ALTER TABLE "public"."EvalRun"
  ADD CONSTRAINT "EvalRun_status_check"
  CHECK ("status" IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED'));

CREATE UNIQUE INDEX IF NOT EXISTS "EvalRun_environmentId_idempotencyDigest_key"
  ON "public"."EvalRun" ("environmentId", "idempotencyDigest");

CREATE INDEX IF NOT EXISTS "EvalRun_status_leaseExpiresAt_idx"
  ON "public"."EvalRun" ("status", "leaseExpiresAt");

CREATE INDEX IF NOT EXISTS "EvalRun_environmentId_createdAt_idx"
  ON "public"."EvalRun" ("environmentId", "createdAt");

ALTER TABLE "public"."EvalRun"
  DROP CONSTRAINT IF EXISTS "EvalRun_environmentId_fkey";
ALTER TABLE "public"."EvalRun"
  ADD CONSTRAINT "EvalRun_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."EvalRun"
  DROP CONSTRAINT IF EXISTS "EvalRun_goldenSetId_fkey";
ALTER TABLE "public"."EvalRun"
  ADD CONSTRAINT "EvalRun_goldenSetId_fkey"
  FOREIGN KEY ("goldenSetId") REFERENCES "public"."GoldenSet"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."EvalRun"
  DROP CONSTRAINT IF EXISTS "EvalRun_agentId_fkey";
ALTER TABLE "public"."EvalRun"
  ADD CONSTRAINT "EvalRun_agentId_fkey"
  FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
