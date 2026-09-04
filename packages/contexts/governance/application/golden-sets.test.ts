// Golden-set authoring: the five CRUD paths and the four guards on them.
//
// Every ceiling here is exercised against a SMALL, EXPLICIT policy and an input
// written as a literal, never derived from the constant under test — a cap test
// whose input is `maxThreads + 1` stays green when the cap moves, which is the
// same as not testing it.

import { describe, expect, it } from "vitest";
import { asIdentifier } from "@platos/kernel";

import type { ActorId, EvalCriterionId, GoldenSetId, ThreadId } from "../domain/index.js";
import {
  createGoldenSet,
  describeGoldenSet,
  pageGoldenSets,
  removeGoldenSet,
  updateGoldenSet,
} from "./golden-sets.js";
import {
  AGENT_ID,
  buildGovernanceTestContext,
  otherEnvironmentScope,
  THREAD_ID,
  withPolicy,
  type GovernanceTestContext,
} from "./testing/index.js";

const CRITERION_A = asIdentifier<EvalCriterionId>("criterion-a");
const CRITERION_B = asIdentifier<EvalCriterionId>("criterion-b");
const OPERATOR = asIdentifier<ActorId>("operator-1");

function threads(count: number): readonly ThreadId[] {
  return Array.from({ length: count }, (_, index) => asIdentifier<ThreadId>(`thread-${index + 1}`));
}

function criteria(count: number): readonly EvalCriterionId[] {
  return Array.from({ length: count }, (_, index) => asIdentifier<EvalCriterionId>(`criterion-${index + 1}`));
}

async function create(
  context: GovernanceTestContext,
  overrides: Record<string, unknown> = {},
  authorization: unknown = context.authorization,
) {
  return createGoldenSet(context.dependencies, {
    authorization,
    createdBy: OPERATOR,
    set: {
      agentId: AGENT_ID,
      name: "regression",
      threadIds: [THREAD_ID],
      criterionIds: [CRITERION_A],
      ...overrides,
    },
  });
}

describe("createGoldenSet", () => {
  it("stores the set in the GRANTED environment and answers the stored row", async () => {
    const context = buildGovernanceTestContext();
    const created = await create(context);
    expect(created.ok && created.value.environmentId).toBe("env-1");
    expect(created.ok && created.value.name).toBe("regression");
    expect(created.ok && created.value.createdBy).toBe(OPERATOR);
    expect(context.goldenSets.size()).toBe(1);
  });

  it("REFUSES an unminted grant and WRITES NOTHING", async () => {
    const context = buildGovernanceTestContext();
    const created = await create(context, {}, { principalType: "operator", scope: context.scope });
    expect(created.ok).toBe(false);
    expect(context.goldenSets.size()).toBe(0);
    // Refused before the agent was even looked up.
    expect(context.agents.describeCalls).toEqual([]);
  });

  it("REFUSES an agent that is not visible in this environment, with its OWN code", async () => {
    const context = buildGovernanceTestContext();
    const created = await create(context, { agentId: asIdentifier("agent-elsewhere") });
    expect(!created.ok && created.error.code).toBe("GOVERNANCE_AGENT_NOT_VISIBLE");
    expect(context.goldenSets.size()).toBe(0);
  });

  it("distinguishes an invisible AGENT from a missing SET — two codes, two mistakes", async () => {
    const context = buildGovernanceTestContext();
    const noAgent = await create(context, { agentId: asIdentifier("agent-elsewhere") });
    const noSet = await describeGoldenSet(context.dependencies, {
      authorization: context.authorization,
      goldenSetId: asIdentifier<GoldenSetId>("golden-9999"),
    });
    expect(!noAgent.ok && noAgent.error.code).toBe("GOVERNANCE_AGENT_NOT_VISIBLE");
    expect(!noSet.ok && noSet.error.code).toBe("GOVERNANCE_GOLDEN_SET_NOT_FOUND");
  });

  it("REFUSES a second set with the same name for the same agent", async () => {
    const context = buildGovernanceTestContext();
    await create(context);
    const again = await create(context);
    expect(!again.ok && again.error.code).toBe("GOVERNANCE_GOLDEN_SET_ALREADY_EXISTS");
    expect(context.goldenSets.size()).toBe(1);
  });

  it("refuses the duplicate BEFORE opening a transaction", async () => {
    // The double enforces `@@unique([environmentId, agentId, name])` as well, so
    // the refusal alone cannot tell the pre-check from the store. The number of
    // transactions opened can: with the pre-check the second call opens none.
    const context = buildGovernanceTestContext();
    await create(context);
    expect(context.unitOfWork.opened).toBe(1);
    const again = await create(context);
    expect(again.ok).toBe(false);
    expect(context.unitOfWork.opened).toBe(1);
  });

  it("is REFUSED BY THE STORE even if the pre-check is bypassed", async () => {
    // The pre-check is a better error message, not the guarantee: the store
    // holds the constraint, so a lost race still cannot write a duplicate.
    const context = buildGovernanceTestContext();
    await create(context);
    const direct = await context.dependencies.unitOfWork.run((transaction) =>
      context.goldenSets.create(
        context.scope,
        {
          agentId: AGENT_ID,
          name: "regression",
          description: null,
          threadIds: [THREAD_ID],
          criterionIds: [CRITERION_A],
          pairCount: 1,
        },
        OPERATOR,
        transaction,
      ),
    );
    expect(!direct.ok && direct.error.code).toBe("GOVERNANCE_GOLDEN_SET_ALREADY_EXISTS");
  });

  it("ALLOWS the same name under a DIFFERENT agent — the constraint is per agent", async () => {
    const context = buildGovernanceTestContext();
    context.agents.seed({
      agentId: "agent-2",
      name: "Billing",
      model: "anthropic:claude-sonnet-4-6",
      currentVersionId: "version-1",
      currentVersionNumber: 1,
    });
    await create(context);
    const second = await create(context, { agentId: asIdentifier("agent-2") });
    expect(second.ok).toBe(true);
    expect(context.goldenSets.size()).toBe(2);
  });

  it("REFUSES a set naming NO threads", async () => {
    const context = buildGovernanceTestContext();
    const created = await create(context, { threadIds: [] });
    expect(!created.ok && created.error.code).toBe("GOVERNANCE_GOLDEN_SET_INVALID");
    expect(context.goldenSets.size()).toBe(0);
  });

  it("REFUSES a set naming NO criteria", async () => {
    const context = buildGovernanceTestContext();
    const created = await create(context, { criterionIds: [] });
    expect(!created.ok && created.error.code).toBe("GOVERNANCE_GOLDEN_SET_INVALID");
  });

  it("REFUSES too many THREADS, at exactly one over a three-thread ceiling", async () => {
    const context = buildGovernanceTestContext({ policy: withPolicy({ goldenSets: { maxThreads: 3 } }) });
    const created = await create(context, { threadIds: threads(4) });
    expect(!created.ok && created.error.code).toBe("GOVERNANCE_GOLDEN_SET_TOO_MANY_THREADS");
    expect(context.goldenSets.size()).toBe(0);
  });

  it("ADMITS exactly the ceiling — three threads under a three-thread ceiling", async () => {
    const context = buildGovernanceTestContext({ policy: withPolicy({ goldenSets: { maxThreads: 3 } }) });
    const created = await create(context, { threadIds: threads(3) });
    expect(created.ok && created.value.threadIds).toHaveLength(3);
  });

  it("REFUSES too many CRITERIA with a code of its own", async () => {
    const context = buildGovernanceTestContext({ policy: withPolicy({ goldenSets: { maxCriteria: 2 } }) });
    const created = await create(context, { criterionIds: criteria(3) });
    expect(!created.ok && created.error.code).toBe("GOVERNANCE_GOLDEN_SET_TOO_MANY_CRITERIA");
  });

  it("REFUSES too many PAIRS when both lists are individually inside their ceilings", async () => {
    // 4 threads (ceiling 10) times 3 criteria (ceiling 10) is 12 pairs against a
    // ceiling of 10: neither list guard can catch this one.
    const context = buildGovernanceTestContext({
      policy: withPolicy({ goldenSets: { maxThreads: 10, maxCriteria: 10, maxPairs: 10 } }),
    });
    const created = await create(context, { threadIds: threads(4), criterionIds: criteria(3) });
    expect(!created.ok && created.error.code).toBe("GOVERNANCE_GOLDEN_SET_TOO_MANY_PAIRS");
    expect(context.goldenSets.size()).toBe(0);
  });

  it("DE-DUPLICATES thread ids rather than paying for the same thread twice", async () => {
    const context = buildGovernanceTestContext();
    const created = await create(context, { threadIds: [THREAD_ID, THREAD_ID, asIdentifier("thread-2")] });
    expect(created.ok && created.value.threadIds).toEqual([THREAD_ID, "thread-2"]);
  });

  it("REFUSES a blank name", async () => {
    const context = buildGovernanceTestContext();
    const created = await create(context, { name: "   " });
    expect(!created.ok && created.error.code).toBe("GOVERNANCE_GOLDEN_SET_INVALID");
  });

  it("REFUSES a name one character over a ten-character ceiling", async () => {
    const context = buildGovernanceTestContext({ policy: withPolicy({ goldenSets: { maxNameLength: 10 } }) });
    const created = await create(context, { name: "abcdefghijk" });
    expect(!created.ok && created.error.code).toBe("GOVERNANCE_GOLDEN_SET_INVALID");
  });

  it("reports a store failure rather than claiming a write", async () => {
    const context = buildGovernanceTestContext();
    context.goldenSets.failNext("store down");
    const created = await create(context);
    expect(!created.ok && created.error.code).toBe("GOVERNANCE_LEDGER_UNAVAILABLE");
  });

  it("writes inside a transaction", async () => {
    const context = buildGovernanceTestContext();
    await create(context);
    expect(context.unitOfWork.opened).toBe(1);
    expect(context.unitOfWork.lastOutcome).toBe("committed");
  });
});

describe("updateGoldenSet", () => {
  it("re-admits the MERGED set, so growing one list past the pair ceiling is refused", async () => {
    const context = buildGovernanceTestContext({
      policy: withPolicy({ goldenSets: { maxThreads: 10, maxCriteria: 10, maxPairs: 4 } }),
    });
    const created = await create(context, { threadIds: threads(2), criterionIds: [CRITERION_A, CRITERION_B] });
    expect(created.ok).toBe(true);
    const goldenSetId = created.ok ? created.value.goldenSetId : ("" as GoldenSetId);

    // The patch touches only the thread list; the ceiling it breaches is the
    // product of that list and the criteria the STORED set already had.
    const patched = await updateGoldenSet(context.dependencies, {
      authorization: context.authorization,
      goldenSetId,
      patch: { threadIds: threads(3) },
    });
    expect(!patched.ok && patched.error.code).toBe("GOVERNANCE_GOLDEN_SET_TOO_MANY_PAIRS");
    const stored = await describeGoldenSet(context.dependencies, {
      authorization: context.authorization,
      goldenSetId,
    });
    expect(stored.ok && stored.value.threadIds).toHaveLength(2);
  });

  it("REFUSES a set that is not in the granted environment", async () => {
    const context = buildGovernanceTestContext();
    const created = await create(context);
    const goldenSetId = created.ok ? created.value.goldenSetId : ("" as GoldenSetId);
    const patched = await updateGoldenSet(context.dependencies, {
      authorization: context.grantFor(otherEnvironmentScope()),
      goldenSetId,
      patch: { name: "stolen" },
    });
    expect(!patched.ok && patched.error.code).toBe("GOVERNANCE_GOLDEN_SET_NOT_FOUND");
  });

  it("REFUSES a rename onto a name the same agent already uses", async () => {
    const context = buildGovernanceTestContext();
    await create(context, { name: "nightly" });
    const second = await create(context, { name: "regression" });
    const goldenSetId = second.ok ? second.value.goldenSetId : ("" as GoldenSetId);
    const renamed = await updateGoldenSet(context.dependencies, {
      authorization: context.authorization,
      goldenSetId,
      patch: { name: "nightly" },
    });
    expect(!renamed.ok && renamed.error.code).toBe("GOVERNANCE_GOLDEN_SET_ALREADY_EXISTS");
  });

  it("ALLOWS a rename to the set's OWN current name", async () => {
    const context = buildGovernanceTestContext();
    const created = await create(context);
    const goldenSetId = created.ok ? created.value.goldenSetId : ("" as GoldenSetId);
    const renamed = await updateGoldenSet(context.dependencies, {
      authorization: context.authorization,
      goldenSetId,
      patch: { name: "regression" },
    });
    expect(renamed.ok && renamed.value.name).toBe("regression");
  });

  it("stamps `updatedAt` from the INJECTED clock", async () => {
    const context = buildGovernanceTestContext({ now: new Date("2026-03-01T12:00:00.000Z") });
    const created = await create(context);
    const goldenSetId = created.ok ? created.value.goldenSetId : ("" as GoldenSetId);
    context.clock.advanceMilliseconds(90_000);
    const renamed = await updateGoldenSet(context.dependencies, {
      authorization: context.authorization,
      goldenSetId,
      patch: { name: "nightly" },
    });
    expect(renamed.ok && renamed.value.updatedAt.toISOString()).toBe("2026-03-01T12:01:30.000Z");
  });
});

describe("removeGoldenSet", () => {
  it("removes only within the granted environment, and answers false elsewhere", async () => {
    const context = buildGovernanceTestContext();
    const created = await create(context);
    const goldenSetId = created.ok ? created.value.goldenSetId : ("" as GoldenSetId);

    const elsewhere = await removeGoldenSet(context.dependencies, {
      authorization: context.grantFor(otherEnvironmentScope()),
      goldenSetId,
    });
    // The whole Result, so a REFUSAL cannot masquerade as `ok(false)`.
    expect(elsewhere).toEqual({ ok: true, value: false });
    expect(context.goldenSets.size()).toBe(1);

    const here = await removeGoldenSet(context.dependencies, {
      authorization: context.authorization,
      goldenSetId,
    });
    expect(here).toEqual({ ok: true, value: true });
    expect(context.goldenSets.size()).toBe(0);
  });
});

describe("pageGoldenSets", () => {
  it("clamps an over-wide page to EXACTLY the ceiling", async () => {
    const context = buildGovernanceTestContext({ policy: withPolicy({ criteria: { maxPageSize: 2 } }) });
    for (const name of ["a", "b", "c", "d"]) await create(context, { name });
    const page = await pageGoldenSets(context.dependencies, {
      authorization: context.authorization,
      limit: 500,
    });
    expect(page.ok && page.value.items).toHaveLength(2);
    expect(page.ok && page.value.limit).toBe(2);
    expect(page.ok && page.value.total).toBe(4);
  });

  it("REFUSES a negative offset rather than serving page one", async () => {
    const context = buildGovernanceTestContext();
    const page = await pageGoldenSets(context.dependencies, {
      authorization: context.authorization,
      offset: -1,
    });
    expect(!page.ok && page.error.code).toBe("GOVERNANCE_PAGE_REQUEST_INVALID");
  });

  it("filters by agent, and does NOT leak another environment's sets", async () => {
    const context = buildGovernanceTestContext();
    context.agents.seed({
      agentId: "agent-2",
      name: "Billing",
      model: "anthropic:claude-sonnet-4-6",
      currentVersionId: "version-1",
      currentVersionNumber: 1,
    });
    await create(context);
    await create(context, { agentId: asIdentifier("agent-2"), name: "billing-set" });

    const filtered = await pageGoldenSets(context.dependencies, {
      authorization: context.authorization,
      agentId: AGENT_ID,
    });
    expect(filtered.ok && filtered.value.total).toBe(1);

    const elsewhere = await pageGoldenSets(context.dependencies, {
      authorization: context.grantFor(otherEnvironmentScope()),
    });
    expect(elsewhere.ok && elsewhere.value.total).toBe(0);
  });
});
