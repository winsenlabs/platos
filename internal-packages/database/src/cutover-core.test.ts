import { describe, expect, test } from "vitest";
import { compareApplicationCatalogs, type CatalogSnapshot } from "./cutover-catalog";
import { deterministicChunks } from "./cutover-backfill";
import {
  parseCutoverArguments,
  resolveCutoverCredentialRootKeyRing,
  resolveCutoverMessageEncryptionKeyVersion,
  resolveCutoverMessageEncryptionKeys,
} from "./cutover-cli";
import {
  assertImplementedRetainedSourceCoverage,
  assertCutoverPhaseLedgerIsExhaustive,
  cutoverDomainPhases,
  implementedRetainedSourceCoverage,
  incompleteCutoverPhaseIds,
} from "./cutover-phases";
import { serializeCutoverReport } from "./cutover-report";
import { sourceModelManifest } from "./source-model-manifest";

describe("cutover command safety contracts", () => {
  test("defaults to dry-run and requires mandatory rollback for core rehearsal", () => {
    expect(parseCutoverArguments([]).mode).toBe("DRY_RUN");
    expect(() => parseCutoverArguments(["--execute", "--core-rehearsal"]))
      .toThrow("requires --force-rollback-before-commit");
    expect(() => parseCutoverArguments(["--core-rehearsal", "--force-rollback-before-commit"]))
      .toThrow("requires the explicit --execute flag");
    expect(
      parseCutoverArguments([
        "--execute",
        "--core-rehearsal",
        "--force-rollback-before-commit",
      ]).mode
    ).toBe("CORE_REHEARSAL_ROLLBACK");
    expect(parseCutoverArguments([])).toMatchObject({
      exportKeyEnvironment: "PLATOS_CUTOVER_EXPORT_KEY",
      exportKeyReference: undefined,
      exportDirectory: undefined,
    });
    expect(parseCutoverArguments([
      "--export-key-env",
      "TEST_CUTOVER_EXPORT_KEY",
      "--export-key-reference",
      "ops/win-123/export-key-v1",
      "--export-dir",
      "/var/tmp/explicit-cutover-export-test",
    ])).toMatchObject({
      exportKeyEnvironment: "TEST_CUTOVER_EXPORT_KEY",
      exportKeyReference: "ops/win-123/export-key-v1",
      exportDirectory: "/var/tmp/explicit-cutover-export-test",
    });
    expect(() => parseCutoverArguments(["--export-key-env", "bad-env-name"]))
      .toThrow("must name an environment variable");
    expect(() => parseCutoverArguments(["--export-key-reference", "bad key reference"]))
      .toThrow("is invalid");
  });

  test("keeps all unimplemented domain phases machine-readable and exhaustive", () => {
    expect(() => assertCutoverPhaseLedgerIsExhaustive()).not.toThrow();
    expect(() => assertImplementedRetainedSourceCoverage()).not.toThrow();
    expect(
      cutoverDomainPhases
        .filter((phase) => phase.implementation === "IMPLEMENTED")
        .map((phase) => phase.id)
    ).toEqual([
      "core-tenancy-auth",
      "supplemental-auth-mfa",
      "retained-agent-tool-batch-1",
      "retained-conversation-batch-2",
      "retained-entity-mcp-batch-3",
      "retained-provider-oauth-batch-4",
      "retained-channel-batch-5",
      "retained-operational-batch-6",
      "retained-eval-job-skill-batch-7",
      "retained-memory-batch-8",
      "final-message-re-encryption-read-probes",
      "remaining-retained-backfill",
      "unsupported-trigger-export",
      "ephemeral-session-recovery-disposition",
      "clean-trigger-defer-install",
      "cryptographic-read-probes",
    ]);
    expect(cutoverDomainPhases.find((phase) => phase.id === "supplemental-auth-mfa"))
      .toMatchObject({
        implementation: "IMPLEMENTED",
        sourceModels: [
          "OrgMemberInvite",
          "SecretReference",
          "SecretStore",
          "ImpersonationAuditLog",
        ],
      });
    expect(cutoverDomainPhases.find((phase) => phase.id === "retained-agent-tool-batch-1"))
      .toMatchObject({
        implementation: "IMPLEMENTED",
        sourceModels: [
          "PlatosToolDefinition",
          "PlatosAgent",
          "PlatosAgentVersion",
          "PlatosAgentCluster",
        ],
      });
    expect(cutoverDomainPhases.find((phase) => phase.id === "retained-conversation-batch-2"))
      .toMatchObject({
        implementation: "IMPLEMENTED",
        sourceModels: [
          "PlatosEndUser",
          "PlatosEndUserIdentity",
          "PlatosAgentThread",
          "PlatosAgentMessage",
          "PlatosAgentArtifact",
          "PlatosMessageAttachment",
          "PlatosPostmanTemplate",
        ],
      });
    expect(
      cutoverDomainPhases.find((phase) => phase.id === "final-message-re-encryption-read-probes")
    ).toMatchObject({ implementation: "IMPLEMENTED", sourceModels: [] });
    expect(cutoverDomainPhases.find((phase) => phase.id === "retained-entity-mcp-batch-3"))
      .toMatchObject({
        implementation: "IMPLEMENTED",
        sourceModels: expect.arrayContaining([
          "PlatosConnectedEntity",
          "PlatosMcpOidcSession",
          "PlatosMcpBearerToken",
        ]),
      });
    expect(cutoverDomainPhases.find((phase) => phase.id === "retained-provider-oauth-batch-4"))
      .toMatchObject({
        implementation: "IMPLEMENTED",
        sourceModels: expect.arrayContaining([
          "PlatosProviderKey",
          "PlatosAccessKey",
          "PlatosOAuthRefreshToken",
        ]),
      });
    expect(cutoverDomainPhases.find((phase) => phase.id === "retained-channel-batch-5"))
      .toMatchObject({
        implementation: "IMPLEMENTED",
        sourceModels: expect.arrayContaining([
          "PlatosChannelConnection",
          "PlatosChannelInstallation",
          "PlatosChannelAppThread",
        ]),
      });
    expect(cutoverDomainPhases.find((phase) => phase.id === "retained-operational-batch-6"))
      .toMatchObject({
        implementation: "IMPLEMENTED",
        sourceModels: expect.arrayContaining([
          "PlatosToolCallAudit",
          "PlatosCredentialAudit",
          "PlatosErasureOperation",
        ]),
      });
    expect(cutoverDomainPhases.find((phase) => phase.id === "retained-eval-job-skill-batch-7"))
      .toMatchObject({
        implementation: "IMPLEMENTED",
        sourceModels: expect.arrayContaining([
          "PlatosMessageRating",
          "PlatosSkill",
          "PlatosMacro",
        ]),
      });
    expect(cutoverDomainPhases.find((phase) => phase.id === "retained-memory-batch-8"))
      .toMatchObject({
        implementation: "IMPLEMENTED",
        sourceModels: ["PlatosMemory", "PlatosMemoryEntity", "PlatosMemoryRelationship"],
      });
    expect(
      cutoverDomainPhases.find((phase) => phase.id === "final-message-re-encryption-read-probes")
    ).toMatchObject({
      implementation: "IMPLEMENTED",
      summary: expect.stringContaining("Batch 8 memory re-encryption"),
    });
    expect(cutoverDomainPhases.find((phase) => phase.id === "remaining-retained-backfill"))
      .toMatchObject({
        implementation: "IMPLEMENTED",
        sourceModels: [],
        summary: expect.stringContaining("All 55 retained Platos models"),
      });
    expect(cutoverDomainPhases.find((phase) => phase.id === "cryptographic-read-probes"))
      .toMatchObject({ implementation: "IMPLEMENTED", summary: expect.stringContaining("Batch 6 audit") });
    expect(cutoverDomainPhases.find((phase) => phase.id === "clean-trigger-defer-install"))
      .toMatchObject({ implementation: "IMPLEMENTED", sourceModels: [] });
    expect(incompleteCutoverPhaseIds).toEqual(["external-analytics-object-rekey"]);
    expect(implementedRetainedSourceCoverage).toEqual({
      retainedPlatosSourceModelCount: 55,
      supplementalRetainedSourceModelCount: 4,
      implementedRetainedSourceModelCount: 59,
    });
    const assignedPlatosSources = cutoverDomainPhases
      .filter((phase) => phase.implementation === "IMPLEMENTED")
      .flatMap((phase) => phase.sourceModels)
      .filter((sourceModel) => sourceModel.startsWith("Platos"));
    expect(assignedPlatosSources).toHaveLength(55);
    expect(new Set(assignedPlatosSources)).toEqual(
      new Set(sourceModelManifest.map((entry) => entry.source))
    );
    for (const blockedPhase of ["external-analytics-object-rekey"]) {
      expect(cutoverDomainPhases.find((phase) => phase.id === blockedPhase))
        .toMatchObject({ implementation: "STUB" });
    }
  });

  test("resolves the active and historical message key ring without exposing aliases", () => {
    expect(resolveCutoverMessageEncryptionKeys({
      PLATOS_MESSAGE_ENCRYPTION_KEY: "active",
      PLATOS_MESSAGE_ENCRYPTION_KEY_V: "3",
      PLATOS_MESSAGE_ENCRYPTION_KEY_V1: "prior-one",
      PLATOS_MESSAGE_ENCRYPTION_KEY_V2: "prior-two",
      PLATOS_MESSAGE_ENCRYPTION_KEY_V3: "shadowed-active-alias",
      PLATOS_MESSAGE_ENCRYPTION_KEY_V0: "unsupported",
    })).toEqual({
      "1": "prior-one",
      "2": "prior-two",
      "3": "active",
    });
    expect(resolveCutoverMessageEncryptionKeys({
      PLATOS_MESSAGE_ENCRYPTION_KEY: "default-active",
      PLATOS_MESSAGE_ENCRYPTION_KEY_V: "invalid",
    })).toEqual({ "1": "default-active" });
    expect(resolveCutoverMessageEncryptionKeyVersion({
      PLATOS_MESSAGE_ENCRYPTION_KEY_V: "3",
    })).toBe(3);
    expect(resolveCutoverMessageEncryptionKeyVersion({
      PLATOS_MESSAGE_ENCRYPTION_KEY_V: "invalid",
    })).toBe(1);
  });

  test("resolves the active and prior credential root ring from the runtime JSON contract", () => {
    const ring = resolveCutoverCredentialRootKeyRing({
      PLATOS_CREDENTIAL_ROOT_KEY_VERSION: "2",
      PLATOS_CREDENTIAL_ROOT_KEYS: JSON.stringify({
        1: "1".repeat(64),
        2: "2".repeat(64),
      }),
    });
    expect(ring?.activeVersion).toBe(2);
    expect(ring?.key(1)).toHaveLength(32);
    expect(resolveCutoverCredentialRootKeyRing({})).toBeUndefined();
    expect(() => resolveCutoverCredentialRootKeyRing({
      PLATOS_CREDENTIAL_ROOT_KEY_VERSION: "2",
      PLATOS_CREDENTIAL_ROOT_KEYS: '{"2":"root-sentinel"}',
    })).toThrow("credential root key ring configuration is invalid");
  });

  test("compares normalized application catalogs exactly", () => {
    const left: CatalogSnapshot = {
      entries: [{ kind: "column", name: "User.1", definition: "id|uuid" }],
      digest: "one",
    };
    expect(compareApplicationCatalogs(left, left)).toMatchObject({ equal: true, missing: [], unexpected: [] });
    const right: CatalogSnapshot = { entries: [], digest: "two" };
    expect(compareApplicationCatalogs(left, right)).toMatchObject({
      equal: false,
      missing: [],
      unexpected: ["column:User.1:id|uuid"],
    });
  });

  test("uses stable bounded chunks and rejects ambiguous chunk sizes", () => {
    expect(deterministicChunks(["a", "b", "c", "d", "e"], 2)).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e"],
    ]);
    expect(() => deterministicChunks([], 0)).toThrow("positive integer");
  });

  test("emits a checksummed structured report without database URLs", () => {
    const output = serializeCutoverReport({
      reportVersion: 1,
      runId: "03125bd3-8e2e-5500-8942-574db43e9203",
      mappingVersion: 1,
      mappingNamespace: "75803f94-05d5-5eb3-b37d-65774e2aaa6c",
      mode: "DRY_RUN",
      state: "INCOMPLETE_IMPLEMENTATION",
      startedAt: "2026-08-17T00:00:00.000Z",
      finishedAt: "2026-08-17T00:00:01.000Z",
      checks: [],
      phases: [],
      sourceDigests: [],
      incompletePhaseIds: incompleteCutoverPhaseIds,
    });
    expect(JSON.parse(output)).toMatchObject({
      state: "INCOMPLETE_IMPLEMENTATION",
      reportSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(output).not.toContain("postgresql://");
  });
});
