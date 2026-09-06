// One scenario, written once, so this context's in-memory double and this
// adapter can be asked the SAME questions and their answers compared.
//
// Same instrument as `./conformance.ts`, `./identity-conformance.ts`,
// `./cost-conformance.ts` and `./governance-conformance.ts`, and the same
// reason: two independently written suites measure two things and agree by
// coincidence. This module drives one sequence of port calls and records what
// came back; a test runs it twice and compares verbatim. A divergence is then a
// named step with a value on each side.
//
// EVERY IDENTIFIER AND EVERY INSTANT IN THIS SCENARIO IS THE CALLER'S, which is
// the opposite of `governance`'s and is forced by these four ports rather than
// chosen: `createThread` is handed a whole `Thread`, `createTurn` a whole `Turn`,
// `saveSettlement` a turn and its steps. Nothing here mints anything. So ids and
// instants DO compare, and the scenario is written to use uuids — the context's
// own `threadFixture` mints `thread-1`, which every double accepts and `@db.Uuid`
// refuses, and that class of divergence has its own named cases in
// `conversations-constraints.integration.test.ts` instead.
//
// ---------------------------------------------------------------------------
// FIVE THINGS ARE OUT OF THIS SCENARIO OR NARROWED IN IT, BECAUSE ON EACH THE
// DOUBLE IS WRONG RATHER THAN DIFFERENT
// ---------------------------------------------------------------------------
//
//   A FAILED TURN IN THE TRANSCRIPT. `TurnRepository.readTranscriptTurns` is
//   documented as "Every SUCCEEDED turn of a thread after `afterSequence`" and
//   `InMemoryConversations` does not filter on status at all. Seeding an
//   unsettled turn would make this run red on the DOUBLE's behaviour. The real
//   store's filter is pinned in `conversations-rules.integration.test.ts`.
//
//   AN ORGANIZATION-SCOPED ERASURE ACROSS TWO TENANTS. Every erasure method
//   takes an `organizationId` and the double ignores it entirely, filtering on
//   the subject alone. A second tenant is seeded in the rules suite instead.
//
//   A FORK. `Thread_forkedUpToTurnId_fkey` is `ON DELETE RESTRICT` and
//   `Thread_owner_immutable` freezes the column, so a subject who forked can
//   only be erased parent-last; the double deletes from a `Map` with no
//   referential integrity and would agree with a store that got the order wrong.
//   The ordering is pinned in the rules suite.
//
//   A `Turn` WHOSE STORED `costCents` DISAGREES WITH ITS STEPS. The double keeps
//   whole objects and has no column to disagree with. `conversations-rows.test.ts`
//   pins that the rollup wins.
//
//   A FIFTH ONE IS NARROWED RATHER THAN LEFT OUT, because the step around it is
//   worth keeping: after an erasure the real store answers an execution whose
//   `threadId` and `turnId` are NULL — `onDelete: SetNull` on both — and the
//   double keeps them pointing at a thread it has just deleted. The observation
//   records what the erasure is about and the nulling is pinned separately.
//
// All five are pinned against the real database instead, and all five are
// reported.

import {
  asConversationsIdentifier,
  money,
  rollUpTurnCost,
  sumStepUsage,
  type ActorId,
  type AgentId,
  type AgentVersionId,
  type ClusterId,
  type EndUserId,
  type EnvironmentScope,
  type IdempotencyKey,
  type ModelPriceId,
  type PostmanContextHandle,
  type PostmanExecution,
  type PostmanExecutionId,
  type PostmanTemplateId,
  type Result,
  type Step,
  type StepId,
  type StepRateBook,
  type Thread,
  type ThreadId,
  type TransactionScope,
  type Turn,
  type TurnId,
} from "@platos/context-conversations/application/ports/index.js";
import type { NotResult } from "@platos/context-conversations/application/ports/index.js";

import { runErasureConformance } from "./conversations-conformance-erasure.js";
import {
  CONFORMANCE_RATES,
  RATE_OBSERVED_AT,
  RATE_SOURCE,
  RATE_SOURCE_REF,
} from "./conversations-harness.js";
import type { ConversationsStores } from "./conversations-repository.js";

/** Every identifier the scenario needs. All uuids; both stores use the same. */
export interface ConversationsConformanceIds {
  readonly agentId: string;
  readonly agentVersionId: string;
  readonly secondAgentVersionId: string;
  readonly clusterId: string;
  readonly endUserId: string;
  readonly templateId: string;
  readonly actorUserId: string;
  readonly modelPriceId: string;
  readonly threadId: string;
  readonly secondThreadId: string;
  readonly firstTurnId: string;
  readonly secondTurnId: string;
  readonly replyTurnId: string;
  readonly firstStepId: string;
  readonly secondStepId: string;
  readonly executionId: string;
  readonly contextHandle: string;
  readonly requestId: string;
  /** An id of the right SHAPE that names no row. Every miss uses it. */
  readonly absentId: string;
}

export interface ConversationsConformanceEnvironment {
  readonly stores: ConversationsStores;
  readonly scope: EnvironmentScope;
  readonly ids: ConversationsConformanceIds;
  /** Open one transaction. The double's stand-in, or the adapter's unit of work. */
  run<Value>(work: (transaction: TransactionScope) => Promise<NotResult<Value>>): Promise<Value>;
}

export type ConversationsObservation = Record<string, unknown>;

const AT = new Date("2026-05-01T09:00:00.000Z");

function at(offsetMs: number): Date {
  return new Date(AT.getTime() + offsetMs);
}

/**
 * The rate book every priced step in the scenario carries.
 *
 * IT IS THE HARNESS'S CARD, not a copy of it. `Step_price_snapshot` compares
 * these four numbers to `ModelPrice`'s own columns and refuses the row if any
 * digit differs, so a second literal here would be a second chance for the
 * fixture and the card to drift apart in a place no reader would look.
 */
function rateBook(): StepRateBook {
  const rate = (usdPerToken: string) => ({
    usdPerToken,
    source: RATE_SOURCE,
    observedAt: RATE_OBSERVED_AT,
    // NOT NULL, and that is `ModelPrice_rate_check` reaching through
    // `Step_price_snapshot`; see `RATE_SOURCE_REF` in the harness.
    sourceRef: RATE_SOURCE_REF,
  });
  return {
    input: rate(CONFORMANCE_RATES.input),
    output: rate(CONFORMANCE_RATES.output),
    cacheRead: rate(CONFORMANCE_RATES.cacheRead),
    cacheWrite: rate(CONFORMANCE_RATES.cacheWrite),
  };
}

/**
 * A settled step with REAL money on it, priced against the harness's card.
 *
 * BUILT AS A LITERAL rather than through `openStep`/`settleStep`. Those are
 * domain factories on the CONTRACTS barrel — the peer-facing door — and an
 * adapter that reached through it would be a peer of the context it implements.
 * The shape is the port's own `Step`, so a field the domain adds turns this file
 * red at compile time rather than being silently omitted.
 */
function conformanceStep(
  ids: ConversationsConformanceIds,
  stepId: string,
  turnId: string,
  sequence: number,
  microCents: bigint,
): Step {
  return Object.freeze({
    stepId: asConversationsIdentifier<StepId>(stepId),
    turnId: asConversationsIdentifier<TurnId>(turnId),
    sequence,
    model: "anthropic:claude-test",
    status: "SUCCEEDED" as const,
    retryCount: 0,
    usage: Object.freeze({
      inputTokens: 1_000,
      outputTokens: 200,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      reasoningTokens: 0,
    }),
    cost: money(microCents),
    modelPriceId: asConversationsIdentifier<ModelPriceId>(ids.modelPriceId),
    rates: rateBook(),
    latencyMs: 1_000,
    error: null,
    startedAt: at(1_000),
    completedAt: at(2_000),
    createdAt: at(1_000),
  });
}

function conformanceThread(
  ids: ConversationsConformanceIds,
  threadId: string,
  offsetMs: number,
): Thread {
  return Object.freeze({
    threadId: asConversationsIdentifier<ThreadId>(threadId),
    agentId: asConversationsIdentifier<AgentId>(ids.agentId),
    endUserId: asConversationsIdentifier<EndUserId>(ids.endUserId),
    clusterId: asConversationsIdentifier<ClusterId>(ids.clusterId),
    parentThreadId: null,
    forkedUpToTurnId: null,
    forkedTurnIds: Object.freeze([]),
    compactedUpToTurnId: null,
    title: "the conversation",
    status: "ACTIVE" as const,
    summary: null,
    compactionState: "IDLE" as const,
    compactedAt: null,
    sessionContext: Object.freeze({ channel: "web" }),
    tags: Object.freeze(["support"]),
    pinnedAt: null,
    archivedAt: null,
    createdAt: at(offsetMs),
    updatedAt: at(offsetMs),
  });
}

function conformanceTurn(
  ids: ConversationsConformanceIds,
  turnId: string,
  sequence: number,
  overrides: Partial<Turn> = {},
): Turn {
  return Object.freeze({
    turnId: asConversationsIdentifier<TurnId>(turnId),
    threadId: asConversationsIdentifier<ThreadId>(ids.threadId),
    parentTurnId: null,
    agentVersionId: asConversationsIdentifier<AgentVersionId>(ids.agentVersionId),
    versionBucket: "CURRENT" as const,
    sequence,
    inputText: "what is the refund window",
    outputText: null,
    input: null,
    output: null,
    thinkingContent: null,
    status: "PENDING" as const,
    externalRuntimeId: null,
    idempotencyKey: null,
    cost: rollUpTurnCost([]),
    usage: sumStepUsage([]),
    latencyMs: null,
    startedAt: null,
    completedAt: null,
    createdAt: at(10_000 + sequence),
    ...overrides,
  });
}

/** The settled form of a turn: status, output and the rollup over its steps. */
function settledTurn(turn: Turn, steps: readonly Step[]): Turn {
  return Object.freeze({
    ...turn,
    status: "SUCCEEDED" as const,
    outputText: "thirty days",
    cost: rollUpTurnCost(steps),
    usage: sumStepUsage(steps.map((step) => step.usage)),
    latencyMs: 30_000,
    completedAt: at(30_000),
  });
}

function conformanceExecution(ids: ConversationsConformanceIds): PostmanExecution {
  return Object.freeze({
    executionId: asConversationsIdentifier<PostmanExecutionId>(ids.executionId),
    agentId: asConversationsIdentifier<AgentId>(ids.agentId),
    templateId: asConversationsIdentifier<PostmanTemplateId>(ids.templateId),
    requestId: ids.requestId,
    // 64 lowercase hex, because `PostmanExecution_requestFingerprint_check` says
    // so and the double would take any string at all.
    requestFingerprint: "a".repeat(64),
    actorUserId: asConversationsIdentifier<ActorId>(ids.actorUserId),
    simulatedEndUserId: asConversationsIdentifier<EndUserId>(ids.endUserId),
    contextHandle: asConversationsIdentifier<PostmanContextHandle>(ids.contextHandle),
    contextExpiresAt: at(3_600_000),
    status: "PENDING" as const,
    threadId: null,
    turnId: null,
    completedAt: null,
    createdAt: at(20_000),
    updatedAt: at(20_000),
  });
}

/** A `Result`, reduced to what compares across two stores. */
function outcome<Value>(result: Result<Value>, project: (value: Value) => unknown): ConversationsObservation {
  if (result.ok) return { ok: true, value: project(result.value) };
  return {
    ok: false,
    code: result.error.code,
    category: result.error.category,
  };
}

/** A thread, reduced to the fields both stores can be asked for. */
function projectThread(thread: Thread | null): unknown {
  if (thread === null) return null;
  return {
    threadId: thread.threadId,
    agentId: thread.agentId,
    endUserId: thread.endUserId,
    clusterId: thread.clusterId,
    parentThreadId: thread.parentThreadId,
    forkedTurnIds: [...thread.forkedTurnIds],
    compactedUpToTurnId: thread.compactedUpToTurnId,
    title: thread.title,
    status: thread.status,
    summary: thread.summary,
    compactionState: thread.compactionState,
    sessionContext: thread.sessionContext,
    tags: [...thread.tags],
    archived: thread.archivedAt !== null,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

/**
 * A turn, reduced — and `cost` and `usage` are in the projection deliberately.
 *
 * They are the six numbers the `Turn` row has no columns for, rolled up from the
 * step rows on one side and kept in a `Map` on the other. If the real store's
 * rollup ever stopped matching the double's stored object, this is the step that
 * would say so.
 */
function projectTurn(turn: Turn | null): unknown {
  if (turn === null) return null;
  return {
    turnId: turn.turnId,
    threadId: turn.threadId,
    parentTurnId: turn.parentTurnId,
    agentVersionId: turn.agentVersionId,
    versionBucket: turn.versionBucket,
    sequence: turn.sequence,
    inputText: turn.inputText,
    outputText: turn.outputText,
    status: turn.status,
    idempotencyKey: turn.idempotencyKey,
    costMicroCents: turn.cost.amount.microCents.toString(),
    stepCount: turn.cost.stepCount,
    unpricedSteps: turn.cost.unpricedSteps,
    costComplete: turn.cost.complete,
    usage: { ...turn.usage },
    latencyMs: turn.latencyMs,
    createdAt: turn.createdAt.toISOString(),
  };
}

function projectStep(step: Step): unknown {
  return {
    stepId: step.stepId,
    turnId: step.turnId,
    sequence: step.sequence,
    model: step.model,
    status: step.status,
    retryCount: step.retryCount,
    usage: { ...step.usage },
    costMicroCents: step.cost === null ? null : step.cost.microCents.toString(),
    modelPriceId: step.modelPriceId,
    inputRate: step.rates.input?.usdPerToken ?? null,
    inputRateSource: step.rates.input?.source ?? null,
    cacheWriteRate: step.rates.cacheWrite?.usdPerToken ?? null,
    error: step.error,
  };
}

function projectExecution(execution: PostmanExecution | null): unknown {
  if (execution === null) return null;
  return {
    executionId: execution.executionId,
    agentId: execution.agentId,
    templateId: execution.templateId,
    requestId: execution.requestId,
    requestFingerprint: execution.requestFingerprint,
    actorUserId: execution.actorUserId,
    simulatedEndUserId: execution.simulatedEndUserId,
    contextHandle: execution.contextHandle,
    status: execution.status,
    threadId: execution.threadId,
    turnId: execution.turnId,
    createdAt: execution.createdAt.toISOString(),
  };
}

/**
 * Drive the whole scenario and record what came back.
 *
 * The order is a real conversation's: open two threads, allocate and insert two
 * turns, settle one of them with two priced steps, read it back every way the
 * ports allow, take the compaction lock twice, launch an operator execution and
 * settle it, then plan and carry out an erasure.
 */
export async function runConversationsConformance(
  environment: ConversationsConformanceEnvironment,
): Promise<ConversationsObservation> {
  const { stores, scope, ids } = environment;
  const observed: ConversationsObservation = {};
  const threadId = asConversationsIdentifier<ThreadId>(ids.threadId);
  const secondThreadId = asConversationsIdentifier<ThreadId>(ids.secondThreadId);
  const firstTurnId = asConversationsIdentifier<TurnId>(ids.firstTurnId);
  const absentThread = asConversationsIdentifier<ThreadId>(ids.absentId);

  // ---- threads ------------------------------------------------------------

  observed["findThread.absent"] = outcome(
    await stores.threads.findThread(scope, absentThread),
    projectThread,
  );

  // SECOND THREAD FIRST, and with the LATER instant. The real store lists by
  // `updatedAt DESC` and the double lists in insertion order; seeding the newest
  // first is what makes those the same sequence, so the page below compares
  // verbatim rather than being sorted into agreement by the comparison.
  observed["createThread.second"] = outcome(
    await stores.threads.createThread(scope, conformanceThread(ids, ids.secondThreadId, 2_000)),
    projectThread,
  );
  observed["createThread.first"] = outcome(
    await stores.threads.createThread(scope, conformanceThread(ids, ids.threadId, 1_000)),
    projectThread,
  );
  observed["findThread.present"] = outcome(
    await stores.threads.findThread(scope, threadId),
    projectThread,
  );

  const listed = await stores.threads.pageThreads({
    scope,
    endUserId: asConversationsIdentifier<EndUserId>(ids.endUserId),
    limit: 10,
    offset: 0,
    includeArchived: false,
  });
  observed["pageThreads.bySubject"] = outcome(listed, (page) => ({
    total: page.total,
    ids: page.items.map((thread) => thread.threadId),
  }));

  observed["countForks"] = outcome(await stores.threads.countForks(scope, threadId), (n) => n);
  observed["measureForkDepth.root"] = outcome(
    await stores.threads.measureForkDepth(scope, threadId),
    (n) => n,
  );
  observed["countTurns.empty"] = outcome(await stores.threads.countTurns(scope, threadId), (n) => n);

  // ---- turns --------------------------------------------------------------

  observed["allocateTurnSequence.first"] = outcome(
    await stores.threads.allocateTurnSequence(scope, threadId),
    (n) => n,
  );
  observed["createTurn.first"] = outcome(
    await stores.turns.createTurn(scope, conformanceTurn(ids, ids.firstTurnId, 1)),
    projectTurn,
  );
  observed["allocateTurnSequence.second"] = outcome(
    await stores.threads.allocateTurnSequence(scope, threadId),
    (n) => n,
  );
  observed["createTurn.second"] = outcome(
    await stores.turns.createTurn(
      scope,
      conformanceTurn(ids, ids.secondTurnId, 2, {
        idempotencyKey: asConversationsIdentifier<IdempotencyKey>("delivery-7"),
      }),
    ),
    projectTurn,
  );
  // A REPLY TURN, so `includeSubThreads` has something to include and something
  // to leave out. It hangs off the first turn, which is what makes it a reply.
  observed["createTurn.reply"] = outcome(
    await stores.turns.createTurn(
      scope,
      conformanceTurn(ids, ids.replyTurnId, 3, { parentTurnId: firstTurnId }),
    ),
    projectTurn,
  );

  observed["createTurn.sequenceTaken"] = outcome(
    await stores.turns.createTurn(scope, conformanceTurn(ids, ids.absentId, 1)),
    projectTurn,
  );

  observed["findTurnByIdempotencyKey.hit"] = outcome(
    await stores.turns.findTurnByIdempotencyKey(
      scope,
      threadId,
      asConversationsIdentifier<IdempotencyKey>("delivery-7"),
    ),
    projectTurn,
  );
  observed["findTurnByIdempotencyKey.miss"] = outcome(
    await stores.turns.findTurnByIdempotencyKey(
      scope,
      threadId,
      asConversationsIdentifier<IdempotencyKey>("delivery-8"),
    ),
    projectTurn,
  );

  // ---- the settlement, with real money on it ------------------------------

  const steps = [
    conformanceStep(ids, ids.firstStepId, ids.firstTurnId, 1, 4_500_000n),
    conformanceStep(ids, ids.secondStepId, ids.firstTurnId, 2, 1_250_000n),
  ];
  const settled = settledTurn(conformanceTurn(ids, ids.firstTurnId, 1), steps);
  observed["saveSettlement"] = outcome(
    await stores.turns.saveSettlement(scope, { turn: settled, steps }),
    (value) => ({ turn: projectTurn(value.turn), steps: value.steps.map(projectStep) }),
  );
  // THE ROLLUP IS ASSERTED ON BOTH SIDES rather than trusted: the sum of the two
  // steps is 5,750,000 micro-cents and both stores must answer it, one from a
  // stored object and one from the `Step` rows it just wrote.
  observed["saveSettlement.rollup"] = {
    microCents: rollUpTurnCost(steps).amount.microCents.toString(),
    usage: { ...sumStepUsage(steps.map((step) => step.usage)) },
  };

  observed["findTurn.settled"] = outcome(
    await stores.turns.findTurn(scope, firstTurnId),
    projectTurn,
  );
  observed["findTurnWithSteps"] = outcome(
    await stores.turns.findTurnWithSteps(scope, firstTurnId),
    (value) =>
      value === null ? null : { turn: projectTurn(value.turn), steps: value.steps.map(projectStep) },
  );
  observed["findTurnWithSteps.absent"] = outcome(
    await stores.turns.findTurnWithSteps(scope, asConversationsIdentifier<TurnId>(ids.absentId)),
    (value) => value,
  );

  observed["pageTurns.transcript"] = outcome(
    await stores.turns.pageTurns({
      scope,
      threadId,
      limit: 10,
      offset: 0,
      includeSubThreads: false,
    }),
    (page) => ({ total: page.total, ids: page.items.map((turn) => turn.turnId) }),
  );
  observed["pageTurns.withReplies"] = outcome(
    await stores.turns.pageTurns({
      scope,
      threadId,
      limit: 10,
      offset: 0,
      includeSubThreads: true,
    }),
    (page) => ({ total: page.total, ids: page.items.map((turn) => turn.turnId) }),
  );

  observed["countToolCalls"] = outcome(
    await stores.turns.countToolCalls(scope, [
      firstTurnId,
      asConversationsIdentifier<TurnId>(ids.absentId),
    ]),
    (counts) => [...counts.entries()].sort(),
  );

  observed["countTurns.afterInserts"] = outcome(
    await stores.threads.countTurns(scope, threadId),
    (n) => n,
  );

  observed["findInheritedTurns.ordered"] = outcome(
    await stores.threads.findInheritedTurns(scope, [
      asConversationsIdentifier<TurnId>(ids.secondTurnId),
      firstTurnId,
      asConversationsIdentifier<TurnId>(ids.absentId),
    ]),
    (turns) => turns.map((turn) => turn.turnId),
  );

  // ---- the compaction lock ------------------------------------------------

  observed["acquireCompactionLock.first"] = outcome(
    await stores.threads.acquireCompactionLock(scope, threadId),
    (taken) => taken,
  );
  observed["acquireCompactionLock.second"] = outcome(
    await stores.threads.acquireCompactionLock(scope, threadId),
    (taken) => taken,
  );
  observed["acquireCompactionLock.absent"] = outcome(
    await stores.threads.acquireCompactionLock(scope, absentThread),
    (taken) => taken,
  );

  // THE SECOND THREAD IS THE ONE ARCHIVED, and which one is not arbitrary. The
  // real store lists by `updatedAt DESC` and the double in insertion order; the
  // second thread was created FIRST and carries the LATER instant, so stamping
  // it again with the latest instant of all keeps it first on both sides.
  // Archiving the other one would have moved it to the head of the real store's
  // listing and left it at the tail of the double's, and the differential would
  // then be reporting the fixture's own ordering rather than a divergence.
  const archivable = await stores.threads.findThread(scope, secondThreadId);
  if (!archivable.ok || archivable.value === null) throw new Error("the thread went missing");
  observed["saveThread.archived"] = outcome(
    await stores.threads.saveThread(scope, {
      ...archivable.value,
      summary: "the subject asked about refunds",
      archivedAt: at(40_000),
      updatedAt: at(40_000),
    }),
    projectThread,
  );
  observed["pageThreads.excludesArchived"] = outcome(
    await stores.threads.pageThreads({
      scope,
      endUserId: null,
      limit: 10,
      offset: 0,
      includeArchived: false,
    }),
    (page) => ({ total: page.total, ids: page.items.map((thread) => thread.threadId) }),
  );
  observed["pageThreads.includesArchived"] = outcome(
    await stores.threads.pageThreads({
      scope,
      endUserId: null,
      limit: 10,
      offset: 0,
      includeArchived: true,
    }),
    (page) => ({ total: page.total, ids: page.items.map((thread) => thread.threadId) }),
  );

  // THE SECOND HALF RUNS FROM ITS OWN MODULE and writes into THIS observation
  // map. `max-file-lines` bit at the hard error and the seam it pointed at is
  // real: everything above is a CONVERSATION — threads, turns, steps, the
  // compaction lock — and everything after it is the OPERATOR'S execution and
  // the ERASURE that severs it. Both halves are one transcript, so the
  // differential still compares one object per store.
  await runErasureConformance(environment, observed);
  return observed;
}
