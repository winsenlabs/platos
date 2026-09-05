// One scenario, written once, so this context's five in-memory doubles and this
// adapter can be asked the SAME questions and their answers compared.
//
// Same instrument as `./conformance.ts`, `./identity-conformance.ts` and
// `./cost-conformance.ts`, and the same reason: two independently written suites
// measure two things and agree by coincidence. This module drives one sequence
// of port calls and records what came back; a test runs it twice and compares
// verbatim. A divergence is then a named step with a value on each side.
//
// NO OBSERVATION CARRIES A MINTED IDENTIFIER OR A MINTED INSTANT, and that is
// forced by the ports rather than chosen. None of these five stores takes an id
// or a timestamp: `SafetyLedger.append` is handed an `AdmittedSafetyEvent` with
// neither, `CriteriaRepository.create` an `AdmittedCriterion` with neither. So
// the store mints both, the double mints `safety-0001` where PostgreSQL mints a
// uuid, and comparing either would measure the minting rather than the
// behaviour. What IS compared is everything downstream of them: totals, orders
// expressed as sequences of DETECTORS and NAMES, counts, booleans, null-versus-
// absent, and the `Result` errors' own codes and reasons.
//
// THE ORDER STILL COMPARES, because both stores are driven by a clock that
// advances. `createInstantSource` gives the adapter a strictly increasing
// instant per row and the listings break the remaining tie on `id`; the doubles
// are handed an equivalent advancing clock by `governanceConformanceClock`.
// Without that the real store's `createdAt` would tie inside one transaction —
// `now()` is the TRANSACTION's start time on PostgreSQL — and a paged listing's
// order would be arbitrary on one side and insertion order on the other.
//
// THE IDENTIFIERS THE SCENARIO IS GIVEN ARE ALL UUIDS. `governance`'s own
// fixtures mint `agent-1` and its `SequenceIdGenerator` mints `id-0001`; both
// satisfy every double and both are refused by `@db.Uuid`. The scenario is
// handed real ones by its environment, so a divergence here is a behaviour
// difference rather than a shape difference. The shape refusals have their own
// named cases in `governance-constraints.integration.test.ts`.
//
// TWO THINGS ARE DELIBERATELY NOT IN THIS SCENARIO, because on both the double
// is WRONG rather than different, and a conformance run is for comparing answers:
//
//   A rating of `-1`. The domain mints it and `MessageRating_rating_check`
//   refuses it. The double stores it happily.
//
//   A golden-set RENAME onto a name that agent already uses.
//   `InMemoryGoldenSetsRepository.update` performs no uniqueness check at all
//   and would leave two rows `@@unique([environmentId, agentId, name])` forbids.
//
// Both are pinned against the real database instead, and both are reported.

import type {
  AdmittedCriterion,
  AdmittedEval,
  AdmittedGoldenSet,
  AdmittedSafetyEvent,
  ActorId,
  AgentId,
  AgentVersionId,
  EndUserId,
  EnvironmentScope,
  EvalCriterionId,
  Result,
  ThreadId,
  TransactionScope,
  TurnId,
} from "@platos/context-governance/application/ports/index.js";
import { asGovernanceIdentifier } from "@platos/context-governance/application/ports/index.js";

import type { GovernanceStores } from "./governance-repository.js";

/** Every identifier the scenario needs. All uuids; both stores use the same. */
export interface GovernanceConformanceIds {
  readonly agentId: string;
  readonly agentVersionId: string;
  readonly secondAgentVersionId: string;
  readonly endUserId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly secondTurnId: string;
  /** An id of the right SHAPE that names no row. Every `findById` miss uses it. */
  readonly absentId: string;
}

export interface GovernanceConformanceEnvironment {
  readonly stores: GovernanceStores;
  readonly scope: EnvironmentScope;
  readonly ids: GovernanceConformanceIds;
  /** Open one transaction. The doubles' stand-in, or the adapter's unit of work. */
  run<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value>;
}

export type GovernanceObservation = Record<string, unknown>;

/**
 * A clock that advances one millisecond per reading.
 *
 * The doubles take `() => Date` and the adapter mints its own through
 * `createInstantSource`; both are strictly increasing, which is what makes
 * "most recent first" the same sequence on both sides.
 */
export function governanceConformanceClock(): () => Date {
  let tick = Date.parse("2026-05-01T09:00:00.000Z");
  return () => {
    tick += 1;
    return new Date(tick);
  };
}

const ACTOR = asGovernanceIdentifier<ActorId>("operator-1");

/** A safety draft, already admitted, with everything but the axes held fixed. */
export function conformanceSafetyEvent(
  ids: GovernanceConformanceIds,
  overrides: Partial<AdmittedSafetyEvent> = {},
): AdmittedSafetyEvent {
  return {
    detector: "pii",
    action: "flag",
    severity: "high",
    detail: "an email address was seen",
    detailTruncated: false,
    metadata: null,
    agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
    threadId: asGovernanceIdentifier<ThreadId>(ids.threadId),
    turnId: asGovernanceIdentifier<TurnId>(ids.turnId),
    principalId: null,
    toolName: null,
    toolCallId: null,
    rule: null,
    ...overrides,
  };
}

export function conformanceCriterion(overrides: Partial<AdmittedCriterion> = {}): AdmittedCriterion {
  return {
    agentId: null,
    name: "helpfulness",
    description: "did it answer the question",
    judgePrompt: "score the assistant on {conversation}",
    rubric: null,
    judgeModel: null,
    scoreScaleMin: 0,
    scoreScaleMax: 1,
    ...overrides,
  };
}

export function conformanceEval(
  ids: GovernanceConformanceIds,
  criterionId: EvalCriterionId,
  overrides: Partial<AdmittedEval> = {},
): AdmittedEval {
  return {
    agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
    agentVersionId: asGovernanceIdentifier<AgentVersionId>(ids.agentVersionId),
    threadId: asGovernanceIdentifier<ThreadId>(ids.threadId),
    turnId: asGovernanceIdentifier<TurnId>(ids.turnId),
    criterionId,
    criterionSnapshot: {
      name: "helpfulness",
      description: "did it answer the question",
      judgePrompt: "score the assistant on {conversation}",
      rubric: null,
      judgeModel: null,
      scoreScaleMin: 0,
      scoreScaleMax: 1,
    },
    judgeModel: "anthropic:test-judge",
    judgePromptUsed: "score the assistant on USER: hello",
    rawResponse: '{"score":1,"rationale":"answered"}',
    rawResponseTruncated: false,
    score: 100,
    rationale: "answered",
    passed: true,
    costCents: 0.0125,
    latencyMs: 42,
    ...overrides,
  };
}

export function conformanceGoldenSet(
  ids: GovernanceConformanceIds,
  overrides: Partial<AdmittedGoldenSet> = {},
): AdmittedGoldenSet {
  return {
    agentId: asGovernanceIdentifier<AgentId>(ids.agentId),
    name: "regression",
    description: "the ten conversations every version is judged on",
    threadIds: [asGovernanceIdentifier<ThreadId>(ids.threadId)],
    criterionIds: [],
    pairCount: 0,
    ...overrides,
  };
}

/** A `Result`, reduced to what compares across two stores. */
function outcome<Value>(
  result: Result<Value>,
  project: (value: Value) => unknown,
): Record<string, unknown> {
  if (result.ok) return { ok: true, value: project(result.value) };
  return {
    ok: false,
    code: result.error.code,
    category: result.error.category,
    reason: result.error.details["reason"] ?? null,
  };
}

/**
 * Drive the whole scenario and record what came back.
 *
 * The sequence is fixed and the observations are keyed by STEP NAME, so a
 * divergence names the call rather than an index into an array.
 */
export async function runGovernanceConformance(
  environment: GovernanceConformanceEnvironment,
): Promise<GovernanceObservation> {
  const { stores, scope, ids } = environment;
  const observed: GovernanceObservation = {};
  const since = new Date("2026-01-01T00:00:00.000Z");
  const endUserId = asGovernanceIdentifier<EndUserId>(ids.endUserId);
  const turnId = asGovernanceIdentifier<TurnId>(ids.turnId);
  const secondTurnId = asGovernanceIdentifier<TurnId>(ids.secondTurnId);
  const agentId = asGovernanceIdentifier<AgentId>(ids.agentId);

  // ---------------------------------------------------------------- safety
  const firstAppend = await environment.run((transaction) =>
    stores.safety.append(
      scope,
      conformanceSafetyEvent(ids, {
        principalId: "subject-a",
        toolName: "web_search",
        rule: "pii.email",
        detailTruncated: true,
      }),
      transaction,
    ),
  );
  observed["safety.append.first"] = outcome(firstAppend, (event) => ({
    detector: event.detector,
    action: event.action,
    severity: event.severity,
    detail: event.detail,
    detailTruncated: event.detailTruncated,
    metadata: event.metadata,
    principalId: event.principalId,
    rule: event.rule,
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    // The COLUMN, which the write path never populates. It is observed because
    // "null on write" is a decision `domain/safety-event.ts` makes and an
    // adapter could quietly undo.
    endUserId: event.endUserId,
    environmentId: event.environmentId,
  }));
  const firstEventId = firstAppend.ok ? firstAppend.value.safetyEventId : null;

  await environment.run((transaction) =>
    stores.safety.append(
      scope,
      conformanceSafetyEvent(ids, {
        detector: "injection",
        action: "block",
        severity: "medium",
        principalId: "subject-b",
        toolName: "shell",
        metadata: { pattern: "ignore previous", hits: 2 },
      }),
      transaction,
    ),
  );
  await environment.run((transaction) =>
    stores.safety.append(
      scope,
      conformanceSafetyEvent(ids, {
        detector: "tool_param",
        action: "warn",
        severity: "low",
        principalId: "subject-a",
        toolName: "WEB_fetch",
      }),
      transaction,
    ),
  );

  const everything = await stores.safety.page(scope, {
    since,
    limit: 10,
    offset: 0,
    detector: null,
    severity: null,
    agentId: null,
    threadId: null,
    search: null,
  });
  observed["safety.page.all"] = outcome(everything, (page) => ({
    total: page.total,
    detectors: page.items.map((item) => item.detector),
  }));

  observed["safety.page.filtered"] = outcome(
    await stores.safety.page(scope, {
      since,
      limit: 10,
      offset: 0,
      detector: "pii",
      severity: null,
      agentId: null,
      threadId: null,
      search: null,
    }),
    (page) => ({ total: page.total, detectors: page.items.map((item) => item.detector) }),
  );

  observed["safety.page.search"] = outcome(
    await stores.safety.page(scope, {
      since,
      limit: 10,
      offset: 0,
      detector: null,
      severity: null,
      agentId: null,
      threadId: null,
      // Lower case against a tool named `WEB_fetch`, so a store that forgot to
      // fold the case answers zero.
      search: "web_",
    }),
    (page) => ({ total: page.total, tools: page.items.map((item) => item.toolName) }),
  );

  observed["safety.page.paged"] = outcome(
    await stores.safety.page(scope, {
      since,
      limit: 1,
      offset: 1,
      detector: null,
      severity: null,
      agentId: null,
      threadId: null,
      search: null,
    }),
    (page) => ({ total: page.total, detectors: page.items.map((item) => item.detector) }),
  );

  if (firstEventId !== null) {
    observed["safety.findById.hit"] = outcome(
      await stores.safety.findById(scope, firstEventId),
      (event) => (event === null ? null : { detector: event.detector, rule: event.rule }),
    );
  }
  observed["safety.findById.miss"] = outcome(
    await stores.safety.findById(scope, asGovernanceIdentifier(ids.absentId)),
    (event) => event,
  );

  observed["safety.tally"] = outcome(await stores.safety.tally(scope, since), (rows) =>
    [...rows]
      .map((row) => `${row.detector}/${row.action}/${row.severity}`)
      .sort(),
  );

  observed["safety.countByAgent"] = outcome(
    await stores.safety.countByAgent(scope, since),
    (rows) =>
      [...rows]
        .map((row) => ({ pii: row.piiEvents, injection: row.injectionEvents }))
        .sort((left, right) => left.pii - right.pii),
  );

  observed["safety.countSubject.present"] = outcome(
    await stores.safety.countSubject({ scope, principalId: "subject-a" }),
    (count) => count,
  );
  observed["safety.countSubject.null"] = outcome(
    await stores.safety.countSubject({ scope, principalId: null }),
    (count) => count,
  );
  observed["safety.countSubject.organization"] = outcome(
    await stores.safety.countSubject({
      scope: { level: "organization", organizationId: scope.organizationId },
      principalId: "subject-a",
    }),
    (count) => count,
  );

  observed["safety.anonymize"] = outcome(
    await environment.run((transaction) =>
      stores.safety.anonymizeSubject({ scope, principalId: "subject-a" }, transaction),
    ),
    (count) => count,
  );
  observed["safety.countSubject.afterAnonymise"] = outcome(
    await stores.safety.countSubject({ scope, principalId: "subject-a" }),
    (count) => count,
  );
  if (firstEventId !== null) {
    observed["safety.findById.afterAnonymise"] = outcome(
      await stores.safety.findById(scope, firstEventId),
      (event) =>
        event === null
          ? null
          : {
              // The ledger's own facts survive; the identifying columns do not.
              detector: event.detector,
              action: event.action,
              severity: event.severity,
              detail: event.detail,
              metadata: event.metadata,
              principalId: event.principalId,
            },
    );
  }
  observed["safety.page.afterAnonymise"] = outcome(
    await stores.safety.page(scope, {
      since,
      limit: 10,
      offset: 0,
      detector: null,
      severity: null,
      agentId: null,
      threadId: null,
      search: null,
    }),
    (page) => ({ total: page.total }),
  );

  // --------------------------------------------------------------- ratings
  observed["ratings.upsert.create"] = outcome(
    await environment.run((transaction) =>
      stores.ratings.upsert(
        scope,
        {
          turnId,
          agentId,
          agentVersionId: asGovernanceIdentifier<AgentVersionId>(ids.agentVersionId),
          endUserId,
          rating: 1,
          comment: "exactly right",
          revision: 1,
        },
        transaction,
      ),
    ),
    (rating) => ({ rating: rating.rating, revision: rating.revision, comment: rating.comment }),
  );
  observed["ratings.findForTurn.hit"] = outcome(
    await stores.ratings.findForTurn(scope, turnId, endUserId),
    (rating) => (rating === null ? null : { rating: rating.rating, revision: rating.revision }),
  );
  observed["ratings.upsert.flip"] = outcome(
    await environment.run((transaction) =>
      stores.ratings.upsert(
        scope,
        {
          turnId,
          agentId,
          agentVersionId: asGovernanceIdentifier<AgentVersionId>(ids.secondAgentVersionId),
          endUserId,
          rating: 1,
          comment: null,
          revision: 2,
        },
        transaction,
      ),
    ),
    (rating) => ({ rating: rating.rating, revision: rating.revision, comment: rating.comment }),
  );
  observed["ratings.tallyTurn"] = outcome(
    await stores.ratings.tallyTurn(scope, turnId),
    (rows) => rows.map((row) => row.rating),
  );
  observed["ratings.sample.allAgents"] = outcome(
    await stores.ratings.sample(scope, { since, agentId: null }),
    (rows) => rows.map((row) => row.rating),
  );
  observed["ratings.countSubject"] = outcome(
    await stores.ratings.countSubject({ scope, endUserId }),
    (count) => count,
  );
  observed["ratings.countSubject.null"] = outcome(
    await stores.ratings.countSubject({ scope, endUserId: null }),
    (count) => count,
  );
  observed["ratings.remove.hit"] = outcome(
    await environment.run((transaction) =>
      stores.ratings.remove(scope, turnId, endUserId, transaction),
    ),
    (removed) => removed,
  );
  observed["ratings.remove.miss"] = outcome(
    await environment.run((transaction) =>
      stores.ratings.remove(scope, secondTurnId, endUserId, transaction),
    ),
    (removed) => removed,
  );

  // -------------------------------------------------------------- criteria
  const created = await environment.run((transaction) =>
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
    await environment.run((transaction) =>
      stores.criteria.create(scope, conformanceCriterion(), ACTOR, transaction),
    ),
    (criterion) => criterion.name,
  );
  const criterionId = created.ok ? created.value.evalCriterionId : asGovernanceIdentifier<EvalCriterionId>(ids.absentId);

  await environment.run((transaction) =>
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
      await environment.run((transaction) =>
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
      await environment.run((transaction) =>
        stores.criteria.update(
          scope,
          { ...created.value, evalCriterionId: asGovernanceIdentifier(ids.absentId) },
          transaction,
        ),
      ),
      (criterion) => criterion.name,
    );
  }

  // ----------------------------------------------------------------- evals
  const appended = await environment.run((transaction) =>
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

  await environment.run((transaction) =>
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
            // FALSE on every read: no column carries it. See the header of
            // `governance-evals.ts`.
            rawResponseTruncated: row.rawResponseTruncated,
            rawResponse: row.rawResponse,
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
  const set = await environment.run((transaction) =>
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
    await environment.run((transaction) =>
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
      await environment.run((transaction) =>
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
      await environment.run((transaction) =>
        stores.goldenSets.update(
          scope,
          { ...set.value, goldenSetId: asGovernanceIdentifier(ids.absentId) },
          transaction,
        ),
      ),
      (row) => row.name,
    );
    observed["goldenSets.remove.hit"] = outcome(
      await environment.run((transaction) =>
        stores.goldenSets.remove(scope, set.value.goldenSetId, transaction),
      ),
      (removed) => removed,
    );
    observed["goldenSets.remove.miss"] = outcome(
      await environment.run((transaction) =>
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
    await environment.run((transaction) => stores.criteria.remove(scope, criterionId, transaction)),
    (removed) => removed,
  );
  observed["criteria.remove.again"] = outcome(
    await environment.run((transaction) => stores.criteria.remove(scope, criterionId, transaction)),
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

  return observed;
}
