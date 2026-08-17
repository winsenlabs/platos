import { createCipheriv } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  backfillBatch5ChannelConnections,
  backfillRetainedChannelBatch5,
  batch5CredentialIds,
  batch5CredentialName,
  batch5ExternalInstallationId,
  buildBatch5AppPayload,
  buildBatch5ConnectionPayload,
  buildBatch5InstallationPayload,
  materializeRetainedChannelBatch5Mappings,
  normalizeBatch5Routing,
  retainedChannelBatch5MappingTargets,
  retainedChannelBatch5SourceModels,
  transformBatch5Credential,
  validateRetainedChannelBatch5,
  validateRetainedChannelBatch5Source,
} from "./cutover-channel-batch5";
import { mapCutoverId } from "./cutover-id";
import { CredentialRootKeyRing, decryptCredentialSecret } from "./secrets";
import type { CutoverDatabase, QueryResultLike } from "./cutover-types";

const MESSAGE_KEY = "11".repeat(32);
const ROOT_KEY = "55".repeat(32);
const messageKeys = Object.freeze({ "1": MESSAGE_KEY });
const keyRing = new CredentialRootKeyRing({ activeVersion: 9, keys: { 9: ROOT_KEY } });

function messageEnvelope(value: unknown, ivByte = 0x22): string {
  const iv = Buffer.alloc(16, ivByte);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(MESSAGE_KEY, "hex"), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const packed = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
  return JSON.stringify({ __platos_enc: 1, v: 1, ct: packed });
}

function emptyDatabase(): CutoverDatabase {
  return {
    async query<Row extends Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
      return { rows: [], rowCount: 0 };
    },
  };
}

describe("retained channel cutover Batch 5", () => {
  test("pins source models and deterministic split mappings", () => {
    expect(retainedChannelBatch5SourceModels).toEqual([
      "PlatosChannelConnection",
      "PlatosChannelThread",
      "PlatosChannelApp",
      "PlatosChannelInstallation",
      "PlatosChannelAppThread",
    ]);
    expect(retainedChannelBatch5MappingTargets).toContainEqual({
      sourceModel: "PlatosChannelInstallation",
      targetModel: "CredentialSecretVersion",
      stableSuffix: "credential-secret-version:1",
    });
    expect(batch5CredentialIds("PlatosChannelApp", "legacy-app")).toEqual({
      credentialId: mapCutoverId({
        sourceModel: "PlatosChannelApp",
        sourceId: "legacy-app",
        suffix: "credential",
      }),
      versionId: mapCutoverId({
        sourceModel: "PlatosChannelApp",
        sourceId: "legacy-app",
        suffix: "credential-secret-version:1",
      }),
    });
    expect(batch5CredentialName("PlatosChannelConnection", "legacy-connection")).toBe(
      "PlatosChannelConnection:legacy-connection:channel-connection-auth"
    );
  });

  test("derives one canonical external installation identity and rejects ambiguity", () => {
    expect(
      batch5ExternalInstallationId({
        provider: "slack",
        teamId: "T123",
        enterpriseId: null,
        isEnterpriseInstall: false,
      })
    ).toBe("slack:team:T123");
    expect(
      batch5ExternalInstallationId({
        provider: "slack",
        teamId: null,
        enterpriseId: "E123",
        isEnterpriseInstall: true,
      })
    ).toBe("slack:enterprise:E123");
    expect(() =>
      batch5ExternalInstallationId({
        provider: "slack",
        teamId: "T123",
        enterpriseId: "E123",
        isEnterpriseInstall: false,
      })
    ).toThrow("ambiguous");
    expect(() =>
      batch5ExternalInstallationId({
        provider: "slack",
        teamId: null,
        enterpriseId: "E123",
        isEnterpriseInstall: false,
      })
    ).toThrow("ambiguous");
  });

  test("normalizes only array-root routing JSON", () => {
    expect(normalizeBatch5Routing("ChannelConnection.agentRouting", null)).toEqual([]);
    expect(
      normalizeBatch5Routing("ChannelApp.agentRouting", [{ match: { type: "prefix" } }])
    ).toEqual([{ match: { type: "prefix" } }]);
    expect(() => normalizeBatch5Routing("ChannelInstallation.agentRouting", {})).toThrow(
      "array root"
    );
  });

  test("strictly decodes and canonically aggregates required and optional channel components", () => {
    const connection = buildBatch5ConnectionPayload(
      messageEnvelope({ z: 1, nested: { b: true, a: false } }),
      "webhook-sentinel",
      messageKeys
    );
    expect(JSON.parse(connection)).toEqual({
      credentials: '{"nested":{"a":false,"b":true},"z":1}',
      webhookSecret: "webhook-sentinel",
    });

    expect(
      JSON.parse(
        buildBatch5AppPayload(
          messageEnvelope("client-sentinel", 0x23),
          messageEnvelope("signing-sentinel", 0x24),
          messageKeys
        )
      )
    ).toEqual({ clientSecret: "client-sentinel", signingSecret: "signing-sentinel" });

    expect(
      JSON.parse(
        buildBatch5InstallationPayload(messageEnvelope("bot-sentinel", 0x25), null, messageKeys)
      )
    ).toEqual({ botToken: "bot-sentinel" });
    expect(
      JSON.parse(
        buildBatch5InstallationPayload(
          messageEnvelope("bot-sentinel", 0x26),
          messageEnvelope("refresh-sentinel", 0x27),
          messageKeys
        )
      )
    ).toEqual({ botToken: "bot-sentinel", refreshToken: "refresh-sentinel" });
  });

  test("fails closed on plaintext, malformed envelopes, and missing required components", () => {
    expect(() => buildBatch5ConnectionPayload(null, "", messageKeys)).toThrow("required component");
    expect(() => buildBatch5ConnectionPayload('{"plain":true}', "webhook", messageKeys)).toThrow(
      "unreadable"
    );
    expect(() =>
      buildBatch5AppPayload(
        messageEnvelope("client"),
        JSON.stringify({ __platos_enc: 1, v: 1, ct: "malformed" }),
        messageKeys
      )
    ).toThrow("unreadable");
    expect(() =>
      buildBatch5AppPayload(messageEnvelope(""), messageEnvelope("signing"), messageKeys)
    ).toThrow("required component");
    expect(() => buildBatch5InstallationPayload(null, null, messageKeys)).toThrow("unreadable");
  });

  test("re-envelopes aggregate material under deterministic target AAD", () => {
    const plaintext = buildBatch5AppPayload(
      messageEnvelope("client", 0x31),
      messageEnvelope("signing", 0x32),
      messageKeys
    );
    const target = transformBatch5Credential({
      sourceModel: "PlatosChannelApp",
      sourceId: "legacy-app",
      environmentId: "92667e71-0437-5fc4-961c-f1224647019c",
      provider: "slack",
      externalClientId: "client-id",
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date("2025-01-01T00:00:00Z"),
      updatedAt: new Date("2025-01-02T00:00:00Z"),
      plaintext,
      keyRing,
    });
    const material = decryptCredentialSecret(
      keyRing.key(9),
      {
        credentialId: target.credential.id,
        environmentId: target.credential.environmentId,
        secretRevision: 1,
        formatVersion: 1,
        rootKeyVersion: 9,
      },
      target.version
    );
    expect(material.reveal()).toBe(plaintext);
    expect(target.credential.name).toBe("PlatosChannelApp:legacy-app:channel-app-auth");
  });

  test("materializes aggregate mappings in bounded deterministic chunks", async () => {
    const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        values?: readonly unknown[]
      ): Promise<QueryResultLike<Row>> {
        queries.push({ sql, values });
        if (sql.includes('FROM cutover_legacy."PlatosChannelConnection" source')) {
          const rows = values?.[0] === "" ? [{ source_id: "connection-a" }] : [];
          return { rows: rows as unknown as Row[], rowCount: rows.length };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    await expect(materializeRetainedChannelBatch5Mappings(database, 1)).resolves.toBe(2);
    expect(
      queries.filter((query) => query.sql.includes("ORDER BY source.id LIMIT $2"))
    ).toHaveLength(4);
    const insert = queries.find((query) =>
      query.sql.includes("INSERT INTO cutover_legacy.cutover_id_map")
    );
    expect(insert?.values).toContain("credential");
    expect(insert?.values).toContain("credential-secret-version:1");
  });

  test("pages connection aggregates and never sends plaintext to target inserts", async () => {
    const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        values?: readonly unknown[]
      ): Promise<QueryResultLike<Row>> {
        queries.push({ sql, values });
        if (sql.includes('FROM cutover_legacy."PlatosChannelConnection" source')) {
          const rows =
            values?.[0] === ""
              ? [
                  {
                    source_id: "connection-a",
                    target_id: "00000000-0000-5000-8000-000000000001",
                    environment_id: "00000000-0000-5000-8000-000000000002",
                    provider: "slack",
                    display_name: "Fixture connection",
                    enabled: true,
                    credentials: messageEnvelope({ token: "credential-sentinel" }, 0x41),
                    webhook_secret: "webhook-plaintext-sentinel",
                    agent_routing: null,
                    created_at: new Date(0),
                    updated_at: new Date(1),
                  },
                ]
              : [];
          return { rows: rows as unknown as Row[], rowCount: rows.length };
        }
        return { rows: [], rowCount: 1 };
      },
    };
    await expect(
      backfillBatch5ChannelConnections(
        database,
        { messageEncryptionKeys: messageKeys, credentialRootKeyRing: keyRing },
        1
      )
    ).resolves.toBe(1);
    const sourceSelects = queries.filter((query) =>
      query.sql.includes("ORDER BY source.id LIMIT $2")
    );
    expect(sourceSelects).toHaveLength(2);
    const credentialIndex = queries.findIndex((query) =>
      query.sql.includes('INSERT INTO public."Credential"')
    );
    const versionIndex = queries.findIndex((query) =>
      query.sql.includes('INSERT INTO public."CredentialSecretVersion"')
    );
    const activationIndex = queries.findIndex((query) =>
      query.sql.includes('UPDATE public."Credential"')
    );
    const connectionIndex = queries.findIndex((query) =>
      query.sql.includes('INSERT INTO public."ChannelConnection"')
    );
    expect(credentialIndex).toBeLessThan(versionIndex);
    expect(versionIndex).toBeLessThan(activationIndex);
    expect(activationIndex).toBeLessThan(connectionIndex);
    const targetValues = queries
      .filter((query) => query.sql.includes("public."))
      .flatMap((query) => query.values ?? []);
    expect(targetValues).not.toContain("credential-sentinel");
    expect(targetValues).not.toContain("webhook-plaintext-sentinel");
  });

  test("reports duplicate installation identity and keeps target validation gates separate", async () => {
    const sourceDatabase: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
        return {
          rows: [{ issue: "duplicate-external-installation-identity" }] as unknown as Row[],
          rowCount: 1,
        };
      },
    };
    await expect(
      validateRetainedChannelBatch5Source(sourceDatabase, {
        messageEncryptionKeys: messageKeys,
        credentialRootKeyRing: keyRing,
      })
    ).rejects.toMatchObject({ code: "BATCH5_SOURCE_OR_MAPPING_INVALID" });

    let call = 0;
    const targetDatabase: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(): Promise<QueryResultLike<Row>> {
        call += 1;
        return call === 3
          ? { rows: [{ issue: "installation-credential" }] as unknown as Row[], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      },
    };
    await expect(validateRetainedChannelBatch5(targetDatabase)).rejects.toMatchObject({
      code: "BATCH5_CREDENTIAL_PARITY_FAILED",
    });
    expect(call).toBe(3);
  });

  test("returns frozen count-only evidence without supplied secret material", async () => {
    const evidence = await backfillRetainedChannelBatch5(
      emptyDatabase(),
      {
        messageEncryptionKeys: { "1": "message-key-sentinel" },
        credentialRootKeyRing: keyRing,
      },
      2
    );
    expect(evidence).toEqual({
      batch: "retained-channel-batch5",
      sourceRows: { connections: 0, channelThreads: 0, apps: 0, installations: 0, appThreads: 0 },
      targetRows: {
        connections: 0,
        connectionCredentials: 0,
        connectionCredentialVersions: 0,
        channelThreads: 0,
        apps: 0,
        appCredentials: 0,
        appCredentialVersions: 0,
        installations: 0,
        installationCredentials: 0,
        installationCredentialVersions: 0,
        appThreads: 0,
      },
    });
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("message-key-sentinel");
  });
});
