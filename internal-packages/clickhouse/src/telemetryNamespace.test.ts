import { describe, expect, test } from "vitest";
import { resolveTelemetryDatabase } from "./telemetryNamespace.js";

describe("telemetry database namespace", () => {
  test("defaults to the Platos-owned database", () => {
    expect(resolveTelemetryDatabase(undefined)).toBe("platos_telemetry");
    expect(resolveTelemetryDatabase("  ")).toBe("platos_telemetry");
  });

  test("accepts a bounded rollback override", () => {
    expect(resolveTelemetryDatabase("rollback_namespace_1")).toBe("rollback_namespace_1");
  });

  test("rejects values that cannot be safely interpolated as identifiers", () => {
    expect(() => resolveTelemetryDatabase("database; DROP DATABASE other")).toThrow(
      "CLICKHOUSE_DATABASE must be a valid unquoted ClickHouse identifier"
    );
  });
});
