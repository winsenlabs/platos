// The binder: is every declared capability actually wired to a use case?
//
// A contract method bound to nothing type-checks perfectly — the interface is
// satisfied by any function of the right shape, including one that was never
// written. So this suite drives EVERY method through the built contract and
// asserts an effect, and pins the two kernel ports the composition root collects
// by identity rather than by shape.

import { describe, expect, it } from "vitest";
import type { PrincipalId, SafetyObservation } from "@platos/kernel";
import { asIdentifier, environmentScope } from "@platos/kernel";

import {
  GOVERNANCE_EVENT_NAMES,
  type ActorId,
  type AgentEvalId,
  type EvalCriterionId,
  type GoldenSetId,
  type SafetyEventId,
} from "../domain/index.js";
import { createGovernanceContract } from "./governance-contract.js";
import {
  AGENT_ID,
  buildGovernanceTestContext,
  END_USER_ID,
  THREAD_ID,
  TURN_ID,
  aCriterionDraft,
  type GovernanceTestContext,
} from "./testing/index.js";

function build(context: GovernanceTestContext) {
  return createGovernanceContract(context.dependencies);
}

async function seedCriterion(context: GovernanceTestContext): Promise<EvalCriterionId> {
  const created = await build(context).createCriterion({
    authorization: context.authorization,
    createdBy: asIdentifier<ActorId>("operator-1"),
    criterion: aCriterionDraft(),
  });
  if (!created.ok) throw new Error(`criterion seed failed: ${created.error.code}`);
  return created.value.evalCriterionId;
}

async function seedGoldenSet(
  context: GovernanceTestContext,
  criterionId: EvalCriterionId,
): Promise<GoldenSetId> {
  const created = await build(context).createGoldenSet({
    authorization: context.authorization,
    createdBy: asIdentifier<ActorId>("operator-1"),
    set: { agentId: AGENT_ID, name: "regression", threadIds: [THREAD_ID], criterionIds: [criterionId] },
  });
  if (!created.ok) throw new Error(`golden set seed failed: ${created.error.code}`);
  return created.value.goldenSetId;
}

describe("the contract is the whole surface", () => {
  it("names itself and is frozen", () => {
    const contract = build(buildGovernanceTestContext());
    expect(contract.name).toBe("governance");
    expect(Object.isFrozen(contract)).toBe(true);
  });

  it("names every integration event under this context's own prefix, with no duplicates", () => {
    for (const name of GOVERNANCE_EVENT_NAMES) {
      expect(name.startsWith("governance.")).toBe(true);
      expect(name).toMatch(/^[a-z]+(?:\.[a-z_]+)+$/u);
    }
    expect(new Set(GOVERNANCE_EVENT_NAMES).size).toBe(GOVERNANCE_EVENT_NAMES.length);
    expect(GOVERNANCE_EVENT_NAMES).toHaveLength(11);
  });
});

describe("the two kernel ports", () => {
  it("hands back the SAME sink every call, so one binding is one object", () => {
    const contract = build(buildGovernanceTestContext());
    expect(contract.safetyEventSink()).toBe(contract.safetyEventSink());
  });

  it("hands back the SAME erasure target every call", () => {
    const contract = build(buildGovernanceTestContext());
    expect(contract.erasureTarget()).toBe(contract.erasureTarget());
  });

  it("the bound sink really appends — it is not an empty object of the right shape", async () => {
    const context = buildGovernanceTestContext();
    const observation: SafetyObservation = {
      rule: "identity.rate_limit.exceeded",
      outcome: "blocked",
      scope: environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1")),
      principalId: asIdentifier<PrincipalId>("operator-1"),
      observedAt: new Date("2026-03-01T12:00:00.000Z"),
      details: {},
    };
    await build(context).safetyEventSink().record(observation);
    expect(context.safety.size()).toBe(1);
  });

  it("the bound erasure target really counts — a plan sees rows the context holds", async () => {
    const context = buildGovernanceTestContext();
    const rated = await build(context).rateTurn({
      authorization: context.authorization,
      actor: { kind: "end-user", endUserId: END_USER_ID },
      turnId: TURN_ID,
      rating: 1,
    });
    expect(rated.ok).toBe(true);

    const plan = await build(context).erasureTarget().plan({
      subjectKind: "end-user",
      subjectId: END_USER_ID,
      scope: environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier("env-1")),
    });
    const rating = plan.items.find((item) => item.model === "MessageRating");
    expect(rating?.rowCount).toBe(1);
  });
});

describe("every declared method is bound to a use case", () => {
  it("binds the four safety-ledger methods", async () => {
    const context = buildGovernanceTestContext();
    const contract = build(context);
    const appended = await contract.recordSafetyEvent({
      authorization: context.authorization,
      event: { detector: "pii", action: "redact", severity: "medium" },
    });
    expect(appended.ok).toBe(true);
    const eventId = appended.ok ? appended.value.safetyEventId : ("" as SafetyEventId);

    const page = await contract.pageSafetyEvents({ authorization: context.authorization });
    expect(page.ok && page.value.total).toBe(1);

    const one = await contract.describeSafetyEvent({
      authorization: context.authorization,
      safetyEventId: eventId,
    });
    expect(one.ok && one.value?.safetyEventId).toBe(eventId);

    const summary = await contract.summariseSafety({ authorization: context.authorization });
    expect(summary.ok && summary.value.total).toBe(1);
  });

  it("binds the five rating methods", async () => {
    const context = buildGovernanceTestContext();
    const contract = build(context);
    const actor = { kind: "end-user" as const, endUserId: END_USER_ID };

    const cast = await contract.rateTurn({
      authorization: context.authorization,
      actor,
      turnId: TURN_ID,
      rating: 1,
    });
    expect(cast.ok && cast.value.rating).toBe(1);

    const read = await contract.readTurnRating({
      authorization: context.authorization,
      actor,
      turnId: TURN_ID,
    });
    expect(read.ok && read.value.own?.rating).toBe(1);

    const versions = await contract.readVersionSatisfaction({
      authorization: context.authorization,
      agentId: AGENT_ID,
    });
    expect(versions.ok).toBe(true);

    const agents = await contract.readAgentSatisfaction({ authorization: context.authorization });
    expect(agents.ok).toBe(true);

    const withdrawn = await contract.withdrawRating({
      authorization: context.authorization,
      actor,
      turnId: TURN_ID,
    });
    expect(withdrawn.ok && withdrawn.value).toBe(true);
    expect(context.ratings.size()).toBe(0);
  });

  it("binds the five criterion methods", async () => {
    const context = buildGovernanceTestContext();
    const contract = build(context);
    const criterionId = await seedCriterion(context);

    const described = await contract.describeCriterion({
      authorization: context.authorization,
      criterionId,
    });
    expect(described.ok && described.value.name).toBe("groundedness");

    const updated = await contract.updateCriterion({
      authorization: context.authorization,
      criterionId,
      patch: { name: "grounded" },
    });
    expect(updated.ok && updated.value.name).toBe("grounded");

    const paged = await contract.pageCriteria({ authorization: context.authorization });
    expect(paged.ok && paged.value.total).toBe(1);

    const removed = await contract.removeCriterion({ authorization: context.authorization, criterionId });
    expect(removed.ok && removed.value).toBe(true);
    expect(context.criteria.size()).toBe(0);
  });

  it("binds the four eval methods", async () => {
    const context = buildGovernanceTestContext();
    const contract = build(context);
    const criterionId = await seedCriterion(context);

    const judged = await contract.runJudge({
      authorization: context.authorization,
      agentId: AGENT_ID,
      criterionId,
      threadId: THREAD_ID,
      turnId: TURN_ID,
    });
    expect(judged.ok && judged.value.score).toBe(80);
    const evalId = judged.ok ? judged.value.agentEvalId : ("" as AgentEvalId);

    const described = await contract.describeEval({ authorization: context.authorization, evalId });
    expect(described.ok && described.value.agentEvalId).toBe(evalId);

    const paged = await contract.pageEvals({ authorization: context.authorization });
    expect(paged.ok && paged.value.total).toBe(1);

    const rolled = await contract.aggregateAgentEvals({
      authorization: context.authorization,
      agentId: AGENT_ID,
    });
    expect(rolled.ok && rolled.value.rows).toHaveLength(1);
  });

  it("binds the seven golden-set, run and report methods", async () => {
    const context = buildGovernanceTestContext();
    const contract = build(context);
    const criterionId = await seedCriterion(context);
    const goldenSetId = await seedGoldenSet(context, criterionId);

    const described = await contract.describeGoldenSet({
      authorization: context.authorization,
      goldenSetId,
    });
    expect(described.ok && described.value.name).toBe("regression");

    const updated = await contract.updateGoldenSet({
      authorization: context.authorization,
      goldenSetId,
      patch: { name: "nightly" },
    });
    expect(updated.ok && updated.value.name).toBe("nightly");

    const paged = await contract.pageGoldenSets({ authorization: context.authorization });
    expect(paged.ok && paged.value.total).toBe(1);

    const queued = await contract.enqueueEvalRun({
      authorization: context.authorization,
      goldenSetId,
      requestedBy: asIdentifier<ActorId>("operator-1"),
    });
    expect(queued.ok && queued.value.pairs).toHaveLength(1);

    const report = await contract.reportRegression({
      authorization: context.authorization,
      goldenSetId,
      evalIds: [],
    });
    expect(report.ok && report.value.complete).toBe(false);

    const removed = await contract.removeGoldenSet({ authorization: context.authorization, goldenSetId });
    expect(removed.ok && removed.value).toBe(true);
    expect(context.goldenSets.size()).toBe(0);
  });

  it("binds the risk board", async () => {
    const context = buildGovernanceTestContext();
    const board = await build(context).readRiskBoard({ authorization: context.authorization });
    expect(board.ok && board.value.rows).toEqual([]);
    expect(board.ok && board.value.complete).toBe(true);
  });
});

describe("no method is bound to a stub that ignores authorization", () => {
  it("REFUSES every operator method when the grant was not minted by tenancy", async () => {
    const context = buildGovernanceTestContext();
    const contract = build(context);
    const forged = { principalType: "operator", scope: context.scope };
    const criterionId = asIdentifier<EvalCriterionId>("criterion-0001");
    const goldenSetId = asIdentifier<GoldenSetId>("golden-0001");
    const actor = { kind: "end-user" as const, endUserId: END_USER_ID };

    const refusals = await Promise.all([
      contract.recordSafetyEvent({
        authorization: forged,
        event: { detector: "pii", action: "redact", severity: "medium" },
      }),
      contract.pageSafetyEvents({ authorization: forged }),
      contract.describeSafetyEvent({ authorization: forged, safetyEventId: asIdentifier("safety-0001") }),
      contract.summariseSafety({ authorization: forged }),
      contract.rateTurn({ authorization: forged, actor, turnId: TURN_ID, rating: 1 }),
      contract.withdrawRating({ authorization: forged, actor, turnId: TURN_ID }),
      contract.readTurnRating({ authorization: forged, actor, turnId: TURN_ID }),
      contract.readVersionSatisfaction({ authorization: forged, agentId: AGENT_ID }),
      contract.readAgentSatisfaction({ authorization: forged }),
      contract.createCriterion({
        authorization: forged,
        createdBy: asIdentifier<ActorId>("operator-1"),
        criterion: aCriterionDraft(),
      }),
      contract.updateCriterion({ authorization: forged, criterionId, patch: { name: "x" } }),
      contract.removeCriterion({ authorization: forged, criterionId }),
      contract.describeCriterion({ authorization: forged, criterionId }),
      contract.pageCriteria({ authorization: forged }),
      contract.runJudge({
        authorization: forged,
        agentId: AGENT_ID,
        criterionId,
        threadId: THREAD_ID,
        turnId: TURN_ID,
      }),
      contract.pageEvals({ authorization: forged }),
      contract.describeEval({ authorization: forged, evalId: asIdentifier("eval-0001") }),
      contract.aggregateAgentEvals({ authorization: forged, agentId: AGENT_ID }),
      contract.createGoldenSet({
        authorization: forged,
        createdBy: asIdentifier<ActorId>("operator-1"),
        set: { agentId: AGENT_ID, name: "s", threadIds: [THREAD_ID], criterionIds: [criterionId] },
      }),
      contract.updateGoldenSet({ authorization: forged, goldenSetId, patch: { name: "x" } }),
      contract.removeGoldenSet({ authorization: forged, goldenSetId }),
      contract.describeGoldenSet({ authorization: forged, goldenSetId }),
      contract.pageGoldenSets({ authorization: forged }),
      contract.enqueueEvalRun({
        authorization: forged,
        goldenSetId,
        requestedBy: asIdentifier<ActorId>("operator-1"),
      }),
      contract.reportRegression({ authorization: forged, goldenSetId, evalIds: [] }),
      contract.readRiskBoard({ authorization: forged }),
    ]);

    expect(refusals).toHaveLength(26);
    for (const refusal of refusals) expect(refusal.ok).toBe(false);
    // And nothing reached a store on the way to being refused.
    expect(context.safety.size()).toBe(0);
    expect(context.ratings.size()).toBe(0);
    expect(context.criteria.size()).toBe(0);
    expect(context.evals.size()).toBe(0);
    expect(context.goldenSets.size()).toBe(0);
    expect(context.evalRuns.requests).toHaveLength(0);
    expect(context.judge.asked).toHaveLength(0);
  });
});
