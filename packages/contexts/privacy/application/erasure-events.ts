// Composing this context's integration events, and refusing to emit a leaky one.
//
// The events ARE the audit trail (see `contracts/events.ts` for why there are
// four and not one). They are appended through the kernel `OutboxWriter` in the
// same transaction that wrote the state they describe, so there is no instant in
// which a person's data is destroyed and the record saying so does not exist.
//
// EVERY APPEND IS GUARDED. `assertContentFree` scans the composed payload whole
// against the subject's own handles before it goes anywhere near the outbox. The
// guard runs here rather than at the call sites because a payload is assembled
// from a target's note, a hold reference and a set of counts, and the leak
// arrives through whichever of those a later change touches.
//
// A REFUSED APPEND FAILS THE CALLER. Not "log and continue": the payload is
// already wrong, and writing it would put the erased identifier into the
// permanent evidence record. Failing leaves the operation retryable, which is
// recoverable; a leaked receipt is not.

import { err, ok, organizationScope, type JsonValue, type Result, type TransactionScope } from "@platos/kernel";
import type { DomainEventDraft } from "@platos/kernel";

import {
  assertContentFree,
  type ErasureOperationRecord,
  type TargetOutcome,
} from "../domain/index.js";
import {
  PRIVACY_EVENT_NAMES,
  RETENTION_CLASSES,
  type ErasureCause,
  type ErasureFinishedPayload,
  type ErasureRefusedPayload,
  type ErasureRequestedPayload,
  type SubjectInventoriedPayload,
  type TargetOutcomeSummary,
} from "../contracts/events.js";
import type { PrivacyDependencies } from "./dependencies.js";

/** Every event this context emits is at envelope version 1. */
export const PRIVACY_EVENT_SCHEMA_VERSION = 1;

/**
 * A target outcome reduced to the fields that carry no content.
 *
 * `note` survives because target notes are already held to the error-CLASS rule
 * and it is where the useful operational detail lives — a rejection code, the
 * reason a verification was demoted, how many rows survived.
 */
export function summarizeOutcome(outcome: TargetOutcome): TargetOutcomeSummary {
  return {
    target: outcome.target,
    status: outcome.status,
    verification: outcome.verification,
    discovered: outcome.discovered,
    deleted: outcome.counts.deleted,
    anonymized: outcome.counts.anonymized,
    cryptoShredded: outcome.counts.cryptoShredded,
    retained: outcome.counts.retained,
    failures: outcome.failures,
    note: outcome.note,
  };
}

export function requestedEvent(args: {
  readonly operation: ErasureOperationRecord;
  readonly cause: ErasureCause;
  readonly targets: readonly string[];
  readonly resolvedSubjects: number;
}): ErasureRequestedPayload {
  return {
    operationId: args.operation.operationId,
    subjectKeyHash: args.operation.subjectKeyHash,
    policyVersion: args.operation.policyVersion,
    cause: args.cause,
    targets: [...args.targets],
    pass: args.operation.retryCount + 1,
    resolvedSubjects: args.resolvedSubjects,
    retentionClass: RETENTION_CLASSES.evidence,
  };
}

export function finishedEvent(args: {
  readonly operation: ErasureOperationRecord;
  readonly cause: ErasureCause;
}): ErasureFinishedPayload {
  const outcomes = args.operation.outcomes;
  return {
    operationId: args.operation.operationId,
    subjectKeyHash: args.operation.subjectKeyHash,
    policyVersion: args.operation.policyVersion,
    status: args.operation.status,
    cause: args.cause,
    pass: args.operation.retryCount,
    requestedAt: args.operation.requestedAt.toISOString(),
    startedAt: args.operation.startedAt?.toISOString() ?? null,
    completedAt: args.operation.completedAt?.toISOString() ?? null,
    nextRetryAt: args.operation.nextRetryAt?.toISOString() ?? null,
    legalHoldPolicyId: args.operation.legalHoldPolicyId,
    outcomes: outcomes.map(summarizeOutcome),
    retentionClass: RETENTION_CLASSES.evidence,
    anonymizedRecords: outcomes.reduce((total, outcome) => total + outcome.counts.anonymized, 0),
    retainedRecords: outcomes.reduce((total, outcome) => total + outcome.counts.retained, 0),
  };
}

export function refusedEvent(args: {
  readonly subjectKeyHash: string;
  readonly refusal: string;
  readonly operationId?: string | null;
  readonly policyVersion?: string | null;
  readonly legalHoldPolicyId?: string | null;
}): ErasureRefusedPayload {
  return {
    operationId: args.operationId ?? null,
    subjectKeyHash: args.subjectKeyHash,
    policyVersion: args.policyVersion ?? null,
    refusal: args.refusal,
    legalHoldPolicyId: args.legalHoldPolicyId ?? null,
    retentionClass: RETENTION_CLASSES.evidence,
  };
}

export function inventoriedEvent(args: {
  readonly subjectKeyHash: string;
  readonly policyVersion: string;
  readonly resolvedSubjects: number;
  readonly discovered: number;
  readonly targets: readonly string[];
}): SubjectInventoriedPayload {
  return {
    subjectKeyHash: args.subjectKeyHash,
    policyVersion: args.policyVersion,
    resolvedSubjects: args.resolvedSubjects,
    discovered: args.discovered,
    targets: [...args.targets],
    retentionClass: RETENTION_CLASSES.evidence,
  };
}

/**
 * Guard, then append.
 *
 * The organization scope, not the subject's environment scopes: an erasure is an
 * organization-level act, and an event scoped to one of several environments
 * would be invisible in the others.
 */
export async function appendPrivacyEvent<Payload extends JsonValue>(
  dependencies: PrivacyDependencies,
  args: {
    readonly name: (typeof PRIVACY_EVENT_NAMES)[keyof typeof PRIVACY_EVENT_NAMES];
    readonly organizationId: Parameters<typeof organizationScope>[0];
    readonly payload: Payload;
    readonly handles: readonly string[];
    readonly transaction: TransactionScope;
  },
): Promise<Result<void>> {
  const clean = assertContentFree("erasure-event", args.payload, args.handles);
  if (!clean.ok) return err(clean.error);

  const draft: DomainEventDraft<Payload> = {
    name: args.name,
    schemaVersion: PRIVACY_EVENT_SCHEMA_VERSION,
    scope: organizationScope(args.organizationId),
    requestId: null,
    payload: args.payload,
  };
  await dependencies.outbox.append(draft, args.transaction);
  return ok(undefined);
}
