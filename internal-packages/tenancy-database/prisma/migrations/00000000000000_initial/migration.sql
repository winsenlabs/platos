-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."PrincipalTier" AS ENUM ('OPERATOR', 'END_USER');

-- CreateEnum
CREATE TYPE "public"."OrganizationRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "public"."ProjectRole" AS ENUM ('ADMIN', 'EDITOR', 'VIEWER');

-- CreateTable
CREATE TABLE "public"."User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OperatorSession" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tier" "public"."PrincipalTier" NOT NULL DEFAULT 'OPERATOR',
    "userId" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperatorSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Organization" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OrganizationMembership" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "public"."OrganizationRole" NOT NULL DEFAULT 'MEMBER',
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OrganizationInvitation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "inviterId" UUID,
    "email" TEXT NOT NULL,
    "role" "public"."OrganizationRole" NOT NULL DEFAULT 'MEMBER',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Project" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProjectMembership" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "organizationMembershipId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "role" "public"."ProjectRole" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Environment" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Environment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EnvironmentSession" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "operatorSessionId" UUID NOT NULL,
    "tier" "public"."PrincipalTier" NOT NULL DEFAULT 'OPERATOR',
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnvironmentSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EndUser" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "displayName" TEXT,
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EndUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EndUserIdentity" (
    "id" UUID NOT NULL,
    "endUserId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "issuer" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "profile" JSONB,
    "verifiedAt" TIMESTAMP(3),
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EndUserIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EndUserSession" (
    "id" UUID NOT NULL,
    "identityId" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tier" "public"."PrincipalTier" NOT NULL DEFAULT 'END_USER',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EndUserSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "OperatorSession_tokenHash_key" ON "public"."OperatorSession"("tokenHash");

-- CreateIndex
CREATE INDEX "OperatorSession_userId_expiresAt_idx" ON "public"."OperatorSession"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "OperatorSession_expiresAt_idx" ON "public"."OperatorSession"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "public"."Organization"("slug");

-- CreateIndex
CREATE INDEX "Organization_archivedAt_idx" ON "public"."Organization"("archivedAt");

-- CreateIndex
CREATE INDEX "OrganizationMembership_userId_deactivatedAt_idx" ON "public"."OrganizationMembership"("userId", "deactivatedAt");

-- CreateIndex
CREATE INDEX "OrganizationMembership_organizationId_role_deactivatedAt_idx" ON "public"."OrganizationMembership"("organizationId", "role", "deactivatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMembership_organizationId_userId_key" ON "public"."OrganizationMembership"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMembership_id_organizationId_key" ON "public"."OrganizationMembership"("id", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationInvitation_tokenHash_key" ON "public"."OrganizationInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "OrganizationInvitation_organizationId_email_expiresAt_idx" ON "public"."OrganizationInvitation"("organizationId", "email", "expiresAt");

-- CreateIndex
CREATE INDEX "OrganizationInvitation_inviterId_idx" ON "public"."OrganizationInvitation"("inviterId");

-- CreateIndex
CREATE INDEX "OrganizationInvitation_expiresAt_idx" ON "public"."OrganizationInvitation"("expiresAt");

-- CreateIndex
CREATE INDEX "Project_organizationId_archivedAt_idx" ON "public"."Project"("organizationId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Project_organizationId_slug_key" ON "public"."Project"("organizationId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Project_id_organizationId_key" ON "public"."Project"("id", "organizationId");

-- CreateIndex
CREATE INDEX "ProjectMembership_organizationMembershipId_idx" ON "public"."ProjectMembership"("organizationMembershipId");

-- CreateIndex
CREATE INDEX "ProjectMembership_projectId_role_idx" ON "public"."ProjectMembership"("projectId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMembership_projectId_organizationMembershipId_key" ON "public"."ProjectMembership"("projectId", "organizationMembershipId");

-- CreateIndex
CREATE INDEX "Environment_projectId_archivedAt_idx" ON "public"."Environment"("projectId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Environment_projectId_slug_key" ON "public"."Environment"("projectId", "slug");

-- CreateIndex
CREATE INDEX "EnvironmentSession_environmentId_endedAt_idx" ON "public"."EnvironmentSession"("environmentId", "endedAt");

-- CreateIndex
CREATE INDEX "EnvironmentSession_operatorSessionId_endedAt_idx" ON "public"."EnvironmentSession"("operatorSessionId", "endedAt");

-- CreateIndex
CREATE INDEX "EndUser_organizationId_disabledAt_idx" ON "public"."EndUser"("organizationId", "disabledAt");

-- CreateIndex
CREATE UNIQUE INDEX "EndUser_id_organizationId_key" ON "public"."EndUser"("id", "organizationId");

-- CreateIndex
CREATE INDEX "EndUserIdentity_endUserId_disabledAt_idx" ON "public"."EndUserIdentity"("endUserId", "disabledAt");

-- CreateIndex
CREATE UNIQUE INDEX "EndUserIdentity_organizationId_issuer_channel_subject_key" ON "public"."EndUserIdentity"("organizationId", "issuer", "channel", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "EndUserSession_tokenHash_key" ON "public"."EndUserSession"("tokenHash");

-- CreateIndex
CREATE INDEX "EndUserSession_identityId_expiresAt_idx" ON "public"."EndUserSession"("identityId", "expiresAt");

-- CreateIndex
CREATE INDEX "EndUserSession_environmentId_expiresAt_idx" ON "public"."EndUserSession"("environmentId", "expiresAt");

-- CreateIndex
CREATE INDEX "EndUserSession_expiresAt_idx" ON "public"."EndUserSession"("expiresAt");

-- AddForeignKey
ALTER TABLE "public"."OperatorSession" ADD CONSTRAINT "OperatorSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Project" ADD CONSTRAINT "Project_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProjectMembership" ADD CONSTRAINT "ProjectMembership_projectId_organizationId_fkey" FOREIGN KEY ("projectId", "organizationId") REFERENCES "public"."Project"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProjectMembership" ADD CONSTRAINT "ProjectMembership_organizationMembershipId_organizationId_fkey" FOREIGN KEY ("organizationMembershipId", "organizationId") REFERENCES "public"."OrganizationMembership"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Environment" ADD CONSTRAINT "Environment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EnvironmentSession" ADD CONSTRAINT "EnvironmentSession_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EnvironmentSession" ADD CONSTRAINT "EnvironmentSession_operatorSessionId_fkey" FOREIGN KEY ("operatorSessionId") REFERENCES "public"."OperatorSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EndUser" ADD CONSTRAINT "EndUser_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EndUserIdentity" ADD CONSTRAINT "EndUserIdentity_endUserId_organizationId_fkey" FOREIGN KEY ("endUserId", "organizationId") REFERENCES "public"."EndUser"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EndUserSession" ADD CONSTRAINT "EndUserSession_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "public"."EndUserIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EndUserSession" ADD CONSTRAINT "EndUserSession_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Enforce the principal tier in the database rather than trusting callers to
-- preserve each session table's control-plane/data-plane meaning.
ALTER TABLE "public"."OperatorSession"
ADD CONSTRAINT "OperatorSession_tier_check" CHECK ("tier" = 'OPERATOR');

ALTER TABLE "public"."EnvironmentSession"
ADD CONSTRAINT "EnvironmentSession_tier_check" CHECK ("tier" = 'OPERATOR');

ALTER TABLE "public"."EndUserSession"
ADD CONSTRAINT "EndUserSession_tier_check" CHECK ("tier" = 'END_USER');

-- End users are organization-owned while sessions are environment-pinned.
-- Verify the derived parent chain without storing an independent scope tuple.
CREATE FUNCTION "public"."enforce_end_user_session_organization"()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM "public"."EndUserIdentity" AS identity
        INNER JOIN "public"."EndUser" AS end_user
            ON end_user."id" = identity."endUserId"
           AND end_user."organizationId" = identity."organizationId"
        INNER JOIN "public"."Environment" AS environment
            ON environment."id" = NEW."environmentId"
        INNER JOIN "public"."Project" AS project
            ON project."id" = environment."projectId"
        WHERE identity."id" = NEW."identityId"
          AND end_user."organizationId" = project."organizationId"
    ) THEN
        RAISE EXCEPTION 'End-user identity and environment must belong to the same organization'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EndUserSession_organization_check"
BEFORE INSERT OR UPDATE OF "identityId", "environmentId"
ON "public"."EndUserSession"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_end_user_session_organization"();

-- A session's organization can also change indirectly when one of the parent
-- links in its derived scope is repointed. Reject those changes before they
-- can make an already-valid session cross an organization boundary.
CREATE FUNCTION "public"."enforce_environment_end_user_session_organization"()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "public"."EndUserSession" AS session
        INNER JOIN "public"."EndUserIdentity" AS identity
            ON identity."id" = session."identityId"
        INNER JOIN "public"."EndUser" AS end_user
            ON end_user."id" = identity."endUserId"
           AND end_user."organizationId" = identity."organizationId"
        INNER JOIN "public"."Project" AS project
            ON project."id" = NEW."projectId"
        WHERE session."environmentId" = NEW."id"
          AND end_user."organizationId" <> project."organizationId"
    ) THEN
        RAISE EXCEPTION 'Environment project and end-user sessions must belong to the same organization'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Environment_end_user_session_organization_check"
BEFORE UPDATE OF "projectId"
ON "public"."Environment"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_environment_end_user_session_organization"();

CREATE FUNCTION "public"."enforce_project_end_user_session_organization"()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "public"."Environment" AS environment
        INNER JOIN "public"."EndUserSession" AS session
            ON session."environmentId" = environment."id"
        INNER JOIN "public"."EndUserIdentity" AS identity
            ON identity."id" = session."identityId"
        INNER JOIN "public"."EndUser" AS end_user
            ON end_user."id" = identity."endUserId"
           AND end_user."organizationId" = identity."organizationId"
        WHERE environment."projectId" = NEW."id"
          AND end_user."organizationId" <> NEW."organizationId"
    ) THEN
        RAISE EXCEPTION 'Project organization and end-user sessions must belong to the same organization'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Project_end_user_session_organization_check"
BEFORE UPDATE OF "organizationId"
ON "public"."Project"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_project_end_user_session_organization"();

CREATE FUNCTION "public"."enforce_end_user_session_organization_reparent"()
RETURNS TRIGGER AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "public"."EndUserIdentity" AS identity
        INNER JOIN "public"."EndUserSession" AS session
            ON session."identityId" = identity."id"
        INNER JOIN "public"."Environment" AS environment
            ON environment."id" = session."environmentId"
        INNER JOIN "public"."Project" AS project
            ON project."id" = environment."projectId"
        WHERE identity."endUserId" = NEW."id"
          AND project."organizationId" <> NEW."organizationId"
    ) THEN
        RAISE EXCEPTION 'End-user organization and sessions must belong to the same organization'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EndUser_session_organization_reparent_check"
BEFORE UPDATE OF "organizationId"
ON "public"."EndUser"
FOR EACH ROW
EXECUTE FUNCTION "public"."enforce_end_user_session_organization_reparent"();
