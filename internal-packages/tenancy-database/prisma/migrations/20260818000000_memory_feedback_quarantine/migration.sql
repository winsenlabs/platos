-- MessageRating has always been exposed by the product as thumbs feedback:
-- +1 is thumbs-up and -1 is thumbs-down. The clean initial migration's 1..5
-- check accidentally admitted 2..5, but repository history defines no safe
-- star-scale interpretation for those values. Fail before any DDL with
-- content-free counts so an operator can deliberately remediate source data
-- rather than silently changing feedback meaning.
DO $$
DECLARE
  rating_2_count BIGINT;
  rating_3_count BIGINT;
  rating_4_count BIGINT;
  rating_5_count BIGINT;
  other_count BIGINT;
BEGIN
  SELECT
    COUNT(*) FILTER (WHERE "rating" = 2),
    COUNT(*) FILTER (WHERE "rating" = 3),
    COUNT(*) FILTER (WHERE "rating" = 4),
    COUNT(*) FILTER (WHERE "rating" = 5),
    COUNT(*) FILTER (WHERE "rating" NOT IN (-1, 1, 2, 3, 4, 5))
  INTO rating_2_count, rating_3_count, rating_4_count, rating_5_count, other_count
  FROM "public"."MessageRating";

  IF rating_2_count + rating_3_count + rating_4_count + rating_5_count + other_count > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = format(
        'MessageRating thumbs preflight failed: unsupported rows rating=2:%s, rating=3:%s, rating=4:%s, rating=5:%s, other:%s',
        rating_2_count, rating_3_count, rating_4_count, rating_5_count, other_count
      ),
      HINT = 'Platos only authorizes -1 (thumbs-down), 1 (thumbs-up), or deletion (no feedback). Audit and deliberately UPDATE or DELETE unsupported rows, mark this failed migration rolled back with prisma migrate resolve, then rerun migrate deploy.';
  END IF;
END $$;

-- Quarantine is authoritative recall state. It must remain plaintext so
-- pgvector candidate retrieval can exclude rejected memories without
-- decrypting content or metadata.
ALTER TABLE "public"."Memory"
  ADD COLUMN "quarantinedAt" TIMESTAMP(3),
  ADD COLUMN "feedbackBaselineConfidence" DOUBLE PRECISION;

ALTER TABLE "public"."Environment"
  ADD COLUMN "memoryFeedbackBackfillCursor" UUID,
  ADD COLUMN "memoryFeedbackBackfillCompletedAt" TIMESTAMP(3);

ALTER TABLE "public"."MessageRating"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "public"."MessageRating"
  DROP CONSTRAINT "MessageRating_rating_check",
  ADD CONSTRAINT "MessageRating_rating_check" CHECK ("rating" IN (-1, 1)),
  ADD CONSTRAINT "MessageRating_revision_check" CHECK ("revision" > 0);

ALTER TABLE "public"."Memory"
  ADD CONSTRAINT "Memory_feedback_baseline_confidence_check" CHECK (
    "feedbackBaselineConfidence" IS NULL OR
    "feedbackBaselineConfidence" BETWEEN 0 AND 1
  );

CREATE INDEX "Memory_environmentId_endUserId_quarantinedAt_idx"
  ON "public"."Memory"("environmentId", "endUserId", "quarantinedAt");
