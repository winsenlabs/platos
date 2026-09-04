import { describe, expect, it } from "vitest";

import type { SafetyEventDraft } from "../domain/index.js";
import { describeSafetyEvent, pageSafetyEvents, summariseSafety } from "./read-safety.js";
import { recordSafetyEvent } from "./record-safety-event.js";
import { buildGovernanceTestContext, otherEnvironmentScope, withPolicy, type GovernanceTestContext } from "./testing/index.js";

const DAY = 86_400_000;

function draft(overrides: Partial<SafetyEventDraft> = {}): SafetyEventDraft {
  return { detector: "pii", action: "redact", severity: "medium", ...overrides };
}

async function record(context: GovernanceTestContext, overrides: Partial<SafetyEventDraft> = {}) {
  return recordSafetyEvent(context.dependencies, {
    authorization: context.authorization,
    event: draft(overrides),
  });
}

describe("recordSafetyEvent", () => {
  it("appends through a genuine grant and stamps the granted environment", async () => {
    const context = buildGovernanceTestContext();
    const written = await record(context);
    expect(written.ok && written.value.environmentId).toBe("env-1");
    expect(context.safety.size()).toBe(1);
  });

  it("REFUSES an unminted grant and WRITES NOTHING", async () => {
    const context = buildGovernanceTestContext();
    const written = await recordSafetyEvent(context.dependencies, {
      authorization: { pretend: true },
      event: draft(),
    });
    expect(written.ok).toBe(false);
    expect(context.safety.size()).toBe(0);
  });

  it("REFUSES an unknown detector BEFORE the store is touched", async () => {
    const context = buildGovernanceTestContext();
    const written = await record(context, { detector: "vibes" });
    expect(!written.ok && written.error.code).toBe("GOVERNANCE_SAFETY_DETECTOR_UNKNOWN");
    expect(context.safety.size()).toBe(0);
  });

  it("reports a store failure rather than swallowing it, unlike the sink", async () => {
    const context = buildGovernanceTestContext();
    context.safety.failNext("store down");
    const written = await record(context);
    expect(!written.ok && written.error.code).toBe("GOVERNANCE_LEDGER_UNAVAILABLE");
  });
});

describe("pageSafetyEvents", () => {
  it("REFUSES an unminted grant and reads nothing", async () => {
    const context = buildGovernanceTestContext();
    await record(context);
    const page = await pageSafetyEvents(context.dependencies, { authorization: {} });
    expect(page.ok).toBe(false);
  });

  it("does NOT show another environment's events to this grant", async () => {
    const context = buildGovernanceTestContext();
    await record(context);
    const elsewhere = await pageSafetyEvents(context.dependencies, {
      authorization: context.grantFor(otherEnvironmentScope()),
    });
    expect(elsewhere.ok && elsewhere.value.items).toEqual([]);
    expect(elsewhere.ok && elsewhere.value.total).toBe(0);
  });

  it("clamps an over-wide page to EXACTLY the ceiling", async () => {
    // Seeded with more rows than the ceiling, so the clamp is what limits the
    // page rather than the supply of rows.
    const context = buildGovernanceTestContext({ policy: withPolicy({ safety: { maxPageSize: 3 } }) });
    for (let index = 0; index < 5; index += 1) await record(context);
    const page = await pageSafetyEvents(context.dependencies, {
      authorization: context.authorization,
      limit: 100,
    });
    expect(page.ok && page.value.items).toHaveLength(3);
    expect(page.ok && page.value.limit).toBe(3);
    expect(page.ok && page.value.total).toBe(5);
  });

  it("REFUSES a negative offset rather than serving page one", async () => {
    const context = buildGovernanceTestContext();
    const page = await pageSafetyEvents(context.dependencies, {
      authorization: context.authorization,
      offset: -1,
    });
    expect(!page.ok && page.error.code).toBe("GOVERNANCE_PAGE_REQUEST_INVALID");
  });

  it("excludes an event older than the window, and includes one inside it", async () => {
    const context = buildGovernanceTestContext();
    await record(context);
    context.clock.advanceMilliseconds(10 * DAY);
    await record(context, { detector: "injection" });

    const week = await pageSafetyEvents(context.dependencies, {
      authorization: context.authorization,
      sinceDays: 7,
    });
    expect(week.ok && week.value.items).toHaveLength(1);
    expect(week.ok && week.value.items[0]?.detector).toBe("injection");

    const month = await pageSafetyEvents(context.dependencies, {
      authorization: context.authorization,
      sinceDays: 30,
    });
    expect(month.ok && month.value.items).toHaveLength(2);
  });

  it("reports the CLAMPED window it actually read, not the one asked for", async () => {
    const context = buildGovernanceTestContext();
    const page = await pageSafetyEvents(context.dependencies, {
      authorization: context.authorization,
      sinceDays: 10_000,
    });
    expect(page.ok && page.value.sinceDays).toBe(365);
  });

  it("filters by detector and by severity", async () => {
    const context = buildGovernanceTestContext();
    await record(context, { detector: "pii", severity: "low" });
    await record(context, { detector: "injection", severity: "high" });
    const byDetector = await pageSafetyEvents(context.dependencies, {
      authorization: context.authorization,
      detector: "injection",
    });
    expect(byDetector.ok && byDetector.value.items).toHaveLength(1);
    const bySeverity = await pageSafetyEvents(context.dependencies, {
      authorization: context.authorization,
      severity: "low",
    });
    expect(bySeverity.ok && bySeverity.value.items[0]?.detector).toBe("pii");
  });

  it("treats an empty search term as NO filter rather than as one that matches", async () => {
    const context = buildGovernanceTestContext();
    await record(context, { toolName: "search" });
    const page = await pageSafetyEvents(context.dependencies, {
      authorization: context.authorization,
      search: "   ",
    });
    expect(page.ok && page.value.items).toHaveLength(1);
  });
});

describe("describeSafetyEvent", () => {
  it("reads one event back", async () => {
    const context = buildGovernanceTestContext();
    const written = await record(context);
    if (!written.ok) throw new Error("unreachable");
    const found = await describeSafetyEvent(context.dependencies, {
      authorization: context.authorization,
      safetyEventId: written.value.safetyEventId,
    });
    expect(found.ok && found.value?.safetyEventId).toBe(written.value.safetyEventId);
  });

  it("answers NULL for an event in another environment, never the row", async () => {
    const context = buildGovernanceTestContext();
    const written = await record(context);
    if (!written.ok) throw new Error("unreachable");
    const found = await describeSafetyEvent(context.dependencies, {
      authorization: context.grantFor(otherEnvironmentScope()),
      safetyEventId: written.value.safetyEventId,
    });
    expect(found.ok && found.value).toBeNull();
  });
});

describe("summariseSafety", () => {
  it("counts exactly what is in the window, on all three axes", async () => {
    const context = buildGovernanceTestContext();
    await record(context, { detector: "pii", action: "redact", severity: "medium" });
    await record(context, { detector: "pii", action: "block", severity: "high" });
    await record(context, { detector: "budget", action: "warn", severity: "low" });

    const summary = await summariseSafety(context.dependencies, { authorization: context.authorization });
    expect(summary.ok && summary.value.total).toBe(3);
    expect(summary.ok && summary.value.byDetector.pii).toBe(2);
    expect(summary.ok && summary.value.byDetector.budget).toBe(1);
    expect(summary.ok && summary.value.byDetector.injection).toBe(0);
    expect(summary.ok && summary.value.bySeverity.high).toBe(1);
  });

  it("excludes events outside the window from every axis", async () => {
    const context = buildGovernanceTestContext();
    await record(context, { detector: "pii" });
    context.clock.advanceMilliseconds(10 * DAY);
    const summary = await summariseSafety(context.dependencies, {
      authorization: context.authorization,
      sinceDays: 7,
    });
    expect(summary.ok && summary.value.total).toBe(0);
    expect(summary.ok && summary.value.byDetector.pii).toBe(0);
  });

  it("does not roll up another environment's events", async () => {
    const context = buildGovernanceTestContext();
    await record(context);
    const summary = await summariseSafety(context.dependencies, {
      authorization: context.grantFor(otherEnvironmentScope()),
    });
    expect(summary.ok && summary.value.total).toBe(0);
  });

  it("REFUSES an unminted grant", async () => {
    const context = buildGovernanceTestContext();
    expect((await summariseSafety(context.dependencies, { authorization: null })).ok).toBe(false);
  });
});
