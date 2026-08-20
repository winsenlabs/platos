import { describe, expect, test } from "vitest";
import {
  OBSERVABILITY_URL_VARIABLES,
  parseObservabilityEndpoint,
  readObservabilityUrl,
  resolveObservabilityConfig,
} from "./observability-config";

describe("observability endpoint resolution", () => {
  test("prefers the dedicated variable over the inherited ones", () => {
    const found = readObservabilityUrl({
      PLATOS_OBSERVABILITY_CLICKHOUSE_URL: "http://dedicated:8123",
      PLATOS_OTEL_CLICKHOUSE_URL: "http://spans:8123",
      CLICKHOUSE_URL: "http://webapp:8123",
    });
    expect(found).toEqual({
      raw: "http://dedicated:8123",
      source: "PLATOS_OBSERVABILITY_CLICKHOUSE_URL",
    });
  });

  test("falls through the inherited variables in order", () => {
    expect(readObservabilityUrl({ PLATOS_OTEL_CLICKHOUSE_URL: "http://spans:8123" })?.source)
      .toBe("PLATOS_OTEL_CLICKHOUSE_URL");
    expect(readObservabilityUrl({ CLICKHOUSE_URL: "http://webapp:8123" })?.source)
      .toBe("CLICKHOUSE_URL");
  });

  test("treats the empty string compose passes for an unset variable as absent", () => {
    expect(readObservabilityUrl({ PLATOS_OBSERVABILITY_CLICKHOUSE_URL: "" })).toBeNull();
    expect(readObservabilityUrl({ PLATOS_OBSERVABILITY_CLICKHOUSE_URL: "   " })).toBeNull();
    expect(resolveObservabilityConfig({}).configured).toBe(false);
  });

  test("splits URL credentials out into Basic auth and drops the query string", () => {
    // Node's fetch refuses a URL carrying credentials, and `?secure=false`
    // collides with the `?query=` appended on the way out.
    const target = parseObservabilityEndpoint("http://default:s3cret@clickhouse:8123?secure=false");
    expect(target).toEqual({
      endpoint: "http://clickhouse:8123",
      auth: { user: "default", pass: "s3cret" },
    });
  });

  test("percent-decodes credentials and strips a trailing slash", () => {
    expect(parseObservabilityEndpoint("https://user%40platos:p%3Fwd@host:8443/")).toEqual({
      endpoint: "https://host:8443",
      auth: { user: "user@platos", pass: "p?wd" },
    });
  });

  test("rejects a non-http protocol as unusable rather than absent", () => {
    // Configured-but-unusable must stay distinguishable from unconfigured: the
    // deployment HAS a store and someone mistyped where it is.
    const config = resolveObservabilityConfig({
      PLATOS_OBSERVABILITY_CLICKHOUSE_URL: "clickhouse://host:9000",
    });
    expect(config.configured).toBe(true);
    expect(config.target).toBeNull();
    expect(config.source).toBe("PLATOS_OBSERVABILITY_CLICKHOUSE_URL");
  });

  test("keeps a URL path so a reverse-proxied ClickHouse still resolves", () => {
    expect(parseObservabilityEndpoint("https://proxy.example/clickhouse/")?.endpoint)
      .toBe("https://proxy.example/clickhouse");
  });

  test("clamps tuning knobs and defaults the ones that are absent", () => {
    const defaults = resolveObservabilityConfig({});
    expect(defaults.batchSize).toBe(1_000);
    expect(defaults.drainBatchSize).toBe(500);
    expect(defaults.maxAttempts).toBe(10);
    expect(defaults.requireSink).toBe(false);

    const tuned = resolveObservabilityConfig({
      PLATOS_OBSERVABILITY_BATCH_SIZE: "0",
      PLATOS_OBSERVABILITY_DRAIN_BATCH_SIZE: "999999",
      PLATOS_OBSERVABILITY_MAX_ATTEMPTS: "not-a-number",
      PLATOS_OBSERVABILITY_REQUIRE_SINK: "true",
    });
    expect(tuned.batchSize).toBe(1_000);
    expect(tuned.drainBatchSize).toBe(5_000);
    expect(tuned.maxAttempts).toBe(10);
    expect(tuned.requireSink).toBe(true);
  });

  test("names no trigger.dev variable", () => {
    for (const name of OBSERVABILITY_URL_VARIABLES) {
      expect(name.toLowerCase()).not.toContain("trigger");
    }
  });
});
