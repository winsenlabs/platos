-- WIN-130 — durable channel token rotation and hosted event admission.

ALTER TABLE "public"."ChannelInstallation"
  ADD COLUMN "tokenRefreshState" TEXT NOT NULL DEFAULT 'IDLE',
  ADD COLUMN "tokenRefreshAttemptId" UUID,
  ADD COLUMN "tokenRefreshStartedAt" TIMESTAMP(3),
  ADD COLUMN "tokenRefreshRepairCode" TEXT,
  ADD COLUMN "tokenGeneration" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "public"."Turn"
  ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "Turn_threadId_idempotencyKey_key"
  ON "public"."Turn"("threadId", "idempotencyKey");

ALTER TABLE "public"."ChannelInstallation"
  ADD CONSTRAINT "ChannelInstallation_tokenRefreshState_check"
  CHECK ("tokenRefreshState" IN ('IDLE', 'REFRESHING', 'REPAIR_REQUIRED'));

CREATE INDEX "ChannelInstallation_tokenRefreshState_tokenRefreshStartedAt_idx"
  ON "public"."ChannelInstallation"("tokenRefreshState", "tokenRefreshStartedAt");

CREATE TABLE "public"."ChannelEventInbox" (
  "id" UUID NOT NULL,
  "appId" UUID NOT NULL,
  "eventId" TEXT NOT NULL,
  "payloadFormatVersion" INTEGER NOT NULL,
  "payloadKeyVersion" INTEGER NOT NULL,
  "encryptedPayload" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseOwner" TEXT,
  "leaseExpiresAt" TIMESTAMP(3),
  "leaseGeneration" INTEGER NOT NULL DEFAULT 0,
  "turnId" UUID,
  "deliveryCompletedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ChannelEventInbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ChannelEventInbox_appId_eventId_key"
  ON "public"."ChannelEventInbox"("appId", "eventId");
CREATE UNIQUE INDEX "ChannelEventInbox_turnId_key"
  ON "public"."ChannelEventInbox"("turnId");
CREATE INDEX "ChannelEventInbox_status_availableAt_idx"
  ON "public"."ChannelEventInbox"("status", "availableAt");
CREATE INDEX "ChannelEventInbox_leaseExpiresAt_idx"
  ON "public"."ChannelEventInbox"("leaseExpiresAt");

ALTER TABLE "public"."ChannelEventInbox"
  ADD CONSTRAINT "ChannelEventInbox_status_check"
  CHECK ("status" IN ('PENDING', 'PROCESSING', 'FAILED', 'COMPLETED', 'DISCARDED'));

ALTER TABLE "public"."ChannelEventInbox"
  ADD CONSTRAINT "ChannelEventInbox_appId_fkey"
  FOREIGN KEY ("appId") REFERENCES "public"."ChannelApp"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."ChannelEventInbox"
  ADD CONSTRAINT "ChannelEventInbox_turnId_fkey"
  FOREIGN KEY ("turnId") REFERENCES "public"."Turn"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION "public"."reject_channel_event_inbox_identity_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."appId" IS DISTINCT FROM OLD."appId"
     OR NEW."eventId" IS DISTINCT FROM OLD."eventId"
     OR NEW."payloadFormatVersion" IS DISTINCT FROM OLD."payloadFormatVersion"
     OR NEW."payloadKeyVersion" IS DISTINCT FROM OLD."payloadKeyVersion"
     OR NEW."encryptedPayload" IS DISTINCT FROM OLD."encryptedPayload" THEN
    RAISE EXCEPTION 'ChannelEventInbox identity and payload are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ChannelEventInbox_identity_immutable"
  BEFORE UPDATE ON "public"."ChannelEventInbox"
  FOR EACH ROW EXECUTE FUNCTION "public"."reject_channel_event_inbox_identity_mutation"();
