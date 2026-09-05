// The `Event.payload` envelope: what the kernel `DomainEvent` looks like once
// the frozen row has taken it, and what comes back when a drain reads it.
//
// THE ROW IS NARROWER THAN THE ENVELOPE, and that is the whole reason this file
// exists. `Event` was created by the initial migration with six columns —
// `id`, `environmentId`, `eventType`, `subjectId`, `payload`, `createdAt` — and
// the kernel envelope carries `schemaVersion`, `requestId` and a whole
// `TenantScope` besides its payload. Three of those have no column. Expand and
// contract says a writer may use only the columns in the frozen baseline or ones
// an ordered migration added, so the three that have no column are carried
// INSIDE `payload`, whose own schema comment already calls it "the versioned
// event body".
//
// THE ENVELOPE ALSO SOLVES A CONSTRAINT THE DOUBLE CANNOT SEE. The migrations
// add `Event_payload_json_root CHECK (jsonb_typeof("payload") = 'object')`. The
// kernel's `JsonValue` admits an array, a string and a number, so a producer
// appending `payload: [1, 2]` is legal at the type level and is REFUSED by
// PostgreSQL. Wrapping puts an object at the root whatever the producer sent,
// and the refusal disappears — for every payload, not for the ones a suite
// happened to try.
//
// `subjectId` IS ALWAYS NULL. The column has no counterpart in the kernel
// envelope: a domain event names its scope and its payload, not a subject. It is
// written as null rather than filled with something adjacent — the request id, a
// payload field — because a column whose meaning was decided by whichever writer
// got there first is worse than an empty one, and the row already has a live
// second writer in the legacy tree that fills it with a real subject.

import type {
  DomainEventDraft,
  EnvironmentId,
  EventId,
  JsonValue,
  RequestId,
  TenantScope,
} from "@platos/kernel";
import { asIdentifier } from "@platos/kernel";

/** The envelope layout this binary writes and can read. */
export const ENVELOPE_VERSION = 1;

/** The key that marks a payload as an envelope rather than a bare body. */
export const ENVELOPE_MARKER = "outboxEnvelope";

/** The event name is not a dotted, lower-case, context-prefixed name. */
export const NAME_INVALID = "outbox.append.name_invalid";

/** The contract's schema version is not a positive whole number. */
export const SCHEMA_VERSION_INVALID = "outbox.append.schema_version_invalid";

/**
 * The event is scoped above an environment, and the frozen row cannot hold it.
 *
 * `Event.environmentId` is `UUID NOT NULL` with a live foreign key to
 * `Environment`, so an organization-scoped or project-scoped event has no legal
 * row. This is a REFUSAL and not a silent widening on purpose: writing such an
 * event under some arbitrary environment would file an organization-level fact
 * in one environment and hide it from every other, and dropping it would lose it.
 */
export const SCOPE_NOT_ENVIRONMENT = "outbox.append.scope_not_environment";

/** The payload holds a value JSON cannot carry, or a cycle. */
export const PAYLOAD_NOT_SERIALISABLE = "outbox.append.payload_not_serialisable";

/** A stored row's payload is not a JSON object at all. */
export const ROW_PAYLOAD_NOT_OBJECT = "outbox.drain.payload_not_object";

/** The row was written by a binary whose envelope layout this one cannot read. */
export const ENVELOPE_VERSION_UNKNOWN = "outbox.drain.envelope_version_unknown";

/** The envelope is this version, but a field inside it is the wrong shape. */
export const ENVELOPE_FIELD_UNREADABLE = "outbox.drain.envelope_field_unreadable";

export class OutboxEnvelopeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OutboxEnvelopeError";
    this.code = code;
  }
}

/**
 * A dotted, lower-case, context-prefixed name — `tenancy.invitation.issued`.
 *
 * Checked HERE rather than trusted, because `eventType` is a bare `TEXT` column
 * with no constraint of its own: every name a producer ever sends is legal to
 * PostgreSQL, and a drain routing on the first segment would silently stop
 * matching a name that arrived capitalised or with a space in it.
 */
export const EVENT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*){2,}$/u;

function assertName(name: string): void {
  if (!EVENT_NAME_PATTERN.test(name)) {
    throw new OutboxEnvelopeError(
      NAME_INVALID,
      `"${name}" is not a dotted lower-case event name of the form <context>.<subject>.<verb>`,
    );
  }
}

function assertSchemaVersion(version: number): void {
  if (!Number.isInteger(version) || version <= 0) {
    throw new OutboxEnvelopeError(
      SCHEMA_VERSION_INVALID,
      `schemaVersion must be a positive whole number; received ${String(version)}`,
    );
  }
}

/**
 * The environment an event is filed under, or a refusal.
 *
 * Exported because the refusal is a fact about the SCHEMA rather than about this
 * function, and the integration suite proves it by putting the row PostgreSQL
 * would have to accept in front of PostgreSQL and watching it refuse.
 */
export function environmentOf(scope: TenantScope): EnvironmentId {
  if (scope.level !== "environment") {
    throw new OutboxEnvelopeError(
      SCOPE_NOT_ENVIRONMENT,
      `a ${scope.level}-scoped event has no row: Event.environmentId is NOT NULL with a` +
        " foreign key to Environment, and the baseline schema has no column for a wider scope",
    );
  }
  return scope.environmentId;
}

/**
 * A deep copy of `payload` with every value JSON can actually carry.
 *
 * A round trip rather than a walk, because the round trip is what the database
 * driver will do: `undefined`, a function, a `NaN` and a `bigint` each fail or
 * change shape on the way into a JSONB column, and finding that out at the port
 * with a named code beats finding it out as a driver error three layers down.
 */
export function toStorableJson(payload: JsonValue): JsonValue {
  let text: string;
  try {
    text = JSON.stringify(payload);
  } catch (cause) {
    throw new OutboxEnvelopeError(
      PAYLOAD_NOT_SERIALISABLE,
      `the event payload cannot be written as JSON: ${String(cause)}`,
    );
  }
  if (text === undefined) {
    throw new OutboxEnvelopeError(
      PAYLOAD_NOT_SERIALISABLE,
      "the event payload serialises to nothing; undefined and functions have no JSON form",
    );
  }
  return JSON.parse(text) as JsonValue;
}

/** The object written to `Event.payload`. Always an object root. */
export function encodeEnvelope<Payload extends JsonValue>(
  draft: DomainEventDraft<Payload>,
): Readonly<Record<string, unknown>> {
  assertName(draft.name);
  assertSchemaVersion(draft.schemaVersion);
  const scope = draft.scope;
  environmentOf(scope);
  return {
    [ENVELOPE_MARKER]: ENVELOPE_VERSION,
    schemaVersion: draft.schemaVersion,
    requestId: draft.requestId,
    scope: { ...scope },
    payload: toStorableJson(draft.payload),
  };
}

/** One event as a drain sees it. `scope` is null for a pre-envelope row. */
export interface DrainedEvent {
  readonly eventId: EventId;
  readonly name: string;
  readonly occurredAt: Date;
  readonly environmentId: EnvironmentId;
  readonly schemaVersion: number;
  readonly requestId: RequestId | null;
  /**
   * The scope the producer named, or null when the row predates the envelope.
   *
   * NULL IS THE EXPAND-AND-CONTRACT READ. `Event` has a live writer in the
   * legacy tree that stores a bare body, and those rows are real rows with real
   * event types. A reader that refused them would be a reader that cannot drain
   * the table it is pointed at; a reader that invented a scope for them would be
   * making one up. Reporting the absence is the only honest third option, and it
   * is a value a consumer can branch on.
   */
  readonly scope: TenantScope | null;
  readonly payload: JsonValue;
}

function readScope(value: unknown): TenantScope {
  if (typeof value !== "object" || value === null) {
    throw new OutboxEnvelopeError(ENVELOPE_FIELD_UNREADABLE, "the envelope scope is not an object");
  }
  const raw = value as Record<string, unknown>;
  const level = raw["level"];
  const organizationId = raw["organizationId"];
  if (typeof organizationId !== "string") {
    throw new OutboxEnvelopeError(
      ENVELOPE_FIELD_UNREADABLE,
      "the envelope scope carries no organizationId",
    );
  }
  if (level === "organization") {
    return { level, organizationId: asIdentifier(organizationId) };
  }
  const projectId = raw["projectId"];
  if (typeof projectId !== "string") {
    throw new OutboxEnvelopeError(
      ENVELOPE_FIELD_UNREADABLE,
      `a ${String(level)} scope carries no projectId`,
    );
  }
  if (level === "project") {
    return { level, organizationId: asIdentifier(organizationId), projectId: asIdentifier(projectId) };
  }
  const environmentId = raw["environmentId"];
  if (level !== "environment" || typeof environmentId !== "string") {
    throw new OutboxEnvelopeError(
      ENVELOPE_FIELD_UNREADABLE,
      `the envelope scope level "${String(level)}" is not one this binary knows`,
    );
  }
  return {
    level,
    organizationId: asIdentifier(organizationId),
    projectId: asIdentifier(projectId),
    environmentId: asIdentifier(environmentId),
  };
}

/**
 * A stored row, decoded.
 *
 * THE THREE REFUSALS HERE ARE THREE DIFFERENT FACTS about a row and carry three
 * codes for the reason the transaction guards do: "this payload is not an
 * object" is a corrupt row, "this envelope version is newer than me" is a
 * rollback in progress and is fixed by rolling the binary forward, and "this
 * field is the wrong shape" is a defect in whatever wrote it. One shared code
 * would put all three in a log as the same line.
 */
export function decodeEnvelope(row: {
  readonly eventId: string;
  readonly environmentId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly createdAt: Date;
}): DrainedEvent {
  const base = {
    eventId: asIdentifier<EventId>(row.eventId),
    name: row.eventType,
    occurredAt: row.createdAt,
    environmentId: asIdentifier<EnvironmentId>(row.environmentId),
  };
  if (typeof row.payload !== "object" || row.payload === null || Array.isArray(row.payload)) {
    throw new OutboxEnvelopeError(
      ROW_PAYLOAD_NOT_OBJECT,
      `event ${row.eventId} has a payload that is not a JSON object`,
    );
  }
  const body = row.payload as Record<string, unknown>;
  const marker = body[ENVELOPE_MARKER];
  if (marker === undefined) {
    // A row written before this envelope existed. Its body IS the payload.
    return { ...base, schemaVersion: 1, requestId: null, scope: null, payload: body as JsonValue };
  }
  if (marker !== ENVELOPE_VERSION) {
    throw new OutboxEnvelopeError(
      ENVELOPE_VERSION_UNKNOWN,
      `event ${row.eventId} carries envelope version ${String(marker)};` +
        ` this binary reads version ${String(ENVELOPE_VERSION)}`,
    );
  }
  const schemaVersion = body["schemaVersion"];
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion <= 0) {
    throw new OutboxEnvelopeError(
      ENVELOPE_FIELD_UNREADABLE,
      `event ${row.eventId} carries an unreadable schemaVersion`,
    );
  }
  const requestId = body["requestId"];
  if (requestId !== null && typeof requestId !== "string") {
    throw new OutboxEnvelopeError(
      ENVELOPE_FIELD_UNREADABLE,
      `event ${row.eventId} carries an unreadable requestId`,
    );
  }
  return {
    ...base,
    schemaVersion,
    requestId: requestId === null ? null : asIdentifier<RequestId>(requestId),
    scope: readScope(body["scope"]),
    payload: (body["payload"] ?? null) as JsonValue,
  };
}
