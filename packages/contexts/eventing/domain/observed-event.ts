// One event as the drain sees it.
//
// ADR M0.3 §1 row 17 makes this context a DRAIN of the kernel outbox, and §7
// decision 8 fixes one physical outbox with multiple drain consumers. The kernel
// `DomainEvent` envelope is "self-describing: a drain must be able to route and
// version an event without importing the context that produced it", and this
// type is that promise taken literally — it is derived FROM the envelope and
// names no producer.
//
// WHY IT IS NOT JUST `DomainEvent`. The envelope's `scope` is a `TenantScope`,
// which may be organization- or project-level. A notification rule is
// environment-scoped and has no wider form (`notification-rule.ts`), so an event
// that is not environment-scoped can match no rule at all. Narrowing at the
// boundary, once, is what stops every downstream predicate from having to
// re-ask; `observedEventFrom` is the only place that narrowing happens and it
// returns null rather than inventing an environment id.

import type { DomainEvent, EnvironmentScope, EventId, JsonValue } from "@platos/kernel";

import { asEventName, asSubjectId } from "./coercions.js";
import type { EventName, SubjectId } from "./identifiers.js";

export interface ObservedEvent {
  readonly eventId: EventId;
  readonly name: EventName;
  readonly scope: EnvironmentScope;
  /** Null when the event is about the environment rather than a row in it. */
  readonly subjectId: SubjectId | null;
  readonly payload: JsonValue;
  readonly occurredAt: Date;
}

/**
 * Where the subject id lives on the envelope.
 *
 * The legacy `Event` row has a first-class `subjectId` column. The kernel
 * envelope has no such field — it carries `payload` — so the drain reads the
 * subject from a reserved payload key. Naming the key once, here, is what keeps
 * the convention from being re-derived (and mistyped) at each call site.
 */
export const SUBJECT_PAYLOAD_KEY = "subjectId";

function readSubject(payload: JsonValue): SubjectId | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const raw = payload[SUBJECT_PAYLOAD_KEY];
  if (typeof raw !== "string" || raw.length === 0) return null;
  return asSubjectId(raw);
}

/**
 * Narrow an outbox envelope into something a rule can be matched against.
 *
 * Returns null when the event is not environment-scoped. A null is a SKIP, not
 * an error: an organization-scoped event is perfectly valid and simply has no
 * rule that could want it.
 */
export function observedEventFrom(event: DomainEvent): ObservedEvent | null {
  if (event.scope.level !== "environment") return null;
  return Object.freeze({
    eventId: event.eventId,
    name: asEventName(event.name),
    scope: event.scope,
    subjectId: readSubject(event.payload),
    payload: event.payload,
    occurredAt: new Date(event.occurredAt.getTime()),
  });
}
