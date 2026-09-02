// Integration events privacy publishes.
//
// Appended through the kernel `OutboxWriter` inside the same unit of work that
// wrote the state they describe (ADR M0.3 §3), so there is no instant in which a
// person's data is destroyed and the record saying so does not exist.
// `observability` projects them into the append-only admin trail and `eventing`
// routes them; neither imports this context's domain, which is why every payload
// below is flat, self-describing JSON.
//
// THIS IS THE AUDIT TRAIL, AND IT IS FOUR EVENTS RATHER THAN ONE.
//
//   requested     intent, appended BEFORE any target runs.
//   finished      outcome, appended after the operation row is updated.
//   refused       nothing ran: a legal hold, an idempotency conflict, an
//                 exhausted retry budget.
//   inventoried   somebody enumerated a subject's footprint without erasing.
//
// One event would be cheaper and would lose the case that matters: a pass that
// dies mid-sweep. The intent event survives it, so "who asked, and when" is
// answerable even when the outcome never got written. And the REFUSALS are the
// records most worth keeping — an idempotency key bound to another subject is
// what someone targeting person B with person A's key looks like.
//
// CONTENT-FREE, ON THE SAME TERMS AS THE OPERATION ROW. `subjectKeyHash` is the
// salted, organization-scoped digest; `legalHoldPolicyId` is a register position
// plus a truncated digest. `domain/content-free.ts` scans every payload whole
// before it is appended, because an event is assembled from an inventory, a set
// of target outcomes and an actor, and a leak arrives through whichever of those
// a later change touches.
//
// PAYLOADS ARE `type`, NOT `interface`, on purpose: a type alias gains an
// implicit index signature and therefore satisfies the kernel's `JsonValue`
// constraint, while an interface does not. For the same reason the ARRAY fields
// below are not `readonly`: `JsonValue` admits `JsonValue[]`, and a
// `readonly T[]` is not assignable to it. The properties holding them still are
// readonly, so a payload is no more mutable in practice — the difference is only
// that the element type stays inside the kernel's JSON algebra.

import type { DomainEventDraft } from "@platos/kernel";

export const PRIVACY_EVENT_NAMES = {
  erasureRequested: "privacy.erasure.requested",
  erasureFinished: "privacy.erasure.finished",
  erasureRefused: "privacy.erasure.refused",
  subjectInventoried: "privacy.erasure.inventoried",
} as const;

export type PrivacyEventName = (typeof PRIVACY_EVENT_NAMES)[keyof typeof PRIVACY_EVENT_NAMES];

/**
 * What an erasure DELIBERATELY leaves behind, restated on every record.
 *
 * Named on the event rather than deferred to a policy document that will not be
 * next to it in five years.
 */
export const RETENTION_CLASSES = {
  /**
   * The operation row and this trail. Retained indefinitely: they are the proof
   * the erasure happened, and destroying them to be tidy would leave the
   * operator unable to evidence compliance with the very request they honoured.
   */
  evidence: "erasure-evidence",
  /**
   * The tombstone register. Bounded, because a permanent register of erased
   * people is itself a record of them.
   */
  barrier: "erasure-barrier",
} as const;

export type RetentionClass = (typeof RETENTION_CLASSES)[keyof typeof RETENTION_CLASSES];

/** What caused this pass. Distinguishes an operator from the queue. */
export type ErasureCause = "request" | "operator-retry" | "queue-resume";

/** One target's outcome, reduced to the fields that carry no content. */
export type TargetOutcomeSummary = {
  readonly target: string;
  readonly status: string;
  readonly verification: string;
  readonly discovered: number;
  readonly deleted: number;
  readonly anonymized: number;
  readonly cryptoShredded: number;
  readonly retained: number;
  readonly failures: number;
  readonly note: string | null;
};

export type ErasureRequestedPayload = {
  readonly operationId: string;
  readonly subjectKeyHash: string;
  readonly policyVersion: string;
  readonly cause: ErasureCause;
  /** Targets this pass intends to run. A later pass names only the unsettled. */
  readonly targets: string[];
  readonly pass: number;
  readonly resolvedSubjects: number;
  readonly retentionClass: RetentionClass;
};

export type ErasureFinishedPayload = {
  readonly operationId: string;
  readonly subjectKeyHash: string;
  readonly policyVersion: string;
  readonly status: string;
  readonly cause: ErasureCause;
  readonly pass: number;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /** Null when the queue will not re-drive it; see `scheduleAfterPass`. */
  readonly nextRetryAt: string | null;
  readonly legalHoldPolicyId: string | null;
  readonly outcomes: TargetOutcomeSummary[];
  readonly retentionClass: RetentionClass;
  /** Rows kept but stripped of identity — the proof the erasure happened. */
  readonly anonymizedRecords: number;
  /** Rows a hold or retention rule kept, reported rather than silently dropped. */
  readonly retainedRecords: number;
};

export type ErasureRefusedPayload = {
  readonly operationId: string | null;
  readonly subjectKeyHash: string;
  readonly policyVersion: string | null;
  /** A stable error code, never free text assembled from the request. */
  readonly refusal: string;
  readonly legalHoldPolicyId: string | null;
  readonly retentionClass: RetentionClass;
};

export type SubjectInventoriedPayload = {
  readonly subjectKeyHash: string;
  readonly policyVersion: string;
  readonly resolvedSubjects: number;
  readonly discovered: number;
  readonly targets: string[];
  readonly retentionClass: RetentionClass;
};

export type PrivacyEventDraft =
  | DomainEventDraft<ErasureRequestedPayload>
  | DomainEventDraft<ErasureFinishedPayload>
  | DomainEventDraft<ErasureRefusedPayload>
  | DomainEventDraft<SubjectInventoriedPayload>;
