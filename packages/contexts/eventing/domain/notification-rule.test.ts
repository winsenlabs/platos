import { asIdentifier, environmentScope, type PrincipalId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import { asEventName } from "./coercions.js";
import { parseDestination, type Destination } from "./destination.js";
import type { NotificationRuleId, RuleName, SubjectId } from "./identifiers.js";
import {
  createNotificationRule,
  editIsVacuous,
  editNotificationRule,
  ruleAdmits,
  type NotificationRule,
} from "./notification-rule.js";
import { parseRuleFilter, type RuleFilter } from "./rule-filter.js";
import { MAX_RULE_NAME_LENGTH, parseRuleName } from "./rule-name.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const LATER = new Date("2026-01-02T00:00:00.000Z");

function filter(eventTypes: string[], subjectIds?: string[]): RuleFilter {
  const parsed = parseRuleFilter({ eventTypes, subjectIds: subjectIds ?? null });
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function destination(raw: unknown): Destination {
  const parsed = parseDestination(raw as never);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function build(overrides: Partial<Pick<NotificationRule, "name" | "filter">> = {}): NotificationRule {
  return createNotificationRule(
    {
      ruleId: asIdentifier<NotificationRuleId>("rule-1"),
      scope: environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1")),
      name: overrides.name ?? (asIdentifier<RuleName>("failures")),
      filter: overrides.filter ?? filter(["run.*"]),
      destination: destination({ type: "webhook", url: "https://example.test/hook" }),
      createdBy: asIdentifier<PrincipalId>("user-1"),
    },
    NOW,
  );
}

const name = asEventName;
const subject = (raw: string): SubjectId => asIdentifier<SubjectId>(raw);

describe("parseRuleName", () => {
  it("accepts the legacy 1–120 bound at both edges", () => {
    expect(parseRuleName("a").ok).toBe(true);
    expect(parseRuleName("x".repeat(MAX_RULE_NAME_LENGTH)).ok).toBe(true);
  });

  it("refuses just outside the bound at both edges", () => {
    expect(parseRuleName("").ok).toBe(false);
    expect(parseRuleName("x".repeat(MAX_RULE_NAME_LENGTH + 1)).ok).toBe(false);
  });

  it("reports a field violation a transport can render", () => {
    const denied = parseRuleName("");
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("EVENTING_RULE_NAME_INVALID");
    expect(denied.error.fields[0]?.field).toBe("name");
  });

  // Not trimmed: the unique index treats " " and "" as different values, so
  // trimming here would make two rules the database considers distinct collide.
  it("does NOT trim, so whitespace is a legal name", () => {
    expect(parseRuleName(" ").ok).toBe(true);
  });
});

describe("createNotificationRule", () => {
  it("is enabled, matching the column default and the legacy create", () => {
    expect(build().enabled).toBe(true);
  });

  it("stamps both timestamps from the injected instant", () => {
    const rule = build();
    expect(rule.createdAt.toISOString()).toBe(NOW.toISOString());
    expect(rule.updatedAt.toISOString()).toBe(NOW.toISOString());
  });
});

describe("editNotificationRule", () => {
  it("leaves an omitted field alone", () => {
    const rule = build();
    const edited = editNotificationRule(rule, { name: asIdentifier<RuleName>("renamed") }, LATER);
    if (!edited.ok) throw new Error("unreachable");
    expect(edited.value.name).toBe("renamed");
    expect(edited.value.enabled).toBe(true);
    expect(edited.value.filter).toBe(rule.filter);
    expect(edited.value.destination).toBe(rule.destination);
  });

  // The defect every naive PATCH has: a request that omits `enabled` must not
  // re-enable a rule the operator disabled.
  it("does NOT re-enable a disabled rule when enabled is omitted", () => {
    const disabled = editNotificationRule(build(), { enabled: false }, LATER);
    if (!disabled.ok) throw new Error("unreachable");
    const renamed = editNotificationRule(disabled.value, { name: asIdentifier<RuleName>("x") }, LATER);
    if (!renamed.ok) throw new Error("unreachable");
    expect(renamed.value.enabled).toBe(false);
  });

  it("can set enabled to false explicitly", () => {
    const edited = editNotificationRule(build(), { enabled: false }, LATER);
    if (!edited.ok) throw new Error("unreachable");
    expect(edited.value.enabled).toBe(false);
  });

  it("advances updatedAt and leaves createdAt alone", () => {
    const edited = editNotificationRule(build(), { enabled: false }, LATER);
    if (!edited.ok) throw new Error("unreachable");
    expect(edited.value.updatedAt.toISOString()).toBe(LATER.toISOString());
    expect(edited.value.createdAt.toISOString()).toBe(NOW.toISOString());
  });
});

describe("editIsVacuous", () => {
  it("is true for an empty edit and false once any field is present", () => {
    expect(editIsVacuous({})).toBe(true);
    expect(editIsVacuous({ enabled: false })).toBe(false);
    expect(editIsVacuous({ name: asIdentifier<RuleName>("x") })).toBe(false);
  });
});

describe("ruleAdmits", () => {
  it("admits a matching event on an enabled rule", () => {
    expect(ruleAdmits(build(), name("run.completed"), null)).toBe(true);
  });

  it("refuses a non-matching event", () => {
    expect(ruleAdmits(build(), name("tool.called"), null)).toBe(false);
  });

  // The routing query narrows on `enabled` in the store; this predicate is the
  // belt to that braces, so a caller listing rules another way cannot deliver
  // through a disabled rule.
  it("a DISABLED rule admits nothing, even a perfect match", () => {
    const disabled = editNotificationRule(build({ filter: filter(["*"]) }), { enabled: false }, LATER);
    if (!disabled.ok) throw new Error("unreachable");
    expect(ruleAdmits(disabled.value, name("run.completed"), subject("run-1"))).toBe(false);
  });
});
