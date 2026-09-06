// The domain values the four `conversations` integration suites are written in,
// and the raw door they send SQL through.
//
// IT EXISTS BECAUSE `max-file-lines` BIT, and the seam it pointed at is real.
// Four suites over four tables each need a `Thread`, a `Turn`, a `Step` and a
// `PostmanExecution` of the right shape, and four copies of those builders is
// four chances for one of them to drift into a shape the database refuses —
// which is precisely the class of defect this tranche spent an integration run
// on. One copy, imported four times.
//
// EVERY BUILDER IS A FROZEN LITERAL RATHER THAN A DOMAIN FACTORY. `openThread`,
// `openTurn`, `openStep` and `settleStep` live on the context's CONTRACTS
// barrel, which is the peer-facing door, and an adapter that reached through it
// would be a peer of the context it implements. The shape is the port's own, so
// a field the domain adds turns these files red at compile time rather than
// being silently omitted.
//
// AND EVERY ONE TAKES ITS PEER CHAIN AS A PARAMETER. The `agentId`,
// `agentVersionId`, `endUserId` and `modelPriceId` a row hangs off are seeded
// per tenant, and `enforce_domain_ancestry` refuses a row that mixes two
// chains — so the cross-tenant proofs build their fixtures from the FOREIGN
// chain and the ordinary ones from this one, through the same builders.

import {
  asConversationsIdentifier,
  money,
  rollUpTurnCost,
  sumStepUsage,
  type ActorId,
  type AgentId,
  type AgentVersionId,
  type EndUserId,
  type ModelPriceId,
  type PostmanContextHandle,
  type PostmanExecution,
  type PostmanExecutionId,
  type Step,
  type StepId,
  type StepRateBook,
  type Thread,
  type ThreadId,
  type Turn,
  type TurnId,
} from "@platos/context-conversations/application/ports/index.js";

import type { ConversationsHarness, PeerChain } from "./conversations-harness.js";
import { CONFORMANCE_RATES, RATE_OBSERVED_AT, RATE_SOURCE, RATE_SOURCE_REF } from "./conversations-harness.js";

/** The one instant every fixture row is stamped with, so nothing is time-dependent. */
export const AT = new Date("2026-05-01T09:00:00.000Z");

/**
 * The raw client, resolved at the call site.
 *
 * Typed structurally so no suite names a vendor type: `client.ts` is the one
 * file in the layout entitled to, and a second naming here would be a second
 * import of the ORM in a package whose whole point is having one.
 */
export function rawClient(harness: ConversationsHarness): {
  $executeRawUnsafe(text: string, ...values: unknown[]): Promise<number>;
} {
  return harness.base.client as unknown as {
    $executeRawUnsafe(text: string, ...values: unknown[]): Promise<number>;
  };
}

/** Run a statement that must be refused, and answer the message it was refused with. */
export async function refusedByDatabase(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the database accepted a write a rule forbids");
}

export function threadOf(
  link: PeerChain,
  threadId: string,
  overrides: Partial<Thread> = {},
): Thread {
  return Object.freeze({
    threadId: asConversationsIdentifier<ThreadId>(threadId),
    agentId: asConversationsIdentifier<AgentId>(link.agentId),
    endUserId: asConversationsIdentifier<EndUserId>(link.endUserId),
    clusterId: null,
    parentThreadId: null,
    forkedUpToTurnId: null,
    forkedTurnIds: Object.freeze([]),
    compactedUpToTurnId: null,
    title: null,
    status: "ACTIVE" as const,
    summary: null,
    compactionState: "IDLE" as const,
    compactedAt: null,
    sessionContext: null,
    tags: Object.freeze([]),
    pinnedAt: null,
    archivedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}

export function turnOf(
  link: PeerChain,
  turnId: string,
  threadId: string,
  sequence: number,
  overrides: Partial<Turn> = {},
): Turn {
  return Object.freeze({
    turnId: asConversationsIdentifier<TurnId>(turnId),
    threadId: asConversationsIdentifier<ThreadId>(threadId),
    parentTurnId: null,
    agentVersionId: asConversationsIdentifier<AgentVersionId>(link.agentVersionId),
    versionBucket: "CURRENT" as const,
    sequence,
    inputText: "hello",
    outputText: null,
    input: null,
    output: null,
    thinkingContent: null,
    status: "SUCCEEDED" as const,
    externalRuntimeId: null,
    idempotencyKey: null,
    cost: rollUpTurnCost([]),
    usage: sumStepUsage([]),
    latencyMs: null,
    startedAt: null,
    completedAt: null,
    createdAt: AT,
    ...overrides,
  });
}

/**
 * The four rates as the harness's own card holds them.
 *
 * `Step_price_snapshot` compares a step's sixteen rate columns to `ModelPrice`'s
 * and refuses the row if any one differs, so this reads the harness's constants
 * rather than restating them — a second copy would be a second chance for the
 * fixture and the card to drift apart in a digit no reader would spot.
 */
export function fullRates(): StepRateBook {
  const rate = (usdPerToken: string) => ({
    usdPerToken,
    source: RATE_SOURCE,
    observedAt: RATE_OBSERVED_AT,
    // NOT NULL, and that is `ModelPrice_rate_check` reaching through
    // `Step_price_snapshot`; see `RATE_SOURCE_REF` in the harness.
    sourceRef: RATE_SOURCE_REF,
  });
  return Object.freeze({
    input: rate(CONFORMANCE_RATES.input),
    output: rate(CONFORMANCE_RATES.output),
    cacheRead: rate(CONFORMANCE_RATES.cacheRead),
    cacheWrite: rate(CONFORMANCE_RATES.cacheWrite),
  });
}

/** An UNPRICED step: no cost, no card, no rates. What a failed call leaves. */
export function stepOf(stepId: string, turnId: string, overrides: Partial<Step> = {}): Step {
  return Object.freeze({
    stepId: asConversationsIdentifier<StepId>(stepId),
    turnId: asConversationsIdentifier<TurnId>(turnId),
    sequence: 1,
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
    cost: null,
    modelPriceId: null,
    rates: Object.freeze({ input: null, output: null, cacheRead: null, cacheWrite: null }),
    latencyMs: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt: AT,
    ...overrides,
  });
}

/** A settled, PRICED step, charged against the harness's own card. */
export function pricedStep(link: PeerChain, stepId: string, turnId: string): Step {
  return stepOf(stepId, turnId, {
    cost: money(4_500_000n),
    modelPriceId: asConversationsIdentifier<ModelPriceId>(link.modelPriceId),
    rates: fullRates(),
    latencyMs: 1_000,
    startedAt: AT,
    completedAt: AT,
  });
}

export function executionOf(
  link: PeerChain,
  ids: { readonly executionId: string; readonly requestId: string; readonly contextHandle: string },
  overrides: Partial<PostmanExecution> = {},
): PostmanExecution {
  return Object.freeze({
    executionId: asConversationsIdentifier<PostmanExecutionId>(ids.executionId),
    agentId: asConversationsIdentifier<AgentId>(link.agentId),
    templateId: null,
    requestId: ids.requestId,
    // 64 lowercase hex, because `PostmanExecution_requestFingerprint_check` says
    // so and every in-memory double would take any string at all.
    requestFingerprint: "c".repeat(64),
    actorUserId: asConversationsIdentifier<ActorId>(link.actorUserId),
    simulatedEndUserId: asConversationsIdentifier<EndUserId>(link.endUserId),
    contextHandle: asConversationsIdentifier<PostmanContextHandle>(ids.contextHandle),
    contextExpiresAt: AT,
    status: "PENDING" as const,
    threadId: null,
    turnId: null,
    completedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  });
}
