import { asIdentifier, environmentScope, type EventId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { asEventName } from "./coercions.js";
import { parseDestination } from "./destination.js";
import type { NotificationRuleId, RuleName, SubjectId } from "./identifiers.js";
import { severityOf, summarize, type NotificationRequested } from "./notification-request.js";

function destination() {
  const parsed = parseDestination({ type: "webhook", url: "https://example.test/hook" });
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function request(overrides: Partial<NotificationRequested> = {}): NotificationRequested {
  const eventName = overrides.eventName ?? asEventName("run.completed");
  return {
    ruleId: asIdentifier<NotificationRuleId>("rule-1"),
    ruleName: asIdentifier<RuleName>("failures"),
    scope: environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1")),
    eventId: asIdentifier<EventId>("evt-1"),
    eventName,
    subjectId: null,
    payload: {},
    destination: destination(),
    severity: severityOf(eventName),
    retryCount: 0,
    requestedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("severityOf", () => {
  // Lifted out of the legacy Slack renderer, where it decided an attachment
  // colour. The two suffixes are the whole rule.
  it("is alert for the two legacy suffixes", () => {
    expect(severityOf(asEventName("run.failed"))).toBe("alert");
    expect(severityOf(asEventName("budget.exceeded"))).toBe("alert");
  });

  it("is info for everything else", () => {
    expect(severityOf(asEventName("run.completed"))).toBe("info");
    expect(severityOf(asEventName("run.started"))).toBe("info");
  });

  it("matches on the SUFFIX, not on containment", () => {
    expect(severityOf(asEventName("run.failed.retried"))).toBe("info");
    expect(severityOf(asEventName("exceeded.budget"))).toBe("info");
  });
});

describe("summarize", () => {
  // Operators have this string in Slack history and in alert-routing regexes,
  // so its shape is part of the observable contract.
  it("renders the legacy line with a subject", () => {
    expect(summarize(request({ subjectId: asIdentifier<SubjectId>("run-7") }))).toBe(
      "[platos] run.completed subject=run-7 (rule: failures)",
    );
  });

  it("omits the subject segment entirely when there is none", () => {
    expect(summarize(request())).toBe("[platos] run.completed (rule: failures)");
  });
});
