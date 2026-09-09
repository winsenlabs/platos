// WIN-303 — THE TAMPERED SCOPE TRIPLE, against a real PostgreSQL holding two
// tenants.
//
// WHAT WAS WRONG. A `governance` scope is a TRIPLE — organization, project,
// environment — and the five canonical stores narrowed every read and every
// write by the environment ALONE. So a caller presenting a LEGITIMATE
// environment beside SOMEBODY ELSE'S project or organization was served, in
// full, by all five: the two clauses that would have disagreed were never in the
// statement. `governance-rules.integration.test.ts` already seeds a second
// tenant and proves a COHERENT foreign scope reaches nothing — and it passes
// either way, because the environment clause alone is enough for that case. The
// forged triple is the case that separates them, and nothing measured it.
//
// WHY IT IS PROVED HERE AND NOT AGAINST A DOUBLE. The in-memory stores hold no
// tenant tree. `InMemorySafetyLedger` and its four siblings compare
// `resolvePath(scope)` against the one scope they were constructed with, so a
// forged ancestry and a real one are the same VALUE to them — a double asked
// whether an environment sits under a project can only answer whatever it was
// told. `tools-scope.ts` states the same limit about the same shape of guard.
// Every assertion below therefore runs against the container, and every one that
// claims a row did not move reads it back on a SECOND client the adapter's pool
// never touched.
//
// THE THREE FACTS ARE ASSERTED APART. `governance-scope.ts` refuses under one
// code per store and one reason per fact, and the reasons are what make the
// halves of the comparison separable:
//
//   `foreign_ancestry` with only the ORGANIZATION forged is the case that dies
//   if the organization half of the comparison is deleted — and NO other case
//   in this package notices, because every fixture seeds one whole chain, where
//   the right project is always under the right organization.
//
//   `foreign_ancestry` with only the PROJECT forged is the mirror.
//
//   `unknown_environment` is a leaf in no row at all, and
//   `unnarrowable_identifiers` is a scope no statement can even be sent for —
//   pinned at ZERO statements, because a malformed uuid reaching a `@db.Uuid`
//   column aborts the caller's whole transaction.
//
// Run by `pnpm test:postgres-tenancy:integration`. FAILS when Docker is absent.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  ActorId,
  AgentId,
  AgentVersionId,
  EndUserId,
  EnvironmentScope,
  EvalCriterionId,
  GoldenSetId,
  SafetyEventId,
  TurnId,
} from "@platos/context-governance/application/ports/index.js";
import {
  asGovernanceIdentifier,
  asIdentifier,
  environmentScope,
  runResult,
} from "@platos/context-governance/application/ports/index.js";

import type { TenancyDatabaseClient } from "./client.js";
import {
  conformanceCriterion,
  conformanceGoldenSet,
  conformanceSafetyEvent,
  type GovernanceConformanceIds,
} from "./governance-conformance.js";
import type { GovernanceHarness, PeerChain } from "./governance-harness.js";
import { startGovernanceHarness } from "./governance-harness.js";

let harness: GovernanceHarness;
/** The tenant that owns every row asserted below. */
let mine: PeerChain;
/** A whole second tenant, whose organization and project are the forgery. */
let theirs: PeerChain;
let ids: GovernanceConformanceIds;
let observer: TenancyDatabaseClient;
let criterionId: EvalCriterionId;
let goldenSetId: GoldenSetId;

const actor = asGovernanceIdentifier<ActorId>("operator-1");
const SINCE = new Date("2026-01-01T00:00:00.000Z");
/** A uuid of the right shape naming no row anywhere. */
const ABSENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/**
 * The scope every case below is refused for: MY environment, THEIR ancestry.
 *
 * Not a typo and not a scope any legitimate grant can produce. It is what a
 * grant looks like when it has been tampered with, or assembled by a bug in
 * whatever resolved it, and it is precisely what the environment clause alone
 * cannot see.
 */
function tampered(): EnvironmentScope {
  return environmentScope(
    asIdentifier(theirs.scope.organizationId),
    asIdentifier(theirs.scope.projectId),
    asIdentifier(mine.scope.environmentId),
  );
}

/** MY environment and MY project, under THEIR organization. One clause wrong. */
function organizationForged(): EnvironmentScope {
  return environmentScope(
    asIdentifier(theirs.scope.organizationId),
    asIdentifier(mine.scope.projectId),
    asIdentifier(mine.scope.environmentId),
  );
}

/** MY environment and MY organization, under THEIR project. The other clause. */
function projectForged(): EnvironmentScope {
  return environmentScope(
    asIdentifier(mine.scope.organizationId),
    asIdentifier(theirs.scope.projectId),
    asIdentifier(mine.scope.environmentId),
  );
}

/** The code a store refused under, and the FACT its reason leads with. */
function refusal(result: unknown): { readonly code: string; readonly fact: string } {
  const outcome = result as {
    readonly ok: boolean;
    readonly error?: { readonly code?: string; readonly details?: Record<string, unknown> };
  };
  if (outcome.ok) return { code: "<accepted>", fact: "<accepted>" };
  const reason = String(outcome.error?.details?.["reason"] ?? "<no reason>");
  return { code: outcome.error?.code ?? "<no code>", fact: reason.split(":")[0] ?? reason };
}

beforeAll(async () => {
  harness = await startGovernanceHarness();
  mine = await harness.seedChain(await harness.freshScope());
  theirs = await harness.foreignChain();
  ids = {
    agentId: mine.agentId,
    agentVersionId: mine.agentVersionId,
    secondAgentVersionId: mine.secondAgentVersionId,
    endUserId: mine.endUserId,
    threadId: mine.threadId,
    turnId: mine.turnId,
    secondTurnId: mine.secondTurnId,
    absentId: ABSENT,
  };
  const created = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
    harness.stores.criteria.create(mine.scope, conformanceCriterion(), actor, transaction),
  );
  if (!created.ok) throw new Error("the fixture criterion was refused");
  criterionId = created.value.evalCriterionId;
  const set = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
    harness.stores.goldenSets.create(mine.scope, conformanceGoldenSet(ids), actor, transaction),
  );
  if (!set.ok) throw new Error("the fixture golden set was refused");
  goldenSetId = set.value.goldenSetId;
  await runResult(harness.base.adapter.unitOfWork, (transaction) =>
    harness.stores.ratings.upsert(
      mine.scope,
      {
        turnId: asGovernanceIdentifier<TurnId>(mine.turnId),
        agentId: asGovernanceIdentifier<AgentId>(mine.agentId),
        agentVersionId: asGovernanceIdentifier<AgentVersionId>(mine.agentVersionId),
        endUserId: asGovernanceIdentifier<EndUserId>(mine.endUserId),
        rating: 1,
        comment: "mine",
        revision: 1,
      },
      transaction,
    ),
  );
  await runResult(harness.base.adapter.unitOfWork, (transaction) =>
    harness.stores.safety.append(
      mine.scope,
      conformanceSafetyEvent(ids, { principalId: "subject-a" }),
      transaction,
    ),
  );
  const { PrismaClient } = await import("@platos/tenancy-database");
  observer = new PrismaClient({
    datasources: { db: { url: harness.base.databaseUrl } },
  }) as TenancyDatabaseClient;
}, 600_000);

afterAll(async () => {
  await observer?.$disconnect();
  await harness?.stop();
});

describe("a tampered triple is REFUSED by every one of the five stores", () => {
  // THE POSITIVE CONTROL IS IN EVERY CASE, and it is not decoration: a resolver
  // that refused unconditionally would satisfy every refusal assertion in this
  // file. Each case asks the SAME question twice — once with the honest scope,
  // once with the forged one — so a store that stopped answering at all fails
  // here as loudly as one that answers everybody.
  test("`SafetyLedger` reads its own environment and refuses the forged ancestry", async () => {
    const honest = await harness.stores.safety.page(mine.scope, {
      since: SINCE,
      limit: 10,
      offset: 0,
      detector: null,
      severity: null,
      agentId: null,
      threadId: null,
      search: null,
    });
    expect(honest.ok && honest.value.total).toBe(1);

    const forged = await harness.stores.safety.page(tampered(), {
      since: SINCE,
      limit: 10,
      offset: 0,
      detector: null,
      severity: null,
      agentId: null,
      threadId: null,
      search: null,
    });
    expect(refusal(forged)).toEqual({
      code: "GOVERNANCE_SAFETY_SCOPE_UNRESOLVED",
      fact: "foreign_ancestry",
    });

    // And the row itself is not reachable by id either, which is the read a
    // probe holding one identifier would actually make.
    const byId = await harness.stores.safety.findById(
      tampered(),
      asGovernanceIdentifier<SafetyEventId>(ABSENT),
    );
    expect(refusal(byId).code).toBe("GOVERNANCE_SAFETY_SCOPE_UNRESOLVED");
  });

  test("`RatingsRepository` refuses, and the forged upsert moves NO row", async () => {
    const honest = await harness.stores.ratings.findForTurn(
      mine.scope,
      asGovernanceIdentifier<TurnId>(mine.turnId),
      asGovernanceIdentifier<EndUserId>(mine.endUserId),
    );
    expect(honest.ok && honest.value?.comment).toBe("mine");

    const forged = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.stores.ratings.upsert(
        tampered(),
        {
          turnId: asGovernanceIdentifier<TurnId>(mine.turnId),
          agentId: asGovernanceIdentifier<AgentId>(mine.agentId),
          agentVersionId: asGovernanceIdentifier<AgentVersionId>(mine.agentVersionId),
          endUserId: asGovernanceIdentifier<EndUserId>(mine.endUserId),
          rating: -1,
          comment: "flipped by a forged grant",
          revision: 2,
        },
        transaction,
      ),
    );
    expect(refusal(forged)).toEqual({
      code: "GOVERNANCE_RATINGS_SCOPE_UNRESOLVED",
      fact: "foreign_ancestry",
    });
    // READ BACK ON THE SECOND CLIENT. A flip the writer alone cannot see is not
    // a flip that did not happen.
    const held = await observer.messageRating.findFirst({
      where: { turnId: mine.turnId, endUserId: mine.endUserId },
      select: { rating: true, comment: true, revision: true },
    });
    expect(held).toEqual({ rating: 1, comment: "mine", revision: 1 });
  });

  test("`CriteriaRepository` refuses, and the forged remove DELETES nothing", async () => {
    const honest = await harness.stores.criteria.findById(mine.scope, criterionId);
    expect(honest.ok && honest.value !== null).toBe(true);

    const forged = await harness.stores.criteria.findById(tampered(), criterionId);
    expect(refusal(forged)).toEqual({
      code: "GOVERNANCE_CRITERIA_SCOPE_UNRESOLVED",
      fact: "foreign_ancestry",
    });

    const removed = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.stores.criteria.remove(tampered(), criterionId, transaction),
    );
    expect(refusal(removed).code).toBe("GOVERNANCE_CRITERIA_SCOPE_UNRESOLVED");
    expect(await observer.evalCriterion.count({ where: { id: criterionId } })).toBe(1);
  });

  test("`EvalsRepository` refuses, and the forged append WRITES nothing", async () => {
    const before = await observer.agentEval.count({
      where: { environmentId: mine.scope.environmentId },
    });
    const honest = await harness.stores.evals.page(mine.scope, {
      since: SINCE,
      limit: 10,
      offset: 0,
      agentId: null,
      agentVersionId: null,
      criterionId: null,
      threadId: null,
      search: null,
    });
    expect(honest.ok).toBe(true);

    const forged = await harness.stores.evals.sample(tampered(), {
      agentId: asGovernanceIdentifier<AgentId>(mine.agentId),
      since: SINCE,
      versionIds: [],
    });
    expect(refusal(forged)).toEqual({
      code: "GOVERNANCE_EVALS_SCOPE_UNRESOLVED",
      fact: "foreign_ancestry",
    });
    expect(
      await observer.agentEval.count({ where: { environmentId: mine.scope.environmentId } }),
    ).toBe(before);
  });

  test("`GoldenSetsRepository` refuses, and the forged update MOVES nothing", async () => {
    const honest = await harness.stores.goldenSets.findById(mine.scope, goldenSetId);
    expect(honest.ok && honest.value !== null).toBe(true);
    if (!honest.ok || honest.value === null) return;
    const stored = honest.value;

    const forged = await runResult(harness.base.adapter.unitOfWork, (transaction) =>
      harness.stores.goldenSets.update(
        tampered(),
        { ...stored, name: "renamed by a forged grant" },
        transaction,
      ),
    );
    expect(refusal(forged)).toEqual({
      code: "GOVERNANCE_GOLDEN_SETS_SCOPE_UNRESOLVED",
      fact: "foreign_ancestry",
    });
    const held = await observer.goldenSet.findFirst({
      where: { id: goldenSetId },
      select: { name: true },
    });
    expect(held).toEqual({ name: stored.name });
  });
});

describe("each half of the ancestry comparison is refused on its own", () => {
  // THE TWO CASES THAT KILL THE TWO HALVES. Deleting `project."organizationId"`
  // from the resolver's comparison leaves the first of these green and only the
  // second red; deleting the project half does the reverse. Neither is visible
  // in any other suite in this package, because every fixture seeds ONE chain
  // where the right project is always under the right organization.
  test("only the ORGANIZATION forged is still `foreign_ancestry`", async () => {
    const answer = await harness.stores.criteria.findById(organizationForged(), criterionId);
    expect(refusal(answer)).toEqual({
      code: "GOVERNANCE_CRITERIA_SCOPE_UNRESOLVED",
      fact: "foreign_ancestry",
    });
  });

  test("only the PROJECT forged is `foreign_ancestry` too", async () => {
    const answer = await harness.stores.criteria.findById(projectForged(), criterionId);
    expect(refusal(answer)).toEqual({
      code: "GOVERNANCE_CRITERIA_SCOPE_UNRESOLVED",
      fact: "foreign_ancestry",
    });
  });

  test("an environment in no row at all is `unknown_environment`, not absence", async () => {
    const answer = await harness.stores.criteria.findById(
      environmentScope(
        asIdentifier(mine.scope.organizationId),
        asIdentifier(mine.scope.projectId),
        asIdentifier(ABSENT),
      ),
      criterionId,
    );
    expect(refusal(answer)).toEqual({
      code: "GOVERNANCE_CRITERIA_SCOPE_UNRESOLVED",
      fact: "unknown_environment",
    });
  });

  test("a scope that is not uuid-shaped is refused with ZERO statements sent", async () => {
    // The count is the assertion, not a detail of it. Every id here is bound to
    // a `@db.Uuid` column: a malformed one makes the driver refuse the whole
    // statement, and on PostgreSQL a refused statement ABORTS the enclosing
    // transaction — so a caller mid-unit-of-work would lose every later write.
    harness.base.resetStatements();
    const answer = await harness.stores.criteria.findById(
      environmentScope(
        asIdentifier(mine.scope.organizationId),
        asIdentifier(mine.scope.projectId),
        asIdentifier("not-a-uuid"),
      ),
      criterionId,
    );
    const sent = harness.base
      .statements()
      .filter(
        (statement) =>
          !/^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE)\b/iu.test(statement) &&
          !/^\s*SELECT\s+1\s*$/iu.test(statement),
      );
    expect({ ...refusal(answer), sent: sent.length }).toEqual({
      code: "GOVERNANCE_CRITERIA_SCOPE_UNRESOLVED",
      fact: "unnarrowable_identifiers",
      sent: 0,
    });
  });
});

describe("a TENANT scope is held to the ancestry it asserts, and to no more", () => {
  test("a PROJECT scope under a forged organization is refused, not counted", async () => {
    // `tenantWhere` narrows a project-level scope by the PROJECT alone, so this
    // is the same hole one level up: my project, their organization, and a
    // subject count that would otherwise have been served in full.
    const honest = await harness.stores.safety.countSubject({
      scope: { level: "project", organizationId: mine.scope.organizationId, projectId: mine.scope.projectId },
      principalId: "subject-a",
    });
    expect(honest.ok && honest.value).toBe(1);

    const forged = await harness.stores.safety.countSubject({
      scope: {
        level: "project",
        organizationId: theirs.scope.organizationId,
        projectId: mine.scope.projectId,
      },
      principalId: "subject-a",
    });
    expect(refusal(forged)).toEqual({
      code: "GOVERNANCE_SAFETY_SCOPE_UNRESOLVED",
      fact: "foreign_ancestry",
    });
  });

  test("an ORGANIZATION scope asserts no relation, so it is answered without one", async () => {
    // ONE identifier, no claim about the tree, nothing to contradict — and the
    // rows it reaches are already narrowed through `Environment` and `Project`
    // from that organization, so a forged one reaches none. A statement that
    // could only ever answer "yes" would be a cost with no refusal behind it,
    // and it would move the pin `governance-statements.integration.test.ts`
    // takes here to catch a widening read of the tenant tree.
    const answer = await harness.stores.safety.countSubject({
      scope: { level: "organization", organizationId: mine.scope.organizationId },
      principalId: "subject-a",
    });
    expect(answer.ok && answer.value).toBe(1);

    const foreign = await harness.stores.safety.countSubject({
      scope: { level: "organization", organizationId: theirs.scope.organizationId },
      principalId: "subject-a",
    });
    expect(foreign.ok && foreign.value).toBe(0);
  });
});
