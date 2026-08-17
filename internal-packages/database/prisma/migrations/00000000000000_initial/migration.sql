-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "public"."PrincipalTier" AS ENUM ('OPERATOR', 'END_USER');

-- CreateEnum
CREATE TYPE "public"."OrganizationRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "public"."OperatorIdentityProvider" AS ENUM ('MAGIC_LINK', 'GITHUB', 'GOOGLE');

-- CreateEnum
CREATE TYPE "public"."AuthRateLimitAction" AS ENUM ('LOGIN', 'INVITE_ACCEPT', 'MFA_VERIFY');

-- CreateEnum
CREATE TYPE "public"."ImpersonationAction" AS ENUM ('START', 'STOP');

-- CreateEnum
CREATE TYPE "public"."ProjectRole" AS ENUM ('ADMIN', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "public"."CredentialKind" AS ENUM ('SECRET_REFERENCE', 'CHANNEL_SECRET', 'ENTITY_SECRET', 'SERVICE_CREDENTIAL');

-- CreateEnum
CREATE TYPE "public"."PolicyEffect" AS ENUM ('ALLOW', 'DENY');

-- CreateEnum
CREATE TYPE "public"."ToolKind" AS ENUM ('ENTITY', 'RUNTIME', 'META');

-- CreateEnum
CREATE TYPE "public"."WorkStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "public"."ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "public"."AuthorizationScopeKind" AS ENUM ('GLOBAL', 'ORGANIZATION', 'PROJECT', 'ENVIRONMENT');

-- CreateEnum
CREATE TYPE "public"."AgentToolDefaultPolicy" AS ENUM ('NONE', 'ALL');

-- CreateEnum
CREATE TYPE "public"."AgentVersionBucket" AS ENUM ('CURRENT', 'CANARY');

-- CreateEnum
CREATE TYPE "public"."ThreadCompactionState" AS ENUM ('IDLE', 'IN_PROGRESS');

-- CreateTable
CREATE TABLE "public"."User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "platformOperator" BOOLEAN NOT NULL DEFAULT false,
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
    "impersonatedUserId" UUID,
    "parentSessionId" UUID,
    "mfaVerifiedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperatorSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OperatorIdentity" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "public"."OperatorIdentityProvider" NOT NULL,
    "subject" TEXT NOT NULL,
    "providerEmail" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatorIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MagicLinkToken" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MagicLinkToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OperatorMfaTotp" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "encryptedSecret" TEXT,
    "enabledAt" TIMESTAMP(3),
    "lastUsedCounter" BIGINT,
    "pendingEncryptedSecret" TEXT,
    "pendingExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperatorMfaTotp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OperatorMfaRecoveryCode" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperatorMfaRecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AuthRateLimitBucket" (
    "id" UUID NOT NULL,
    "action" "public"."AuthRateLimitAction" NOT NULL,
    "identifierHash" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthRateLimitBucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ImpersonationAudit" (
    "id" UUID NOT NULL,
    "action" "public"."ImpersonationAction" NOT NULL,
    "actorUserId" UUID NOT NULL,
    "targetUserId" UUID NOT NULL,
    "impersonationSessionId" UUID NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImpersonationAudit_pkey" PRIMARY KEY ("id")
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
    "acceptedByUserId" UUID,
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

-- CreateTable
CREATE TABLE "public"."Agent" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AgentCluster" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentCluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AgentVersion" (
    "id" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "systemPrompt" TEXT,
    "maxSteps" INTEGER NOT NULL DEFAULT 10,
    "contextLimit" INTEGER NOT NULL DEFAULT 128000,
    "toolDefaultPolicy" "public"."AgentToolDefaultPolicy" NOT NULL DEFAULT 'NONE',
    "promptBlocks" JSONB NOT NULL DEFAULT '[]',
    "dynamicBlocks" JSONB NOT NULL DEFAULT '[]',
    "toolsBlockConfig" JSONB NOT NULL DEFAULT '{}',
    "modelRoutes" JSONB NOT NULL DEFAULT '[]',
    "memoryConfig" JSONB NOT NULL DEFAULT '{}',
    "outputSchema" JSONB,
    "note" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AgentBinding" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "activeAgentVersionId" UUID NOT NULL,
    "canaryAgentVersionId" UUID,
    "clusterId" UUID,
    "canaryPercent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Credential" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "activeSecretVersionId" UUID,
    "kind" "public"."CredentialKind" NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT,
    "secretHash" TEXT,
    "encryptedReference" TEXT,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedOrigins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "provider" TEXT,
    "externalClientId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CredentialSecretVersion" (
    "id" UUID NOT NULL,
    "credentialId" UUID NOT NULL,
    "secretRevision" INTEGER NOT NULL,
    "formatVersion" INTEGER NOT NULL,
    "rootKeyVersion" INTEGER NOT NULL,
    "salt" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "authTag" BYTEA NOT NULL,
    "retiredAt" TIMESTAMP(3),
    "readableUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CredentialSecretVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CredentialAudit" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "credentialId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "effectiveUserId" TEXT,
    "secretRevision" INTEGER,
    "fromRootKeyVersion" INTEGER,
    "toRootKeyVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CredentialAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AccessKey" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "allowedOrigins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "replacedById" UUID,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProviderKey" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "credentialId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "environmentKeyName" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."McpToken" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "mintedByUserId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "permissions" TEXT[],
    "tier" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PersonalAccessToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "scopeKind" "public"."AuthorizationScopeKind" NOT NULL,
    "organizationId" UUID,
    "projectId" UUID,
    "environmentId" UUID,
    "tokenHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonalAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OAuthAccessToken" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "clientId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "scopeKind" "public"."AuthorizationScopeKind" NOT NULL,
    "organizationId" UUID,
    "projectId" UUID,
    "environmentId" UUID,
    "scopes" TEXT[],
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "OAuthAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OAuthRefreshToken" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "accessTokenId" UUID,
    "clientId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "scopeKind" "public"."AuthorizationScopeKind" NOT NULL,
    "organizationId" UUID,
    "projectId" UUID,
    "environmentId" UUID,
    "scopes" TEXT[],
    "rotationFamilyId" UUID NOT NULL,
    "parentRefreshTokenId" UUID,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "replayDetectedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "OAuthRefreshToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."McpBearerToken" (
    "id" UUID NOT NULL,
    "entityId" UUID NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "mcpUserId" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "McpBearerToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PostmanTemplate" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "simulateUserId" TEXT NOT NULL,
    "sessionContext" JSONB,
    "createdBy" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostmanTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Thread" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "endUserId" UUID NOT NULL,
    "clusterId" UUID,
    "parentThreadId" UUID,
    "compactedUpToTurnId" UUID,
    "title" TEXT,
    "status" "public"."WorkStatus" NOT NULL DEFAULT 'ACTIVE',
    "summary" TEXT,
    "compactionState" "public"."ThreadCompactionState" NOT NULL DEFAULT 'IDLE',
    "compactedAt" TIMESTAMP(3),
    "sessionContext" JSONB,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pinnedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Thread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Turn" (
    "id" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "parentTurnId" UUID,
    "agentVersionId" UUID NOT NULL,
    "versionBucket" "public"."AgentVersionBucket" NOT NULL,
    "sequence" INTEGER NOT NULL,
    "inputText" TEXT,
    "outputText" TEXT,
    "input" JSONB,
    "output" JSONB,
    "thinkingContent" TEXT,
    "status" "public"."WorkStatus" NOT NULL DEFAULT 'PENDING',
    "externalRuntimeId" TEXT,
    "costCents" DECIMAL(18,6),
    "latencyMs" INTEGER,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Turn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Step" (
    "id" UUID NOT NULL,
    "turnId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "model" TEXT NOT NULL,
    "status" "public"."WorkStatus" NOT NULL DEFAULT 'PENDING',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cacheCreationInputTokens" INTEGER,
    "cacheReadInputTokens" INTEGER,
    "reasoningTokens" INTEGER,
    "costCents" DECIMAL(18,6),
    "latencyMs" INTEGER,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ToolCall" (
    "id" UUID NOT NULL,
    "stepId" UUID NOT NULL,
    "toolId" UUID,
    "sequence" INTEGER NOT NULL,
    "toolName" TEXT NOT NULL,
    "arguments" JSONB NOT NULL,
    "result" JSONB,
    "status" "public"."WorkStatus" NOT NULL DEFAULT 'PENDING',
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "latencyMs" INTEGER,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Artifact" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "producedByTurnId" UUID,
    "artifactKey" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "kind" TEXT NOT NULL,
    "title" TEXT,
    "mimeType" TEXT,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MessageAttachment" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "endUserId" UUID NOT NULL,
    "turnId" UUID,
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

    CONSTRAINT "MessageAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Entity" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "connectionStatus" TEXT NOT NULL,
    "connectionKind" TEXT NOT NULL,
    "mcpUrls" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowedOrigins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastConnectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Entity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ChannelConnection" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "entityId" UUID,
    "provider" TEXT NOT NULL,
    "displayName" TEXT,
    "defaultAgentId" UUID,
    "agentRouting" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "credentialId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ChannelThread" (
    "id" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "channelThreadKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ChannelApp" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "displayName" TEXT,
    "clientId" TEXT NOT NULL,
    "credentialId" UUID,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "distribution" TEXT NOT NULL,
    "defaultAgentId" UUID,
    "agentRouting" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelApp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ChannelInstallation" (
    "id" UUID NOT NULL,
    "appId" UUID NOT NULL,
    "externalInstallationId" TEXT NOT NULL,
    "displayName" TEXT,
    "credentialId" UUID,
    "grantedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "defaultAgentId" UUID,
    "agentRouting" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastEventAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ChannelAppThread" (
    "id" UUID NOT NULL,
    "installationId" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "channelThreadKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelAppThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EntityMcpConfig" (
    "entityId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "identityMode" TEXT NOT NULL,
    "identityProviders" JSONB NOT NULL DEFAULT '[]',
    "branding" JSONB NOT NULL DEFAULT '{}',
    "toolAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "redirectUriAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 60,
    "injectMcpContext" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntityMcpConfig_pkey" PRIMARY KEY ("entityId")
);

-- CreateTable
CREATE TABLE "public"."EntityMcpClient" (
    "entityId" UUID NOT NULL,
    "transport" TEXT NOT NULL,
    "url" TEXT,
    "credentialId" UUID,
    "headersTemplate" JSONB NOT NULL DEFAULT '{}',
    "lastDiscoveryAt" TIMESTAMP(3),
    "discoveryError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EntityMcpClient_pkey" PRIMARY KEY ("entityId")
);

-- CreateTable
CREATE TABLE "public"."Tool" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "kind" "public"."ToolKind" NOT NULL DEFAULT 'ENTITY',
    "paramSchema" JSONB NOT NULL,
    "category" TEXT,
    "schemaHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EnvironmentEntityTool" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "entityId" UUID NOT NULL,
    "toolId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "callbackUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvironmentEntityTool_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ToolHealth" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "toolId" UUID NOT NULL,
    "entityExternalId" TEXT,
    "lastCalledAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "failCount" INTEGER NOT NULL DEFAULT 0,
    "totalCalls" INTEGER NOT NULL DEFAULT 0,
    "totalFailures" INTEGER NOT NULL DEFAULT 0,
    "p95LatencyMs" INTEGER,
    "avgLatencyMs" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ToolHealth_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ToolCallAudit" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "toolId" UUID,
    "endUserId" UUID,
    "agentId" UUID,
    "threadId" UUID,
    "toolName" TEXT NOT NULL,
    "arguments" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "status" "public"."WorkStatus" NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "costCents" DECIMAL(18,6),
    "traceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolCallAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AdminAudit" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AgentApproval" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "agentId" UUID,
    "threadId" UUID,
    "turnId" UUID,
    "action" TEXT NOT NULL,
    "details" TEXT,
    "status" "public"."ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 300,
    "resolvedAt" TIMESTAMP(3),
    "respondedBy" TEXT,
    "comment" TEXT,
    "toolName" TEXT,
    "arguments" JSONB,
    "resolution" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EnvironmentProvider" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "providerId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvironmentProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Budget" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "agentId" UUID,
    "scope" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "limitCents" INTEGER NOT NULL,
    "turnsLimit" INTEGER,
    "alertThresholds" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "overrideUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SafetyEvent" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "agentId" UUID,
    "threadId" UUID,
    "turnId" UUID,
    "endUserId" UUID,
    "detector" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "detail" TEXT,
    "metadata" JSONB,
    "toolName" TEXT,
    "toolCallId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SafetyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MessageRating" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "turnId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "agentVersionId" UUID,
    "endUserId" UUID NOT NULL,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EvalCriterion" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "agentId" UUID,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "judgePrompt" TEXT NOT NULL,
    "rubric" TEXT,
    "judgeModel" TEXT,
    "scoreScaleMin" INTEGER NOT NULL DEFAULT 0,
    "scoreScaleMax" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvalCriterion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AgentEval" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "agentVersionId" UUID,
    "threadId" UUID NOT NULL,
    "turnId" UUID,
    "criterionId" UUID NOT NULL,
    "criterionSnapshot" JSONB NOT NULL,
    "judgeModel" TEXT NOT NULL,
    "judgePromptUsed" TEXT NOT NULL,
    "rawResponse" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "rationale" TEXT,
    "passed" BOOLEAN NOT NULL,
    "costCents" DECIMAL(18,6),
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentEval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."GoldenSet" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "threadIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "criterionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoldenSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Job" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "externalId" TEXT,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "triggerType" TEXT NOT NULL,
    "scheduleCron" TEXT,
    "scheduleTimezone" TEXT,
    "allowedAgentIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "payloadSchema" JSONB,
    "handler" TEXT NOT NULL,
    "timeoutSeconds" INTEGER NOT NULL DEFAULT 300,
    "maxRetries" INTEGER NOT NULL DEFAULT 0,
    "status" "public"."WorkStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdBy" TEXT NOT NULL,
    "lastStartedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Skill" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "author" TEXT,
    "origin" TEXT NOT NULL,
    "isOfficial" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "promptBlock" TEXT NOT NULL,
    "providesTools" JSONB NOT NULL DEFAULT '[]',
    "requiredEnvironmentKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "optionalEnvironmentKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Skill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProjectSkill" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "skillId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EnvironmentSkill" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "projectSkillId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvironmentSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AgentSkill" (
    "id" UUID NOT NULL,
    "agentVersionId" UUID NOT NULL,
    "environmentSkillId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AgentToolPolicy" (
    "id" UUID NOT NULL,
    "agentVersionId" UUID NOT NULL,
    "toolId" UUID NOT NULL,
    "effect" "public"."PolicyEffect" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentToolPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Memory" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "endUserId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "clusterId" UUID,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "agentVisible" BOOLEAN NOT NULL DEFAULT true,
    "visibility" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "embedding" vector(1536),
    "sourceThreadId" UUID,
    "sourceTurnIds" UUID[] DEFAULT ARRAY[]::UUID[],
    "extractorVersion" TEXT,
    "contentHash" TEXT,
    "confidence" DOUBLE PRECISION,
    "lastAccessedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MemoryEntity" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "endUserId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "clusterId" UUID,
    "entityKey" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MemoryEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MemoryRelationship" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "endUserId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "clusterId" UUID,
    "fromEntityId" UUID NOT NULL,
    "toEntityId" UUID NOT NULL,
    "relationshipType" TEXT NOT NULL,
    "weight" DOUBLE PRECISION,
    "metadata" JSONB,
    "sourceMemoryId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemoryRelationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OrganizationMcpPolicy" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "pattern" TEXT NOT NULL,
    "effect" "public"."PolicyEffect" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationMcpPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Macro" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "steps" JSONB NOT NULL,
    "paramSchema" JSONB,
    "sharedWithOrganization" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Macro_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Event" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "subjectId" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."NotificationRule" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "delivery" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OAuthClient" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretHash" TEXT,
    "clientName" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "tokenEndpointAuthMethod" TEXT NOT NULL,
    "grantTypes" TEXT[],
    "scopes" TEXT[],
    "registeredByUserId" UUID NOT NULL,
    "entityId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "OAuthClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OAuthAuthorizationCode" (
    "id" UUID NOT NULL,
    "scopeKind" "public"."AuthorizationScopeKind" NOT NULL,
    "organizationId" UUID,
    "projectId" UUID,
    "environmentId" UUID,
    "clientId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "codeChallengeMethod" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthAuthorizationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."McpAnonymousSession" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "entityId" UUID NOT NULL,
    "mcpUserId" TEXT NOT NULL,
    "firstSeenIp" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "McpAnonymousSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."McpOidcSession" (
    "id" UUID NOT NULL,
    "environmentId" UUID NOT NULL,
    "entityId" UUID NOT NULL,
    "mcpUserId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "email" TEXT,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "externalSubject" TEXT NOT NULL,
    "displayName" TEXT,
    "avatarUrl" TEXT,
    "credentialId" UUID,
    "firstLoginAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "McpOidcSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EntityToolPolicy" (
    "id" UUID NOT NULL,
    "entityId" UUID NOT NULL,
    "toolId" UUID NOT NULL,
    "effect" "public"."PolicyEffect" NOT NULL,
    "minIdentityMode" TEXT NOT NULL,
    "scopeLabels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "addedBy" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReviewedAt" TIMESTAMP(3),

    CONSTRAINT "EntityToolPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ErasureOperation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "subjectKeyHash" TEXT NOT NULL,
    "status" "public"."WorkStatus" NOT NULL DEFAULT 'PENDING',
    "scopes" JSONB NOT NULL,
    "stores" JSONB NOT NULL,
    "inventory" JSONB,
    "policyVersion" TEXT NOT NULL,
    "legalHoldPolicyId" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ErasureOperation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "OperatorSession_tokenHash_key" ON "public"."OperatorSession"("tokenHash");

-- CreateIndex
CREATE INDEX "OperatorSession_userId_expiresAt_idx" ON "public"."OperatorSession"("userId", "expiresAt");

-- CreateIndex
CREATE INDEX "OperatorSession_impersonatedUserId_expiresAt_idx" ON "public"."OperatorSession"("impersonatedUserId", "expiresAt");

-- CreateIndex
CREATE INDEX "OperatorSession_parentSessionId_idx" ON "public"."OperatorSession"("parentSessionId");

-- CreateIndex
CREATE INDEX "OperatorSession_expiresAt_idx" ON "public"."OperatorSession"("expiresAt");

-- CreateIndex
CREATE INDEX "OperatorIdentity_providerEmail_idx" ON "public"."OperatorIdentity"("providerEmail");

-- CreateIndex
CREATE UNIQUE INDEX "OperatorIdentity_provider_subject_key" ON "public"."OperatorIdentity"("provider", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "OperatorIdentity_userId_provider_key" ON "public"."OperatorIdentity"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "MagicLinkToken_tokenHash_key" ON "public"."MagicLinkToken"("tokenHash");

-- CreateIndex
CREATE INDEX "MagicLinkToken_email_expiresAt_idx" ON "public"."MagicLinkToken"("email", "expiresAt");

-- CreateIndex
CREATE INDEX "MagicLinkToken_expiresAt_idx" ON "public"."MagicLinkToken"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "OperatorMfaTotp_userId_key" ON "public"."OperatorMfaTotp"("userId");

-- CreateIndex
CREATE INDEX "OperatorMfaRecoveryCode_userId_consumedAt_idx" ON "public"."OperatorMfaRecoveryCode"("userId", "consumedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OperatorMfaRecoveryCode_userId_codeHash_key" ON "public"."OperatorMfaRecoveryCode"("userId", "codeHash");

-- CreateIndex
CREATE INDEX "AuthRateLimitBucket_expiresAt_idx" ON "public"."AuthRateLimitBucket"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "AuthRateLimitBucket_action_identifierHash_windowStart_key" ON "public"."AuthRateLimitBucket"("action", "identifierHash", "windowStart");

-- CreateIndex
CREATE INDEX "ImpersonationAudit_actorUserId_createdAt_idx" ON "public"."ImpersonationAudit"("actorUserId", "createdAt");

-- CreateIndex
CREATE INDEX "ImpersonationAudit_targetUserId_createdAt_idx" ON "public"."ImpersonationAudit"("targetUserId", "createdAt");

-- CreateIndex
CREATE INDEX "ImpersonationAudit_impersonationSessionId_createdAt_idx" ON "public"."ImpersonationAudit"("impersonationSessionId", "createdAt");

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
CREATE INDEX "OrganizationInvitation_acceptedByUserId_idx" ON "public"."OrganizationInvitation"("acceptedByUserId");

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

-- CreateIndex
CREATE INDEX "Agent_projectId_isActive_idx" ON "public"."Agent"("projectId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_projectId_slug_key" ON "public"."Agent"("projectId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "AgentCluster_environmentId_slug_key" ON "public"."AgentCluster"("environmentId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "AgentVersion_agentId_versionNumber_key" ON "public"."AgentVersion"("agentId", "versionNumber");

-- CreateIndex
CREATE INDEX "AgentBinding_activeAgentVersionId_idx" ON "public"."AgentBinding"("activeAgentVersionId");

-- CreateIndex
CREATE INDEX "AgentBinding_canaryAgentVersionId_idx" ON "public"."AgentBinding"("canaryAgentVersionId");

-- CreateIndex
CREATE INDEX "AgentBinding_clusterId_idx" ON "public"."AgentBinding"("clusterId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentBinding_environmentId_agentId_key" ON "public"."AgentBinding"("environmentId", "agentId");

-- CreateIndex
CREATE INDEX "Credential_environmentId_kind_revokedAt_idx" ON "public"."Credential"("environmentId", "kind", "revokedAt");

-- CreateIndex
CREATE INDEX "Credential_activeSecretVersionId_idx" ON "public"."Credential"("activeSecretVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "Credential_id_environmentId_key" ON "public"."Credential"("id", "environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Credential_activeSecretVersionId_id_key" ON "public"."Credential"("activeSecretVersionId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Credential_environmentId_kind_name_key" ON "public"."Credential"("environmentId", "kind", "name");

-- CreateIndex
CREATE INDEX "CredentialSecretVersion_credentialId_retiredAt_idx" ON "public"."CredentialSecretVersion"("credentialId", "retiredAt");

-- CreateIndex
CREATE INDEX "CredentialSecretVersion_rootKeyVersion_idx" ON "public"."CredentialSecretVersion"("rootKeyVersion");

-- CreateIndex
CREATE UNIQUE INDEX "CredentialSecretVersion_id_credentialId_key" ON "public"."CredentialSecretVersion"("id", "credentialId");

-- CreateIndex
CREATE UNIQUE INDEX "CredentialSecretVersion_credentialId_secretRevision_rootKey_key" ON "public"."CredentialSecretVersion"("credentialId", "secretRevision", "rootKeyVersion");

-- CreateIndex
CREATE INDEX "CredentialAudit_environmentId_createdAt_idx" ON "public"."CredentialAudit"("environmentId", "createdAt");

-- CreateIndex
CREATE INDEX "CredentialAudit_credentialId_createdAt_idx" ON "public"."CredentialAudit"("credentialId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccessKey_keyHash_key" ON "public"."AccessKey"("keyHash");

-- CreateIndex
CREATE INDEX "AccessKey_environmentId_revokedAt_validUntil_idx" ON "public"."AccessKey"("environmentId", "revokedAt", "validUntil");

-- CreateIndex
CREATE INDEX "AccessKey_replacedById_idx" ON "public"."AccessKey"("replacedById");

-- CreateIndex
CREATE INDEX "ProviderKey_environmentId_provider_isDefault_idx" ON "public"."ProviderKey"("environmentId", "provider", "isDefault");

-- CreateIndex
CREATE INDEX "ProviderKey_credentialId_idx" ON "public"."ProviderKey"("credentialId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderKey_environmentId_provider_label_key" ON "public"."ProviderKey"("environmentId", "provider", "label");

-- CreateIndex
CREATE UNIQUE INDEX "McpToken_tokenHash_key" ON "public"."McpToken"("tokenHash");

-- CreateIndex
CREATE INDEX "McpToken_environmentId_revokedAt_expiresAt_idx" ON "public"."McpToken"("environmentId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "McpToken_mintedByUserId_idx" ON "public"."McpToken"("mintedByUserId");

-- CreateIndex
CREATE UNIQUE INDEX "PersonalAccessToken_tokenHash_key" ON "public"."PersonalAccessToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PersonalAccessToken_userId_revokedAt_expiresAt_idx" ON "public"."PersonalAccessToken"("userId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "PersonalAccessToken_organizationId_idx" ON "public"."PersonalAccessToken"("organizationId");

-- CreateIndex
CREATE INDEX "PersonalAccessToken_projectId_idx" ON "public"."PersonalAccessToken"("projectId");

-- CreateIndex
CREATE INDEX "PersonalAccessToken_environmentId_idx" ON "public"."PersonalAccessToken"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAccessToken_tokenHash_key" ON "public"."OAuthAccessToken"("tokenHash");

-- CreateIndex
CREATE INDEX "OAuthAccessToken_clientId_userId_revokedAt_expiresAt_idx" ON "public"."OAuthAccessToken"("clientId", "userId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "OAuthAccessToken_organizationId_idx" ON "public"."OAuthAccessToken"("organizationId");

-- CreateIndex
CREATE INDEX "OAuthAccessToken_projectId_idx" ON "public"."OAuthAccessToken"("projectId");

-- CreateIndex
CREATE INDEX "OAuthAccessToken_environmentId_idx" ON "public"."OAuthAccessToken"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthRefreshToken_tokenHash_key" ON "public"."OAuthRefreshToken"("tokenHash");

-- CreateIndex
CREATE INDEX "OAuthRefreshToken_clientId_userId_rotationFamilyId_idx" ON "public"."OAuthRefreshToken"("clientId", "userId", "rotationFamilyId");

-- CreateIndex
CREATE INDEX "OAuthRefreshToken_accessTokenId_idx" ON "public"."OAuthRefreshToken"("accessTokenId");

-- CreateIndex
CREATE INDEX "OAuthRefreshToken_parentRefreshTokenId_idx" ON "public"."OAuthRefreshToken"("parentRefreshTokenId");

-- CreateIndex
CREATE INDEX "OAuthRefreshToken_organizationId_idx" ON "public"."OAuthRefreshToken"("organizationId");

-- CreateIndex
CREATE INDEX "OAuthRefreshToken_projectId_idx" ON "public"."OAuthRefreshToken"("projectId");

-- CreateIndex
CREATE INDEX "OAuthRefreshToken_environmentId_idx" ON "public"."OAuthRefreshToken"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "McpBearerToken_tokenHash_key" ON "public"."McpBearerToken"("tokenHash");

-- CreateIndex
CREATE INDEX "McpBearerToken_entityId_mcpUserId_revokedAt_expiresAt_idx" ON "public"."McpBearerToken"("entityId", "mcpUserId", "revokedAt", "expiresAt");

-- CreateIndex
CREATE INDEX "McpBearerToken_createdByUserId_idx" ON "public"."McpBearerToken"("createdByUserId");

-- CreateIndex
CREATE INDEX "PostmanTemplate_agentId_idx" ON "public"."PostmanTemplate"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "PostmanTemplate_environmentId_agentId_name_key" ON "public"."PostmanTemplate"("environmentId", "agentId", "name");

-- CreateIndex
CREATE INDEX "Thread_environmentId_endUserId_updatedAt_idx" ON "public"."Thread"("environmentId", "endUserId", "updatedAt");

-- CreateIndex
CREATE INDEX "Thread_agentId_status_idx" ON "public"."Thread"("agentId", "status");

-- CreateIndex
CREATE INDEX "Thread_clusterId_idx" ON "public"."Thread"("clusterId");

-- CreateIndex
CREATE INDEX "Thread_parentThreadId_idx" ON "public"."Thread"("parentThreadId");

-- CreateIndex
CREATE INDEX "Thread_compactionState_compactedAt_idx" ON "public"."Thread"("compactionState", "compactedAt");

-- CreateIndex
CREATE INDEX "Turn_parentTurnId_idx" ON "public"."Turn"("parentTurnId");

-- CreateIndex
CREATE INDEX "Turn_agentVersionId_versionBucket_idx" ON "public"."Turn"("agentVersionId", "versionBucket");

-- CreateIndex
CREATE INDEX "Turn_threadId_status_idx" ON "public"."Turn"("threadId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Turn_threadId_sequence_key" ON "public"."Turn"("threadId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "Step_turnId_sequence_key" ON "public"."Step"("turnId", "sequence");

-- CreateIndex
CREATE INDEX "ToolCall_toolId_idx" ON "public"."ToolCall"("toolId");

-- CreateIndex
CREATE UNIQUE INDEX "ToolCall_stepId_sequence_key" ON "public"."ToolCall"("stepId", "sequence");

-- CreateIndex
CREATE INDEX "Artifact_environmentId_createdAt_idx" ON "public"."Artifact"("environmentId", "createdAt");

-- CreateIndex
CREATE INDEX "Artifact_producedByTurnId_idx" ON "public"."Artifact"("producedByTurnId");

-- CreateIndex
CREATE UNIQUE INDEX "Artifact_threadId_artifactKey_revision_key" ON "public"."Artifact"("threadId", "artifactKey", "revision");

-- CreateIndex
CREATE INDEX "MessageAttachment_environmentId_endUserId_createdAt_idx" ON "public"."MessageAttachment"("environmentId", "endUserId", "createdAt");

-- CreateIndex
CREATE INDEX "MessageAttachment_turnId_idx" ON "public"."MessageAttachment"("turnId");

-- CreateIndex
CREATE UNIQUE INDEX "Entity_projectId_externalId_key" ON "public"."Entity"("projectId", "externalId");

-- CreateIndex
CREATE INDEX "ChannelConnection_environmentId_enabled_idx" ON "public"."ChannelConnection"("environmentId", "enabled");

-- CreateIndex
CREATE INDEX "ChannelConnection_entityId_idx" ON "public"."ChannelConnection"("entityId");

-- CreateIndex
CREATE INDEX "ChannelThread_threadId_idx" ON "public"."ChannelThread"("threadId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelThread_connectionId_channelThreadKey_key" ON "public"."ChannelThread"("connectionId", "channelThreadKey");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelApp_environmentId_provider_clientId_key" ON "public"."ChannelApp"("environmentId", "provider", "clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelInstallation_appId_externalInstallationId_key" ON "public"."ChannelInstallation"("appId", "externalInstallationId");

-- CreateIndex
CREATE INDEX "ChannelAppThread_threadId_idx" ON "public"."ChannelAppThread"("threadId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelAppThread_installationId_channelThreadKey_key" ON "public"."ChannelAppThread"("installationId", "channelThreadKey");

-- CreateIndex
CREATE INDEX "Tool_kind_name_idx" ON "public"."Tool"("kind", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Tool_name_schemaHash_key" ON "public"."Tool"("name", "schemaHash");

-- CreateIndex
CREATE INDEX "EnvironmentEntityTool_toolId_idx" ON "public"."EnvironmentEntityTool"("toolId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvironmentEntityTool_environmentId_entityId_toolId_key" ON "public"."EnvironmentEntityTool"("environmentId", "entityId", "toolId");

-- CreateIndex
CREATE UNIQUE INDEX "ToolHealth_environmentId_toolId_entityExternalId_key" ON "public"."ToolHealth"("environmentId", "toolId", "entityExternalId");

-- CreateIndex
CREATE INDEX "ToolCallAudit_environmentId_createdAt_idx" ON "public"."ToolCallAudit"("environmentId", "createdAt");

-- CreateIndex
CREATE INDEX "ToolCallAudit_endUserId_createdAt_idx" ON "public"."ToolCallAudit"("endUserId", "createdAt");

-- CreateIndex
CREATE INDEX "ToolCallAudit_toolId_idx" ON "public"."ToolCallAudit"("toolId");

-- CreateIndex
CREATE INDEX "AdminAudit_environmentId_createdAt_idx" ON "public"."AdminAudit"("environmentId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentApproval_environmentId_status_createdAt_idx" ON "public"."AgentApproval"("environmentId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AgentApproval_threadId_idx" ON "public"."AgentApproval"("threadId");

-- CreateIndex
CREATE INDEX "AgentApproval_turnId_idx" ON "public"."AgentApproval"("turnId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvironmentProvider_environmentId_providerId_key" ON "public"."EnvironmentProvider"("environmentId", "providerId");

-- CreateIndex
CREATE INDEX "Budget_environmentId_enabled_idx" ON "public"."Budget"("environmentId", "enabled");

-- CreateIndex
CREATE INDEX "Budget_agentId_idx" ON "public"."Budget"("agentId");

-- CreateIndex
CREATE INDEX "SafetyEvent_environmentId_createdAt_idx" ON "public"."SafetyEvent"("environmentId", "createdAt");

-- CreateIndex
CREATE INDEX "SafetyEvent_endUserId_idx" ON "public"."SafetyEvent"("endUserId");

-- CreateIndex
CREATE INDEX "MessageRating_environmentId_createdAt_idx" ON "public"."MessageRating"("environmentId", "createdAt");

-- CreateIndex
CREATE INDEX "MessageRating_agentId_idx" ON "public"."MessageRating"("agentId");

-- CreateIndex
CREATE INDEX "MessageRating_agentVersionId_idx" ON "public"."MessageRating"("agentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageRating_turnId_endUserId_key" ON "public"."MessageRating"("turnId", "endUserId");

-- CreateIndex
CREATE INDEX "EvalCriterion_agentId_idx" ON "public"."EvalCriterion"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "EvalCriterion_environmentId_name_key" ON "public"."EvalCriterion"("environmentId", "name");

-- CreateIndex
CREATE INDEX "AgentEval_environmentId_createdAt_idx" ON "public"."AgentEval"("environmentId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentEval_agentId_agentVersionId_idx" ON "public"."AgentEval"("agentId", "agentVersionId");

-- CreateIndex
CREATE INDEX "AgentEval_threadId_idx" ON "public"."AgentEval"("threadId");

-- CreateIndex
CREATE INDEX "AgentEval_turnId_idx" ON "public"."AgentEval"("turnId");

-- CreateIndex
CREATE INDEX "AgentEval_criterionId_idx" ON "public"."AgentEval"("criterionId");

-- CreateIndex
CREATE UNIQUE INDEX "GoldenSet_environmentId_agentId_name_key" ON "public"."GoldenSet"("environmentId", "agentId", "name");

-- CreateIndex
CREATE INDEX "Job_environmentId_status_idx" ON "public"."Job"("environmentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Job_environmentId_externalId_key" ON "public"."Job"("environmentId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Skill_organizationId_slug_version_key" ON "public"."Skill"("organizationId", "slug", "version");

-- CreateIndex
CREATE INDEX "ProjectSkill_skillId_idx" ON "public"."ProjectSkill"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectSkill_projectId_skillId_key" ON "public"."ProjectSkill"("projectId", "skillId");

-- CreateIndex
CREATE INDEX "EnvironmentSkill_projectSkillId_idx" ON "public"."EnvironmentSkill"("projectSkillId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvironmentSkill_environmentId_projectSkillId_key" ON "public"."EnvironmentSkill"("environmentId", "projectSkillId");

-- CreateIndex
CREATE INDEX "AgentSkill_environmentSkillId_idx" ON "public"."AgentSkill"("environmentSkillId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSkill_agentVersionId_environmentSkillId_key" ON "public"."AgentSkill"("agentVersionId", "environmentSkillId");

-- CreateIndex
CREATE INDEX "AgentToolPolicy_toolId_idx" ON "public"."AgentToolPolicy"("toolId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentToolPolicy_agentVersionId_toolId_key" ON "public"."AgentToolPolicy"("agentVersionId", "toolId");

-- CreateIndex
CREATE INDEX "Memory_environmentId_endUserId_archivedAt_idx" ON "public"."Memory"("environmentId", "endUserId", "archivedAt");

-- CreateIndex
CREATE INDEX "Memory_environmentId_endUserId_agentId_archivedAt_idx" ON "public"."Memory"("environmentId", "endUserId", "agentId", "archivedAt");

-- CreateIndex
CREATE INDEX "Memory_environmentId_endUserId_clusterId_archivedAt_idx" ON "public"."Memory"("environmentId", "endUserId", "clusterId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Memory_environmentId_endUserId_sourceThreadId_contentHash_key" ON "public"."Memory"("environmentId", "endUserId", "sourceThreadId", "contentHash");

-- CreateIndex
CREATE INDEX "MemoryEntity_environmentId_endUserId_clusterId_idx" ON "public"."MemoryEntity"("environmentId", "endUserId", "clusterId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryEntity_environmentId_endUserId_agentId_entityKey_key" ON "public"."MemoryEntity"("environmentId", "endUserId", "agentId", "entityKey");

-- CreateIndex
CREATE INDEX "MemoryRelationship_environmentId_endUserId_agentId_idx" ON "public"."MemoryRelationship"("environmentId", "endUserId", "agentId");

-- CreateIndex
CREATE INDEX "MemoryRelationship_environmentId_endUserId_clusterId_idx" ON "public"."MemoryRelationship"("environmentId", "endUserId", "clusterId");

-- CreateIndex
CREATE INDEX "MemoryRelationship_toEntityId_idx" ON "public"."MemoryRelationship"("toEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "MemoryRelationship_fromEntityId_toEntityId_relationshipType_key" ON "public"."MemoryRelationship"("fromEntityId", "toEntityId", "relationshipType");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMcpPolicy_organizationId_pattern_key" ON "public"."OrganizationMcpPolicy"("organizationId", "pattern");

-- CreateIndex
CREATE UNIQUE INDEX "Macro_environmentId_name_key" ON "public"."Macro"("environmentId", "name");

-- CreateIndex
CREATE INDEX "Event_environmentId_eventType_createdAt_idx" ON "public"."Event"("environmentId", "eventType", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationRule_environmentId_name_key" ON "public"."NotificationRule"("environmentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthClient_clientId_key" ON "public"."OAuthClient"("clientId");

-- CreateIndex
CREATE INDEX "OAuthClient_organizationId_deletedAt_idx" ON "public"."OAuthClient"("organizationId", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAuthorizationCode_codeHash_key" ON "public"."OAuthAuthorizationCode"("codeHash");

-- CreateIndex
CREATE INDEX "OAuthAuthorizationCode_organizationId_expiresAt_idx" ON "public"."OAuthAuthorizationCode"("organizationId", "expiresAt");

-- CreateIndex
CREATE INDEX "OAuthAuthorizationCode_projectId_expiresAt_idx" ON "public"."OAuthAuthorizationCode"("projectId", "expiresAt");

-- CreateIndex
CREATE INDEX "OAuthAuthorizationCode_environmentId_expiresAt_idx" ON "public"."OAuthAuthorizationCode"("environmentId", "expiresAt");

-- CreateIndex
CREATE INDEX "OAuthAuthorizationCode_clientId_idx" ON "public"."OAuthAuthorizationCode"("clientId");

-- CreateIndex
CREATE INDEX "OAuthAuthorizationCode_userId_idx" ON "public"."OAuthAuthorizationCode"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "McpAnonymousSession_environmentId_entityId_mcpUserId_key" ON "public"."McpAnonymousSession"("environmentId", "entityId", "mcpUserId");

-- CreateIndex
CREATE UNIQUE INDEX "McpOidcSession_environmentId_entityId_provider_externalSubj_key" ON "public"."McpOidcSession"("environmentId", "entityId", "provider", "externalSubject");

-- CreateIndex
CREATE INDEX "EntityToolPolicy_toolId_idx" ON "public"."EntityToolPolicy"("toolId");

-- CreateIndex
CREATE UNIQUE INDEX "EntityToolPolicy_entityId_toolId_key" ON "public"."EntityToolPolicy"("entityId", "toolId");

-- CreateIndex
CREATE INDEX "ErasureOperation_organizationId_subjectKeyHash_requestedAt_idx" ON "public"."ErasureOperation"("organizationId", "subjectKeyHash", "requestedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ErasureOperation_organizationId_idempotencyKey_key" ON "public"."ErasureOperation"("organizationId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "public"."OperatorSession" ADD CONSTRAINT "OperatorSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OperatorSession" ADD CONSTRAINT "OperatorSession_impersonatedUserId_fkey" FOREIGN KEY ("impersonatedUserId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OperatorSession" ADD CONSTRAINT "OperatorSession_parentSessionId_fkey" FOREIGN KEY ("parentSessionId") REFERENCES "public"."OperatorSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OperatorIdentity" ADD CONSTRAINT "OperatorIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OperatorMfaTotp" ADD CONSTRAINT "OperatorMfaTotp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OperatorMfaRecoveryCode" ADD CONSTRAINT "OperatorMfaRecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ImpersonationAudit" ADD CONSTRAINT "ImpersonationAudit_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ImpersonationAudit" ADD CONSTRAINT "ImpersonationAudit_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ImpersonationAudit" ADD CONSTRAINT "ImpersonationAudit_impersonationSessionId_fkey" FOREIGN KEY ("impersonationSessionId") REFERENCES "public"."OperatorSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_acceptedByUserId_fkey" FOREIGN KEY ("acceptedByUserId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "public"."Agent" ADD CONSTRAINT "Agent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentCluster" ADD CONSTRAINT "AgentCluster_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentVersion" ADD CONSTRAINT "AgentVersion_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentBinding" ADD CONSTRAINT "AgentBinding_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentBinding" ADD CONSTRAINT "AgentBinding_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentBinding" ADD CONSTRAINT "AgentBinding_activeAgentVersionId_fkey" FOREIGN KEY ("activeAgentVersionId") REFERENCES "public"."AgentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentBinding" ADD CONSTRAINT "AgentBinding_canaryAgentVersionId_fkey" FOREIGN KEY ("canaryAgentVersionId") REFERENCES "public"."AgentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentBinding" ADD CONSTRAINT "AgentBinding_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "public"."AgentCluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Credential" ADD CONSTRAINT "Credential_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Credential" ADD CONSTRAINT "Credential_activeSecretVersionId_id_fkey" FOREIGN KEY ("activeSecretVersionId", "id") REFERENCES "public"."CredentialSecretVersion"("id", "credentialId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CredentialSecretVersion" ADD CONSTRAINT "CredentialSecretVersion_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "public"."Credential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CredentialAudit" ADD CONSTRAINT "CredentialAudit_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CredentialAudit" ADD CONSTRAINT "CredentialAudit_credentialId_environmentId_fkey" FOREIGN KEY ("credentialId", "environmentId") REFERENCES "public"."Credential"("id", "environmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AccessKey" ADD CONSTRAINT "AccessKey_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AccessKey" ADD CONSTRAINT "AccessKey_replacedById_fkey" FOREIGN KEY ("replacedById") REFERENCES "public"."AccessKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProviderKey" ADD CONSTRAINT "ProviderKey_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProviderKey" ADD CONSTRAINT "ProviderKey_credentialId_environmentId_fkey" FOREIGN KEY ("credentialId", "environmentId") REFERENCES "public"."Credential"("id", "environmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."McpToken" ADD CONSTRAINT "McpToken_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."McpToken" ADD CONSTRAINT "McpToken_mintedByUserId_fkey" FOREIGN KEY ("mintedByUserId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PersonalAccessToken" ADD CONSTRAINT "PersonalAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PersonalAccessToken" ADD CONSTRAINT "PersonalAccessToken_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PersonalAccessToken" ADD CONSTRAINT "PersonalAccessToken_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PersonalAccessToken" ADD CONSTRAINT "PersonalAccessToken_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OAuthAccessToken" ADD CONSTRAINT "OAuthAccessToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "public"."OAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OAuthAccessToken" ADD CONSTRAINT "OAuthAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OAuthAccessToken" ADD CONSTRAINT "OAuthAccessToken_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OAuthAccessToken" ADD CONSTRAINT "OAuthAccessToken_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OAuthAccessToken" ADD CONSTRAINT "OAuthAccessToken_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OAuthRefreshToken" ADD CONSTRAINT "OAuthRefreshToken_accessTokenId_fkey" FOREIGN KEY ("accessTokenId") REFERENCES "public"."OAuthAccessToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OAuthRefreshToken" ADD CONSTRAINT "OAuthRefreshToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "public"."OAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OAuthRefreshToken" ADD CONSTRAINT "OAuthRefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OAuthRefreshToken" ADD CONSTRAINT "OAuthRefreshToken_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OAuthRefreshToken" ADD CONSTRAINT "OAuthRefreshToken_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OAuthRefreshToken" ADD CONSTRAINT "OAuthRefreshToken_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OAuthRefreshToken" ADD CONSTRAINT "OAuthRefreshToken_parentRefreshTokenId_fkey" FOREIGN KEY ("parentRefreshTokenId") REFERENCES "public"."OAuthRefreshToken"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."McpBearerToken" ADD CONSTRAINT "McpBearerToken_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "public"."Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."McpBearerToken" ADD CONSTRAINT "McpBearerToken_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PostmanTemplate" ADD CONSTRAINT "PostmanTemplate_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PostmanTemplate" ADD CONSTRAINT "PostmanTemplate_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Thread" ADD CONSTRAINT "Thread_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Thread" ADD CONSTRAINT "Thread_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Thread" ADD CONSTRAINT "Thread_endUserId_fkey" FOREIGN KEY ("endUserId") REFERENCES "public"."EndUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Thread" ADD CONSTRAINT "Thread_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "public"."AgentCluster"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Thread" ADD CONSTRAINT "Thread_parentThreadId_fkey" FOREIGN KEY ("parentThreadId") REFERENCES "public"."Thread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Thread" ADD CONSTRAINT "Thread_compactedUpToTurnId_fkey" FOREIGN KEY ("compactedUpToTurnId") REFERENCES "public"."Turn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Turn" ADD CONSTRAINT "Turn_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Turn" ADD CONSTRAINT "Turn_parentTurnId_fkey" FOREIGN KEY ("parentTurnId") REFERENCES "public"."Turn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Turn" ADD CONSTRAINT "Turn_agentVersionId_fkey" FOREIGN KEY ("agentVersionId") REFERENCES "public"."AgentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Step" ADD CONSTRAINT "Step_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "public"."Turn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ToolCall" ADD CONSTRAINT "ToolCall_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "public"."Step"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ToolCall" ADD CONSTRAINT "ToolCall_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "public"."Tool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Artifact" ADD CONSTRAINT "Artifact_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Artifact" ADD CONSTRAINT "Artifact_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Artifact" ADD CONSTRAINT "Artifact_producedByTurnId_fkey" FOREIGN KEY ("producedByTurnId") REFERENCES "public"."Turn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MessageAttachment" ADD CONSTRAINT "MessageAttachment_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MessageAttachment" ADD CONSTRAINT "MessageAttachment_endUserId_fkey" FOREIGN KEY ("endUserId") REFERENCES "public"."EndUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MessageAttachment" ADD CONSTRAINT "MessageAttachment_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "public"."Turn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Entity" ADD CONSTRAINT "Entity_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChannelConnection" ADD CONSTRAINT "ChannelConnection_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChannelConnection" ADD CONSTRAINT "ChannelConnection_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "public"."Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChannelConnection" ADD CONSTRAINT "ChannelConnection_defaultAgentId_fkey" FOREIGN KEY ("defaultAgentId") REFERENCES "public"."Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChannelConnection" ADD CONSTRAINT "ChannelConnection_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "public"."Credential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChannelThread" ADD CONSTRAINT "ChannelThread_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "public"."ChannelConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChannelThread" ADD CONSTRAINT "ChannelThread_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChannelApp" ADD CONSTRAINT "ChannelApp_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChannelApp" ADD CONSTRAINT "ChannelApp_defaultAgentId_fkey" FOREIGN KEY ("defaultAgentId") REFERENCES "public"."Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChannelApp" ADD CONSTRAINT "ChannelApp_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "public"."Credential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChannelInstallation" ADD CONSTRAINT "ChannelInstallation_appId_fkey" FOREIGN KEY ("appId") REFERENCES "public"."ChannelApp"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChannelInstallation" ADD CONSTRAINT "ChannelInstallation_defaultAgentId_fkey" FOREIGN KEY ("defaultAgentId") REFERENCES "public"."Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChannelInstallation" ADD CONSTRAINT "ChannelInstallation_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "public"."Credential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChannelAppThread" ADD CONSTRAINT "ChannelAppThread_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "public"."ChannelInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ChannelAppThread" ADD CONSTRAINT "ChannelAppThread_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EntityMcpConfig" ADD CONSTRAINT "EntityMcpConfig_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "public"."Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EntityMcpClient" ADD CONSTRAINT "EntityMcpClient_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "public"."Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EntityMcpClient" ADD CONSTRAINT "EntityMcpClient_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "public"."Credential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EnvironmentEntityTool" ADD CONSTRAINT "EnvironmentEntityTool_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EnvironmentEntityTool" ADD CONSTRAINT "EnvironmentEntityTool_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "public"."Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EnvironmentEntityTool" ADD CONSTRAINT "EnvironmentEntityTool_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "public"."Tool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ToolHealth" ADD CONSTRAINT "ToolHealth_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ToolHealth" ADD CONSTRAINT "ToolHealth_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "public"."Tool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ToolCallAudit" ADD CONSTRAINT "ToolCallAudit_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ToolCallAudit" ADD CONSTRAINT "ToolCallAudit_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "public"."Tool"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ToolCallAudit" ADD CONSTRAINT "ToolCallAudit_endUserId_fkey" FOREIGN KEY ("endUserId") REFERENCES "public"."EndUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ToolCallAudit" ADD CONSTRAINT "ToolCallAudit_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ToolCallAudit" ADD CONSTRAINT "ToolCallAudit_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."Thread"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AdminAudit" ADD CONSTRAINT "AdminAudit_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentApproval" ADD CONSTRAINT "AgentApproval_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentApproval" ADD CONSTRAINT "AgentApproval_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentApproval" ADD CONSTRAINT "AgentApproval_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentApproval" ADD CONSTRAINT "AgentApproval_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "public"."Turn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EnvironmentProvider" ADD CONSTRAINT "EnvironmentProvider_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Budget" ADD CONSTRAINT "Budget_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Budget" ADD CONSTRAINT "Budget_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SafetyEvent" ADD CONSTRAINT "SafetyEvent_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SafetyEvent" ADD CONSTRAINT "SafetyEvent_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SafetyEvent" ADD CONSTRAINT "SafetyEvent_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SafetyEvent" ADD CONSTRAINT "SafetyEvent_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "public"."Turn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."SafetyEvent" ADD CONSTRAINT "SafetyEvent_endUserId_fkey" FOREIGN KEY ("endUserId") REFERENCES "public"."EndUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MessageRating" ADD CONSTRAINT "MessageRating_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MessageRating" ADD CONSTRAINT "MessageRating_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "public"."Turn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MessageRating" ADD CONSTRAINT "MessageRating_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MessageRating" ADD CONSTRAINT "MessageRating_agentVersionId_fkey" FOREIGN KEY ("agentVersionId") REFERENCES "public"."AgentVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MessageRating" ADD CONSTRAINT "MessageRating_endUserId_fkey" FOREIGN KEY ("endUserId") REFERENCES "public"."EndUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EvalCriterion" ADD CONSTRAINT "EvalCriterion_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EvalCriterion" ADD CONSTRAINT "EvalCriterion_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentEval" ADD CONSTRAINT "AgentEval_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentEval" ADD CONSTRAINT "AgentEval_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentEval" ADD CONSTRAINT "AgentEval_agentVersionId_fkey" FOREIGN KEY ("agentVersionId") REFERENCES "public"."AgentVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentEval" ADD CONSTRAINT "AgentEval_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentEval" ADD CONSTRAINT "AgentEval_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "public"."Turn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentEval" ADD CONSTRAINT "AgentEval_criterionId_fkey" FOREIGN KEY ("criterionId") REFERENCES "public"."EvalCriterion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GoldenSet" ADD CONSTRAINT "GoldenSet_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."GoldenSet" ADD CONSTRAINT "GoldenSet_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Job" ADD CONSTRAINT "Job_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Skill" ADD CONSTRAINT "Skill_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProjectSkill" ADD CONSTRAINT "ProjectSkill_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProjectSkill" ADD CONSTRAINT "ProjectSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "public"."Skill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EnvironmentSkill" ADD CONSTRAINT "EnvironmentSkill_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EnvironmentSkill" ADD CONSTRAINT "EnvironmentSkill_projectSkillId_fkey" FOREIGN KEY ("projectSkillId") REFERENCES "public"."ProjectSkill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentSkill" ADD CONSTRAINT "AgentSkill_agentVersionId_fkey" FOREIGN KEY ("agentVersionId") REFERENCES "public"."AgentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentSkill" ADD CONSTRAINT "AgentSkill_environmentSkillId_fkey" FOREIGN KEY ("environmentSkillId") REFERENCES "public"."EnvironmentSkill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentToolPolicy" ADD CONSTRAINT "AgentToolPolicy_agentVersionId_fkey" FOREIGN KEY ("agentVersionId") REFERENCES "public"."AgentVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AgentToolPolicy" ADD CONSTRAINT "AgentToolPolicy_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "public"."Tool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Memory" ADD CONSTRAINT "Memory_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Memory" ADD CONSTRAINT "Memory_endUserId_fkey" FOREIGN KEY ("endUserId") REFERENCES "public"."EndUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Memory" ADD CONSTRAINT "Memory_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Memory" ADD CONSTRAINT "Memory_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "public"."AgentCluster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Memory" ADD CONSTRAINT "Memory_sourceThreadId_fkey" FOREIGN KEY ("sourceThreadId") REFERENCES "public"."Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MemoryEntity" ADD CONSTRAINT "MemoryEntity_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MemoryEntity" ADD CONSTRAINT "MemoryEntity_endUserId_fkey" FOREIGN KEY ("endUserId") REFERENCES "public"."EndUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MemoryEntity" ADD CONSTRAINT "MemoryEntity_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MemoryEntity" ADD CONSTRAINT "MemoryEntity_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "public"."AgentCluster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MemoryRelationship" ADD CONSTRAINT "MemoryRelationship_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MemoryRelationship" ADD CONSTRAINT "MemoryRelationship_endUserId_fkey" FOREIGN KEY ("endUserId") REFERENCES "public"."EndUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MemoryRelationship" ADD CONSTRAINT "MemoryRelationship_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "public"."Agent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MemoryRelationship" ADD CONSTRAINT "MemoryRelationship_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "public"."AgentCluster"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MemoryRelationship" ADD CONSTRAINT "MemoryRelationship_fromEntityId_fkey" FOREIGN KEY ("fromEntityId") REFERENCES "public"."MemoryEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MemoryRelationship" ADD CONSTRAINT "MemoryRelationship_toEntityId_fkey" FOREIGN KEY ("toEntityId") REFERENCES "public"."MemoryEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MemoryRelationship" ADD CONSTRAINT "MemoryRelationship_sourceMemoryId_fkey" FOREIGN KEY ("sourceMemoryId") REFERENCES "public"."Memory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationMcpPolicy" ADD CONSTRAINT "OrganizationMcpPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Macro" ADD CONSTRAINT "Macro_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."NotificationRule" ADD CONSTRAINT "NotificationRule_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OAuthClient" ADD CONSTRAINT "OAuthClient_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OAuthClient" ADD CONSTRAINT "OAuthClient_registeredByUserId_fkey" FOREIGN KEY ("registeredByUserId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OAuthClient" ADD CONSTRAINT "OAuthClient_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "public"."Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OAuthAuthorizationCode" ADD CONSTRAINT "OAuthAuthorizationCode_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OAuthAuthorizationCode" ADD CONSTRAINT "OAuthAuthorizationCode_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OAuthAuthorizationCode" ADD CONSTRAINT "OAuthAuthorizationCode_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OAuthAuthorizationCode" ADD CONSTRAINT "OAuthAuthorizationCode_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "public"."OAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OAuthAuthorizationCode" ADD CONSTRAINT "OAuthAuthorizationCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."McpAnonymousSession" ADD CONSTRAINT "McpAnonymousSession_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."McpAnonymousSession" ADD CONSTRAINT "McpAnonymousSession_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "public"."Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."McpOidcSession" ADD CONSTRAINT "McpOidcSession_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."Environment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."McpOidcSession" ADD CONSTRAINT "McpOidcSession_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "public"."Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."McpOidcSession" ADD CONSTRAINT "McpOidcSession_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "public"."Credential"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EntityToolPolicy" ADD CONSTRAINT "EntityToolPolicy_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "public"."Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EntityToolPolicy" ADD CONSTRAINT "EntityToolPolicy_toolId_fkey" FOREIGN KEY ("toolId") REFERENCES "public"."Tool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ErasureOperation" ADD CONSTRAINT "ErasureOperation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma-inexpressible value constraints.
ALTER TABLE "public"."OperatorSession"
  ADD CONSTRAINT "OperatorSession_tier_check" CHECK ("tier" = 'OPERATOR');
ALTER TABLE "public"."EnvironmentSession"
  ADD CONSTRAINT "EnvironmentSession_tier_check" CHECK ("tier" = 'OPERATOR');
ALTER TABLE "public"."EndUserSession"
  ADD CONSTRAINT "EndUserSession_tier_check" CHECK ("tier" = 'END_USER');
ALTER TABLE "public"."AgentBinding"
  ADD CONSTRAINT "AgentBinding_canaryPercent_check" CHECK ("canaryPercent" BETWEEN 0 AND 100);
ALTER TABLE "public"."MessageRating"
  ADD CONSTRAINT "MessageRating_rating_check" CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "public"."AgentVersion"
  ADD CONSTRAINT "AgentVersion_toolsBlockConfig_enabledTools_check"
  CHECK (NOT ("toolsBlockConfig" ? 'enabledTools'));
ALTER TABLE "public"."Turn"
  ADD CONSTRAINT "Turn_usage_check" CHECK (
    "sequence" > 0 AND
    ("costCents" IS NULL OR "costCents" >= 0) AND
    ("latencyMs" IS NULL OR "latencyMs" >= 0) AND
    ("startedAt" IS NULL OR "completedAt" IS NULL OR "completedAt" >= "startedAt")
  );
ALTER TABLE "public"."Step"
  ADD CONSTRAINT "Step_usage_check" CHECK (
    "sequence" > 0 AND "retryCount" >= 0 AND
    ("inputTokens" IS NULL OR "inputTokens" >= 0) AND
    ("outputTokens" IS NULL OR "outputTokens" >= 0) AND
    ("cacheCreationInputTokens" IS NULL OR "cacheCreationInputTokens" >= 0) AND
    ("cacheReadInputTokens" IS NULL OR "cacheReadInputTokens" >= 0) AND
    ("reasoningTokens" IS NULL OR "reasoningTokens" >= 0) AND
    ("inputTokens" IS NULL OR
      COALESCE("cacheCreationInputTokens", 0) + COALESCE("cacheReadInputTokens", 0) <= "inputTokens") AND
    ("costCents" IS NULL OR "costCents" >= 0) AND
    ("latencyMs" IS NULL OR "latencyMs" >= 0) AND
    ("startedAt" IS NULL OR "completedAt" IS NULL OR "completedAt" >= "startedAt")
  );
ALTER TABLE "public"."Memory"
  ADD CONSTRAINT "Memory_extraction_provenance_check" CHECK (
    (
      "sourceThreadId" IS NULL AND cardinality("sourceTurnIds") = 0 AND
      "extractorVersion" IS NULL AND "contentHash" IS NULL
    ) OR (
      "sourceThreadId" IS NOT NULL AND cardinality("sourceTurnIds") > 0 AND
      NULLIF(btrim("extractorVersion"), '') IS NOT NULL AND
      "contentHash" ~ '^[0-9a-f]{64}$'
    )
  );
ALTER TABLE "public"."Memory"
  ADD CONSTRAINT "Memory_confidence_check" CHECK (
    "confidence" IS NULL OR "confidence" BETWEEN 0 AND 1
  );

-- Prisma cannot express pgvector operator classes or partial ownership keys.
CREATE INDEX "Memory_embedding_hnsw_cosine_idx"
  ON "public"."Memory" USING hnsw ("embedding" vector_cosine_ops)
  WHERE "embedding" IS NOT NULL;
CREATE INDEX "MemoryEntity_embedding_hnsw_cosine_idx"
  ON "public"."MemoryEntity" USING hnsw ("embedding" vector_cosine_ops)
  WHERE "embedding" IS NOT NULL;
CREATE UNIQUE INDEX "MemoryEntity_shared_cluster_entityKey_key"
  ON "public"."MemoryEntity"("environmentId", "endUserId", "clusterId", "entityKey")
  WHERE "clusterId" IS NOT NULL;
CREATE UNIQUE INDEX "ProviderKey_one_default_per_environment_provider"
  ON "public"."ProviderKey"("environmentId", "provider")
  WHERE "isDefault" = TRUE;

-- Json columns store their native documented root. This blocks encoded strings
-- even when a caller bypasses the TypeScript write-boundary helpers.
ALTER TABLE "public"."EndUserIdentity" ADD CONSTRAINT "EndUserIdentity_profile_json_root" CHECK ("profile" IS NULL OR jsonb_typeof("profile") = 'object');
ALTER TABLE "public"."AgentCluster" ADD CONSTRAINT "AgentCluster_metadata_json_root" CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object');
ALTER TABLE "public"."AgentVersion" ADD CONSTRAINT "AgentVersion_promptBlocks_json_root" CHECK (jsonb_typeof("promptBlocks") = 'array');
ALTER TABLE "public"."AgentVersion" ADD CONSTRAINT "AgentVersion_dynamicBlocks_json_root" CHECK (jsonb_typeof("dynamicBlocks") = 'array');
ALTER TABLE "public"."AgentVersion" ADD CONSTRAINT "AgentVersion_toolsBlockConfig_json_root" CHECK (jsonb_typeof("toolsBlockConfig") = 'object');
ALTER TABLE "public"."AgentVersion" ADD CONSTRAINT "AgentVersion_modelRoutes_json_root" CHECK (jsonb_typeof("modelRoutes") = 'array');
ALTER TABLE "public"."AgentVersion" ADD CONSTRAINT "AgentVersion_memoryConfig_json_root" CHECK (jsonb_typeof("memoryConfig") = 'object');
ALTER TABLE "public"."AgentVersion" ADD CONSTRAINT "AgentVersion_outputSchema_json_root" CHECK ("outputSchema" IS NULL OR jsonb_typeof("outputSchema") = 'object');
ALTER TABLE "public"."PostmanTemplate" ADD CONSTRAINT "PostmanTemplate_sessionContext_json_root" CHECK ("sessionContext" IS NULL OR jsonb_typeof("sessionContext") = 'object');
ALTER TABLE "public"."Thread" ADD CONSTRAINT "Thread_sessionContext_json_root" CHECK ("sessionContext" IS NULL OR jsonb_typeof("sessionContext") = 'object');
ALTER TABLE "public"."Turn" ADD CONSTRAINT "Turn_input_json_root" CHECK ("input" IS NULL OR jsonb_typeof("input") = 'object');
ALTER TABLE "public"."Turn" ADD CONSTRAINT "Turn_output_json_root" CHECK ("output" IS NULL OR jsonb_typeof("output") = 'object');
ALTER TABLE "public"."ToolCall" ADD CONSTRAINT "ToolCall_arguments_json_root" CHECK (jsonb_typeof("arguments") = 'object');
ALTER TABLE "public"."ToolCall" ADD CONSTRAINT "ToolCall_result_json_root" CHECK ("result" IS NULL OR jsonb_typeof("result") IN ('object', 'array'));
ALTER TABLE "public"."Artifact" ADD CONSTRAINT "Artifact_metadata_json_root" CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object');
ALTER TABLE "public"."ChannelConnection" ADD CONSTRAINT "ChannelConnection_agentRouting_json_root" CHECK (jsonb_typeof("agentRouting") = 'array');
ALTER TABLE "public"."ChannelApp" ADD CONSTRAINT "ChannelApp_agentRouting_json_root" CHECK (jsonb_typeof("agentRouting") = 'array');
ALTER TABLE "public"."ChannelInstallation" ADD CONSTRAINT "ChannelInstallation_agentRouting_json_root" CHECK (jsonb_typeof("agentRouting") = 'array');
ALTER TABLE "public"."EntityMcpConfig" ADD CONSTRAINT "EntityMcpConfig_identityProviders_json_root" CHECK (jsonb_typeof("identityProviders") = 'array');
ALTER TABLE "public"."EntityMcpConfig" ADD CONSTRAINT "EntityMcpConfig_branding_json_root" CHECK (jsonb_typeof("branding") = 'object');
ALTER TABLE "public"."EntityMcpClient" ADD CONSTRAINT "EntityMcpClient_headersTemplate_json_root" CHECK (jsonb_typeof("headersTemplate") = 'object');
ALTER TABLE "public"."Tool" ADD CONSTRAINT "Tool_paramSchema_json_root" CHECK (jsonb_typeof("paramSchema") = 'object');
ALTER TABLE "public"."ToolCallAudit" ADD CONSTRAINT "ToolCallAudit_arguments_json_root" CHECK (jsonb_typeof("arguments") = 'object');
ALTER TABLE "public"."ToolCallAudit" ADD CONSTRAINT "ToolCallAudit_result_json_root" CHECK ("result" IS NULL OR jsonb_typeof("result") IN ('object', 'array'));
ALTER TABLE "public"."AdminAudit" ADD CONSTRAINT "AdminAudit_before_json_root" CHECK ("before" IS NULL OR jsonb_typeof("before") = 'object');
ALTER TABLE "public"."AdminAudit" ADD CONSTRAINT "AdminAudit_after_json_root" CHECK ("after" IS NULL OR jsonb_typeof("after") = 'object');
ALTER TABLE "public"."AgentApproval" ADD CONSTRAINT "AgentApproval_arguments_json_root" CHECK ("arguments" IS NULL OR jsonb_typeof("arguments") = 'object');
ALTER TABLE "public"."AgentApproval" ADD CONSTRAINT "AgentApproval_resolution_json_root" CHECK ("resolution" IS NULL OR jsonb_typeof("resolution") = 'object');
ALTER TABLE "public"."Budget" ADD CONSTRAINT "Budget_alertThresholds_json_root" CHECK (jsonb_typeof("alertThresholds") = 'array');
ALTER TABLE "public"."SafetyEvent" ADD CONSTRAINT "SafetyEvent_metadata_json_root" CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object');
ALTER TABLE "public"."AgentEval" ADD CONSTRAINT "AgentEval_criterionSnapshot_json_root" CHECK (jsonb_typeof("criterionSnapshot") = 'object');
ALTER TABLE "public"."Job" ADD CONSTRAINT "Job_payloadSchema_json_root" CHECK ("payloadSchema" IS NULL OR jsonb_typeof("payloadSchema") = 'object');
ALTER TABLE "public"."Skill" ADD CONSTRAINT "Skill_manifest_json_root" CHECK (jsonb_typeof("manifest") = 'object');
ALTER TABLE "public"."Skill" ADD CONSTRAINT "Skill_providesTools_json_root" CHECK (jsonb_typeof("providesTools") = 'array');
ALTER TABLE "public"."EnvironmentSkill" ADD CONSTRAINT "EnvironmentSkill_config_json_root" CHECK (jsonb_typeof("config") = 'object');
ALTER TABLE "public"."AgentSkill" ADD CONSTRAINT "AgentSkill_config_json_root" CHECK (jsonb_typeof("config") = 'object');
ALTER TABLE "public"."Memory" ADD CONSTRAINT "Memory_metadata_json_root" CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object');
ALTER TABLE "public"."MemoryEntity" ADD CONSTRAINT "MemoryEntity_metadata_json_root" CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object');
ALTER TABLE "public"."MemoryRelationship" ADD CONSTRAINT "MemoryRelationship_metadata_json_root" CHECK ("metadata" IS NULL OR jsonb_typeof("metadata") = 'object');
ALTER TABLE "public"."Macro" ADD CONSTRAINT "Macro_steps_json_root" CHECK (jsonb_typeof("steps") = 'array');
ALTER TABLE "public"."Macro" ADD CONSTRAINT "Macro_paramSchema_json_root" CHECK ("paramSchema" IS NULL OR jsonb_typeof("paramSchema") = 'object');
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_payload_json_root" CHECK (jsonb_typeof("payload") = 'object');
ALTER TABLE "public"."NotificationRule" ADD CONSTRAINT "NotificationRule_filters_json_root" CHECK (jsonb_typeof("filters") = 'object');
ALTER TABLE "public"."NotificationRule" ADD CONSTRAINT "NotificationRule_delivery_json_root" CHECK (jsonb_typeof("delivery") = 'object');
ALTER TABLE "public"."ErasureOperation" ADD CONSTRAINT "ErasureOperation_scopes_json_root" CHECK (jsonb_typeof("scopes") = 'array');
ALTER TABLE "public"."ErasureOperation" ADD CONSTRAINT "ErasureOperation_stores_json_root" CHECK (jsonb_typeof("stores") = 'array');
ALTER TABLE "public"."ErasureOperation" ADD CONSTRAINT "ErasureOperation_inventory_json_root" CHECK ("inventory" IS NULL OR jsonb_typeof("inventory") = 'object');

-- Canonical owner keys are immutable. Moving a record between isolation roots
-- would otherwise invalidate descendants without touching their rows.
CREATE FUNCTION "public"."reject_canonical_owner_change"()
RETURNS TRIGGER AS $$
DECLARE
  owner_key TEXT;
BEGIN
  FOREACH owner_key IN ARRAY TG_ARGV LOOP
    IF to_jsonb(OLD) -> owner_key IS DISTINCT FROM to_jsonb(NEW) -> owner_key THEN
      RAISE EXCEPTION '% ownership/authorization key % is immutable', TG_TABLE_NAME, owner_key
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Project_owner_immutable" BEFORE UPDATE ON "public"."Project" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('organizationId');
CREATE TRIGGER "Environment_owner_immutable" BEFORE UPDATE ON "public"."Environment" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('projectId');
CREATE TRIGGER "EndUser_owner_immutable" BEFORE UPDATE ON "public"."EndUser" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('organizationId');
CREATE TRIGGER "Agent_owner_immutable" BEFORE UPDATE ON "public"."Agent" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('projectId');
CREATE TRIGGER "AgentVersion_owner_immutable" BEFORE UPDATE ON "public"."AgentVersion" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('agentId');
CREATE TRIGGER "AgentCluster_owner_immutable" BEFORE UPDATE ON "public"."AgentCluster" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('environmentId');
CREATE TRIGGER "Credential_owner_immutable" BEFORE UPDATE ON "public"."Credential" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('environmentId', 'kind', 'name', 'provider');
CREATE TRIGGER "Thread_owner_immutable" BEFORE UPDATE ON "public"."Thread" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('environmentId');
CREATE TRIGGER "Turn_owner_immutable" BEFORE UPDATE ON "public"."Turn" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('threadId', 'agentVersionId', 'versionBucket');
CREATE TRIGGER "Step_owner_immutable" BEFORE UPDATE ON "public"."Step" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('turnId');
CREATE TRIGGER "Entity_owner_immutable" BEFORE UPDATE ON "public"."Entity" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('projectId');
CREATE TRIGGER "ChannelConnection_owner_immutable" BEFORE UPDATE ON "public"."ChannelConnection" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('environmentId');
CREATE TRIGGER "ChannelApp_owner_immutable" BEFORE UPDATE ON "public"."ChannelApp" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('environmentId');
CREATE TRIGGER "Skill_owner_immutable" BEFORE UPDATE ON "public"."Skill" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('organizationId');
CREATE TRIGGER "ProjectSkill_owner_immutable" BEFORE UPDATE ON "public"."ProjectSkill" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('projectId');
CREATE TRIGGER "EnvironmentSkill_owner_immutable" BEFORE UPDATE ON "public"."EnvironmentSkill" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('environmentId');
CREATE TRIGGER "Memory_owner_immutable" BEFORE UPDATE ON "public"."Memory" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('environmentId', 'endUserId', 'agentId', 'clusterId', 'sourceThreadId', 'extractorVersion');
CREATE TRIGGER "MemoryEntity_owner_immutable" BEFORE UPDATE ON "public"."MemoryEntity" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('environmentId', 'agentId', 'clusterId');
CREATE TRIGGER "MemoryRelationship_owner_immutable" BEFORE UPDATE ON "public"."MemoryRelationship" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('environmentId', 'endUserId', 'agentId', 'clusterId', 'fromEntityId', 'toEntityId');
CREATE TRIGGER "EndUserIdentity_owner_immutable" BEFORE UPDATE ON "public"."EndUserIdentity" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('endUserId', 'organizationId');
CREATE TRIGGER "Thread_subject_immutable" BEFORE UPDATE ON "public"."Thread" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('endUserId');
CREATE TRIGGER "MessageAttachment_owner_immutable" BEFORE UPDATE ON "public"."MessageAttachment" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('environmentId', 'endUserId');
CREATE TRIGGER "ChannelInstallation_owner_immutable" BEFORE UPDATE ON "public"."ChannelInstallation" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('appId');
CREATE TRIGGER "OAuthClient_owner_immutable" BEFORE UPDATE ON "public"."OAuthClient" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('organizationId');
CREATE TRIGGER "MemoryEntity_subject_immutable" BEFORE UPDATE ON "public"."MemoryEntity" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('endUserId');
CREATE TRIGGER "AccessKey_owner_immutable" BEFORE UPDATE ON "public"."AccessKey" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('environmentId');
CREATE TRIGGER "ProviderKey_owner_immutable" BEFORE UPDATE ON "public"."ProviderKey" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('environmentId');
CREATE TRIGGER "McpToken_owner_immutable" BEFORE UPDATE ON "public"."McpToken" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('environmentId', 'mintedByUserId');
CREATE TRIGGER "PersonalAccessToken_scope_immutable" BEFORE UPDATE ON "public"."PersonalAccessToken" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('userId', 'scopeKind', 'organizationId', 'projectId', 'environmentId');
CREATE TRIGGER "OAuthAuthorizationCode_scope_immutable" BEFORE UPDATE ON "public"."OAuthAuthorizationCode" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('clientId', 'userId', 'scopeKind', 'organizationId', 'projectId', 'environmentId');
CREATE TRIGGER "OAuthAccessToken_scope_immutable" BEFORE UPDATE ON "public"."OAuthAccessToken" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('clientId', 'userId', 'scopeKind', 'organizationId', 'projectId', 'environmentId');
CREATE TRIGGER "OAuthRefreshToken_scope_immutable" BEFORE UPDATE ON "public"."OAuthRefreshToken" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('clientId', 'userId', 'scopeKind', 'organizationId', 'projectId', 'environmentId', 'rotationFamilyId', 'parentRefreshTokenId');
CREATE TRIGGER "McpBearerToken_owner_immutable" BEFORE UPDATE ON "public"."McpBearerToken" FOR EACH ROW EXECUTE FUNCTION "public"."reject_canonical_owner_change"('entityId', 'createdByUserId');

-- A Redis thread lock may select any historical version of an Environment-bound
-- agent. All of those versions are therefore executable, including their
-- primary, request-selected, retry-fallback, and compaction routes. Inspect only
-- provider-key identifiers and model provider metadata; credential contents are
-- neither selected nor traversed.
CREATE FUNCTION "public"."reject_executable_provider_key_delete"()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "public"."Environment" environment
      JOIN "public"."Project" project ON project.id = environment."projectId"
      JOIN "public"."AgentBinding" binding ON binding."environmentId" = environment.id
      JOIN "public"."Agent" agent ON agent.id = binding."agentId" AND agent."projectId" = project.id
      JOIN "public"."AgentVersion" version ON version."agentId" = agent.id
     WHERE environment.id = OLD."environmentId"
       AND (
         (
           version."memoryConfig" #>> '{__runtime,providerKeyId}' = OLD.id::text
           AND split_part(version.model, ':', 1) = OLD.provider
         )
         OR EXISTS (
           SELECT 1
             FROM jsonb_array_elements(version."modelRoutes") route
            WHERE split_part(COALESCE(route ->> 'model', ''), ':', 1) = OLD.provider
              AND (
                route ->> 'providerCredentialId' = OLD.id::text
                OR route ->> 'providerKeyId' = OLD.id::text
              )
         )
       )
  ) THEN
    RAISE EXCEPTION 'ProviderKey is referenced by an executable AgentVersion'
      USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ProviderKey_executable_reference"
  BEFORE DELETE ON "public"."ProviderKey"
  FOR EACH ROW EXECUTE FUNCTION "public"."reject_executable_provider_key_delete"();

-- Typed authorization scope records use exactly one target at the selected
-- level. GLOBAL is valid only for operator PATs and has no tenant target.
ALTER TABLE "public"."PersonalAccessToken" ADD CONSTRAINT "PersonalAccessToken_scope_shape_check" CHECK (
  ("scopeKind" = 'GLOBAL' AND "organizationId" IS NULL AND "projectId" IS NULL AND "environmentId" IS NULL) OR
  ("scopeKind" = 'ORGANIZATION' AND "organizationId" IS NOT NULL AND "projectId" IS NULL AND "environmentId" IS NULL) OR
  ("scopeKind" = 'PROJECT' AND "organizationId" IS NULL AND "projectId" IS NOT NULL AND "environmentId" IS NULL) OR
  ("scopeKind" = 'ENVIRONMENT' AND "organizationId" IS NULL AND "projectId" IS NULL AND "environmentId" IS NOT NULL)
);
ALTER TABLE "public"."OAuthAuthorizationCode" ADD CONSTRAINT "OAuthAuthorizationCode_scope_shape_check" CHECK (
  "scopeKind" <> 'GLOBAL' AND (
    ("scopeKind" = 'ORGANIZATION' AND "organizationId" IS NOT NULL AND "projectId" IS NULL AND "environmentId" IS NULL) OR
    ("scopeKind" = 'PROJECT' AND "organizationId" IS NULL AND "projectId" IS NOT NULL AND "environmentId" IS NULL) OR
    ("scopeKind" = 'ENVIRONMENT' AND "organizationId" IS NULL AND "projectId" IS NULL AND "environmentId" IS NOT NULL)
  )
);
ALTER TABLE "public"."OAuthAccessToken" ADD CONSTRAINT "OAuthAccessToken_scope_shape_check" CHECK (
  "scopeKind" <> 'GLOBAL' AND (
    ("scopeKind" = 'ORGANIZATION' AND "organizationId" IS NOT NULL AND "projectId" IS NULL AND "environmentId" IS NULL) OR
    ("scopeKind" = 'PROJECT' AND "organizationId" IS NULL AND "projectId" IS NOT NULL AND "environmentId" IS NULL) OR
    ("scopeKind" = 'ENVIRONMENT' AND "organizationId" IS NULL AND "projectId" IS NULL AND "environmentId" IS NOT NULL)
  )
);
ALTER TABLE "public"."OAuthRefreshToken" ADD CONSTRAINT "OAuthRefreshToken_scope_shape_check" CHECK (
  "scopeKind" <> 'GLOBAL' AND (
    ("scopeKind" = 'ORGANIZATION' AND "organizationId" IS NOT NULL AND "projectId" IS NULL AND "environmentId" IS NULL) OR
    ("scopeKind" = 'PROJECT' AND "organizationId" IS NULL AND "projectId" IS NOT NULL AND "environmentId" IS NULL) OR
    ("scopeKind" = 'ENVIRONMENT' AND "organizationId" IS NULL AND "projectId" IS NULL AND "environmentId" IS NOT NULL)
  )
);

-- Cross-owner ancestry cannot be represented by Prisma relations without
-- copying organization/project scope tuples onto every record. Resolve each
-- canonical owner chain in the database instead.
CREATE FUNCTION "public"."enforce_domain_ancestry"()
RETURNS TRIGGER AS $$
DECLARE
  valid BOOLEAN := FALSE;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'EndUserSession' THEN
      SELECT EXISTS (
        SELECT 1 FROM "EndUserIdentity" i
        JOIN "EndUser" u ON u.id = i."endUserId" AND u."organizationId" = i."organizationId"
        JOIN "Environment" e ON e.id = NEW."environmentId"
        JOIN "Project" p ON p.id = e."projectId"
        WHERE i.id = NEW."identityId" AND u."organizationId" = p."organizationId"
      ) INTO valid;
    WHEN 'AgentBinding' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Environment" e
        JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = e."projectId"
        JOIN "AgentVersion" active ON active.id = NEW."activeAgentVersionId" AND active."agentId" = a.id
        LEFT JOIN "AgentVersion" canary ON canary.id = NEW."canaryAgentVersionId" AND canary."agentId" = a.id
        LEFT JOIN "AgentCluster" cluster ON cluster.id = NEW."clusterId" AND cluster."environmentId" = e.id
        WHERE e.id = NEW."environmentId"
          AND (NEW."canaryAgentVersionId" IS NULL OR canary.id IS NOT NULL)
          AND (NEW."clusterId" IS NULL OR cluster.id IS NOT NULL)
      ) INTO valid;
    WHEN 'PostmanTemplate' THEN
      SELECT EXISTS (SELECT 1 FROM "Environment" e JOIN "Agent" a ON a."projectId" = e."projectId" WHERE e.id = NEW."environmentId" AND a.id = NEW."agentId") INTO valid;
    WHEN 'Thread' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Environment" e
        JOIN "Project" p ON p.id = e."projectId"
        JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = p.id
        JOIN "EndUser" u ON u.id = NEW."endUserId" AND u."organizationId" = p."organizationId"
        LEFT JOIN "AgentCluster" c ON c.id = NEW."clusterId" AND c."environmentId" = e.id
        LEFT JOIN "Thread" parent ON parent.id = NEW."parentThreadId" AND parent."environmentId" = e.id AND parent."endUserId" = u.id
        LEFT JOIN "Turn" cursor ON cursor.id = NEW."compactedUpToTurnId" AND cursor."threadId" = NEW.id
        WHERE e.id = NEW."environmentId"
          AND (NEW."clusterId" IS NULL OR c.id IS NOT NULL)
          AND (NEW."parentThreadId" IS NULL OR parent.id IS NOT NULL)
          AND (NEW."compactedUpToTurnId" IS NULL OR cursor.id IS NOT NULL)
      ) INTO valid;
    WHEN 'Turn' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Thread" t
        JOIN "AgentVersion" version ON version.id = NEW."agentVersionId" AND version."agentId" = t."agentId"
        LEFT JOIN "Turn" parent ON parent.id = NEW."parentTurnId" AND parent."threadId" = t.id
        WHERE t.id = NEW."threadId"
          AND (NEW."parentTurnId" IS NULL OR parent.id IS NOT NULL)
      ) INTO valid;
    WHEN 'Artifact' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Thread" t
        LEFT JOIN "Turn" turn ON turn.id = NEW."producedByTurnId" AND turn."threadId" = t.id
        WHERE t.id = NEW."threadId" AND t."environmentId" = NEW."environmentId"
          AND (NEW."producedByTurnId" IS NULL OR turn.id IS NOT NULL)
      ) INTO valid;
    WHEN 'MessageAttachment' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Environment" e
        JOIN "Project" p ON p.id = e."projectId"
        JOIN "EndUser" u ON u.id = NEW."endUserId" AND u."organizationId" = p."organizationId"
        LEFT JOIN "Turn" turn ON turn.id = NEW."turnId"
        LEFT JOIN "Thread" t ON t.id = turn."threadId" AND t."environmentId" = e.id AND t."endUserId" = u.id
        WHERE e.id = NEW."environmentId" AND (NEW."turnId" IS NULL OR t.id IS NOT NULL)
      ) INTO valid;
    WHEN 'ChannelConnection' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Environment" e
        LEFT JOIN "Entity" entity ON entity.id = NEW."entityId" AND entity."projectId" = e."projectId"
        LEFT JOIN "Agent" agent ON agent.id = NEW."defaultAgentId" AND agent."projectId" = e."projectId"
        LEFT JOIN "Credential" credential ON credential.id = NEW."credentialId" AND credential."environmentId" = e.id
        WHERE e.id = NEW."environmentId"
          AND (NEW."entityId" IS NULL OR entity.id IS NOT NULL)
          AND (NEW."defaultAgentId" IS NULL OR agent.id IS NOT NULL)
          AND (NEW."credentialId" IS NULL OR credential.id IS NOT NULL)
      ) INTO valid;
    WHEN 'ChannelThread' THEN
      SELECT EXISTS (SELECT 1 FROM "ChannelConnection" c JOIN "Thread" t ON t."environmentId" = c."environmentId" WHERE c.id = NEW."connectionId" AND t.id = NEW."threadId") INTO valid;
    WHEN 'ChannelApp' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Environment" e
        LEFT JOIN "Agent" a ON a.id = NEW."defaultAgentId" AND a."projectId" = e."projectId"
        LEFT JOIN "Credential" c ON c.id = NEW."credentialId" AND c."environmentId" = e.id
        WHERE e.id = NEW."environmentId"
          AND (NEW."defaultAgentId" IS NULL OR a.id IS NOT NULL)
          AND (NEW."credentialId" IS NULL OR c.id IS NOT NULL)
      ) INTO valid;
    WHEN 'ChannelInstallation' THEN
      SELECT EXISTS (
        SELECT 1 FROM "ChannelApp" app JOIN "Environment" e ON e.id = app."environmentId"
        LEFT JOIN "Agent" a ON a.id = NEW."defaultAgentId" AND a."projectId" = e."projectId"
        LEFT JOIN "Credential" c ON c.id = NEW."credentialId" AND c."environmentId" = e.id
        WHERE app.id = NEW."appId"
          AND (NEW."defaultAgentId" IS NULL OR a.id IS NOT NULL)
          AND (NEW."credentialId" IS NULL OR c.id IS NOT NULL)
      ) INTO valid;
    WHEN 'ChannelAppThread' THEN
      SELECT EXISTS (SELECT 1 FROM "ChannelInstallation" i JOIN "ChannelApp" app ON app.id = i."appId" JOIN "Thread" t ON t."environmentId" = app."environmentId" WHERE i.id = NEW."installationId" AND t.id = NEW."threadId") INTO valid;
    WHEN 'EntityMcpClient' THEN
      SELECT NEW."credentialId" IS NULL OR EXISTS (
        SELECT 1 FROM "Entity" entity JOIN "Credential" c ON c.id = NEW."credentialId" JOIN "Environment" e ON e.id = c."environmentId"
        WHERE entity.id = NEW."entityId" AND entity."projectId" = e."projectId"
      ) INTO valid;
    WHEN 'EnvironmentEntityTool' THEN
      SELECT EXISTS (SELECT 1 FROM "Environment" e JOIN "Entity" entity ON entity."projectId" = e."projectId" WHERE e.id = NEW."environmentId" AND entity.id = NEW."entityId") INTO valid;
    WHEN 'ToolCallAudit' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Environment" e JOIN "Project" p ON p.id = e."projectId"
        LEFT JOIN "EndUser" u ON u.id = NEW."endUserId" AND u."organizationId" = p."organizationId"
        LEFT JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = p.id
        LEFT JOIN "Thread" t ON t.id = NEW."threadId" AND t."environmentId" = e.id
        WHERE e.id = NEW."environmentId"
          AND (NEW."endUserId" IS NULL OR u.id IS NOT NULL)
          AND (NEW."agentId" IS NULL OR a.id IS NOT NULL)
          AND (NEW."threadId" IS NULL OR t.id IS NOT NULL)
      ) INTO valid;
    WHEN 'AgentApproval' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Environment" e
        LEFT JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = e."projectId"
        LEFT JOIN "Thread" t ON t.id = NEW."threadId" AND t."environmentId" = e.id
        LEFT JOIN "Turn" turn ON turn.id = NEW."turnId" AND turn."threadId" = t.id
        WHERE e.id = NEW."environmentId"
          AND (NEW."agentId" IS NULL OR a.id IS NOT NULL)
          AND (NEW."threadId" IS NULL OR t.id IS NOT NULL)
          AND (NEW."turnId" IS NULL OR turn.id IS NOT NULL)
      ) INTO valid;
    WHEN 'Budget' THEN
      SELECT EXISTS (SELECT 1 FROM "Environment" e LEFT JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = e."projectId" WHERE e.id = NEW."environmentId" AND (NEW."agentId" IS NULL OR a.id IS NOT NULL)) INTO valid;
    WHEN 'SafetyEvent' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Environment" e JOIN "Project" p ON p.id = e."projectId"
        LEFT JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = p.id
        LEFT JOIN "EndUser" u ON u.id = NEW."endUserId" AND u."organizationId" = p."organizationId"
        LEFT JOIN "Thread" t ON t.id = NEW."threadId" AND t."environmentId" = e.id
        LEFT JOIN "Turn" turn ON turn.id = NEW."turnId" AND turn."threadId" = t.id
        WHERE e.id = NEW."environmentId"
          AND (NEW."agentId" IS NULL OR a.id IS NOT NULL)
          AND (NEW."endUserId" IS NULL OR u.id IS NOT NULL)
          AND (NEW."threadId" IS NULL OR t.id IS NOT NULL)
          AND (NEW."turnId" IS NULL OR turn.id IS NOT NULL)
      ) INTO valid;
    WHEN 'MessageRating' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Environment" e JOIN "Project" p ON p.id = e."projectId"
        JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = p.id
        JOIN "EndUser" u ON u.id = NEW."endUserId" AND u."organizationId" = p."organizationId"
        JOIN "Turn" turn ON turn.id = NEW."turnId" JOIN "Thread" t ON t.id = turn."threadId" AND t."environmentId" = e.id AND t."endUserId" = u.id
        LEFT JOIN "AgentVersion" version ON version.id = NEW."agentVersionId" AND version."agentId" = a.id
        WHERE e.id = NEW."environmentId" AND (NEW."agentVersionId" IS NULL OR version.id IS NOT NULL)
      ) INTO valid;
    WHEN 'EvalCriterion' THEN
      SELECT EXISTS (SELECT 1 FROM "Environment" e LEFT JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = e."projectId" WHERE e.id = NEW."environmentId" AND (NEW."agentId" IS NULL OR a.id IS NOT NULL)) INTO valid;
    WHEN 'AgentEval' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Environment" e JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = e."projectId"
        JOIN "Thread" t ON t.id = NEW."threadId" AND t."environmentId" = e.id
        JOIN "EvalCriterion" criterion ON criterion.id = NEW."criterionId" AND criterion."environmentId" = e.id
        LEFT JOIN "AgentVersion" version ON version.id = NEW."agentVersionId" AND version."agentId" = a.id
        LEFT JOIN "Turn" turn ON turn.id = NEW."turnId" AND turn."threadId" = t.id
        WHERE e.id = NEW."environmentId"
          AND (NEW."agentVersionId" IS NULL OR version.id IS NOT NULL)
          AND (NEW."turnId" IS NULL OR turn.id IS NOT NULL)
      ) INTO valid;
    WHEN 'GoldenSet' THEN
      SELECT EXISTS (SELECT 1 FROM "Environment" e JOIN "Agent" a ON a."projectId" = e."projectId" WHERE e.id = NEW."environmentId" AND a.id = NEW."agentId") INTO valid;
    WHEN 'ProjectSkill' THEN
      SELECT EXISTS (SELECT 1 FROM "Project" p JOIN "Skill" s ON s."organizationId" = p."organizationId" WHERE p.id = NEW."projectId" AND s.id = NEW."skillId") INTO valid;
    WHEN 'EnvironmentSkill' THEN
      SELECT EXISTS (SELECT 1 FROM "Environment" e JOIN "ProjectSkill" ps ON ps."projectId" = e."projectId" WHERE e.id = NEW."environmentId" AND ps.id = NEW."projectSkillId") INTO valid;
    WHEN 'AgentSkill' THEN
      SELECT EXISTS (
        SELECT 1 FROM "AgentVersion" v JOIN "Agent" a ON a.id = v."agentId"
        JOIN "EnvironmentSkill" es ON es.id = NEW."environmentSkillId" JOIN "Environment" e ON e.id = es."environmentId" AND e."projectId" = a."projectId"
        WHERE v.id = NEW."agentVersionId"
      ) INTO valid;
    WHEN 'Memory' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Environment" e
        JOIN "Project" p ON p.id = e."projectId"
        JOIN "EndUser" u ON u.id = NEW."endUserId" AND u."organizationId" = p."organizationId"
        JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = p.id
        LEFT JOIN "AgentCluster" cluster ON cluster.id = NEW."clusterId" AND cluster."environmentId" = e.id
        LEFT JOIN "AgentBinding" binding ON binding."environmentId" = e.id
          AND binding."agentId" = a.id AND binding."clusterId" = cluster.id
        LEFT JOIN "Thread" source_thread ON source_thread.id = NEW."sourceThreadId"
          AND source_thread."environmentId" = e.id AND source_thread."endUserId" = u.id
          AND source_thread."agentId" = a.id
          AND (NEW."clusterId" IS NULL OR source_thread."clusterId" = NEW."clusterId")
        WHERE e.id = NEW."environmentId"
          AND (NEW."clusterId" IS NULL OR (cluster.id IS NOT NULL AND binding.id IS NOT NULL))
          AND (NEW."sourceThreadId" IS NULL OR source_thread.id IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM unnest(NEW."sourceTurnIds") source_turn_id
            WHERE NOT EXISTS (
              SELECT 1 FROM "Turn" source_turn
              WHERE source_turn.id = source_turn_id AND source_turn."threadId" = NEW."sourceThreadId"
            )
          )
      ) INTO valid;
    WHEN 'MemoryEntity' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Environment" e
        JOIN "Project" p ON p.id = e."projectId"
        JOIN "EndUser" u ON u.id = NEW."endUserId" AND u."organizationId" = p."organizationId"
        JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = p.id
        LEFT JOIN "AgentCluster" cluster ON cluster.id = NEW."clusterId" AND cluster."environmentId" = e.id
        LEFT JOIN "AgentBinding" binding ON binding."environmentId" = e.id
          AND binding."agentId" = a.id AND binding."clusterId" = cluster.id
        WHERE e.id = NEW."environmentId"
          AND (NEW."clusterId" IS NULL OR (cluster.id IS NOT NULL AND binding.id IS NOT NULL))
      ) INTO valid;
    WHEN 'MemoryRelationship' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Environment" e
        JOIN "Project" p ON p.id = e."projectId"
        JOIN "EndUser" u ON u.id = NEW."endUserId" AND u."organizationId" = p."organizationId"
        JOIN "Agent" a ON a.id = NEW."agentId" AND a."projectId" = p.id
        LEFT JOIN "AgentCluster" cluster ON cluster.id = NEW."clusterId" AND cluster."environmentId" = e.id
        LEFT JOIN "AgentBinding" binding ON binding."environmentId" = e.id
          AND binding."agentId" = a.id AND binding."clusterId" = cluster.id
        JOIN "MemoryEntity" source ON source.id = NEW."fromEntityId"
          AND source."environmentId" = e.id AND source."endUserId" = u.id
        JOIN "MemoryEntity" target ON target.id = NEW."toEntityId"
          AND target."environmentId" = e.id AND target."endUserId" = u.id
        LEFT JOIN "Memory" source_memory ON source_memory.id = NEW."sourceMemoryId"
          AND source_memory."environmentId" = e.id AND source_memory."endUserId" = u.id
        WHERE e.id = NEW."environmentId"
          AND (NEW."clusterId" IS NULL OR (cluster.id IS NOT NULL AND binding.id IS NOT NULL))
          AND (
            (NEW."clusterId" IS NULL AND
              source."clusterId" IS NULL AND target."clusterId" IS NULL AND
              source."agentId" = a.id AND target."agentId" = a.id) OR
            (NEW."clusterId" IS NOT NULL AND
              source."clusterId" = NEW."clusterId" AND target."clusterId" = NEW."clusterId")
          )
          AND (
            NEW."sourceMemoryId" IS NULL OR
            (NEW."clusterId" IS NULL AND source_memory."clusterId" IS NULL AND source_memory."agentId" = a.id) OR
            (NEW."clusterId" IS NOT NULL AND source_memory."clusterId" = NEW."clusterId")
          )
      ) INTO valid;
    WHEN 'OAuthClient' THEN
      SELECT EXISTS (
        SELECT 1 FROM "OrganizationMembership" membership
        LEFT JOIN "Entity" entity ON entity.id = NEW."entityId" LEFT JOIN "Project" p ON p.id = entity."projectId" AND p."organizationId" = NEW."organizationId"
        WHERE membership."organizationId" = NEW."organizationId" AND membership."userId" = NEW."registeredByUserId"
          AND membership."deactivatedAt" IS NULL AND (NEW."entityId" IS NULL OR p.id IS NOT NULL)
      ) INTO valid;
    WHEN 'OAuthAuthorizationCode' THEN
      SELECT EXISTS (
        SELECT 1 FROM "OAuthClient" client
        JOIN "OrganizationMembership" membership ON membership."organizationId" = client."organizationId"
          AND membership."userId" = NEW."userId" AND membership."deactivatedAt" IS NULL
        WHERE client.id = NEW."clientId" AND client."organizationId" = CASE NEW."scopeKind"
          WHEN 'ORGANIZATION' THEN NEW."organizationId"
          WHEN 'PROJECT' THEN (SELECT p."organizationId" FROM "Project" p WHERE p.id = NEW."projectId")
          WHEN 'ENVIRONMENT' THEN (SELECT p."organizationId" FROM "Environment" e JOIN "Project" p ON p.id = e."projectId" WHERE e.id = NEW."environmentId")
        END
      ) INTO valid;
    WHEN 'McpAnonymousSession' THEN
      SELECT EXISTS (SELECT 1 FROM "Environment" e JOIN "Entity" entity ON entity."projectId" = e."projectId" WHERE e.id = NEW."environmentId" AND entity.id = NEW."entityId") INTO valid;
    WHEN 'McpOidcSession' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Environment" e JOIN "Entity" entity ON entity.id = NEW."entityId" AND entity."projectId" = e."projectId"
        LEFT JOIN "Credential" c ON c.id = NEW."credentialId" AND c."environmentId" = e.id
        WHERE e.id = NEW."environmentId" AND (NEW."credentialId" IS NULL OR c.id IS NOT NULL)
      ) INTO valid;
    WHEN 'McpToken' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Environment" e JOIN "Project" p ON p.id = e."projectId"
        JOIN "OrganizationMembership" membership ON membership."organizationId" = p."organizationId"
          AND membership."userId" = NEW."mintedByUserId" AND membership."deactivatedAt" IS NULL
        WHERE e.id = NEW."environmentId"
      ) INTO valid;
    WHEN 'PersonalAccessToken' THEN
      IF NEW."scopeKind" = 'GLOBAL' THEN
        valid := TRUE;
      ELSE
        SELECT EXISTS (
          SELECT 1
          FROM "OrganizationMembership" membership
          WHERE membership."userId" = NEW."userId" AND membership."deactivatedAt" IS NULL
            AND membership."organizationId" = CASE NEW."scopeKind"
              WHEN 'ORGANIZATION' THEN NEW."organizationId"
              WHEN 'PROJECT' THEN (SELECT p."organizationId" FROM "Project" p WHERE p.id = NEW."projectId")
              WHEN 'ENVIRONMENT' THEN (SELECT p."organizationId" FROM "Environment" e JOIN "Project" p ON p.id = e."projectId" WHERE e.id = NEW."environmentId")
            END
        ) INTO valid;
      END IF;
    WHEN 'OAuthAccessToken' THEN
      SELECT EXISTS (
        SELECT 1 FROM "OAuthClient" client
        JOIN "OrganizationMembership" membership ON membership."organizationId" = client."organizationId"
          AND membership."userId" = NEW."userId" AND membership."deactivatedAt" IS NULL
        WHERE client.id = NEW."clientId" AND client."organizationId" = CASE NEW."scopeKind"
          WHEN 'ORGANIZATION' THEN NEW."organizationId"
          WHEN 'PROJECT' THEN (SELECT p."organizationId" FROM "Project" p WHERE p.id = NEW."projectId")
          WHEN 'ENVIRONMENT' THEN (SELECT p."organizationId" FROM "Environment" e JOIN "Project" p ON p.id = e."projectId" WHERE e.id = NEW."environmentId")
        END
      ) INTO valid;
    WHEN 'OAuthRefreshToken' THEN
      SELECT EXISTS (
        SELECT 1 FROM "OAuthClient" client
        JOIN "OrganizationMembership" membership ON membership."organizationId" = client."organizationId"
          AND membership."userId" = NEW."userId" AND membership."deactivatedAt" IS NULL
        LEFT JOIN "OAuthAccessToken" access ON access.id = NEW."accessTokenId"
          AND access."clientId" = client.id AND access."userId" = NEW."userId"
        LEFT JOIN "OAuthRefreshToken" parent ON parent.id = NEW."parentRefreshTokenId"
          AND parent."clientId" = client.id AND parent."userId" = NEW."userId"
          AND parent."rotationFamilyId" = NEW."rotationFamilyId"
        WHERE client.id = NEW."clientId" AND client."organizationId" = CASE NEW."scopeKind"
          WHEN 'ORGANIZATION' THEN NEW."organizationId"
          WHEN 'PROJECT' THEN (SELECT p."organizationId" FROM "Project" p WHERE p.id = NEW."projectId")
          WHEN 'ENVIRONMENT' THEN (SELECT p."organizationId" FROM "Environment" e JOIN "Project" p ON p.id = e."projectId" WHERE e.id = NEW."environmentId")
        END
          AND (NEW."accessTokenId" IS NULL OR access.id IS NOT NULL)
          AND (NEW."parentRefreshTokenId" IS NULL OR parent.id IS NOT NULL)
      ) INTO valid;
    WHEN 'McpBearerToken' THEN
      SELECT EXISTS (
        SELECT 1 FROM "Entity" entity JOIN "Project" p ON p.id = entity."projectId"
        JOIN "OrganizationMembership" membership ON membership."organizationId" = p."organizationId"
          AND membership."userId" = NEW."createdByUserId" AND membership."deactivatedAt" IS NULL
        WHERE entity.id = NEW."entityId"
      ) INTO valid;
    ELSE
      RAISE EXCEPTION 'No ancestry rule for %', TG_TABLE_NAME USING ERRCODE = '23514';
  END CASE;

  IF NOT valid THEN
    RAISE EXCEPTION '% crosses its canonical owner ancestry', TG_TABLE_NAME
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "EndUserSession_ancestry" BEFORE INSERT OR UPDATE ON "public"."EndUserSession" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "AgentBinding_ancestry" BEFORE INSERT OR UPDATE ON "public"."AgentBinding" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "PostmanTemplate_ancestry" BEFORE INSERT OR UPDATE ON "public"."PostmanTemplate" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "Thread_ancestry" BEFORE INSERT OR UPDATE ON "public"."Thread" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "Turn_ancestry" BEFORE INSERT OR UPDATE ON "public"."Turn" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "Artifact_ancestry" BEFORE INSERT OR UPDATE ON "public"."Artifact" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "MessageAttachment_ancestry" BEFORE INSERT OR UPDATE ON "public"."MessageAttachment" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "ChannelConnection_ancestry" BEFORE INSERT OR UPDATE ON "public"."ChannelConnection" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "ChannelThread_ancestry" BEFORE INSERT OR UPDATE ON "public"."ChannelThread" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "ChannelApp_ancestry" BEFORE INSERT OR UPDATE ON "public"."ChannelApp" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "ChannelInstallation_ancestry" BEFORE INSERT OR UPDATE ON "public"."ChannelInstallation" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "ChannelAppThread_ancestry" BEFORE INSERT OR UPDATE ON "public"."ChannelAppThread" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "EntityMcpClient_ancestry" BEFORE INSERT OR UPDATE ON "public"."EntityMcpClient" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "EnvironmentEntityTool_ancestry" BEFORE INSERT OR UPDATE ON "public"."EnvironmentEntityTool" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "ToolCallAudit_ancestry" BEFORE INSERT OR UPDATE ON "public"."ToolCallAudit" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "AgentApproval_ancestry" BEFORE INSERT OR UPDATE ON "public"."AgentApproval" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "Budget_ancestry" BEFORE INSERT OR UPDATE ON "public"."Budget" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "SafetyEvent_ancestry" BEFORE INSERT OR UPDATE ON "public"."SafetyEvent" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "MessageRating_ancestry" BEFORE INSERT OR UPDATE ON "public"."MessageRating" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "EvalCriterion_ancestry" BEFORE INSERT OR UPDATE ON "public"."EvalCriterion" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "AgentEval_ancestry" BEFORE INSERT OR UPDATE ON "public"."AgentEval" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "GoldenSet_ancestry" BEFORE INSERT OR UPDATE ON "public"."GoldenSet" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "ProjectSkill_ancestry" BEFORE INSERT OR UPDATE ON "public"."ProjectSkill" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "EnvironmentSkill_ancestry" BEFORE INSERT OR UPDATE ON "public"."EnvironmentSkill" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "AgentSkill_ancestry" BEFORE INSERT OR UPDATE ON "public"."AgentSkill" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "Memory_ancestry" BEFORE INSERT OR UPDATE ON "public"."Memory" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "MemoryEntity_ancestry" BEFORE INSERT OR UPDATE ON "public"."MemoryEntity" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "MemoryRelationship_ancestry" BEFORE INSERT OR UPDATE ON "public"."MemoryRelationship" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "OAuthClient_ancestry" BEFORE INSERT OR UPDATE ON "public"."OAuthClient" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "OAuthAuthorizationCode_ancestry" BEFORE INSERT OR UPDATE ON "public"."OAuthAuthorizationCode" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "McpAnonymousSession_ancestry" BEFORE INSERT OR UPDATE ON "public"."McpAnonymousSession" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "McpOidcSession_ancestry" BEFORE INSERT OR UPDATE ON "public"."McpOidcSession" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "McpToken_ancestry" BEFORE INSERT OR UPDATE ON "public"."McpToken" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "PersonalAccessToken_ancestry" BEFORE INSERT OR UPDATE ON "public"."PersonalAccessToken" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "OAuthAccessToken_ancestry" BEFORE INSERT OR UPDATE ON "public"."OAuthAccessToken" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "OAuthRefreshToken_ancestry" BEFORE INSERT OR UPDATE ON "public"."OAuthRefreshToken" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();
CREATE TRIGGER "McpBearerToken_ancestry" BEFORE INSERT OR UPDATE ON "public"."McpBearerToken" FOR EACH ROW EXECUTE FUNCTION "public"."enforce_domain_ancestry"();

-- Platos-native authentication invariants.
ALTER TABLE "public"."User"
  ADD CONSTRAINT "User_email_normalized_check" CHECK ("email" = lower(btrim("email")));
ALTER TABLE "public"."MagicLinkToken"
  ADD CONSTRAINT "MagicLinkToken_email_normalized_check" CHECK ("email" = lower(btrim("email")));
ALTER TABLE "public"."OrganizationInvitation"
  ADD CONSTRAINT "OrganizationInvitation_email_normalized_check" CHECK ("email" = lower(btrim("email")));
ALTER TABLE "public"."OperatorSession"
  ADD CONSTRAINT "OperatorSession_tokenHash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "public"."MagicLinkToken"
  ADD CONSTRAINT "MagicLinkToken_tokenHash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "public"."OrganizationInvitation"
  ADD CONSTRAINT "OrganizationInvitation_tokenHash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "public"."OperatorMfaRecoveryCode"
  ADD CONSTRAINT "OperatorMfaRecoveryCode_codeHash_check" CHECK ("codeHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "public"."AuthRateLimitBucket"
  ADD CONSTRAINT "AuthRateLimitBucket_identifierHash_check" CHECK ("identifierHash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "public"."OperatorMfaTotp"
  ADD CONSTRAINT "OperatorMfaTotp_active_pending_shape_check" CHECK (
    (("enabledAt" IS NULL AND "encryptedSecret" IS NULL AND "lastUsedCounter" IS NULL) OR
     ("enabledAt" IS NOT NULL AND "encryptedSecret" IS NOT NULL)) AND
    (("pendingEncryptedSecret" IS NULL AND "pendingExpiresAt" IS NULL) OR
     ("pendingEncryptedSecret" IS NOT NULL AND "pendingExpiresAt" IS NOT NULL))
  );

-- Exactly one unconsumed, unrevoked invitation may exist for an organization
-- and normalized email. issueInvitation also takes an advisory transaction
-- lock so concurrent replacements serialize instead of leaking a unique error.
CREATE UNIQUE INDEX "OrganizationInvitation_one_active_per_email"
  ON "public"."OrganizationInvitation" ("organizationId", "email")
  WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;

-- Impersonation sessions are subordinate to the actor's parent session. A
-- child cannot outlive or survive revocation of that parent.
CREATE FUNCTION "public"."enforce_operator_session_parent"()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."parentSessionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "public"."OperatorSession" parent
    WHERE parent.id = NEW."parentSessionId"
      AND parent."userId" = NEW."userId"
      AND parent."impersonatedUserId" IS NULL
      AND parent."revokedAt" IS NULL
      AND parent."expiresAt" >= NEW."expiresAt"
  ) THEN
    RAISE EXCEPTION 'OperatorSession parent must be active and cannot expire before its child'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "OperatorSession_parent_active"
  BEFORE INSERT OR UPDATE OF "parentSessionId", "userId", "expiresAt" ON "public"."OperatorSession"
  FOR EACH ROW EXECUTE FUNCTION "public"."enforce_operator_session_parent"();

CREATE FUNCTION "public"."cascade_operator_session_revocation"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."revokedAt" IS NULL AND NEW."revokedAt" IS NOT NULL THEN
    UPDATE "public"."OperatorSession"
      SET "revokedAt" = COALESCE("revokedAt", NEW."revokedAt")
      WHERE "parentSessionId" = NEW.id AND "revokedAt" IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "OperatorSession_cascade_revocation"
  AFTER UPDATE OF "revokedAt" ON "public"."OperatorSession"
  FOR EACH ROW EXECUTE FUNCTION "public"."cascade_operator_session_revocation"();

-- Membership privilege changes invalidate every active dashboard session even
-- when a caller bypasses the TypeScript auth service.
CREATE FUNCTION "public"."revoke_operator_sessions_for_membership_change"()
RETURNS TRIGGER AS $$
DECLARE
  affected_user_id UUID;
BEGIN
  affected_user_id := COALESCE(NEW."userId", OLD."userId");
  IF TG_OP = 'DELETE'
     OR OLD."role" IS DISTINCT FROM NEW."role"
     OR OLD."deactivatedAt" IS DISTINCT FROM NEW."deactivatedAt" THEN
    UPDATE "public"."OperatorSession"
      SET "revokedAt" = COALESCE("revokedAt", CURRENT_TIMESTAMP)
      WHERE ("userId" = affected_user_id OR "impersonatedUserId" = affected_user_id)
        AND "revokedAt" IS NULL;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "OrganizationMembership_revoke_sessions_update"
  AFTER UPDATE OF "role", "deactivatedAt" ON "public"."OrganizationMembership"
  FOR EACH ROW EXECUTE FUNCTION "public"."revoke_operator_sessions_for_membership_change"();
CREATE TRIGGER "OrganizationMembership_revoke_sessions_delete"
  AFTER DELETE ON "public"."OrganizationMembership"
  FOR EACH ROW EXECUTE FUNCTION "public"."revoke_operator_sessions_for_membership_change"();

-- Impersonation audit is append-only. Corrections are represented by a new
-- STOP/START row; existing evidence cannot be edited, deleted, or truncated.
CREATE FUNCTION "public"."reject_impersonation_audit_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'ImpersonationAudit is immutable' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ImpersonationAudit_immutable_update"
  BEFORE UPDATE ON "public"."ImpersonationAudit"
  FOR EACH ROW EXECUTE FUNCTION "public"."reject_impersonation_audit_mutation"();
CREATE TRIGGER "ImpersonationAudit_immutable_delete"
  BEFORE DELETE ON "public"."ImpersonationAudit"
  FOR EACH ROW EXECUTE FUNCTION "public"."reject_impersonation_audit_mutation"();
CREATE TRIGGER "ImpersonationAudit_immutable_truncate"
  BEFORE TRUNCATE ON "public"."ImpersonationAudit"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."reject_impersonation_audit_mutation"();

-- Runtime roles should receive SELECT/INSERT only. Remove mutation privileges
-- inherited through PUBLIC as defense in depth; the triggers also bind owners.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "public"."ImpersonationAudit" FROM PUBLIC;

-- WIN-123: Platos-native credential envelope and append-only audit invariants.
CREATE FUNCTION "public"."reject_provider_key_credential_mismatch"()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "public"."Credential" credential
     WHERE credential.id = NEW."credentialId"
       AND credential."environmentId" = NEW."environmentId"
       AND credential.provider = NEW.provider
       AND credential.name = NEW."environmentKeyName"
  ) THEN
    RAISE EXCEPTION 'ProviderKey credential/provider mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "ProviderKey_credential_provider_integrity"
  BEFORE INSERT OR UPDATE ON "public"."ProviderKey"
  FOR EACH ROW EXECUTE FUNCTION "public"."reject_provider_key_credential_mismatch"();

-- Enforce one current key even when a caller bypasses the rotation helper.
CREATE UNIQUE INDEX "AccessKey_one_active_per_environment"
  ON "public"."AccessKey" ("environmentId")
  WHERE "revokedAt" IS NULL AND "validUntil" IS NULL;

ALTER TABLE "public"."CredentialSecretVersion"
  ADD CONSTRAINT "CredentialSecretVersion_revision_check" CHECK ("secretRevision" > 0),
  ADD CONSTRAINT "CredentialSecretVersion_format_check" CHECK ("formatVersion" > 0),
  ADD CONSTRAINT "CredentialSecretVersion_root_key_check" CHECK ("rootKeyVersion" > 0),
  ADD CONSTRAINT "CredentialSecretVersion_salt_length_check" CHECK (octet_length("salt") = 32),
  ADD CONSTRAINT "CredentialSecretVersion_nonce_length_check" CHECK (octet_length("nonce") = 12),
  ADD CONSTRAINT "CredentialSecretVersion_auth_tag_length_check" CHECK (octet_length("authTag") = 16);

CREATE FUNCTION "public"."reject_credential_secret_envelope_change"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."credentialId" IS DISTINCT FROM NEW."credentialId"
     OR OLD."secretRevision" IS DISTINCT FROM NEW."secretRevision"
     OR OLD."formatVersion" IS DISTINCT FROM NEW."formatVersion"
     OR OLD."rootKeyVersion" IS DISTINCT FROM NEW."rootKeyVersion"
     OR OLD."salt" IS DISTINCT FROM NEW."salt"
     OR OLD."nonce" IS DISTINCT FROM NEW."nonce"
     OR OLD."ciphertext" IS DISTINCT FROM NEW."ciphertext"
     OR OLD."authTag" IS DISTINCT FROM NEW."authTag"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
    RAISE EXCEPTION 'CredentialSecretVersion envelope is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "CredentialSecretVersion_envelope_immutable"
  BEFORE UPDATE ON "public"."CredentialSecretVersion"
  FOR EACH ROW EXECUTE FUNCTION "public"."reject_credential_secret_envelope_change"();

CREATE FUNCTION "public"."reject_credential_audit_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'CredentialAudit is immutable' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "CredentialAudit_immutable_update"
  BEFORE UPDATE ON "public"."CredentialAudit"
  FOR EACH ROW EXECUTE FUNCTION "public"."reject_credential_audit_mutation"();
CREATE TRIGGER "CredentialAudit_immutable_delete"
  BEFORE DELETE ON "public"."CredentialAudit"
  FOR EACH ROW EXECUTE FUNCTION "public"."reject_credential_audit_mutation"();
CREATE TRIGGER "CredentialAudit_immutable_truncate"
  BEFORE TRUNCATE ON "public"."CredentialAudit"
  FOR EACH STATEMENT EXECUTE FUNCTION "public"."reject_credential_audit_mutation"();
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "public"."CredentialAudit" FROM PUBLIC;
