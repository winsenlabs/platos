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

import type { TokenUsage } from "./token-usage.js";

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
  // message, and an expired binding is a cached provider handle that aged out.
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
  // The seven the SDK-holding adapter needs (WIN-256). Every one of them is a
  // situation the adapter is the only layer that can be in, and every one of
  // them has a DIFFERENT operator response — which is the whole reason they are
  // five codes and not one `PROVIDERS_ADAPTER_FAILED`: a caller that cannot tell
  // "your schema does not compile" from "your tool threw" from "the caller
  // hung up" cannot fix any of the three.
  "PROVIDERS_RETRY_POLICY_INVALID",
  "PROVIDERS_SERVICE_ACCOUNT_INVALID",
  "PROVIDERS_OUTPUT_SCHEMA_INVALID",
  "PROVIDERS_TOOL_EXECUTOR_FAILED",
  "PROVIDERS_GENERATION_ABORTED",
  "PROVIDERS_MESSAGE_NOT_REPRESENTABLE",
  "PROVIDERS_PASS_BUDGET_INVALID",
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
 * The binding aged out before it was used.
 *
 * `precondition_failed` and not `not_found`: the session was real and the caller
 * did nothing wrong, so the fix is a fresh binding rather than a hunt for
 * something that never existed or a change to configuration that is correct.
 */
export function modelSessionExpired(sessionId: string, expiredAt: string): DomainError {
  return domainError(
    "PROVIDERS_MODEL_SESSION_EXPIRED",
    "precondition_failed",
    "the model session has expired and must be opened again",
    { details: { sessionId, expiredAt } },
  );
}

/**
 * The model produced nothing that satisfies the schema the caller asked for.
 *
 * IT CARRIES WHAT IT SPENT. Every pass was sent and every pass was billed, and a
 * failure is the one outcome with no `ModelGeneration` to hang a usage record
 * on: the port returns `Result<ModelGeneration>`, so an `err` has nowhere else
 * to put the four counts. The streaming surface does not have this problem — it
 * emits a `step-finished` event per pass before it emits `failed` — and a
 * non-streaming failure that reported nothing would have made the same turn cost
 * a different amount depending on which entry point ran it.
 *
 * `spent` is a required argument, not an optional one. A caller that cannot say
 * what a loop cost should not be running a loop that costs anything.
 */
export function structuredOutputInvalid(
  reason: string,
  passes: number,
  spent: TokenUsage,
): DomainError {
  return domainError(
    "PROVIDERS_STRUCTURED_OUTPUT_INVALID",
    "invalid_input",
    "the model did not produce output matching the requested schema",
    {
      details: {
        reason,
        passes,
        inputTokens: spent.inputTokens,
        outputTokens: spent.outputTokens,
        cacheReadInputTokens: spent.cacheReadInputTokens,
        cacheWriteInputTokens: spent.cacheWriteInputTokens,
      },
    },
  );
}

// --- the adapter surface -----------------------------------------------------
//
// The `ModelRouter` port forbids a vendor error from escaping: a caller banned
// from importing the SDK (ADR M0.3 §2) cannot catch a typed error from it. These
// seven are the translations that had nowhere to land before, and they are minted
// HERE, beside every other code this context can produce, so an operator
// grepping a log still finds exactly one definition per code.

/**
 * A retry rule the transport cannot honour.
 *
 * Refused when the transport is BUILT rather than when a rule first fires,
 * because a negative retry count or a non-integer backoff is a configuration
 * defect whose only symptom would otherwise be a call that behaves oddly under
 * a failure nobody is producing on purpose.
 */
export function retryPolicyInvalid(reason: string, field: string, value: unknown): DomainError {
  return domainError("PROVIDERS_RETRY_POLICY_INVALID", "invalid_input", reason, {
    details: { field, value: String(value) },
  });
}

/**
 * The credential a service-account route needs is not a service-account document.
 *
 * Distinct from `provider_credential_unavailable`, which means the material
 * could not be READ. Here it was read perfectly and is the wrong KIND of thing,
 * and the operator's next step is to replace the credential rather than to
 * investigate the vault.
 */
export function serviceAccountInvalid(reason: string, provider: string): DomainError {
  return domainError(
    "PROVIDERS_SERVICE_ACCOUNT_INVALID",
    "precondition_failed",
    CREDENTIAL_UNAVAILABLE,
    { details: { reason, provider } },
  );
}

/**
 * The caller's own output schema will not compile.
 *
 * Deliberately NOT `structured_output_invalid`. That code means the MODEL
 * produced the wrong thing and a retry might fix it; this one means the request
 * was never answerable and no retry ever will. Sharing a code would have sent an
 * operator hunting a model for a defect in the caller.
 */
export function outputSchemaInvalid(reason: string): DomainError {
  return domainError(
    "PROVIDERS_OUTPUT_SCHEMA_INVALID",
    "invalid_input",
    "the requested output schema is not a usable JSON Schema document",
    { details: { reason } },
  );
}

/**
 * The caller's `ToolExecutor` rejected rather than answering.
 *
 * The port is explicit that a tool which FAILED is a `ToolResultPart` with
 * `failed: true` and not an error, because the model is often able to recover.
 * A rejected promise is therefore a defect in the caller, and it ends the
 * generation under its own code so it is never mistaken for a provider outage.
 */
export function toolExecutorFailed(toolName: string, reason: string): DomainError {
  return domainError(
    "PROVIDERS_TOOL_EXECUTOR_FAILED",
    "internal",
    "the supplied tool executor rejected instead of answering the model",
    { details: { toolName, reason } },
  );
}

/**
 * The caller abandoned the generation.
 *
 * `precondition_failed` and not `unavailable`: nothing is wrong upstream and
 * retrying is pointless. It is a distinct code because a turn that the operator
 * stopped and a turn the provider dropped look identical in a log otherwise, and
 * only one of them is worth paging about.
 */
export function generationAborted(reason: string): DomainError {
  return domainError("PROVIDERS_GENERATION_ABORTED", "precondition_failed", "the generation was abandoned", {
    details: { reason },
  });
}

/**
 * A message this system can express that the provider's wire format cannot.
 *
 * `promptMessage` admits any content part in any role, because what a role may
 * carry is a WIRE fact and not a domain one: a system message is a string on
 * every provider in the catalogue, and an assistant message has no place to put
 * an image. Refusing at the boundary that knows, under a code that names the
 * role and the part, is what turns "the provider rejected your request" into a
 * sentence the caller can act on without a round trip.
 */
export function messageNotRepresentable(role: string, part: string): DomainError {
  return domainError(
    "PROVIDERS_MESSAGE_NOT_REPRESENTABLE",
    "invalid_input",
    "a message carries a content part the provider's wire format has no place for",
    { details: { role, part } },
  );
}

/**
 * A pass budget: a whole number, at least one.
 *
 * Separate from `stepBudgetInvalid` because it bounds a different loop with a
 * different cost. A STEP is a tool round trip; a PASS is a whole second
 * generation with the first one's output quoted back inside it, which is the
 * more expensive of the two to run away. Sharing one code would have left an
 * operator unable to tell which budget was wrong.
 */
export function passBudgetInvalid(maxPasses: number): DomainError {
  return domainError(
    "PROVIDERS_PASS_BUDGET_INVALID",
    "invalid_input",
    "a schema-shaped generation must be allowed at least one pass, and a whole number of them",
    { details: { maxPasses } },
  );
}
