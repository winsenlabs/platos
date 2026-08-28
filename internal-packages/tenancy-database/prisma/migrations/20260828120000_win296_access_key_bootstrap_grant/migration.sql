-- WIN-296 — one-use first-install grant for the AccessKey lifecycle.
--
-- Records the single consume of the narrow install secret that authorizes the
-- FIRST `POST /api/v1/agent/access-key` on an Environment over the trusted
-- direct-header channel. The UNIQUE constraint on "environmentId" is the
-- single-winner gate: the first writer inserts the row, and any concurrent or
-- later writer collides and is rejected, so the grant is non-replayable without
-- a check-then-set race. Apply this migration candidate before starting an
-- Agent image that reads or writes "AccessKeyBootstrapGrant".
BEGIN;

CREATE TABLE "public"."AccessKeyBootstrapGrant" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "actorUserId" TEXT,
    "tokenFingerprint" TEXT NOT NULL,
    "source" TEXT,
    "consumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessKeyBootstrapGrant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccessKeyBootstrapGrant_environmentId_key"
    ON "public"."AccessKeyBootstrapGrant"("environmentId");

CREATE INDEX "AccessKeyBootstrapGrant_organizationId_projectId_idx"
    ON "public"."AccessKeyBootstrapGrant"("organizationId", "projectId");

ALTER TABLE "public"."AccessKeyBootstrapGrant"
    ADD CONSTRAINT "AccessKeyBootstrapGrant_environmentId_fkey"
    FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
