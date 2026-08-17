import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { Prisma as ControlPrisma } from "../generated/control";
import { describe, expect, test } from "vitest";
import {
  aggregateCredentialPayloadContracts,
  assembleCredentialPayload,
  cutoverConservationEquations,
  cryptographicFieldLedger,
  cutoverValidationQueries,
  evaluateConservationEquation,
  findOmittedSourceIdentities,
  legacyAdditionalPhysicalObjectLedger,
  legacyEnumDispositionLedger,
  legacyFunctionDispositionLedger,
  legacyIndexDispositionLedger,
  legacyModelDispositionLedger,
  legacyPhysicalTableDispositionLedger,
  legacyTriggerDispositionLedger,
  messageMixedEncodingContracts,
  sourceValidationManifest,
  type CredentialPayloadComponent,
} from "./cutover-ledger";
import {
  auditFieldTransformationManifest,
  requiredTargetFieldManifest,
  sourceFieldTransformationManifest,
  sourceIdentityTransformManifest,
  sourceJsonTransformManifest,
  sourceModelManifest,
  sourceOwnershipDerivationManifest,
  sourceRequiredDefaultPolicyManifest,
} from "./source-model-manifest";

const packageRoot = resolve(__dirname, "..");
const legacyPackageRoot = resolve(packageRoot, "../database");
const legacyPrismaRoot = resolve(legacyPackageRoot, "legacy-prisma");
const legacySchemaPath = resolve(legacyPrismaRoot, "schema.prisma");
const legacySchema = readFileSync(legacySchemaPath, "utf8");
const controlSchema = readFileSync(resolve(packageRoot, "prisma/schema.prisma"), "utf8");
const controlModels = new Map(
  ControlPrisma.dmmf.datamodel.models.map((model) => [model.name, model] as const)
);

function prismaBlocks(kind: "model" | "enum"): Map<string, string> {
  return new Map(
    [...legacySchema.matchAll(new RegExp(`^${kind} (\\w+) \\{([\\s\\S]*?)^\\}`, "gm"))].map(
      (match) => [match[1]!, match[2]!] as const
    )
  );
}

const legacyModels = prismaBlocks("model");
const legacyEnums = prismaBlocks("enum");

function legacyFieldExists(path: string): boolean {
  const [modelName, fieldName] = path.split(".");
  const block = legacyModels.get(modelName!);
  return Boolean(block?.match(new RegExp(`^\\s*${fieldName}\\s`, "m")));
}

function controlFieldExists(path: string): boolean {
  const [modelName, fieldName] = path.split(".");
  if (controlModels.get(modelName!)?.fields.some((field) => field.name === fieldName)) return true;
  const block = controlSchema.match(
    new RegExp(`^model ${modelName} \\{([\\s\\S]*?)^\\}`, "m")
  )?.[1];
  return Boolean(block?.match(new RegExp(`^\\s*${fieldName}\\s`, "m")));
}

function legacyScalarFieldPaths(modelNames: ReadonlySet<string>): string[] {
  return [...modelNames].flatMap((modelName) => {
    const block = legacyModels.get(modelName)!;
    return block.split("\n").flatMap((line) => {
      const field = line.match(/^\s+(\w+)\s+([A-Za-z]\w*)(?:\[\]|\?)?/);
      if (!field || legacyModels.has(field[2]!)) return [];
      return [`${modelName}.${field[1]}`];
    });
  });
}

function requiredControlFieldPaths(modelNames: ReadonlySet<string>): string[] {
  return [...modelNames].flatMap((modelName) =>
    (controlModels.get(modelName)?.fields ?? [])
      .filter((field) => field.kind !== "object" && field.isRequired)
      .map((field) => `${modelName}.${field.name}`)
  );
}

function generatedLegacySql(): string {
  return execFileSync(
    resolve(packageRoot, "node_modules/.bin/prisma"),
    ["migrate", "diff", "--from-empty", "--to-schema-datamodel", legacySchemaPath, "--script"],
    {
      cwd: packageRoot,
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://generate:generate@localhost:5432/generate",
        DIRECT_URL: "postgresql://generate:generate@localhost:5432/generate",
      },
      encoding: "utf8",
    }
  );
}

function generatedIndexNames(sql: string): string[] {
  const indexes = [
    ...sql.matchAll(/^CREATE (?:UNIQUE )?INDEX "([^"]+)" ON "public"\."[^"]+"/gm),
  ].map((match) => match[1]!);
  for (const table of sql.matchAll(/^CREATE TABLE "public"\."[^"]+" \(([\s\S]*?)^\);/gm)) {
    const primaryKey = table[1]!.match(/CONSTRAINT "([^"]+)" PRIMARY KEY/);
    if (primaryKey) indexes.push(primaryKey[1]!);
  }
  return indexes.sort();
}

describe("WIN-123 inherited cutover ledgers", () => {
  test("classifies every inherited Prisma model and physical table exactly once", () => {
    const schemaModels = [...legacyModels.keys()].sort();
    const ledgerModels = legacyModelDispositionLedger.map((entry) => entry.sourceModel);
    expect(schemaModels).toHaveLength(124);
    expect(ledgerModels).toHaveLength(124);
    expect(new Set(ledgerModels).size).toBe(124);
    expect([...ledgerModels].sort()).toEqual(schemaModels);

    expect(
      Object.fromEntries(
        ["BACKFILL", "EXPORT_DROP", "EPHEMERAL_DROP"].map((disposition) => [
          disposition,
          legacyModelDispositionLedger.filter((entry) => entry.disposition === disposition).length,
        ])
      )
    ).toEqual({ BACKFILL: 64, EXPORT_DROP: 58, EPHEMERAL_DROP: 2 });

    const generatedTables = [
      ...generatedLegacySql().matchAll(/^CREATE TABLE "public"\."([^"]+)"/gm),
    ].map((match) => match[1]!);
    generatedTables.push("_prisma_migrations");
    const ledgerTables = legacyPhysicalTableDispositionLedger.map((entry) => entry.name);
    expect(ledgerTables).toHaveLength(130);
    expect(new Set(ledgerTables).size).toBe(130);
    expect([...ledgerTables].sort()).toEqual(generatedTables.sort());

    expect(
      legacyAdditionalPhysicalObjectLedger.filter((entry) => entry.kind === "IMPLICIT_JOIN_TABLE")
    ).toHaveLength(5);
  });

  test("pins all enums and the replayed physical index catalog", () => {
    expect(legacyEnumDispositionLedger).toHaveLength(44);
    expect(new Set(legacyEnumDispositionLedger.map((entry) => entry.name)).size).toBe(44);
    expect(legacyEnumDispositionLedger.map((entry) => entry.name).sort()).toEqual(
      [...legacyEnums.keys()].sort()
    );

    const catalogNames = legacyIndexDispositionLedger.map((entry) => entry.name);
    expect(catalogNames).toHaveLength(458);
    expect(new Set(catalogNames).size).toBe(458);
    expect(legacyIndexDispositionLedger.every((entry) => entry.disposition !== undefined)).toBe(
      true
    );

    // These exact deltas distinguish the real 849-migration replay catalog
    // from a merely generated datamodel. They include the concurrent partial
    // indexes and historical names that remain physically present.
    const generatedNames = generatedIndexNames(generatedLegacySql());
    const generatedSet = new Set<string>(generatedNames);
    const catalogSet = new Set<string>(catalogNames);
    expect(catalogNames.filter((name) => !generatedSet.has(name))).toEqual([
      "PlatosAgentApproval_scope_agentId_idx",
      "PlatosAgentApproval_scope_approvalId_key",
      "PlatosAgentApproval_scope_createdAt_idx",
      "PlatosAgentApproval_scope_status_createdAt_idx",
      "PlatosAgentApproval_scope_threadId_idx",
      "PlatosAgentEval_scope_agent_createdAt_idx",
      "PlatosAgentEval_scope_criterion_idx",
      "PlatosAgentEval_scope_version_idx",
      "PlatosAgentThread_env_status_idx",
      "PlatosBudgetCap_scope_idx",
      "PlatosBudgetCap_scope_scopeType_idx",
      "PlatosBudgetCap_scope_target_period_key",
      "PlatosEvalCriterion_scope_agentId_idx",
      "PlatosEvalCriterion_scope_idx",
      "PlatosGoldenSet_scope_agentId_idx",
      "PlatosMemory_archivedAt_idx",
      "PlatosMessageRating_scope_agentId_idx",
      "PlatosMessageRating_scope_agentVersionId_idx",
      "PlatosProviderKey_orgProjEnvProviderEnvVar_key",
      "PlatosProviderKey_orgProjEnv_isDefault_idx",
      "PlatosProviderKey_orgProjEnv_provider_idx",
      "PlatosSafetyEvent_scope_agentId_idx",
      "PlatosSafetyEvent_scope_createdAt_idx",
      "PlatosSafetyEvent_scope_detector_idx",
      "PlatosSafetyEvent_scope_threadId_idx",
      "PlatosTask_orgProjEnvTaskId_key",
      "PlatosTask_orgProjEnv_idx",
      "PlatosToolCallAudit_scope_agentId_idx",
      "PlatosToolCallAudit_scope_createdAt_idx",
      "PlatosToolCallAudit_scope_status_idx",
      "PlatosToolCallAudit_scope_threadId_idx",
      "PlatosToolCallAudit_scope_toolName_idx",
      "TaskRunWaitpoint_taskRunId_waitpointId_batchIndex_null_key",
      "_prisma_migrations_pkey",
      "platos_mem_embedding_hnsw",
    ]);
    expect(generatedNames.filter((name) => !catalogSet.has(name))).toEqual([
      "PlatosAgentApproval_organizationId_projectId_environmentId__key",
      "PlatosProviderKey_organizationId_projectId_environmentId_is_idx",
      "PlatosProviderKey_organizationId_projectId_environmentId_pr_idx",
      "PlatosProviderKey_organizationId_projectId_environmentId_pr_key",
      "PlatosTask_organizationId_projectId_environmentId_idx",
      "PlatosTask_organizationId_projectId_environmentId_taskId_key",
      "platos_agent_eval_scope_agent_createdAt_idx",
      "platos_agent_eval_scope_crit_idx",
      "platos_agent_eval_scope_ver_idx",
      "platos_approval_scope_agent_idx",
      "platos_approval_scope_createdAt_idx",
      "platos_approval_scope_status_createdAt_idx",
      "platos_approval_scope_thread_idx",
      "platos_budget_cap_scope_idx",
      "platos_budget_cap_scope_type_idx",
      "platos_eval_crit_scope_agent_idx",
      "platos_eval_crit_scope_idx",
      "platos_golden_set_scope_agent_idx",
      "platos_msg_rating_scope_agent_idx",
      "platos_msg_rating_scope_ver_idx",
      "platos_safety_scope_agent_idx",
      "platos_safety_scope_createdAt_idx",
      "platos_safety_scope_detector_idx",
      "platos_safety_scope_thread_idx",
      "platos_tool_audit_scope_agent_idx",
      "platos_tool_audit_scope_createdAt_idx",
      "platos_tool_audit_scope_status_idx",
      "platos_tool_audit_scope_thread_idx",
      "platos_tool_audit_scope_tool_idx",
    ]);
  });

  test("accounts for migration history and proves no application function or trigger", () => {
    const migrations = readdirSync(resolve(legacyPrismaRoot, "migrations"), {
      withFileTypes: true,
    }).filter((entry) => entry.isDirectory());
    expect(migrations).toHaveLength(849);

    const migrationSql = migrations
      .map((entry) =>
        readFileSync(resolve(legacyPrismaRoot, "migrations", entry.name, "migration.sql"), "utf8")
      )
      .join("\n");
    expect(migrationSql).not.toMatch(/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i);
    expect(migrationSql).not.toMatch(/\bCREATE\s+TRIGGER\b/i);
    expect(legacyFunctionDispositionLedger).toHaveLength(0);
    expect(legacyTriggerDispositionLedger).toHaveLength(0);
    expect(legacyAdditionalPhysicalObjectLedger).toContainEqual({
      kind: "MIGRATION_HISTORY",
      name: "_prisma_migrations",
      disposition: "EXPORT_DROP",
    });
  });

  test("generates real source counts, visible mapping anti-joins, and conservation equations", () => {
    expect(sourceIdentityTransformManifest).toHaveLength(55);
    expect(sourceOwnershipDerivationManifest).toHaveLength(55);
    expect(sourceRequiredDefaultPolicyManifest).toHaveLength(55);
    expect(sourceValidationManifest).toHaveLength(64);
    expect(sourceValidationManifest.map((entry) => entry.sourceModel).sort()).toEqual(
      legacyModelDispositionLedger
        .filter((entry) => entry.disposition === "BACKFILL")
        .map((entry) => entry.sourceModel)
        .sort()
    );
    expect(
      new Set(sourceIdentityTransformManifest.map((entry) => entry.source.split(".")[0]))
    ).toEqual(new Set(sourceModelManifest.map((entry) => entry.source)));

    for (const identity of sourceIdentityTransformManifest) {
      expect(legacyFieldExists(identity.source), identity.source).toBe(true);
      for (const target of identity.targets) {
        expect(controlFieldExists(target.field), target.field).toBe(true);
        if (target.transform === "UUID_V5_SPLIT") expect(target.suffix).toBeTruthy();
      }
    }
    for (const validation of sourceValidationManifest) {
      expect(legacyFieldExists(`${validation.sourceModel}.${validation.identityField}`)).toBe(true);
      expect(validation.sourceCountSql).toContain(
        `FROM cutover_legacy."${validation.physicalTable}"`
      );
      expect(validation.sourceCountSql).not.toContain("information_schema");
      expect(validation.omittedMappingsSql).toContain("NOT EXISTS");
      expect(validation.omittedMappingsSql).toContain("source_id");
    }

    expect(
      findOmittedSourceIdentities(
        "Organization",
        ["org-c", "org-a", "org-b"],
        [
          { sourceModel: "Organization", sourceId: "org-a" },
          { sourceModel: "Organization", sourceId: "org-c" },
          { sourceModel: "User", sourceId: "org-b" },
        ]
      )
    ).toEqual(["org-b"]);

    expect(new Set(cutoverConservationEquations.map((entry) => entry.kind))).toEqual(
      new Set(["ONE_TO_ONE", "SPLIT", "MERGE"])
    );
    const oneToOne = cutoverConservationEquations.find((entry) => entry.kind === "ONE_TO_ONE")!;
    expect(
      evaluateConservationEquation(oneToOne, {
        source_organizations: 17n,
        target_organizations: 17n,
      })
    ).toEqual({ sourceCount: 17n, targetCount: 17n, delta: 0n });
    const split = cutoverConservationEquations.find((entry) => entry.kind === "SPLIT")!;
    expect(
      evaluateConservationEquation(split, {
        source_agents: 7n,
        target_agents: 7n,
        target_agent_bindings: 6n,
      })
    ).toEqual({ sourceCount: 14n, targetCount: 13n, delta: 1n });
    const merge = cutoverConservationEquations.find((entry) => entry.kind === "MERGE")!;
    expect(
      evaluateConservationEquation(merge, {
        source_joined_secrets: 11n,
        target_secret_versions: 9n,
      })
    ).toEqual({ sourceCount: 11n, targetCount: 9n, delta: 2n });

    for (const validation of [...sourceValidationManifest, ...cutoverValidationQueries]) {
      for (const sql of Object.entries(validation)
        .filter(([key]) => key.endsWith("Sql") || key === "sql")
        .map(([, value]) => value)) {
        expect(sql).toMatch(/^SELECT /);
        expect(sql).not.toContain(";");
      }
    }
    for (const equation of cutoverConservationEquations) {
      expect(equation.sql).toMatch(/^WITH /);
      expect(equation.sql).not.toContain(";");
    }
  });

  test("disposes every BACKFILL scalar field once and satisfies every required target", () => {
    const backfillModels = new Set(
      legacyModelDispositionLedger
        .filter((entry) => entry.disposition === "BACKFILL")
        .map((entry) => entry.sourceModel)
    );
    const targetModels = new Set(
      legacyModelDispositionLedger
        .filter((entry) => entry.disposition === "BACKFILL")
        .flatMap((entry) => entry.targets)
    );
    const expectedSourceFields = legacyScalarFieldPaths(backfillModels);
    const requiredTargetFields = requiredControlFieldPaths(targetModels);

    expect(sourceFieldTransformationManifest).toHaveLength(expectedSourceFields.length);
    expect(
      Object.fromEntries(
        ["TRANSFORM", "COPY", "EXPORT", "DROP"].map((disposition) => [
          disposition,
          sourceFieldTransformationManifest.filter((entry) => entry.disposition === disposition)
            .length,
        ])
      )
    ).toEqual({ TRANSFORM: 304, COPY: 335, EXPORT: 259, DROP: 1 });
    expect(requiredTargetFieldManifest).toHaveLength(requiredTargetFields.length);
    expect(auditFieldTransformationManifest(expectedSourceFields, requiredTargetFields)).toEqual(
      []
    );

    const userAvatar = sourceFieldTransformationManifest.find(
      (entry) => entry.sourceModel === "User" && entry.sourceField === "avatarUrl"
    );
    const userPreferences = sourceFieldTransformationManifest.find(
      (entry) => entry.sourceModel === "User" && entry.sourceField === "dashboardPreferences"
    );
    expect(userAvatar).toMatchObject({
      disposition: "TRANSFORM",
      targetFields: ["User.avatarUrl"],
    });
    expect(userPreferences).toMatchObject({
      disposition: "TRANSFORM",
      targetFields: ["User.dashboardPreferences"],
    });

    for (const transform of sourceJsonTransformManifest) {
      expect(legacyFieldExists(transform.source), transform.source).toBe(true);
      expect(controlFieldExists(transform.target), transform.target).toBe(true);
      expect(transform.invalidPolicy).toBe("BLOCK_CUTOVER");
    }
    for (const entry of sourceFieldTransformationManifest) {
      expect(legacyFieldExists(`${entry.sourceModel}.${entry.sourceField}`)).toBe(true);
      for (const target of entry.targetFields)
        expect(controlFieldExists(target), target).toBe(true);
    }
    for (const requirement of requiredTargetFieldManifest) {
      expect(controlFieldExists(requirement.targetField), requirement.targetField).toBe(true);
      if (requirement.deterministicDefault) {
        expect(requirement.deterministicDefault).not.toMatch(/uuid\(|now\(/i);
      }
    }

    const [firstSource] = sourceFieldTransformationManifest;
    expect(
      auditFieldTransformationManifest(
        expectedSourceFields,
        requiredTargetFields,
        sourceFieldTransformationManifest.slice(1),
        requiredTargetFieldManifest
      )
    ).toContain(
      `missing_source_disposition:${firstSource!.sourceModel}.${firstSource!.sourceField}`
    );
    expect(
      auditFieldTransformationManifest(
        expectedSourceFields,
        requiredTargetFields,
        [...sourceFieldTransformationManifest, firstSource!],
        requiredTargetFieldManifest
      )
    ).toContain(
      `duplicate_source_disposition:${firstSource!.sourceModel}.${firstSource!.sourceField}`
    );
    const [firstTarget] = requiredTargetFieldManifest;
    expect(
      auditFieldTransformationManifest(
        expectedSourceFields,
        requiredTargetFields,
        sourceFieldTransformationManifest,
        requiredTargetFieldManifest.slice(1)
      )
    ).toContain(`missing_target_requirement:${firstTarget!.targetField}`);
    expect(
      auditFieldTransformationManifest(
        expectedSourceFields,
        requiredTargetFields,
        sourceFieldTransformationManifest,
        requiredTargetFieldManifest.map((entry, index) =>
          index === 0 ? { ...entry, sourceFields: [], deterministicDefault: undefined } : entry
        )
      )
    ).toContain(`unsatisfied_target_requirement:${firstTarget!.targetField}`);
  });

  test("covers every retained encrypted-material family with a target read probe", () => {
    expect(new Set(cryptographicFieldLedger.map((entry) => entry.family))).toEqual(
      new Set(["MFA", "PROVIDER", "CHANNEL", "ENTITY", "OIDC", "GENERIC_CREDENTIAL", "MESSAGE"])
    );
    expect(new Set(cryptographicFieldLedger.map((entry) => entry.id)).size).toBe(
      cryptographicFieldLedger.length
    );

    for (const entry of cryptographicFieldLedger) {
      expect(entry.sourceEncoding).toBeTruthy();
      expect(entry.sourceKeyDomain).toBeTruthy();
      expect(entry.sourceKeyVersion).toBeTruthy();
      expect(entry.targetKeyDomain).toBeTruthy();
      expect(entry.probe).toBeTruthy();
      for (const source of entry.sourceFields) {
        expect(legacyFieldExists(source) || controlFieldExists(source), source).toBe(true);
      }
      for (const target of entry.targetFields) {
        expect(controlFieldExists(target), target).toBe(true);
      }
    }

    expect(cryptographicFieldLedger.map((entry) => entry.id)).toEqual(
      expect.arrayContaining([
        "mfa-totp-secret-store",
        "provider-secret-store",
        "channel-connection-credentials",
        "channel-connection-webhook-secret",
        "channel-app-client-secret",
        "channel-installation-bot-token",
        "entity-service-secret",
        "entity-test-credentials",
        "mcp-oidc-access-token",
        "mcp-oidc-refresh-token",
        "generic-credential-encrypted-reference",
        "message-content",
        "message-thinking",
        "tool-audit-arguments",
        "safety-metadata",
        "memory-content",
        "memory-entity-label",
      ])
    );

    const aggregateComponents = aggregateCredentialPayloadContracts.flatMap(
      (contract) => [...contract.components] as CredentialPayloadComponent[]
    );
    expect(
      new Set(aggregateComponents.map((component) => component.cryptographicFieldId)).size
    ).toBe(aggregateComponents.length);
    expect(new Set(aggregateCredentialPayloadContracts.map((contract) => contract.id)).size).toBe(
      aggregateCredentialPayloadContracts.length
    );
    for (const contract of aggregateCredentialPayloadContracts) {
      expect(new Set(contract.components.map((component) => component.payloadKey)).size).toBe(
        contract.components.length
      );
      if (contract.emptyPayloadPolicy === "OMIT_CREDENTIAL") {
        expect(contract.minimumPresentComponents).toBe(0);
      } else {
        expect(contract.minimumPresentComponents).toBeGreaterThan(0);
      }
      expect(contract.ownerForeignKey === null).toBe(
        contract.bindingRule === "DETERMINISTIC_NAME_LOOKUP"
      );
      for (const component of contract.components) {
        expect(component.mergeRule).toBe("SET_IF_ABSENT");
        expect(
          cryptographicFieldLedger.some((entry) => entry.id === component.cryptographicFieldId),
          component.cryptographicFieldId
        ).toBe(true);
      }
    }
    expect(aggregateComponents.map((component) => component.cryptographicFieldId)).toEqual(
      expect.arrayContaining([
        "entity-service-secret",
        "entity-test-credentials",
        "channel-app-client-secret",
        "channel-app-signing-secret",
        "channel-installation-bot-token",
        "channel-installation-refresh-token",
        "mcp-oidc-access-token",
        "mcp-oidc-refresh-token",
      ])
    );

    const channelApp = aggregateCredentialPayloadContracts.find(
      (contract) => contract.id === "channel-app-auth"
    )!;
    expect(
      assembleCredentialPayload(channelApp, {
        "PlatosChannelApp.clientSecret": "client-value",
        "PlatosChannelApp.signingSecret": "signing-value",
      })
    ).toEqual({ clientSecret: "client-value", signingSecret: "signing-value" });
    expect(() =>
      assembleCredentialPayload(channelApp, {
        "PlatosChannelApp.clientSecret": "client-value",
      })
    ).toThrow("Missing required credential component PlatosChannelApp.signingSecret");
    expect(() =>
      assembleCredentialPayload(
        {
          ...channelApp,
          components: [
            channelApp.components[0],
            { ...channelApp.components[1], payloadKey: channelApp.components[0].payloadKey },
          ],
        },
        {
          "PlatosChannelApp.clientSecret": "client-value",
          "PlatosChannelApp.signingSecret": "signing-value",
        }
      )
    ).toThrow("Credential payload key collision clientSecret");
    const oidc = aggregateCredentialPayloadContracts.find(
      (contract) => contract.id === "mcp-oidc-tokens"
    )!;
    expect(assembleCredentialPayload(oidc, {})).toEqual({});
    expect(
      assembleCredentialPayload(oidc, {
        "PlatosMcpOidcSession.entityRefreshToken": "refresh-value",
      })
    ).toEqual({ refreshToken: "refresh-value" });

    expect(messageMixedEncodingContracts).toHaveLength(
      cryptographicFieldLedger.filter((entry) => entry.family === "MESSAGE").length
    );
    expect(
      new Set(messageMixedEncodingContracts.map((contract) => contract.cryptographicFieldId))
    ).toEqual(
      new Set(
        cryptographicFieldLedger
          .filter((entry) => entry.family === "MESSAGE")
          .map((entry) => entry.id)
      )
    );
    for (const contract of messageMixedEncodingContracts) {
      expect(contract.recognizedEnvelopeFailure).toBe("BLOCK_CUTOVER_NO_PLAINTEXT_FALLBACK");
      expect(contract.probeVariants).toEqual(["ENVELOPE", "PLAINTEXT"]);
      expect(contract.probeAssertion).toBe("TARGET_READER_RETURNS_SOURCE_SEMANTICS");
    }
  });
});
