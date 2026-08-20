import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma as ControlPrisma } from "../generated/control";
import { Prisma as EndUserPrisma } from "../generated/end-user";
import { describe, expect, test } from "vitest";
import { endUserDelegateNames } from "./end-user";
import { jsonShapeRegistry } from "./json";
import {
  domainModelNames,
  legacyTenancyRelationManifest,
  legacyTenancyRelationCounts,
  sourceModelManifest,
} from "./source-model-manifest";

const packageRoot = resolve(__dirname, "..");
const schemaPath = resolve(packageRoot, "prisma/schema.prisma");
const schema = readFileSync(schemaPath, "utf8");
const sourceSchema = readFileSync(resolve(packageRoot, "../database/prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  resolve(packageRoot, "prisma/migrations/00000000000000_initial/migration.sql"),
  "utf8"
);
const tenancyOnlyModels = [
  "User",
  "OperatorSession",
  "OperatorIdentity",
  "MagicLinkToken",
  "OperatorMfaTotp",
  "OperatorMfaRecoveryCode",
  "AuthRateLimitBucket",
  "ImpersonationAudit",
  "Organization",
  "OrganizationMembership",
  "OrganizationInvitation",
  "Project",
  "ProjectMembership",
  "Environment",
  "EnvironmentSession",
  "EndUserSession",
] as const;

const expectedEndUserModels = [
  "AgentApproval",
  "Artifact",
  "EndUser",
  "EndUserIdentity",
  "EndUserSession",
  "Memory",
  "MemoryEntity",
  "MemoryRelationship",
  "MessageAttachment",
  "MessageRating",
  "Step",
  "Thread",
  "ToolCall",
  "Turn",
];

describe("clean-slate domain schema", () => {
  test("uses the approved normalized target and no persisted Platos prefixes", () => {
    const models = ControlPrisma.dmmf.datamodel.models.map((model) => model.name);
    expect(models).toHaveLength(90);
    expect(domainModelNames).toHaveLength(74);
    expect(new Set(domainModelNames).size).toBe(74);
    expect(new Set([...domainModelNames, ...tenancyOnlyModels])).toEqual(new Set(models));
    expect(models.some((name) => name.startsWith("Platos"))).toBe(false);
    expect(schema).not.toContain("@@map(");
    expect(schema).not.toContain("@map(");
  });

  test("states an onDelete policy for every Prisma-owned foreign key", () => {
    const owningRelations = schema
      .split("\n")
      .filter((line) => line.includes("@relation(") && line.includes("fields:"));
    for (const relation of owningRelations) expect(relation).toContain("onDelete:");

    const sqlForeignKeys = migration.match(/ FOREIGN KEY /g) ?? [];
    const sqlDeletePolicies =
      migration.match(/ ON DELETE (CASCADE|SET NULL|RESTRICT|NO ACTION)/g) ?? [];
    expect(sqlForeignKeys).toHaveLength(owningRelations.length);
    expect(sqlDeletePolicies).toHaveLength(sqlForeignKeys.length);
  });

  test("accounts for all 55 source models exactly once", () => {
    const sourceModels = [...sourceSchema.matchAll(/^model (Platos\w+) \{/gm)].map((match) => match[1]);
    const manifestSources = sourceModelManifest.map((entry) => entry.source);
    const controlModels = new Set(ControlPrisma.dmmf.datamodel.models.map((model) => model.name));

    expect(sourceModels).toHaveLength(55);
    expect(manifestSources).toHaveLength(55);
    expect(new Set(manifestSources).size).toBe(55);
    expect([...manifestSources].sort()).toEqual([...sourceModels].sort());
    for (const entry of sourceModelManifest) {
      expect(entry.targets.length).toBeGreaterThan(0);
      for (const target of entry.targets) expect(controlModels.has(target)).toBe(true);
    }
    expect(new Set(sourceModelManifest.flatMap((entry) => entry.targets)).size).toBe(59);
    expect(legacyTenancyRelationCounts).toEqual({
      RuntimeEnvironment: 30,
      Organization: 6,
      Project: 6,
      total: 42,
    });
    expect(legacyTenancyRelationManifest).toHaveLength(42);
    expect(new Set(legacyTenancyRelationManifest.map((entry) => entry.source)).size).toBe(42);
    for (const relation of legacyTenancyRelationManifest) {
      const [sourceModel, sourceField] = relation.source.split(".");
      const sourceBlock = sourceSchema.match(
        new RegExp(`model ${sourceModel} \\{([\\s\\S]*?)\\n\\}`)
      )?.[1];
      expect(sourceBlock, relation.source).toMatch(new RegExp(`^\\s*${sourceField}\\s`, "m"));
      expect(controlModels.has(relation.targetPath.split(".")[0]), relation.targetPath).toBe(true);
    }
  });

  test("preserves typed credential, principal, scope, rotation, and entity bearer capabilities", () => {
    const model = (name: string) => {
      const entry = ControlPrisma.dmmf.datamodel.models.find((candidate) => candidate.name === name);
      expect(entry, name).toBeDefined();
      return entry!;
    };
    const fields = (name: string) => new Set(model(name).fields.map((field) => field.name));

    for (const [name, expected] of Object.entries({
      AccessKey: ["environmentId", "keyPrefix", "keyHash", "allowedOrigins"],
      ProviderKey: ["environmentId", "credentialId", "provider", "environmentKeyName", "isDefault"],
      Credential: ["environmentId", "activeSecretVersionId"],
      CredentialSecretVersion: ["credentialId", "secretRevision", "rootKeyVersion", "ciphertext"],
      CredentialAudit: ["environmentId", "credentialId", "action", "outcome", "actorType"],
      EnvironmentVariable: ["environmentId", "key", "kind", "value", "credentialId", "version"],
      AlertChannel: ["environmentId", "type", "alertTypes", "deletedAt"],
      AlertChannelConfiguration: ["channelId", "environmentId", "type", "credentialId"],
      BudgetThresholdEvent: ["environmentId", "budgetId", "windowKey", "threshold"],
      AlertDelivery: ["environmentId", "channelId", "budgetThresholdEventId", "status", "idempotencyKey"],
      AlertDeliveryAttempt: ["environmentId", "deliveryId", "attemptNumber", "status"],
      McpToken: ["environmentId", "mintedByUserId", "permissions", "tier"],
      PersonalAccessToken: ["userId", "scopeKind", "organizationId", "projectId", "environmentId"],
      OAuthAuthorizationCode: ["clientId", "userId", "scopeKind", "organizationId", "projectId", "environmentId"],
      OAuthConsentTransaction: ["clientId", "organizationId", "projectId", "environmentId", "scopes", "nonce"],
      OAuthAccessToken: ["clientId", "userId", "scopeKind", "scopes"],
      OAuthRefreshToken: ["accessTokenId", "rotationFamilyId", "parentRefreshTokenId", "consumedAt", "replayDetectedAt"],
      McpBearerToken: ["entityId", "environmentId", "mcpUserId", "createdByUserId", "scopes"],
      Thread: ["compactedUpToTurnId", "compactionState", "compactedAt"],
      Turn: ["agentVersionId", "versionBucket", "costCents", "latencyMs"],
      Model: ["key", "provider", "name", "sourceUpdatedAt"],
      ModelPrice: [
        "modelId",
        "effectiveFrom",
        "inputRate",
        "outputRate",
        "cacheReadRate",
        "cacheWriteRate",
        "inputSource",
        "outputSource",
        "cacheReadSource",
        "cacheWriteSource",
      ],
      Step: [
        "cacheCreationInputTokens",
        "cacheReadInputTokens",
        "reasoningTokens",
        "costCents",
        "modelPriceId",
        "inputRate",
        "outputRate",
        "cacheReadRate",
        "cacheWriteRate",
        "latencyMs",
      ],
      Memory: [
        "agentId",
        "clusterId",
        "sourceThreadId",
        "sourceTurnIds",
        "extractorVersion",
        "contentHash",
        "quarantinedAt",
        "feedbackBaselineConfidence",
      ],
      MessageRating: ["revision"],
      MemoryEntity: ["agentId", "clusterId"],
      MemoryRelationship: ["agentId", "clusterId", "sourceMemoryId"],
    })) {
      const actual = fields(name);
      for (const field of expected) expect(actual.has(field), `${name}.${field}`).toBe(true);
    }

    expect(sourceModelManifest.find((entry) => entry.source === "PlatosPAT")?.targets)
      .toEqual(["PersonalAccessToken"]);
    expect(sourceModelManifest.find((entry) => entry.source === "PlatosOAuthRefreshToken")?.targets)
      .toEqual(["OAuthRefreshToken"]);
    expect(sourceModelManifest.find((entry) => entry.source === "PlatosMcpBearerToken")?.targets)
      .toEqual(["McpBearerToken"]);
    expect(migration).toContain('CONSTRAINT "PersonalAccessToken_scope_shape_check"');
    expect(migration).toContain('CONSTRAINT "OAuthRefreshToken_scope_shape_check"');
    expect(migration).toContain('CREATE UNIQUE INDEX "ProviderKey_one_default_per_environment_provider"');
    expect(migration).toContain('WHERE "isDefault" = TRUE');
    expect(migration).toContain('CREATE TRIGGER "ProviderKey_executable_reference"');
    expect(migration).toContain('version."memoryConfig" #>> \'{__runtime,providerKeyId}\'');
    expect(migration).toContain("route ->> 'providerCredentialId'");
    expect(migration).toContain("route ->> 'providerKeyId'");
  });

  test("models runtime attribution, compaction, vector recall, and cluster sharing structurally", () => {
    const model = (name: string) => ControlPrisma.dmmf.datamodel.models.find(
      (candidate) => candidate.name === name
    )!;
    const field = (modelName: string, fieldName: string) => model(modelName).fields.find(
      (candidate) => candidate.name === fieldName
    )!;

    expect(field("Turn", "agentVersionId").isRequired).toBe(true);
    expect(field("Turn", "agentVersion")).toMatchObject({
      kind: "object",
      type: "AgentVersion",
    });
    expect(field("Thread", "compactedUpToTurn")).toMatchObject({
      kind: "object",
      type: "Turn",
    });
    expect(field("Memory", "agentId").isRequired).toBe(true);
    expect(field("Memory", "cluster")).toMatchObject({ kind: "object", type: "AgentCluster" });
    expect(field("MemoryRelationship", "sourceMemory")).toMatchObject({
      kind: "object",
      type: "Memory",
    });

    for (const expected of [
      'CREATE EXTENSION IF NOT EXISTS "vector"',
      'CREATE INDEX "Memory_embedding_hnsw_cosine_idx"',
      'CREATE INDEX "MemoryEntity_embedding_hnsw_cosine_idx"',
      'CREATE UNIQUE INDEX "MemoryEntity_shared_cluster_entityKey_key"',
      'CONSTRAINT "Memory_extraction_provenance_check"',
      'CONSTRAINT "Step_usage_check"',
      'CONSTRAINT "ModelPrice_rate_check"',
      'CREATE TRIGGER "ModelPrice_immutable_update"',
      'CREATE TRIGGER "Step_price_snapshot"',
      'CREATE TRIGGER "Turn_ancestry"',
      'CREATE TRIGGER "MemoryRelationship_owner_immutable"',
    ]) {
      expect(migration).toContain(expected);
    }
    expect(migration).not.toContain("ClickHouse");
  });

  test("documents and registers every retained Json field", () => {
    const jsonFields = ControlPrisma.dmmf.datamodel.models.flatMap((model) =>
      model.fields
        .filter((field) => field.type === "Json")
        .map((field) => `${model.name}.${field.name}`)
    );
    expect(Object.keys(jsonShapeRegistry).sort()).toEqual(jsonFields.sort());

    for (const field of jsonFields) {
      const [modelName, fieldName] = field.split(".");
      const model = ControlPrisma.dmmf.datamodel.models.find((entry) => entry.name === modelName);
      const dmmfField = model?.fields.find((entry) => entry.name === fieldName);
      expect(dmmfField?.documentation, field).toContain("root");
      expect(migration, field).toContain(`\"${modelName}_${fieldName}_json_root\"`);
    }
  });

  test("keeps the complete disposable schema in one initial migration", () => {
    const migrationDirectories = readdirSync(resolve(packageRoot, "prisma/migrations"), {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory());
    expect(migrationDirectories.map((entry) => entry.name)).toEqual([
      "00000000000000_initial",
    ]);

    const generated = execFileSync(resolve(packageRoot, "node_modules/.bin/prisma"), [
      "migrate",
      "diff",
      "--from-empty",
      "--to-schema-datamodel",
      schemaPath,
      "--script",
    ], {
      cwd: packageRoot,
      env: { ...process.env, DATABASE_URL: "postgresql://generate:generate@localhost:5432/generate" },
      encoding: "utf8",
    });
    expect(generated).toContain('CREATE TABLE "public"."ChannelEventInbox"');
    expect(migration).toContain('ALTER TABLE "public"."ChannelInstallation"');
    expect(migration).toContain('CREATE TABLE "public"."ChannelEventInbox"');
    expect(migration).toContain('CREATE TRIGGER "ChannelEventInbox_identity_immutable"');
    expect(migration).toContain('CONSTRAINT "ChannelEventInbox_status_check"');
    expect(migration).toContain(
      'CONSTRAINT "ChannelInstallation_tokenRefreshState_check"'
    );
    expect(migration).toContain('ADD COLUMN "quarantinedAt" TIMESTAMP(3)');
    expect(migration).toContain('ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1');
    expect(migration).toContain('"memoryFeedbackBackfillCompletedAt" TIMESTAMP(3)');
    expect(migration).toContain("MessageRating thumbs preflight failed");
    expect(migration).toContain("rating=2:%s, rating=3:%s, rating=4:%s, rating=5:%s");
    const feedbackSection = migration.indexOf(
      "-- Memory feedback quarantine and thumbs-feedback constraints"
    );
    expect(migration.indexOf("DO $$", feedbackSection)).toBeLessThan(
      migration.indexOf('ALTER TABLE "public"."Memory"', feedbackSection)
    );
    expect(migration).toContain('CHECK ("rating" IN (-1, 1))');
    expect(migration).toContain(
      'CREATE INDEX "Memory_environmentId_endUserId_quarantinedAt_idx"'
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "MemoryEntity_standalone_agent_entityKey_key"'
    );
    expect(migration).toContain('WHERE "clusterId" IS NULL');
    expect(migration).toContain(
      'CREATE FUNCTION "public"."enforce_memory_entity_owner_transition"()'
    );
    expect(migration).toContain('DROP TRIGGER "MemoryEntity_owner_immutable"');
    expect(migration).toContain('CREATE FUNCTION "public"."enforce_domain_ancestry"()');
    expect(migration).toContain('CREATE FUNCTION "public"."reject_canonical_owner_change"()');
    expect(migration).toContain('CREATE FUNCTION "public"."revoke_operator_sessions_for_membership_change"()');
    expect(migration).toContain('CREATE FUNCTION "public"."reject_impersonation_audit_mutation"()');
    expect(migration).toContain('CREATE FUNCTION "public"."reject_credential_audit_mutation"()');
    expect(migration).toContain('CREATE FUNCTION "public"."reject_admin_audit_mutation"()');
    for (const operation of ["update", "delete", "truncate"]) {
      expect(migration).toContain(`CREATE TRIGGER "AdminAudit_immutable_${operation}"`);
    }
    expect(migration).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "public"."AdminAudit" FROM PUBLIC'
    );
    expect(migration).toContain('CREATE UNIQUE INDEX "AccessKey_one_active_per_environment"');
    expect(migration).toContain('WHERE "revokedAt" IS NULL AND "validUntil" IS NULL');
    expect(migration).toContain('CONSTRAINT "OperatorSession_tokenHash_check"');
    expect(migration).toContain('OR "impersonatedUserId" = affected_user_id');
    for (const expected of [
      'CONSTRAINT "EnvironmentVariable_value_shape_check"',
      'CONSTRAINT "AlertChannelConfiguration_shape_check"',
      'CONSTRAINT "AlertDelivery_state_check"',
      'CREATE TRIGGER "EnvironmentVariable_credential_kind"',
      'CREATE TRIGGER "AlertChannelConfiguration_credential_kind"',
      'CREATE TRIGGER "AlertDeliveryAttempt_immutable_update"',
      'CREATE TRIGGER "AlertDeliveryAttempt_immutable_delete"',
      'CREATE TRIGGER "AlertDeliveryAttempt_immutable_truncate"',
      'CREATE UNIQUE INDEX "BudgetThresholdEvent_budgetId_windowKey_threshold_key"',
      'CREATE UNIQUE INDEX "AlertDelivery_budgetThresholdEventId_channelId_key"',
    ]) {
      expect(migration).toContain(expected);
    }
    for (const trigger of [
      "EndUserIdentity_owner_immutable",
      "Thread_subject_immutable",
      "MessageAttachment_owner_immutable",
      "ChannelInstallation_owner_immutable",
      "OAuthClient_owner_immutable",
      "MemoryEntity_subject_immutable",
    ]) {
      expect(migration).toContain(`CREATE TRIGGER \"${trigger}\"`);
    }
  });

  test("limits the generated end-user graph to subject-reachable data", () => {
    const models = EndUserPrisma.dmmf.datamodel.models;
    expect(models.map((model) => model.name).sort()).toEqual(expectedEndUserModels);

    const relationTargets = new Set(
      models.flatMap((model) =>
        model.fields.filter((field) => field.kind === "object").map((field) => field.type)
      )
    );
    expect([...relationTargets].every((target) => expectedEndUserModels.includes(target))).toBe(true);

    const forbidden = [
      "User",
      "Organization",
      "Project",
      "Environment",
      "Agent",
      "AgentVersion",
      "Credential",
      "EnvironmentVariable",
      "AlertChannel",
      "AlertChannelConfiguration",
      "BudgetThresholdEvent",
      "AlertDelivery",
      "AlertDeliveryAttempt",
      "Entity",
      "Tool",
      "AdminAudit",
      "ErasureOperation",
    ];
    for (const model of forbidden) expect(relationTargets.has(model)).toBe(false);
    expect(endUserDelegateNames).toHaveLength(expectedEndUserModels.length);
  });
});
