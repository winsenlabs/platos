-- Platos Theme D — multimodal attachments.
--
-- Adds PlatosMessageAttachment — one row per uploaded file. Scope fields
-- (organizationId, projectId, environmentId) mirror the Theme A scoping
-- invariant; every scoped row carries all four axes and FKs cascade on
-- delete so tearing down a project/env tears down its attachments.
--
-- messageId is nullable: rows are created when the browser requests a
-- presigned PUT URL, before the message is sent. The retention task
-- deletes still-unattached rows after PLATOS_ATTACHMENT_GRACE_DAYS.

-- CreateTable
CREATE TABLE "public"."PlatosMessageAttachment" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "messageId" TEXT,
    "uploadedBy" TEXT NOT NULL,
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
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "PlatosMessageAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex — scoped lookup for the retention task + per-org quota sum.
CREATE INDEX "PlatosMessageAttachment_organizationId_projectId_environmen_idx" ON "public"."PlatosMessageAttachment"("organizationId", "projectId", "environmentId");

-- CreateIndex — messageId lookup for loading attachments attached to a message.
CREATE INDEX "PlatosMessageAttachment_messageId_idx" ON "public"."PlatosMessageAttachment"("messageId");

-- CreateIndex — per-user quota + audit.
CREATE INDEX "PlatosMessageAttachment_uploadedBy_idx" ON "public"."PlatosMessageAttachment"("uploadedBy");

-- CreateIndex — daily retention sweep walks this index.
CREATE INDEX "PlatosMessageAttachment_expiresAt_idx" ON "public"."PlatosMessageAttachment"("expiresAt");

-- AddForeignKey
ALTER TABLE "public"."PlatosMessageAttachment" ADD CONSTRAINT "PlatosMessageAttachment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatosMessageAttachment" ADD CONSTRAINT "PlatosMessageAttachment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PlatosMessageAttachment" ADD CONSTRAINT "PlatosMessageAttachment_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey — messageId is nullable + SET NULL so a message delete
-- leaves orphan attachment rows for the retention task to clean up via
-- the grace-period TTL rule.
ALTER TABLE "public"."PlatosMessageAttachment" ADD CONSTRAINT "PlatosMessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."PlatosAgentMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
