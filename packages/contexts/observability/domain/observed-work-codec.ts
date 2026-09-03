// Reading a finalized Turn out of an envelope payload.
//
// THE ENVELOPE'S SCOPE IS AUTHORITATIVE, AND THE PAYLOAD DOES NOT CARRY ONE.
// The kernel envelope already states which tenant the event belongs to, and it
// is stamped by the outbox adapter inside the producer's transaction. Reading a
// second scope out of the payload would create two answers to "whose row is
// this?", and the projection is keyed by exactly those three columns. So every
// part of the Turn inherits the one scope, and a Step cannot be filed under
// another tenant however the payload is spelled.
//
// UNKNOWN FIELDS ARE IGNORED (M0.4 §1.1). A producer on a newer binary may send
// keys this reader has never heard of; nothing below enumerates the payload's
// own keys, so those cost nothing. What is NOT ignored is a required field that
// is absent or the wrong type — that is a producer defect, and the envelope is
// parked with the field named rather than projected with a fabricated value.

import { asIdentifier, type Branded, type EnvironmentScope } from "@platos/kernel";

import { asArray, asFiniteNumber, asInstant, asMember, asObject, asText, type JsonObject } from "./json-read.js";
import type { ObservedAttributes } from "./attributes.js";
import { ATTRIBUTE_ALLOW_LIST } from "./attributes.js";
import type {
  AgentId,
  AgentVersionId,
  EndUserId,
  SkillId,
  SpanId,
  StepId,
  SubjectKeyHash,
  ThreadId,
  ToolCallId,
  ToolId,
  TraceId,
  TurnId,
  UsageEventId,
} from "./identifiers.js";
import {
  OBSERVED_STATUSES,
  TOOL_CALL_STATUSES,
  USAGE_KINDS,
  type ObservedRuntime,
  type ObservedSubject,
  type ObservedTrace,
  type StepObserved,
  type ToolCallObserved,
  type TurnObserved,
  type TurnWork,
  type UsageObserved,
} from "./observed-work.js";
import type { ObservedRates, ObservedTokens } from "./token-lanes.js";

/** A named reason one payload could not be read. */
export interface CodecFailure {
  readonly field: string;
  readonly reason: string;
}

export type CodecResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly failure: CodecFailure };

function fail<Value>(field: string, reason: string): CodecResult<Value> {
  return { ok: false, failure: { field, reason } };
}

function succeed<Value>(value: Value): CodecResult<Value> {
  return { ok: true, value };
}

function optionalText(source: JsonObject, key: string): string | null {
  return asText(source[key]) ?? null;
}

function optionalNumber(source: JsonObject, key: string): number | null {
  return asFiniteNumber(source[key]) ?? null;
}

/**
 * An optional branded id.
 *
 * `asIdentifier` is a compile-time assertion, not validation, so the provenance
 * check is `asText` above it: a blank string never becomes an id, because a
 * blank id is the value that widens an erasure predicate to a whole tenant.
 */
function optionalId<Id extends Branded<string, string>>(source: JsonObject, key: string): Id | null {
  const value = asText(source[key]);
  return value === undefined ? null : asIdentifier<Id>(value);
}

function readSubject(value: unknown): ObservedSubject | undefined {
  const source = asObject(value);
  if (!source) return undefined;
  return {
    endUserId: optionalId<EndUserId>(source, "endUserId"),
    subjectKeyHash: optionalId<SubjectKeyHash>(source, "subjectKeyHash"),
    userDisplayName: optionalText(source, "userDisplayName"),
    userEmail: optionalText(source, "userEmail"),
  };
}

function readTrace(value: unknown): ObservedTrace | undefined {
  const source = asObject(value);
  if (!source) return undefined;
  return {
    traceId: optionalId<TraceId>(source, "traceId"),
    spanId: optionalId<SpanId>(source, "spanId"),
    parentSpanId: optionalId<SpanId>(source, "parentSpanId"),
  };
}

function readRuntime(value: unknown): ObservedRuntime | undefined {
  const source = asObject(value);
  if (!source) return undefined;
  return {
    runtimeProvider: optionalText(source, "runtimeProvider"),
    runtimeRunId: optionalText(source, "runtimeRunId"),
  };
}

function readTokens(value: unknown): ObservedTokens | undefined {
  const source = asObject(value);
  if (!source) return undefined;
  return {
    inputTokens: optionalNumber(source, "inputTokens"),
    outputTokens: optionalNumber(source, "outputTokens"),
    cacheReadInputTokens: optionalNumber(source, "cacheReadInputTokens"),
    cacheWriteInputTokens: optionalNumber(source, "cacheWriteInputTokens"),
    reasoningTokens: optionalNumber(source, "reasoningTokens"),
  };
}

function readRates(value: unknown): ObservedRates | undefined {
  const source = asObject(value);
  if (!source) return undefined;
  return {
    pricingSource: optionalText(source, "pricingSource"),
    pricingVersion: optionalText(source, "pricingVersion"),
    inputUsdPerToken: optionalNumber(source, "inputUsdPerToken"),
    outputUsdPerToken: optionalNumber(source, "outputUsdPerToken"),
    cacheReadUsdPerToken: optionalNumber(source, "cacheReadUsdPerToken"),
    cacheWriteUsdPerToken: optionalNumber(source, "cacheWriteUsdPerToken"),
  };
}

/**
 * Attributes, filtered to the allow-list at the READ boundary as well as the
 * write one.
 *
 * Belt and braces on purpose: `attributesJson` iterates the allow-list so an
 * unknown key could not reach a column anyway, but a payload carrying one has
 * told us something about its producer, and it costs nothing to refuse to
 * carry it any further than this function.
 */
function readAttributes(value: unknown): ObservedAttributes | undefined {
  const source = asObject(value);
  if (!source) return undefined;
  const attributes: Record<string, string | number | boolean> = {};
  for (const key of ATTRIBUTE_ALLOW_LIST) {
    const candidate = source[key];
    if (typeof candidate === "string" || typeof candidate === "boolean") attributes[key] = candidate;
    else if (typeof candidate === "number" && Number.isFinite(candidate)) attributes[key] = candidate;
  }
  return attributes as ObservedAttributes;
}

function readTurn(source: JsonObject, scope: EnvironmentScope): CodecResult<TurnObserved> {
  const turnId = asText(source.turnId);
  if (turnId === undefined) return fail("turn.turnId", "required");
  const threadId = asText(source.threadId);
  if (threadId === undefined) return fail("turn.threadId", "required");
  const agentId = asText(source.agentId);
  if (agentId === undefined) return fail("turn.agentId", "required");
  const status = asMember(source.status, OBSERVED_STATUSES);
  if (status === undefined) return fail("turn.status", "must be completed, failed, or cancelled");
  const acceptedAt = asInstant(source.acceptedAt);
  if (acceptedAt === undefined) return fail("turn.acceptedAt", "required instant");
  const completedAt = asInstant(source.completedAt);
  if (completedAt === undefined) return fail("turn.completedAt", "required instant");

  return succeed({
    scope,
    turnId: asIdentifier(turnId),
    threadId: asIdentifier(threadId),
    agentId: asIdentifier(agentId),
    agentVersionId:
      optionalId<AgentVersionId>(source, "agentVersionId"),
    subject: readSubject(source.subject),
    trace: readTrace(source.trace),
    status,
    acceptedAt,
    completedAt,
    stepCount: asFiniteNumber(source.stepCount) ?? 0,
    toolCallCount: asFiniteNumber(source.toolCallCount) ?? 0,
    tokens: readTokens(source.tokens),
    costCents: optionalNumber(source, "costCents"),
    providerReportedCostUsd: optionalNumber(source, "providerReportedCostUsd"),
    errorCode: optionalText(source, "errorCode"),
    errorClass: optionalText(source, "errorClass"),
    runtime: readRuntime(source.runtime),
  });
}

function readStep(source: JsonObject, scope: EnvironmentScope, index: number): CodecResult<StepObserved> {
  const at = (field: string): string => `steps[${index}].${field}`;
  const stepId = asText(source.stepId);
  if (stepId === undefined) return fail(at("stepId"), "required");
  const turnId = asText(source.turnId);
  if (turnId === undefined) return fail(at("turnId"), "required");
  const status = asMember(source.status, OBSERVED_STATUSES);
  if (status === undefined) return fail(at("status"), "must be completed, failed, or cancelled");
  const startedAt = asInstant(source.startedAt);
  if (startedAt === undefined) return fail(at("startedAt"), "required instant");
  const completedAt = asInstant(source.completedAt);
  if (completedAt === undefined) return fail(at("completedAt"), "required instant");

  return succeed({
    scope,
    stepId: asIdentifier(stepId),
    turnId: asIdentifier(turnId),
    threadId: asIdentifier<ThreadId>(asText(source.threadId) ?? ""),
    agentId: asIdentifier<AgentId>(asText(source.agentId) ?? ""),
    subject: readSubject(source.subject),
    sequence: asFiniteNumber(source.sequence) ?? 0,
    provider: asText(source.provider) ?? "",
    model: asText(source.model) ?? "",
    status,
    startedAt,
    completedAt,
    trace: readTrace(source.trace),
    tokens: readTokens(source.tokens),
    rates: readRates(source.rates),
    costCents: optionalNumber(source, "costCents"),
    providerReportedCostUsd: optionalNumber(source, "providerReportedCostUsd"),
    errorCode: optionalText(source, "errorCode"),
    errorClass: optionalText(source, "errorClass"),
    errorMessageRedacted: optionalText(source, "errorMessageRedacted"),
    attributes: readAttributes(source.attributes),
  });
}

function readToolCall(source: JsonObject, scope: EnvironmentScope, index: number): CodecResult<ToolCallObserved> {
  const at = (field: string): string => `toolCalls[${index}].${field}`;
  const toolCallId = asText(source.toolCallId);
  if (toolCallId === undefined) return fail(at("toolCallId"), "required");
  const stepId = asText(source.stepId);
  if (stepId === undefined) return fail(at("stepId"), "required");
  const turnId = asText(source.turnId);
  if (turnId === undefined) return fail(at("turnId"), "required");
  const toolName = asText(source.toolName);
  if (toolName === undefined) return fail(at("toolName"), "required");
  const status = asMember(source.status, TOOL_CALL_STATUSES);
  if (status === undefined) return fail(at("status"), "must be completed, failed, cancelled, or denied");
  const startedAt = asInstant(source.startedAt);
  if (startedAt === undefined) return fail(at("startedAt"), "required instant");
  const completedAt = asInstant(source.completedAt);
  if (completedAt === undefined) return fail(at("completedAt"), "required instant");

  return succeed({
    scope,
    toolCallId: asIdentifier(toolCallId),
    stepId: asIdentifier(stepId),
    turnId: asIdentifier(turnId),
    threadId: asIdentifier<ThreadId>(asText(source.threadId) ?? ""),
    agentId: asIdentifier<AgentId>(asText(source.agentId) ?? ""),
    subject: readSubject(source.subject),
    sequence: asFiniteNumber(source.sequence) ?? 0,
    entityId: optionalText(source, "entityId"),
    toolId: optionalId<ToolId>(source, "toolId"),
    toolName,
    status,
    startedAt,
    completedAt,
    trace: readTrace(source.trace),
    retryCount: asFiniteNumber(source.retryCount) ?? 0,
    requestBytes: asFiniteNumber(source.requestBytes) ?? 0,
    responseBytes: asFiniteNumber(source.responseBytes) ?? 0,
    errorCode: optionalText(source, "errorCode"),
    errorClass: optionalText(source, "errorClass"),
    errorMessageRedacted: optionalText(source, "errorMessageRedacted"),
    attributes: readAttributes(source.attributes),
  });
}

function readUsage(source: JsonObject, scope: EnvironmentScope, index: number): CodecResult<UsageObserved> {
  const at = (field: string): string => `usage[${index}].${field}`;
  const usageEventId = asText(source.usageEventId);
  if (usageEventId === undefined) return fail(at("usageEventId"), "required");
  const agentId = asText(source.agentId);
  if (agentId === undefined) return fail(at("agentId"), "required");
  const usageKind = asMember(source.usageKind, USAGE_KINDS);
  if (usageKind === undefined) return fail(at("usageKind"), "must be a known usage kind");
  const occurredAt = asInstant(source.occurredAt);
  if (occurredAt === undefined) return fail(at("occurredAt"), "required instant");

  return succeed({
    scope,
    usageEventId: asIdentifier(usageEventId),
    turnId: optionalId<TurnId>(source, "turnId"),
    stepId: optionalId<StepId>(source, "stepId"),
    toolCallId:
      optionalId<ToolCallId>(source, "toolCallId"),
    threadId: optionalId<ThreadId>(source, "threadId"),
    agentId: asIdentifier(agentId),
    subject: readSubject(source.subject),
    usageKind,
    provider: asText(source.provider) ?? "",
    model: optionalText(source, "model"),
    skillId: optionalId<SkillId>(source, "skillId"),
    toolName: optionalText(source, "toolName"),
    occurredAt,
    tokens: readTokens(source.tokens),
    rates: readRates(source.rates),
    inputUnits: optionalNumber(source, "inputUnits"),
    outputUnits: optionalNumber(source, "outputUnits"),
    unitType: optionalText(source, "unitType"),
    inputUnitPriceUsd: optionalNumber(source, "inputUnitPriceUsd"),
    outputUnitPriceUsd: optionalNumber(source, "outputUnitPriceUsd"),
    costCents: optionalNumber(source, "costCents"),
    providerReportedCostUsd: optionalNumber(source, "providerReportedCostUsd"),
    trace: readTrace(source.trace),
    runtime: readRuntime(source.runtime),
  });
}

function readList<Value>(
  value: unknown,
  field: string,
  read: (source: JsonObject, index: number) => CodecResult<Value>,
): CodecResult<Value[]> {
  if (value === undefined || value === null) return succeed([]);
  const entries = asArray(value);
  if (entries === undefined) return fail(field, "must be an array when present");
  const out: Value[] = [];
  for (const [index, entry] of entries.entries()) {
    const source = asObject(entry);
    if (!source) return fail(`${field}[${index}]`, "must be an object");
    const read1 = read(source, index);
    if (!read1.ok) return { ok: false, failure: read1.failure };
    out.push(read1.value);
  }
  return succeed(out);
}

/**
 * Read a finalized Turn's work from a payload, under one authoritative scope.
 *
 * The `turn` member is required and the three lists are optional: a Turn that
 * called no tool really does have no tool calls, and demanding an empty array
 * would make an absent list and an empty list two different producer defects.
 */
export function readTurnWork(payload: unknown, scope: EnvironmentScope): CodecResult<TurnWork> {
  const source = asObject(payload);
  if (!source) return fail("payload", "must be a JSON object");
  const turnSource = asObject(source.turn);
  if (!turnSource) return fail("turn", "required object");

  const turn = readTurn(turnSource, scope);
  if (!turn.ok) return { ok: false, failure: turn.failure };
  const steps = readList(source.steps, "steps", (entry, index) => readStep(entry, scope, index));
  if (!steps.ok) return { ok: false, failure: steps.failure };
  const toolCalls = readList(source.toolCalls, "toolCalls", (entry, index) => readToolCall(entry, scope, index));
  if (!toolCalls.ok) return { ok: false, failure: toolCalls.failure };
  const usage = readList(source.usage, "usage", (entry, index) => readUsage(entry, scope, index));
  if (!usage.ok) return { ok: false, failure: usage.failure };

  return succeed({ turn: turn.value, steps: steps.value, toolCalls: toolCalls.value, usage: usage.value });
}
