// The `providers` error catalogue.
//
// M0.4 §2 fixes `code` as a SCREAMING_SNAKE string that is immutable within a
// major, and the kernel makes an error a VALUE rather than a thrown class. Every
// code this context can produce is minted here, once, so a transport builds its
// status table from one list and an operator grepping a log finds exactly one
// definition.
//
// THE EXTRACTION SOURCE HAD TWO ERROR VOCABULARIES AND THEY ARE BOTH PRESERVED.
//
//   `ProviderKeyError`     — the CONTROL surface: not_found, already_exists,
//                            credential_unavailable, pinned_agents.
//   `ProviderRuntimeError` — the RUNTIME surface: four codes whose messages are
//                            deliberately uninformative because they are
//                            returned to a client.
//
// Merging them would have lost a real distinction. `credential_unavailable` on
// the control surface means "the operator named a credential that does not
// exist" (a 404 the operator can fix), while `provider_credential_unavailable`
// at runtime means "the key resolved but its envelope could not be read" (an
// operational failure the caller cannot fix). They are separate codes below.
//
// THE SAFE-MESSAGE RULE IS KEPT. Every runtime message here is the same
// content-free sentence the source returns, and the diagnosis goes in `details`,
// which the kernel documents as never returned to a client. That is what lets an
// operator tell a missing ProviderKey from a failed authorization from a
// decryption failure without any of it reaching the wire.

import { domainError, type DomainError, type FieldViolation } from "@platos/kernel";

export const PROVIDERS_ERROR_CODES = [
  "PROVIDERS_UNKNOWN_PROVIDER",
  "PROVIDERS_KEY_NOT_FOUND",
  "PROVIDERS_KEY_ALREADY_EXISTS",
  "PROVIDERS_KEY_PINNED_BY_AGENTS",
  "PROVIDERS_KEY_METADATA_INVALID",
  "PROVIDERS_CREDENTIAL_UNAVAILABLE",
  "PROVIDERS_SCOPE_MISMATCH",
  "PROVIDERS_CONFIGURATION_UNAVAILABLE",
  "PROVIDERS_PROVIDER_CREDENTIAL_UNAVAILABLE",
  "PROVIDERS_PROVIDER_REQUEST_FAILED",
  "PROVIDERS_MODEL_STRING_INVALID",
  "PROVIDERS_MODEL_KEY_INVALID",
  "PROVIDERS_MODEL_RATE_INVALID",
  "PROVIDERS_RATE_CARD_INVALID",
  "PROVIDERS_MODEL_PRICING_UNAVAILABLE",
  "PROVIDERS_PRICE_REVISION_CONFLICT",
  "PROVIDERS_TOKEN_USAGE_INVALID",
  "PROVIDERS_REPOSITORY_UNAVAILABLE",
  // The inference surface (ADR M0.3 §14). Ten codes and not one, because each
  // names a different thing the caller did and a caller that cannot tell them
  // apart cannot fix any of them: a prompt with no messages is a bug in the
  // assembler, a tool result with no matching call is a dropped assistant
  // message, and an expired session is a turn that simply ran too long.
  "PROVIDERS_PROMPT_EMPTY",
  "PROVIDERS_PROMPT_CONTENT_EMPTY",
  "PROVIDERS_MEDIA_TYPE_MISSING",
  "PROVIDERS_TOOL_CALL_DUPLICATED",
  "PROVIDERS_TOOL_RESULT_UNMATCHED",
  "PROVIDERS_TOOL_NAME_DUPLICATED",
  "PROVIDERS_CACHE_BUDGET_EXCEEDED",
  "PROVIDERS_STEP_BUDGET_INVALID",
  "PROVIDERS_MODEL_SESSION_EXPIRED",
  "PROVIDERS_STRUCTURED_OUTPUT_INVALID",
] as const;

export type ProvidersErrorCode = (typeof PROVIDERS_ERROR_CODES)[number];

/** The one message a client is ever shown for a runtime resolution failure. */
const CONFIGURATION_UNAVAILABLE = "Provider configuration is unavailable for this environment.";
const CREDENTIAL_UNAVAILABLE = "Provider credential is unavailable for this environment.";
const REQUEST_FAILED = "Provider request failed.";
const PRICING_UNAVAILABLE = "Canonical model pricing is unavailable.";

export function unknownProvider(providerId: string): DomainError {
  return domainError("PROVIDERS_UNKNOWN_PROVIDER", "not_found", "no such provider", {
    details: { providerId },
  });
}

export function providerKeyNotFound(providerKeyId: string): DomainError {
  return domainError("PROVIDERS_KEY_NOT_FOUND", "not_found", "provider key is not visible in this scope", {
    details: { providerKeyId },
  });
}

/** The `@@unique([environmentId, provider, label])` constraint, in the domain. */
export function providerKeyAlreadyExists(provider: string, label: string): DomainError {
  return domainError(
    "PROVIDERS_KEY_ALREADY_EXISTS",
    "conflict",
    "a provider key with that label already exists for this provider in this environment",
    { details: { provider, label } },
  );
}

/**
 * Deleting a key an agent version still names would leave that version
 * unrunnable, so the delete is refused and the count travels with the error —
 * the control surface renders it, exactly as the source does.
 */
export function providerKeyPinnedByAgents(providerKeyId: string, pinnedAgents: number): DomainError {
  return domainError(
    "PROVIDERS_KEY_PINNED_BY_AGENTS",
    "conflict",
    "provider key is still pinned by an agent version and cannot be removed",
    { details: { providerKeyId, pinnedAgents } },
  );
}

export function providerKeyMetadataInvalid(
  message: string,
  fields: readonly FieldViolation[] = [],
): DomainError {
  return domainError("PROVIDERS_KEY_METADATA_INVALID", "invalid_input", message, { fields });
}

/**
 * The operator named a credential that is not present, not this provider's, or
 * not usable. `not_found`, because from the operator's position the thing they
 * named does not exist here.
 */
export function credentialUnavailable(name: string, provider: string): DomainError {
  return domainError(
    "PROVIDERS_CREDENTIAL_UNAVAILABLE",
    "not_found",
    "no usable credential of that name exists for this provider in this environment",
    { details: { name, provider } },
  );
}

/**
 * `forbidden`, not `not_found`: the grant resolves, but to a different place in
 * the tenant tree than the caller claimed. The source raises `not_found` here to
 * avoid confirming existence; the code is distinct so a transport can keep that
 * behaviour deliberately rather than by accident.
 */
export function scopeMismatch(expectedPath: string, grantedPath: string): DomainError {
  return domainError(
    "PROVIDERS_SCOPE_MISMATCH",
    "forbidden",
    "authorization does not belong to the requested scope",
    { details: { expectedPath, grantedPath } },
  );
}

/** Runtime: no key could be resolved, or the routing plan could not be built. */
export function configurationUnavailable(reason: string, context: ErrorContext = {}): DomainError {
  return domainError("PROVIDERS_CONFIGURATION_UNAVAILABLE", "precondition_failed", CONFIGURATION_UNAVAILABLE, {
    details: { reason, ...context },
  });
}

/** Runtime: a key resolved, and its credential could not be read. */
export function providerCredentialUnavailable(reason: string, context: ErrorContext = {}): DomainError {
  return domainError(
    "PROVIDERS_PROVIDER_CREDENTIAL_UNAVAILABLE",
    "precondition_failed",
    CREDENTIAL_UNAVAILABLE,
    { details: { reason, ...context } },
  );
}

/** Runtime: the provider itself refused or could not be reached. */
export function providerRequestFailed(reason: string, retryAfterSeconds = 5): DomainError {
  return domainError("PROVIDERS_PROVIDER_REQUEST_FAILED", "unavailable", REQUEST_FAILED, {
    retryAfterSeconds,
    details: { reason },
  });
}

/** Structured, already-safe context for a runtime failure. Never a secret. */
export interface ErrorContext {
  readonly provider?: string;
  readonly name?: string;
  readonly environmentId?: string;
  readonly providerKeyId?: string;
  readonly model?: string;
}

export function modelStringInvalid(message: string, model: string): DomainError {
  return domainError("PROVIDERS_MODEL_STRING_INVALID", "invalid_input", message, {
    details: { model },
  });
}

export function modelKeyInvalid(message: string): DomainError {
  return domainError("PROVIDERS_MODEL_KEY_INVALID", "invalid_input", message);
}

export function modelRateInvalid(message: string, details: Readonly<Record<string, string>> = {}): DomainError {
  return domainError("PROVIDERS_MODEL_RATE_INVALID", "invalid_input", message, { details });
}

/** The catalogue document itself is unusable, before any model is read from it. */
export function rateCardInvalid(message: string): DomainError {
  return domainError("PROVIDERS_RATE_CARD_INVALID", "invalid_input", message);
}

/**
 * No rate card covers this model at this instant. The source raises this as
 * `ModelPricingUnavailableError`, optionally naming the one rate that was
 * missing — a priced turn must not silently bill zero for a rate nobody knows.
 */
export function modelPricingUnavailable(model: string, rate: string | null = null): DomainError {
  return domainError("PROVIDERS_MODEL_PRICING_UNAVAILABLE", "not_found", PRICING_UNAVAILABLE, {
    details: { model, rate },
  });
}

/** The `@@unique([modelId, effectiveFrom])` constraint, in the domain. */
export function priceRevisionConflict(modelKey: string, effectiveFrom: string): DomainError {
  return domainError(
    "PROVIDERS_PRICE_REVISION_CONFLICT",
    "conflict",
    "a price card already exists for that model at that instant; the ledger is append-only",
    { details: { modelKey, effectiveFrom } },
  );
}

export function tokenUsageInvalid(message: string, details: Readonly<Record<string, number>> = {}): DomainError {
  return domainError("PROVIDERS_TOKEN_USAGE_INVALID", "invalid_input", message, { details });
}

export function repositoryUnavailable(reason: string): DomainError {
  return domainError("PROVIDERS_REPOSITORY_UNAVAILABLE", "unavailable", "providers repository is unavailable", {
    retryAfterSeconds: 5,
    details: { reason },
  });
}

// --- the inference surface ---------------------------------------------------
//
// These are `invalid_input` rather than runtime refusals, and that is the point.
// Every one of them is a defect in the request the caller assembled, detectable
// before any material moves and before a provider is paid for a round trip that
// was always going to be rejected. The safe-message rule above does not apply:
// the caller here is another context inside this process, not a client.

export function promptEmpty(): DomainError {
  return domainError("PROVIDERS_PROMPT_EMPTY", "invalid_input", "a prompt must carry at least one message");
}

export function promptContentEmpty(role: string): DomainError {
  return domainError(
    "PROVIDERS_PROMPT_CONTENT_EMPTY",
    "invalid_input",
    "a message must carry at least one content part",
    { details: { role } },
  );
}

/**
 * An image or file part with no media type.
 *
 * Named separately from every other malformed part because it is the one the
 * source shipped: a part built without it failed the whole turn at the provider,
 * and only images survived, by having their bytes sniffed.
 */
export function mediaTypeMissing(role: string, part: string): DomainError {
  return domainError(
    "PROVIDERS_MEDIA_TYPE_MISSING",
    "invalid_input",
    "an image or file part must declare its media type",
    { details: { role, part } },
  );
}

export function toolCallDuplicated(toolCallId: string): DomainError {
  return domainError(
    "PROVIDERS_TOOL_CALL_DUPLICATED",
    "invalid_input",
    "the same tool call id is asked for twice in one prompt",
    { details: { toolCallId } },
  );
}

export function toolResultUnmatched(toolCallId: string, toolName: string): DomainError {
  return domainError(
    "PROVIDERS_TOOL_RESULT_UNMATCHED",
    "invalid_input",
    "a tool result answers a call that was never asked for, or answers it twice",
    { details: { toolCallId, toolName } },
  );
}

export function toolNameDuplicated(toolName: string): DomainError {
  return domainError(
    "PROVIDERS_TOOL_NAME_DUPLICATED",
    "invalid_input",
    "two tool definitions in one request carry the same name",
    { details: { toolName } },
  );
}

/**
 * More cache breakpoints than the plan's provider will honour.
 *
 * A provider that receives too many does not fail loudly — it drops the overflow
 * in document order, which discards the NEWEST breakpoint and silently turns
 * caching off from that step onward. Refusing here is what makes that failure
 * visible instead of expensive.
 */
export function cacheBudgetExceeded(placed: number, allowed: number): DomainError {
  return domainError(
    "PROVIDERS_CACHE_BUDGET_EXCEEDED",
    "invalid_input",
    "the prompt carries more cache breakpoints than the provider will honour",
    { details: { placed, allowed } },
  );
}

export function stepBudgetInvalid(maxSteps: number): DomainError {
  return domainError(
    "PROVIDERS_STEP_BUDGET_INVALID",
    "invalid_input",
    "a generation must be allowed at least one step, and a whole number of them",
    { details: { maxSteps } },
  );
}

/**
 * The handle outlived its binding.
 *
 * `precondition_failed` and not `not_found`: the session was real, the caller
 * did nothing wrong, and the fix is to open the route again rather than to go
 * looking for something that never existed.
 */
export function modelSessionExpired(sessionId: string, expiredAt: string): DomainError {
  return domainError(
    "PROVIDERS_MODEL_SESSION_EXPIRED",
    "precondition_failed",
    "the model session has expired and must be opened again",
    { details: { sessionId, expiredAt } },
  );
}

/** The model produced nothing that satisfies the schema the caller asked for. */
export function structuredOutputInvalid(reason: string, passes: number): DomainError {
  return domainError(
    "PROVIDERS_STRUCTURED_OUTPUT_INVALID",
    "invalid_input",
    "the model did not produce output matching the requested schema",
    { details: { reason, passes } },
  );
}
