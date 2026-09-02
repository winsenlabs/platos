import { asIdentifier } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import type { NotificationRule, NotificationRuleId } from "../domain/index.js";
import {
  deleteNotificationRule,
  describeNotificationRule,
  listNotificationRules,
} from "./read-notification-rules.js";
import { registerNotificationRule } from "./register-notification-rule.js";
import { updateNotificationRule } from "./update-notification-rule.js";
import {
  buildEventingTestContext,
  TEST_PRINCIPAL,
  testEnvironmentScope,
  type EventingTestContext,
} from "./testing/index.js";

const WEBHOOK = { type: "webhook", url: "https://example.test/hook" } as const;

async function seedRule(
  context: EventingTestContext,
  name = "failures",
  environmentId = "env-1",
): Promise<NotificationRule> {
  const registered = await registerNotificationRule(context.dependencies, {
    scope: testEnvironmentScope(environmentId),
    name,
    filters: { eventTypes: ["run.*"] },
    delivery: WEBHOOK,
    createdBy: TEST_PRINCIPAL,
  });
  if (!registered.ok) throw new Error(registered.error.code);
  return registered.value;
}

describe("updateNotificationRule", () => {
  let context: EventingTestContext;

  beforeEach(() => {
    context = buildEventingTestContext();
  });

  it("changes only the fields the command names", async () => {
    const rule = await seedRule(context);
    context.clock.advanceSeconds(60);

    const updated = await updateNotificationRule(context.dependencies, {
      scope: testEnvironmentScope(),
      ruleId: rule.ruleId,
      enabled: false,
    });

    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error("unreachable");
    expect(updated.value.enabled).toBe(false);
    expect(updated.value.name).toBe(rule.name);
    expect(updated.value.filter).toEqual(rule.filter);
    expect(updated.value.updatedAt.getTime()).toBeGreaterThan(rule.updatedAt.getTime());
  });

  // The PATCH defect: omitting `enabled` must not re-enable a disabled rule.
  it("does NOT re-enable a disabled rule when the command omits enabled", async () => {
    const rule = await seedRule(context);
    await updateNotificationRule(context.dependencies, {
      scope: testEnvironmentScope(),
      ruleId: rule.ruleId,
      enabled: false,
    });
    const renamed = await updateNotificationRule(context.dependencies, {
      scope: testEnvironmentScope(),
      ruleId: rule.ruleId,
      name: "renamed",
    });
    if (!renamed.ok) throw new Error("unreachable");
    expect(renamed.value.enabled).toBe(false);
  });

  it("refuses a rule id from another environment as NOT FOUND", async () => {
    const rule = await seedRule(context, "failures", "env-1");
    const denied = await updateNotificationRule(context.dependencies, {
      scope: testEnvironmentScope("env-2"),
      ruleId: rule.ruleId,
      enabled: false,
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("EVENTING_RULE_NOT_FOUND");
    expect(context.repository.allRules()[0]?.enabled).toBe(true);
  });

  it("refuses an unknown rule id", async () => {
    const denied = await updateNotificationRule(context.dependencies, {
      scope: testEnvironmentScope(),
      ruleId: asIdentifier<NotificationRuleId>("nope"),
      enabled: false,
    });
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("EVENTING_RULE_NOT_FOUND");
  });

  it("re-validates every field it is given, as registration does", async () => {
    const rule = await seedRule(context);
    const badName = await updateNotificationRule(context.dependencies, {
      scope: testEnvironmentScope(),
      ruleId: rule.ruleId,
      name: "",
    });
    if (badName.ok) throw new Error("unreachable");
    expect(badName.error.code).toBe("EVENTING_RULE_NAME_INVALID");

    const badFilters = await updateNotificationRule(context.dependencies, {
      scope: testEnvironmentScope(),
      ruleId: rule.ruleId,
      filters: { eventTypes: [] },
    });
    if (badFilters.ok) throw new Error("unreachable");
    expect(badFilters.error.code).toBe("EVENTING_RULE_FILTERS_INVALID");
  });

  // Registering a public webhook and then repointing it at private space is the
  // obvious way round a register-time-only check.
  it("RE-SCREENS a changed destination, so a rule cannot be repointed at private space", async () => {
    const rule = await seedRule(context);
    context.screen.refuse("http://169.254.169.254/latest/meta-data", "link-local");

    const denied = await updateNotificationRule(context.dependencies, {
      scope: testEnvironmentScope(),
      ruleId: rule.ruleId,
      delivery: { type: "webhook", url: "http://169.254.169.254/latest/meta-data" },
    });

    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("EVENTING_RULE_DESTINATION_REJECTED");
    expect(context.repository.allRules()[0]?.destination).toEqual({ kind: "webhook", url: WEBHOOK.url });
  });

  it("refuses a rename onto a sibling's name", async () => {
    const first = await seedRule(context, "first");
    await seedRule(context, "second");
    const denied = await updateNotificationRule(context.dependencies, {
      scope: testEnvironmentScope(),
      ruleId: first.ruleId,
      name: "second",
    });
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("EVENTING_RULE_NAME_TAKEN");
  });

  // An idempotent re-PUT of an unchanged rule must not trip the unique index
  // against the rule's own row.
  it("ALLOWS a rename to the rule's own current name", async () => {
    const rule = await seedRule(context, "failures");
    const renamed = await updateNotificationRule(context.dependencies, {
      scope: testEnvironmentScope(),
      ruleId: rule.ruleId,
      name: "failures",
    });
    expect(renamed.ok).toBe(true);
  });

  it("returns the rule unchanged, and writes nothing, for an empty edit", async () => {
    const rule = await seedRule(context);
    const before = context.unitOfWork.transactions.length;
    const updated = await updateNotificationRule(context.dependencies, {
      scope: testEnvironmentScope(),
      ruleId: rule.ruleId,
    });
    if (!updated.ok) throw new Error("unreachable");
    expect(updated.value).toEqual(rule);
    expect(context.unitOfWork.transactions).toHaveLength(before);
  });
});

describe("reads and delete", () => {
  let context: EventingTestContext;

  beforeEach(() => {
    context = buildEventingTestContext();
  });

  it("lists newest first, matching the legacy ordering", async () => {
    await seedRule(context, "oldest");
    context.clock.advanceSeconds(60);
    await seedRule(context, "newest");

    const listed = await listNotificationRules(context.dependencies, testEnvironmentScope());
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value.map((rule) => rule.name)).toEqual(["newest", "oldest"]);
  });

  it("lists only the requested environment's rules", async () => {
    await seedRule(context, "mine", "env-1");
    await seedRule(context, "theirs", "env-2");
    const listed = await listNotificationRules(context.dependencies, testEnvironmentScope("env-1"));
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value.map((rule) => rule.name)).toEqual(["mine"]);
  });

  it("describes a rule in scope and refuses one outside it", async () => {
    const rule = await seedRule(context, "failures", "env-1");
    const found = await describeNotificationRule(context.dependencies, testEnvironmentScope("env-1"), rule.ruleId);
    expect(found.ok).toBe(true);

    const denied = await describeNotificationRule(context.dependencies, testEnvironmentScope("env-2"), rule.ruleId);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("EVENTING_RULE_NOT_FOUND");
  });

  it("deletes a rule and reports true", async () => {
    const rule = await seedRule(context);
    const deleted = await deleteNotificationRule(context.dependencies, testEnvironmentScope(), rule.ruleId);
    if (!deleted.ok) throw new Error("unreachable");
    expect(deleted.value).toBe(true);
    expect(context.repository.allRules()).toHaveLength(0);
  });

  // Delete is idempotent: a caller retrying after a timeout must not get an
  // error for having succeeded the first time.
  it("reports false, NOT an error, for an already-absent rule", async () => {
    const rule = await seedRule(context);
    await deleteNotificationRule(context.dependencies, testEnvironmentScope(), rule.ruleId);
    const again = await deleteNotificationRule(context.dependencies, testEnvironmentScope(), rule.ruleId);
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error("unreachable");
    expect(again.value).toBe(false);
  });

  it("refuses to delete another environment's rule and leaves it standing", async () => {
    const rule = await seedRule(context, "failures", "env-1");
    const denied = await deleteNotificationRule(context.dependencies, testEnvironmentScope("env-2"), rule.ruleId);
    if (!denied.ok) throw new Error("unreachable");
    expect(denied.value).toBe(false);
    expect(context.repository.allRules()).toHaveLength(1);
  });
});
