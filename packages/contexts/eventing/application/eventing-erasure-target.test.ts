import { asIdentifier, organizationScope, type ErasureSubject, type PrincipalId } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { registerNotificationRule } from "./register-notification-rule.js";
import {
  createEventingErasureTarget,
  ERASED_PRINCIPAL,
  EventingErasureRejected,
  EVENTING_ERASURE_TARGET_NAME,
} from "./eventing-erasure-target.js";
import {
  buildEventingTestContext,
  TEST_PRINCIPAL,
  testEnvironmentScope,
  type EventingTestContext,
} from "./testing/index.js";

const OTHER_PRINCIPAL = asIdentifier<PrincipalId>("user-2");

async function seed(context: EventingTestContext, name: string, createdBy = TEST_PRINCIPAL): Promise<void> {
  const registered = await registerNotificationRule(context.dependencies, {
    scope: testEnvironmentScope(),
    name,
    filters: { eventTypes: ["run.*"] },
    delivery: { type: "webhook", url: "https://example.test/hook" },
    createdBy,
  });
  if (!registered.ok) throw new Error(registered.error.code);
}

function subject(kind: ErasureSubject["subjectKind"], id: string): ErasureSubject {
  return { subjectKind: kind, subjectId: id, scope: testEnvironmentScope() };
}

describe("eventing ErasureTarget", () => {
  let context: EventingTestContext;

  beforeEach(() => {
    context = buildEventingTestContext();
  });

  it("names itself, so a plan records who is acting", () => {
    expect(createEventingErasureTarget(context.dependencies).targetName).toBe(EVENTING_ERASURE_TARGET_NAME);
  });

  // The heart of the legacy-row decision: one model, not the three ADR §1
  // row 17 lists.
  it("plans exactly ONE model — NotificationRule and nothing else", async () => {
    await seed(context, "failures");
    const plan = await createEventingErasureTarget(context.dependencies).plan(subject("user", TEST_PRINCIPAL));

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.model).toBe("NotificationRule");
    expect(plan.items.map((item) => item.model)).not.toContain("PlatformNotification");
    expect(plan.items.map((item) => item.model)).not.toContain("PlatformNotificationInteraction");
  });

  // `anonymize`, not `delete`: destroying the row would disable an
  // environment's alerting because an administrator exercised a data right.
  it("plans ANONYMIZE, not delete", async () => {
    await seed(context, "failures");
    const plan = await createEventingErasureTarget(context.dependencies).plan(subject("user", TEST_PRINCIPAL));
    expect(plan.items[0]?.method).toBe("anonymize");
  });

  it("counts only the subject's own rules", async () => {
    await seed(context, "mine", TEST_PRINCIPAL);
    await seed(context, "theirs", OTHER_PRINCIPAL);
    const plan = await createEventingErasureTarget(context.dependencies).plan(subject("user", TEST_PRINCIPAL));
    expect(plan.items[0]?.rowCount).toBe(1);
  });

  it("leaves blockedBy null — privacy adjudicates holds, not this context", async () => {
    await seed(context, "failures");
    const plan = await createEventingErasureTarget(context.dependencies).plan(subject("user", TEST_PRINCIPAL));
    expect(plan.items[0]?.blockedBy).toBeNull();
  });

  it("plans zero rows for a subject kind that cannot own a rule", async () => {
    await seed(context, "failures");
    const target = createEventingErasureTarget(context.dependencies);
    for (const kind of ["end-user", "entity"] as const) {
      const plan = await target.plan(subject(kind, TEST_PRINCIPAL));
      expect(plan.items[0]?.rowCount).toBe(0);
    }
  });

  it("does not mutate while planning", async () => {
    await seed(context, "failures");
    await createEventingErasureTarget(context.dependencies).plan(subject("user", TEST_PRINCIPAL));
    expect(context.repository.allRules()[0]?.createdBy).toBe(TEST_PRINCIPAL);
  });

  it("scrubs createdBy and KEEPS the rule, so alerting survives the erasure", async () => {
    await seed(context, "failures");
    const target = createEventingErasureTarget(context.dependencies);
    const plan = await target.plan(subject("user", TEST_PRINCIPAL));

    const receipt = await context.unitOfWork.run((transaction) => target.erase(plan, transaction));

    expect(receipt.items[0]).toEqual({
      model: "NotificationRule",
      method: "anonymize",
      rowCount: 1,
      blockedBy: null,
    });
    const [survivor] = context.repository.allRules();
    expect(survivor).toBeDefined();
    expect(survivor?.createdBy).toBe(ERASED_PRINCIPAL);
    expect(survivor?.name).toBe("failures");
    expect(survivor?.enabled).toBe(true);
  });

  it("leaves another principal's rules untouched", async () => {
    await seed(context, "mine", TEST_PRINCIPAL);
    await seed(context, "theirs", OTHER_PRINCIPAL);
    const target = createEventingErasureTarget(context.dependencies);
    const plan = await target.plan(subject("user", TEST_PRINCIPAL));
    await context.unitOfWork.run((transaction) => target.erase(plan, transaction));

    const theirs = context.repository.allRules().find((rule) => rule.name === "theirs");
    expect(theirs?.createdBy).toBe(OTHER_PRINCIPAL);
  });

  it("reaches rules below an ORGANIZATION-scoped erasure by containment", async () => {
    await seed(context, "failures");
    const target = createEventingErasureTarget(context.dependencies);
    const plan = await target.plan({
      subjectKind: "user",
      subjectId: TEST_PRINCIPAL,
      scope: organizationScope(asIdentifier("org-1")),
    });
    expect(plan.items[0]?.rowCount).toBe(1);
  });

  // A plan this target did not mint carries no subject, so acting on it would
  // mean guessing whose rows to scrub.
  it("REFUSES a foreign plan rather than guessing a subject", async () => {
    const target = createEventingErasureTarget(context.dependencies);
    await expect(
      context.unitOfWork.run((transaction) =>
        target.erase({ targetName: "files", items: [] }, transaction),
      ),
    ).rejects.toBeInstanceOf(EventingErasureRejected);
  });

  it("rejects rather than issuing a receipt when the scrub fails", async () => {
    await seed(context, "failures");
    const target = createEventingErasureTarget(context.dependencies);
    const plan = await target.plan(subject("user", TEST_PRINCIPAL));
    context.repository.failNext("connection reset");

    await expect(
      context.unitOfWork.run((transaction) => target.erase(plan, transaction)),
    ).rejects.toBeInstanceOf(EventingErasureRejected);
  });

  it("issues an honest empty receipt for a vacuous plan", async () => {
    const target = createEventingErasureTarget(context.dependencies);
    const plan = await target.plan(subject("entity", "entity-1"));
    const receipt = await context.unitOfWork.run((transaction) => target.erase(plan, transaction));
    expect(receipt.targetName).toBe(EVENTING_ERASURE_TARGET_NAME);
    expect(receipt.items[0]?.rowCount).toBe(0);
  });
});
