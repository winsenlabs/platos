/**
 * The turn-shaped projection: domain events in, analytical rows out.
 *
 * Everything here is pure. The rows this module returns are exactly the JSON
 * objects that get POSTed to ClickHouse, and they are what the outbox stores —
 * so the projection semantics are frozen at enqueue time and a row delivered
 * three days late still means what it meant when the Turn committed.
 * `payloadVersion` on the outbox row is the pin for that shape.
 *
 * THREE THINGS THIS MODULE EXISTS TO GET RIGHT
 *
 * 1. CACHE LANES ARE A SUBSET OF INPUT. `total_input_tokens` is what the
 *    provider billed as input, INCLUSIVE of the cached slice.
 *    `fresh = total - cache_read - cache_write` is stored rather than derived,
 *    because three different screens deriving it from three different bases is
 *    exactly how the same label came to mean three different numbers.
 *
 * 2. RATES ARE FROZEN, NOT LOOKED UP. Each Step carries the four rates that
 *    were used when it ran. Nothing here consults a catalogue: re-pricing an
 *    old Turn with today's card silently rewrites an invoice already issued.
 *
 * 3. NOTHING IDENTIFYING LEAKS THROUGH `attributes_json`. It is built from an
 *    allow-list of scalar keys, never from a caller-supplied bag. Prompts, tool
 *    arguments, tool results, message bodies and credentials have no path into
 *    this file at all — they are not parameters of any function in it.
 */

import { OBSERVABILITY_TABLES, type ObservabilityTable } from "./observability-config";

/** A single JSONEachRow record. */
export type ObservabilityRow = Record<string, string | number | null>;

/** One outbox payload: the rows for one committed Turn, ready to insert. */
export type ObservabilityRows = {
  [Table in ObservabilityTable]: ObservabilityRow[];
};

export function emptyRows(): ObservabilityRows {
  return { turns_v1: [], steps_v1: [], tool_calls_v1: [], usage_events_v1: [] };
}

export function rowCount(rows: ObservabilityRows): number {
  return OBSERVABILITY_TABLES.reduce((total, table) => total + rows[table].length, 0);
}

// ---------------------------------------------------------------------------
// Scalar formatting
// ---------------------------------------------------------------------------

/** Total digits 24, of which 12 are fractional — so 12 digits of integer room. */
const DECIMAL_BOUND = 1e12;

/**
 * The largest magnitude that still RENDERS inside those 12 integer digits.
 *
 * Clamping to `DECIMAL_BOUND` itself is an off-by-one that defeats the clamp:
 * `(1e12).toFixed(12)` is "1000000000000.000000000000", thirteen integer
 * digits, which `Decimal(24, 12)` cannot parse — so the one absurd number takes
 * the whole batch down with it, which is precisely the outcome clamping exists
 * to prevent, forever, because the row is frozen in the outbox and replayed.
 * One double below the bound is the largest value that renders with twelve.
 */
const DECIMAL_MAX = DECIMAL_BOUND - 2 ** -13;

/**
 * Fixed-point text for a `Decimal(24, 12)` column.
 *
 * `toFixed` rather than `String(value)` because the hazard here is notation,
 * not precision: `String(0.0000001)` is `"1e-7"`, and ClickHouse rejects the
 * ENTIRE batch when one column fails to parse. Twelve fractional digits is the
 * column's own scale, and a double carries ~15-16 significant digits, so this
 * rounds nothing a `Decimal(24, 12)` could have stored.
 *
 * Out-of-range input is clamped rather than thrown. A cost of ten to the
 * twelfth dollars is already corrupt, and the useful failure is one absurd
 * number in a delivered batch — not a batch of good rows blocked behind it.
 */
export function decimal12(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "0.000000000000";
  const clamped = Math.max(-DECIMAL_MAX, Math.min(DECIMAL_MAX, value));
  return clamped.toFixed(12);
}

/** Nullable money: absent stays absent rather than becoming a confident zero. */
export function nullableDecimal12(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return decimal12(value);
}

/** USD per million tokens, from the catalogue's USD per token. */
export function usdPerMillion(usdPerToken: number | null | undefined): string {
  if (usdPerToken === null || usdPerToken === undefined || !Number.isFinite(usdPerToken)) {
    return decimal12(0);
  }
  return decimal12(usdPerToken * 1_000_000);
}

/** USD from the cents the Postgres row stores. */
export function usdFromCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return decimal12(0);
  return decimal12(cents / 100);
}

/** Non-negative whole tokens. Providers occasionally report a float or a null. */
export function tokenCount(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/**
 * `DateTime64(6, 'UTC')` text.
 *
 * Space-separated and without a zone suffix: the column is UTC-typed, so this
 * is unambiguous, and it avoids depending on which ISO-8601 spellings the
 * server's parser accepts this version.
 */
export function clickhouseDateTime(value: Date | null | undefined): string {
  const date = value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date(0);
  return date.toISOString().replace("T", " ").replace("Z", "").padEnd(26, "0").slice(0, 26);
}

/** Milliseconds between two instants, never negative. */
export function durationMs(startedAt: Date | null | undefined, completedAt: Date | null | undefined): number {
  if (!(startedAt instanceof Date) || !(completedAt instanceof Date)) return 0;
  const delta = completedAt.getTime() - startedAt.getTime();
  return Number.isFinite(delta) ? Math.max(0, Math.round(delta)) : 0;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * A value ClickHouse's UUID parser will accept.
 *
 * A malformed id fails the whole INSERT, and the id columns are populated from
 * Postgres uuids that are always well formed — so reaching the nil uuid means a
 * caller passed something else, and one visibly wrong row beats a rejected
 * batch that takes the Turn's real rows with it.
 */
export function uuidOrNil(value: string | null | undefined): string {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : NIL_UUID;
}

/** Empty string, never null: these columns are `String DEFAULT ''`. */
function text(value: string | null | undefined): string {
  return typeof value === "string" ? value : "";
}

/**
 * A plaintext identity value, or null.
 *
 * Blank collapses to null so the erasure residue check — which asks whether any
 * row STILL CARRIES identity via `coalesce(col, '') != ''` — is answering a
 * question about identity rather than about whitespace.
 */
function identityText(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}

/** Redacted diagnostic text: a class or a short message, never a payload. */
function redacted(value: string | null | undefined, limit = 500): string {
  if (typeof value !== "string") return "";
  return value.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

/**
 * Keys permitted in `attributes_json`.
 *
 * An allow-list, for the reason the erasure plan enumerates its tables rather
 * than discovering them: a list is auditable, and "copy whatever the caller
 * sent" is how a prompt ends up in an analytical store nobody thought held
 * prompts. Adding a key here is a deliberate act, and adding one that can carry
 * identity means adding it to CLICKHOUSE_ERASURE_PLAN in the same change.
 */
export const ATTRIBUTE_ALLOW_LIST = [
  "finish_reason",
  "retry_count",
  "stop_reason",
  "temperature",
  "tool_choice",
  "truncated",
  "version_bucket",
] as const;

export type ObservabilityAttributes = Partial<
  Record<(typeof ATTRIBUTE_ALLOW_LIST)[number], string | number | boolean>
>;

/**
 * Serialize allow-listed scalars.
 *
 * Objects and arrays are dropped rather than stringified: a nested value is
 * where an unreviewed payload hides, and no allow-listed key has one.
 */
export function attributesJson(attributes: ObservabilityAttributes | undefined): string {
  if (!attributes) return "{}";
  const out: Record<string, string | number | boolean> = {};
  for (const key of ATTRIBUTE_ALLOW_LIST) {
    const value = attributes[key];
    if (typeof value === "string") out[key] = value.slice(0, 200);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
  }
  return JSON.stringify(out);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type ObservabilityStatus = "completed" | "failed" | "cancelled";
export type ToolCallStatus = ObservabilityStatus | "denied";
export type UsageKind = "inference" | "embedding" | "extraction" | "judge" | "skill";

export interface ObservabilityScope {
  organizationId: string;
  projectId: string;
  environmentId: string;
}

/**
 * Who the work was for.
 *
 * `subjectKeyHash` is the canonical join key and survives erasure.
 * `endUserId` is the canonical EndUser id and is cleared by erasure.
 * The two plaintext fields are present ONLY when an entity signed userMeta;
 * absent is the default and the common case.
 */
export interface ObservabilitySubject {
  endUserId?: string | null;
  subjectKeyHash?: string | null;
  userDisplayName?: string | null;
  userEmail?: string | null;
}

/** Token lanes as the provider reported them. `inputTokens` includes the cache slice. */
export interface ObservabilityTokens {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
  reasoningTokens?: number | null;
}

/** The four rates that were in force when the Step ran, in USD per token. */
export interface ObservabilityRates {
  pricingSource?: string | null;
  /** The ModelPrice row id. The catalogue version this cost is pinned to. */
  pricingVersion?: string | null;
  inputUsdPerToken?: number | null;
  outputUsdPerToken?: number | null;
  cacheReadUsdPerToken?: number | null;
  cacheWriteUsdPerToken?: number | null;
}

export interface TurnObserved {
  scope: ObservabilityScope;
  turnId: string;
  threadId: string;
  agentId: string;
  agentVersionId?: string | null;
  subject?: ObservabilitySubject;
  traceId?: string | null;
  rootSpanId?: string | null;
  status: ObservabilityStatus;
  acceptedAt: Date;
  completedAt: Date;
  stepCount?: number;
  toolCallCount?: number;
  tokens?: ObservabilityTokens;
  costCents?: number | null;
  providerReportedCostUsd?: number | null;
  errorCode?: string | null;
  errorClass?: string | null;
  runtimeProvider?: string | null;
  runtimeRunId?: string | null;
}

export interface StepObserved {
  scope: ObservabilityScope;
  stepId: string;
  turnId: string;
  threadId: string;
  agentId: string;
  subject?: ObservabilitySubject;
  sequence: number;
  provider: string;
  model: string;
  status: ObservabilityStatus;
  startedAt: Date;
  completedAt: Date;
  traceId?: string | null;
  spanId?: string | null;
  parentSpanId?: string | null;
  tokens?: ObservabilityTokens;
  rates?: ObservabilityRates;
  costCents?: number | null;
  providerReportedCostUsd?: number | null;
  errorCode?: string | null;
  errorClass?: string | null;
  errorMessageRedacted?: string | null;
  attributes?: ObservabilityAttributes;
}

export interface ToolCallObserved {
  scope: ObservabilityScope;
  toolCallId: string;
  stepId: string;
  turnId: string;
  threadId: string;
  agentId: string;
  subject?: ObservabilitySubject;
  sequence: number;
  entityId?: string | null;
  toolId?: string | null;
  toolName: string;
  status: ToolCallStatus;
  startedAt: Date;
  completedAt: Date;
  traceId?: string | null;
  spanId?: string | null;
  parentSpanId?: string | null;
  retryCount?: number;
  requestBytes?: number;
  responseBytes?: number;
  errorCode?: string | null;
  errorClass?: string | null;
  errorMessageRedacted?: string | null;
  attributes?: ObservabilityAttributes;
}

export interface UsageObserved {
  scope: ObservabilityScope;
  usageEventId: string;
  turnId?: string | null;
  stepId?: string | null;
  toolCallId?: string | null;
  threadId?: string | null;
  agentId: string;
  subject?: ObservabilitySubject;
  usageKind: UsageKind;
  provider: string;
  model?: string | null;
  skillId?: string | null;
  toolName?: string | null;
  occurredAt: Date;
  tokens?: ObservabilityTokens;
  rates?: ObservabilityRates;
  inputUnits?: number | null;
  outputUnits?: number | null;
  unitType?: string | null;
  inputUnitPriceUsd?: number | null;
  outputUnitPriceUsd?: number | null;
  costCents?: number | null;
  providerReportedCostUsd?: number | null;
  traceId?: string | null;
  spanId?: string | null;
  runtimeProvider?: string | null;
  runtimeRunId?: string | null;
}

// ---------------------------------------------------------------------------
// Lane arithmetic
// ---------------------------------------------------------------------------

export interface ResolvedLanes {
  totalInput: number;
  freshInput: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
}

/**
 * Split reported usage into the lanes the schema stores.
 *
 * Cache counters that exceed the reported input are clamped, not trusted:
 * providers do occasionally report a cache read larger than the input it was
 * part of, and letting `fresh` go negative would understate the bill by exactly
 * the amount of the error.
 */
export function resolveLanes(tokens: ObservabilityTokens | undefined): ResolvedLanes {
  const totalInput = tokenCount(tokens?.inputTokens);
  const cacheRead = Math.min(totalInput, tokenCount(tokens?.cacheReadInputTokens));
  const cacheWrite = Math.min(totalInput - cacheRead, tokenCount(tokens?.cacheWriteInputTokens));
  return {
    totalInput,
    freshInput: Math.max(0, totalInput - cacheRead - cacheWrite),
    cacheRead,
    cacheWrite,
    output: tokenCount(tokens?.outputTokens),
    reasoning: tokenCount(tokens?.reasoningTokens),
  };
}

/** Per-lane extended cost in USD, from the frozen rates and the resolved lanes. */
export interface LaneCosts {
  freshInput: string;
  cacheRead: string;
  cacheWrite: string;
  output: string;
}

export function laneCosts(lanes: ResolvedLanes, rates: ObservabilityRates | undefined): LaneCosts {
  const rate = (value: number | null | undefined): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    freshInput: decimal12(lanes.freshInput * rate(rates?.inputUsdPerToken)),
    cacheRead: decimal12(lanes.cacheRead * rate(rates?.cacheReadUsdPerToken)),
    cacheWrite: decimal12(lanes.cacheWrite * rate(rates?.cacheWriteUsdPerToken)),
    output: decimal12(lanes.output * rate(rates?.outputUsdPerToken)),
  };
}

function subjectColumns(subject: ObservabilitySubject | undefined) {
  return {
    end_user_id: text(subject?.endUserId),
    subject_key_hash: text(subject?.subjectKeyHash),
  };
}

function rateColumns(rates: ObservabilityRates | undefined) {
  return {
    pricing_source: text(rates?.pricingSource),
    pricing_version: text(rates?.pricingVersion),
    fresh_input_usd_per_million: usdPerMillion(rates?.inputUsdPerToken),
    cache_read_usd_per_million: usdPerMillion(rates?.cacheReadUsdPerToken),
    cache_write_usd_per_million: usdPerMillion(rates?.cacheWriteUsdPerToken),
    output_usd_per_million: usdPerMillion(rates?.outputUsdPerToken),
  };
}

function laneColumns(lanes: ResolvedLanes) {
  return {
    total_input_tokens: lanes.totalInput,
    fresh_input_tokens: lanes.freshInput,
    cache_read_input_tokens: lanes.cacheRead,
    cache_write_input_tokens: lanes.cacheWrite,
    output_tokens: lanes.output,
    reasoning_tokens: lanes.reasoning,
  };
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

/**
 * `billable_unit` is absent on purpose: the column is MATERIALIZED from status,
 * so the server derives it and no writer can disagree with it. That is the
 * whole reason "one completed Turn is one billable unit" holds regardless of
 * how many Steps or Tool Calls the Turn contained.
 */
export function turnRow(event: TurnObserved): ObservabilityRow {
  const lanes = resolveLanes(event.tokens);
  return {
    organization_id: event.scope.organizationId,
    project_id: event.scope.projectId,
    environment_id: event.scope.environmentId,
    turn_id: uuidOrNil(event.turnId),
    thread_id: text(event.threadId),
    agent_id: text(event.agentId),
    agent_version_id: text(event.agentVersionId),
    ...subjectColumns(event.subject),
    user_display_name: identityText(event.subject?.userDisplayName),
    user_email: identityText(event.subject?.userEmail),
    trace_id: text(event.traceId),
    root_span_id: text(event.rootSpanId),
    status: event.status,
    accepted_at: clickhouseDateTime(event.acceptedAt),
    completed_at: clickhouseDateTime(event.completedAt),
    duration_ms: durationMs(event.acceptedAt, event.completedAt),
    step_count: Math.max(0, Math.floor(event.stepCount ?? 0)),
    tool_call_count: Math.max(0, Math.floor(event.toolCallCount ?? 0)),
    total_input_tokens: lanes.totalInput,
    total_output_tokens: lanes.output,
    cache_read_input_tokens: lanes.cacheRead,
    cache_write_input_tokens: lanes.cacheWrite,
    reasoning_tokens: lanes.reasoning,
    calculated_cost_usd: usdFromCents(event.costCents),
    provider_reported_cost_usd: nullableDecimal12(event.providerReportedCostUsd),
    error_code: text(event.errorCode),
    error_class: text(event.errorClass),
    runtime_provider: text(event.runtimeProvider),
    runtime_run_id: text(event.runtimeRunId),
  };
}

export function stepRow(event: StepObserved): ObservabilityRow {
  const lanes = resolveLanes(event.tokens);
  const costs = laneCosts(lanes, event.rates);
  return {
    organization_id: event.scope.organizationId,
    project_id: event.scope.projectId,
    environment_id: event.scope.environmentId,
    step_id: uuidOrNil(event.stepId),
    turn_id: uuidOrNil(event.turnId),
    thread_id: text(event.threadId),
    agent_id: text(event.agentId),
    ...subjectColumns(event.subject),
    sequence: Math.max(0, Math.floor(event.sequence)),
    provider: text(event.provider),
    model: text(event.model),
    status: event.status,
    started_at: clickhouseDateTime(event.startedAt),
    completed_at: clickhouseDateTime(event.completedAt),
    duration_ms: durationMs(event.startedAt, event.completedAt),
    trace_id: text(event.traceId),
    span_id: text(event.spanId),
    parent_span_id: text(event.parentSpanId),
    ...laneColumns(lanes),
    ...rateColumns(event.rates),
    fresh_input_cost_usd: costs.freshInput,
    cache_read_cost_usd: costs.cacheRead,
    cache_write_cost_usd: costs.cacheWrite,
    output_cost_usd: costs.output,
    // The authoritative figure is the one Postgres billed, not the sum of the
    // four lanes above. They should agree; when they do not, the lanes are the
    // explanation and this is the money.
    calculated_cost_usd: usdFromCents(event.costCents),
    provider_reported_cost_usd: nullableDecimal12(event.providerReportedCostUsd),
    error_code: text(event.errorCode),
    error_class: text(event.errorClass),
    error_message_redacted: redacted(event.errorMessageRedacted),
    attributes_json: attributesJson(event.attributes),
  };
}

export function toolCallRow(event: ToolCallObserved): ObservabilityRow {
  return {
    organization_id: event.scope.organizationId,
    project_id: event.scope.projectId,
    environment_id: event.scope.environmentId,
    tool_call_id: uuidOrNil(event.toolCallId),
    step_id: uuidOrNil(event.stepId),
    turn_id: uuidOrNil(event.turnId),
    thread_id: text(event.threadId),
    agent_id: text(event.agentId),
    ...subjectColumns(event.subject),
    sequence: Math.max(0, Math.floor(event.sequence)),
    entity_id: text(event.entityId),
    tool_id: text(event.toolId),
    tool_name: text(event.toolName),
    status: event.status,
    started_at: clickhouseDateTime(event.startedAt),
    completed_at: clickhouseDateTime(event.completedAt),
    duration_ms: durationMs(event.startedAt, event.completedAt),
    trace_id: text(event.traceId),
    span_id: text(event.spanId),
    parent_span_id: text(event.parentSpanId),
    retry_count: Math.max(0, Math.floor(event.retryCount ?? 0)),
    request_bytes: Math.max(0, Math.floor(event.requestBytes ?? 0)),
    response_bytes: Math.max(0, Math.floor(event.responseBytes ?? 0)),
    error_code: text(event.errorCode),
    error_class: text(event.errorClass),
    error_message_redacted: redacted(event.errorMessageRedacted),
    attributes_json: attributesJson(event.attributes),
  };
}

export function usageRow(event: UsageObserved): ObservabilityRow {
  const lanes = resolveLanes(event.tokens);
  const costs = laneCosts(lanes, event.rates);
  return {
    organization_id: event.scope.organizationId,
    project_id: event.scope.projectId,
    environment_id: event.scope.environmentId,
    usage_event_id: uuidOrNil(event.usageEventId),
    // Nullable on purpose: auxiliary work belongs to an Agent and Environment
    // and to no Turn. A nil uuid here would invent a parent that never existed.
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
    occurred_at: clickhouseDateTime(event.occurredAt),
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
    trace_id: text(event.traceId),
    span_id: text(event.spanId),
    runtime_provider: text(event.runtimeProvider),
    runtime_run_id: text(event.runtimeRunId),
  };
}

/** Everything one committed Turn projects into, as one deliverable payload. */
export interface TurnProjection {
  turn: TurnObserved;
  steps?: StepObserved[];
  toolCalls?: ToolCallObserved[];
  usage?: UsageObserved[];
}

export function projectTurn(projection: TurnProjection): ObservabilityRows {
  return {
    turns_v1: [turnRow(projection.turn)],
    steps_v1: (projection.steps ?? []).map(stepRow),
    tool_calls_v1: (projection.toolCalls ?? []).map(toolCallRow),
    usage_events_v1: (projection.usage ?? []).map(usageRow),
  };
}

/**
 * Read a stored payload back as rows.
 *
 * Returns null for anything that is not the shape this module wrote. The outbox
 * column is `Json`, which in this schema has repeatedly been found holding a
 * string scalar rather than an object, and a drain worker that trusts the
 * column crashes the whole pass on one bad row.
 */
export function decodeRows(payload: unknown): ObservabilityRows | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const source = payload as Record<string, unknown>;
  const rows = emptyRows();
  for (const table of OBSERVABILITY_TABLES) {
    const value = source[table];
    if (value === undefined) continue;
    if (!Array.isArray(value)) return null;
    for (const entry of value) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
      rows[table].push(entry as ObservabilityRow);
    }
  }
  return rows;
}
