import { describe, expect, test } from "vitest";
import {
  CUTOVER_ID_MAPPING_VERSION,
  CUTOVER_ID_NAMESPACE,
  cutoverIdGoldenVectors,
  cutoverIdName,
  mapCutoverId,
} from "./cutover-id";
import { materializeCutoverIdMap } from "./cutover-backfill";
import type { CutoverDatabase, QueryResultLike } from "./cutover-types";

describe("cutover UUID mapping contract", () => {
  test("pins the namespace, version, exact name grammar, and golden vectors", () => {
    expect(CUTOVER_ID_MAPPING_VERSION).toBe(1);
    expect(CUTOVER_ID_NAMESPACE).toBe("75803f94-05d5-5eb3-b37d-65774e2aaa6c");

    for (const vector of cutoverIdGoldenVectors) {
      expect(mapCutoverId(vector), cutoverIdName(vector)).toBe(vector.expected);
    }
  });

  test("uses stable suffixes only for split targets", () => {
    expect(cutoverIdName({ sourceModel: "PlatosAgent", sourceId: "cuid" })).toBe(
      "PlatosAgent:cuid"
    );
    expect(
      cutoverIdName({ sourceModel: "PlatosAgent", sourceId: "cuid", suffix: "agent-binding" })
    ).toBe("PlatosAgent:cuid:agent-binding");
    expect(mapCutoverId({ sourceModel: "PlatosAgent", sourceId: "cuid" })).not.toBe(
      mapCutoverId({ sourceModel: "PlatosAgent", sourceId: "cuid", suffix: "agent-binding" })
    );
  });

  test("preserves colon, Unicode, whitespace, and case source IDs byte-for-byte", () => {
    const sourceIds = [
      "mfa:fixture:enabled-v1",
      "秘密:Δοκιμή",
      "é",
      "e\u0301",
      "  padded identity  ",
      "CaseSensitiveKey",
      "casesensitivekey",
    ];

    for (const sourceId of sourceIds) {
      const name = cutoverIdName({ sourceModel: "SecretStore", sourceId });
      expect(name).toBe(`SecretStore:${sourceId}`);
      expect(Buffer.from(name.slice("SecretStore:".length), "utf8")).toEqual(
        Buffer.from(sourceId, "utf8")
      );
    }
    expect(mapCutoverId({ sourceModel: "SecretStore", sourceId: "CaseSensitiveKey" })).not.toBe(
      mapCutoverId({ sourceModel: "SecretStore", sourceId: "casesensitivekey" })
    );
    expect(mapCutoverId({ sourceModel: "SecretStore", sourceId: "é" })).not.toBe(
      mapCutoverId({ sourceModel: "SecretStore", sourceId: "e\u0301" })
    );
    expect(mapCutoverId({ sourceModel: "SecretStore", sourceId: " padded identity " })).not.toBe(
      mapCutoverId({ sourceModel: "SecretStore", sourceId: "padded identity" })
    );
  });

  test("materializes realistic SecretStore keys without normalization", async () => {
    const sourceIds = [
      "mfa:fixture:enabled-v1",
      "秘密:Δοκιμή",
      "é",
      "e\u0301",
      "  padded identity  ",
      "CaseSensitiveKey",
      "casesensitivekey",
    ];
    const inserts: unknown[][] = [];
    const database: CutoverDatabase = {
      async query<Row extends Record<string, unknown>>(
        sql: string,
        values?: readonly unknown[]
      ): Promise<QueryResultLike<Row>> {
        if (sql.includes('FROM cutover_legacy."SecretStore"')) {
          return {
            rows: sourceIds.map((source_id) => ({ source_id })) as unknown as Row[],
            rowCount: sourceIds.length,
          };
        }
        if (sql.includes("INSERT INTO cutover_legacy.cutover_id_map")) {
          inserts.push([...(values ?? [])]);
        }
        return { rows: [], rowCount: 0 };
      },
    };

    await materializeCutoverIdMap(database);

    const insertedSourceIds = inserts.flatMap((values) =>
      values.filter((_, index) => index % 5 === 1)
    );
    for (const sourceId of sourceIds) {
      expect(insertedSourceIds.filter((inserted) => inserted === sourceId)).toHaveLength(2);
    }
    expect(insertedSourceIds).not.toContain("mfa-fixture-enabled-v1");
    expect(insertedSourceIds).not.toContain("padded identity");
  });

  test.each([
    { sourceModel: "", sourceId: "cuid" },
    { sourceModel: "user", sourceId: "cuid" },
    { sourceModel: "User", sourceId: "" },
    { sourceModel: "User", sourceId: "bad\0id" },
    { sourceModel: "User", sourceId: "bad\ud800id" },
    { sourceModel: "User", sourceId: "bad\udc00id" },
    { sourceModel: "User", sourceId: "cuid", suffix: "AgentBinding" },
    { sourceModel: "User", sourceId: "cuid", suffix: "bad suffix" },
  ])("rejects malformed mapping input %#", (input) => {
    expect(() => mapCutoverId(input)).toThrow(TypeError);
  });
});
