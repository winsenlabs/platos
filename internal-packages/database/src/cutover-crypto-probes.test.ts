import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  probeRetainedCryptoField,
  reencryptAndProbeRetainedCryptoTargets,
  reencryptRetainedCryptoField,
  retainedCryptoProbeFields,
  type CutoverCryptoProbeOptions,
  type RetainedCryptoProbeField,
} from "./cutover-crypto-probes";
import type { CutoverDatabase, QueryResultLike } from "./cutover-types";

interface FixtureCase {
  readonly id: string;
  readonly field: RetainedCryptoProbeField;
  readonly variant: "PLAINTEXT" | "ENVELOPE";
  readonly sourceValue: unknown;
  readonly sourceKeyVersion?: number | null;
}

interface MalformedFixtureCase {
  readonly id: string;
  readonly field: RetainedCryptoProbeField;
  readonly variant: "MALFORMED";
  readonly sourceValue: unknown;
  readonly sourceKeyVersion?: number | null;
  readonly expectedCode: string;
}

interface CryptoProbeFixture {
  readonly fixtureVersion: 1;
  readonly sourceKeys: Readonly<Record<string, string>>;
  readonly target: Readonly<{ version: number; key: string }>;
  readonly cases: readonly FixtureCase[];
  readonly malformed: readonly MalformedFixtureCase[];
}

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../test-fixtures/cutover-crypto-probes-matrix.json"), "utf8")
) as CryptoProbeFixture;

const options: CutoverCryptoProbeOptions = Object.freeze({
  sourceMessageEncryptionKeys: fixture.sourceKeys,
  targetMessageEncryptionKey: fixture.target.key,
  targetMessageEncryptionKeyVersion: fixture.target.version,
});

function sourceInput(entry: FixtureCase | MalformedFixtureCase) {
  return {
    field: entry.field,
    sourceValue: entry.sourceValue,
    sourceKeyVersion: entry.sourceKeyVersion,
  };
}

describe("strict retained cutover target crypto probes", () => {
  test("fixture matrix covers plaintext and historical envelopes for every retained field", () => {
    expect(fixture.fixtureVersion).toBe(1);
    for (const field of retainedCryptoProbeFields) {
      expect(
        fixture.cases.filter((entry) => entry.field === field).map((entry) => entry.variant)
      ).toEqual(["PLAINTEXT", "ENVELOPE"]);
    }
    expect(
      new Set(
        fixture.cases
          .filter((entry) => entry.variant === "ENVELOPE")
          .map((entry) => {
            if (entry.sourceKeyVersion) return entry.sourceKeyVersion;
            const source =
              typeof entry.sourceValue === "string"
                ? JSON.parse(entry.sourceValue)
                : entry.sourceValue;
            return (source as { v: number }).v;
          })
      )
    ).toEqual(new Set([1, 2]));
  });

  test.each(fixture.cases)(
    "re-encrypts and probes $id through the exact active target envelope",
    (entry) => {
      const transformed = reencryptRetainedCryptoField(sourceInput(entry), options);
      expect(transformed.targetKeyVersion).toBe(fixture.target.version);
      expect(transformed.storageValue).not.toEqual(entry.sourceValue);

      const envelope =
        typeof transformed.storageValue === "string"
          ? JSON.parse(transformed.storageValue)
          : transformed.storageValue;
      expect(envelope).toEqual({
        __platos_enc: 1,
        v: fixture.target.version,
        ct: expect.any(String),
      });
      expect(Object.keys(envelope as object)).toEqual(["__platos_enc", "v", "ct"]);
      expect(Buffer.from((envelope as { ct: string }).ct, "base64").length).toBeGreaterThanOrEqual(
        32
      );

      const evidence = probeRetainedCryptoField(
        sourceInput(entry),
        transformed.storageValue,
        options
      );
      expect(evidence.fieldCount).toBe(1);
      expect(evidence.targetVersionCounts).toEqual({ [fixture.target.version]: 1 });
      expect(JSON.stringify(evidence)).not.toContain(fixture.target.key);
      expect(JSON.stringify(evidence)).not.toMatch(
        /fixture assistant|fixture retained|fixture argument/
      );
    }
  );

  test("uses a fresh IV for each final target write", () => {
    const entry = fixture.cases.find((candidate) => candidate.id === "Memory.content-plaintext")!;
    const first = reencryptRetainedCryptoField(sourceInput(entry), options);
    const second = reencryptRetainedCryptoField(sourceInput(entry), options);
    expect(first.storageValue).not.toBe(second.storageValue);
    expect(probeRetainedCryptoField(sourceInput(entry), first.storageValue, options)).toEqual(
      probeRetainedCryptoField(sourceInput(entry), second.storageValue, options)
    );
  });

  test.each(fixture.malformed)(
    "blocks recognized invalid fixture $id without fallback",
    (entry) => {
      expect(() => reencryptRetainedCryptoField(sourceInput(entry), options)).toThrowError(
        expect.objectContaining({ name: "CutoverFailure", code: entry.expectedCode })
      );
    }
  );

  test("blocks malformed active target configuration even for nullable material", () => {
    expect(() =>
      reencryptRetainedCryptoField(
        { field: "SafetyEvent.detail", sourceValue: null },
        { ...options, targetMessageEncryptionKey: "not-a-key" }
      )
    ).toThrowError(expect.objectContaining({ code: "CUTOVER_CRYPTO_TARGET_CONFIG_INVALID" }));
    expect(() =>
      reencryptRetainedCryptoField(
        { field: "SafetyEvent.detail", sourceValue: null },
        { ...options, targetMessageEncryptionKeyVersion: 0 }
      )
    ).toThrowError(expect.objectContaining({ code: "CUTOVER_CRYPTO_TARGET_CONFIG_INVALID" }));
  });

  test("target reader rejects malformed or plaintext persistence with no sentinel fallback", () => {
    const entry = fixture.cases.find((candidate) => candidate.id === "Memory.content-plaintext")!;
    for (const persisted of [
      "fixture retained memory",
      '{"__platos_enc":1,"v":3,"ct":"plaintext-looking-fixture"}',
    ]) {
      expect(() => probeRetainedCryptoField(sourceInput(entry), persisted, options)).toThrowError(
        expect.objectContaining({ code: "CUTOVER_CRYPTO_TARGET_READER_FAILED" })
      );
    }
  });

  test("errors and evidence never disclose source, target, or key material", () => {
    const entry = fixture.malformed[0]!;
    let caught: unknown;
    try {
      reencryptRetainedCryptoField(sourceInput(entry), options);
    } catch (error) {
      caught = error;
    }
    const outputs = [
      caught instanceof Error ? caught.message : String(caught),
      JSON.stringify(caught),
      inspect(caught),
    ];
    for (const output of outputs) {
      expect(output).not.toContain(String(entry.sourceValue));
      expect(output).not.toContain(fixture.target.key);
      for (const key of Object.values(fixture.sourceKeys)) expect(output).not.toContain(key);
    }
  });

  test("persists every mapped family, probes returned database values, and emits count/version evidence only", async () => {
    const plaintext = Object.fromEntries(
      fixture.cases
        .filter((entry) => entry.variant === "PLAINTEXT")
        .map((entry) => [entry.field, entry.sourceValue])
    );
    const selectRows = new Map<string, Record<string, unknown>>([
      [
        "PlatosAgentMessage",
        {
          source_id: "source-turn",
          target_id: "target-turn",
          output_text: plaintext["Turn.outputText"],
          thinking_content: plaintext["Turn.thinkingContent"],
          enc_key_version: null,
        },
      ],
      [
        "PlatosToolCallAudit",
        {
          source_id: "source-tool",
          target_id: "target-tool",
          arguments: plaintext["ToolCallAudit.arguments"],
          result: plaintext["ToolCallAudit.result"],
        },
      ],
      [
        "PlatosSafetyEvent",
        {
          source_id: "source-safety",
          target_id: "target-safety",
          detail: plaintext["SafetyEvent.detail"],
          metadata: plaintext["SafetyEvent.metadata"],
        },
      ],
      [
        'PlatosMemory" source',
        {
          source_id: "source-memory",
          target_id: "target-memory",
          content: plaintext["Memory.content"],
          metadata: plaintext["Memory.metadata"],
        },
      ],
      [
        "PlatosMemoryEntity",
        {
          source_id: "source-entity",
          target_id: "target-entity",
          label: plaintext["MemoryEntity.label"],
          metadata: plaintext["MemoryEntity.metadata"],
        },
      ],
      [
        "PlatosMemoryRelationship",
        {
          source_id: "source-relationship",
          target_id: "target-relationship",
          metadata: plaintext["MemoryRelationship.metadata"],
        },
      ],
    ]);
    let updateCount = 0;
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        values: readonly unknown[] = []
      ): Promise<QueryResultLike<Row>> {
        if (sql.startsWith("UPDATE")) {
          updateCount += 1;
          const rows: Record<string, unknown> = {};
          values.slice(1).forEach((value, index) => {
            rows[`persisted_${index}`] =
              typeof value === "string" && sql.includes(`$${index + 2}::jsonb`)
                ? JSON.parse(value)
                : value;
          });
          return { rows: [rows as Row], rowCount: 1 };
        }
        if (values[0] !== "") return { rows: [], rowCount: 0 };
        const matched = [...selectRows.entries()].find(([needle]) => sql.includes(needle));
        if (!matched) throw new Error("unexpected crypto probe query");
        return { rows: [matched[1] as Row], rowCount: 1 };
      },
    };

    const evidence = await reencryptAndProbeRetainedCryptoTargets(database, options, 2);
    expect(updateCount).toBe(6);
    expect(evidence.rowCounts).toEqual({
      turns: 1,
      toolCallAudits: 1,
      safetyEvents: 1,
      memories: 1,
      memoryEntities: 1,
      memoryRelationships: 1,
    });
    expect(evidence.fieldCounts).toEqual(
      Object.fromEntries(retainedCryptoProbeFields.map((field) => [field, 1]))
    );
    expect(evidence.sourceUnversionedCount).toBe(11);
    expect(evidence.sourceVersionCounts).toEqual({});
    expect(evidence.targetVersionCounts).toEqual({ [fixture.target.version]: 11 });
    const serialized = JSON.stringify(evidence);
    for (const entry of fixture.cases) {
      if (typeof entry.sourceValue === "string")
        expect(serialized).not.toContain(entry.sourceValue);
    }
    expect(serialized).not.toContain(fixture.target.key);
    expect(serialized).not.toMatch(/__platos_enc|ciphertext|nonce|authTag|plaintext-looking/);
  });
});
