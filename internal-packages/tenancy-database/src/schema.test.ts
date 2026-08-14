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
const customMigrationMarker = "-- Prisma-inexpressible value constraints.";

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
    expect(models).toHaveLength(77);
    expect(domainModelNames).toHaveLength(61);
    expect(new Set(domainModelNames).size).toBe(61);
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

  test("accounts for all 54 source models exactly once", () => {
    const sourceModels = [...sourceSchema.matchAll(/^model (Platos\w+) \{/gm)].map((match) => match[1]);
    const manifestSources = sourceModelManifest.map((entry) => entry.source);
    const controlModels = new Set(ControlPrisma.dmmf.datamodel.models.map((model) => model.name));

    expect(sourceModels).toHaveLength(54);
    expect(manifestSources).toHaveLength(54);
    expect(new Set(manifestSources).size).toBe(54);
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
      ProviderKey: ["environmentId", "provider", "environmentKeyName", "isDefault"],
      McpToken: ["environmentId", "mintedByUserId", "permissions", "tier"],
      PersonalAccessToken: ["userId", "scopeKind", "organizationId", "projectId", "environmentId"],
      OAuthAuthorizationCode: ["clientId", "userId", "scopeKind", "organizationId", "projectId", "environmentId"],
      OAuthAccessToken: ["clientId", "userId", "scopeKind", "scopes"],
      OAuthRefreshToken: ["accessTokenId", "rotationFamilyId", "parentRefreshTokenId", "consumedAt", "replayDetectedAt"],
      McpBearerToken: ["entityId", "mcpUserId", "createdByUserId", "scopes"],
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

  test("generates one migration from empty before custom checks and triggers", () => {
    const migrationDirectories = readdirSync(resolve(packageRoot, "prisma/migrations"), {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory());
    expect(migrationDirectories.map((entry) => entry.name)).toEqual(["00000000000000_initial"]);

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
    expect(migration.split(customMigrationMarker)[0].trim()).toBe(generated.trim());
    expect(migration).toContain('CREATE FUNCTION "public"."enforce_domain_ancestry"()');
    expect(migration).toContain('CREATE FUNCTION "public"."reject_canonical_owner_change"()');
    expect(migration).toContain('CREATE FUNCTION "public"."revoke_operator_sessions_for_membership_change"()');
    expect(migration).toContain('CREATE FUNCTION "public"."reject_impersonation_audit_mutation"()');
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
      "ErasureOperation",
    ];
    for (const model of forbidden) expect(relationTargets.has(model)).toBe(false);
    expect(endUserDelegateNames).toHaveLength(expectedEndUserModels.length);
  });
});
