-- Clean webapp profile fields and the Environment-owned pre-turn attachment lifecycle.
-- Organization and Project scope are always derived through Environment.
ALTER TABLE "public"."User"
  ADD COLUMN "avatarUrl" TEXT,
  ADD COLUMN "dashboardPreferences" JSONB;

CREATE TABLE "public"."AttachmentUploadReservation" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "environmentId" UUID NOT NULL,
  "uploadedByUserId" UUID,
  "uploadedByEndUserId" UUID,
  "messageAttachmentId" UUID,
  "kind" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "bytes" INTEGER NOT NULL,
  "width" INTEGER,
  "height" INTEGER,
  "durationSec" INTEGER,
  "storageKey" TEXT NOT NULL,
  "originalName" TEXT,
  "contentHash" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "claimedAt" TIMESTAMP(3),

  CONSTRAINT "AttachmentUploadReservation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AttachmentUploadReservation_messageAttachmentId_key"
  ON "public"."AttachmentUploadReservation"("messageAttachmentId");
CREATE UNIQUE INDEX "AttachmentUploadReservation_storageKey_key"
  ON "public"."AttachmentUploadReservation"("storageKey");
CREATE INDEX "AttachmentUploadReservation_environmentId_expiresAt_idx"
  ON "public"."AttachmentUploadReservation"("environmentId", "expiresAt");
CREATE INDEX "AttachmentUploadReservation_uploadedByUserId_createdAt_idx"
  ON "public"."AttachmentUploadReservation"("uploadedByUserId", "createdAt");
CREATE INDEX "AttachmentUploadReservation_uploadedByEndUserId_createdAt_idx"
  ON "public"."AttachmentUploadReservation"("uploadedByEndUserId", "createdAt");
CREATE INDEX "AttachmentUploadReservation_expiresAt_claimedAt_idx"
  ON "public"."AttachmentUploadReservation"("expiresAt", "claimedAt");

ALTER TABLE "public"."AttachmentUploadReservation"
  ADD CONSTRAINT "AttachmentUploadReservation_environmentId_fkey"
  FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."AttachmentUploadReservation"
  ADD CONSTRAINT "AttachmentUploadReservation_uploadedByUserId_fkey"
  FOREIGN KEY ("uploadedByUserId") REFERENCES "public"."User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "public"."AttachmentUploadReservation"
  ADD CONSTRAINT "AttachmentUploadReservation_uploadedByEndUserId_fkey"
  FOREIGN KEY ("uploadedByEndUserId") REFERENCES "public"."EndUser"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."AttachmentUploadReservation"
  ADD CONSTRAINT "AttachmentUploadReservation_messageAttachmentId_fkey"
  FOREIGN KEY ("messageAttachmentId") REFERENCES "public"."MessageAttachment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."User"
  ADD CONSTRAINT "User_dashboardPreferences_json_root"
  CHECK ("dashboardPreferences" IS NULL OR jsonb_typeof("dashboardPreferences") = 'object');
ALTER TABLE "public"."AttachmentUploadReservation"
  ADD CONSTRAINT "AttachmentUploadReservation_uploader_shape_check" CHECK (
    ("uploadedByUserId" IS NOT NULL)::int + ("uploadedByEndUserId" IS NOT NULL)::int = 1
  ),
  ADD CONSTRAINT "AttachmentUploadReservation_metadata_check" CHECK (
    "bytes" > 0 AND
    ("width" IS NULL OR "width" > 0) AND
    ("height" IS NULL OR "height" > 0) AND
    ("durationSec" IS NULL OR "durationSec" >= 0) AND
    length(btrim("kind")) > 0 AND
    length(btrim("mimeType")) > 0 AND
    length("storageKey") > 0
  ),
  ADD CONSTRAINT "AttachmentUploadReservation_lifecycle_shape_check" CHECK (
    (
      "messageAttachmentId" IS NULL AND "claimedAt" IS NULL AND
      "expiresAt" = "createdAt" + interval '7 days'
    ) OR (
      "messageAttachmentId" IS NOT NULL AND "claimedAt" IS NOT NULL AND
      "claimedAt" >= "createdAt" AND
      "expiresAt" = "claimedAt" + interval '30 days'
    )
  );

CREATE FUNCTION "public"."enforce_attachment_upload_reservation"()
RETURNS TRIGGER AS $$
DECLARE
  owner_valid BOOLEAN := FALSE;
  claim_valid BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."messageAttachmentId" IS NOT NULL AND pg_trigger_depth() <= 1 THEN
      RAISE EXCEPTION 'claimed AttachmentUploadReservation is retained through attachment deletion'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' AND (NEW."messageAttachmentId" IS NOT NULL OR NEW."claimedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'AttachmentUploadReservation must begin unclaimed'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."environmentId" IS DISTINCT FROM NEW."environmentId" OR
       OLD."uploadedByUserId" IS DISTINCT FROM NEW."uploadedByUserId" OR
       OLD."uploadedByEndUserId" IS DISTINCT FROM NEW."uploadedByEndUserId" OR
       OLD."kind" IS DISTINCT FROM NEW."kind" OR
       OLD."mimeType" IS DISTINCT FROM NEW."mimeType" OR
       OLD."bytes" IS DISTINCT FROM NEW."bytes" OR
       OLD."width" IS DISTINCT FROM NEW."width" OR
       OLD."height" IS DISTINCT FROM NEW."height" OR
       OLD."durationSec" IS DISTINCT FROM NEW."durationSec" OR
       OLD."storageKey" IS DISTINCT FROM NEW."storageKey" OR
       OLD."originalName" IS DISTINCT FROM NEW."originalName" OR
       OLD."contentHash" IS DISTINCT FROM NEW."contentHash" OR
       OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
      RAISE EXCEPTION 'AttachmentUploadReservation ownership and upload metadata are immutable'
        USING ERRCODE = '23514';
    END IF;

    IF OLD."messageAttachmentId" IS NOT NULL THEN
      IF OLD."messageAttachmentId" IS DISTINCT FROM NEW."messageAttachmentId" OR
         OLD."claimedAt" IS DISTINCT FROM NEW."claimedAt" OR
         OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt" THEN
        RAISE EXCEPTION 'claimed AttachmentUploadReservation is immutable'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;

    IF NEW."messageAttachmentId" IS NULL OR NEW."claimedAt" IS NULL THEN
      IF OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt" THEN
        RAISE EXCEPTION 'unclaimed AttachmentUploadReservation expiration is immutable'
          USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END IF;

    IF OLD."expiresAt" <= CURRENT_TIMESTAMP THEN
      RAISE EXCEPTION 'AttachmentUploadReservation has expired'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT EXISTS (
    SELECT 1
      FROM "public"."Environment" environment
      JOIN "public"."Project" project ON project.id = environment."projectId"
      LEFT JOIN "public"."EndUser" end_user
        ON end_user.id = NEW."uploadedByEndUserId"
       AND end_user."organizationId" = project."organizationId"
       AND end_user."disabledAt" IS NULL
      LEFT JOIN "public"."OrganizationMembership" membership
        ON membership."organizationId" = project."organizationId"
       AND membership."userId" = NEW."uploadedByUserId"
       AND membership."deactivatedAt" IS NULL
     WHERE environment.id = NEW."environmentId"
       AND (
         (NEW."uploadedByEndUserId" IS NOT NULL AND end_user.id IS NOT NULL) OR
         (NEW."uploadedByUserId" IS NOT NULL AND membership.id IS NOT NULL)
       )
  ) INTO owner_valid;

  IF NOT owner_valid THEN
    RAISE EXCEPTION 'AttachmentUploadReservation crosses its canonical uploader ancestry'
      USING ERRCODE = '23514';
  END IF;

  IF NEW."messageAttachmentId" IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
        FROM "public"."MessageAttachment" attachment
        JOIN "public"."Turn" turn ON turn.id = attachment."turnId"
        JOIN "public"."Thread" thread ON thread.id = turn."threadId"
       WHERE attachment.id = NEW."messageAttachmentId"
         AND attachment."environmentId" = NEW."environmentId"
         AND thread."environmentId" = NEW."environmentId"
         AND thread."endUserId" = attachment."endUserId"
         AND (
           NEW."uploadedByEndUserId" IS NULL OR
           attachment."endUserId" = NEW."uploadedByEndUserId"
         )
         AND attachment."kind" = NEW."kind"
         AND attachment."mimeType" = NEW."mimeType"
         AND attachment."bytes" = NEW."bytes"
         AND attachment."width" IS NOT DISTINCT FROM NEW."width"
         AND attachment."height" IS NOT DISTINCT FROM NEW."height"
         AND attachment."durationSec" IS NOT DISTINCT FROM NEW."durationSec"
         AND attachment."storageKey" = NEW."storageKey"
         AND attachment."originalName" IS NOT DISTINCT FROM NEW."originalName"
         AND attachment."contentHash" IS NOT DISTINCT FROM NEW."contentHash"
         AND attachment."expiresAt" = NEW."expiresAt"
    ) INTO claim_valid;

    IF NOT claim_valid THEN
      RAISE EXCEPTION 'AttachmentUploadReservation claim crosses scope or changes reserved metadata'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AttachmentUploadReservation_lifecycle"
  BEFORE INSERT OR UPDATE OR DELETE ON "public"."AttachmentUploadReservation"
  FOR EACH ROW EXECUTE FUNCTION "public"."enforce_attachment_upload_reservation"();

CREATE FUNCTION "public"."protect_claimed_message_attachment"()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "public"."AttachmentUploadReservation" reservation
    WHERE reservation."messageAttachmentId" = OLD.id
  ) AND (
    OLD."environmentId" IS DISTINCT FROM NEW."environmentId" OR
    OLD."endUserId" IS DISTINCT FROM NEW."endUserId" OR
    OLD."turnId" IS DISTINCT FROM NEW."turnId" OR
    OLD."kind" IS DISTINCT FROM NEW."kind" OR
    OLD."mimeType" IS DISTINCT FROM NEW."mimeType" OR
    OLD."bytes" IS DISTINCT FROM NEW."bytes" OR
    OLD."width" IS DISTINCT FROM NEW."width" OR
    OLD."height" IS DISTINCT FROM NEW."height" OR
    OLD."durationSec" IS DISTINCT FROM NEW."durationSec" OR
    OLD."storageKey" IS DISTINCT FROM NEW."storageKey" OR
    OLD."originalName" IS DISTINCT FROM NEW."originalName" OR
    OLD."contentHash" IS DISTINCT FROM NEW."contentHash" OR
    OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt"
  ) THEN
    RAISE EXCEPTION 'claimed MessageAttachment lifecycle is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MessageAttachment_claimed_lifecycle"
  BEFORE UPDATE ON "public"."MessageAttachment"
  FOR EACH ROW EXECUTE FUNCTION "public"."protect_claimed_message_attachment"();
