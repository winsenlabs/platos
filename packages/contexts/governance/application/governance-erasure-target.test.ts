// The erasure target, exercised THROUGH THE PUBLISHED BINDER.
//
// Every test here reaches the target with `createGovernanceContract(...).
// erasureTarget()` rather than by calling the factory. A binder that stopped
// publishing the method — the exact defect found in another context this month,
// where a context owning subject data shipped without a target and made a
// multi-context erasure silently incomplete — turns this whole file red rather
// than leaving it green against a factory nobody wires.

import { describe, expect, it } from "vitest";
import type { ErasurePlan, ErasureSubject, TransactionScope } from "@platos/kernel";
import { asIdentifier, environmentScope, organizationScope, projectScope } from "@platos/kernel";

import { createGovernanceContract } from "./governance-contract.js";
import {
  CRITERION_MODEL,
  EVAL_MODEL,
  GOLDEN_SET_MODEL,
  GOVERNANCE_ERASURE_TARGET_NAME,
  GovernanceErasureRejected,
  RATING_MODEL,
  SAFETY_EVENT_MODEL,
} from "./governance-erasure-target.js";
import { rateTurn } from "./rate-turn.js";
import { recordSafetyEvent } from "./record-safety-event.js";
import {
  buildGovernanceTestContext,
  END_USER_ID,
  otherEnvironmentScope,
  OTHER_END_USER_ID,
  TURN_ID,
  type GovernanceTestContext,
} from "./testing/index.js";

const TRANSACTION: TransactionScope = { transactionId: asIdentifier("txn-erasure") };
const PRINCIPAL = "operator-1";

/** The one way this suite obtains a target: through the published contract. */
function targetOf(context: GovernanceTestContext) {
  return createGovernanceContract(context.dependencies).erasureTarget();
}

function endUserSubject(
  subjectId: string = END_USER_ID,
  scope = { organizationId: "org-1", projectId: "proj-1", environmentId: "env-1" },
): ErasureSubject {
  return {
    subjectKind: "end-user",
    subjectId,
    scope: environmentScope(
      asIdentifier(scope.organizationId),
      asIdentifier(scope.projectId),
      asIdentifier(scope.environmentId),
    ),
  };
}

function operatorSubject(subjectId: string = PRINCIPAL): ErasureSubject {
  return {
    subjectKind: "user",
    subjectId,
    scope: environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1")),
  };
}

/** Cast one rating and append one safety event carrying the operator's subject. */
async function seedSubjectRows(context: GovernanceTestContext): Promise<void> {
  const rated = await rateTurn(context.dependencies, {
    authorization: context.authorization,
    actor: { kind: "end-user", endUserId: END_USER_ID },
    turnId: TURN_ID,
    rating: 1,
  });
  expect(rated.ok).toBe(true);
  const recorded = await recordSafetyEvent(context.dependencies, {
    authorization: context.authorization,
    event: { detector: "pii", action: "redact", severity: "medium", principalId: PRINCIPAL },
  });
  expect(recorded.ok).toBe(true);
}

function itemFor(plan: { readonly items: readonly { readonly model: string }[] }, model: string) {
  const found = plan.items.find((item) => item.model === model);
  expect(found, `${model} must be named on every plan`).toBeDefined();
  return found as { model: string; method: string; rowCount: number; blockedBy: string | null };
}

describe("the target is reachable through the published contract", () => {
  it("is published, and names this context", () => {
    const contract = createGovernanceContract(buildGovernanceTestContext().dependencies);
    expect(typeof contract.erasureTarget).toBe("function");
    expect(contract.erasureTarget().targetName).toBe(GOVERNANCE_ERASURE_TARGET_NAME);
    expect(contract.erasureTarget().targetName).toBe("governance");
  });

  it("hands back the SAME target every call, so two injections cannot double-count", () => {
    const contract = createGovernanceContract(buildGovernanceTestContext().dependencies);
    expect(contract.erasureTarget()).toBe(contract.erasureTarget());
  });
});

describe("plan", () => {
  it("names ALL FIVE owned models, so none is silently unconsidered", async () => {
    const context = buildGovernanceTestContext();
    const plan = await targetOf(context).plan(endUserSubject());
    expect(plan.items.map((item) => item.model).sort()).toEqual(
      [CRITERION_MODEL, EVAL_MODEL, GOLDEN_SET_MODEL, RATING_MODEL, SAFETY_EVENT_MODEL].sort(),
    );
  });

  it("counts the subject's ratings and gives them the DELETE method", async () => {
    const context = buildGovernanceTestContext();
    await seedSubjectRows(context);
    const plan = await targetOf(context).plan(endUserSubject());
    const rating = itemFor(plan, RATING_MODEL);
    expect(rating.method).toBe("delete");
    expect(rating.rowCount).toBe(1);
  });

  it("gives safety events the ANONYMIZE method, so a block cannot be erased away", async () => {
    const context = buildGovernanceTestContext();
    await seedSubjectRows(context);
    const plan = await targetOf(context).plan(operatorSubject());
    const safety = itemFor(plan, SAFETY_EVENT_MODEL);
    expect(safety.method).toBe("anonymize");
    expect(safety.rowCount).toBe(1);
  });

  it("reports the three cascaded or non-subject models at EXACTLY zero", async () => {
    const context = buildGovernanceTestContext();
    await seedSubjectRows(context);
    const plan = await targetOf(context).plan(endUserSubject());
    expect(itemFor(plan, EVAL_MODEL).rowCount).toBe(0);
    expect(itemFor(plan, CRITERION_MODEL).rowCount).toBe(0);
    expect(itemFor(plan, GOLDEN_SET_MODEL).rowCount).toBe(0);
  });

  it("does NOT mutate: the row counts are identical before and after planning", async () => {
    const context = buildGovernanceTestContext();
    await seedSubjectRows(context);
    const before = { ratings: context.ratings.size(), safety: context.safety.size() };
    await targetOf(context).plan(endUserSubject());
    expect({ ratings: context.ratings.size(), safety: context.safety.size() }).toEqual(before);
  });

  it("leaves every item unblocked — a legal hold is `privacy`'s to apply", async () => {
    const context = buildGovernanceTestContext();
    await seedSubjectRows(context);
    const plan = await targetOf(context).plan(endUserSubject());
    for (const item of plan.items) expect(item.blockedBy).toBeNull();
  });

  it("carries the subject, so a stateless target can act on the plan later", async () => {
    const context = buildGovernanceTestContext();
    const plan = (await targetOf(context).plan(endUserSubject())) as ErasurePlan & {
      subject: ErasureSubject;
    };
    expect(plan.subject.subjectId).toBe(END_USER_ID);
    expect(plan.subject.subjectKind).toBe("end-user");
  });
});

describe("which subject kind matches which model", () => {
  it("counts NO ratings for a `user` subject — ratings are keyed by EndUser.id", async () => {
    const context = buildGovernanceTestContext();
    await seedSubjectRows(context);
    // The operator's own id is deliberately the SAME string a rating could hold,
    // so this is testing the id-space rule rather than a missing seed.
    const plan = await targetOf(context).plan(operatorSubject(END_USER_ID));
    expect(itemFor(plan, RATING_MODEL).rowCount).toBe(0);
  });

  it("counts safety events for a `user` subject AND for an `end-user` subject", async () => {
    const context = buildGovernanceTestContext();
    await seedSubjectRows(context);
    const asOperator = await targetOf(context).plan(operatorSubject(PRINCIPAL));
    const asEndUser = await targetOf(context).plan(endUserSubject(PRINCIPAL));
    expect(itemFor(asOperator, SAFETY_EVENT_MODEL).rowCount).toBe(1);
    expect(itemFor(asEndUser, SAFETY_EVENT_MODEL).rowCount).toBe(1);
  });

  it("matches NEITHER model for an `entity` subject, and still names all five", async () => {
    const context = buildGovernanceTestContext();
    await seedSubjectRows(context);
    const plan = await targetOf(context).plan({
      subjectKind: "entity",
      subjectId: PRINCIPAL,
      scope: environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1")),
    });
    expect(plan.items).toHaveLength(5);
    for (const item of plan.items) expect(item.rowCount).toBe(0);
  });
});

describe("scope", () => {
  it("does NOT reach a rating stored in ANOTHER organization", async () => {
    const context = buildGovernanceTestContext();
    await seedSubjectRows(context);
    const elsewhere = otherEnvironmentScope();
    const plan = await targetOf(context).plan(
      endUserSubject(END_USER_ID, {
        organizationId: elsewhere.organizationId,
        projectId: elsewhere.projectId,
        environmentId: elsewhere.environmentId,
      }),
    );
    expect(itemFor(plan, RATING_MODEL).rowCount).toBe(0);
  });

  it("an ORGANIZATION-wide subject reaches a row stored in one of its environments", async () => {
    const context = buildGovernanceTestContext();
    await seedSubjectRows(context);
    const plan = await targetOf(context).plan({
      subjectKind: "end-user",
      subjectId: END_USER_ID,
      scope: organizationScope(asIdentifier("org-1")),
    });
    expect(itemFor(plan, RATING_MODEL).rowCount).toBe(1);
  });

  it("a PROJECT-wide subject in a different project reaches nothing", async () => {
    const context = buildGovernanceTestContext();
    await seedSubjectRows(context);
    const plan = await targetOf(context).plan({
      subjectKind: "end-user",
      subjectId: END_USER_ID,
      scope: projectScope(asIdentifier("org-1"), asIdentifier("proj-9")),
    });
    expect(itemFor(plan, RATING_MODEL).rowCount).toBe(0);
  });

  it("does NOT erase another end user's rating", async () => {
    const context = buildGovernanceTestContext();
    await seedSubjectRows(context);
    const target = targetOf(context);
    const plan = await target.plan(endUserSubject(OTHER_END_USER_ID));
    await target.erase(plan, TRANSACTION);
    expect(context.ratings.size()).toBe(1);
  });
});

describe("erase", () => {
  it("DESTROYS the rating and REWRITES the safety event, in one pass", async () => {
    const context = buildGovernanceTestContext();
    await seedSubjectRows(context);
    const target = targetOf(context);
    const receipt = await target.erase(await target.plan(endUserSubject()), TRANSACTION);

    expect(context.ratings.size()).toBe(0);
    expect(itemFor(receipt, RATING_MODEL).rowCount).toBe(1);
    // The safety row survives: an end-user subject does not match the operator
    // principal this event carries.
    expect(context.safety.size()).toBe(1);
  });

  it("keeps the safety event's OWN facts and drops only the identifying columns", async () => {
    const context = buildGovernanceTestContext();
    await seedSubjectRows(context);
    const target = targetOf(context);
    await target.erase(await target.plan(operatorSubject()), TRANSACTION);

    expect(context.safety.size()).toBe(1);
    const [row] = context.safety.all();
    expect(row.principalId).toBeNull();
    expect(row.detail).toBeNull();
    expect(row.metadata).toBeNull();
    expect(row.detector).toBe("pii");
    expect(row.action).toBe("redact");
    expect(row.severity).toBe("medium");
  });

  it("stamps the receipt from the INJECTED clock, not the wall clock", async () => {
    const context = buildGovernanceTestContext({ now: new Date("2026-05-05T00:00:00.000Z") });
    const target = targetOf(context);
    const receipt = await target.erase(await target.plan(endUserSubject()), TRANSACTION);
    expect(receipt.erasedAt.toISOString()).toBe("2026-05-05T00:00:00.000Z");
    expect(receipt.targetName).toBe("governance");
  });

  it("REFUSES a plan minted by another context and destroys nothing", async () => {
    const context = buildGovernanceTestContext();
    await seedSubjectRows(context);
    const foreign: ErasurePlan = { targetName: "memory", items: [] };
    await expect(targetOf(context).erase(foreign, TRANSACTION)).rejects.toBeInstanceOf(
      GovernanceErasureRejected,
    );
    expect(context.ratings.size()).toBe(1);
  });

  it("REFUSES a plan carrying this name but no subject rider", async () => {
    const context = buildGovernanceTestContext();
    await seedSubjectRows(context);
    const riderless: ErasurePlan = { targetName: GOVERNANCE_ERASURE_TARGET_NAME, items: [] };
    await expect(targetOf(context).erase(riderless, TRANSACTION)).rejects.toMatchObject({
      domainError: { code: "GOVERNANCE_ERASURE_PLAN_FOREIGN" },
    });
    expect(context.ratings.size()).toBe(1);
  });

  it("REJECTS rather than receipting when the ratings store fails mid-erasure", async () => {
    const context = buildGovernanceTestContext();
    await seedSubjectRows(context);
    const target = targetOf(context);
    const plan = await target.plan(endUserSubject());
    context.ratings.failNext("store gone");
    await expect(target.erase(plan, TRANSACTION)).rejects.toBeInstanceOf(GovernanceErasureRejected);
    expect(context.ratings.size()).toBe(1);
  });

  it("REJECTS rather than receipting when the safety ledger fails mid-erasure", async () => {
    const context = buildGovernanceTestContext();
    await seedSubjectRows(context);
    const target = targetOf(context);
    const plan = await target.plan(operatorSubject());
    context.safety.failNext("ledger gone");
    await expect(target.erase(plan, TRANSACTION)).rejects.toMatchObject({
      domainError: { code: "GOVERNANCE_LEDGER_UNAVAILABLE" },
    });
  });

  it("REJECTS a PLAN whose count could not be taken, rather than planning zero", async () => {
    const context = buildGovernanceTestContext();
    await seedSubjectRows(context);
    context.ratings.failNext("store gone");
    await expect(targetOf(context).plan(endUserSubject())).rejects.toBeInstanceOf(
      GovernanceErasureRejected,
    );
  });

  it("is idempotent: erasing twice destroys one row and receipts zero the second time", async () => {
    const context = buildGovernanceTestContext();
    await seedSubjectRows(context);
    const target = targetOf(context);
    const plan = await target.plan(endUserSubject());
    const first = await target.erase(plan, TRANSACTION);
    const second = await target.erase(plan, TRANSACTION);
    expect(itemFor(first, RATING_MODEL).rowCount).toBe(1);
    expect(itemFor(second, RATING_MODEL).rowCount).toBe(0);
    expect(context.ratings.size()).toBe(0);
  });
});
