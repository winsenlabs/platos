// The `channels` error catalogue.
//
// M0.4 §2 fixes `code` as a SCREAMING_SNAKE string that is immutable within a
// major, and the kernel makes an error a VALUE rather than a thrown class. Every
// code this context can produce is minted here, once, so a transport can build
// its status table from one list and an operator grepping a log finds exactly
// one definition.
//
// The `CHANNELS_ADAPTER_*` codes are the provider's failure modes expressed in
// this context's vocabulary. A `ChannelAdapter` maps its SDK's errors onto them
// and never lets a vendor error escape: this context is the sole holder of the
// Slack/etc SDKs (ADR M0.3 §1), so a caller must be able to tell "the workspace
// revoked us" from "the provider is down" without catching a typed exception
// from a library every other package is forbidden to import.

import { domainError, type DomainError, type FieldViolation } from "@platos/kernel";

export const CHANNELS_ERROR_CODES = [
  "CHANNELS_CONNECTION_NOT_FOUND",
  "CHANNELS_CONNECTION_DISABLED",
  "CHANNELS_APP_NOT_FOUND",
  "CHANNELS_INSTALLATION_NOT_FOUND",
  "CHANNELS_INSTALLATION_REVOKED",
  "CHANNELS_ROUTING_INVALID",
  "CHANNELS_ROUTING_AGENT_UNKNOWN",
  "CHANNELS_ROUTING_UNRESOLVED",
  "CHANNELS_THREAD_KEY_INVALID",
  "CHANNELS_THREAD_LINK_CONFLICT",
  "CHANNELS_EVENT_DUPLICATE",
  "CHANNELS_EVENT_NOT_FOUND",
  "CHANNELS_EVENT_LEASE_LOST",
  "CHANNELS_EVENT_NOT_CLAIMABLE",
  "CHANNELS_EVENT_PAYLOAD_INVALID",
  "CHANNELS_REFRESH_NOT_CLAIMABLE",
  "CHANNELS_REFRESH_LOST",
  "CHANNELS_REFRESH_REPAIR_REQUIRED",
  "CHANNELS_ADAPTER_UNAUTHORIZED",
  "CHANNELS_ADAPTER_UNAVAILABLE",
  "CHANNELS_ADAPTER_REJECTED",
  "CHANNELS_REPOSITORY_UNAVAILABLE",
  "CHANNELS_ERASURE_PLAN_FOREIGN",
] as const;

export type ChannelsErrorCode = (typeof CHANNELS_ERROR_CODES)[number];

export function connectionNotFound(connectionId: string): DomainError {
  return domainError("CHANNELS_CONNECTION_NOT_FOUND", "not_found", "channel connection is not visible in this scope", {
    details: { connectionId },
  });
}

/**
 * `precondition_failed`, not `forbidden`: the caller is entitled to the row, and
 * the operator disabled it. Re-enabling is the remedy, so the category must not
 * suggest an authorization problem.
 */
export function connectionDisabled(connectionId: string): DomainError {
  return domainError("CHANNELS_CONNECTION_DISABLED", "precondition_failed", "channel connection is disabled", {
    details: { connectionId },
  });
}

export function appNotFound(appId: string): DomainError {
  return domainError("CHANNELS_APP_NOT_FOUND", "not_found", "channel app is not visible in this scope", {
    details: { appId },
  });
}

export function installationNotFound(installationId: string): DomainError {
  return domainError("CHANNELS_INSTALLATION_NOT_FOUND", "not_found", "channel installation is not visible in this scope", {
    details: { installationId },
  });
}

export function installationRevoked(installationId: string, revokedAt: string | null): DomainError {
  return domainError("CHANNELS_INSTALLATION_REVOKED", "precondition_failed", "channel installation is revoked", {
    details: { installationId, revokedAt },
  });
}

export function routingInvalid(message: string, fields: readonly FieldViolation[] = []): DomainError {
  return domainError("CHANNELS_ROUTING_INVALID", "invalid_input", message, { fields });
}

/**
 * The forged-id guard. A stored routing table must never point at an agent
 * outside the environment that owns the connection, so an unknown id is
 * rejected at WRITE time and can therefore never be reached at read time.
 */
export function routingAgentUnknown(agentIds: readonly string[]): DomainError {
  return domainError(
    "CHANNELS_ROUTING_AGENT_UNKNOWN",
    "invalid_input",
    `agentRouting references agent id(s) not in scope: ${[...agentIds].join(", ")}`,
    { details: { agentIds: [...agentIds] } },
  );
}

/**
 * No rule matched and no default is configured. Raised rather than defaulted:
 * silently dropping an inbound message is the failure mode an operator cannot
 * see, and picking an arbitrary agent is worse.
 */
export function routingUnresolved(): DomainError {
  return domainError(
    "CHANNELS_ROUTING_UNRESOLVED",
    "precondition_failed",
    "no routing rule matched and no default agent is configured",
  );
}

export function threadKeyInvalid(message: string): DomainError {
  return domainError("CHANNELS_THREAD_KEY_INVALID", "invalid_input", message);
}

/**
 * The `[connectionId, channelThreadKey]` / `[installationId, channelThreadKey]`
 * uniques, expressed in the domain: one channel conversation maps to exactly one
 * Platos thread, forever. Re-linking it elsewhere would silently split a
 * transcript.
 */
export function threadLinkConflict(channelThreadKey: string, linkedThreadId: string, requestedThreadId: string): DomainError {
  return domainError(
    "CHANNELS_THREAD_LINK_CONFLICT",
    "conflict",
    "channel thread is already linked to a different thread",
    { details: { channelThreadKey, linkedThreadId, requestedThreadId } },
  );
}

/**
 * Not an error the caller must fix — the `[appId, eventId]` unique doing its
 * job. Admission returns this so a redelivery is *reported* as a duplicate
 * rather than admitted twice or silently swallowed; `admitChannelEvent` turns it
 * into an idempotent success.
 */
export function eventDuplicate(eventId: string): DomainError {
  return domainError("CHANNELS_EVENT_DUPLICATE", "conflict", "channel event was already admitted", {
    details: { eventId },
  });
}

export function eventNotFound(inboxId: string): DomainError {
  return domainError("CHANNELS_EVENT_NOT_FOUND", "not_found", "channel event is not in the inbox", {
    details: { inboxId },
  });
}

/**
 * The lease fence. Raised when a worker acts on a row whose lease it no longer
 * holds — because the lease expired and another worker claimed it, bumping
 * `leaseGeneration`. Returning this rather than writing anyway is what stops two
 * workers from both completing the same event.
 */
export function eventLeaseLost(inboxId: string): DomainError {
  return domainError("CHANNELS_EVENT_LEASE_LOST", "conflict", "channel event lease is no longer held by this worker", {
    details: { inboxId },
  });
}

export function eventNotClaimable(inboxId: string, status: string): DomainError {
  return domainError("CHANNELS_EVENT_NOT_CLAIMABLE", "precondition_failed", "channel event is not claimable", {
    details: { inboxId, status },
  });
}

export function eventPayloadInvalid(message: string): DomainError {
  return domainError("CHANNELS_EVENT_PAYLOAD_INVALID", "invalid_input", message);
}

export function refreshNotClaimable(installationId: string, state: string): DomainError {
  return domainError(
    "CHANNELS_REFRESH_NOT_CLAIMABLE",
    "conflict",
    "installation credential refresh is not claimable in its current state",
    { details: { installationId, state } },
  );
}

/**
 * The refresh fence, and the reason it exists. A rotating grant may be redeemed
 * exactly once: if the row moved underneath an in-flight refresh, the token this
 * retry is holding is already stale, and committing it would overwrite a newer
 * credential with a dead one.
 */
export function refreshLost(installationId: string): DomainError {
  return domainError(
    "CHANNELS_REFRESH_LOST",
    "conflict",
    "installation moved during refresh; this claim's grant must not be committed",
    { details: { installationId } },
  );
}

/**
 * Terminal until an operator re-authorizes. A rotating grant was consumed and
 * the replacement was never committed, so no usable credential remains and
 * retrying cannot produce one.
 */
export function refreshRepairRequired(installationId: string, repairCode: string | null): DomainError {
  return domainError(
    "CHANNELS_REFRESH_REPAIR_REQUIRED",
    "precondition_failed",
    "installation credential is unrecoverable and needs operator re-authorization",
    { details: { installationId, repairCode } },
  );
}

export function adapterUnauthorized(provider: string, reason: string): DomainError {
  return domainError("CHANNELS_ADAPTER_UNAUTHORIZED", "forbidden", "provider rejected the credential", {
    details: { provider, reason },
  });
}

export function adapterUnavailable(provider: string, reason: string, retryAfterSeconds = 5): DomainError {
  return domainError("CHANNELS_ADAPTER_UNAVAILABLE", "unavailable", "channel provider is unavailable", {
    retryAfterSeconds,
    details: { provider, reason },
  });
}

export function adapterRejected(provider: string, reason: string): DomainError {
  return domainError("CHANNELS_ADAPTER_REJECTED", "invalid_input", "provider rejected the outbound message", {
    details: { provider, reason },
  });
}

export function repositoryUnavailable(reason: string): DomainError {
  return domainError("CHANNELS_REPOSITORY_UNAVAILABLE", "unavailable", "channels repository is unavailable", {
    retryAfterSeconds: 5,
    details: { reason },
  });
}

/**
 * The kernel's `ErasurePlan` carries no subject, so a target handed a plan it did
 * not mint cannot know whose rows to destroy. Refusing is the only safe answer.
 */
export function erasurePlanForeign(targetName: string): DomainError {
  return domainError(
    "CHANNELS_ERASURE_PLAN_FOREIGN",
    "precondition_failed",
    "erasure plan was not produced by this target and carries no subject to act on",
    { details: { targetName } },
  );
}
