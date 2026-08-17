import { createHash } from "node:crypto";
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
const sourceSchema = readFileSync(resolve(packageRoot, "legacy-prisma/schema.prisma"), "utf8");
const initialMigration = readFileSync(
  resolve(packageRoot, "prisma/migrations/00000000000000_initial/migration.sql"),
  "utf8"
);
const uploadReservationMigration = readFileSync(
  resolve(packageRoot, "prisma/migrations/20260817000000_add_upload_reservations/migration.sql"),
  "utf8"
);
const tokenLifecycleAuditMigration = readFileSync(
  resolve(packageRoot, "prisma/migrations/20260817010000_add_token_lifecycle_audit/migration.sql"),
  "utf8"
);
const attachmentByteReconciliationMigration = readFileSync(
  resolve(packageRoot, "prisma/migrations/20260817020000_add_attachment_byte_reconciliation/migration.sql"),
  "utf8"
);
const externalCutoverReconciliationMigration = readFileSync(
  resolve(packageRoot, "prisma/migrations/20260817030000_add_external_cutover_reconciliation/migration.sql"),
  "utf8"
);
const disposableExternalRehearsalMigration = readFileSync(
  resolve(packageRoot, "prisma/migrations/20260817040000_enable_disposable_external_rehearsal_report/migration.sql"),
  "utf8"
);
const duplicateExternalObjectReferenceMigration = readFileSync(
  resolve(packageRoot, "prisma/migrations/20260817050000_allow_duplicate_external_object_references/migration.sql"),
  "utf8"
);
const externalWriterFencePlanMigration = readFileSync(
  resolve(packageRoot, "prisma/migrations/20260817060000_add_external_writer_fence_plan/migration.sql"),
  "utf8"
);
const migration = `${initialMigration}\n${uploadReservationMigration}\n${tokenLifecycleAuditMigration}\n${attachmentByteReconciliationMigration}\n${externalCutoverReconciliationMigration}\n${disposableExternalRehearsalMigration}\n${duplicateExternalObjectReferenceMigration}\n${externalWriterFencePlanMigration}`;

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
  "AttachmentUploadReservation",
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
    expect(models).toHaveLength(85);
    expect(domainModelNames).toHaveLength(68);
    expect(new Set(domainModelNames).size).toBe(68);
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
    const sqlDeletePolicies = migration.match(/ ON DELETE (CASCADE|SET NULL|RESTRICT|NO ACTION)/g) ?? [];
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
      User: ["avatarUrl", "dashboardPreferences"],
      AttachmentUploadReservation: [
        "environmentId",
        "uploadedByUserId",
        "uploadedByEndUserId",
        "messageAttachmentId",
        "expiresAt",
        "claimedAt",
      ],
      AccessKey: ["environmentId", "keyPrefix", "keyHash", "allowedOrigins"],
      ProviderKey: ["environmentId", "credentialId", "provider", "environmentKeyName", "isDefault"],
      Credential: ["environmentId", "activeSecretVersionId"],
      CredentialSecretVersion: ["credentialId", "secretRevision", "rootKeyVersion", "ciphertext"],
      CredentialAudit: ["environmentId", "credentialId", "action", "outcome", "actorType"],
      TokenLifecycleAudit: [
        "family",
        "personalAccessTokenId",
        "mcpTokenId",
        "scopeKind",
        "actorUserId",
        "action",
        "outcome",
      ],
      ExternalCutoverRun: [
        "idempotencyKey",
        "attempt",
        "status",
        "manifestSha256",
        "report",
      ],
      ExternalCutoverEvidence: [
        "runId",
        "runAttempt",
        "sequence",
        "domain",
        "action",
        "outcome",
        "expectedMetadata",
        "observedMetadata",
      ],
      ObjectKeyReconciliation: [
        "runId",
        "runAttempt",
        "metadataModel",
        "metadataRowId",
        "attempt",
        "sourceObjectKeySha256",
        "targetObjectKeySha256",
        "expectedMetadata",
        "observedMetadata",
      ],
      McpToken: ["environmentId", "mintedByUserId", "permissions", "tier"],
      PersonalAccessToken: ["userId", "scopeKind", "organizationId", "projectId", "environmentId"],
      OAuthAuthorizationCode: ["clientId", "userId", "scopeKind", "organizationId", "projectId", "environmentId"],
      OAuthAccessToken: ["clientId", "userId", "scopeKind", "scopes"],
      OAuthRefreshToken: ["accessTokenId", "rotationFamilyId", "parentRefreshTokenId", "consumedAt", "replayDetectedAt"],
      McpBearerToken: ["entityId", "mcpUserId", "createdByUserId", "scopes"],
      Thread: ["compactedUpToTurnId", "compactionState", "compactedAt"],
      Turn: ["agentVersionId", "versionBucket", "costCents", "latencyMs"],
      Step: [
        "cacheCreationInputTokens",
        "cacheReadInputTokens",
        "reasoningTokens",
        "costCents",
        "latencyMs",
      ],
      Memory: [
        "agentId",
        "clusterId",
        "sourceThreadId",
        "sourceTurnIds",
        "extractorVersion",
        "contentHash",
      ],
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
    expect(migration).toContain('CONSTRAINT "TokenLifecycleAudit_reference_shape_check"');
    expect(migration).toContain('CONSTRAINT "TokenLifecycleAudit_scope_shape_check"');
    expect(migration).toContain('CREATE TRIGGER "TokenLifecycleAudit_scope_match"');
    expect(migration).toContain('CREATE TRIGGER "TokenLifecycleAudit_immutable_update"');
    expect(migration).toContain('CREATE TRIGGER "TokenLifecycleAudit_immutable_delete"');
    expect(migration).toContain('CREATE TRIGGER "TokenLifecycleAudit_immutable_truncate"');
    expect(migration).toContain('REVOKE UPDATE, DELETE, TRUNCATE\nON TABLE "public"."TokenLifecycleAudit"');
    expect([...fields("TokenLifecycleAudit")]).not.toEqual(
      expect.arrayContaining(["token", "tokenHash", "ciphertext", "nonce", "authTag"])
    );
    expect([...fields("ObjectKeyReconciliation")]).not.toEqual(
      expect.arrayContaining(["sourceObjectKey", "targetObjectKey", "storageKey", "rawKey"])
    );
    expect(externalCutoverReconciliationMigration).toContain(
      'CREATE TYPE "public"."ExternalCutoverStatus"'
    );
    expect(externalCutoverReconciliationMigration).toContain(
      'CREATE TYPE "public"."ExternalCutoverDomain"'
    );
    expect(externalCutoverReconciliationMigration).toContain(
      'CREATE TYPE "public"."ExternalCutoverAction"'
    );
    expect(externalCutoverReconciliationMigration).toContain(
      'CREATE TYPE "public"."ExternalCutoverOutcome"'
    );
    expect(externalCutoverReconciliationMigration).toContain(
      'CONSTRAINT "ObjectKeyReconciliation_source_key_sha256_check"'
    );
    expect(externalCutoverReconciliationMigration).toContain(
      'CONSTRAINT "ExternalCutoverRun_report_check"'
    );
    expect(disposableExternalRehearsalMigration).toContain(
      'CREATE FUNCTION "public"."external_cutover_disposable_rehearsal_report_is_valid"'
    );
    expect(duplicateExternalObjectReferenceMigration).toContain(
      'DROP INDEX "public"."ObjectKeyReconciliation_runId_sourceObjectKeySha256_targetO_key"'
    );
    expect(disposableExternalRehearsalMigration).toContain(
      '"status" = \'ROLLED_BACK\' AND "report" ->> \'implementation\' = \'DISPOSABLE_REHEARSAL\''
    );
    expect(disposableExternalRehearsalMigration).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE\nON TABLE "public"."ExternalCutoverRun", "public"."ExternalCutoverEvidence", "public"."ObjectKeyReconciliation"'
    );
    expect(externalCutoverReconciliationMigration).not.toMatch(
      /"sourceObjectKey"\s+TEXT|"targetObjectKey"\s+TEXT|"storageKey"\s+TEXT/
    );
    for (const model of [
      "ExternalCutoverRun",
      "ExternalCutoverEvidence",
      "ObjectKeyReconciliation",
    ]) {
      for (const operation of ["update", "delete", "truncate"]) {
        expect(externalCutoverReconciliationMigration).toContain(
          `CREATE TRIGGER \"${model}_immutable_${operation}\"`
        );
      }
    }
    expect(externalCutoverReconciliationMigration).toContain(
      'ON TABLE "public"."ExternalCutoverRun", "public"."ExternalCutoverEvidence", "public"."ObjectKeyReconciliation"'
    );
    expect(migration).toContain('CONSTRAINT "OAuthRefreshToken_scope_shape_check"');
    expect(migration).toContain('CREATE UNIQUE INDEX "ProviderKey_one_default_per_environment_provider"');
    expect(migration).toContain('WHERE "isDefault" = TRUE');
    expect(migration).toContain('CREATE TRIGGER "ProviderKey_executable_reference"');
    expect(migration).toContain('CREATE TRIGGER "AttachmentUploadReservation_lifecycle"');
    expect(migration).toContain('CREATE TRIGGER "MessageAttachment_claimed_lifecycle"');
    expect(migration).toContain('CREATE FUNCTION "public"."reconcile_attachment_upload_bytes"');
    expect(attachmentByteReconciliationMigration).toContain("pg_advisory_xact_lock");
    expect(attachmentByteReconciliationMigration).toContain(
      "Attachment upload quota exceeded during byte reconciliation"
    );
    expect(attachmentByteReconciliationMigration).toContain(
      'ON FUNCTION "public"."reconcile_attachment_upload_bytes"'
    );
    expect(attachmentByteReconciliationMigration).toContain("FROM PUBLIC");
    expect(attachmentByteReconciliationMigration).not.toContain('SET "storageKey"');
    expect(fields("AttachmentUploadReservation").has("organizationId")).toBe(false);
    expect(fields("AttachmentUploadReservation").has("projectId")).toBe(false);
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
      'CREATE TRIGGER "Turn_ancestry"',
      'CREATE TRIGGER "MemoryRelationship_owner_immutable"',
    ]) {
      expect(migration).toContain(expected);
    }
    expect(initialMigration).not.toContain("ClickHouse");
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

  test("preserves the clean initial migration and appends sequential migrations", () => {
    const migrationDirectories = readdirSync(resolve(packageRoot, "prisma/migrations"), {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory());
    expect(migrationDirectories.map((entry) => entry.name)).toEqual([
      "00000000000000_initial",
      "20260817000000_add_upload_reservations",
      "20260817010000_add_token_lifecycle_audit",
      "20260817020000_add_attachment_byte_reconciliation",
      "20260817030000_add_external_cutover_reconciliation",
      "20260817040000_enable_disposable_external_rehearsal_report",
      "20260817050000_allow_duplicate_external_object_references",
      "20260817060000_add_external_writer_fence_plan",
    ]);
    expect(externalWriterFencePlanMigration).toContain(
      'CREATE TABLE "public"."ExternalClickHouseWriterGrant"'
    );
    expect(createHash("sha256").update(initialMigration).digest("hex"))
      .toBe("ef1675ae7a79e3a426829892201a96c809cc2700a16426c24d69a14036dc383a");
    expect(uploadReservationMigration).toContain('CREATE TABLE "public"."AttachmentUploadReservation"');
    expect(uploadReservationMigration).not.toMatch(/"organizationId" UUID|"projectId" UUID/);
    expect(tokenLifecycleAuditMigration).toContain('CREATE TABLE "public"."TokenLifecycleAudit"');
    expect(tokenLifecycleAuditMigration).not.toMatch(/"token"|"tokenHash"|"ciphertext"|"authTag"/);
    expect(externalCutoverReconciliationMigration).toContain(
      'CREATE TABLE "public"."ExternalCutoverRun"'
    );
    expect(externalCutoverReconciliationMigration).toContain(
      'CREATE TABLE "public"."ExternalCutoverEvidence"'
    );
    expect(externalCutoverReconciliationMigration).toContain(
      'CREATE TABLE "public"."ObjectKeyReconciliation"'
    );
    expect(migration).toContain('CREATE FUNCTION "public"."enforce_domain_ancestry"()');
    expect(migration).toContain('CREATE FUNCTION "public"."reject_canonical_owner_change"()');
    expect(migration).toContain('CREATE FUNCTION "public"."revoke_operator_sessions_for_membership_change"()');
    expect(migration).toContain('CREATE FUNCTION "public"."reject_impersonation_audit_mutation"()');
    expect(migration).toContain('CREATE FUNCTION "public"."reject_credential_audit_mutation"()');
    expect(migration).toContain('CREATE UNIQUE INDEX "AccessKey_one_active_per_environment"');
    expect(migration).toContain('WHERE "revokedAt" IS NULL AND "validUntil" IS NULL');
    expect(migration).toContain('CONSTRAINT "OperatorSession_tokenHash_check"');
    expect(migration).toContain('OR "impersonatedUserId" = affected_user_id');
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
      "Entity",
      "Tool",
      "AdminAudit",
      "TokenLifecycleAudit",
      "ExternalCutoverRun",
      "ExternalCutoverEvidence",
      "ObjectKeyReconciliation",
      "ErasureOperation",
    ];
    for (const model of forbidden) expect(relationTargets.has(model)).toBe(false);
    expect(endUserDelegateNames).toHaveLength(expectedEndUserModels.length);
  });
});
