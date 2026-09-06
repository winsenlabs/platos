// Every value the CANONICAL SCHEMA refuses and this context's in-memory doubles
// accept, standing beside the constraint it comes from.
//
// EACH CASE IS A PAIR. The double is asked first and ACCEPTS; the adapter is
// asked the same thing and REFUSES with a named code. A case that only showed
// the refusal would not establish that the double is the thing that is wrong,
// and "the double accepts what the database refuses" is the whole finding.
//
// AND EACH REFUSAL LEAVES THE CALLER'S TRANSACTION USABLE. On PostgreSQL a
// violated constraint aborts the whole transaction, so a store that let one
// raise would answer correctly and leave the caller unable to write anything
// else. Every guard here runs BEFORE a statement is sent, and the case at the
// end of the file proves it by writing a real row in the SAME unit of work a
// refusal just came out of.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  ActorId,
  AgentId,
  AgentVersionId,
  EndUserId,
  EnvironmentScope,
  EvalCriterionId,
  ThreadId,
  TransactionScope,
  TurnId,
} from "@platos/context-governance/application/ports/index.js";
import { asGovernanceIdentifier } from "@platos/context-governance/application/ports/index.js";
import {
  InMemoryEvalsRepository,
  InMemoryRatingsRepository,
  InMemorySafetyLedger,
} from "@platos/context-governance/application/testing/index.js";

import {
  CRITERION_SCALE_NOT_REPRESENTABLE,
  EVAL_COST_NOT_REPRESENTABLE,
  EVAL_LATENCY_INVALID,
  EVAL_SCORE_NOT_FINITE,
  GOVERNANCE_IDENTIFIER_NOT_UUID,
  RATING_NOT_THUMBS,
  RATING_REVISION_INVALID,
  SAFETY_METADATA_RESERVED,
} from "./governance-guards.js";
import {
  conformanceCriterion,
  conformanceEval,
  conformanceGoldenSet,
  conformanceSafetyEvent,
  governanceConformanceClock,
  type GovernanceConformanceIds,
} from "./governance-conformance.js";
import type { GovernanceHarness, PeerChain } from "./governance-harness.js";
import { startGovernanceHarness } from "./governance-harness.js";

let harness: GovernanceHarness;
let chain: PeerChain;
let scope: EnvironmentScope;
let ids: GovernanceConformanceIds;

const actor = asGovernanceIdentifier<ActorId>("operator-1");

beforeAll(async () => {
  harness = await startGovernanceHarness();
  scope = await harness.freshScope();
  chain = await harness.seedChain(scope);
  ids = {
    agentId: chain.agentId,
    agentVersionId: chain.agentVersionId,
    secondAgentVersionId: chain.secondAgentVersionId,
    endUserId: chain.endUserId,
    threadId: chain.threadId,
    turnId: chain.turnId,
    secondTurnId: chain.secondTurnId,
    absentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  };
}, 300_000);

afterAll(async () => {
  await harness?.stop();
});

/** The refusal reason a store returns, which leads with the distinct code. */
function reasonOf(result: { readonly ok: boolean }): string {
  if (result.ok) return "<accepted>";
  const { error } = result as unknown as {
    readonly error: { readonly details: Record<string, unknown> };
  };
  return String(error.details["reason"] ?? "");
}

describe("MessageRating_rating_check is the constraint the migration ENDS with", () => {
  test("the double stores a five-star `3`, and no database this migration builds can", async () => {
    // THE DOUBLE stores whatever the type lets through: `RatingValue` is
    // `1 | -1`, so `3` needs a cast to get past the compiler and nothing else to
    // get past the store.
    const fake = new InMemoryRatingsRepository(governanceConformanceClock());
    const stored = await fake.upsert(
      scope,
      {
        turnId: asGovernanceIdentifier<TurnId>(ids.turnId),
        agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
        agentVersionId: null,
        endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
        rating: 3 as unknown as 1,
        comment: null,
        revision: 1,
      },
      { transactionId: asGovernanceIdentifier("txn-1") } as TransactionScope,
    );
    expect(stored.ok && stored.value.rating).toBe(3);

    // THE SCHEMA. `00000000000000_initial` installs
    // `CHECK ("rating" BETWEEN 1 AND 5)` at line 2799 and then, at line 3802 in
    // the SAME FILE, DROPS it for `CHECK ("rating" IN (-1, 1))` behind a
    // preflight that refuses to build the database at all if any row holds 2..5.
    // Neither constraint is expressible in a Prisma attribute, so
    // `schema.prisma` shows neither and a reader who stopped at the first would
    // have got this backwards in both directions.
    const refused = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.ratings.upsert(
        scope,
        {
          turnId: asGovernanceIdentifier<TurnId>(ids.turnId),
          agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
          agentVersionId: null,
          endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
          rating: 3 as unknown as 1,
          comment: null,
          revision: 1,
        },
        transaction,
      ),
    );
    expect(refused.ok).toBe(false);
    expect(reasonOf(refused)).toContain(RATING_NOT_THUMBS);
  });

  test("and BOTH thumbs are stored, so the refusal is the VALUE and not the path", async () => {
    for (const rating of [1, -1] as const) {
      const accepted = await harness.base.adapter.unitOfWork.run((transaction) =>
        harness.stores.ratings.upsert(
          scope,
          {
            turnId: asGovernanceIdentifier<TurnId>(ids.turnId),
            agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
            agentVersionId: asGovernanceIdentifier<AgentVersionId>(ids.agentVersionId),
            endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
            rating,
            comment: null,
            revision: 1,
          },
          transaction,
        ),
      );
      expect(accepted.ok && accepted.value.rating).toBe(rating);
      await harness.base.adapter.unitOfWork.run((transaction) =>
        harness.stores.ratings.remove(
          scope,
          asGovernanceIdentifier<TurnId>(ids.turnId),
          asGovernanceIdentifier<EndUserId>(ids.endUserId),
          transaction,
        ),
      );
    }
  });

  test("a revision of zero is refused by its own code", async () => {
    const refused = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.ratings.upsert(
        scope,
        {
          turnId: asGovernanceIdentifier<TurnId>(ids.turnId),
          agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
          agentVersionId: null,
          endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
          rating: 1,
          comment: null,
          revision: 0,
        },
        transaction,
      ),
    );
    expect(reasonOf(refused)).toContain(RATING_REVISION_INVALID);
    // DISTINCT from the rating refusal above. Two guards over the same table
    // that shared a code could not be told apart in a log.
    expect(RATING_REVISION_INVALID).not.toBe(RATING_NOT_THUMBS);
  });
});

describe("@db.Uuid on every key, which the doubles mint around", () => {
  test("the safety double mints `safety-0001` and the column will not hold it", async () => {
    const fake = new InMemorySafetyLedger(governanceConformanceClock());
    const stored = await fake.append(scope, conformanceSafetyEvent(ids), null);
    expect(stored.ok && stored.value.safetyEventId).toBe("safety-0001");

    const refused = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.safety.append(
        scope,
        // `agent-1` is the shape `application/testing/fixtures.ts` mints.
        conformanceSafetyEvent(ids, { agentId: asGovernanceIdentifier<AgentId>("agent-1") }),
        transaction,
      ),
    );
    expect(reasonOf(refused)).toContain(GOVERNANCE_IDENTIFIER_NOT_UUID);
  });

  test("the evals double mints `eval-0001` and every foreign key is checked", async () => {
    const fake = new InMemoryEvalsRepository(governanceConformanceClock());
    const stored = await fake.append(
      scope,
      conformanceEval(ids, asGovernanceIdentifier<EvalCriterionId>("criterion-0001")),
      null,
    );
    expect(stored.ok && stored.value.agentEvalId).toBe("eval-0001");

    const refused = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.evals.append(
        scope,
        conformanceEval(ids, asGovernanceIdentifier<EvalCriterionId>("criterion-0001")),
        transaction,
      ),
    );
    expect(reasonOf(refused)).toContain(GOVERNANCE_IDENTIFIER_NOT_UUID);
  });

  test("and a golden set's agent is checked too", async () => {
    const refused = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.goldenSets.create(
        scope,
        conformanceGoldenSet(ids, { agentId: asGovernanceIdentifier<AgentId>("agent-1") }),
        actor,
        transaction,
      ),
    );
    expect(reasonOf(refused)).toContain(GOVERNANCE_IDENTIFIER_NOT_UUID);
  });
});

describe("the column types the doubles cannot see", () => {
  test("`AgentEval.score` is a double that would hold NaN, so NaN is refused", async () => {
    const criterion = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.criteria.create(
        scope,
        conformanceCriterion({ name: `scale-${Date.now()}` }),
        actor,
        transaction,
      ),
    );
    expect(criterion.ok).toBe(true);
    const criterionId = criterion.ok ? criterion.value.evalCriterionId : ids.absentId;

    const refused = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.evals.append(
        scope,
        conformanceEval(ids, asGovernanceIdentifier<EvalCriterionId>(criterionId), {
          score: Number.NaN,
        }),
        transaction,
      ),
    );
    expect(reasonOf(refused)).toContain(EVAL_SCORE_NOT_FINITE);

    // `Decimal(18, 6)` ROUNDS a longer fraction rather than refusing it, so a
    // cost written and read back would silently differ. Refused instead.
    const rounded = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.evals.append(
        scope,
        conformanceEval(ids, asGovernanceIdentifier<EvalCriterionId>(criterionId), {
          costCents: 0.0000005,
        }),
        transaction,
      ),
    );
    expect(reasonOf(rounded)).toContain(EVAL_COST_NOT_REPRESENTABLE);

    // `Int` is int4, and JavaScript hands the driver a number that may be 2^53.
    const overflowed = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.evals.append(
        scope,
        conformanceEval(ids, asGovernanceIdentifier<EvalCriterionId>(criterionId), {
          latencyMs: 2 ** 40,
        }),
        transaction,
      ),
    );
    expect(reasonOf(overflowed)).toContain(EVAL_LATENCY_INVALID);

    // Four refusals over ONE table, four codes. The set is asserted rather than
    // each pair, so a future guard that reused a sibling's code fails here.
    expect(
      new Set([
        EVAL_SCORE_NOT_FINITE,
        EVAL_COST_NOT_REPRESENTABLE,
        EVAL_LATENCY_INVALID,
        CRITERION_SCALE_NOT_REPRESENTABLE,
      ]).size,
    ).toBe(4);
  });

  test("a criterion scale outside int4 is refused before the statement", async () => {
    const refused = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.criteria.create(
        scope,
        conformanceCriterion({ name: `wide-${Date.now()}`, scoreScaleMax: 2 ** 40 }),
        actor,
        transaction,
      ),
    );
    expect(reasonOf(refused)).toContain(CRITERION_SCALE_NOT_REPRESENTABLE);
  });
});

describe("the safety metadata envelope is the adapter's, and a producer may not forge one", () => {
  test("a producer's metadata carrying the reserved marker is refused", async () => {
    const refused = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.safety.append(
        scope,
        conformanceSafetyEvent(ids, {
          principalId: "subject-x",
          metadata: { __governance: 1, principalId: "somebody-else" },
        }),
        transaction,
      ),
    );
    expect(reasonOf(refused)).toContain(SAFETY_METADATA_RESERVED);
  });

  test("a NESTED marker is a detector attribute and reads back unchanged", async () => {
    const written = await harness.base.adapter.unitOfWork.run((transaction) =>
      harness.stores.safety.append(
        scope,
        conformanceSafetyEvent(ids, {
          principalId: "subject-nested",
          metadata: { inner: { __governance: "not the marker" } },
        }),
        transaction,
      ),
    );
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    const read = await harness.stores.safety.findById(scope, written.value.safetyEventId);
    expect(read.ok && read.value?.metadata).toEqual({ inner: { __governance: "not the marker" } });
    expect(read.ok && read.value?.principalId).toBe("subject-nested");
  });
});

test("a refusal leaves the caller's transaction usable, which a raised CHECK would not", async () => {
  // THE PROPERTY THE WHOLE GUARD FILE EXISTS FOR. `rate-turn.ts` writes a rating
  // inside a unit of work that goes on to do more; if the refusal had come from
  // PostgreSQL rather than from TypeScript, this second write would fail with
  // 25P02 and the caller would have no way to tell a bad value from an outage.
  const name = `after-refusal-${Date.now()}`;
  const created = await harness.base.adapter.unitOfWork.run(async (transaction) => {
    const refused = await harness.stores.ratings.upsert(
      scope,
      {
        turnId: asGovernanceIdentifier<TurnId>(ids.turnId),
        agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
        agentVersionId: null,
        endUserId: asGovernanceIdentifier<EndUserId>(ids.endUserId),
        rating: 3 as unknown as 1,
        comment: null,
        revision: 1,
      },
      transaction,
    );
    expect(refused.ok).toBe(false);
    // THE SAME TRANSACTION, still open, still writable.
    return harness.stores.criteria.create(scope, conformanceCriterion({ name }), actor, transaction);
  });
  expect(created.ok).toBe(true);
  const found = await harness.stores.criteria.findByName(scope, name);
  expect(found.ok && found.value?.name).toBe(name);
});

test("a thread this environment does not own is refused by the DATABASE, not by a guard", async () => {
  // `enforce_domain_ancestry` fires BEFORE INSERT on `SafetyEvent` and resolves
  // `threadId` against the environment. It is the one refusal this adapter does
  // NOT pre-check — four joins it would have to duplicate, racily — so it
  // arrives as a driver error and is mapped to a `Result` rather than thrown.
  const foreign = await harness.foreignChain();
  const refused = await harness.base.adapter.unitOfWork.run((transaction) =>
    harness.stores.safety.append(
      scope,
      conformanceSafetyEvent(ids, {
        threadId: asGovernanceIdentifier<ThreadId>(foreign.threadId),
        turnId: asGovernanceIdentifier<TurnId>(foreign.turnId),
      }),
      transaction,
    ),
  );
  expect(refused.ok).toBe(false);
  expect(reasonOf(refused)).toContain("safety append");
});
