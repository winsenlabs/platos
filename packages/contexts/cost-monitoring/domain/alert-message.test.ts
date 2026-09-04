import { describe, expect, it } from "vitest";

import {
  renderAlertDocument,
  renderAlertSubject,
  renderAlertText,
  type BudgetAlert,
} from "./alert-message.js";
import { asCostIdentifier, type BudgetId, type ThresholdEventId, type WindowKey } from "./identifiers.js";
import { centsToMoney } from "./spend.js";

function alert(overrides: Partial<BudgetAlert> = {}): BudgetAlert {
  const spent = centsToMoney(812.345678);
  if (!spent.ok) throw new Error("unreachable");
  return {
    eventId: asCostIdentifier<ThresholdEventId>("event-1"),
    budgetId: asCostIdentifier<BudgetId>("budget-1"),
    organizationId: "org-1",
    projectId: "proj-1",
    environmentId: "env-1",
    subject: "scope",
    targetId: "",
    subjectLabel: "Scope-wide",
    period: "day",
    threshold: 80,
    limitCents: 1_000,
    spent: spent.value,
    tasks: 12,
    runsLimit: 0,
    windowKey: asCostIdentifier<WindowKey>("2026-01-15"),
    firedAt: new Date("2026-01-15T12:00:00.000Z"),
    ...overrides,
  };
}

describe("the plain-text body", () => {
  it("states what happened, then the numbers", () => {
    expect(renderAlertText(alert())).toBe(
      [
        "Platos budget alert",
        "",
        "Scope-wide crossed 80% of its dayly cap.",
        "Spent so far: 8.12345678 USD of 10.00 USD",
        "Window: 2026-01-15",
      ].join("\n"),
    );
  });

  it("omits the turn line when turns are uncapped", () => {
    // "12 of 0" teaches a recipient nothing and makes them mistrust the rest.
    expect(renderAlertText(alert())).not.toContain("Turns this window");
    expect(renderAlertText(alert({ runsLimit: 20 }))).toContain("Turns this window: 12 of 20");
  });

  it("names the subject the crossing was about", () => {
    expect(renderAlertText(alert({ subjectLabel: "User: u-1" }))).toContain("User: u-1 crossed");
  });
});

describe("the subject line", () => {
  it("carries the threshold, which is what a mailbox rule keys on", () => {
    expect(renderAlertSubject(alert())).toBe("Platos budget alert: 80% threshold crossed");
  });
});

describe("the structured document", () => {
  it("states the SAME numbers as the text, because neither computes anything", () => {
    // Three renderings in the source is three places for the number in the mail
    // and the number in the webhook to disagree, and the webhook is the one an
    // operator's automation reads.
    const value = alert();
    const document = renderAlertDocument(value);
    expect(document.threshold).toBe(value.threshold);
    expect(document.limitCents).toBe(value.limitCents);
    expect(document.tasks).toBe(value.tasks);
    expect(renderAlertText(value)).toContain(String(value.threshold));
  });

  it("carries the amount as a canonical decimal STRING", () => {
    // A JSON number cannot carry a Decimal(18, 6); an automation summing a month
    // of alerts would accumulate the difference.
    const document = renderAlertDocument(alert());
    expect(document.spentCents).toBe("812.345678");
    expect(typeof document.spentCents).toBe("string");
  });

  it("carries no credential, no channel configuration and no other tenant", () => {
    const document = renderAlertDocument(alert());
    const serialised = JSON.stringify(document);
    expect(serialised).not.toContain("credential");
    expect(serialised).not.toContain("secret");
    expect(Object.keys(document.scope).sort()).toEqual([
      "environmentId",
      "organizationId",
      "projectId",
    ]);
  });

  it("names a stable event token an automation can key on", () => {
    expect(renderAlertDocument(alert()).event).toBe("platos.budget.threshold_crossed");
  });

  it("dates itself in ISO 8601 UTC", () => {
    expect(renderAlertDocument(alert()).firedAt).toBe("2026-01-15T12:00:00.000Z");
  });
});
