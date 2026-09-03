import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  expiresAt,
  freshnessSeconds,
  healthCacheKey,
  HEALTH_STATUSES,
  isFresh,
  modelListCacheKey,
  notConfigured,
  statusForFailure,
  unknownProviderReport,
  type ProviderHealthReport,
} from "./health.js";
import type { ProviderId } from "./identifiers.js";
import { DEFAULT_PROVIDERS_POLICY } from "./policy.js";

const POLICY = DEFAULT_PROVIDERS_POLICY.health;
const PROVIDER = asIdentifier<ProviderId>("openai");
const CHECKED = new Date("2026-01-01T00:00:00.000Z");

function report(overrides: Partial<ProviderHealthReport> = {}): ProviderHealthReport {
  return {
    provider: PROVIDER,
    status: "healthy",
    latencyMs: 42,
    failure: null,
    model: "gpt-4.1-mini",
    requiredCredentials: [{ name: asIdentifier("OPENAI_API_KEY"), present: true }],
    checkedAt: CHECKED,
    ...overrides,
  };
}

describe("what a failure means", () => {
  it("condemns the key only when the provider REFUSED it", () => {
    expect(statusForFailure("auth_refused")).toBe("invalid_key");
  });

  it("does not condemn the key when the call simply did not complete", () => {
    expect(statusForFailure("request_failed")).toBe("error");
    expect(statusForFailure("probe_not_configurable")).toBe("error");
  });

  it("declares exactly the four statuses the surface renders", () => {
    expect([...HEALTH_STATUSES]).toEqual(["healthy", "invalid_key", "error", "not_configured"]);
  });
});

describe("results that record that nothing was called", () => {
  it("reports not_configured with no latency and no model", () => {
    const built = notConfigured(PROVIDER, [{ name: asIdentifier("OPENAI_API_KEY"), present: false }], CHECKED);
    expect(built.status).toBe("not_configured");
    expect(built.latencyMs).toBe(0);
    expect(built.model).toBeNull();
    expect(built.failure).toBeNull();
  });

  it("distinguishes an unknown provider from an unconfigured one by its failure token", () => {
    const built = unknownProviderReport(asIdentifier<ProviderId>("nope"), CHECKED);
    expect(built.status).toBe("not_configured");
    expect(built.failure).toBe("unknown_provider");
    expect(built.requiredCredentials).toEqual([]);
  });
});

describe("freshness", () => {
  it("keeps a healthy result far longer than a failing one", () => {
    expect(freshnessSeconds(report(), POLICY)).toBe(POLICY.healthySeconds);
    for (const status of ["invalid_key", "error", "not_configured"] as const) {
      expect(freshnessSeconds(report({ status }), POLICY)).toBe(POLICY.unhealthySeconds);
    }
    expect(POLICY.unhealthySeconds).toBeLessThan(POLICY.healthySeconds);
  });

  it("expires AT its instant, not after it", () => {
    const healthy = report();
    const end = expiresAt(healthy, POLICY);
    expect(end.toISOString()).toBe("2026-01-01T00:05:00.000Z");
    expect(isFresh(healthy, POLICY, new Date(end.getTime() - 1))).toBe(true);
    expect(isFresh(healthy, POLICY, end)).toBe(false);
  });

  it("lets a fixed key be re-checked a minute after it failed", () => {
    const failed = report({ status: "invalid_key" });
    expect(isFresh(failed, POLICY, new Date(CHECKED.getTime() + 59_000))).toBe(true);
    expect(isFresh(failed, POLICY, new Date(CHECKED.getTime() + 60_000))).toBe(false);
  });
});

describe("cache keys", () => {
  it("are keyed by the credential, so a rotation invalidates by construction", () => {
    expect(healthCacheKey(PROVIDER, "aaa")).not.toBe(healthCacheKey(PROVIDER, "bbb"));
  });

  it("do not collide across providers", () => {
    expect(healthCacheKey(PROVIDER, "aaa")).not.toBe(
      healthCacheKey(asIdentifier<ProviderId>("anthropic"), "aaa"),
    );
  });

  it("keep liveness and model lists in separate namespaces", () => {
    expect(healthCacheKey(PROVIDER, "aaa")).not.toBe(modelListCacheKey(PROVIDER, "aaa"));
  });
});
