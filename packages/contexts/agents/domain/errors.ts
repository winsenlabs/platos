// The `agents` error catalogue.
//
// M0.4 §2 fixes `code` as a SCREAMING_SNAKE string that is immutable within a
// major, and the kernel makes an error a VALUE rather than a thrown class. Every
// code this context can produce is minted here, once, so a transport builds its
// status table from one list and an operator grepping a log finds exactly one
// definition.
//
// THE EXTRACTION SOURCE THREW BARE `Error("Agent not found")` FROM TWENTY
// PLACES. That string is the same sentence for four genuinely different
// outcomes — no such agent, an agent in another project, an agent with no
// binding in this environment, and an agent whose active version row is gone —
// and a transport cannot tell them apart without matching on prose. They are
// four codes below, and the two that must not confirm existence (`NOT_FOUND`
// for a cross-scope read, `CLUSTER_NOT_FOUND` for a cross-scope cluster) keep
// the source's deliberate `not_found` category so probing still cannot
// enumerate ids.
//
// THE MACRO GATE KEEPS ITS TWO ANSWERS. `macros.get` on a macro the caller may
// not see answers "not found in scope" while `macros.update` on a macro the
// caller can READ but does not OWN answers "not editable by this token". That
// distinction is deliberate in the source — a shared macro is legitimately
// visible and legitimately immutable — so it is two codes here, not one.

import { domainError, type DomainError, type FieldViolation } from "@platos/kernel";

export const AGENTS_ERROR_CODES = [
  "AGENTS_AGENT_NOT_FOUND",
  "AGENTS_AGENT_NOT_BOUND",
  "AGENTS_AGENT_ALREADY_EXISTS",
  "AGENTS_AGENT_METADATA_INVALID",
  "AGENTS_VERSION_NOT_FOUND",
  "AGENTS_VERSION_INVALID",
  "AGENTS_CANARY_ABSENT",
  "AGENTS_CLUSTER_NOT_FOUND",
  "AGENTS_CLUSTER_ALREADY_EXISTS",
  "AGENTS_ROUTE_INVALID",
  "AGENTS_ROUTE_NOT_FOUND",
  "AGENTS_PROVIDER_KEY_UNAVAILABLE",
  "AGENTS_SKILL_NOT_LOADED",
  "AGENTS_MACRO_NOT_FOUND",
  "AGENTS_MACRO_NOT_EDITABLE",
  "AGENTS_MACRO_INVALID",
  "AGENTS_MACRO_RECORDING_UNKNOWN",
  "AGENTS_TEMPLATE_NOT_FOUND",
  "AGENTS_TEMPLATE_INVALID",
  "AGENTS_SCOPE_MISMATCH",
  "AGENTS_REPOSITORY_UNAVAILABLE",
] as const;

export type AgentsErrorCode = (typeof AGENTS_ERROR_CODES)[number];

/** No such agent in the caller's project. Never confirms one exists elsewhere. */
export function agentNotFound(agentId: string): DomainError {
  return domainError("AGENTS_AGENT_NOT_FOUND", "not_found", "agent is not visible in this scope", {
    details: { agentId },
  });
}

/**
 * The agent exists in this project and has no binding in THIS environment.
 *
 * Distinct from `agentNotFound` because the remedy is different: an operator
 * told "not bound" knows to bind it here, while "not found" means they are in
 * the wrong project. `not_found` all the same, so the two are indistinguishable
 * to a caller that has no business knowing either.
 */
export function agentNotBound(agentId: string, environmentId: string): DomainError {
  return domainError("AGENTS_AGENT_NOT_BOUND", "not_found", "agent is not bound in this environment", {
    details: { agentId, environmentId },
  });
}

/** The `@@unique([projectId, slug])` constraint, in the domain. */
export function agentAlreadyExists(projectId: string, slug: string): DomainError {
  return domainError(
    "AGENTS_AGENT_ALREADY_EXISTS",
    "conflict",
    "an agent with that slug already exists in this project",
    { details: { projectId, slug } },
  );
}

export function agentMetadataInvalid(message: string, fields: readonly FieldViolation[] = []): DomainError {
  return domainError("AGENTS_AGENT_METADATA_INVALID", "invalid_input", message, { fields });
}

export function versionNotFound(agentId: string, versionId: string): DomainError {
  return domainError("AGENTS_VERSION_NOT_FOUND", "not_found", "no such version for this agent", {
    details: { agentId, versionId },
  });
}

/**
 * A version row that cannot be projected — the active version is missing, or a
 * column holds a shape no reader can use. `precondition_failed` rather than
 * `not_found`: the agent is there and the operator can fix it by saving again.
 */
export function versionInvalid(message: string, details: Readonly<Record<string, string>> = {}): DomainError {
  return domainError("AGENTS_VERSION_INVALID", "precondition_failed", message, { details });
}

/** Promoting when nothing is in canary. The source's exact refusal. */
export function canaryAbsent(agentId: string): DomainError {
  return domainError("AGENTS_CANARY_ABSENT", "conflict", "there is no canary version to promote", {
    details: { agentId },
  });
}

export function clusterNotFound(clusterId: string): DomainError {
  return domainError("AGENTS_CLUSTER_NOT_FOUND", "not_found", "cluster is not visible in this scope", {
    details: { clusterId },
  });
}

/** The `@@unique([environmentId, slug])` constraint, in the domain. */
export function clusterAlreadyExists(environmentId: string, slug: string): DomainError {
  return domainError(
    "AGENTS_CLUSTER_ALREADY_EXISTS",
    "conflict",
    "a cluster with that slug already exists in this environment",
    { details: { environmentId, slug } },
  );
}

export function routeInvalid(message: string, fields: readonly FieldViolation[] = []): DomainError {
  return domainError("AGENTS_ROUTE_INVALID", "invalid_input", message, { fields });
}

/** A label a caller selected that this version's routing table does not carry. */
export function routeNotFound(label: string): DomainError {
  return domainError("AGENTS_ROUTE_NOT_FOUND", "not_found", "no model route carries that label", {
    details: { label },
  });
}

/**
 * The pinned provider key does not resolve, or resolves to a different provider
 * than the route's model names.
 *
 * The message is the source's, word for word, because it is the sentence an
 * operator reads when a turn fails closed rather than falling back to an ambient
 * platform credential.
 */
export function providerKeyUnavailable(
  providerKeyId: string,
  provider: string,
  reason: "unresolved" | "provider-mismatch",
): DomainError {
  return domainError(
    "AGENTS_PROVIDER_KEY_UNAVAILABLE",
    "precondition_failed",
    "no provider key with the pinned id for this provider in this environment",
    { details: { providerKeyId, provider, reason } },
  );
}

/** The version does not carry that skill in its loadout. */
export function skillNotLoaded(agentVersionId: string, environmentSkillId: string): DomainError {
  return domainError("AGENTS_SKILL_NOT_LOADED", "not_found", "this version does not carry that skill", {
    details: { agentVersionId, environmentSkillId },
  });
}

export function macroNotFound(macroId: string): DomainError {
  return domainError("AGENTS_MACRO_NOT_FOUND", "not_found", "macro is not visible in this scope", {
    details: { macroId },
  });
}

/** Readable, and not the caller's to change. See the note at the top. */
export function macroNotEditable(macroId: string): DomainError {
  return domainError("AGENTS_MACRO_NOT_EDITABLE", "forbidden", "macro is not editable by this caller", {
    details: { macroId },
  });
}

export function macroInvalid(message: string, fields: readonly FieldViolation[] = []): DomainError {
  return domainError("AGENTS_MACRO_INVALID", "invalid_input", message, { fields });
}

/** Finalising a recording that this caller never started, or already stopped. */
export function macroRecordingUnknown(recordingId: string): DomainError {
  return domainError(
    "AGENTS_MACRO_RECORDING_UNKNOWN",
    "not_found",
    "no active recording with that id for this caller",
    { details: { recordingId } },
  );
}

export function templateNotFound(templateId: string): DomainError {
  return domainError("AGENTS_TEMPLATE_NOT_FOUND", "not_found", "template is not visible in this scope", {
    details: { templateId },
  });
}

export function templateInvalid(message: string, fields: readonly FieldViolation[] = []): DomainError {
  return domainError("AGENTS_TEMPLATE_INVALID", "invalid_input", message, { fields });
}

/**
 * `forbidden`, not `not_found`: the grant resolves, but to a different place in
 * the tenant tree than the caller claimed. Transports that must not confirm
 * existence render it as a 404; the code stays distinct so that is a decision
 * rather than an accident.
 */
export function scopeMismatch(expectedPath: string, grantedPath: string): DomainError {
  return domainError("AGENTS_SCOPE_MISMATCH", "forbidden", "authorization does not belong to the requested scope", {
    details: { expectedPath, grantedPath },
  });
}

export function repositoryUnavailable(reason: string): DomainError {
  return domainError("AGENTS_REPOSITORY_UNAVAILABLE", "unavailable", "agents repository is unavailable", {
    retryAfterSeconds: 5,
    details: { reason },
  });
}
