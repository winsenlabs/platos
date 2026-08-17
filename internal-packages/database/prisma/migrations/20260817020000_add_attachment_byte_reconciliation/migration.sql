-- Constrained object-store byte reconciliation for upload reservations.
-- Ordinary UPDATEs remain rejected by immutable lifecycle triggers. The helper
-- acquires the canonical Organization quota lock, rechecks usage, and updates a
-- claimed MessageAttachment partner atomically when present.
CREATE OR REPLACE FUNCTION "public"."enforce_attachment_upload_reservation"()
RETURNS TRIGGER AS $$
DECLARE
  owner_valid BOOLEAN := FALSE;
  claim_valid BOOLEAN := FALSE;
  byte_correction BOOLEAN := FALSE;
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
    byte_correction :=
      OLD."bytes" IS DISTINCT FROM NEW."bytes" AND
      NEW."bytes" > 0 AND
      COALESCE(current_setting('platos.attachment_byte_correction', TRUE) = OLD.id::text, FALSE);

    IF OLD."environmentId" IS DISTINCT FROM NEW."environmentId" OR
       OLD."uploadedByUserId" IS DISTINCT FROM NEW."uploadedByUserId" OR
       OLD."uploadedByEndUserId" IS DISTINCT FROM NEW."uploadedByEndUserId" OR
       OLD."kind" IS DISTINCT FROM NEW."kind" OR
       OLD."mimeType" IS DISTINCT FROM NEW."mimeType" OR
       (OLD."bytes" IS DISTINCT FROM NEW."bytes" AND NOT byte_correction) OR
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
    ELSIF NEW."messageAttachmentId" IS NULL OR NEW."claimedAt" IS NULL THEN
      IF OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt" THEN
        RAISE EXCEPTION 'unclaimed AttachmentUploadReservation expiration is immutable'
          USING ERRCODE = '23514';
      END IF;
    ELSIF OLD."expiresAt" <= CURRENT_TIMESTAMP THEN
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

CREATE OR REPLACE FUNCTION "public"."protect_claimed_message_attachment"()
RETURNS TRIGGER AS $$
DECLARE
  reservation_id UUID;
  byte_correction BOOLEAN := FALSE;
BEGIN
  SELECT reservation.id
    INTO reservation_id
    FROM "public"."AttachmentUploadReservation" reservation
   WHERE reservation."messageAttachmentId" = OLD.id;

  IF reservation_id IS NOT NULL THEN
    byte_correction :=
      OLD."bytes" IS DISTINCT FROM NEW."bytes" AND
      NEW."bytes" > 0 AND
      COALESCE(current_setting('platos.attachment_byte_correction', TRUE) = reservation_id::text, FALSE);

    IF OLD."environmentId" IS DISTINCT FROM NEW."environmentId" OR
       OLD."endUserId" IS DISTINCT FROM NEW."endUserId" OR
       OLD."turnId" IS DISTINCT FROM NEW."turnId" OR
       OLD."kind" IS DISTINCT FROM NEW."kind" OR
       OLD."mimeType" IS DISTINCT FROM NEW."mimeType" OR
       (OLD."bytes" IS DISTINCT FROM NEW."bytes" AND NOT byte_correction) OR
       OLD."width" IS DISTINCT FROM NEW."width" OR
       OLD."height" IS DISTINCT FROM NEW."height" OR
       OLD."durationSec" IS DISTINCT FROM NEW."durationSec" OR
       OLD."storageKey" IS DISTINCT FROM NEW."storageKey" OR
       OLD."originalName" IS DISTINCT FROM NEW."originalName" OR
       OLD."contentHash" IS DISTINCT FROM NEW."contentHash" OR
       OLD."expiresAt" IS DISTINCT FROM NEW."expiresAt" THEN
      RAISE EXCEPTION 'claimed MessageAttachment lifecycle is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "public"."reconcile_attachment_upload_bytes"(
  reservation_id UUID,
  expected_environment_id UUID,
  expected_storage_key TEXT,
  expected_claimed_bytes INTEGER,
  observed_actual_bytes INTEGER,
  organization_quota_bytes BIGINT
)
RETURNS TABLE (
  "claimedBytes" INTEGER,
  "actualBytes" INTEGER,
  corrected BOOLEAN
) AS $$
DECLARE
  reservation "public"."AttachmentUploadReservation"%ROWTYPE;
  attachment "public"."MessageAttachment"%ROWTYPE;
  organization_id UUID;
  used_bytes BIGINT;
BEGIN
  IF observed_actual_bytes <= 0 OR organization_quota_bytes <= 0 THEN
    RAISE EXCEPTION 'Attachment byte correction values must be positive'
      USING ERRCODE = '22023';
  END IF;

  SELECT project."organizationId"
    INTO organization_id
    FROM "public"."AttachmentUploadReservation" candidate
    JOIN "public"."Environment" environment ON environment.id = candidate."environmentId"
    JOIN "public"."Project" project ON project.id = environment."projectId"
   WHERE candidate.id = reservation_id
     AND candidate."environmentId" = expected_environment_id;
  IF organization_id IS NULL THEN
    RAISE EXCEPTION 'Attachment upload reservation is not accessible'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(organization_id::text, 0));

  SELECT *
    INTO reservation
    FROM "public"."AttachmentUploadReservation" candidate
   WHERE candidate.id = reservation_id
     AND candidate."environmentId" = expected_environment_id
   FOR UPDATE;
  IF NOT FOUND OR reservation."storageKey" IS DISTINCT FROM expected_storage_key OR
     reservation."bytes" IS DISTINCT FROM expected_claimed_bytes OR
     reservation."expiresAt" <= CURRENT_TIMESTAMP THEN
    RAISE EXCEPTION 'Attachment upload reservation changed during byte reconciliation'
      USING ERRCODE = '23514';
  END IF;

  IF reservation."bytes" = observed_actual_bytes THEN
    RETURN QUERY SELECT reservation."bytes", observed_actual_bytes, FALSE;
    RETURN;
  END IF;

  SELECT (
    COALESCE((
      SELECT SUM(candidate."bytes")::bigint
        FROM "public"."AttachmentUploadReservation" candidate
        JOIN "public"."Environment" environment ON environment.id = candidate."environmentId"
        JOIN "public"."Project" project ON project.id = environment."projectId"
       WHERE project."organizationId" = organization_id
         AND candidate."expiresAt" > CURRENT_TIMESTAMP
    ), 0) +
    COALESCE((
      SELECT SUM(candidate."bytes")::bigint
        FROM "public"."MessageAttachment" candidate
        JOIN "public"."Environment" environment ON environment.id = candidate."environmentId"
        JOIN "public"."Project" project ON project.id = environment."projectId"
        LEFT JOIN "public"."AttachmentUploadReservation" linked
          ON linked."messageAttachmentId" = candidate.id
       WHERE project."organizationId" = organization_id
         AND linked.id IS NULL
         AND (candidate."expiresAt" IS NULL OR candidate."expiresAt" > CURRENT_TIMESTAMP)
    ), 0)
  )::bigint INTO used_bytes;

  IF used_bytes - reservation."bytes" + observed_actual_bytes > organization_quota_bytes THEN
    RAISE EXCEPTION 'Attachment upload quota exceeded during byte reconciliation'
      USING ERRCODE = '23514';
  END IF;

  PERFORM set_config('platos.attachment_byte_correction', reservation.id::text, TRUE);

  IF reservation."messageAttachmentId" IS NOT NULL THEN
    SELECT *
      INTO attachment
      FROM "public"."MessageAttachment" candidate
     WHERE candidate.id = reservation."messageAttachmentId"
     FOR UPDATE;
    IF NOT FOUND OR attachment."environmentId" IS DISTINCT FROM reservation."environmentId" OR
       attachment."storageKey" IS DISTINCT FROM reservation."storageKey" OR
       attachment."bytes" IS DISTINCT FROM reservation."bytes" THEN
      RAISE EXCEPTION 'Claimed attachment metadata changed during byte reconciliation'
        USING ERRCODE = '23514';
    END IF;
    UPDATE "public"."MessageAttachment"
       SET "bytes" = observed_actual_bytes
     WHERE id = attachment.id;
  END IF;

  UPDATE "public"."AttachmentUploadReservation"
     SET "bytes" = observed_actual_bytes
   WHERE id = reservation.id;

  RETURN QUERY SELECT reservation."bytes", observed_actual_bytes, TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp;

REVOKE ALL
ON FUNCTION "public"."reconcile_attachment_upload_bytes"(UUID, UUID, TEXT, INTEGER, INTEGER, BIGINT)
FROM PUBLIC;
