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
