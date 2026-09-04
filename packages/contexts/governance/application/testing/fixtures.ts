// One expression that builds the whole context from in-memory doubles.
//
// EVERY DOUBLE IS REACHABLE FROM THE RETURNED CONTEXT, not only through the
// dependency bundle, so a test can seed a store and then assert on it directly
// — "the row was NOT written" is the assertion most of the refusal tests turn
// on, and it needs a handle on the store rather than on the port.
//
// THE POLICY IS AN ARGUMENT. Ceilings are exercised against SMALL, EXPLICIT
// policies rather than against the shipped defaults, because a cap test whose
// input is derived from the constant it is testing stays green when the constant
// moves. `withPolicy` is how a suite says "three threads is the ceiling here"
// and then supplies four.

import { asIdentifier, environmentScope, type EnvironmentScope } from "@platos/kernel";
import type { EnvironmentOperatorAuthorization as TenancyGrant } from "@platos/context-tenancy";
import type { AgentsContract } from "@platos/context-agents";
import type { TenancyContract } from "@platos/context-tenancy";

import {
  DEFAULT_GOVERNANCE_POLICY,
  type AgentId,
  type AgentVersionId,
  type EndUserId,
  type GovernancePolicy,
  type ThreadId,
  type TurnId,
} from "../../domain/index.js";
import { governanceDependencies, type GovernanceDependencies } from "../dependencies.js";
import {
  InMemoryUnitOfWork,
  MutableClock,
  RecordingLogger,
  SequentialIds,
} from "./in-memory-infrastructure.js";
import { InMemoryAgents, InMemoryTenancy } from "./in-memory-peers.js";
import { InMemoryRatingsRepository } from "./in-memory-ratings-repository.js";
import { InMemorySafetyLedger } from "./in-memory-safety-ledger.js";
import { InMemoryCriteriaRepository, InMemoryEvalsRepository } from "./in-memory-eval-stores.js";
import { InMemoryGoldenSetsRepository } from "./in-memory-golden-sets-repository.js";
import {
  InMemoryActivity,
  InMemoryEvalRunQueue,
  InMemoryRatingTargets,
  InMemoryTranscripts,
  ScriptedJudge,
} from "./in-memory-seams.js";

/** The environment every fixture is seeded in. */
export function testEnvironmentScope(environmentId = "env-1"): EnvironmentScope {
  return environmentScope(asIdentifier("org-1"), asIdentifier("proj-1"), asIdentifier(environmentId));
}

/** A second tenant, for the cross-tenant denial tests. */
export function otherEnvironmentScope(): EnvironmentScope {
  return environmentScope(asIdentifier("org-2"), asIdentifier("proj-2"), asIdentifier("env-2"));
}

export const AGENT_ID = asIdentifier<AgentId>("agent-1");
export const AGENT_VERSION_ID = asIdentifier<AgentVersionId>("version-7");
/**
 * The version the seeded turn RAN ON — one behind the live one.
 *
 * The fixture is deliberately mid-promotion. An eval and a rating taken on this
 * turn must be attributed to `version-6`; a fixture in which the turn's version
 * equalled the agent's current version would make the two indistinguishable and
 * the attribution rule untestable.
 */
export const PRIOR_AGENT_VERSION_ID = asIdentifier<AgentVersionId>("version-6");
export const THREAD_ID = asIdentifier<ThreadId>("thread-1");
export const TURN_ID = asIdentifier<TurnId>("turn-1");
export const END_USER_ID = asIdentifier<EndUserId>("end-user-1");
export const OTHER_END_USER_ID = asIdentifier<EndUserId>("end-user-2");
/** The model the seeded agent's live version runs. The self-eval guard reads it. */
export const AGENT_MODEL = "anthropic:claude-sonnet-4-6";

export interface GovernanceTestContext {
  readonly scope: EnvironmentScope;
  readonly dependencies: GovernanceDependencies;
  readonly safety: InMemorySafetyLedger;
  readonly ratings: InMemoryRatingsRepository;
  readonly criteria: InMemoryCriteriaRepository;
  readonly evals: InMemoryEvalsRepository;
  readonly goldenSets: InMemoryGoldenSetsRepository;
  readonly ratingTargets: InMemoryRatingTargets;
  readonly transcripts: InMemoryTranscripts;
  readonly activity: InMemoryActivity;
  readonly judge: ScriptedJudge;
  readonly evalRuns: InMemoryEvalRunQueue;
  readonly clock: MutableClock;
  readonly logger: RecordingLogger;
  readonly unitOfWork: InMemoryUnitOfWork;
  readonly tenancy: InMemoryTenancy;
  readonly agents: InMemoryAgents;
  /** A grant this context's tenancy double will recognise. */
  readonly authorization: TenancyGrant;
  /** A grant for a DIFFERENT environment, minted by the same double. */
  grantFor(scope: EnvironmentScope): TenancyGrant;
}

export interface TestContextOptions {
  readonly scope?: EnvironmentScope;
  readonly policy?: GovernancePolicy;
  readonly now?: Date;
  /** Seed the standard agent, turn and transcript. Default true. */
  readonly seeded?: boolean;
}

export function buildGovernanceTestContext(options: TestContextOptions = {}): GovernanceTestContext {
  const scope = options.scope ?? testEnvironmentScope();
  const clock = new MutableClock(options.now);
  const now = () => clock.now();

  const safety = new InMemorySafetyLedger(now);
  const ratings = new InMemoryRatingsRepository(now);
  const criteria = new InMemoryCriteriaRepository(now);
  const evals = new InMemoryEvalsRepository(now);
  const goldenSets = new InMemoryGoldenSetsRepository(now);
  // `AgentEval.criterion` is `onDelete: Cascade` in the canonical schema, so the
  // two stores are wired together here rather than left independent.
  criteria.cascadeInto(evals);
  const ratingTargets = new InMemoryRatingTargets();
  const transcripts = new InMemoryTranscripts();
  const activity = new InMemoryActivity();
  const judge = new ScriptedJudge();
  const evalRuns = new InMemoryEvalRunQueue();
  const logger = new RecordingLogger();
  const unitOfWork = new InMemoryUnitOfWork();
  const tenancy = new InMemoryTenancy(scope);
  const agents = new InMemoryAgents(scope, now);

  if (options.seeded !== false) {
    agents.seed({
      agentId: AGENT_ID,
      name: "Support",
      model: AGENT_MODEL,
      currentVersionId: AGENT_VERSION_ID,
      currentVersionNumber: 7,
      priorVersions: [{ versionId: PRIOR_AGENT_VERSION_ID, versionNumber: 6 }],
    });
    ratingTargets.seed(scope, {
      turnId: TURN_ID,
      threadId: THREAD_ID,
      agentId: AGENT_ID,
      endUserId: END_USER_ID,
      // The version that PRODUCED the seeded turn, deliberately NOT the agent's
      // current one: a fixture where the two agree could not tell an attribution
      // taken from the turn apart from one taken from the live binding.
      agentVersionId: PRIOR_AGENT_VERSION_ID,
    });
    transcripts.seed(scope, THREAD_ID, AGENT_ID, [
      {
        turnId: TURN_ID,
        input: "how do I reset it?",
        output: "hold the button for ten seconds",
        agentVersionId: PRIOR_AGENT_VERSION_ID,
      },
    ]);
    judge.answer('{"score": 80, "rationale": "grounded and complete", "passed": true}');
  }

  const dependencies = governanceDependencies({
    safety,
    ratings,
    criteria,
    evals,
    goldenSets,
    ratingTargets,
    transcripts,
    activity,
    judge,
    evalRuns,
    clock,
    ids: new SequentialIds(),
    unitOfWork,
    logger,
    policy: options.policy ?? DEFAULT_GOVERNANCE_POLICY,
    tenancy: tenancy as unknown as TenancyContract,
    agents: agents as unknown as AgentsContract,
  });

  return {
    scope,
    dependencies,
    safety,
    ratings,
    criteria,
    evals,
    goldenSets,
    ratingTargets,
    transcripts,
    activity,
    judge,
    evalRuns,
    clock,
    logger,
    unitOfWork,
    tenancy,
    agents,
    authorization: tenancy.grant(),
    grantFor: (other: EnvironmentScope) => tenancy.grant("metadata", other),
  };
}

/** A policy with one branch of the shipped defaults replaced. */
export function withPolicy(patch: {
  readonly safety?: Partial<GovernancePolicy["safety"]>;
  readonly ratings?: Partial<GovernancePolicy["ratings"]>;
  readonly criteria?: Partial<GovernancePolicy["criteria"]>;
  readonly evals?: Partial<GovernancePolicy["evals"]>;
  readonly goldenSets?: Partial<GovernancePolicy["goldenSets"]>;
  readonly regression?: Partial<GovernancePolicy["regression"]>;
  readonly risk?: Partial<GovernancePolicy["risk"]>;
}): GovernancePolicy {
  return {
    safety: { ...DEFAULT_GOVERNANCE_POLICY.safety, ...patch.safety },
    ratings: { ...DEFAULT_GOVERNANCE_POLICY.ratings, ...patch.ratings },
    criteria: { ...DEFAULT_GOVERNANCE_POLICY.criteria, ...patch.criteria },
    evals: { ...DEFAULT_GOVERNANCE_POLICY.evals, ...patch.evals },
    goldenSets: { ...DEFAULT_GOVERNANCE_POLICY.goldenSets, ...patch.goldenSets },
    regression: { ...DEFAULT_GOVERNANCE_POLICY.regression, ...patch.regression },
    risk: { ...DEFAULT_GOVERNANCE_POLICY.risk, ...patch.risk },
  };
}

/** A well-formed criterion draft, for suites that need one but do not vary it. */
export function aCriterionDraft(overrides: Record<string, unknown> = {}) {
  return {
    name: "groundedness",
    judgePrompt: "Score the assistant on groundedness.\n\n{conversation}",
    ...overrides,
  };
}
