import {
  asIdentifier,
  environmentScope,
  type ErasurePlan,
  type ErasureSubject,
  type PrincipalId,
  type TransactionId,
  type TransactionScope,
} from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import { ADMIN_AUDIT_MODEL, PROJECTION_TABLES, type ProjectionTable } from "../domain/index.js";
import {
  createObservabilityErasureTarget,
  isObservabilityErasurePlan,
  ObservabilityErasureRejected,
  OBSERVABILITY_ERASURE_TARGET_NAME,
} from "./observability-erasure-target.js";
import { recordAdminActionBestEffort } from "./record-admin-action.js";
import {
  buildObservabilityTestContext,
  testScope,
  type ObservabilityTestContext,
} from "./testing/index.js";

function subject(overrides: Partial<ErasureSubject> = {}): ErasureSubject {
  return {
    subjectKind: "end-user",
    subjectId: "end-user-1",
    scope: environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1")),
    ...overrides,
  };
}

function seedSubjectRows(context: ObservabilityTestContext, endUserId = "end-user-1"): void {
  for (const table of PROJECTION_TABLES) {
    context.sink.seed(table as ProjectionTable, [
      {
        organization_id: "org-1",
        thread_id: "thread-1",
        end_user_id: endUserId,
        subject_key_hash: "hash-1",
        user_display_name: table === "turns_v1" ? "Ada" : null,
        user_email: table === "turns_v1" ? "ada@example.test" : null,
      },
    ]);
  }
}

async function rejection(work: () => Promise<unknown>): Promise<ObservabilityErasureRejected> {
  try {
    await work();
  } catch (thrown) {
    if (thrown instanceof ObservabilityErasureRejected) return thrown;
    throw thrown;
  }
  throw new Error("expected the erasure to be rejected");
}

describe("plan", () => {
  let context: ObservabilityTestContext;

  beforeEach(() => {
    context = buildObservabilityTestContext();
  });

  it("reports every model this context is sole writer of", async () => {
    const target = createObservabilityErasureTarget(context.dependencies);
    const plan = await target.plan(subject());
    expect(plan.items.map((item) => item.model)).toEqual([...PROJECTION_TABLES, ADMIN_AUDIT_MODEL]);
    expect(plan.targetName).toBe(OBSERVABILITY_ERASURE_TARGET_NAME);
  });

  it("counts the subject's rows before anything is destroyed", async () => {
    seedSubjectRows(context);
    const target = createObservabilityErasureTarget(context.dependencies);
    const plan = await target.plan(subject());
    for (const item of plan.items.filter((entry) => entry.model !== ADMIN_AUDIT_MODEL)) {
      expect(item.rowCount).toBe(1);
    }
    expect(context.sink.callsTo("clearSubjectColumns")).toHaveLength(0);
  });

  it("UNLINKS rather than deletes, on every model", async () => {
    const target = createObservabilityErasureTarget(context.dependencies);
    const plan = await target.plan(subject());
    expect(plan.items.every((item) => item.method === "anonymize")).toBe(true);
  });

  it("leaves the hold decision to privacy rather than adjudicating it here", async () => {
    const target = createObservabilityErasureTarget(context.dependencies);
    const plan = await target.plan(subject());
    expect(plan.items.every((item) => item.blockedBy === null)).toBe(true);
  });

  it("reports a zero-row plan for a subject it cannot address, rather than vanishing", async () => {
    seedSubjectRows(context);
    const target = createObservabilityErasureTarget(context.dependencies);
    const plan = await target.plan(subject({ subjectKind: "entity", subjectId: "entity-1" }));
    expect(plan.items).toHaveLength(PROJECTION_TABLES.length + 1);
    expect(plan.items.every((item) => item.rowCount === 0)).toBe(true);
    expect(context.sink.callsTo("countSubjectRows")).toHaveLength(0);
  });

  it("counts an operator's audit rows and no analytical rows", async () => {
    await recordAdminActionBestEffort(context.dependencies, {
      scope: testScope(),
      actorUserId: asIdentifier<PrincipalId>("user-1"),
      action: "agent.delete",
      subjectType: "Agent",
    });
    const target = createObservabilityErasureTarget(context.dependencies);
    const plan = await target.plan(subject({ subjectKind: "user", subjectId: "user-1" }));
    expect(plan.items.find((item) => item.model === ADMIN_AUDIT_MODEL)?.rowCount).toBe(1);
  });

  it("carries the subject and its address, so a plan handed back can be acted on", async () => {
    context.subjectLocators.setLocators("end-user-1", { threadIds: ["thread-1"] });
    const target = createObservabilityErasureTarget(context.dependencies);
    const plan = await target.plan(subject());
    expect(isObservabilityErasurePlan(plan)).toBe(true);
    if (!isObservabilityErasurePlan(plan)) throw new Error("unreachable");
    expect(plan.address.threadIds).toEqual(["thread-1"]);
  });

  it("resolves the supplementary locators PER SUBJECT, never once for everyone", async () => {
    context.subjectLocators.setLocators("end-user-1", { threadIds: ["thread-a"] });
    context.subjectLocators.setLocators("end-user-2", { threadIds: ["thread-b"] });
    const target = createObservabilityErasureTarget(context.dependencies);

    const first = await target.plan(subject({ subjectId: "end-user-1" }));
    const second = await target.plan(subject({ subjectId: "end-user-2" }));
    if (!isObservabilityErasurePlan(first) || !isObservabilityErasurePlan(second)) {
      throw new Error("unreachable");
    }
    // One person's plan must never enumerate another person's threads.
    expect(first.address.threadIds).toEqual(["thread-a"]);
    expect(second.address.threadIds).toEqual(["thread-b"]);
    expect(context.subjectLocators.asked.map((asked) => asked.subjectId)).toEqual([
      "end-user-1",
      "end-user-2",
    ]);
  });

  it("adds the salted subject key as a locator when the source has one", async () => {
    context.subjectLocators.setLocators("end-user-1", { subjectKeyHashes: ["hash-1"] });
    const target = createObservabilityErasureTarget(context.dependencies);
    const plan = await target.plan(subject());
    if (!isObservabilityErasurePlan(plan)) throw new Error("unreachable");
    expect(plan.address.subjectKeyHashes).toEqual(["hash-1"]);
  });

  it("REJECTS rather than narrowing the plan when the locator source refuses", async () => {
    context.subjectLocators.lookupFails = true;
    const target = createObservabilityErasureTarget(context.dependencies);
    const rejected = await rejection(() => target.plan(subject()));
    expect(rejected.domainError.code).toBe("OBSERVABILITY_REPOSITORY_UNAVAILABLE");
  });

  it("rejects rather than reporting zero when the store cannot be counted", async () => {
    context.sink.countFails = true;
    const target = createObservabilityErasureTarget(context.dependencies);
    const rejected = await rejection(() => target.plan(subject()));
    expect(rejected.domainError.code).toBe("OBSERVABILITY_SINK_UNREACHABLE");
  });
});

describe("erase", () => {
  let context: ObservabilityTestContext;
  const transaction: TransactionScope = { transactionId: asIdentifier<TransactionId>("txn-1") };

  beforeEach(() => {
    context = buildObservabilityTestContext();
  });

  it("clears the identity columns and keeps the row", async () => {
    seedSubjectRows(context);
    const target = createObservabilityErasureTarget(context.dependencies);
    const plan = await target.plan(subject());

    const receipt = await target.erase(plan, transaction);
    expect(receipt.targetName).toBe(OBSERVABILITY_ERASURE_TARGET_NAME);
    for (const table of PROJECTION_TABLES) {
      expect(context.sink.rows(table as ProjectionTable)).toHaveLength(1);
      expect(context.sink.rows(table as ProjectionTable)[0]?.end_user_id).toBe("");
    }
  });

  it("RETAINS the pseudonymous key so aggregates stay continuous", async () => {
    seedSubjectRows(context);
    const target = createObservabilityErasureTarget(context.dependencies);
    await target.erase(await target.plan(subject()), transaction);
    expect(context.sink.rows("turns_v1")[0]?.subject_key_hash).toBe("hash-1");
  });

  it("clears the two plaintext columns to NULL, not to an empty string", async () => {
    seedSubjectRows(context);
    const target = createObservabilityErasureTarget(context.dependencies);
    await target.erase(await target.plan(subject()), transaction);
    expect(context.sink.rows("turns_v1")[0]?.user_display_name).toBeNull();
    expect(context.sink.rows("turns_v1")[0]?.user_email).toBeNull();
  });

  it("keeps the usage row and its money", async () => {
    context.sink.seed("usage_events_v1", [
      {
        organization_id: "org-1",
        end_user_id: "end-user-1",
        subject_key_hash: "hash-1",
        thread_id: "thread-1",
        calculated_cost_usd: "1.250000000000",
      },
    ]);
    const target = createObservabilityErasureTarget(context.dependencies);
    await target.erase(await target.plan(subject()), transaction);
    const row = context.sink.rows("usage_events_v1")[0];
    expect(row?.calculated_cost_usd).toBe("1.250000000000");
    expect(row?.end_user_id).toBe("");
  });

  it("leaves another subject's rows untouched", async () => {
    seedSubjectRows(context, "end-user-1");
    context.sink.seed("turns_v1", [
      { organization_id: "org-1", end_user_id: "end-user-2", subject_key_hash: "hash-2", thread_id: "t2" },
    ]);
    const target = createObservabilityErasureTarget(context.dependencies);
    await target.erase(await target.plan(subject()), transaction);
    expect(context.sink.rows("turns_v1").map((row) => row.end_user_id)).toEqual(["", "end-user-2"]);
  });

  it("leaves another TENANT's identically-keyed rows untouched", async () => {
    seedSubjectRows(context);
    context.sink.seed("turns_v1", [
      { organization_id: "org-2", end_user_id: "end-user-1", subject_key_hash: "hash-1", thread_id: "t1" },
    ]);
    const target = createObservabilityErasureTarget(context.dependencies);
    await target.erase(await target.plan(subject()), transaction);
    const foreign = context.sink.rows("turns_v1").find((row) => row.organization_id === "org-2");
    expect(foreign?.end_user_id).toBe("end-user-1");
  });

  it("reports the number of rows that CARRIED identity, not the number left", async () => {
    seedSubjectRows(context);
    const target = createObservabilityErasureTarget(context.dependencies);
    const receipt = await target.erase(await target.plan(subject()), transaction);
    expect(receipt.items.find((item) => item.model === "turns_v1")?.rowCount).toBe(1);
  });

  it("REJECTS when the store did not confirm the change", async () => {
    seedSubjectRows(context);
    const target = createObservabilityErasureTarget(context.dependencies);
    const plan = await target.plan(subject());
    context.sink.clearUnconfirmed = true;

    const rejected = await rejection(() => target.erase(plan, transaction));
    expect(rejected.domainError.code).toBe("OBSERVABILITY_ERASURE_UNVERIFIED");
  });

  it("REJECTS when rows still carry identity after the change", async () => {
    seedSubjectRows(context);
    const target = createObservabilityErasureTarget(context.dependencies);
    const plan = await target.plan(subject());
    context.sink.clearIsANoOp = true;

    const rejected = await rejection(() => target.erase(plan, transaction));
    expect(rejected.domainError.code).toBe("OBSERVABILITY_ERASURE_RESIDUE");
  });

  it("REJECTS when the residue count cannot be read — unverified is not clean", async () => {
    seedSubjectRows(context);
    const target = createObservabilityErasureTarget(context.dependencies);
    const plan = await target.plan(subject());
    let counts = 0;
    const realCount = context.sink.countSubjectRows.bind(context.sink);
    context.sink.countSubjectRows = async (request) => {
      counts += 1;
      if (counts > 1) {
        context.sink.countFails = true;
      }
      return realCount(request);
    };

    const rejected = await rejection(() => target.erase(plan, transaction));
    expect(rejected.domainError.code).toBe("OBSERVABILITY_ERASURE_UNVERIFIED");
  });

  it("REFUSES a plan it did not mint, rather than guessing whose rows to unlink", async () => {
    const target = createObservabilityErasureTarget(context.dependencies);
    const foreign: ErasurePlan = { targetName: "files", items: [] };
    const rejected = await rejection(() => target.erase(foreign, transaction));
    expect(rejected.domainError.code).toBe("OBSERVABILITY_ERASURE_PLAN_FOREIGN");
  });

  it("touches nothing for a subject it cannot address", async () => {
    seedSubjectRows(context);
    const target = createObservabilityErasureTarget(context.dependencies);
    const plan = await target.plan(subject({ subjectKind: "entity", subjectId: "entity-1" }));

    const receipt = await target.erase(plan, transaction);
    expect(receipt.items.every((item) => item.rowCount === 0)).toBe(true);
    expect(context.sink.callsTo("clearSubjectColumns")).toHaveLength(0);
    expect(context.sink.rows("turns_v1")[0]?.end_user_id).toBe("end-user-1");
  });

  it("unlinks an operator's audit rows inside the caller's transaction", async () => {
    await recordAdminActionBestEffort(context.dependencies, {
      scope: testScope(),
      actorUserId: asIdentifier<PrincipalId>("user-1"),
      action: "agent.delete",
      subjectType: "Agent",
      before: { name: "old" },
    });
    const target = createObservabilityErasureTarget(context.dependencies);
    const plan = await target.plan(subject({ subjectKind: "user", subjectId: "user-1" }));

    const receipt = await target.erase(plan, transaction);
    expect(receipt.items.find((item) => item.model === ADMIN_AUDIT_MODEL)?.rowCount).toBe(1);
    expect(context.repository.all()[0]?.actorUserId).toBeNull();
    // The action and its snapshot survive the actor: that is the accountability.
    expect(context.repository.all()[0]?.action).toBe("agent.delete");
    expect(context.repository.all()[0]?.before).toEqual({ name: "old" });
    expect(context.repository.transactions).toContain(transaction);
  });

  it("rejects rather than producing a receipt when the audit unlink fails", async () => {
    const target = createObservabilityErasureTarget(context.dependencies);
    const plan = await target.plan(subject({ subjectKind: "user", subjectId: "user-1" }));
    context.repository.writeFails = true;

    const rejected = await rejection(() => target.erase(plan, transaction));
    expect(rejected.domainError.code).toBe("OBSERVABILITY_REPOSITORY_UNAVAILABLE");
  });
});
