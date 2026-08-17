import { CUTOVER_CHUNK_SIZE } from "./cutover-backfill";
import {
  assertSecretFreeCutoverEvidence,
  decodeLegacyJsonMessage,
  serializeAggregateCredentialPayload,
  type CutoverJsonValue,
} from "./cutover-crypto";
import { mapCutoverId } from "./cutover-id";
import { aggregateCredentialPayloadContracts } from "./cutover-ledger";
import { normalizeJsonField, type JsonValue } from "./json";
import { CredentialRootKeyRing, decryptCredentialSecret, encryptCredentialSecret } from "./secrets";
import type { CutoverDatabase } from "./cutover-types";
import { CutoverFailure } from "./cutover-types";

export const retainedChannelBatch5SourceModels = [
  "PlatosChannelConnection",
  "PlatosChannelThread",
  "PlatosChannelApp",
  "PlatosChannelInstallation",
  "PlatosChannelAppThread",
] as const;

export const retainedChannelBatch5MappingTargets = [
  { sourceModel: "PlatosChannelConnection", targetModel: "ChannelConnection", stableSuffix: "" },
  { sourceModel: "PlatosChannelConnection", targetModel: "Credential", stableSuffix: "credential" },
  {
    sourceModel: "PlatosChannelConnection",
    targetModel: "CredentialSecretVersion",
    stableSuffix: "credential-secret-version:1",
  },
  { sourceModel: "PlatosChannelThread", targetModel: "ChannelThread", stableSuffix: "" },
  { sourceModel: "PlatosChannelApp", targetModel: "ChannelApp", stableSuffix: "" },
  { sourceModel: "PlatosChannelApp", targetModel: "Credential", stableSuffix: "credential" },
  {
    sourceModel: "PlatosChannelApp",
    targetModel: "CredentialSecretVersion",
    stableSuffix: "credential-secret-version:1",
  },
  {
    sourceModel: "PlatosChannelInstallation",
    targetModel: "ChannelInstallation",
    stableSuffix: "",
  },
  {
    sourceModel: "PlatosChannelInstallation",
    targetModel: "Credential",
    stableSuffix: "credential",
  },
  {
    sourceModel: "PlatosChannelInstallation",
    targetModel: "CredentialSecretVersion",
    stableSuffix: "credential-secret-version:1",
  },
  { sourceModel: "PlatosChannelAppThread", targetModel: "ChannelAppThread", stableSuffix: "" },
] as const;

type Batch5CredentialSourceModel =
  | "PlatosChannelConnection"
  | "PlatosChannelApp"
  | "PlatosChannelInstallation";

type Batch5RoutingField =
  | "ChannelConnection.agentRouting"
  | "ChannelApp.agentRouting"
  | "ChannelInstallation.agentRouting";

export interface RetainedChannelBatch5Options {
  readonly messageEncryptionKeys: Readonly<Record<string, string>>;
  readonly credentialRootKeyRing: CredentialRootKeyRing;
}

export interface RetainedChannelBatch5Evidence {
  readonly batch: "retained-channel-batch5";
  readonly sourceRows: Readonly<Record<string, number>>;
  readonly targetRows: Readonly<Record<string, number>>;
}

export interface Batch5CredentialTarget {
  readonly credential: {
    readonly id: string;
    readonly environmentId: string;
    readonly activeVersionId: string;
    readonly name: string;
    readonly provider: string;
    readonly externalClientId: string | null;
    readonly expiresAt: Date | null;
    readonly revokedAt: Date | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  };
  readonly version: {
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

const connectionAggregate = aggregateCredentialPayloadContracts.find(
  (contract) => contract.id === "channel-connection-auth"
)!;
const appAggregate = aggregateCredentialPayloadContracts.find(
  (contract) => contract.id === "channel-app-auth"
)!;
const installationAggregate = aggregateCredentialPayloadContracts.find(
  (contract) => contract.id === "channel-installation-tokens"
)!;

function batch5Failure(code: string, summary: string): CutoverFailure {
  return new CutoverFailure(code, summary);
}

function parameterTuples(rowCount: number, width: number): string {
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const offset = rowIndex * width;
    return `(${Array.from(
      { length: width },
      (__, columnIndex) => `$${offset + columnIndex + 1}`
    ).join(", ")})`;
  }).join(", ");
}

async function forEachBatch5SourceChunk<Row extends Record<string, unknown>>(
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
      throw batch5Failure(
        "BATCH5_CHUNK_ORDER_INVALID",
        "retained channel Batch 5 source chunk order is not stable"
      );
    }
    cursor = nextCursor;
    count += result.rows.length;
  }
}

function canonicalizeJson(value: CutoverJsonValue): CutoverJsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, canonicalizeJson(child)])
  );
}

function requiredUtf8(value: unknown, code: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw batch5Failure(code, "retained channel Batch 5 required component is unavailable");
  }
  try {
    const encoded = Buffer.from(value, "utf8");
    if (new TextDecoder("utf-8", { fatal: true }).decode(encoded) !== value) throw new Error();
  } catch {
    throw batch5Failure(code, "retained channel Batch 5 required component is unavailable");
  }
  return value;
}

function decodeEnvelope(
  value: unknown,
  messageEncryptionKeys: Readonly<Record<string, string>>,
  code: string
): CutoverJsonValue {
  try {
    const decoded = decodeLegacyJsonMessage(value, "TEXT", messageEncryptionKeys);
    if (decoded.encoding !== "ENVELOPE") throw new Error();
    return decoded.value as CutoverJsonValue;
  } catch {
    throw batch5Failure(code, "retained channel Batch 5 encrypted component is unreadable");
  }
}

function decodeEnvelopeString(
  value: unknown,
  messageEncryptionKeys: Readonly<Record<string, string>>,
  code: string
): string {
  const decoded = decodeEnvelope(value, messageEncryptionKeys, code);
  return requiredUtf8(decoded, code);
}

export function normalizeBatch5Routing(field: Batch5RoutingField, value: unknown): JsonValue {
  try {
    return normalizeJsonField(field, value ?? []) as unknown as JsonValue;
  } catch {
    throw batch5Failure(
      "BATCH5_ROUTING_JSON_INVALID",
      "retained channel Batch 5 routing JSON must have an array root"
    );
  }
}

export function batch5ExternalInstallationId(input: {
  readonly provider: unknown;
  readonly teamId: unknown;
  readonly enterpriseId: unknown;
  readonly isEnterpriseInstall: unknown;
}): string {
  const provider = requiredUtf8(input.provider, "BATCH5_INSTALLATION_IDENTITY_INVALID");
  const teamId =
    input.teamId === null
      ? null
      : requiredUtf8(input.teamId, "BATCH5_INSTALLATION_IDENTITY_INVALID");
  const enterpriseId =
    input.enterpriseId === null
      ? null
      : requiredUtf8(input.enterpriseId, "BATCH5_INSTALLATION_IDENTITY_INVALID");
  if (typeof input.isEnterpriseInstall !== "boolean") {
    throw batch5Failure(
      "BATCH5_INSTALLATION_IDENTITY_INVALID",
      "channel installation ownership is ambiguous"
    );
  }
  if (input.isEnterpriseInstall) {
    if (teamId !== null || enterpriseId === null) {
      throw batch5Failure(
        "BATCH5_INSTALLATION_IDENTITY_INVALID",
        "channel installation ownership is ambiguous"
      );
    }
    return `${provider}:enterprise:${enterpriseId}`;
  }
  if (teamId === null || enterpriseId !== null) {
    throw batch5Failure(
      "BATCH5_INSTALLATION_IDENTITY_INVALID",
      "channel installation ownership is ambiguous"
    );
  }
  return `${provider}:team:${teamId}`;
}

export function batch5CredentialIds(
  sourceModel: Batch5CredentialSourceModel,
  sourceId: string
): Readonly<{ credentialId: string; versionId: string }> {
  return Object.freeze({
    credentialId: mapCutoverId({ sourceModel, sourceId, suffix: "credential" }),
    versionId: mapCutoverId({
      sourceModel,
      sourceId,
      suffix: "credential-secret-version:1",
    }),
  });
}

export function batch5CredentialName(
  sourceModel: Batch5CredentialSourceModel,
  sourceId: string
): string {
  const suffix =
    sourceModel === "PlatosChannelConnection"
      ? connectionAggregate.targetCredentialNameSuffix
      : sourceModel === "PlatosChannelApp"
      ? appAggregate.targetCredentialNameSuffix
      : installationAggregate.targetCredentialNameSuffix;
  return `${sourceModel}:${sourceId}:${suffix}`;
}

export function buildBatch5ConnectionPayload(
  credentials: unknown,
  webhookSecret: unknown,
  messageEncryptionKeys: Readonly<Record<string, string>>
): string {
  let decodedCredentials: string | null = null;
  if (credentials !== null && credentials !== undefined) {
    const decoded = decodeEnvelope(
      credentials,
      messageEncryptionKeys,
      "BATCH5_CONNECTION_CREDENTIALS_UNREADABLE"
    );
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw batch5Failure(
        "BATCH5_CONNECTION_CREDENTIALS_UNREADABLE",
        "retained channel Batch 5 connection credentials are invalid"
      );
    }
    decodedCredentials = JSON.stringify(canonicalizeJson(decoded));
  }
  try {
    return serializeAggregateCredentialPayload(connectionAggregate, {
      "PlatosChannelConnection.credentials": decodedCredentials,
      "PlatosChannelConnection.webhookSecret": requiredUtf8(
        webhookSecret,
        "BATCH5_CONNECTION_WEBHOOK_REQUIRED"
      ),
    });
  } catch (error) {
    if (error instanceof CutoverFailure) throw error;
    throw batch5Failure(
      "BATCH5_CONNECTION_AGGREGATE_INVALID",
      "retained channel Batch 5 connection aggregate is invalid"
    );
  }
}

export function buildBatch5AppPayload(
  clientSecret: unknown,
  signingSecret: unknown,
  messageEncryptionKeys: Readonly<Record<string, string>>
): string {
  try {
    return serializeAggregateCredentialPayload(appAggregate, {
      "PlatosChannelApp.clientSecret": decodeEnvelopeString(
        clientSecret,
        messageEncryptionKeys,
        "BATCH5_APP_CLIENT_SECRET_REQUIRED"
      ),
      "PlatosChannelApp.signingSecret": decodeEnvelopeString(
        signingSecret,
        messageEncryptionKeys,
        "BATCH5_APP_SIGNING_SECRET_REQUIRED"
      ),
    });
  } catch (error) {
    if (error instanceof CutoverFailure) throw error;
    throw batch5Failure(
      "BATCH5_APP_AGGREGATE_INVALID",
      "retained channel Batch 5 app aggregate is invalid"
    );
  }
}

export function buildBatch5InstallationPayload(
  botToken: unknown,
  refreshToken: unknown,
  messageEncryptionKeys: Readonly<Record<string, string>>
): string {
  try {
    return serializeAggregateCredentialPayload(installationAggregate, {
      "PlatosChannelInstallation.botToken": decodeEnvelopeString(
        botToken,
        messageEncryptionKeys,
        "BATCH5_INSTALLATION_BOT_TOKEN_REQUIRED"
      ),
      "PlatosChannelInstallation.refreshToken":
        refreshToken === null || refreshToken === undefined
          ? null
          : decodeEnvelopeString(
              refreshToken,
              messageEncryptionKeys,
              "BATCH5_INSTALLATION_REFRESH_TOKEN_UNREADABLE"
            ),
    });
  } catch (error) {
    if (error instanceof CutoverFailure) throw error;
    throw batch5Failure(
      "BATCH5_INSTALLATION_AGGREGATE_INVALID",
      "retained channel Batch 5 installation aggregate is invalid"
    );
  }
}

export function transformBatch5Credential(input: {
  readonly sourceModel: Batch5CredentialSourceModel;
  readonly sourceId: string;
  readonly environmentId: string;
  readonly provider: string;
  readonly externalClientId: string | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly plaintext: string;
  readonly keyRing: CredentialRootKeyRing;
}): Batch5CredentialTarget {
  const ids = batch5CredentialIds(input.sourceModel, input.sourceId);
  const context = {
    credentialId: ids.credentialId,
    environmentId: input.environmentId,
    secretRevision: 1,
    formatVersion: 1,
    rootKeyVersion: input.keyRing.activeVersion,
  };
  try {
    const envelope = encryptCredentialSecret(
      input.keyRing.key(input.keyRing.activeVersion),
      context,
      input.plaintext
    );
    decryptCredentialSecret(input.keyRing.key(input.keyRing.activeVersion), context, envelope);
    return Object.freeze({
      credential: Object.freeze({
        id: ids.credentialId,
        environmentId: input.environmentId,
        activeVersionId: ids.versionId,
        name: batch5CredentialName(input.sourceModel, input.sourceId),
        provider: input.provider,
        externalClientId: input.externalClientId,
        expiresAt: input.expiresAt,
        revokedAt: input.revokedAt,
        createdAt: new Date(input.createdAt),
        updatedAt: new Date(input.updatedAt),
      }),
      version: Object.freeze({
        id: ids.versionId,
        credentialId: ids.credentialId,
        secretRevision: 1 as const,
        formatVersion: 1 as const,
        rootKeyVersion: input.keyRing.activeVersion,
        salt: Buffer.from(envelope.salt),
        nonce: Buffer.from(envelope.nonce),
        ciphertext: Buffer.from(envelope.ciphertext),
        authTag: Buffer.from(envelope.authTag),
        createdAt: new Date(input.createdAt),
      }),
    });
  } catch {
    throw batch5Failure(
      "BATCH5_TARGET_ENVELOPE_FAILED",
      "retained channel Batch 5 target envelope validation failed"
    );
  }
}

interface DynamicMappingRow extends Record<string, unknown> {
  source_id: string;
}

/** Adds only Batch 5's deterministic aggregate credential mappings. */
export async function materializeRetainedChannelBatch5Mappings(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  await database.query(`DELETE FROM cutover_legacy.cutover_id_map
    WHERE mapping_version = 1
      AND source_model IN ('PlatosChannelConnection', 'PlatosChannelApp', 'PlatosChannelInstallation')
      AND target_model IN ('Credential', 'CredentialSecretVersion')`);

  let count = 0;
  for (const sourceModel of [
    "PlatosChannelConnection",
    "PlatosChannelApp",
    "PlatosChannelInstallation",
  ] as const) {
    count +=
      (await forEachBatch5SourceChunk<DynamicMappingRow>(
        database,
        `SELECT source.id::text AS source_id FROM cutover_legacy."${sourceModel}" source
        WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
        async (rows) => {
          const mappings = rows.flatMap((row) =>
            [
              { targetModel: "Credential", suffix: "credential" },
              { targetModel: "CredentialSecretVersion", suffix: "credential-secret-version:1" },
            ].map((target) => ({ row, target }))
          );
          await database.query(
            `INSERT INTO cutover_legacy.cutover_id_map
            (mapping_version, source_model, source_id, target_model, stable_suffix, target_id)
           VALUES ${parameterTuples(mappings.length, 6)}`,
            mappings.flatMap(({ row, target }) => [
              1,
              sourceModel,
              row.source_id,
              target.targetModel,
              target.suffix,
              mapCutoverId({ sourceModel, sourceId: row.source_id, suffix: target.suffix }),
            ])
          );
        },
        chunkSize
      )) * 2;
  }
  return count;
}

const sourceAndMappingValidationSql = `
  WITH issues AS (
    SELECT 'missing-static-mapping' AS issue WHERE EXISTS (
      SELECT 1 FROM (
        SELECT 'PlatosChannelConnection'::text source_model, id::text source_id, 'ChannelConnection'::text target_model FROM cutover_legacy."PlatosChannelConnection"
        UNION ALL SELECT 'PlatosChannelThread', id::text, 'ChannelThread' FROM cutover_legacy."PlatosChannelThread"
        UNION ALL SELECT 'PlatosChannelApp', id::text, 'ChannelApp' FROM cutover_legacy."PlatosChannelApp"
        UNION ALL SELECT 'PlatosChannelInstallation', id::text, 'ChannelInstallation' FROM cutover_legacy."PlatosChannelInstallation"
        UNION ALL SELECT 'PlatosChannelAppThread', id::text, 'ChannelAppThread' FROM cutover_legacy."PlatosChannelAppThread"
      ) source WHERE (SELECT count(*) FROM cutover_legacy.cutover_id_map map
        WHERE map.mapping_version = 1 AND map.source_model = source.source_model
          AND map.source_id = source.source_id AND map.target_model = source.target_model
          AND map.stable_suffix = '') <> 1)
    UNION ALL SELECT 'missing-aggregate-mapping' WHERE EXISTS (
      SELECT 1 FROM (
        SELECT source_model, source_id, target_model, stable_suffix
        FROM (
          SELECT 'PlatosChannelConnection'::text source_model, id::text source_id FROM cutover_legacy."PlatosChannelConnection"
          UNION ALL SELECT 'PlatosChannelApp', id::text FROM cutover_legacy."PlatosChannelApp"
          UNION ALL SELECT 'PlatosChannelInstallation', id::text FROM cutover_legacy."PlatosChannelInstallation"
        ) source CROSS JOIN (VALUES
          ('Credential'::text, 'credential'::text),
          ('CredentialSecretVersion'::text, 'credential-secret-version:1'::text)
        ) target(target_model, stable_suffix)
      ) expected WHERE (SELECT count(*) FROM cutover_legacy.cutover_id_map map
        WHERE map.mapping_version = 1 AND map.source_model = expected.source_model
          AND map.source_id = expected.source_id AND map.target_model = expected.target_model
          AND map.stable_suffix = expected.stable_suffix) <> 1)
    UNION ALL SELECT 'missing-reference-mapping' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosChannelConnection" source
       WHERE (SELECT count(*) FROM cutover_legacy.cutover_id_map map
               WHERE map.mapping_version = 1 AND map.source_model = 'RuntimeEnvironment'
                 AND map.source_id = source."environmentId" AND map.target_model = 'Environment'
                 AND map.stable_suffix = '') <> 1
      UNION ALL
      SELECT 1 FROM cutover_legacy."PlatosChannelApp" source
       WHERE (SELECT count(*) FROM cutover_legacy.cutover_id_map map
               WHERE map.mapping_version = 1 AND map.source_model = 'RuntimeEnvironment'
                 AND map.source_id = source."environmentId" AND map.target_model = 'Environment'
                 AND map.stable_suffix = '') <> 1
          OR (source."defaultAgentId" IS NOT NULL AND
              (SELECT count(*) FROM cutover_legacy.cutover_id_map map
                WHERE map.mapping_version = 1 AND map.source_model = 'PlatosAgent'
                  AND map.source_id = source."defaultAgentId" AND map.target_model = 'Agent'
                  AND map.stable_suffix = '') <> 1)
      UNION ALL
      SELECT 1 FROM cutover_legacy."PlatosChannelThread" source
       WHERE (SELECT count(*) FROM cutover_legacy.cutover_id_map map
               WHERE map.mapping_version = 1 AND map.source_model = 'PlatosAgentThread'
                 AND map.source_id = source."platosThreadId" AND map.target_model = 'Thread'
                 AND map.stable_suffix = '') <> 1
      UNION ALL
      SELECT 1 FROM cutover_legacy."PlatosChannelAppThread" source
       WHERE (SELECT count(*) FROM cutover_legacy.cutover_id_map map
               WHERE map.mapping_version = 1 AND map.source_model = 'PlatosAgentThread'
                 AND map.source_id = source."platosThreadId" AND map.target_model = 'Thread'
                 AND map.stable_suffix = '') <> 1)
    UNION ALL SELECT 'environment-owner-ambiguity' WHERE EXISTS (
      SELECT 1 FROM (
        SELECT "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosChannelConnection"
        UNION ALL SELECT "organizationId", "projectId", "environmentId" FROM cutover_legacy."PlatosChannelApp"
      ) source
      LEFT JOIN cutover_legacy."Project" project ON project.id = source."projectId"
      LEFT JOIN cutover_legacy."RuntimeEnvironment" environment ON environment.id = source."environmentId"
      WHERE project.id IS NULL OR environment.id IS NULL
         OR project."organizationId" <> source."organizationId"
         OR environment."organizationId" <> source."organizationId"
         OR environment."projectId" <> source."projectId")
    UNION ALL SELECT 'connection-required-field' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosChannelConnection"
       WHERE btrim(provider) = '' OR btrim("agentId") = '' OR btrim("webhookSecret") = '')
    UNION ALL SELECT 'connection-reference-ancestry' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosChannelConnection" source
      LEFT JOIN cutover_legacy."PlatosAgent" agent ON agent.id = source."agentId"
      LEFT JOIN cutover_legacy."PlatosConnectedEntity" entity ON entity.id = source."entityPk"
      WHERE agent.id IS NULL OR agent."organizationId" <> source."organizationId"
         OR agent."projectId" <> source."projectId" OR agent."environmentId" <> source."environmentId"
         OR (source."entityPk" IS NOT NULL AND (entity.id IS NULL
             OR entity."organizationId" <> source."organizationId"
             OR entity."projectId" <> source."projectId")))
    UNION ALL SELECT 'app-required-field' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosChannelApp"
       WHERE btrim(provider) = '' OR btrim("clientId") = '' OR btrim(distribution) = '')
    UNION ALL SELECT 'app-default-agent-ancestry' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosChannelApp" source
      LEFT JOIN cutover_legacy."PlatosAgent" agent ON agent.id = source."defaultAgentId"
      WHERE source."defaultAgentId" IS NOT NULL AND (agent.id IS NULL
         OR agent."organizationId" <> source."organizationId"
         OR agent."projectId" <> source."projectId"
         OR agent."environmentId" <> source."environmentId"))
    UNION ALL SELECT 'app-target-collision' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosChannelApp"
       GROUP BY "environmentId", provider, "clientId" HAVING count(*) > 1)
    UNION ALL SELECT 'installation-parent-or-required-field' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosChannelInstallation" source
      LEFT JOIN cutover_legacy."PlatosChannelApp" app ON app.id = source."appId"
      WHERE app.id IS NULL OR btrim(source.status) = '')
    UNION ALL SELECT 'installation-owner-ambiguity' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosChannelInstallation"
       WHERE ("isEnterpriseInstall" AND ("teamId" IS NOT NULL OR "enterpriseId" IS NULL OR btrim("enterpriseId") = ''))
          OR (NOT "isEnterpriseInstall" AND ("teamId" IS NULL OR btrim("teamId") = '' OR "enterpriseId" IS NOT NULL)))
    UNION ALL SELECT 'duplicate-external-installation-identity' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosChannelInstallation" source
      JOIN cutover_legacy."PlatosChannelApp" app ON app.id = source."appId"
      GROUP BY source."appId", CASE WHEN source."isEnterpriseInstall"
        THEN app.provider || ':enterprise:' || source."enterpriseId"
        ELSE app.provider || ':team:' || source."teamId" END HAVING count(*) > 1)
    UNION ALL SELECT 'channel-thread-ancestry' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosChannelThread" child
      LEFT JOIN cutover_legacy."PlatosChannelConnection" parent ON parent.id = child."connectionId"
      LEFT JOIN cutover_legacy."PlatosAgentThread" thread ON thread.id = child."platosThreadId"
      WHERE parent.id IS NULL OR thread.id IS NULL OR btrim(child."channelThreadKey") = ''
         OR thread."organizationId" <> parent."organizationId"
         OR thread."projectId" <> parent."projectId"
         OR thread."environmentId" <> parent."environmentId")
    UNION ALL SELECT 'channel-app-thread-ancestry' WHERE EXISTS (
      SELECT 1 FROM cutover_legacy."PlatosChannelAppThread" child
      LEFT JOIN cutover_legacy."PlatosChannelInstallation" installation ON installation.id = child."installationId"
      LEFT JOIN cutover_legacy."PlatosChannelApp" app ON app.id = installation."appId"
      LEFT JOIN cutover_legacy."PlatosAgentThread" thread ON thread.id = child."platosThreadId"
      WHERE installation.id IS NULL OR app.id IS NULL OR thread.id IS NULL OR btrim(child."channelThreadKey") = ''
         OR thread."organizationId" <> app."organizationId"
         OR thread."projectId" <> app."projectId"
         OR thread."environmentId" <> app."environmentId")
  ) SELECT issue FROM issues ORDER BY issue`;

interface ConnectionValidationRow extends Record<string, unknown> {
  source_id: string;
  credentials: unknown;
  webhook_secret: unknown;
  agent_routing: unknown;
}

interface AppValidationRow extends Record<string, unknown> {
  source_id: string;
  client_secret: unknown;
  signing_secret: unknown;
  agent_routing: unknown;
}

interface InstallationValidationRow extends Record<string, unknown> {
  source_id: string;
  provider: unknown;
  team_id: unknown;
  enterprise_id: unknown;
  is_enterprise_install: unknown;
  bot_token: unknown;
  refresh_token: unknown;
  agent_routing: unknown;
}

export async function validateRetainedChannelBatch5Source(
  database: CutoverDatabase,
  options: RetainedChannelBatch5Options,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<void> {
  const issues = await database.query<{ issue: string }>(sourceAndMappingValidationSql);
  if (issues.rows.length > 0) {
    throw batch5Failure(
      "BATCH5_SOURCE_OR_MAPPING_INVALID",
      `retained channel Batch 5 source validation failed: ${issues.rows
        .map((row) => row.issue)
        .join(", ")}`
    );
  }
  await forEachBatch5SourceChunk<ConnectionValidationRow>(
    database,
    `SELECT source.id::text AS source_id, source.credentials,
            source."webhookSecret" AS webhook_secret, source."agentRouting" AS agent_routing
       FROM cutover_legacy."PlatosChannelConnection" source
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      for (const row of rows) {
        normalizeBatch5Routing("ChannelConnection.agentRouting", row.agent_routing);
        buildBatch5ConnectionPayload(
          row.credentials,
          row.webhook_secret,
          options.messageEncryptionKeys
        );
      }
    },
    chunkSize
  );
  await forEachBatch5SourceChunk<AppValidationRow>(
    database,
    `SELECT source.id::text AS source_id, source."clientSecret" AS client_secret,
            source."signingSecret" AS signing_secret, source."agentRouting" AS agent_routing
       FROM cutover_legacy."PlatosChannelApp" source
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      for (const row of rows) {
        normalizeBatch5Routing("ChannelApp.agentRouting", row.agent_routing);
        buildBatch5AppPayload(row.client_secret, row.signing_secret, options.messageEncryptionKeys);
      }
    },
    chunkSize
  );
  await forEachBatch5SourceChunk<InstallationValidationRow>(
    database,
    `SELECT source.id::text AS source_id, app.provider, source."teamId" AS team_id,
            source."enterpriseId" AS enterprise_id,
            source."isEnterpriseInstall" AS is_enterprise_install,
            source."botToken" AS bot_token, source."refreshToken" AS refresh_token,
            source."agentRouting" AS agent_routing
       FROM cutover_legacy."PlatosChannelInstallation" source
       JOIN cutover_legacy."PlatosChannelApp" app ON app.id = source."appId"
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      for (const row of rows) {
        batch5ExternalInstallationId({
          provider: row.provider,
          teamId: row.team_id,
          enterpriseId: row.enterprise_id,
          isEnterpriseInstall: row.is_enterprise_install,
        });
        normalizeBatch5Routing("ChannelInstallation.agentRouting", row.agent_routing);
        buildBatch5InstallationPayload(
          row.bot_token,
          row.refresh_token,
          options.messageEncryptionKeys
        );
      }
    },
    chunkSize
  );
}

async function insertCredentials(
  database: CutoverDatabase,
  targets: readonly Batch5CredentialTarget[]
): Promise<void> {
  if (targets.length === 0) return;
  await database.query(
    `INSERT INTO public."Credential"
      (id, "environmentId", kind, name, provider, "externalClientId", "expiresAt",
       "revokedAt", "createdAt", "updatedAt")
     VALUES ${parameterTuples(targets.length, 10)}`,
    targets.flatMap((target) => [
      target.credential.id,
      target.credential.environmentId,
      "CHANNEL_SECRET",
      target.credential.name,
      target.credential.provider,
      target.credential.externalClientId,
      target.credential.expiresAt,
      target.credential.revokedAt,
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
      target.version.id,
      target.version.credentialId,
      target.version.secretRevision,
      target.version.formatVersion,
      target.version.rootKeyVersion,
      target.version.salt,
      target.version.nonce,
      target.version.ciphertext,
      target.version.authTag,
      target.version.createdAt,
    ])
  );
  await database.query(
    `UPDATE public."Credential" credential SET "activeSecretVersionId" = supplied.version_id::uuid
       FROM (VALUES ${parameterTuples(targets.length, 2)}) supplied(credential_id, version_id)
      WHERE credential.id = supplied.credential_id::uuid`,
    targets.flatMap((target) => [target.credential.id, target.credential.activeVersionId])
  );
}

interface ConnectionRow extends ConnectionValidationRow {
  target_id: string;
  environment_id: string;
  provider: string;
  display_name: string | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch5ChannelConnections(
  database: CutoverDatabase,
  options: RetainedChannelBatch5Options,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch5SourceChunk<ConnectionRow>(
    database,
    `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
            environment_map.target_id::text AS environment_id, source.provider,
            source."displayName" AS display_name, source.enabled, source.credentials,
            source."webhookSecret" AS webhook_secret, source."agentRouting" AS agent_routing,
            source."createdAt" AS created_at, source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosChannelConnection" source
       JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version = 1
        AND target_map.source_model = 'PlatosChannelConnection' AND target_map.source_id = source.id
        AND target_map.target_model = 'ChannelConnection' AND target_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version = 1
        AND environment_map.source_model = 'RuntimeEnvironment' AND environment_map.source_id = source."environmentId"
        AND environment_map.target_model = 'Environment' AND environment_map.stable_suffix = ''
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      const targets = rows.map((row) =>
        transformBatch5Credential({
          sourceModel: "PlatosChannelConnection",
          sourceId: row.source_id,
          environmentId: row.environment_id,
          provider: row.provider,
          externalClientId: null,
          expiresAt: null,
          revokedAt: null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          plaintext: buildBatch5ConnectionPayload(
            row.credentials,
            row.webhook_secret,
            options.messageEncryptionKeys
          ),
          keyRing: options.credentialRootKeyRing,
        })
      );
      await insertCredentials(database, targets);
      await database.query(
        `INSERT INTO public."ChannelConnection"
          (id, "environmentId", "entityId", provider, "displayName", "defaultAgentId",
           "agentRouting", enabled, "credentialId", "createdAt", "updatedAt")
         VALUES ${parameterTuples(rows.length, 11)}`,
        rows.flatMap((row, index) => [
          row.target_id,
          row.environment_id,
          null,
          row.provider,
          row.display_name,
          null,
          JSON.stringify(
            normalizeBatch5Routing("ChannelConnection.agentRouting", row.agent_routing)
          ),
          row.enabled,
          targets[index]!.credential.id,
          row.created_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

interface ChannelThreadRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  connection_id: string;
  thread_id: string;
  channel_thread_key: string;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch5ChannelThreads(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch5SourceChunk<ChannelThreadRow>(
    database,
    `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
            connection_map.target_id::text AS connection_id, thread_map.target_id::text AS thread_id,
            source."channelThreadKey" AS channel_thread_key,
            source."createdAt" AS created_at, source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosChannelThread" source
       JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version = 1
        AND target_map.source_model = 'PlatosChannelThread' AND target_map.source_id = source.id
        AND target_map.target_model = 'ChannelThread' AND target_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map connection_map ON connection_map.mapping_version = 1
        AND connection_map.source_model = 'PlatosChannelConnection' AND connection_map.source_id = source."connectionId"
        AND connection_map.target_model = 'ChannelConnection' AND connection_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map thread_map ON thread_map.mapping_version = 1
        AND thread_map.source_model = 'PlatosAgentThread' AND thread_map.source_id = source."platosThreadId"
        AND thread_map.target_model = 'Thread' AND thread_map.stable_suffix = ''
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."ChannelThread"
          (id, "connectionId", "threadId", "channelThreadKey", "createdAt", "updatedAt")
         VALUES ${parameterTuples(rows.length, 6)}`,
        rows.flatMap((row) => [
          row.target_id,
          row.connection_id,
          row.thread_id,
          row.channel_thread_key,
          row.created_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

interface AppRow extends AppValidationRow {
  target_id: string;
  environment_id: string;
  provider: string;
  display_name: string | null;
  client_id: string;
  scopes: string[];
  distribution: string;
  default_agent_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch5ChannelApps(
  database: CutoverDatabase,
  options: RetainedChannelBatch5Options,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch5SourceChunk<AppRow>(
    database,
    `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
            environment_map.target_id::text AS environment_id, source.provider,
            source."displayName" AS display_name, source."clientId" AS client_id,
            source."clientSecret" AS client_secret, source."signingSecret" AS signing_secret,
            source.scopes, source.distribution, agent_map.target_id::text AS default_agent_id,
            source."agentRouting" AS agent_routing,
            source."createdAt" AS created_at, source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosChannelApp" source
       JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version = 1
        AND target_map.source_model = 'PlatosChannelApp' AND target_map.source_id = source.id
        AND target_map.target_model = 'ChannelApp' AND target_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version = 1
        AND environment_map.source_model = 'RuntimeEnvironment' AND environment_map.source_id = source."environmentId"
        AND environment_map.target_model = 'Environment' AND environment_map.stable_suffix = ''
       LEFT JOIN cutover_legacy.cutover_id_map agent_map ON agent_map.mapping_version = 1
        AND agent_map.source_model = 'PlatosAgent' AND agent_map.source_id = source."defaultAgentId"
        AND agent_map.target_model = 'Agent' AND agent_map.stable_suffix = ''
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      const targets = rows.map((row) =>
        transformBatch5Credential({
          sourceModel: "PlatosChannelApp",
          sourceId: row.source_id,
          environmentId: row.environment_id,
          provider: row.provider,
          externalClientId: row.client_id,
          expiresAt: null,
          revokedAt: null,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          plaintext: buildBatch5AppPayload(
            row.client_secret,
            row.signing_secret,
            options.messageEncryptionKeys
          ),
          keyRing: options.credentialRootKeyRing,
        })
      );
      await insertCredentials(database, targets);
      await database.query(
        `INSERT INTO public."ChannelApp"
          (id, "environmentId", provider, "displayName", "clientId", "credentialId",
           scopes, distribution, "defaultAgentId", "agentRouting", "createdAt", "updatedAt")
         VALUES ${parameterTuples(rows.length, 12)}`,
        rows.flatMap((row, index) => [
          row.target_id,
          row.environment_id,
          row.provider,
          row.display_name,
          row.client_id,
          targets[index]!.credential.id,
          row.scopes,
          row.distribution,
          row.default_agent_id,
          JSON.stringify(normalizeBatch5Routing("ChannelApp.agentRouting", row.agent_routing)),
          row.created_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

interface InstallationRow extends InstallationValidationRow {
  target_id: string;
  app_id: string;
  environment_id: string;
  provider: string;
  team_name: string | null;
  granted_scopes: string[];
  status: string;
  token_expires_at: Date | null;
  revoked_at: Date | null;
  last_event_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch5ChannelInstallations(
  database: CutoverDatabase,
  options: RetainedChannelBatch5Options,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch5SourceChunk<InstallationRow>(
    database,
    `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
            app_map.target_id::text AS app_id, environment_map.target_id::text AS environment_id,
            app.provider, source."teamId" AS team_id, source."enterpriseId" AS enterprise_id,
            source."isEnterpriseInstall" AS is_enterprise_install, source."teamName" AS team_name,
            source."botToken" AS bot_token, source."refreshToken" AS refresh_token,
            source."tokenExpiresAt" AS token_expires_at, source."grantedScopes" AS granted_scopes,
            source."agentRouting" AS agent_routing, source.status, source."revokedAt" AS revoked_at,
            source."lastEventAt" AS last_event_at, source."createdAt" AS created_at,
            source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosChannelInstallation" source
       JOIN cutover_legacy."PlatosChannelApp" app ON app.id = source."appId"
       JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version = 1
        AND target_map.source_model = 'PlatosChannelInstallation' AND target_map.source_id = source.id
        AND target_map.target_model = 'ChannelInstallation' AND target_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map app_map ON app_map.mapping_version = 1
        AND app_map.source_model = 'PlatosChannelApp' AND app_map.source_id = source."appId"
        AND app_map.target_model = 'ChannelApp' AND app_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map environment_map ON environment_map.mapping_version = 1
        AND environment_map.source_model = 'RuntimeEnvironment' AND environment_map.source_id = app."environmentId"
        AND environment_map.target_model = 'Environment' AND environment_map.stable_suffix = ''
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      const externalIds = rows.map((row) =>
        batch5ExternalInstallationId({
          provider: row.provider,
          teamId: row.team_id,
          enterpriseId: row.enterprise_id,
          isEnterpriseInstall: row.is_enterprise_install,
        })
      );
      const targets = rows.map((row, index) =>
        transformBatch5Credential({
          sourceModel: "PlatosChannelInstallation",
          sourceId: row.source_id,
          environmentId: row.environment_id,
          provider: row.provider,
          externalClientId: externalIds[index]!,
          expiresAt: row.token_expires_at,
          revokedAt: row.revoked_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          plaintext: buildBatch5InstallationPayload(
            row.bot_token,
            row.refresh_token,
            options.messageEncryptionKeys
          ),
          keyRing: options.credentialRootKeyRing,
        })
      );
      await insertCredentials(database, targets);
      await database.query(
        `INSERT INTO public."ChannelInstallation"
          (id, "appId", "externalInstallationId", "displayName", "credentialId",
           "grantedScopes", "defaultAgentId", "agentRouting", status, "revokedAt",
           "lastEventAt", "createdAt", "updatedAt")
         VALUES ${parameterTuples(rows.length, 13)}`,
        rows.flatMap((row, index) => [
          row.target_id,
          row.app_id,
          externalIds[index],
          null,
          targets[index]!.credential.id,
          row.granted_scopes,
          null,
          JSON.stringify(
            normalizeBatch5Routing("ChannelInstallation.agentRouting", row.agent_routing)
          ),
          row.status,
          row.revoked_at,
          row.last_event_at,
          row.created_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

interface AppThreadRow extends Record<string, unknown> {
  source_id: string;
  target_id: string;
  installation_id: string;
  thread_id: string;
  channel_thread_key: string;
  created_at: Date;
  updated_at: Date;
}

export async function backfillBatch5ChannelAppThreads(
  database: CutoverDatabase,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<number> {
  return forEachBatch5SourceChunk<AppThreadRow>(
    database,
    `SELECT source.id::text AS source_id, target_map.target_id::text AS target_id,
            installation_map.target_id::text AS installation_id,
            thread_map.target_id::text AS thread_id, source."channelThreadKey" AS channel_thread_key,
            source."createdAt" AS created_at, source."updatedAt" AS updated_at
       FROM cutover_legacy."PlatosChannelAppThread" source
       JOIN cutover_legacy.cutover_id_map target_map ON target_map.mapping_version = 1
        AND target_map.source_model = 'PlatosChannelAppThread' AND target_map.source_id = source.id
        AND target_map.target_model = 'ChannelAppThread' AND target_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map installation_map ON installation_map.mapping_version = 1
        AND installation_map.source_model = 'PlatosChannelInstallation'
        AND installation_map.source_id = source."installationId"
        AND installation_map.target_model = 'ChannelInstallation' AND installation_map.stable_suffix = ''
       JOIN cutover_legacy.cutover_id_map thread_map ON thread_map.mapping_version = 1
        AND thread_map.source_model = 'PlatosAgentThread' AND thread_map.source_id = source."platosThreadId"
        AND thread_map.target_model = 'Thread' AND thread_map.stable_suffix = ''
      WHERE source.id > $1 ORDER BY source.id LIMIT $2`,
    async (rows) => {
      await database.query(
        `INSERT INTO public."ChannelAppThread"
          (id, "installationId", "threadId", "channelThreadKey", "createdAt", "updatedAt")
         VALUES ${parameterTuples(rows.length, 6)}`,
        rows.flatMap((row) => [
          row.target_id,
          row.installation_id,
          row.thread_id,
          row.channel_thread_key,
          row.created_at,
          row.updated_at,
        ])
      );
    },
    chunkSize
  );
}

const conservationValidationSql = `
  WITH equations(id, source_count, target_count) AS (VALUES
    ('connections', (SELECT count(*) FROM cutover_legacy."PlatosChannelConnection"),
      (SELECT count(*) FROM public."ChannelConnection" target JOIN cutover_legacy.cutover_id_map map
        ON map.mapping_version = 1 AND map.source_model = 'PlatosChannelConnection'
       AND map.target_model = 'ChannelConnection' AND map.target_id = target.id)),
    ('connection-credentials', (SELECT count(*) FROM cutover_legacy."PlatosChannelConnection"),
      (SELECT count(*) FROM public."ChannelConnection" target JOIN cutover_legacy.cutover_id_map map
        ON map.mapping_version = 1 AND map.source_model = 'PlatosChannelConnection'
       AND map.target_model = 'ChannelConnection' AND map.target_id = target.id
       JOIN public."Credential" credential ON credential.id = target."credentialId"
       JOIN public."CredentialSecretVersion" version ON version.id = credential."activeSecretVersionId")),
    ('channel-threads', (SELECT count(*) FROM cutover_legacy."PlatosChannelThread"),
      (SELECT count(*) FROM public."ChannelThread" target JOIN cutover_legacy.cutover_id_map map
        ON map.mapping_version = 1 AND map.source_model = 'PlatosChannelThread'
       AND map.target_model = 'ChannelThread' AND map.target_id = target.id)),
    ('apps', (SELECT count(*) FROM cutover_legacy."PlatosChannelApp"),
      (SELECT count(*) FROM public."ChannelApp" target JOIN cutover_legacy.cutover_id_map map
        ON map.mapping_version = 1 AND map.source_model = 'PlatosChannelApp'
       AND map.target_model = 'ChannelApp' AND map.target_id = target.id)),
    ('app-credentials', (SELECT count(*) FROM cutover_legacy."PlatosChannelApp"),
      (SELECT count(*) FROM public."ChannelApp" target JOIN cutover_legacy.cutover_id_map map
        ON map.mapping_version = 1 AND map.source_model = 'PlatosChannelApp'
       AND map.target_model = 'ChannelApp' AND map.target_id = target.id
       JOIN public."Credential" credential ON credential.id = target."credentialId"
       JOIN public."CredentialSecretVersion" version ON version.id = credential."activeSecretVersionId")),
    ('installations', (SELECT count(*) FROM cutover_legacy."PlatosChannelInstallation"),
      (SELECT count(*) FROM public."ChannelInstallation" target JOIN cutover_legacy.cutover_id_map map
        ON map.mapping_version = 1 AND map.source_model = 'PlatosChannelInstallation'
       AND map.target_model = 'ChannelInstallation' AND map.target_id = target.id)),
    ('installation-credentials', (SELECT count(*) FROM cutover_legacy."PlatosChannelInstallation"),
      (SELECT count(*) FROM public."ChannelInstallation" target JOIN cutover_legacy.cutover_id_map map
        ON map.mapping_version = 1 AND map.source_model = 'PlatosChannelInstallation'
       AND map.target_model = 'ChannelInstallation' AND map.target_id = target.id
       JOIN public."Credential" credential ON credential.id = target."credentialId"
       JOIN public."CredentialSecretVersion" version ON version.id = credential."activeSecretVersionId")),
    ('app-threads', (SELECT count(*) FROM cutover_legacy."PlatosChannelAppThread"),
      (SELECT count(*) FROM public."ChannelAppThread" target JOIN cutover_legacy.cutover_id_map map
        ON map.mapping_version = 1 AND map.source_model = 'PlatosChannelAppThread'
       AND map.target_model = 'ChannelAppThread' AND map.target_id = target.id))
  ) SELECT id FROM equations WHERE source_count <> target_count ORDER BY id`;

const ancestryValidationSql = `
  WITH issues AS (
    SELECT 'connection-owner' AS issue FROM public."ChannelConnection" target
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosChannelConnection' AND map.target_model = 'ChannelConnection' AND map.target_id = target.id
      LEFT JOIN public."Environment" environment ON environment.id = target."environmentId"
     WHERE environment.id IS NULL
    UNION ALL SELECT 'channel-thread-owner' FROM public."ChannelThread" target
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosChannelThread' AND map.target_model = 'ChannelThread' AND map.target_id = target.id
      JOIN public."ChannelConnection" connection ON connection.id = target."connectionId"
      JOIN public."Thread" thread ON thread.id = target."threadId"
     WHERE thread."environmentId" <> connection."environmentId"
    UNION ALL SELECT 'app-owner' FROM public."ChannelApp" target
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosChannelApp' AND map.target_model = 'ChannelApp' AND map.target_id = target.id
      LEFT JOIN public."AgentBinding" binding ON binding."agentId" = target."defaultAgentId"
       AND binding."environmentId" = target."environmentId"
     WHERE target."defaultAgentId" IS NOT NULL AND binding.id IS NULL
    UNION ALL SELECT 'installation-owner' FROM public."ChannelInstallation" target
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosChannelInstallation' AND map.target_model = 'ChannelInstallation' AND map.target_id = target.id
      LEFT JOIN public."ChannelApp" app ON app.id = target."appId"
      LEFT JOIN public."Credential" credential ON credential.id = target."credentialId"
     WHERE app.id IS NULL OR credential."environmentId" IS DISTINCT FROM app."environmentId"
    UNION ALL SELECT 'app-thread-owner' FROM public."ChannelAppThread" target
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosChannelAppThread' AND map.target_model = 'ChannelAppThread' AND map.target_id = target.id
      JOIN public."ChannelInstallation" installation ON installation.id = target."installationId"
      JOIN public."ChannelApp" app ON app.id = installation."appId"
      JOIN public."Thread" thread ON thread.id = target."threadId"
     WHERE thread."environmentId" <> app."environmentId"
  ) SELECT DISTINCT issue FROM issues ORDER BY issue`;

const credentialParityValidationSql = `
  WITH issues AS (
    SELECT 'connection-credential' AS issue FROM cutover_legacy."PlatosChannelConnection" source
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosChannelConnection' AND map.source_id = source.id
       AND map.target_model = 'ChannelConnection' AND map.stable_suffix = ''
      JOIN public."ChannelConnection" target ON target.id = map.target_id
      JOIN cutover_legacy.cutover_id_map credential_map ON credential_map.mapping_version = 1
       AND credential_map.source_model = 'PlatosChannelConnection' AND credential_map.source_id = source.id
       AND credential_map.target_model = 'Credential' AND credential_map.stable_suffix = 'credential'
      JOIN cutover_legacy.cutover_id_map version_map ON version_map.mapping_version = 1
       AND version_map.source_model = 'PlatosChannelConnection' AND version_map.source_id = source.id
       AND version_map.target_model = 'CredentialSecretVersion'
       AND version_map.stable_suffix = 'credential-secret-version:1'
      JOIN public."Credential" credential ON credential.id = target."credentialId"
      JOIN public."CredentialSecretVersion" version ON version.id = credential."activeSecretVersionId"
     WHERE credential.id <> credential_map.target_id OR version.id <> version_map.target_id
        OR credential.kind <> 'CHANNEL_SECRET' OR credential."environmentId" <> target."environmentId"
        OR credential.provider <> source.provider
        OR credential.name <> 'PlatosChannelConnection:' || source.id || ':channel-connection-auth'
        OR credential."externalClientId" IS NOT NULL OR credential."expiresAt" IS NOT NULL
        OR credential."revokedAt" IS NOT NULL OR version."credentialId" <> credential.id
        OR version."secretRevision" <> 1 OR version."formatVersion" <> 1 OR version."rootKeyVersion" < 1
        OR version."retiredAt" IS NOT NULL OR version."readableUntil" IS NOT NULL
    UNION ALL SELECT 'app-credential' FROM cutover_legacy."PlatosChannelApp" source
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosChannelApp' AND map.source_id = source.id
       AND map.target_model = 'ChannelApp' AND map.stable_suffix = ''
      JOIN public."ChannelApp" target ON target.id = map.target_id
      JOIN cutover_legacy.cutover_id_map credential_map ON credential_map.mapping_version = 1
       AND credential_map.source_model = 'PlatosChannelApp' AND credential_map.source_id = source.id
       AND credential_map.target_model = 'Credential' AND credential_map.stable_suffix = 'credential'
      JOIN cutover_legacy.cutover_id_map version_map ON version_map.mapping_version = 1
       AND version_map.source_model = 'PlatosChannelApp' AND version_map.source_id = source.id
       AND version_map.target_model = 'CredentialSecretVersion'
       AND version_map.stable_suffix = 'credential-secret-version:1'
      JOIN public."Credential" credential ON credential.id = target."credentialId"
      JOIN public."CredentialSecretVersion" version ON version.id = credential."activeSecretVersionId"
     WHERE credential.id <> credential_map.target_id OR version.id <> version_map.target_id
        OR credential.kind <> 'CHANNEL_SECRET' OR credential."environmentId" <> target."environmentId"
        OR credential.provider <> source.provider OR credential."externalClientId" <> source."clientId"
        OR credential.name <> 'PlatosChannelApp:' || source.id || ':channel-app-auth'
        OR version."credentialId" <> credential.id OR version."secretRevision" <> 1
        OR version."formatVersion" <> 1 OR version."rootKeyVersion" < 1
        OR version."retiredAt" IS NOT NULL OR version."readableUntil" IS NOT NULL
    UNION ALL SELECT 'installation-credential' FROM cutover_legacy."PlatosChannelInstallation" source
      JOIN cutover_legacy."PlatosChannelApp" source_app ON source_app.id = source."appId"
      JOIN cutover_legacy.cutover_id_map map ON map.mapping_version = 1
       AND map.source_model = 'PlatosChannelInstallation' AND map.source_id = source.id
       AND map.target_model = 'ChannelInstallation' AND map.stable_suffix = ''
      JOIN public."ChannelInstallation" target ON target.id = map.target_id
      JOIN public."ChannelApp" app ON app.id = target."appId"
      JOIN cutover_legacy.cutover_id_map credential_map ON credential_map.mapping_version = 1
       AND credential_map.source_model = 'PlatosChannelInstallation' AND credential_map.source_id = source.id
       AND credential_map.target_model = 'Credential' AND credential_map.stable_suffix = 'credential'
      JOIN cutover_legacy.cutover_id_map version_map ON version_map.mapping_version = 1
       AND version_map.source_model = 'PlatosChannelInstallation' AND version_map.source_id = source.id
       AND version_map.target_model = 'CredentialSecretVersion'
       AND version_map.stable_suffix = 'credential-secret-version:1'
      JOIN public."Credential" credential ON credential.id = target."credentialId"
      JOIN public."CredentialSecretVersion" version ON version.id = credential."activeSecretVersionId"
     WHERE credential.id <> credential_map.target_id OR version.id <> version_map.target_id
        OR credential.kind <> 'CHANNEL_SECRET' OR credential."environmentId" <> app."environmentId"
        OR credential.provider <> source_app.provider
        OR credential."externalClientId" <> CASE WHEN source."isEnterpriseInstall"
             THEN source_app.provider || ':enterprise:' || source."enterpriseId"
             ELSE source_app.provider || ':team:' || source."teamId" END
        OR credential.name <> 'PlatosChannelInstallation:' || source.id || ':channel-installation-tokens'
        OR credential."expiresAt" IS DISTINCT FROM source."tokenExpiresAt"
        OR credential."revokedAt" IS DISTINCT FROM source."revokedAt"
        OR version."credentialId" <> credential.id OR version."secretRevision" <> 1
        OR version."formatVersion" <> 1 OR version."rootKeyVersion" < 1
        OR version."retiredAt" IS NOT NULL OR version."readableUntil" IS NOT NULL
  ) SELECT DISTINCT issue FROM issues ORDER BY issue`;

async function assertBatch5Validation(
  database: CutoverDatabase,
  sql: string,
  code: string,
  summary: string
): Promise<void> {
  const issues = await database.query<{ id?: string; issue?: string }>(sql);
  if (issues.rows.length > 0) {
    throw batch5Failure(
      code,
      `${summary}: ${issues.rows.map((row) => row.id ?? row.issue ?? "unknown").join(", ")}`
    );
  }
}

export async function validateRetainedChannelBatch5(database: CutoverDatabase): Promise<void> {
  await assertBatch5Validation(
    database,
    conservationValidationSql,
    "BATCH5_CONSERVATION_FAILED",
    "retained channel Batch 5 conservation failed"
  );
  await assertBatch5Validation(
    database,
    ancestryValidationSql,
    "BATCH5_ANCESTRY_FAILED",
    "retained channel Batch 5 ancestry failed"
  );
  await assertBatch5Validation(
    database,
    credentialParityValidationSql,
    "BATCH5_CREDENTIAL_PARITY_FAILED",
    "retained channel Batch 5 credential parity failed"
  );
}

export async function backfillRetainedChannelBatch5(
  database: CutoverDatabase,
  options: RetainedChannelBatch5Options,
  chunkSize = CUTOVER_CHUNK_SIZE
): Promise<RetainedChannelBatch5Evidence> {
  await materializeRetainedChannelBatch5Mappings(database, chunkSize);
  await validateRetainedChannelBatch5Source(database, options, chunkSize);
  const connections = await backfillBatch5ChannelConnections(database, options, chunkSize);
  const channelThreads = await backfillBatch5ChannelThreads(database, chunkSize);
  const apps = await backfillBatch5ChannelApps(database, options, chunkSize);
  const installations = await backfillBatch5ChannelInstallations(database, options, chunkSize);
  const appThreads = await backfillBatch5ChannelAppThreads(database, chunkSize);
  await validateRetainedChannelBatch5(database);

  const evidence: RetainedChannelBatch5Evidence = {
    batch: "retained-channel-batch5",
    sourceRows: Object.freeze({ connections, channelThreads, apps, installations, appThreads }),
    targetRows: Object.freeze({
      connections,
      connectionCredentials: connections,
      connectionCredentialVersions: connections,
      channelThreads,
      apps,
      appCredentials: apps,
      appCredentialVersions: apps,
      installations,
      installationCredentials: installations,
      installationCredentialVersions: installations,
      appThreads,
    }),
  };
  assertSecretFreeCutoverEvidence(evidence);
  return Object.freeze(evidence);
}
