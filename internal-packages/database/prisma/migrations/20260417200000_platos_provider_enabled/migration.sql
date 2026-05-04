-- Platos Theme B.7 — provider env-var linking.
--
-- Adds PlatosProviderEnabled, a lightweight scope-enabled marker for LLM
-- providers. Provider secrets continue to live in the trigger.dev
-- Environment Variables table (see PLATOS_SPEC §4.4). This row only
-- records whether the user has linked a provider to the scope and
-- whether it is currently enabled.
--
-- The historical PlatosProviderCredential idea was scrapped before v1
-- shipped to DB, so there is no DROP TABLE here — only a CREATE TABLE.

-- CreateTable
CREATE TABLE "public"."PlatosProviderEnabled" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatosProviderEnabled_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatosProviderEnabled_organizationId_projectId_environmentI_key" ON "public"."PlatosProviderEnabled"("organizationId", "projectId", "environmentId", "providerId");

-- CreateIndex
CREATE INDEX "PlatosProviderEnabled_organizationId_projectId_environmentI_idx" ON "public"."PlatosProviderEnabled"("organizationId", "projectId", "environmentId");

-- AddForeignKey
ALTER TABLE "public"."PlatosProviderEnabled" ADD CONSTRAINT "PlatosProviderEnabled_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
