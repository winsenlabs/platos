import { describe, expect, it } from "vitest";

import { DEFAULT_LOGIN_POLICY, DEFAULT_MFA_VERIFY_POLICY } from "../domain/index.js";
import { ENVIRONMENT, MINUTE_MS } from "../domain/testing.js";
import { consumeRateLimit } from "./consume-rate-limit.js";
import { testPorts, type TestPorts } from "./testing.js";

const request = {
  action: "LOGIN",
  identifier: "198.51.100.7",
  scope: ENVIRONMENT,
  principalId: null,
} as const;

async function spend(ports: TestPorts, times: number): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await consumeRateLimit(ports, request);
  }
}

describe("spending an authentication budget", () => {
  it("admits requests up to the policy limit", async () => {
    const ports = testPorts();
    await spend(ports, DEFAULT_LOGIN_POLICY.requests - 1);
    const last = await consumeRateLimit(ports, request);
    expect(last.ok).toBe(true);
    if (!last.ok) return;
    expect(last.value).toEqual({ outcome: "allowed", remaining: 0 });
  });

  it("REFUSES THE REQUEST AFTER THE LIMIT, with a retry-after", async () => {
    const ports = testPorts();
    await spend(ports, DEFAULT_LOGIN_POLICY.requests);
    const refused = await consumeRateLimit(ports, request);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("RATE_LIMITED");
    expect(refused.error.retryAfterSeconds).toBe(60);
  });

  it("REPORTS THE DENIAL THROUGH THE KERNEL SAFETY SINK, not by importing governance", async () => {
    const ports = testPorts();
    await spend(ports, DEFAULT_LOGIN_POLICY.requests + 1);
    const observation = ports.safety.observations.at(-1);
    expect(observation?.rule).toBe("identity.rate_limit.exceeded");
    expect(observation?.outcome).toBe("blocked");
    expect(observation?.scope).toBe(ENVIRONMENT);
    expect(observation?.details).toMatchObject({ action: "LOGIN", limit: 10 });
  });

  it("records nothing while requests are still inside the budget", async () => {
    const ports = testPorts();
    await spend(ports, DEFAULT_LOGIN_POLICY.requests);
    expect(ports.safety.observations).toHaveLength(0);
  });

  it("RESETS WHEN THE WINDOW ROLLS OVER", async () => {
    const ports = testPorts();
    await spend(ports, DEFAULT_LOGIN_POLICY.requests + 1);
    expect((await consumeRateLimit(ports, request)).ok).toBe(false);

    ports.clock.advance(MINUTE_MS);
    const afterRollover = await consumeRateLimit(ports, request);
    expect(afterRollover.ok).toBe(true);
    if (!afterRollover.ok) return;
    expect(afterRollover.value).toEqual({ outcome: "allowed", remaining: 9 });
  });

  it("keeps separate budgets per action and per identifier", async () => {
    const ports = testPorts();
    await spend(ports, DEFAULT_LOGIN_POLICY.requests + 1);
    const otherAction = await consumeRateLimit(ports, { ...request, action: "MFA_VERIFY" });
    const otherIdentifier = await consumeRateLimit(ports, { ...request, identifier: "other" });
    expect(otherAction.ok).toBe(true);
    expect(otherIdentifier.ok).toBe(true);
  });

  it("normalizes the identifier, so one caller cannot get two budgets by casing", async () => {
    const ports = testPorts();
    await spend(ports, DEFAULT_LOGIN_POLICY.requests + 1);
    const cased = await consumeRateLimit(ports, { ...request, identifier: " 198.51.100.7 " });
    expect(cased.ok).toBe(false);
  });

  it("uses each action's own policy", async () => {
    const ports = testPorts();
    for (let index = 0; index < DEFAULT_MFA_VERIFY_POLICY.requests; index += 1) {
      expect((await consumeRateLimit(ports, { ...request, action: "MFA_VERIFY" })).ok).toBe(true);
    }
    expect((await consumeRateLimit(ports, { ...request, action: "MFA_VERIFY" })).ok).toBe(false);
  });
});

describe("when the limiter itself is unreachable", () => {
  it("FAILS OPEN — the documented availability-over-limiting policy", async () => {
    const ports = testPorts();
    ports.rateLimiter.breakLimiter();
    const result = await consumeRateLimit(ports, request);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ outcome: "degraded" });
  });

  it("reports the degradation, so an outage is discoverable rather than silent", async () => {
    const ports = testPorts();
    ports.rateLimiter.breakLimiter();
    await consumeRateLimit(ports, request);
    const observation = ports.safety.observations.at(-1);
    expect(observation?.rule).toBe("identity.rate_limit.degraded");
    expect(observation?.details).toMatchObject({ reason: "IDENTITY_STORE_UNAVAILABLE" });
  });

  it("does not let an exhausted budget survive a limiter outage as a refusal", async () => {
    const ports = testPorts();
    await spend(ports, DEFAULT_LOGIN_POLICY.requests + 1);
    ports.rateLimiter.breakLimiter();
    expect((await consumeRateLimit(ports, request)).ok).toBe(true);
  });
});
