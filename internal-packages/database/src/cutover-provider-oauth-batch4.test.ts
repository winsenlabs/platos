import { createCipheriv, createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  backfillBatch4OAuthAuthorizationCodes,
  backfillBatch4ProviderCredentials,
  backfillRetainedProviderOauthBatch4,
  batch4OAuthRefreshFamilyId,
  batch4ProviderCredentialIds,
  hashBatch4OAuthAuthorizationCode,
  mapBatch4OrganizationMcpPolicy,
  materializeRetainedProviderOauthBatch4Mappings,
  normalizeBatch4ScopeTuple,
  retainedProviderOauthBatch4MappingTargets,
  retainedProviderOauthBatch4SourceModels,
  transformBatch4ProviderCredential,
  validateBatch4Sha256Hash,
  validateRetainedProviderOauthBatch4,
  validateRetainedProviderOauthBatch4Source,
} from "./cutover-provider-oauth-batch4";
import { mapCutoverId } from "./cutover-id";
import { decryptCredentialSecret } from "./secrets";
import type { CutoverDatabase, QueryResultLike } from "./cutover-types";

const LEGACY_KEY = "22".repeat(32);
const TARGET_KEY = "44".repeat(32);
const VALID_HASH = createHash("sha256").update("batch-4-fixture").digest("hex");

function legacyV2(value: unknown): Record<string, string> {
  const nonce = Buffer.alloc(12, 0x33);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(LEGACY_KEY, "hex"), nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("hex"),
    nonce: nonce.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
  };
}

function providerSource(storeVersion: "1" | "2", storeValue: unknown) {
  return {
    sourceId: "cllegacyproviderkey0001",
    environmentId: "92667e71-0437-5fc4-961c-f1224647019c",
    provider: "anthropic",
    label: "Anthropic fixture",
    envVarName: "ANTHROPIC_API_KEY",
    isDefault: true,
    createdBy: "cllegacyuser0001",
    lastUsedAt: null,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    updatedAt: new Date("2025-01-02T00:00:00Z"),
    storeVersion,
    storeValue,
    storeCreatedAt: new Date("2025-01-01T00:00:00Z"),
  };
}

describe("retained provider/OAuth cutover Batch 4", () => {
  test("pins every source and deterministic split target", () => {
    expect(retainedProviderOauthBatch4SourceModels).toEqual([
      "PlatosProviderEnabled",
      "PlatosProviderKey",
      "PlatosAccessKey",
      "PlatosMCPToken",
      "PlatosPAT",
      "PlatosOAuthClient",
      "PlatosOAuthAuthCode",
      "PlatosOAuthAccessToken",
      "PlatosOAuthRefreshToken",
      "PlatosOrgMcpPolicy",
    ]);
    expect(retainedProviderOauthBatch4MappingTargets).toContainEqual({
      sourceModel: "PlatosProviderKey",
      targetModel: "CredentialSecretVersion",
      stableSuffix: "credential-secret-version:1",
    });
    const ids = batch4ProviderCredentialIds("cllegacyproviderkey0001");
    expect(ids).toEqual({
      credentialId: mapCutoverId({
        sourceModel: "PlatosProviderKey",
        sourceId: "cllegacyproviderkey0001",
        suffix: "credential",
      }),
      secretVersionId: mapCutoverId({
        sourceModel: "PlatosProviderKey",
        sourceId: "cllegacyproviderkey0001",
        suffix: "credential-secret-version:1",
      }),
    });
  });

  test("materializes the provider credential split with stable revision suffixes", async () => {
    const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        values?: readonly unknown[]
      ): Promise<QueryResultLike<Row>> {
        queries.push({ sql, values });
        if (sql.includes('FROM cutover_legacy."PlatosProviderKey"')) {
          return {
            rows: [{ source_id: "cllegacyproviderkey0001" }] as unknown as Row[],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    await expect(materializeRetainedProviderOauthBatch4Mappings(database)).resolves.toBe(2);
    const insert = queries.find((query) =>
      query.sql.includes("INSERT INTO cutover_legacy.cutover_id_map")
    )!;
    expect(insert.values).toEqual([
      "cllegacyproviderkey0001",
      "Credential",
      "credential",
      batch4ProviderCredentialIds("cllegacyproviderkey0001").credentialId,
      "cllegacyproviderkey0001",
      "CredentialSecretVersion",
      "credential-secret-version:1",
      batch4ProviderCredentialIds("cllegacyproviderkey0001").secretVersionId,
    ]);
  });

  test("normalizes scope tuples to exactly one canonical owner", () => {
    expect(normalizeBatch4ScopeTuple({}, { allowGlobal: true })).toEqual({
      scopeKind: "GLOBAL",
      organizationSourceId: null,
      projectSourceId: null,
      environmentSourceId: null,
    });
    expect(normalizeBatch4ScopeTuple({ organizationId: "org" }, { allowGlobal: false })).toEqual({
      scopeKind: "ORGANIZATION",
      organizationSourceId: "org",
      projectSourceId: null,
      environmentSourceId: null,
    });
    expect(normalizeBatch4ScopeTuple({ organizationId: "org", projectId: "project" }, { allowGlobal: false }))
      .toMatchObject({ scopeKind: "PROJECT", projectSourceId: "project" });
    expect(normalizeBatch4ScopeTuple({
      organizationId: "org",
      projectId: "project",
      environmentId: "environment",
    }, { allowGlobal: false })).toMatchObject({
      scopeKind: "ENVIRONMENT",
      environmentSourceId: "environment",
    });
    expect(() => normalizeBatch4ScopeTuple({}, { allowGlobal: false })).toThrow("cannot be global");
    expect(() => normalizeBatch4ScopeTuple({ projectId: "project" }, { allowGlobal: true }))
      .toThrow("requires its organization ancestor");
    expect(() => normalizeBatch4ScopeTuple({ organizationId: "org", extra: "forged" }, { allowGlobal: true }))
      .toThrow("unsupported fields");
  });

  test("preserves only canonical lowercase hashes and derives isolated refresh families", () => {
    expect(validateBatch4Sha256Hash(VALID_HASH)).toBe(VALID_HASH);
    expect(() => validateBatch4Sha256Hash(VALID_HASH.toUpperCase())).toThrow("malformed SHA-256");
    expect(() => validateBatch4Sha256Hash("short")).toThrow("malformed SHA-256");
    expect(batch4OAuthRefreshFamilyId(VALID_HASH)).toBe(
      mapCutoverId({
        sourceModel: "PlatosOAuthRefreshToken",
        sourceId: VALID_HASH,
        suffix: "rotation-family",
      })
    );
  });

  test("hashes plaintext authorization codes without retaining plaintext", () => {
    const code = "plt_oacode_fixture_plaintext";
    expect(hashBatch4OAuthAuthorizationCode(code)).toBe(
      createHash("sha256").update(code).digest("hex")
    );
    expect(hashBatch4OAuthAuthorizationCode(code)).not.toContain(code);
    expect(() => hashBatch4OAuthAuthorizationCode("")).toThrow("code is malformed");
  });

  test("maps approval policies fail-closed", () => {
    expect(mapBatch4OrganizationMcpPolicy("auto_allow")).toBe("ALLOW");
    expect(mapBatch4OrganizationMcpPolicy("require_approval")).toBe("DENY");
    expect(mapBatch4OrganizationMcpPolicy("block")).toBe("DENY");
    expect(() => mapBatch4OrganizationMcpPolicy("allow_without_review")).toThrow("not representable");
  });

  test.each([
    ["1" as const, { secret: "provider-plaintext-v1" }],
    ["2" as const, legacyV2({ secret: "provider-plaintext-v2" })],
  ])("strictly decodes SecretStore v%s and writes a target-bound envelope", (version, value) => {
    const target = transformBatch4ProviderCredential(providerSource(version, value), {
      legacyEncryptionKey: LEGACY_KEY,
      credentialRootKeyVersion: 7,
      credentialRootKey: TARGET_KEY,
    });
    expect(target.credential.name).toBe("ANTHROPIC_API_KEY");
    expect(target.providerKey.environmentKeyName).toBe(target.credential.name);
    expect(target.providerKey.credentialId).toBe(target.credential.id);
    expect(target.credential.activeSecretVersionId).toBe(target.secretVersion.id);
    const material = decryptCredentialSecret(
      Buffer.from(TARGET_KEY, "hex"),
      {
        credentialId: target.credential.id,
        environmentId: target.credential.environmentId,
        secretRevision: 1,
        formatVersion: 1,
        rootKeyVersion: 7,
      },
      target.secretVersion
    );
    expect(material.reveal()).toBe(`provider-plaintext-v${version}`);
  });

  test("rejects unsupported SecretStore formats and non-exact provider payloads", () => {
    expect(() => transformBatch4ProviderCredential(providerSource("1", { secret: "ok", extra: true }), {
      legacyEncryptionKey: LEGACY_KEY,
      credentialRootKeyVersion: 1,
      credentialRootKey: TARGET_KEY,
    })).toThrow("unsupported fields");
    expect(() => transformBatch4ProviderCredential({
      ...providerSource("2", legacyV2({ secret: "ok" })),
      storeValue: { ciphertext: "00", nonce: "00", tag: "00" },
    }, {
      legacyEncryptionKey: LEGACY_KEY,
      credentialRootKeyVersion: 1,
      credentialRootKey: TARGET_KEY,
    })).toThrow("SecretStore value is unreadable");
  });

  test("pages provider secrets in bounded chunks and activates versions before linking keys", async () => {
    const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<QueryResultLike<Row>> {
        queries.push({ sql, values });
        if (sql.includes('FROM cutover_legacy."PlatosProviderKey" source')) {
          const rows = values?.[0] === "" ? [{
            source_id: "provider-a",
            target_id: "00000000-0000-5000-8000-000000000001",
            environment_id: "00000000-0000-5000-8000-000000000002",
            provider: "anthropic",
            label: "Primary",
            env_var_name: "ANTHROPIC_API_KEY",
            is_default: true,
            created_by: "operator-a",
            last_used_at: null,
            created_at: new Date(0),
            updated_at: new Date(1),
            store_version: "1",
            store_value: { secret: "provider-sentinel" },
            store_created_at: new Date(0),
          }] : [];
          return { rows: rows as unknown as Row[], rowCount: rows.length };
        }
        return { rows: [], rowCount: 1 };
      },
    };

    await expect(backfillBatch4ProviderCredentials(database, {
      legacyEncryptionKey: LEGACY_KEY,
      credentialRootKeyVersion: 1,
      credentialRootKey: TARGET_KEY,
    }, 1)).resolves.toBe(1);
    expect(queries.filter((query) => query.sql.includes("ORDER BY source.id LIMIT $2"))).toHaveLength(2);
    const credentialIndex = queries.findIndex((query) => query.sql.includes('INSERT INTO public."Credential"'));
    const versionIndex = queries.findIndex((query) => query.sql.includes('INSERT INTO public."CredentialSecretVersion"'));
    const activationIndex = queries.findIndex((query) => query.sql.includes('UPDATE public."Credential"'));
    const providerIndex = queries.findIndex((query) => query.sql.includes('INSERT INTO public."ProviderKey"'));
    expect(credentialIndex).toBeLessThan(versionIndex);
    expect(versionIndex).toBeLessThan(activationIndex);
    expect(activationIndex).toBeLessThan(providerIndex);
    expect(queries[providerIndex]?.values).not.toContain("provider-sentinel");
  });

  test("writes only the authorization-code digest to the target insert", async () => {
    const rawCode = "plaintext-code-sentinel";
    let insertValues: readonly unknown[] | undefined;
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<QueryResultLike<Row>> {
        if (sql.includes('FROM cutover_legacy."PlatosOAuthAuthCode" child')) {
          const rows = values?.[0] === "" ? [{
            source_id: rawCode,
            target_id: "00000000-0000-5000-8000-000000000001",
            client_id: "00000000-0000-5000-8000-000000000002",
            user_id: "00000000-0000-5000-8000-000000000003",
            client_organization_source_id: "org-a",
            scope_tuple: { organizationId: "org-a", projectId: "project-a", environmentId: "environment-a" },
            scopes: ["mcp:tools"],
            organization_id: "00000000-0000-5000-8000-000000000004",
            project_id: "00000000-0000-5000-8000-000000000005",
            environment_id: "00000000-0000-5000-8000-000000000006",
            code_challenge: "challenge",
            code_challenge_method: "S256",
            redirect_uri: "https://example.invalid/callback",
            expires_at: new Date(1),
            used_at: null,
            created_at: new Date(0),
          }] : [];
          return { rows: rows as unknown as Row[], rowCount: rows.length };
        }
        if (sql.includes('INSERT INTO public."OAuthAuthorizationCode"')) insertValues = values;
        return { rows: [], rowCount: 1 };
      },
    };
    await backfillBatch4OAuthAuthorizationCodes(database, 1);
    expect(insertValues).not.toContain(rawCode);
    expect(insertValues).toContain(hashBatch4OAuthAuthorizationCode(rawCode));
  });

  test("returns count-only evidence that cannot serialize supplied secret or digest material", async () => {
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
        return { rows: [], rowCount: 0 };
      },
    };
    const evidence = await backfillRetainedProviderOauthBatch4(database, {
      legacyEncryptionKey: "legacy-sentinel",
      credentialRootKeyVersion: 1,
      credentialRootKey: TARGET_KEY,
    }, 2);
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("legacy-sentinel");
    expect(serialized).not.toContain(VALID_HASH);
    expect(evidence.targetRows.providerCredentials).toBe(0);
  });

  test("reports source collisions and keeps validation gates separate", async () => {
    const sourceDatabase: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
        return {
          rows: [{ issue: "bearer-hash-invalid-or-colliding" }] as unknown as Row[],
          rowCount: 1,
        };
      },
    };
    await expect(validateRetainedProviderOauthBatch4Source(sourceDatabase)).rejects.toMatchObject({
      code: "BATCH4_SOURCE_OR_MAPPING_INVALID",
    });

    let call = 0;
    const targetDatabase: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
        call += 1;
        return call === 2
          ? { rows: [{ issue: "oauth-client-scope" }] as unknown as Row[], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      },
    };
    await expect(validateRetainedProviderOauthBatch4(targetDatabase)).rejects.toMatchObject({
      code: "BATCH4_ANCESTRY_FAILED",
    });
    expect(call).toBe(2);
  });
});
