/**
 * From what the finalizing transaction knows, to what the projection stores.
 *
 * Kept out of ConversationService so the mapping is testable on its own, and so
 * the persistence path's diff stays small enough to read: everything the write
 * path gains is one call.
 *
 * IDENTITY IS ASSEMBLED HERE, ONCE. `subject_key_hash` uses the same salt and
 * the same primitive as the erasure receipt, because the two have to agree —
 * a projection hashed differently from the register is a projection erasure
 * cannot find. The plaintext name and email are copied ONLY from
 * `scope.signedUserMeta`, which the auth layer sets from a validated entity
 * JWT and from nothing else; nothing derives them from a thread, a message, a
 * channel handle, or a Postgres row.
 *
 * WHY NOT `scope.sessionContext.user`, WHICH HOLDS THE SAME VALUES
 *
 * Because it holds MORE than the same values. That bag is the prompt
 * substitution surface, and by the time a turn finalizes it has been merged
 * three ways: the JWT's userMeta, the Thread row's stored context, and — on
 * every turn — a base layer `AgentService.stream` reads out of the Postgres
 * `User` table so `{{user.name}}` always resolves. On the operator path
 * `scope.userId` IS a Platos `User.id`, so reading identity out of the merged
 * bag wrote the OPERATOR'S real name and email into `turns_v1` for every
 * dashboard and playground turn — a class of identity CLICKHOUSE_ERASURE_PLAN
 * can never reach, because it addresses rows only by end-user keys. The WS
 * gateway's `sessionContextOverride` merges into the same bag.
 */

import { createHash } from "crypto";
import { erasureHashSalt } from "../privacy/erasure-register";
import { subjectKeyHash } from "../privacy/subject-graph";
import type {
  ObservabilityAttributes,
  ObservabilityScope,
  ObservabilityStatus,
  ObservabilitySubject,
  StepObserved,
  ToolCallObserved,
  ToolCallStatus,
  TurnProjection,
  UsageObserved,
} from "./observability-event";

/**
 * A stable id derived from another id.
 *
 * A usage event is one-to-one with the Step that produced it, and replaying a
 * delivery must not mint a second charge. Deriving the id rather than
 * generating one makes the insert idempotent all the way down: same Step, same
 * usage_event_id, one row after ReplacingMergeTree.
 *
 * Name-based like a v5 UUID, but over SHA-256, with the version and variant
 * bits set so ClickHouse's UUID parser and any downstream reader see a
 * well-formed value rather than 32 arbitrary hex characters.
 */
export function derivedUuid(namespace: string, value: string): string {
  const digest = createHash("sha256").update(`${namespace}\u0000${value}`).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x80; // version 8: custom, name-based
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** The scope fields the projection needs, and nothing else. */
export interface ProjectionScope extends ObservabilityScope {
  /** The acting external user id — what the erasure register hashes. */
  userId: string;
  /**
   * Plaintext identity an entity signed for. The ONLY source of
   * `user_display_name` / `user_email`; see the header for why the merged
   * `sessionContext.user` bag is not it.
   */
  signedUserMeta?: { name?: string; email?: string } | null;
}

/** Plaintext identity, but only when an entity actually signed for it. */
function signedIdentity(signed: ProjectionScope["signedUserMeta"]): {
  name?: string;
  email?: string;
} {
  if (!signed || typeof signed !== "object") return {};
  const record = signed as { name?: unknown; email?: unknown };
  return {
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.email === "string" ? { email: record.email } : {}),
  };
}

/**
 * Build the subject columns for one Turn.
 *
 * `endUserId` is the canonical EndUser id and is what erasure clears.
 * `subjectKeyHash` is content-free by construction and is what survives, so
 * "spend by user last quarter" keeps returning the same total after someone
 * exercises their right to be forgotten.
 */
export function projectionSubject(
  scope: ProjectionScope,
  endUserId: string | null | undefined,
  salt: string = erasureHashSalt(),
): ObservabilitySubject {
  const meta = signedIdentity(scope.signedUserMeta);
  return {
    endUserId: endUserId ?? "",
    subjectKeyHash: scope.userId
      ? subjectKeyHash(scope.userId, scope.organizationId, salt, (input) =>
          createHash("sha256").update(input).digest("hex"))
      : "",
    userDisplayName: meta.name ?? null,
    userEmail: meta.email ?? null,
  };
}

export interface ProjectionStep {
  id: string;
  sequence: number;
  model: string;
  /** Provider, when the caller knows it. Derived from `model` otherwise. */
  provider?: string | null;
  status: ObservabilityStatus;
  startedAt: Date;
  completedAt: Date;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  reasoningTokens?: number | null;
  costCents?: number | null;
  /** Frozen USD-per-token rates, and the ModelPrice row they came from. */
  modelPriceId?: string | null;
  inputRate?: number | null;
  outputRate?: number | null;
  cacheReadRate?: number | null;
  cacheWriteRate?: number | null;
  pricingSource?: string | null;
  errorClass?: string | null;
  errorMessageRedacted?: string | null;
  attributes?: ObservabilityAttributes;
}

export interface ProjectionToolCall {
  id: string;
  stepId: string;
  sequence: number;
  toolName: string;
  toolId?: string | null;
  entityId?: string | null;
  status: ToolCallStatus;
  startedAt: Date;
  completedAt: Date;
  retryCount?: number;
  requestBytes?: number;
  responseBytes?: number;
  errorClass?: string | null;
  errorMessageRedacted?: string | null;
}

export interface ProjectionTurn {
  id: string;
  agentVersionId?: string | null;
  status: ObservabilityStatus;
  acceptedAt: Date;
  completedAt: Date;
  costCents?: number | null;
  errorCode?: string | null;
  errorClass?: string | null;
  traceId?: string | null;
  rootSpanId?: string | null;
  runtimeProvider?: string | null;
  runtimeRunId?: string | null;
}

export interface TurnProjectionInput {
  scope: ProjectionScope;
  thread: { id: string; agentId: string; endUserId?: string | null };
  turn: ProjectionTurn;
  steps?: ProjectionStep[];
  toolCalls?: ProjectionToolCall[];
  /** Overridable so a test does not depend on an installation's salt. */
  salt?: string;
}

/**
 * `anthropic:claude-x` and `openai/gpt-x` both name a provider; a bare model
 * key does not. Guessing beyond a delimiter would put a wrong low-cardinality
 * value in a column people group by.
 */
function providerFromModel(model: string): string {
  const match = /^([a-z0-9-]+)[:/]/i.exec(model.trim());
  return match ? match[1].toLowerCase() : "";
}

/**
 * Project one finalized Turn.
 *
 * Every Step also yields exactly one `inference` usage event, carrying the same
 * lanes and the same frozen rates. The other four usage lanes — embedding,
 * extraction, judge, skill — are produced elsewhere in the runtime today and
 * are not routed through this path yet; the schema holds them, the ingestion
 * for them is M3.2's.
 */
export function buildTurnProjection(input: TurnProjectionInput): TurnProjection {
  const scope: ObservabilityScope = {
    organizationId: input.scope.organizationId,
    projectId: input.scope.projectId,
    environmentId: input.scope.environmentId,
  };
  const subject = projectionSubject(input.scope, input.thread.endUserId, input.salt);
  const steps = input.steps ?? [];
  const toolCalls = input.toolCalls ?? [];
  const threadId = input.thread.id;
  const agentId = input.thread.agentId;

  const tokens = steps.reduce(
    (total, step) => ({
      inputTokens: total.inputTokens + (step.inputTokens ?? 0),
      outputTokens: total.outputTokens + (step.outputTokens ?? 0),
      cacheReadInputTokens: total.cacheReadInputTokens + (step.cacheReadInputTokens ?? 0),
      cacheWriteInputTokens: total.cacheWriteInputTokens + (step.cacheCreationInputTokens ?? 0),
      reasoningTokens: total.reasoningTokens + (step.reasoningTokens ?? 0),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      reasoningTokens: 0,
    },
  );

  const observedSteps: StepObserved[] = steps.map((step) => ({
    scope,
    stepId: step.id,
    turnId: input.turn.id,
    threadId,
    agentId,
    subject,
    sequence: step.sequence,
    provider: step.provider ?? providerFromModel(step.model),
    model: step.model,
    status: step.status,
    startedAt: step.startedAt,
    completedAt: step.completedAt,
    traceId: input.turn.traceId,
    tokens: {
      inputTokens: step.inputTokens,
      outputTokens: step.outputTokens,
      cacheReadInputTokens: step.cacheReadInputTokens,
      cacheWriteInputTokens: step.cacheCreationInputTokens,
      reasoningTokens: step.reasoningTokens,
    },
    rates: {
      pricingSource: step.pricingSource,
      pricingVersion: step.modelPriceId,
      inputUsdPerToken: step.inputRate,
      outputUsdPerToken: step.outputRate,
      cacheReadUsdPerToken: step.cacheReadRate,
      cacheWriteUsdPerToken: step.cacheWriteRate,
    },
    costCents: step.costCents,
    errorClass: step.errorClass,
    errorMessageRedacted: step.errorMessageRedacted,
    attributes: step.attributes,
  }));

  const observedToolCalls: ToolCallObserved[] = toolCalls.map((call) => ({
    scope,
    toolCallId: call.id,
    stepId: call.stepId,
    turnId: input.turn.id,
    threadId,
    agentId,
    subject,
    sequence: call.sequence,
    entityId: call.entityId,
    toolId: call.toolId,
    toolName: call.toolName,
    status: call.status,
    startedAt: call.startedAt,
    completedAt: call.completedAt,
    traceId: input.turn.traceId,
    retryCount: call.retryCount,
    requestBytes: call.requestBytes,
    responseBytes: call.responseBytes,
    errorClass: call.errorClass,
    errorMessageRedacted: call.errorMessageRedacted,
  }));

  const usage: UsageObserved[] = observedSteps.map((step) => ({
    scope,
    usageEventId: derivedUuid("platos.usage.inference", step.stepId),
    turnId: step.turnId,
    stepId: step.stepId,
    threadId,
    agentId,
    subject,
    usageKind: "inference",
    provider: step.provider,
    model: step.model,
    occurredAt: step.completedAt,
    tokens: step.tokens,
    rates: step.rates,
    unitType: "tokens",
    costCents: step.costCents,
    traceId: input.turn.traceId,
    runtimeProvider: input.turn.runtimeProvider,
    runtimeRunId: input.turn.runtimeRunId,
  }));

  return {
    turn: {
      scope,
      turnId: input.turn.id,
      threadId,
      agentId,
      agentVersionId: input.turn.agentVersionId,
      subject,
      traceId: input.turn.traceId,
      rootSpanId: input.turn.rootSpanId,
      status: input.turn.status,
      acceptedAt: input.turn.acceptedAt,
      completedAt: input.turn.completedAt,
      stepCount: observedSteps.length,
      toolCallCount: observedToolCalls.length,
      tokens,
      costCents: input.turn.costCents,
      errorCode: input.turn.errorCode,
      errorClass: input.turn.errorClass,
      runtimeProvider: input.turn.runtimeProvider,
      runtimeRunId: input.turn.runtimeRunId,
    },
    steps: observedSteps,
    toolCalls: observedToolCalls,
    usage,
  };
}
