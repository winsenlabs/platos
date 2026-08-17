import { describe, expect, test } from "vitest";
import {
  CUTOVER_ID_MAPPING_VERSION,
  CUTOVER_ID_NAMESPACE,
  cutoverIdGoldenVectors,
  cutoverIdName,
  mapCutoverId,
} from "./cutover-id";

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

  test.each([
    { sourceModel: "", sourceId: "cuid" },
    { sourceModel: "user", sourceId: "cuid" },
    { sourceModel: "User", sourceId: "" },
    { sourceModel: "User", sourceId: "bad:id" },
    { sourceModel: "User", sourceId: "cuid", suffix: "AgentBinding" },
    { sourceModel: "User", sourceId: "cuid", suffix: "bad suffix" },
  ])("rejects ambiguous mapping input %#", (input) => {
    expect(() => mapCutoverId(input)).toThrow(TypeError);
  });
});
