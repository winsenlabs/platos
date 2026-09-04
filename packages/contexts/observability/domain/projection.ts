// Observed work in, analytical rows out.
//
// Everything here is pure. The rows these functions return are EXACTLY the
// records the sink inserts and exactly what the queue stores — so the projection
// semantics are frozen at enqueue time, and a row delivered three days late
// still means what it meant when the Turn committed. The envelope's schema
// version is the pin for that shape (see `envelope.ts`).
//
// THREE PROPERTIES THIS MODULE EXISTS TO GET RIGHT
//
// 1. CACHE LANES ARE A SUBSET OF INPUT. `total_input_tokens` is what the
//    provider billed as input, INCLUSIVE of the cached slice, and `fresh` is
//    stored rather than derived. `token-lanes.ts` holds that arithmetic.
//
// 2. RATES ARE FROZEN, NOT LOOKED UP. Each Step carries the four rates that were
//    in force when it ran. Nothing here consults a catalogue.
//
// 3. NOTHING IDENTIFYING LEAKS THROUGH `attributes_json`. It is built from an
//    allow-list of scalar keys, never from a caller-supplied bag.
//
// `billable_unit` is absent from `turnRow` ON PURPOSE. The column is derived by
// the server from `status`, so no writer can disagree with it — which is the
// whole reason "one completed Turn is one billable unit" holds regardless of how
// many Steps or Tool Calls the Turn contained.

import { attributesJson } from "./attributes.js";
import {
  columnDateTime,
  decimal12,
  durationMs,
  identityText,
  nullableDecimal12,
  redacted,
  text,
  usdFromCents,
  usdPerMillion,
  uuidOrNil,
  wholeCount,
} from "./column-values.js";
import type { ProjectionRow, ProjectionRows } from "./projection-tables.js";
import type {
  ObservedRuntime,
  ObservedSubject,
  ObservedTrace,
  StepObserved,
  ToolCallObserved,
  TurnObserved,
  TurnWork,
  UsageObserved,
} from "./observed-work.js";
import { laneCosts, resolveLanes, type ObservedRates, type ResolvedLanes } from "./token-lanes.js";
import type { EnvironmentScope } from "@platos/kernel";

// ---------------------------------------------------------------------------
// Column groups
// ---------------------------------------------------------------------------

function scopeColumns(scope: EnvironmentScope): ProjectionRow {
  return {
    organization_id: scope.organizationId,
    project_id: scope.projectId,
    environment_id: scope.environmentId,
  };
}

/**
 * The two subject columns every table carries.
 *
 * Empty string, not null: the columns are `String DEFAULT ''`, and the erasure
 * residue check reads `coalesce(col, '') != ''`, so a null and a blank must mean
 * the same thing to it.
 */
function subjectColumns(subject: ObservedSubject | undefined): ProjectionRow {
  return {
    end_user_id: text(subject?.endUserId),
    subject_key_hash: text(subject?.subjectKeyHash),
  };
}

function rateColumns(rates: ObservedRates | undefined): ProjectionRow {
  return {
    pricing_source: text(rates?.pricingSource),
    pricing_version: text(rates?.pricingVersion),
    fresh_input_usd_per_million: usdPerMillion(rates?.inputUsdPerToken),
    cache_read_usd_per_million: usdPerMillion(rates?.cacheReadUsdPerToken),
    cache_write_usd_per_million: usdPerMillion(rates?.cacheWriteUsdPerToken),
    output_usd_per_million: usdPerMillion(rates?.outputUsdPerToken),
  };
}

function laneColumns(lanes: ResolvedLanes): ProjectionRow {
  return {
    total_input_tokens: lanes.totalInput,
    fresh_input_tokens: lanes.freshInput,
    cache_read_input_tokens: lanes.cacheRead,
    cache_write_input_tokens: lanes.cacheWrite,
    output_tokens: lanes.output,
    reasoning_tokens: lanes.reasoning,
  };
}

function traceColumns(trace: ObservedTrace | undefined): ProjectionRow {
  return {
    trace_id: text(trace?.traceId),
    span_id: text(trace?.spanId),
    parent_span_id: text(trace?.parentSpanId),
  };
}

function runtimeColumns(runtime: ObservedRuntime | undefined): ProjectionRow {
  return {
    runtime_provider: text(runtime?.runtimeProvider),
    runtime_run_id: text(runtime?.runtimeRunId),
  };
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

export function turnRow(event: TurnObserved): ProjectionRow {
  const lanes = resolveLanes(event.tokens);
  return {
    ...scopeColumns(event.scope),
    turn_id: uuidOrNil(event.turnId),
    thread_id: text(event.threadId),
    agent_id: text(event.agentId),
    agent_version_id: text(event.agentVersionId),
    ...subjectColumns(event.subject),
    // The two plaintext columns are Nullable and carry their own short expiry.
    // Blank collapses to null so "still carries identity" stays a question about
    // identity rather than about whitespace.
    user_display_name: identityText(event.subject?.userDisplayName),
    user_email: identityText(event.subject?.userEmail),
    trace_id: text(event.trace?.traceId),
    // A Turn has a root span, not a parent one: it is the top of its own trace.
    root_span_id: text(event.trace?.spanId),
    status: event.status,
    accepted_at: columnDateTime(event.acceptedAt),
    completed_at: columnDateTime(event.completedAt),
    duration_ms: durationMs(event.acceptedAt, event.completedAt),
    step_count: wholeCount(event.stepCount),
    tool_call_count: wholeCount(event.toolCallCount),
    total_input_tokens: lanes.totalInput,
    total_output_tokens: lanes.output,
    cache_read_input_tokens: lanes.cacheRead,
    cache_write_input_tokens: lanes.cacheWrite,
    reasoning_tokens: lanes.reasoning,
    calculated_cost_usd: usdFromCents(event.costCents),
    provider_reported_cost_usd: nullableDecimal12(event.providerReportedCostUsd),
    error_code: text(event.errorCode),
    error_class: text(event.errorClass),
    ...runtimeColumns(event.runtime),
  };
}

export function stepRow(event: StepObserved): ProjectionRow {
  const lanes = resolveLanes(event.tokens);
  const costs = laneCosts(lanes, event.rates);
  return {
    ...scopeColumns(event.scope),
    step_id: uuidOrNil(event.stepId),
    turn_id: uuidOrNil(event.turnId),
    thread_id: text(event.threadId),
    agent_id: text(event.agentId),
    ...subjectColumns(event.subject),
    sequence: wholeCount(event.sequence),
    provider: text(event.provider),
    model: text(event.model),
    status: event.status,
    started_at: columnDateTime(event.startedAt),
    completed_at: columnDateTime(event.completedAt),
    duration_ms: durationMs(event.startedAt, event.completedAt),
    ...traceColumns(event.trace),
    ...laneColumns(lanes),
    ...rateColumns(event.rates),
    fresh_input_cost_usd: costs.freshInput,
    cache_read_cost_usd: costs.cacheRead,
    cache_write_cost_usd: costs.cacheWrite,
    output_cost_usd: costs.output,
    // The authoritative figure is the one the canonical store billed, not the
    // sum of the four lanes above. They should agree; when they do not, the
    // lanes are the explanation and this is the money.
    calculated_cost_usd: usdFromCents(event.costCents),
    provider_reported_cost_usd: nullableDecimal12(event.providerReportedCostUsd),
    error_code: text(event.errorCode),
    error_class: text(event.errorClass),
    error_message_redacted: redacted(event.errorMessageRedacted),
    attributes_json: attributesJson(event.attributes),
  };
}

export function toolCallRow(event: ToolCallObserved): ProjectionRow {
  return {
    ...scopeColumns(event.scope),
    tool_call_id: uuidOrNil(event.toolCallId),
    step_id: uuidOrNil(event.stepId),
    turn_id: uuidOrNil(event.turnId),
    thread_id: text(event.threadId),
    agent_id: text(event.agentId),
    ...subjectColumns(event.subject),
    sequence: wholeCount(event.sequence),
    entity_id: text(event.entityId),
    tool_id: text(event.toolId),
    tool_name: text(event.toolName),
    status: event.status,
    started_at: columnDateTime(event.startedAt),
    completed_at: columnDateTime(event.completedAt),
    duration_ms: durationMs(event.startedAt, event.completedAt),
    ...traceColumns(event.trace),
    retry_count: wholeCount(event.retryCount),
    request_bytes: wholeCount(event.requestBytes),
    response_bytes: wholeCount(event.responseBytes),
    error_code: text(event.errorCode),
    error_class: text(event.errorClass),
    error_message_redacted: redacted(event.errorMessageRedacted),
    attributes_json: attributesJson(event.attributes),
  };
}

export function usageRow(event: UsageObserved): ProjectionRow {
  const lanes = resolveLanes(event.tokens);
  const costs = laneCosts(lanes, event.rates);
  return {
    ...scopeColumns(event.scope),
    usage_event_id: uuidOrNil(event.usageEventId),
    // Nullable on purpose: auxiliary work belongs to an Agent and an Environment
    // and to no Turn. A nil uuid here would invent a parent that never existed —
    // and this table is retained as financial evidence.
    turn_id: event.turnId ? uuidOrNil(event.turnId) : null,
    step_id: event.stepId ? uuidOrNil(event.stepId) : null,
    tool_call_id: event.toolCallId ? uuidOrNil(event.toolCallId) : null,
    thread_id: text(event.threadId),
    agent_id: text(event.agentId),
    ...subjectColumns(event.subject),
    usage_kind: event.usageKind,
    provider: text(event.provider),
    model: text(event.model),
    skill_id: text(event.skillId),
    tool_name: text(event.toolName),
    occurred_at: columnDateTime(event.occurredAt),
    ...laneColumns(lanes),
    input_units: decimal12(event.inputUnits ?? 0),
    output_units: decimal12(event.outputUnits ?? 0),
    unit_type: text(event.unitType),
    ...rateColumns(event.rates),
    input_unit_price_usd: decimal12(event.inputUnitPriceUsd ?? 0),
    output_unit_price_usd: decimal12(event.outputUnitPriceUsd ?? 0),
    fresh_input_cost_usd: costs.freshInput,
    cache_read_cost_usd: costs.cacheRead,
    cache_write_cost_usd: costs.cacheWrite,
    output_cost_usd: costs.output,
    calculated_cost_usd: usdFromCents(event.costCents),
    provider_reported_cost_usd: nullableDecimal12(event.providerReportedCostUsd),
    trace_id: text(event.trace?.traceId),
    span_id: text(event.trace?.spanId),
    ...runtimeColumns(event.runtime),
  };
}

/** Everything one committed Turn projects into. */
export function projectTurnWork(work: TurnWork): ProjectionRows {
  return {
    turns_v1: [turnRow(work.turn)],
    steps_v1: (work.steps ?? []).map(stepRow),
    tool_calls_v1: (work.toolCalls ?? []).map(toolCallRow),
    usage_events_v1: (work.usage ?? []).map(usageRow),
  };
}

/**
 * The subject a queued payload addresses, read back off the projected rows.
 *
 * Used by the drain to ask whether an undelivered projection belongs to someone
 * whose data has since been erased. It reads the TURN row because that is the
 * only table carrying the plaintext identity columns, and it returns null rather
 * than a blank string so a caller cannot accidentally address every
 * system-attributed row in the organization.
 */
export function addressedEndUserId(rows: ProjectionRows): string | null {
  const value = rows.turns_v1[0]?.end_user_id;
  return typeof value === "string" && value.length > 0 ? value : null;
}
