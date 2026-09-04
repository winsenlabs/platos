import { beforeEach, describe, expect, it } from "vitest";

import { MAX_RULE_NAME_LENGTH } from "../domain/index.js";
import { registerNotificationRule } from "./register-notification-rule.js";
import {
  buildEventingTestContext,
  TEST_PRINCIPAL,
  testEnvironmentScope,
  type EventingTestContext,
} from "./testing/index.js";

const WEBHOOK = { type: "webhook", url: "https://example.test/hook" } as const;

function command(overrides: Record<string, unknown> = {}) {
  return {
    scope: testEnvironmentScope(),
    name: "failures",
    filters: { eventTypes: ["run.*"] },
    delivery: WEBHOOK,
    createdBy: TEST_PRINCIPAL,
    ...overrides,
  } as Parameters<typeof registerNotificationRule>[1];
}

describe("registerNotificationRule", () => {
  let context: EventingTestContext;

  beforeEach(() => {
    context = buildEventingTestContext();
  });

  it("mints an enabled rule from the injected clock and id generator", async () => {
    context.clock.set(new Date("2027-03-04T05:06:07.000Z"));
    const registered = await registerNotificationRule(context.dependencies, command());

    expect(registered.ok).toBe(true);
    if (!registered.ok) throw new Error("unreachable");
    expect(registered.value.ruleId).toBe("id-0001");
    expect(registered.value.enabled).toBe(true);
    expect(registered.value.createdBy).toBe(TEST_PRINCIPAL);
    expect(registered.value.createdAt.toISOString()).toBe("2027-03-04T05:06:07.000Z");
    expect(context.repository.allRules()).toHaveLength(1);
  });

  it("writes inside a unit of work", async () => {
    await registerNotificationRule(context.dependencies, command());
    expect(context.unitOfWork.transactions).toHaveLength(1);
    expect(context.repository.transactions).toHaveLength(1);
  });

  it("refuses a name outside the legacy 1–120 bound, and writes nothing", async () => {
    const denied = await registerNotificationRule(
      context.dependencies,
      command({ name: "x".repeat(MAX_RULE_NAME_LENGTH + 1) }),
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("EVENTING_RULE_NAME_INVALID");
    expect(context.repository.allRules()).toHaveLength(0);
  });

  it("refuses an empty eventTypes array", async () => {
    const denied = await registerNotificationRule(
      context.dependencies,
      command({ filters: { eventTypes: [] } }),
    );
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("EVENTING_RULE_FILTERS_INVALID");
  });

  it("refuses a malformed delivery", async () => {
    const denied = await registerNotificationRule(
      context.dependencies,
      command({ delivery: { type: "sms", url: "https://a.test" } }),
    );
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("EVENTING_RULE_DESTINATION_INVALID");
  });

  // The `@@unique([environmentId, name])` index, surfaced as a handled outcome
  // rather than as a raw constraint violation from the store.
  it("refuses a duplicate name in the SAME environment", async () => {
    await registerNotificationRule(context.dependencies, command());
    const duplicate = await registerNotificationRule(context.dependencies, command());
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) throw new Error("unreachable");
    expect(duplicate.error.code).toBe("EVENTING_RULE_NAME_TAKEN");
    expect(context.repository.allRules()).toHaveLength(1);
  });

  // Kills: deleting the EVENTING_RULE_NAME_TAKEN pre-flight from the use case.
  // The index would still refuse the duplicate — the in-memory store enforces
  // `@@unique([environmentId, name])` exactly as Postgres does — so the ERROR
  // CODE alone cannot tell "pre-flighted" from "rejected by the store", and the
  // case above passes either way. What the pre-flight buys is that the common
  // case opens NO transaction at all, and that is the assertion.
  it("refuses a duplicate name BEFORE opening a transaction", async () => {
    await registerNotificationRule(context.dependencies, command());
    expect(context.unitOfWork.transactions).toHaveLength(1);

    const duplicate = await registerNotificationRule(context.dependencies, command());

    if (duplicate.ok) throw new Error("unreachable");
    expect(duplicate.error.code).toBe("EVENTING_RULE_NAME_TAKEN");
    expect(context.unitOfWork.transactions).toHaveLength(1);
    expect(context.repository.transactions).toHaveLength(1);
  });

  it("ALLOWS the same name in a different environment — the index is composite", async () => {
    await registerNotificationRule(context.dependencies, command());
    const elsewhere = await registerNotificationRule(
      context.dependencies,
      command({ scope: testEnvironmentScope("env-2") }),
    );
    expect(elsewhere.ok).toBe(true);
    expect(context.repository.allRules()).toHaveLength(2);
  });

  // --- the SSRF boundary ----------------------------------------------------

  it("screens a url-bearing destination before persisting it", async () => {
    await registerNotificationRule(context.dependencies, command());
    expect(context.screen.screened).toEqual([WEBHOOK.url]);
  });

  it("REFUSES a destination the screen denies, and writes nothing", async () => {
    context.screen.refuse(WEBHOOK.url, "resolves to 169.254.169.254");
    const denied = await registerNotificationRule(context.dependencies, command());
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("EVENTING_RULE_DESTINATION_REJECTED");
    expect(denied.error.category).toBe("forbidden");
    expect(context.repository.allRules()).toHaveLength(0);
  });

  // Failing open here would let an operator persist a link-local destination
  // simply by retrying during a resolver outage. That is the whole vulnerability.
  it("REFUSES the write when the screen cannot decide — it does not fail open", async () => {
    context.screen.breakScreen("resolver timeout");
    const denied = await registerNotificationRule(context.dependencies, command());
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("EVENTING_SCREEN_UNAVAILABLE");
    expect(context.repository.allRules()).toHaveLength(0);
  });

  it("does NOT screen a destination this system never fetches", async () => {
    const registered = await registerNotificationRule(
      context.dependencies,
      command({ delivery: { type: "email", email: "ops@example.test" } }),
    );
    expect(registered.ok).toBe(true);
    expect(context.screen.screened).toHaveLength(0);
  });

  it("does not screen a pagerduty destination either", async () => {
    await registerNotificationRule(
      context.dependencies,
      command({ delivery: { type: "pagerduty", integrationKey: "k-1" } }),
    );
    expect(context.screen.screened).toHaveLength(0);
  });

  it("surfaces a repository failure rather than pretending to have written", async () => {
    context.repository.failNext("connection reset");
    const denied = await registerNotificationRule(context.dependencies, command());
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("EVENTING_REPOSITORY_UNAVAILABLE");
  });
});
