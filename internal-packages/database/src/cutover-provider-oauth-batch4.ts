import { createHash } from "node:crypto";
import { CUTOVER_CHUNK_SIZE } from "./cutover-backfill";
import {
  assertSecretFreeCutoverEvidence,
  decodeLegacySecretStoreJson,
  validateSha256Hex,
} from "./cutover-crypto";
import { mapCutoverId } from "./cutover-id";
import type { CutoverDatabase } from "./cutover-types";
import { CutoverFailure } from "./cutover-types";
import {
  CredentialRootKeyRing,
  decryptCredentialSecret,
  encryptCredentialSecret,
} from "./secrets";

export const retainedProviderOauthBatch4SourceModels = [
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
] as const;

export const retainedProviderOauthBatch4MappingTargets = [
  { sourceModel: "PlatosProviderEnabled", targetModel: "EnvironmentProvider", stableSuffix: "" },
  { sourceModel: "PlatosProviderKey", targetModel: "ProviderKey", stableSuffix: "" },
  { sourceModel: "PlatosProviderKey", targetModel: "Credential", stableSuffix: "credential" },
  {
    sourceModel: "PlatosProviderKey",
    targetModel: "CredentialSecretVersion",
    stableSuffix: "credential-secret-version:1",
  },
  { sourceModel: "PlatosAccessKey", targetModel: "AccessKey", stableSuffix: "" },
  { sourceModel: "PlatosMCPToken", targetModel: "McpToken", stableSuffix: "" },
  { sourceModel: "PlatosPAT", targetModel: "PersonalAccessToken", stableSuffix: "" },
  { sourceModel: "PlatosOAuthClient", targetModel: "OAuthClient", stableSuffix: "" },
  { sourceModel: "PlatosOAuthAuthCode", targetModel: "OAuthAuthorizationCode", stableSuffix: "" },
  { sourceModel: "PlatosOAuthAccessToken", targetModel: "OAuthAccessToken", stableSuffix: "" },
  { sourceModel: "PlatosOAuthRefreshToken", targetModel: "OAuthRefreshToken", stableSuffix: "" },
  { sourceModel: "PlatosOrgMcpPolicy", targetModel: "OrganizationMcpPolicy", stableSuffix: "" },
] as const;

export type Batch4AuthorizationScopeKind =
  | "GLOBAL"
  | "ORGANIZATION"
  | "PROJECT"
  | "ENVIRONMENT";

export interface NormalizedBatch4ScopeTuple {
  readonly scopeKind: Batch4AuthorizationScopeKind;
  readonly organizationSourceId: string | null;
  readonly projectSourceId: string | null;
  readonly environmentSourceId: string | null;
}

interface MappedBatch4ScopeTuple {
  readonly scopeKind: Batch4AuthorizationScopeKind;
  readonly organizationId: string | null;
  readonly projectId: string | null;
  readonly environmentId: string | null;
}

export interface Batch4ProviderSecretOptions {
  readonly legacyEncryptionKey: string;
  readonly credentialRootKeyVersion: number;
  readonly credentialRootKey: string | Buffer;
}

export interface Batch4ProviderCredentialSource {
  readonly sourceId: string;
  readonly providerKeyId?: string;
  readonly environmentId: string;
  readonly provider: string;
  readonly label: string;
  readonly envVarName: string;
  readonly isDefault: boolean;
  readonly createdBy: string;
  readonly lastUsedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly storeVersion: unknown;
  readonly storeValue: unknown;
  readonly storeCreatedAt: Date;
}

export interface Batch4ProviderCredentialTarget {
  readonly providerKey: {
    readonly id: string;
    readonly environmentId: string;
    readonly credentialId: string;
    readonly provider: string;
    readonly label: string;
    readonly environmentKeyName: string;
    readonly isDefault: boolean;
    readonly createdBy: string;
    readonly lastUsedAt: Date | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  };
  readonly credential: {
    readonly id: string;
    readonly environmentId: string;
    readonly activeSecretVersionId: string;
    readonly name: string;
    readonly provider: string;
    readonly createdBy: string;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  };
  readonly secretVersion: {
    readonly id: string;
    readonly credentialId: string;
    readonly secretRevision: 1;
    readonly formatVersion: 1;
    readonly rootKeyVersion: number;
    readonly salt: Buffer;
    readonly nonce: Buffer;
    readonly ciphertext: Buffer;
    readonly authTag: Buffer;
    readonly createdAt: Date;
  };
}

export interface RetainedProviderOauthBatch4Evidence {
  readonly batch: "retained-provider-oauth-batch4";
  readonly sourceRows: Readonly<Record<string, number>>;
  readonly targetRows: Readonly<Record<string, number>>;
}

function batch4Failure(code: string, summary: string): CutoverFailure {
  return new CutoverFailure(code, summary);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactPlainRecord(value: unknown, allowedKeys: readonly string[], code: string): Record<string, unknown> {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) {
    throw batch4Failure(code, "Batch 4 structured source value is malformed");
  }
  const names = Object.getOwnPropertyNames(value).sort();
  const allowed = [...allowedKeys].sort();
  if (names.some((name) => !allowed.includes(name))) {
    throw batch4Failure(code, "Batch 4 structured source value contains unsupported fields");
  }
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw batch4Failure(code, "Batch 4 structured source value is malformed");
    }
  }
  return value;
}

function nullableSourceId(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw batch4Failure("BATCH4_SCOPE_TUPLE_INVALID", `${label} must be a non-empty source identifier`);
  }
  return value;
}

/**
 * Converts denormalized inherited tuples to one canonical target owner. Parent
 * IDs are used only to validate ancestry and are not copied beside a lower
 * owner. OAuth callers set allowGlobal=false.
 */
export function normalizeBatch4ScopeTuple(
  input: unknown,
  options: { readonly allowGlobal: boolean }
): NormalizedBatch4ScopeTuple {
  const tuple = exactPlainRecord(
    input,
    ["organizationId", "projectId", "environmentId"],
    "BATCH4_SCOPE_TUPLE_INVALID"
  );
  const organizationSourceId = nullableSourceId(tuple.organizationId, "organizationId");
  const projectSourceId = nullableSourceId(tuple.projectId, "projectId");
  const environmentSourceId = nullableSourceId(tuple.environmentId, "environmentId");

  if (environmentSourceId !== null && (projectSourceId === null || organizationSourceId === null)) {
    throw batch4Failure("BATCH4_SCOPE_TUPLE_INVALID", "environment scope requires its project and organization ancestors");
  }
  if (projectSourceId !== null && organizationSourceId === null) {
    throw batch4Failure("BATCH4_SCOPE_TUPLE_INVALID", "project scope requires its organization ancestor");
  }
  if (environmentSourceId !== null) {
    return { scopeKind: "ENVIRONMENT", organizationSourceId, projectSourceId, environmentSourceId };
  }
  if (projectSourceId !== null) {
    return { scopeKind: "PROJECT", organizationSourceId, projectSourceId, environmentSourceId: null };
  }
  if (organizationSourceId !== null) {
    return { scopeKind: "ORGANIZATION", organizationSourceId, projectSourceId: null, environmentSourceId: null };
  }
  if (!options.allowGlobal) {
    throw batch4Failure("BATCH4_SCOPE_TUPLE_INVALID", "OAuth scope cannot be global");
  }
  return {
    scopeKind: "GLOBAL",
    organizationSourceId: null,
    projectSourceId: null,
    environmentSourceId: null,
  };
}

export function validateBatch4Sha256Hash(value: unknown): string {
  try {
    return validateSha256Hex(value);
  } catch {
    throw batch4Failure("BATCH4_HASH_INVALID", "Batch 4 source contains a malformed SHA-256 hash");
  }
}

export function hashBatch4OAuthAuthorizationCode(code: unknown): string {
  if (typeof code !== "string" || code.length === 0 || code.includes("\0")) {
    throw batch4Failure("BATCH4_OAUTH_CODE_INVALID", "OAuth authorization code is malformed");
  }
  return createHash("sha256").update(Buffer.from(code, "utf8")).digest("hex");
}

export function mapBatch4OrganizationMcpPolicy(policy: unknown): "ALLOW" | "DENY" {
  if (policy === "auto_allow") return "ALLOW";
  if (policy === "require_approval" || policy === "block") return "DENY";
  throw batch4Failure("BATCH4_MCP_POLICY_INVALID", "organization MCP policy is not representable");
}

export function batch4ProviderCredentialIds(sourceId: string): {
  readonly credentialId: string;
  readonly secretVersionId: string;
} {
  return {
    credentialId: mapCutoverId({ sourceModel: "PlatosProviderKey", sourceId, suffix: "credential" }),
    secretVersionId: mapCutoverId({
      sourceModel: "PlatosProviderKey",
      sourceId,
      suffix: "credential-secret-version:1",
    }),
  };
}

/** Adds the provider-key split mappings that are not present in the source manifest. */
export async function materializeRetainedProviderOauthBatch4Mappings(
  database: CutoverDatabase
): Promise<number> {
  await database.query(`DELETE FROM cutover_legacy.cutover_id_map
    WHERE mapping_version = 1
      AND source_model = 'PlatosProviderKey'
      AND ((target_model = 'Credential' AND stable_suffix = 'credential')
        OR (target_model = 'CredentialSecretVersion'
          AND stable_suffix = 'credential-secret-version:1'))`);
  const source = await database.query<{ source_id: string }>(
    `SELECT id::text AS source_id
       FROM cutover_legacy."PlatosProviderKey"
      ORDER BY id::text`
  );
  const mappings = source.rows.flatMap((row) => {
    const ids = batch4ProviderCredentialIds(row.source_id);
    return [
      {
        sourceId: row.source_id,
        targetModel: "Credential",
        stableSuffix: "credential",
        targetId: ids.credentialId,
      },
      {
        sourceId: row.source_id,
        targetModel: "CredentialSecretVersion",
        stableSuffix: "credential-secret-version:1",
        targetId: ids.secretVersionId,
      },
    ];
  });
  for (let offset = 0; offset < mappings.length; offset += CUTOVER_CHUNK_SIZE) {
    const chunk = mappings.slice(offset, offset + CUTOVER_CHUNK_SIZE);
    await database.query(
      `INSERT INTO cutover_legacy.cutover_id_map
        (mapping_version, source_model, source_id, target_model, stable_suffix, target_id)
       VALUES ${chunk
         .map((_, index) => {
           const base = index * 4;
           return `(1, 'PlatosProviderKey', $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}::uuid)`;
         })
         .join(", ")}`,
      chunk.flatMap((row) => [row.sourceId, row.targetModel, row.stableSuffix, row.targetId])
    );
  }
  return mappings.length;
}

export function batch4OAuthRefreshFamilyId(sourceTokenHash: unknown): string {
  const tokenHash = validateBatch4Sha256Hash(sourceTokenHash);
  return mapCutoverId({
    sourceModel: "PlatosOAuthRefreshToken",
    sourceId: tokenHash,
    suffix: "rotation-family",
  });
}

function decodeProviderPlaintext(source: Batch4ProviderCredentialSource, legacyEncryptionKey: string): string {
  let decoded: unknown;
  try {
    decoded = decodeLegacySecretStoreJson(
      { version: source.storeVersion, value: source.storeValue },
      legacyEncryptionKey
    );
  } catch {
    throw batch4Failure("BATCH4_PROVIDER_SECRET_UNREADABLE", "provider SecretStore value is unreadable");
  }
  const payload = exactPlainRecord(decoded, ["secret"], "BATCH4_PROVIDER_SECRET_UNREADABLE");
  if (
    Object.getOwnPropertyNames(payload).length !== 1 ||
    typeof payload.secret !== "string" ||
    payload.secret.length === 0
  ) {
    throw batch4Failure("BATCH4_PROVIDER_SECRET_UNREADABLE", "provider SecretStore payload is invalid");
  }
  return payload.secret;
}

/** Strictly decodes and immediately re-envelopes one provider source row. */
export function transformBatch4ProviderCredential(
  source: Batch4ProviderCredentialSource,
  options: Batch4ProviderSecretOptions
): Batch4ProviderCredentialTarget {
  const plaintext = decodeProviderPlaintext(source, options.legacyEncryptionKey);
  let keyRing: CredentialRootKeyRing;
  try {
    keyRing = new CredentialRootKeyRing({
      activeVersion: options.credentialRootKeyVersion,
      keys: { [options.credentialRootKeyVersion]: options.credentialRootKey },
    });
  } catch {
    throw batch4Failure("BATCH4_CREDENTIAL_ROOT_INVALID", "Batch 4 credential root configuration is invalid");
  }
  const ids = batch4ProviderCredentialIds(source.sourceId);
  const providerKeyId =
    source.providerKeyId ?? mapCutoverId({ sourceModel: "PlatosProviderKey", sourceId: source.sourceId });
  const context = {
    credentialId: ids.credentialId,
    environmentId: source.environmentId,
    secretRevision: 1,
    formatVersion: 1,
    rootKeyVersion: options.credentialRootKeyVersion,
  };
  const envelope = encryptCredentialSecret(keyRing.key(options.credentialRootKeyVersion), context, plaintext);
  const secretVersion = {
    id: ids.secretVersionId,
    credentialId: ids.credentialId,
    secretRevision: 1 as const,
    formatVersion: 1 as const,
    rootKeyVersion: options.credentialRootKeyVersion,
    salt: Buffer.from(envelope.salt),
    nonce: Buffer.from(envelope.nonce),
    ciphertext: Buffer.from(envelope.ciphertext),
    authTag: Buffer.from(envelope.authTag),
    createdAt: new Date(source.storeCreatedAt),
  };
  // Exercise the target reader before any SQL is emitted. This is an envelope
  // self-check, not a runtime cutover read probe.
  decryptCredentialSecret(keyRing.key(options.credentialRootKeyVersion), context, secretVersion);

  return {
    providerKey: {
      id: providerKeyId,
      environmentId: source.environmentId,
      credentialId: ids.credentialId,
      provider: source.provider,
      label: source.label,
      environmentKeyName: source.envVarName,
      isDefault: source.isDefault,
      createdBy: source.createdBy,
      lastUsedAt: source.lastUsedAt === null ? null : new Date(source.lastUsedAt),
      createdAt: new Date(source.createdAt),
      updatedAt: new Date(source.updatedAt),
    },
    credential: {
      id: ids.credentialId,
      environmentId: source.environmentId,
      activeSecretVersionId: ids.secretVersionId,
      name: source.envVarName,
      provider: source.provider,
      createdBy: source.createdBy,
      createdAt: new Date(source.createdAt),
      updatedAt: new Date(source.updatedAt),
    },
    secretVersion,
  };
}

function parameterTuples(rowCount: number, width: number): string {
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const offset = rowIndex * width;
    return `(${Array.from({ length: width }, (__, columnIndex) => `$${offset + columnIndex + 1}`).join(", ")})`;
  }).join(", ");
}

async function forEachBatch4SourceChunk<Row extends Record<string, unknown>>(
  database: CutoverDatabase,
  selectSql: string,
  consume: (rows: readonly Row[]) => Promise<void>,
  chunkSize: number
): Promise<number> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
    throw new TypeError("cutover chunk size must be a positive integer");
  }
  let cursor = "";
  let count = 0;
  while (true) {
    const result = await database.query<Row>(selectSql, [cursor, chunkSize]);
    if (result.rows.length === 0) return count;
    await consume(result.rows);
    const nextCursor = result.rows[result.rows.length - 1]?.source_id;
    if (typeof nextCursor !== "string" || nextCursor <= cursor) {
      throw batch4Failure("BATCH4_CHUNK_ORDER_INVALID", "Batch 4 source chunk order is not stable");
    }
    cursor = nextCursor;
    count += result.rows.length;
  }
}

const sourceAndMappingValidationSql = `
  WITH issues AS (
    SELECT 'missing-environment-provider-map' AS issue WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosProviderEnabled" source
       WHERE (SELECT count(*) FROM cutover_legacy.cutover_id_map map
               WHERE map.mapping_version = 1 AND map.source_model = 'PlatosProviderEnabled'
                 AND map.source_id = source.id AND map.target_model = 'EnvironmentProvider'
                 AND map.stable_suffix = '') <> 1)
    UNION ALL SELECT 'missing-provider-key-map' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosProviderKey" source
       WHERE (SELECT count(*) FROM cutover_legacy.cutover_id_map map
               WHERE map.mapping_version = 1 AND map.source_model = 'PlatosProviderKey'
                 AND map.source_id = source.id AND map.target_model = 'ProviderKey'
                 AND map.stable_suffix = '') <> 1)
    UNION ALL SELECT 'missing-provider-credential-map' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosProviderKey" source
       WHERE (SELECT count(*) FROM cutover_legacy.cutover_id_map map
               WHERE map.mapping_version = 1 AND map.source_model = 'PlatosProviderKey'
                 AND map.source_id = source.id AND map.target_model = 'Credential'
                 AND map.stable_suffix = 'credential') <> 1)
    UNION ALL SELECT 'missing-provider-credential-version-map' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosProviderKey" source
       WHERE (SELECT count(*) FROM cutover_legacy.cutover_id_map map
               WHERE map.mapping_version = 1 AND map.source_model = 'PlatosProviderKey'
                 AND map.source_id = source.id AND map.target_model = 'CredentialSecretVersion'
                 AND map.stable_suffix = 'credential-secret-version:1') <> 1)
    UNION ALL SELECT 'missing-access-key-map' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosAccessKey" source
       WHERE NOT EXISTS (SELECT 1 FROM cutover_legacy.cutover_id_map map
                          WHERE map.mapping_version = 1 AND map.source_model = 'PlatosAccessKey'
                            AND map.source_id = source.id AND map.target_model = 'AccessKey'))
    UNION ALL SELECT 'missing-mcp-token-map' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosMCPToken" source
       WHERE NOT EXISTS (SELECT 1 FROM cutover_legacy.cutover_id_map map
                          WHERE map.mapping_version = 1 AND map.source_model = 'PlatosMCPToken'
                            AND map.source_id = source.id AND map.target_model = 'McpToken'))
    UNION ALL SELECT 'missing-pat-map' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosPAT" source
       WHERE NOT EXISTS (SELECT 1 FROM cutover_legacy.cutover_id_map map
                          WHERE map.mapping_version = 1 AND map.source_model = 'PlatosPAT'
                            AND map.source_id = source.id AND map.target_model = 'PersonalAccessToken'))
    UNION ALL SELECT 'missing-oauth-client-map' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosOAuthClient" source
       WHERE NOT EXISTS (SELECT 1 FROM cutover_legacy.cutover_id_map map
                          WHERE map.mapping_version = 1 AND map.source_model = 'PlatosOAuthClient'
                            AND map.source_id = source.id AND map.target_model = 'OAuthClient'))
    UNION ALL SELECT 'missing-oauth-code-map' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosOAuthAuthCode" source
       WHERE NOT EXISTS (SELECT 1 FROM cutover_legacy.cutover_id_map map
                          WHERE map.mapping_version = 1 AND map.source_model = 'PlatosOAuthAuthCode'
                            AND map.source_id = source.code AND map.target_model = 'OAuthAuthorizationCode'))
    UNION ALL SELECT 'missing-oauth-access-map' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosOAuthAccessToken" source
       WHERE NOT EXISTS (SELECT 1 FROM cutover_legacy.cutover_id_map map
                          WHERE map.mapping_version = 1 AND map.source_model = 'PlatosOAuthAccessToken'
                            AND map.source_id = source."tokenHash" AND map.target_model = 'OAuthAccessToken'))
    UNION ALL SELECT 'missing-oauth-refresh-map' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosOAuthRefreshToken" source
       WHERE NOT EXISTS (SELECT 1 FROM cutover_legacy.cutover_id_map map
                          WHERE map.mapping_version = 1 AND map.source_model = 'PlatosOAuthRefreshToken'
                            AND map.source_id = source."tokenHash" AND map.target_model = 'OAuthRefreshToken'))
    UNION ALL SELECT 'missing-org-policy-map' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosOrgMcpPolicy" source
       WHERE NOT EXISTS (SELECT 1 FROM cutover_legacy.cutover_id_map map
                          WHERE map.mapping_version = 1 AND map.source_model = 'PlatosOrgMcpPolicy'
                            AND map.source_id = source.id AND map.target_model = 'OrganizationMcpPolicy'))
    UNION ALL SELECT 'environment-ancestry' WHERE EXISTS (
      SELECT 1 FROM (
        SELECT "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosProviderEnabled"
        UNION ALL SELECT "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosProviderKey"
        UNION ALL SELECT "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosAccessKey"
        UNION ALL SELECT "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosMCPToken"
        UNION ALL SELECT "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosOrgMcpPolicy"
      ) source
      LEFT JOIN cutover_legacy."RuntimeEnvironment" environment ON environment.id = source."environmentId"
      LEFT JOIN cutover_legacy."Project" project ON project.id = source."projectId"
      WHERE environment.id IS NULL OR project.id IS NULL
         OR environment."projectId" <> source."projectId"
         OR environment."organizationId" <> source."organizationId"
         OR project."organizationId" <> source."organizationId")
    UNION ALL SELECT 'provider-secret-store-relation' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosProviderKey" source
      LEFT JOIN cutover_legacy."SecretStore" store
        ON store.key = 'environmentvariable:' || source."projectId" || ':' || source."environmentId" || ':' || source."envVarName"
      WHERE store.key IS NULL)
    UNION ALL SELECT 'provider-target-collision' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosProviderKey"
       GROUP BY "environmentId", provider, label HAVING count(*) > 1
      UNION ALL
      SELECT 1 FROM cutover_legacy."PlatosProviderKey"
       GROUP BY "environmentId", "envVarName" HAVING count(*) > 1
      UNION ALL
      SELECT 1 FROM cutover_legacy."PlatosProviderKey" WHERE btrim(provider) = '' OR btrim(label) = '' OR btrim("envVarName") = '')
    UNION ALL SELECT 'provider-default-collision' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosProviderKey" WHERE "isDefault"
       GROUP BY "environmentId", provider HAVING count(*) > 1)
    UNION ALL SELECT 'bearer-hash-invalid-or-colliding' WHERE EXISTS (
      WITH bearer(family, material) AS (
        SELECT 'access-key', "keyHash" FROM cutover_legacy."PlatosAccessKey"
        UNION ALL SELECT 'mcp-token', "tokenHash" FROM cutover_legacy."PlatosMCPToken"
        UNION ALL SELECT 'pat', "tokenHash" FROM cutover_legacy."PlatosPAT"
        UNION ALL SELECT 'oauth-access', "tokenHash" FROM cutover_legacy."PlatosOAuthAccessToken"
        UNION ALL SELECT 'oauth-refresh', "tokenHash" FROM cutover_legacy."PlatosOAuthRefreshToken"
      )
      SELECT 1 FROM bearer GROUP BY material
       HAVING count(*) > 1 OR material !~ '^[0-9a-f]{64}$')
    UNION ALL SELECT 'oauth-client-relation-or-hash' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosOAuthClient" client
      LEFT JOIN cutover_legacy."Organization" organization ON organization.id = client."organizationId"
      LEFT JOIN cutover_legacy."User" registered_by ON registered_by.id = client."registeredByUserId"
      LEFT JOIN cutover_legacy."PlatosConnectedEntity" entity ON entity.id = client."entityPk"
      WHERE organization.id IS NULL OR registered_by.id IS NULL
         OR (client."clientSecretHash" IS NOT NULL AND client."clientSecretHash" !~ '^[0-9a-f]{64}$')
         OR (client."entityPk" IS NOT NULL AND (entity.id IS NULL OR entity."organizationId" <> client."organizationId")))
    UNION ALL SELECT 'oauth-child-relation' WHERE EXISTS (
      SELECT 1 FROM (
        SELECT "clientId", "userId", "scopeTuple", "entityPk" FROM cutover_legacy."PlatosOAuthAuthCode"
        UNION ALL SELECT "clientId", "userId", "scopeTuple", "entityPk" FROM cutover_legacy."PlatosOAuthAccessToken"
        UNION ALL SELECT "clientId", "userId", "scopeTuple", "entityPk" FROM cutover_legacy."PlatosOAuthRefreshToken"
      ) child
      LEFT JOIN cutover_legacy."PlatosOAuthClient" client ON client."clientId" = child."clientId"
      LEFT JOIN cutover_legacy."User" source_user ON source_user.id = child."userId"
      WHERE client.id IS NULL OR source_user.id IS NULL
         OR child."entityPk" IS DISTINCT FROM client."entityPk"
         OR jsonb_typeof(child."scopeTuple") <> 'object'
         OR (child."scopeTuple" - 'organizationId' - 'projectId' - 'environmentId') <> '{}'::jsonb
         OR NOT (child."scopeTuple" ? 'organizationId'))
    UNION ALL SELECT 'oauth-scope-ancestry' WHERE EXISTS (
      SELECT 1 FROM (
        SELECT "clientId", "scopeTuple" FROM cutover_legacy."PlatosOAuthAuthCode"
        UNION ALL SELECT "clientId", "scopeTuple" FROM cutover_legacy."PlatosOAuthAccessToken"
        UNION ALL SELECT "clientId", "scopeTuple" FROM cutover_legacy."PlatosOAuthRefreshToken"
      ) child
      JOIN cutover_legacy."PlatosOAuthClient" client ON client."clientId" = child."clientId"
      LEFT JOIN cutover_legacy."Organization" organization
        ON organization.id = child."scopeTuple" ->> 'organizationId'
      LEFT JOIN cutover_legacy."Project" project
        ON project.id = child."scopeTuple" ->> 'projectId'
      LEFT JOIN cutover_legacy."RuntimeEnvironment" environment
        ON environment.id = child."scopeTuple" ->> 'environmentId'
      WHERE organization.id IS NULL OR organization.id <> client."organizationId"
         OR ((child."scopeTuple" ->> 'projectId') IS NOT NULL
             AND (project.id IS NULL OR project."organizationId" <> organization.id))
         OR ((child."scopeTuple" ->> 'environmentId') IS NOT NULL
             AND (project.id IS NULL OR environment.id IS NULL
                  OR environment."projectId" <> project.id
                  OR environment."organizationId" <> organization.id)))
    UNION ALL SELECT 'oauth-refresh-access-relation' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosOAuthRefreshToken" refresh
      LEFT JOIN cutover_legacy."PlatosOAuthAccessToken" access ON access."tokenHash" = refresh."accessTokenHash"
      WHERE refresh."accessTokenHash" IS NOT NULL AND (
        access."tokenHash" IS NULL OR access."clientId" <> refresh."clientId"
        OR access."userId" <> refresh."userId" OR access."scopeTuple" <> refresh."scopeTuple"
        OR access.scopes <> refresh.scopes OR access."entityPk" IS DISTINCT FROM refresh."entityPk"))
    UNION ALL SELECT 'pat-relation' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosPAT" pat
      LEFT JOIN cutover_legacy."User" source_user ON source_user.id = pat."userId"
      LEFT JOIN cutover_legacy."Project" project ON project.id = pat."projectId"
      LEFT JOIN cutover_legacy."RuntimeEnvironment" environment ON environment.id = pat."environmentId"
      WHERE source_user.id IS NULL
         OR (pat."projectId" IS NOT NULL AND (pat."organizationId" IS NULL OR project.id IS NULL OR project."organizationId" <> pat."organizationId"))
         OR (pat."environmentId" IS NOT NULL AND (pat."projectId" IS NULL OR environment.id IS NULL
              OR environment."projectId" <> pat."projectId" OR environment."organizationId" <> pat."organizationId")))
    UNION ALL SELECT 'org-policy-collision-or-effect' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosOrgMcpPolicy"
       GROUP BY "organizationId", pattern HAVING count(*) > 1
      UNION ALL SELECT 1 FROM cutover_legacy."PlatosOrgMcpPolicy"
       WHERE policy NOT IN ('auto_allow', 'require_approval', 'block') OR btrim(pattern) = '')
  )
  SELECT issue FROM issues ORDER BY issue`;

export async function validateRetainedProviderOauthBatch4Source(database: CutoverDatabase): Promise<void> {
  const issues = await database.query<{ issue: string }>(sourceAndMappingValidationSql);
  if (issues.rows.length > 0) {
    throw batch4Failure(
      "BATCH4_SOURCE_OR_MAPPING_INVALID",
      `retained provider/OAuth Batch 4 source validation failed: ${issues.rows.map((row) => row.issue).join(", ")}`
    );
  }
}

interface EnvironmentProviderSourceRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  provider_id: string;
  enabled: boolean;
  linked_at: Date;
  updated_at: Date;
}

export async function backfillBatch4EnvironmentProviders(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch4SourceChunk<EnvironmentProviderSourceRow>(
    database,
    `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
            environment_map.target_id::text AS environment_id, source."providerId" AS provider_id,
            source.enabled, source."linkedAt" AS linked_at, source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosProviderEnabled" source
       JOIN cutover_legacy.cutover_id_map target_map
         ON target_map.mapping_version = 1 AND target_map.source_model = 'PlatosProviderEnabled'
        AND target_map.source_id = source.id AND target_map.target_model = 'EnvironmentProvider'
        AND target_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map environment_map
         ON environment_map.mapping_version = 1 AND environment_map.source_model = 'RuntimeEnvironment'
        AND environment_map.source_id = source."environmentId" AND environment_map.target_model = 'Environment'
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."EnvironmentProvider"
          (id, "environmentId", "providerId", enabled, "linkedAt", "updatedAt")
         VALUES ${parameterTuples(rows.length, 6)}`,
        rows.flatMap((row) => [
          row.target_id,
          row.environment_id,
          row.provider_id,
          row.enabled,
          row.linked_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

interface ProviderCredentialQueryRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  provider: string;
  label: string;
  env_var_name: string;
  is_default: boolean;
  created_by: string;
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
  store_version: unknown;
  store_value: unknown;
  store_created_at: Date;
}

export async function backfillBatch4ProviderCredentials(
  database: CutoverDatabase,
  options: Batch4ProviderSecretOptions,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch4SourceChunk<ProviderCredentialQueryRow>(
    database,
    `SELECT source.id::text AS source_id, provider_map.target_id::text AS target_id,
            environment_map.target_id::text AS environment_id, source.provider, source.label,
            source."envVarName" AS env_var_name, source."isDefault" AS is_default,
            source."createdBy" AS created_by, source."lastUsedAt" AS last_used_at,
            source."createdAt" AS created_at, source."updatedAt" AS updated_at,
            store.version AS store_version, store.value AS store_value,
            store."createdAt" AS store_created_at
       FROM cutover_legacy."PlatosProviderKey" source
       JOIN cutover_legacy.cutover_id_map provider_map
         ON provider_map.mapping_version = 1 AND provider_map.source_model = 'PlatosProviderKey'
        AND provider_map.source_id = source.id AND provider_map.target_model = 'ProviderKey'
        AND provider_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map environment_map
         ON environment_map.mapping_version = 1 AND environment_map.source_model = 'RuntimeEnvironment'
        AND environment_map.source_id = source."environmentId" AND environment_map.target_model = 'Environment'
       JOIN cutover_legacy."SecretStore" store
         ON store.key = 'environmentvariable:' || source."projectId" || ':' || source."environmentId" || ':' || source."envVarName"
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      const targets = rows.map((row) =>
        transformBatch4ProviderCredential(
          {
            sourceId: row.source_id,
            providerKeyId: row.target_id,
            environmentId: row.environment_id,
            provider: row.provider,
            label: row.label,
            envVarName: row.env_var_name,
            isDefault: row.is_default,
            createdBy: row.created_by,
            lastUsedAt: row.last_used_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            storeVersion: row.store_version,
            storeValue: row.store_value,
            storeCreatedAt: row.store_created_at,
          },
          options
        )
      );

      await database.query(
        `INSERT INTO public."Credential"
          (id, "environmentId", "activeSecretVersionId", kind, name, provider,
           "createdBy", "createdAt", "updatedAt")
         VALUES ${parameterTuples(targets.length, 9)}`,
        targets.flatMap((target) => [
          target.credential.id,
          target.credential.environmentId,
          null,
          "SERVICE_CREDENTIAL",
          target.credential.name,
          target.credential.provider,
          target.credential.createdBy,
          target.credential.createdAt,
          target.credential.updatedAt,
        ])
      );
      await database.query(
        `INSERT INTO public."CredentialSecretVersion"
          (id, "credentialId", "secretRevision", "formatVersion", "rootKeyVersion",
           salt, nonce, ciphertext, "authTag", "createdAt")
         VALUES ${parameterTuples(targets.length, 10)}`,
        targets.flatMap((target) => [
          target.secretVersion.id,
          target.secretVersion.credentialId,
          target.secretVersion.secretRevision,
          target.secretVersion.formatVersion,
          target.secretVersion.rootKeyVersion,
          target.secretVersion.salt,
          target.secretVersion.nonce,
          target.secretVersion.ciphertext,
          target.secretVersion.authTag,
          target.secretVersion.createdAt,
        ])
      );
      await database.query(
        `UPDATE public."Credential" credential
            SET "activeSecretVersionId" = pointers.version_id::uuid
           FROM (VALUES ${parameterTuples(targets.length, 2)}) AS pointers(credential_id, version_id)
          WHERE credential.id = pointers.credential_id::uuid`,
        targets.flatMap((target) => [target.credential.id, target.credential.activeSecretVersionId])
      );
      await database.query(
        `INSERT INTO public."ProviderKey"
          (id, "environmentId", "credentialId", provider, label, "environmentKeyName",
           "isDefault", "createdBy", "lastUsedAt", "createdAt", "updatedAt")
         VALUES ${parameterTuples(targets.length, 11)}`,
        targets.flatMap((target) => [
          target.providerKey.id,
          target.providerKey.environmentId,
          target.providerKey.credentialId,
          target.providerKey.provider,
          target.providerKey.label,
          target.providerKey.environmentKeyName,
          target.providerKey.isDefault,
          target.providerKey.createdBy,
          target.providerKey.lastUsedAt,
          target.providerKey.createdAt,
          target.providerKey.updatedAt,
        ])
      );
    },
    chunkSize
  );
}

interface AccessKeySourceRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  key_prefix: string;
  key_hash: string;
  allowed_origins: string[];
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch4AccessKeys(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch4SourceChunk<AccessKeySourceRow>(
    database,
    `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
            environment_map.target_id::text AS environment_id, source."keyPrefix" AS key_prefix,
            source."keyHash" AS key_hash, source."allowedOrigins" AS allowed_origins,
            source."lastUsedAt" AS last_used_at, source."createdAt" AS created_at,
            source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosAccessKey" source
       JOIN cutover_legacy.cutover_id_map target_map
         ON target_map.mapping_version = 1 AND target_map.source_model = 'PlatosAccessKey'
        AND target_map.source_id = source.id AND target_map.target_model = 'AccessKey'
        AND target_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map environment_map
         ON environment_map.mapping_version = 1 AND environment_map.source_model = 'RuntimeEnvironment'
        AND environment_map.source_id = source."environmentId" AND environment_map.target_model = 'Environment'
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      const values = rows.flatMap((row) => [
        row.target_id,
        row.environment_id,
        row.key_prefix,
        validateBatch4Sha256Hash(row.key_hash),
        row.allowed_origins,
        row.last_used_at,
        row.created_at,
        row.updated_at,
      ]);
      await database.query(
        `INSERT INTO public."AccessKey"
          (id, "environmentId", "keyPrefix", "keyHash", "allowedOrigins", "lastUsedAt",
           "createdAt", "updatedAt") VALUES ${parameterTuples(rows.length, 8)}`,
        values
      );
    },
    chunkSize
  );
}

interface McpTokenSourceRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  environment_id: string;
  minted_by_user_id: string;
  name: string;
  token_hash: string;
  permissions: string[];
  tier: string;
  expires_at: Date | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  revoked_by: string | null;
  created_at: Date;
}

export async function backfillBatch4McpTokens(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch4SourceChunk<McpTokenSourceRow>(
    database,
    `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
            environment_map.target_id::text AS environment_id,
            user_map.target_id::text AS minted_by_user_id, source.name,
            source."tokenHash" AS token_hash, source.permissions, source.tier,
            source."expiresAt" AS expires_at, source."lastUsedAt" AS last_used_at,
            source."revokedAt" AS revoked_at, source."revokedBy" AS revoked_by,
            source."createdAt" AS created_at
       FROM cutover_legacy."PlatosMCPToken" source
       JOIN cutover_legacy.cutover_id_map target_map
         ON target_map.mapping_version = 1 AND target_map.source_model = 'PlatosMCPToken'
        AND target_map.source_id = source.id AND target_map.target_model = 'McpToken'
        AND target_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map environment_map
         ON environment_map.mapping_version = 1 AND environment_map.source_model = 'RuntimeEnvironment'
        AND environment_map.source_id = source."environmentId" AND environment_map.target_model = 'Environment'
       JOIN cutover_legacy.cutover_id_map user_map
         ON user_map.mapping_version = 1 AND user_map.source_model = 'User'
        AND user_map.source_id = source."mintedByUserId" AND user_map.target_model = 'User'
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."McpToken"
          (id, "environmentId", "mintedByUserId", name, "tokenHash", permissions, tier,
           "expiresAt", "lastUsedAt", "revokedAt", "revokedBy", "createdAt")
         VALUES ${parameterTuples(rows.length, 12)}`,
        rows.flatMap((row) => [
          row.target_id,
          row.environment_id,
          row.minted_by_user_id,
          row.name,
          validateBatch4Sha256Hash(row.token_hash),
          row.permissions,
          row.tier,
          row.expires_at,
          row.last_used_at,
          row.revoked_at,
          row.revoked_by,
          row.created_at,
        ])
      );
    },
    chunkSize
  );
}

interface ScopeMappingColumns {
  organization_id: string | null;
  project_id: string | null;
  environment_id: string | null;
}

function mappedBatch4Scope(
  normalized: NormalizedBatch4ScopeTuple,
  mappings: ScopeMappingColumns
): MappedBatch4ScopeTuple {
  if (normalized.scopeKind === "GLOBAL") {
    return { scopeKind: "GLOBAL", organizationId: null, projectId: null, environmentId: null };
  }
  if (normalized.scopeKind === "ORGANIZATION") {
    if (!mappings.organization_id) throw batch4Failure("BATCH4_SCOPE_MAPPING_MISSING", "organization mapping is missing");
    return {
      scopeKind: "ORGANIZATION",
      organizationId: mappings.organization_id,
      projectId: null,
      environmentId: null,
    };
  }
  if (normalized.scopeKind === "PROJECT") {
    if (!mappings.project_id) throw batch4Failure("BATCH4_SCOPE_MAPPING_MISSING", "project mapping is missing");
    return { scopeKind: "PROJECT", organizationId: null, projectId: mappings.project_id, environmentId: null };
  }
  if (!mappings.environment_id) {
    throw batch4Failure("BATCH4_SCOPE_MAPPING_MISSING", "environment mapping is missing");
  }
  return {
    scopeKind: "ENVIRONMENT",
    organizationId: null,
    projectId: null,
    environmentId: mappings.environment_id,
  };
}

interface PatSourceRow extends Record<string, unknown>, ScopeMappingColumns {
  source_id: string;
  target_id: string;
  user_id: string;
  token_hash: string;
  name: string;
  organization_source_id: string | null;
  project_source_id: string | null;
  environment_source_id: string | null;
  role: string;
  last_used_at: Date | null;
  expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

export async function backfillBatch4PersonalAccessTokens(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch4SourceChunk<PatSourceRow>(
    database,
    `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
            user_map.target_id::text AS user_id, source."tokenHash" AS token_hash,
            source.name, source."organizationId" AS organization_source_id,
            source."projectId" AS project_source_id, source."environmentId" AS environment_source_id,
            organization_map.target_id::text AS organization_id,
            project_map.target_id::text AS project_id,
            environment_map.target_id::text AS environment_id,
            source.role, source."lastUsedAt" AS last_used_at, source."expiresAt" AS expires_at,
            source."revokedAt" AS revoked_at, source."createdAt" AS created_at
       FROM cutover_legacy."PlatosPAT" source
       JOIN cutover_legacy.cutover_id_map target_map
         ON target_map.mapping_version = 1 AND target_map.source_model = 'PlatosPAT'
        AND target_map.source_id = source.id AND target_map.target_model = 'PersonalAccessToken'
        AND target_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map user_map
         ON user_map.mapping_version = 1 AND user_map.source_model = 'User'
        AND user_map.source_id = source."userId" AND user_map.target_model = 'User'
       LEFT JOIN cutover_legacy.cutover_id_map organization_map
         ON organization_map.mapping_version = 1 AND organization_map.source_model = 'Organization'
        AND organization_map.source_id = source."organizationId" AND organization_map.target_model = 'Organization'
       LEFT JOIN cutover_legacy.cutover_id_map project_map
         ON project_map.mapping_version = 1 AND project_map.source_model = 'Project'
        AND project_map.source_id = source."projectId" AND project_map.target_model = 'Project'
       LEFT JOIN cutover_legacy.cutover_id_map environment_map
         ON environment_map.mapping_version = 1 AND environment_map.source_model = 'RuntimeEnvironment'
        AND environment_map.source_id = source."environmentId" AND environment_map.target_model = 'Environment'
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      const values = rows.flatMap((row) => {
        const scope = mappedBatch4Scope(
          normalizeBatch4ScopeTuple(
            {
              organizationId: row.organization_source_id,
              projectId: row.project_source_id,
              environmentId: row.environment_source_id,
            },
            { allowGlobal: true }
          ),
          row
        );
        return [
          row.target_id,
          row.user_id,
          scope.scopeKind,
          scope.organizationId,
          scope.projectId,
          scope.environmentId,
          validateBatch4Sha256Hash(row.token_hash),
          row.name,
          row.role,
          [],
          row.last_used_at,
          row.expires_at,
          row.revoked_at,
          row.created_at,
        ];
      });
      await database.query(
        `INSERT INTO public."PersonalAccessToken"
          (id, "userId", "scopeKind", "organizationId", "projectId", "environmentId",
           "tokenHash", name, role, permissions, "lastUsedAt", "expiresAt", "revokedAt", "createdAt")
         VALUES ${parameterTuples(rows.length, 14)}`,
        values
      );
    },
    chunkSize
  );
}

interface OAuthClientSourceRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  organization_id: string;
  client_id: string;
  client_secret_hash: string | null;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  registered_by_user_id: string;
  created_at: Date;
  deleted_at: Date | null;
}

export async function backfillBatch4OAuthClients(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch4SourceChunk<OAuthClientSourceRow>(
    database,
    `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
            organization_map.target_id::text AS organization_id, source."clientId" AS client_id,
            source."clientSecretHash" AS client_secret_hash, source."clientName" AS client_name,
            source."redirectUris" AS redirect_uris,
            source."tokenEndpointAuthMethod" AS token_endpoint_auth_method,
            source."grantTypes" AS grant_types,
            user_map.target_id::text AS registered_by_user_id,
            source."createdAt" AS created_at, source."deletedAt" AS deleted_at
       FROM cutover_legacy."PlatosOAuthClient" source
       JOIN cutover_legacy.cutover_id_map target_map
         ON target_map.mapping_version = 1 AND target_map.source_model = 'PlatosOAuthClient'
        AND target_map.source_id = source.id AND target_map.target_model = 'OAuthClient'
        AND target_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map organization_map
         ON organization_map.mapping_version = 1 AND organization_map.source_model = 'Organization'
        AND organization_map.source_id = source."organizationId" AND organization_map.target_model = 'Organization'
       JOIN cutover_legacy.cutover_id_map user_map
         ON user_map.mapping_version = 1 AND user_map.source_model = 'User'
        AND user_map.source_id = source."registeredByUserId" AND user_map.target_model = 'User'
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."OAuthClient"
          (id, "organizationId", "clientId", "clientSecretHash", "clientName",
           "redirectUris", "tokenEndpointAuthMethod", "grantTypes", scopes,
           "registeredByUserId", "entityId", "createdAt", "deletedAt")
         VALUES ${parameterTuples(rows.length, 13)}`,
        rows.flatMap((row) => [
          row.target_id,
          row.organization_id,
          row.client_id,
          row.client_secret_hash === null ? null : validateBatch4Sha256Hash(row.client_secret_hash),
          row.client_name,
          row.redirect_uris,
          row.token_endpoint_auth_method,
          row.grant_types,
          [],
          row.registered_by_user_id,
          null,
          row.created_at,
          row.deleted_at,
        ])
      );
    },
    chunkSize
  );
}

interface OrganizationMcpPolicySourceRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  organization_id: string;
  pattern: string;
  policy: string;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch4OrganizationMcpPolicies(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch4SourceChunk<OrganizationMcpPolicySourceRow>(
    database,
    `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
            organization_map.target_id::text AS organization_id, source.pattern, source.policy,
            source."createdAt" AS created_at, source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosOrgMcpPolicy" source
       JOIN cutover_legacy.cutover_id_map target_map
         ON target_map.mapping_version = 1 AND target_map.source_model = 'PlatosOrgMcpPolicy'
        AND target_map.source_id = source.id AND target_map.target_model = 'OrganizationMcpPolicy'
        AND target_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map organization_map
         ON organization_map.mapping_version = 1 AND organization_map.source_model = 'Organization'
        AND organization_map.source_id = source."organizationId" AND organization_map.target_model = 'Organization'
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."OrganizationMcpPolicy"
          (id, "organizationId", pattern, effect, "createdAt", "updatedAt")
         VALUES ${parameterTuples(rows.length, 6)}`,
        rows.flatMap((row) => [
          row.target_id,
          row.organization_id,
          row.pattern,
          mapBatch4OrganizationMcpPolicy(row.policy),
          row.created_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

interface OAuthScopedSourceRow extends Record<string, unknown>, ScopeMappingColumns {
  source_id: string;
  target_id: string;
  client_id: string;
  user_id: string;
  client_organization_source_id: string;
  scope_tuple: unknown;
  scopes: string[];
}

function mappedOAuthScope(row: OAuthScopedSourceRow): MappedBatch4ScopeTuple {
  const normalized = normalizeBatch4ScopeTuple(row.scope_tuple, { allowGlobal: false });
  if (normalized.organizationSourceId !== row.client_organization_source_id) {
    throw batch4Failure("BATCH4_OAUTH_RELATION_INVALID", "OAuth scope is outside its client organization");
  }
  return mappedBatch4Scope(normalized, row);
}

const oauthScopeMappingJoins = `
       LEFT JOIN cutover_legacy.cutover_id_map organization_map
         ON organization_map.mapping_version = 1 AND organization_map.source_model = 'Organization'
        AND organization_map.source_id = child."scopeTuple" ->> 'organizationId'
        AND organization_map.target_model = 'Organization'
       LEFT JOIN cutover_legacy.cutover_id_map project_map
         ON project_map.mapping_version = 1 AND project_map.source_model = 'Project'
        AND project_map.source_id = child."scopeTuple" ->> 'projectId'
        AND project_map.target_model = 'Project'
       LEFT JOIN cutover_legacy.cutover_id_map environment_map
         ON environment_map.mapping_version = 1 AND environment_map.source_model = 'RuntimeEnvironment'
        AND environment_map.source_id = child."scopeTuple" ->> 'environmentId'
        AND environment_map.target_model = 'Environment'`;

interface OAuthAuthorizationCodeSourceRow extends OAuthScopedSourceRow {
  code_challenge: string;
  code_challenge_method: string;
  redirect_uri: string;
  expires_at: Date;
  used_at: Date | null;
  created_at: Date;
}

export async function backfillBatch4OAuthAuthorizationCodes(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch4SourceChunk<OAuthAuthorizationCodeSourceRow>(
    database,
    `SELECT child.code::text AS source_id, target_map.target_id::text AS target_id,
            client_map.target_id::text AS client_id, user_map.target_id::text AS user_id,
            client."organizationId" AS client_organization_source_id,
            child."scopeTuple" AS scope_tuple, child.scopes,
            organization_map.target_id::text AS organization_id,
            project_map.target_id::text AS project_id,
            environment_map.target_id::text AS environment_id,
            child."codeChallenge" AS code_challenge,
            child."codeChallengeMethod" AS code_challenge_method,
            child."redirectUri" AS redirect_uri, child."expiresAt" AS expires_at,
            child."usedAt" AS used_at, child."createdAt" AS created_at
       FROM cutover_legacy."PlatosOAuthAuthCode" child
       JOIN cutover_legacy.cutover_id_map target_map
         ON target_map.mapping_version = 1 AND target_map.source_model = 'PlatosOAuthAuthCode'
        AND target_map.source_id = child.code AND target_map.target_model = 'OAuthAuthorizationCode'
        AND target_map.stable_suffix = ''
       JOIN cutover_legacy."PlatosOAuthClient" client ON client."clientId" = child."clientId"
       JOIN cutover_legacy.cutover_id_map client_map
         ON client_map.mapping_version = 1 AND client_map.source_model = 'PlatosOAuthClient'
        AND client_map.source_id = client.id AND client_map.target_model = 'OAuthClient'
       JOIN cutover_legacy.cutover_id_map user_map
         ON user_map.mapping_version = 1 AND user_map.source_model = 'User'
        AND user_map.source_id = child."userId" AND user_map.target_model = 'User'
       ${oauthScopeMappingJoins}
      WHERE child.code > $1 ORDER BY child.code LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."OAuthAuthorizationCode"
          (id, "scopeKind", "organizationId", "projectId", "environmentId", "clientId",
           "userId", "codeHash", "codeChallenge", "codeChallengeMethod", "redirectUri",
           scopes, "expiresAt", "usedAt", "createdAt")
         VALUES ${parameterTuples(rows.length, 15)}`,
        rows.flatMap((row) => {
          const scope = mappedOAuthScope(row);
          return [
            row.target_id,
            scope.scopeKind,
            scope.organizationId,
            scope.projectId,
            scope.environmentId,
            row.client_id,
            row.user_id,
            hashBatch4OAuthAuthorizationCode(row.source_id),
            row.code_challenge,
            row.code_challenge_method,
            row.redirect_uri,
            row.scopes,
            row.expires_at,
            row.used_at,
            row.created_at,
          ];
        })
      );
    },
    chunkSize
  );
}

interface OAuthAccessTokenSourceRow extends OAuthScopedSourceRow {
  token_hash: string;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

export async function backfillBatch4OAuthAccessTokens(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch4SourceChunk<OAuthAccessTokenSourceRow>(
    database,
    `SELECT child."tokenHash"::text AS source_id, target_map.target_id::text AS target_id,
            child."tokenHash" AS token_hash, client_map.target_id::text AS client_id,
            user_map.target_id::text AS user_id,
            client."organizationId" AS client_organization_source_id,
            child."scopeTuple" AS scope_tuple, child.scopes,
            organization_map.target_id::text AS organization_id,
            project_map.target_id::text AS project_id,
            environment_map.target_id::text AS environment_id,
            child."issuedAt" AS issued_at, child."expiresAt" AS expires_at,
            child."revokedAt" AS revoked_at
       FROM cutover_legacy."PlatosOAuthAccessToken" child
       JOIN cutover_legacy.cutover_id_map target_map
         ON target_map.mapping_version = 1 AND target_map.source_model = 'PlatosOAuthAccessToken'
        AND target_map.source_id = child."tokenHash" AND target_map.target_model = 'OAuthAccessToken'
        AND target_map.stable_suffix = ''
       JOIN cutover_legacy."PlatosOAuthClient" client ON client."clientId" = child."clientId"
       JOIN cutover_legacy.cutover_id_map client_map
         ON client_map.mapping_version = 1 AND client_map.source_model = 'PlatosOAuthClient'
        AND client_map.source_id = client.id AND client_map.target_model = 'OAuthClient'
       JOIN cutover_legacy.cutover_id_map user_map
         ON user_map.mapping_version = 1 AND user_map.source_model = 'User'
        AND user_map.source_id = child."userId" AND user_map.target_model = 'User'
       ${oauthScopeMappingJoins}
      WHERE child."tokenHash" > $1 ORDER BY child."tokenHash" LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."OAuthAccessToken"
          (id, "tokenHash", "clientId", "userId", "scopeKind", "organizationId",
           "projectId", "environmentId", scopes, "issuedAt", "expiresAt", "revokedAt")
         VALUES ${parameterTuples(rows.length, 12)}`,
        rows.flatMap((row) => {
          const scope = mappedOAuthScope(row);
          return [
            row.target_id,
            validateBatch4Sha256Hash(row.token_hash),
            row.client_id,
            row.user_id,
            scope.scopeKind,
            scope.organizationId,
            scope.projectId,
            scope.environmentId,
            row.scopes,
            row.issued_at,
            row.expires_at,
            row.revoked_at,
          ];
        })
      );
    },
    chunkSize
  );
}

interface OAuthRefreshTokenSourceRow extends OAuthScopedSourceRow {
  token_hash: string;
  access_token_id: string | null;
  issued_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

export async function backfillBatch4OAuthRefreshTokens(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch4SourceChunk<OAuthRefreshTokenSourceRow>(
    database,
    `SELECT child."tokenHash"::text AS source_id, target_map.target_id::text AS target_id,
            child."tokenHash" AS token_hash, access_map.target_id::text AS access_token_id,
            client_map.target_id::text AS client_id, user_map.target_id::text AS user_id,
            client."organizationId" AS client_organization_source_id,
            child."scopeTuple" AS scope_tuple, child.scopes,
            organization_map.target_id::text AS organization_id,
            project_map.target_id::text AS project_id,
            environment_map.target_id::text AS environment_id,
            child."issuedAt" AS issued_at, child."expiresAt" AS expires_at,
            child."revokedAt" AS revoked_at
       FROM cutover_legacy."PlatosOAuthRefreshToken" child
       JOIN cutover_legacy.cutover_id_map target_map
         ON target_map.mapping_version = 1 AND target_map.source_model = 'PlatosOAuthRefreshToken'
        AND target_map.source_id = child."tokenHash" AND target_map.target_model = 'OAuthRefreshToken'
        AND target_map.stable_suffix = ''
       JOIN cutover_legacy."PlatosOAuthClient" client ON client."clientId" = child."clientId"
       JOIN cutover_legacy.cutover_id_map client_map
         ON client_map.mapping_version = 1 AND client_map.source_model = 'PlatosOAuthClient'
        AND client_map.source_id = client.id AND client_map.target_model = 'OAuthClient'
       JOIN cutover_legacy.cutover_id_map user_map
         ON user_map.mapping_version = 1 AND user_map.source_model = 'User'
        AND user_map.source_id = child."userId" AND user_map.target_model = 'User'
       LEFT JOIN cutover_legacy.cutover_id_map access_map
         ON access_map.mapping_version = 1 AND access_map.source_model = 'PlatosOAuthAccessToken'
        AND access_map.source_id = child."accessTokenHash" AND access_map.target_model = 'OAuthAccessToken'
       ${oauthScopeMappingJoins}
      WHERE child."tokenHash" > $1 ORDER BY child."tokenHash" LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."OAuthRefreshToken"
          (id, "tokenHash", "accessTokenId", "clientId", "userId", "scopeKind",
           "organizationId", "projectId", "environmentId", scopes, "rotationFamilyId",
           "parentRefreshTokenId", "issuedAt", "expiresAt", "consumedAt",
           "replayDetectedAt", "revokedAt")
         VALUES ${parameterTuples(rows.length, 17)}`,
        rows.flatMap((row) => {
          const scope = mappedOAuthScope(row);
          return [
            row.target_id,
            validateBatch4Sha256Hash(row.token_hash),
            row.access_token_id,
            row.client_id,
            row.user_id,
            scope.scopeKind,
            scope.organizationId,
            scope.projectId,
            scope.environmentId,
            row.scopes,
            batch4OAuthRefreshFamilyId(row.token_hash),
            null,
            row.issued_at,
            row.expires_at,
            null,
            null,
            row.revoked_at,
          ];
        })
      );
    },
    chunkSize
  );
}

const conservationValidationSql = `
  WITH equations(id, source_count, target_count) AS (
    VALUES
      ('environment-providers',
       (SELECT count(*) FROM cutover_legacy."PlatosProviderEnabled"),
       (SELECT count(*) FROM public."EnvironmentProvider" target
         JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
          AND map.source_model = 'PlatosProviderEnabled' AND map.target_model = 'EnvironmentProvider'
          AND map.target_id = target.id)),
      ('provider-keys',
       (SELECT count(*) FROM cutover_legacy."PlatosProviderKey"),
       (SELECT count(*) FROM public."ProviderKey" target
         JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
          AND map.source_model = 'PlatosProviderKey' AND map.target_model = 'ProviderKey'
          AND map.target_id = target.id)),
      ('provider-credentials',
       (SELECT count(*) FROM cutover_legacy."PlatosProviderKey"),
       (SELECT count(*) FROM public."ProviderKey" provider_key
         JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
          AND map.source_model = 'PlatosProviderKey' AND map.target_model = 'ProviderKey'
          AND map.target_id = provider_key.id
         JOIN public."Credential" credential ON credential.id = provider_key."credentialId")),
      ('provider-secret-versions',
       (SELECT count(*) FROM cutover_legacy."PlatosProviderKey"),
       (SELECT count(*) FROM public."ProviderKey" provider_key
         JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
          AND map.source_model = 'PlatosProviderKey' AND map.target_model = 'ProviderKey'
          AND map.target_id = provider_key.id
         JOIN public."Credential" credential ON credential.id = provider_key."credentialId"
         JOIN public."CredentialSecretVersion" version
           ON version.id = credential."activeSecretVersionId" AND version."credentialId" = credential.id)),
      ('access-keys',
       (SELECT count(*) FROM cutover_legacy."PlatosAccessKey"),
       (SELECT count(*) FROM public."AccessKey" target JOIN cutover_legacy.cutover_id_map map
         ON map.mapping_version = 1 AND map.source_model = 'PlatosAccessKey'
        AND map.target_model = 'AccessKey' AND map.target_id = target.id)),
      ('mcp-tokens',
       (SELECT count(*) FROM cutover_legacy."PlatosMCPToken"),
       (SELECT count(*) FROM public."McpToken" target JOIN cutover_legacy.cutover_id_map map
         ON map.mapping_version = 1 AND map.source_model = 'PlatosMCPToken'
        AND map.target_model = 'McpToken' AND map.target_id = target.id)),
      ('personal-access-tokens',
       (SELECT count(*) FROM cutover_legacy."PlatosPAT"),
       (SELECT count(*) FROM public."PersonalAccessToken" target JOIN cutover_legacy.cutover_id_map map
         ON map.mapping_version = 1 AND map.source_model = 'PlatosPAT'
        AND map.target_model = 'PersonalAccessToken' AND map.target_id = target.id)),
      ('oauth-clients',
       (SELECT count(*) FROM cutover_legacy."PlatosOAuthClient"),
       (SELECT count(*) FROM public."OAuthClient" target JOIN cutover_legacy.cutover_id_map map
         ON map.mapping_version = 1 AND map.source_model = 'PlatosOAuthClient'
        AND map.target_model = 'OAuthClient' AND map.target_id = target.id)),
      ('oauth-authorization-codes',
       (SELECT count(*) FROM cutover_legacy."PlatosOAuthAuthCode"),
       (SELECT count(*) FROM public."OAuthAuthorizationCode" target JOIN cutover_legacy.cutover_id_map map
         ON map.mapping_version = 1 AND map.source_model = 'PlatosOAuthAuthCode'
        AND map.target_model = 'OAuthAuthorizationCode' AND map.target_id = target.id)),
      ('oauth-access-tokens',
       (SELECT count(*) FROM cutover_legacy."PlatosOAuthAccessToken"),
       (SELECT count(*) FROM public."OAuthAccessToken" target JOIN cutover_legacy.cutover_id_map map
         ON map.mapping_version = 1 AND map.source_model = 'PlatosOAuthAccessToken'
        AND map.target_model = 'OAuthAccessToken' AND map.target_id = target.id)),
      ('oauth-refresh-tokens',
       (SELECT count(*) FROM cutover_legacy."PlatosOAuthRefreshToken"),
       (SELECT count(*) FROM public."OAuthRefreshToken" target JOIN cutover_legacy.cutover_id_map map
         ON map.mapping_version = 1 AND map.source_model = 'PlatosOAuthRefreshToken'
        AND map.target_model = 'OAuthRefreshToken' AND map.target_id = target.id)),
      ('organization-mcp-policies',
       (SELECT count(*) FROM cutover_legacy."PlatosOrgMcpPolicy"),
       (SELECT count(*) FROM public."OrganizationMcpPolicy" target JOIN cutover_legacy.cutover_id_map map
         ON map.mapping_version = 1 AND map.source_model = 'PlatosOrgMcpPolicy'
        AND map.target_model = 'OrganizationMcpPolicy' AND map.target_id = target.id))
  )
  SELECT id FROM equations WHERE source_count <> target_count ORDER BY id`;

const ancestryValidationSql = `
  WITH issues AS (
    SELECT 'provider-credential' AS issue
      FROM public."ProviderKey" provider_key
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosProviderKey' AND map.target_model = 'ProviderKey'
       AND map.target_id = provider_key.id
      LEFT JOIN public."Credential" credential
        ON credential.id = provider_key."credentialId"
       AND credential."environmentId" = provider_key."environmentId"
       AND credential.name = provider_key."environmentKeyName"
       AND credential.provider = provider_key.provider
      LEFT JOIN public."CredentialSecretVersion" version
        ON version.id = credential."activeSecretVersionId"
       AND version."credentialId" = credential.id
     WHERE credential.id IS NULL OR version.id IS NULL OR credential.kind <> 'SERVICE_CREDENTIAL'
        OR version."secretRevision" <> 1 OR version."formatVersion" <> 1 OR version."retiredAt" IS NOT NULL
    UNION ALL
    SELECT 'oauth-client-scope' FROM public."OAuthAuthorizationCode" child
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosOAuthAuthCode' AND map.target_model = 'OAuthAuthorizationCode'
       AND map.target_id = child.id
      JOIN public."OAuthClient" client ON client.id = child."clientId"
      LEFT JOIN public."Organization" organization ON organization.id = child."organizationId"
      LEFT JOIN public."Project" project ON project.id = child."projectId"
      LEFT JOIN public."Environment" environment ON environment.id = child."environmentId"
      LEFT JOIN public."Project" environment_project ON environment_project.id = environment."projectId"
     WHERE (child."scopeKind" = 'ORGANIZATION' AND organization.id IS DISTINCT FROM client."organizationId")
        OR (child."scopeKind" = 'PROJECT' AND project."organizationId" IS DISTINCT FROM client."organizationId")
        OR (child."scopeKind" = 'ENVIRONMENT' AND environment_project."organizationId" IS DISTINCT FROM client."organizationId")
    UNION ALL
    SELECT 'oauth-client-scope' FROM public."OAuthAccessToken" child
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosOAuthAccessToken' AND map.target_model = 'OAuthAccessToken'
       AND map.target_id = child.id
      JOIN public."OAuthClient" client ON client.id = child."clientId"
      LEFT JOIN public."Organization" organization ON organization.id = child."organizationId"
      LEFT JOIN public."Project" project ON project.id = child."projectId"
      LEFT JOIN public."Environment" environment ON environment.id = child."environmentId"
      LEFT JOIN public."Project" environment_project ON environment_project.id = environment."projectId"
     WHERE (child."scopeKind" = 'ORGANIZATION' AND organization.id IS DISTINCT FROM client."organizationId")
        OR (child."scopeKind" = 'PROJECT' AND project."organizationId" IS DISTINCT FROM client."organizationId")
        OR (child."scopeKind" = 'ENVIRONMENT' AND environment_project."organizationId" IS DISTINCT FROM client."organizationId")
    UNION ALL
    SELECT 'oauth-client-scope' FROM public."OAuthRefreshToken" child
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosOAuthRefreshToken' AND map.target_model = 'OAuthRefreshToken'
       AND map.target_id = child.id
      JOIN public."OAuthClient" client ON client.id = child."clientId"
      LEFT JOIN public."Organization" organization ON organization.id = child."organizationId"
      LEFT JOIN public."Project" project ON project.id = child."projectId"
      LEFT JOIN public."Environment" environment ON environment.id = child."environmentId"
      LEFT JOIN public."Project" environment_project ON environment_project.id = environment."projectId"
     WHERE (child."scopeKind" = 'ORGANIZATION' AND organization.id IS DISTINCT FROM client."organizationId")
        OR (child."scopeKind" = 'PROJECT' AND project."organizationId" IS DISTINCT FROM client."organizationId")
        OR (child."scopeKind" = 'ENVIRONMENT' AND environment_project."organizationId" IS DISTINCT FROM client."organizationId")
  )
  SELECT DISTINCT issue FROM issues ORDER BY issue`;

const semanticValidationSql = `
  WITH issues AS (
    SELECT 'access-key-material' AS issue FROM cutover_legacy."PlatosAccessKey" source
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosAccessKey' AND map.target_model = 'AccessKey'
       AND map.source_id = source.id
      JOIN public."AccessKey" target ON target.id = map.target_id
     WHERE target."keyHash" <> source."keyHash"
    UNION ALL
    SELECT 'mcp-token-material' FROM cutover_legacy."PlatosMCPToken" source
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosMCPToken' AND map.target_model = 'McpToken'
       AND map.source_id = source.id
      JOIN public."McpToken" target ON target.id = map.target_id
     WHERE target."tokenHash" <> source."tokenHash"
    UNION ALL
    SELECT 'pat-material' FROM cutover_legacy."PlatosPAT" source
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosPAT' AND map.target_model = 'PersonalAccessToken'
       AND map.source_id = source.id
      JOIN public."PersonalAccessToken" target ON target.id = map.target_id
     WHERE target."tokenHash" <> source."tokenHash"
    UNION ALL
    SELECT 'oauth-access-material' FROM cutover_legacy."PlatosOAuthAccessToken" source
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosOAuthAccessToken' AND map.target_model = 'OAuthAccessToken'
       AND map.source_id = source."tokenHash"
      JOIN public."OAuthAccessToken" target ON target.id = map.target_id
     WHERE target."tokenHash" <> source."tokenHash"
    UNION ALL
    SELECT 'oauth-refresh-material' FROM cutover_legacy."PlatosOAuthRefreshToken" source
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosOAuthRefreshToken' AND map.target_model = 'OAuthRefreshToken'
       AND map.source_id = source."tokenHash"
      JOIN public."OAuthRefreshToken" target ON target.id = map.target_id
     WHERE target."tokenHash" <> source."tokenHash"
        OR target."parentRefreshTokenId" IS NOT NULL OR target."consumedAt" IS NOT NULL
        OR target."replayDetectedAt" IS NOT NULL
    UNION ALL
    SELECT 'oauth-refresh-access-link' FROM cutover_legacy."PlatosOAuthRefreshToken" source
      JOIN cutover_legacy.cutover_id_map refresh_map ON refresh_map.mapping_version = 1
       AND refresh_map.source_model = 'PlatosOAuthRefreshToken'
       AND refresh_map.target_model = 'OAuthRefreshToken' AND refresh_map.source_id = source."tokenHash"
      JOIN public."OAuthRefreshToken" target ON target.id = refresh_map.target_id
      LEFT JOIN cutover_legacy.cutover_id_map access_map ON access_map.mapping_version = 1
       AND access_map.source_model = 'PlatosOAuthAccessToken'
       AND access_map.target_model = 'OAuthAccessToken' AND access_map.source_id = source."accessTokenHash"
     WHERE target."accessTokenId" IS DISTINCT FROM access_map.target_id
    UNION ALL
    SELECT 'organization-policy-effect' FROM cutover_legacy."PlatosOrgMcpPolicy" source
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosOrgMcpPolicy' AND map.target_model = 'OrganizationMcpPolicy'
       AND map.source_id = source.id
      JOIN public."OrganizationMcpPolicy" target ON target.id = map.target_id
     WHERE target.effect <> CASE WHEN source.policy = 'auto_allow' THEN 'ALLOW'::"PolicyEffect" ELSE 'DENY'::"PolicyEffect" END
  )
  SELECT DISTINCT issue FROM issues ORDER BY issue`;

async function assertBatch4ValidationQuery(
  database: CutoverDatabase,
  sql: string,
  code: string,
  summary: string
): Promise<void> {
  const issues = await database.query<{ id?: string; issue?: string }>(sql);
  if (issues.rows.length > 0) {
    throw batch4Failure(
      code,
      `${summary}: ${issues.rows.map((row) => row.id ?? row.issue ?? "unknown").join(", ")}`
    );
  }
}

export async function validateRetainedProviderOauthBatch4(database: CutoverDatabase): Promise<void> {
  await assertBatch4ValidationQuery(
    database,
    conservationValidationSql,
    "BATCH4_CONSERVATION_FAILED",
    "retained provider/OAuth Batch 4 conservation failed"
  );
  await assertBatch4ValidationQuery(
    database,
    ancestryValidationSql,
    "BATCH4_ANCESTRY_FAILED",
    "retained provider/OAuth Batch 4 ancestry failed"
  );
  await assertBatch4ValidationQuery(
    database,
    semanticValidationSql,
    "BATCH4_SEMANTIC_VALIDATION_FAILED",
    "retained provider/OAuth Batch 4 semantic validation failed"
  );
}

export async function backfillRetainedProviderOauthBatch4(
  database: CutoverDatabase,
  options: Batch4ProviderSecretOptions,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<RetainedProviderOauthBatch4Evidence> {
  await validateRetainedProviderOauthBatch4Source(database);
  const environmentProviders = await backfillBatch4EnvironmentProviders(database, chunkSize);
  const providerKeys = await backfillBatch4ProviderCredentials(database, options, chunkSize);
  const accessKeys = await backfillBatch4AccessKeys(database, chunkSize);
  const mcpTokens = await backfillBatch4McpTokens(database, chunkSize);
  const personalAccessTokens = await backfillBatch4PersonalAccessTokens(database, chunkSize);
  const oauthClients = await backfillBatch4OAuthClients(database, chunkSize);
  const oauthAuthorizationCodes = await backfillBatch4OAuthAuthorizationCodes(database, chunkSize);
  const oauthAccessTokens = await backfillBatch4OAuthAccessTokens(database, chunkSize);
  const oauthRefreshTokens = await backfillBatch4OAuthRefreshTokens(database, chunkSize);
  const organizationMcpPolicies = await backfillBatch4OrganizationMcpPolicies(database, chunkSize);
  await validateRetainedProviderOauthBatch4(database);

  const evidence: RetainedProviderOauthBatch4Evidence = {
    batch: "retained-provider-oauth-batch4",
    sourceRows: Object.freeze({
      environmentProviders,
      providerKeys,
      accessKeys,
      mcpTokens,
      personalAccessTokens,
      oauthClients,
      oauthAuthorizationCodes,
      oauthAccessTokens,
      oauthRefreshTokens,
      organizationMcpPolicies,
    }),
    targetRows: Object.freeze({
      environmentProviders,
      providerKeys,
      providerCredentials: providerKeys,
      providerCredentialVersions: providerKeys,
      accessKeys,
      mcpTokens,
      personalAccessTokens,
      oauthClients,
      oauthAuthorizationCodes,
      oauthAccessTokens,
      oauthRefreshTokens,
      organizationMcpPolicies,
    }),
  };
  assertSecretFreeCutoverEvidence(evidence);
  return Object.freeze(evidence);
}
