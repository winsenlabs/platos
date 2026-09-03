// The `eventing` error catalogue.
//
// M0.4 §2 fixes `code` as a SCREAMING_SNAKE string that is immutable within a
// major, and the kernel makes an error a VALUE rather than a thrown class. Every
// code this context can produce is minted here, once, so a transport builds its
// status table from one list and an operator grepping a log finds exactly one
// definition.
//
// The legacy `McpEventsService` raised all of these as bare `new Error(string)`
// with the message as the only discriminator — "name must be 1–120 chars",
// "filters.eventTypes must be a non-empty array", "delivery invalid". A caller
// could only tell them apart by matching prose. These codes are that same set of
// refusals, made addressable.

import { domainError, type DomainError, type FieldViolation } from "@platos/kernel";

export const EVENTING_ERROR_CODES = [
  "EVENTING_RULE_NAME_INVALID",
  "EVENTING_RULE_NAME_TAKEN",
  "EVENTING_RULE_FILTERS_INVALID",
  "EVENTING_RULE_PATTERN_INVALID",
  "EVENTING_RULE_DESTINATION_INVALID",
  "EVENTING_RULE_DESTINATION_REJECTED",
  "EVENTING_RULE_NOT_FOUND",
  "EVENTING_RULE_DISABLED",
  "EVENTING_REPOSITORY_UNAVAILABLE",
  "EVENTING_QUEUE_UNAVAILABLE",
  "EVENTING_SCREEN_UNAVAILABLE",
  "EVENTING_ERASURE_PLAN_FOREIGN",
] as const;

export type EventingErrorCode = (typeof EVENTING_ERROR_CODES)[number];

export function ruleNameInvalid(message: string, fields: readonly FieldViolation[] = []): DomainError {
  return domainError("EVENTING_RULE_NAME_INVALID", "invalid_input", message, { fields });
}

/** The `@@unique([environmentId, name])` constraint, expressed in the domain. */
export function ruleNameTaken(name: string): DomainError {
  return domainError(
    "EVENTING_RULE_NAME_TAKEN",
    "conflict",
    "a notification rule with that name already exists in this environment",
    { details: { name } },
  );
}

export function ruleFiltersInvalid(message: string, fields: readonly FieldViolation[] = []): DomainError {
  return domainError("EVENTING_RULE_FILTERS_INVALID", "invalid_input", message, { fields });
}

export function rulePatternInvalid(pattern: string, reason: string): DomainError {
  return domainError("EVENTING_RULE_PATTERN_INVALID", "invalid_input", reason, {
    details: { pattern },
  });
}

export function ruleDestinationInvalid(message: string): DomainError {
  return domainError("EVENTING_RULE_DESTINATION_INVALID", "invalid_input", message);
}

/**
 * `forbidden`, not `invalid_input`: the destination is WELL FORMED and was
 * refused on where it points. That is the SSRF denial, and conflating it with a
 * shape error would let an operator conclude they had typed the URL wrongly when
 * in fact the URL resolved somewhere they may not reach.
 */
export function ruleDestinationRejected(reason: string): DomainError {
  return domainError(
    "EVENTING_RULE_DESTINATION_REJECTED",
    "forbidden",
    `destination was rejected: ${reason}`,
    { details: { reason } },
  );
}

export function ruleNotFound(ruleId: string): DomainError {
  return domainError("EVENTING_RULE_NOT_FOUND", "not_found", "notification rule is not visible in this scope", {
    details: { ruleId },
  });
}

export function ruleDisabled(ruleId: string): DomainError {
  return domainError(
    "EVENTING_RULE_DISABLED",
    "precondition_failed",
    "notification rule is disabled — enable it first",
    { details: { ruleId } },
  );
}

export function repositoryUnavailable(reason: string): DomainError {
  return domainError("EVENTING_REPOSITORY_UNAVAILABLE", "unavailable", "eventing repository is unavailable", {
    retryAfterSeconds: 5,
    details: { reason },
  });
}

export function queueUnavailable(reason: string): DomainError {
  return domainError("EVENTING_QUEUE_UNAVAILABLE", "unavailable", "notification queue is unavailable", {
    retryAfterSeconds: 5,
    details: { reason },
  });
}

export function screenUnavailable(reason: string): DomainError {
  return domainError("EVENTING_SCREEN_UNAVAILABLE", "unavailable", "destination screen is unavailable", {
    retryAfterSeconds: 5,
    details: { reason },
  });
}

/**
 * The kernel's `ErasurePlan` carries no subject, so a target handed a plan it did
 * not mint cannot know whose rows to act on. Refusing is the only safe answer.
 */
export function erasurePlanForeign(targetName: string): DomainError {
  return domainError(
    "EVENTING_ERASURE_PLAN_FOREIGN",
    "precondition_failed",
    "erasure plan was not produced by this target and carries no subject to act on",
    { details: { targetName } },
  );
}
