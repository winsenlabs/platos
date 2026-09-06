// The half of the conformance scenario that measures the EVAL PIPELINE — the
// criterion a measurement is taken against, the measurement, and the golden set
// a run is drawn from.
//
// IT IS A SEPARATE FILE BECAUSE THE BUDGET SAID SO, and the seam it pointed at
// is the right one. ADR M0.3 §6 puts a hard error at 500 effective lines for
// `packages/adapters/**`, one scenario over five ports was past it, and the two
// halves are genuinely separable: the safety ledger and the ratings table share
// a SUBJECT — both are erased on a person's behalf — and these three share a
// CRITERION, which cascades. Nothing crosses.
//
// The observations are written into the SAME map the first half fills, keyed by
// step name, so the differential still compares one object per store and a
// divergence still names one call. See `governance-conformance.ts` for why no
// observation here carries a minted identifier or a minted instant.

import type {
  AgentId,
  AgentVersionId,
  EvalCriterionId,
  TurnId,
} from "@platos/context-governance/application/ports/index.js";
import { asGovernanceIdentifier } from "@platos/context-governance/application/ports/index.js";
import { runResult } from "@platos/kernel";

import {
  ACTOR,
  conformanceCriterion,
  conformanceEval,
  conformanceGoldenSet,
  outcome,
  type GovernanceConformanceEnvironment,
  type GovernanceObservation,
} from "./governance-conformance.js";

/** Drive the eval half, writing into the map the safety half has already filled. */
export async function runEvalConformance(
  environment: GovernanceConformanceEnvironment,
  observed: GovernanceObservation,
  since: Date,
): Promise<void> {
  const { stores, scope, ids } = environment;
  const agentId = asGovernanceIdentifier<AgentId>(ids.agentId);
  const secondTurnId = asGovernanceIdentifier<TurnId>(ids.secondTurnId);

  // -------------------------------------------------------------- criteria
  const created = await runResult(environment, (transaction) =>
    stores.criteria.create(scope, conformanceCriterion(), ACTOR, transaction),
  );
  observed["criteria.create"] = outcome(created, (criterion) => ({
    name: criterion.name,
    isActive: criterion.isActive,
    agentId: criterion.agentId,
    createdBy: criterion.createdBy,
    scoreScaleMin: criterion.scoreScaleMin,
    scoreScaleMax: criterion.scoreScaleMax,
  }));
  observed["criteria.create.duplicate"] = outcome(
    await runResult(environment, (transaction) =>
      stores.criteria.create(scope, conformanceCriterion(), ACTOR, transaction),
    ),
    (criterion) => criterion.name,
  );
  const criterionId = created.ok ? created.value.evalCriterionId : asGovernanceIdentifier<EvalCriterionId>(ids.absentId);

  await runResult(environment, (transaction) =>
    stores.criteria.create(
      scope,
      conformanceCriterion({ name: "grounding", agentId }),
      ACTOR,
      transaction,
    ),
  );

  observed["criteria.findByName.hit"] = outcome(
    await stores.criteria.findByName(scope, "helpfulness"),
    (criterion) => (criterion === null ? null : criterion.name),
  );
  observed["criteria.findByName.case"] = outcome(
    // EXACT, not folded: the unique index this pre-checks is case-sensitive.
    await stores.criteria.findByName(scope, "Helpfulness"),
    (criterion) => (criterion === null ? null : criterion.name),
  );
  observed["criteria.page.all"] = outcome(
    await stores.criteria.page(scope, { limit: 10, offset: 0, activeOnly: false, search: null }),
    (page) => ({ total: page.total, names: page.items.map((item) => item.name) }),
  );
  observed["criteria.page.sharedOnly"] = outcome(
    await stores.criteria.page(scope, {
      limit: 10,
      offset: 0,
      agentId: null,
      activeOnly: false,
      search: null,
    }),
    (page) => ({ total: page.total, names: page.items.map((item) => item.name) }),
  );
  observed["criteria.page.explicitUndefined"] = outcome(
    // THE KEY IS PRESENT AND THE VALUE IS `undefined`, which is a THIRD case:
    // `agentId?: AgentId | null` permits it, and `"agentId" in query` is what
    // tells it from an absent key. The double treats it as the SHARED-only
    // filter; a store that switched to `=== undefined` would treat it as no
    // filter at all and widen the listing to every criterion in the environment.
    await stores.criteria.page(scope, {
      limit: 10,
      offset: 0,
      agentId: undefined,
      activeOnly: false,
      search: null,
    }),
    (page) => ({ total: page.total, names: page.items.map((item) => item.name) }),
  );
  observed["criteria.page.forAgent"] = outcome(
    // The MEMBERSHIP: this agent's criteria PLUS the shared ones.
    await stores.criteria.page(scope, {
      limit: 10,
      offset: 0,
      agentId,
      activeOnly: false,
      search: null,
    }),
    (page) => ({ total: page.total, names: page.items.map((item) => item.name) }),
  );
  observed["criteria.findMany"] = outcome(
    await stores.criteria.findMany(scope, [criterionId]),
    (rows) => rows.map((row) => row.name),
  );
  observed["criteria.findMany.empty"] = outcome(
    await stores.criteria.findMany(scope, []),
    (rows) => rows.length,
  );

  if (created.ok) {
    observed["criteria.update"] = outcome(
      await runResult(environment, (transaction) =>
        stores.criteria.update(
          scope,
          { ...created.value, name: "helpfulness v2", isActive: false },
          transaction,
        ),
      ),
      (criterion) => ({ name: criterion.name, isActive: criterion.isActive }),
    );
    observed["criteria.findById.afterUpdate"] = outcome(
      await stores.criteria.findById(scope, criterionId),
      (criterion) => (criterion === null ? null : { name: criterion.name, isActive: criterion.isActive }),
    );
    observed["criteria.page.activeOnly"] = outcome(
      await stores.criteria.page(scope, { limit: 10, offset: 0, activeOnly: true, search: null }),
      (page) => ({ total: page.total, names: page.items.map((item) => item.name) }),
    );
    observed["criteria.update.outOfScope"] = outcome(
      // The name is one ANOTHER criterion in this environment already holds, so
      // the row is both out of scope AND clashing. Which refusal comes back is
      // the ORDER the checks run in, and the double checks scope first.
      await runResult(environment, (transaction) =>
        stores.criteria.update(
          scope,
          {
            ...created.value,
            evalCriterionId: asGovernanceIdentifier(ids.absentId),
            name: "grounding",
          },
          transaction,
        ),
      ),
      (criterion) => criterion.name,
    );
  }

  // ----------------------------------------------------------------- evals
  const appended = await runResult(environment, (transaction) =>
    stores.evals.append(scope, conformanceEval(ids, criterionId, { rawResponseTruncated: true }), transaction),
  );
  observed["evals.append"] = outcome(appended, (row) => ({
    score: row.score,
    passed: row.passed,
    judgeModel: row.judgeModel,
    costCents: row.costCents,
    latencyMs: row.latencyMs,
    rationale: row.rationale,
    // Echoed from the admitted draft. The READ below shows what the row keeps.
    rawResponseTruncated: row.rawResponseTruncated,
    snapshotName: row.criterionSnapshot.name,
    snapshotScale: `${row.criterionSnapshot.scoreScaleMin}..${row.criterionSnapshot.scoreScaleMax}`,
  }));
  const evalId = appended.ok ? appended.value.agentEvalId : null;

  await runResult(environment, (transaction) =>
    stores.evals.append(
      scope,
      conformanceEval(ids, criterionId, {
        agentVersionId: asGovernanceIdentifier<AgentVersionId>(ids.secondAgentVersionId),
        turnId: secondTurnId,
        score: 40,
        passed: false,
        rationale: "missed the follow-up",
        costCents: null,
      }),
      transaction,
    ),
  );

  observed["evals.page.all"] = outcome(
    await stores.evals.page(scope, {
      since,
      limit: 10,
      offset: 0,
      agentId: null,
      agentVersionId: null,
      criterionId: null,
      threadId: null,
      search: null,
    }),
    (page) => ({ total: page.total, scores: page.items.map((item) => item.score) }),
  );
  observed["evals.page.search"] = outcome(
    await stores.evals.page(scope, {
      since,
      limit: 10,
      offset: 0,
      agentId: null,
      agentVersionId: null,
      criterionId: null,
      threadId: null,
      // Matches the RATIONALE of one and the JUDGE MODEL of neither.
      search: "FOLLOW-UP",
    }),
    (page) => ({ total: page.total, scores: page.items.map((item) => item.score) }),
  );
  observed["evals.page.searchModel"] = outcome(
    await stores.evals.page(scope, {
      since,
      limit: 10,
      offset: 0,
      agentId: null,
      agentVersionId: null,
      criterionId: null,
      threadId: null,
      search: "test-judge",
    }),
    (page) => ({ total: page.total }),
  );
  if (evalId !== null) {
    observed["evals.findById"] = outcome(await stores.evals.findById(scope, evalId), (row) =>
      row === null
        ? null
        : {
            score: row.score,
            rawResponse: row.rawResponse,
            // `rawResponseTruncated` is NOT observed here: no column carries it,
            // so the real store answers false and the double answers what it was
            // handed. `governance-rules.integration.test.ts` pins both halves.
            passed: row.passed,
          },
    );
    observed["evals.sampleByIds"] = outcome(
      await stores.evals.sampleByIds(scope, [evalId]),
      (rows) => rows.map((row) => row.score),
    );
  }
  observed["evals.sampleByIds.empty"] = outcome(
    await stores.evals.sampleByIds(scope, []),
    (rows) => rows.length,
  );
  observed["evals.sample.everyVersion"] = outcome(
    await stores.evals.sample(scope, { agentId, since, versionIds: [] }),
    (rows) => rows.map((row) => row.score).sort((left, right) => left - right),
  );
  observed["evals.sample.oneVersion"] = outcome(
    await stores.evals.sample(scope, {
      agentId,
      since,
      versionIds: [asGovernanceIdentifier<AgentVersionId>(ids.agentVersionId)],
    }),
    (rows) => rows.map((row) => row.score),
  );
  observed["evals.sampleBaseline"] = outcome(
    await stores.evals.sampleBaseline(scope, {
      agentId,
      agentVersionId: asGovernanceIdentifier<AgentVersionId>(ids.agentVersionId),
      since,
    }),
    (rows) => rows.map((row) => row.score),
  );

  // ------------------------------------------------------------ goldenSets
  const set = await runResult(environment, (transaction) =>
    stores.goldenSets.create(scope, conformanceGoldenSet(ids), ACTOR, transaction),
  );
  observed["goldenSets.create"] = outcome(set, (row) => ({
    name: row.name,
    description: row.description,
    threadIds: row.threadIds.length,
    criterionIds: row.criterionIds.length,
    createdBy: row.createdBy,
  }));
  observed["goldenSets.create.duplicate"] = outcome(
    await runResult(environment, (transaction) =>
      stores.goldenSets.create(scope, conformanceGoldenSet(ids), ACTOR, transaction),
    ),
    (row) => row.name,
  );
  observed["goldenSets.findByName.hit"] = outcome(
    await stores.goldenSets.findByName(scope, agentId, "regression"),
    (row) => (row === null ? null : row.name),
  );
  observed["goldenSets.page"] = outcome(
    await stores.goldenSets.page(scope, { limit: 10, offset: 0, agentId: null }),
    (page) => ({ total: page.total, names: page.items.map((item) => item.name) }),
  );
  if (set.ok) {
    observed["goldenSets.update"] = outcome(
      await runResult(environment, (transaction) =>
        stores.goldenSets.update(
          scope,
          { ...set.value, description: "trimmed to five", criterionIds: [criterionId] },
          transaction,
        ),
      ),
      (row) => ({ description: row.description, criterionIds: row.criterionIds.length }),
    );
    observed["goldenSets.findById.afterUpdate"] = outcome(
      await stores.goldenSets.findById(scope, set.value.goldenSetId),
      (row) => (row === null ? null : { description: row.description, criterionIds: row.criterionIds.length }),
    );
    observed["goldenSets.update.outOfScope"] = outcome(
      await runResult(environment, (transaction) =>
        stores.goldenSets.update(
          scope,
          { ...set.value, goldenSetId: asGovernanceIdentifier(ids.absentId) },
          transaction,
        ),
      ),
      (row) => row.name,
    );
    observed["goldenSets.remove.hit"] = outcome(
      await runResult(environment, (transaction) =>
        stores.goldenSets.remove(scope, set.value.goldenSetId, transaction),
      ),
      (removed) => removed,
    );
    observed["goldenSets.remove.miss"] = outcome(
      await runResult(environment, (transaction) =>
        stores.goldenSets.remove(scope, set.value.goldenSetId, transaction),
      ),
      (removed) => removed,
    );
  }

  // THE CASCADE, LAST, because it destroys the evals every step above measured.
  // `AgentEval.criterion @relation(onDelete: Cascade)` is the database's
  // decision and the double is obliged to model it; this is where the two are
  // asked whether they agree that a measurement does not outlive the question.
  observed["criteria.remove"] = outcome(
    await runResult(environment, (transaction) => stores.criteria.remove(scope, criterionId, transaction)),
    (removed) => removed,
  );
  observed["criteria.remove.again"] = outcome(
    await runResult(environment, (transaction) => stores.criteria.remove(scope, criterionId, transaction)),
    (removed) => removed,
  );
  observed["evals.page.afterCascade"] = outcome(
    await stores.evals.page(scope, {
      since,
      limit: 10,
      offset: 0,
      agentId: null,
      agentVersionId: null,
      criterionId: null,
      threadId: null,
      search: null,
    }),
    (page) => ({ total: page.total }),
  );
}
