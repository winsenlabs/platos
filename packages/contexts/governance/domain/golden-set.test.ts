import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  admitGoldenSet,
  applyGoldenSetPatch,
  planPairs,
  type GoldenSet,
  type GoldenSetDraft,
} from "./golden-set.js";
import type { ActorId, AgentId, EvalCriterionId, GoldenSetId, ThreadId } from "./identifiers.js";

// Small, explicit ceilings. Nothing here is derived from the shipped policy, so
// changing a default cannot keep these green.
const POLICY = { maxNameLength: 10, maxThreads: 3, maxCriteria: 2, maxPairs: 4 } as const;

const AGENT = asIdentifier<AgentId>("agent-1");
const AT = new Date("2026-03-01T12:00:00.000Z");
const LATER = new Date("2026-03-02T12:00:00.000Z");

const threads = (...ids: string[]) => ids.map((id) => asIdentifier<ThreadId>(id));
const criteria = (...ids: string[]) => ids.map((id) => asIdentifier<EvalCriterionId>(id));

function draft(overrides: Partial<GoldenSetDraft> = {}): GoldenSetDraft {
  return {
    agentId: AGENT,
    name: "nightly",
    threadIds: threads("t1", "t2"),
    criterionIds: criteria("c1"),
    ...overrides,
  };
}

function stored(overrides: Partial<GoldenSet> = {}): GoldenSet {
  return {
    goldenSetId: asIdentifier<GoldenSetId>("golden-1"),
    environmentId: "env-1",
    agentId: AGENT,
    name: "nightly",
    description: null,
    threadIds: threads("t1", "t2"),
    criterionIds: criteria("c1"),
    createdBy: asIdentifier<ActorId>("operator-1"),
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

describe("the name ceiling", () => {
  it("REFUSES a name one character over a ten-character ceiling", () => {
    const admitted = admitGoldenSet(
      { agentId: AGENT, name: "abcdefghijk", threadIds: threads("thread-1"), criterionIds: criteria("criterion-1") },
      { ...POLICY, maxNameLength: 10 },
    );
    expect(!admitted.ok && admitted.error.code).toBe("GOVERNANCE_GOLDEN_SET_INVALID");
  });

  it("ADMITS a name of exactly the ceiling", () => {
    const admitted = admitGoldenSet(
      { agentId: AGENT, name: "abcdefghij", threadIds: threads("thread-1"), criterionIds: criteria("criterion-1") },
      { ...POLICY, maxNameLength: 10 },
    );
    expect(admitted.ok && admitted.value.name).toBe("abcdefghij");
  });
});

describe("admitGoldenSet", () => {
  it("admits a well-formed set and reports the judge calls a run will make", () => {
    const admitted = admitGoldenSet(draft(), POLICY);
    expect(admitted.ok && admitted.value.pairCount).toBe(2);
  });

  it("REFUSES a blank name", () => {
    const admitted = admitGoldenSet(draft({ name: "  " }), POLICY);
    expect(!admitted.ok && admitted.error.code).toBe("GOVERNANCE_GOLDEN_SET_INVALID");
    expect(!admitted.ok && admitted.error.fields[0]?.code).toBe("blank");
  });

  it("REFUSES an over-long name and admits one at exactly the ceiling", () => {
    expect(admitGoldenSet(draft({ name: "0123456789" }), POLICY).ok).toBe(true);
    const over = admitGoldenSet(draft({ name: "01234567890" }), POLICY);
    expect(!over.ok && over.error.fields[0]?.code).toBe("too_long");
  });

  it("REFUSES an empty thread list and an empty criterion list, by field", () => {
    const noThreads = admitGoldenSet(draft({ threadIds: [] }), POLICY);
    expect(!noThreads.ok && noThreads.error.fields[0]?.field).toBe("threadIds");
    const noCriteria = admitGoldenSet(draft({ criterionIds: [] }), POLICY);
    expect(!noCriteria.ok && noCriteria.error.fields[0]?.field).toBe("criterionIds");
  });

  it("DE-DUPLICATES threads, so one conversation is not paid for twice", () => {
    // The source stores the array it is handed, so a duplicate doubles that
    // conversation's weight in the regression mean as well as its cost.
    const admitted = admitGoldenSet(draft({ threadIds: threads("t1", "t1", "t2") }), POLICY);
    expect(admitted.ok && admitted.value.threadIds).toEqual(threads("t1", "t2"));
    expect(admitted.ok && admitted.value.pairCount).toBe(2);
  });

  it("de-duplicates criteria too, and preserves first-seen order", () => {
    const admitted = admitGoldenSet(
      draft({ threadIds: threads("t1"), criterionIds: criteria("c2", "c1", "c2") }),
      POLICY,
    );
    expect(admitted.ok && admitted.value.criterionIds).toEqual(criteria("c2", "c1"));
  });

  it("drops a blank id rather than planning a judge call against it", () => {
    const admitted = admitGoldenSet(draft({ threadIds: threads("t1", "  ") }), POLICY);
    expect(admitted.ok && admitted.value.threadIds).toEqual(threads("t1"));
  });

  it("becomes an EMPTY list once blanks are dropped, and is refused as empty", () => {
    const admitted = admitGoldenSet(draft({ threadIds: threads(" ", "") }), POLICY);
    expect(!admitted.ok && admitted.error.fields[0]?.field).toBe("threadIds");
  });

  it("REFUSES too many threads, with its OWN code", () => {
    const admitted = admitGoldenSet(
      draft({ threadIds: threads("t1", "t2", "t3", "t4"), criterionIds: criteria("c1") }),
      POLICY,
    );
    expect(!admitted.ok && admitted.error.code).toBe("GOVERNANCE_GOLDEN_SET_TOO_MANY_THREADS");
    expect(!admitted.ok && admitted.error.details).toEqual({ count: 4, maximum: 3 });
  });

  it("admits EXACTLY the thread ceiling", () => {
    const admitted = admitGoldenSet(
      draft({ threadIds: threads("t1", "t2", "t3"), criterionIds: criteria("c1") }),
      POLICY,
    );
    expect(admitted.ok).toBe(true);
  });

  it("REFUSES too many criteria, with a DIFFERENT code", () => {
    const admitted = admitGoldenSet(
      draft({ threadIds: threads("t1"), criterionIds: criteria("c1", "c2", "c3") }),
      POLICY,
    );
    expect(!admitted.ok && admitted.error.code).toBe("GOVERNANCE_GOLDEN_SET_TOO_MANY_CRITERIA");
  });

  it("REFUSES too many PAIRS when both lists are individually fine — a THIRD code", () => {
    // Three threads (at the ceiling) times two criteria (at the ceiling) is six
    // judge calls against a pair ceiling of four. Only this guard catches it.
    const admitted = admitGoldenSet(
      draft({ threadIds: threads("t1", "t2", "t3"), criterionIds: criteria("c1", "c2") }),
      POLICY,
    );
    expect(!admitted.ok && admitted.error.code).toBe("GOVERNANCE_GOLDEN_SET_TOO_MANY_PAIRS");
    expect(!admitted.ok && admitted.error.details).toEqual({ pairs: 6, maximum: 4 });
  });

  it("admits EXACTLY the pair ceiling", () => {
    const admitted = admitGoldenSet(
      draft({ threadIds: threads("t1", "t2"), criterionIds: criteria("c1", "c2") }),
      POLICY,
    );
    expect(admitted.ok && admitted.value.pairCount).toBe(4);
  });

  it("reports the list ceiling before the product that follows from it", () => {
    const admitted = admitGoldenSet(
      draft({ threadIds: threads("t1", "t2", "t3", "t4"), criterionIds: criteria("c1", "c2") }),
      POLICY,
    );
    expect(!admitted.ok && admitted.error.code).toBe("GOVERNANCE_GOLDEN_SET_TOO_MANY_THREADS");
  });

  it("normalises an empty description to null", () => {
    const admitted = admitGoldenSet(draft({ description: "   " }), POLICY);
    expect(admitted.ok && admitted.value.description).toBeNull();
  });
});

describe("applyGoldenSetPatch", () => {
  it("re-admits the WHOLE set, so growing one list is judged against every cap", () => {
    // The source patches each supplied field independently, so growing only the
    // thread list can carry a set past the pair ceiling with nothing to check it.
    const patched = applyGoldenSetPatch(
      stored({ criterionIds: criteria("c1", "c2") }),
      { threadIds: threads("t1", "t2", "t3") },
      POLICY,
      LATER,
    );
    expect(patched.ok).toBe(false);
    expect(!patched.ok && patched.error.code).toBe("GOVERNANCE_GOLDEN_SET_TOO_MANY_PAIRS");
  });

  it("admits a patch that stays inside every cap and stamps the instant", () => {
    const patched = applyGoldenSetPatch(stored(), { name: "weekly" }, POLICY, LATER);
    expect(patched.ok && patched.value.name).toBe("weekly");
    expect(patched.ok && patched.value.updatedAt).toBe(LATER);
    expect(patched.ok && patched.value.createdAt).toBe(AT);
  });

  it("leaves an absent key alone", () => {
    const patched = applyGoldenSetPatch(stored(), {}, POLICY, LATER);
    expect(patched.ok && patched.value.threadIds).toEqual(threads("t1", "t2"));
  });

  it("de-duplicates on a patch as well as on a create", () => {
    const patched = applyGoldenSetPatch(stored(), { threadIds: threads("t1", "t1") }, POLICY, LATER);
    expect(patched.ok && patched.value.threadIds).toEqual(threads("t1"));
  });

  it("keeps the agent and the identity — a patch does not re-target a set", () => {
    const patched = applyGoldenSetPatch(stored(), { name: "weekly" }, POLICY, LATER);
    expect(patched.ok && patched.value.agentId).toBe(AGENT);
    expect(patched.ok && patched.value.goldenSetId).toBe("golden-1");
  });
});

describe("planPairs", () => {
  it("plans one call per (thread, criterion) pair, thread-major", () => {
    expect(planPairs({ threadIds: threads("t1", "t2"), criterionIds: criteria("c1", "c2") })).toEqual([
      { threadId: "t1", criterionId: "c1" },
      { threadId: "t1", criterionId: "c2" },
      { threadId: "t2", criterionId: "c1" },
      { threadId: "t2", criterionId: "c2" },
    ]);
  });

  it("plans exactly threads times criteria", () => {
    const pairs = planPairs({ threadIds: threads("t1", "t2", "t3"), criterionIds: criteria("c1", "c2") });
    expect(pairs).toHaveLength(6);
  });

  it("plans nothing when either list is empty", () => {
    expect(planPairs({ threadIds: [], criterionIds: criteria("c1") })).toEqual([]);
    expect(planPairs({ threadIds: threads("t1"), criterionIds: [] })).toEqual([]);
  });
});
