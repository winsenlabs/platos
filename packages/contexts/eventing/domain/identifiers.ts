// Identifiers owned by the `eventing` context (ADR M0.3 §1, context 17).
//
// The kernel brands the tenancy tree and the outbox `EventId`; these brand the
// row this context is sole writer of, plus the two opaque strings that are NOT
// primary keys and are the easiest to confuse with one.
//
// `SubjectId` is the one worth pausing on. In the drained envelope it is the
// id of whatever the event is ABOUT — a run, an approval, a budget — and it is
// nullable. It is not a tenancy id, not a principal, and not this context's own
// key, and typing it as `string` is what would let any of those three slide into
// a subject-allowlist comparison and silently match.

import type { Branded } from "@platos/kernel";

/** `NotificationRule.id` — uuid. */
export type NotificationRuleId = Branded<string, "NotificationRuleId">;

/**
 * `NotificationRule.name` — unique per environment (`@@unique([environmentId,
 * name])`). Branded because it is a business key: a caller holding one may look
 * a rule up by it, and it must not be interchangeable with the rule's uuid.
 */
export type RuleName = Branded<string, "RuleName">;

/**
 * The dotted, stable name of an observed event — `run.completed`. It is the
 * kernel `DomainEvent.name` seen from the drain side, and it is what a rule's
 * patterns are matched against.
 */
export type EventName = Branded<string, "EventName">;

/**
 * What the event is ABOUT: a run id, an approval id, whatever the producing
 * context put there. Nullable on the envelope, opaque here, and deliberately not
 * substitutable for any identifier in the tenancy tree.
 */
export type SubjectId = Branded<string, "SubjectId">;
