// The `memory` error catalogue.
//
// M0.4 §2 fixes `code` as a SCREAMING_SNAKE string that is immutable within a
// major, and the kernel makes an error a VALUE rather than a thrown class. Every
// code this context can produce is minted here, once, so a transport builds its
// status table from one list and an operator grepping a log finds exactly one
// definition.
//
// THE EXTRACTION SOURCE THREW BARE `Error`s WITH PROSE MESSAGES, AND FOUR OF
// THEM CARRIED A `code` PROPERTY BOLTED ON AFTER CONSTRUCTION
// (`MEMORY_END_USER_CONTEXT_REQUIRED`, `MEMORY_UNTRUSTED_SOURCE`,
// `MEMORY_INVALID_VISIBILITY`, `MEMORY_INVALID_SOURCE`). Those four are the
// vocabulary that already reached operators, so they keep their spelling below
// and are the only codes here that are not new. The rest of the source's
// failures were message-matched by their callers — a string comparison is what
// currently distinguishes "agent not found" from "agent outside the cluster" —
// and every one of them gets a code.
//
// THE SCOPE-DENIAL CODES ARE DELIBERATELY THREE, NOT ONE. The source raises
// "not found or access denied" for a row in another environment, "outside the
// acting AgentCluster" for a row this agent may not see, and "requires an
// explicit Agent" for an ambiguous write. They are three different operator
// actions — check the scope, check the cluster binding, name the agent — and
// collapsing them into one code would leave a surface unable to say which.

import { domainError, type DomainError, type FieldViolation } from "@platos/kernel";

export const MEMORY_ERROR_CODES = [
  "MEMORY_NOT_FOUND",
  "MEMORY_END_USER_CONTEXT_REQUIRED",
  "MEMORY_SCOPE_MISMATCH",
  "MEMORY_AGENT_SCOPE_DENIED",
  "MEMORY_AGENT_AMBIGUOUS",
  "MEMORY_INVALID_KIND",
  "MEMORY_INVALID_CONTENT",
  "MEMORY_INVALID_METADATA",
  "MEMORY_INVALID_VISIBILITY",
  "MEMORY_INVALID_SOURCE",
  "MEMORY_UNTRUSTED_SOURCE",
  "MEMORY_INVALID_CONFIDENCE",
  "MEMORY_PROVENANCE_INCOMPLETE",
  "MEMORY_BULK_LIMIT_EXCEEDED",
  "MEMORY_ENTITY_NOT_FOUND",
  "MEMORY_ENTITY_KEY_INVALID",
  "MEMORY_ENTITY_OWNERSHIP_CONFLICT",
  "MEMORY_RELATIONSHIP_ENDPOINTS_SPLIT",
  "MEMORY_RELATIONSHIP_INVALID",
  "MEMORY_QUERY_INVALID",
  "MEMORY_EMBEDDING_UNAVAILABLE",
  "MEMORY_EXTRACTION_JUDGE_UNAVAILABLE",
  "MEMORY_EXTRACTION_ENVELOPE_INVALID",
  "MEMORY_CACHE_UNAVAILABLE",
  "MEMORY_CACHE_TTL_INVALID",
  "MEMORY_CACHE_NAMESPACE_INVALID",
  "MEMORY_REPOSITORY_UNAVAILABLE",
] as const;

export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];

export function memoryNotFound(memoryId: string): DomainError {
  return domainError("MEMORY_NOT_FOUND", "not_found", "memory is not visible in this scope", {
    details: { memoryId },
  });
}

/**
 * The source's `MemoryEndUserContextError`, verbatim in code and category.
 *
 * `not_found`, not `forbidden`: the subject either does not exist in this
 * organization or the caller may not see it, and the source refuses to tell the
 * caller which. Keeping that conflation deliberate — rather than splitting it
 * and leaking existence — is the point of the single code.
 */
export function endUserContextRequired(): DomainError {
  return domainError(
    "MEMORY_END_USER_CONTEXT_REQUIRED",
    "not_found",
    "memory end user not found or access denied",
  );
}

/**
 * `forbidden`, not `not_found`: the grant resolves, but to a different place in
 * the tenant tree than the caller claimed. Spelled the same way `providers`
 * spells it, and for the same reason — a transport can then choose deliberately
 * to render it as a 404 rather than doing so by accident.
 */
export function scopeMismatch(expectedPath: string, grantedPath: string): DomainError {
  return domainError("MEMORY_SCOPE_MISMATCH", "forbidden", "authorization does not belong to the requested scope", {
    details: { expectedPath, grantedPath },
  });
}

/** The agent named is not bound here, or is outside the acting cluster. */
export function agentScopeDenied(reason: string, agentId: string | null = null): DomainError {
  return domainError(
    "MEMORY_AGENT_SCOPE_DENIED",
    "forbidden",
    "requested agent is not readable from the acting agent scope",
    { details: { reason, agentId } },
  );
}

/**
 * A write in a multi-agent environment with nothing to attribute it to.
 *
 * `invalid_input`, because the caller can fix it by naming an agent, and the
 * count travels so a surface can say how many it had to choose between.
 */
export function agentAmbiguous(candidateCount: number): DomainError {
  return domainError(
    "MEMORY_AGENT_AMBIGUOUS",
    "invalid_input",
    "memory persistence requires an explicit agent in a multi-agent environment",
    { details: { candidateCount } },
  );
}

export function invalidKind(value: string, permitted: readonly string[]): DomainError {
  return domainError("MEMORY_INVALID_KIND", "invalid_input", `kind must be one of ${permitted.join(", ")}`, {
    details: { value },
    fields: [{ field: "kind", code: "unknown_kind", message: `unknown kind "${value}"` }],
  });
}

export function invalidContent(message: string, fields: readonly FieldViolation[] = []): DomainError {
  return domainError("MEMORY_INVALID_CONTENT", "invalid_input", message, { fields });
}

export function invalidMetadata(message: string, fields: readonly FieldViolation[] = []): DomainError {
  return domainError("MEMORY_INVALID_METADATA", "invalid_input", message, { fields });
}

/** The source's `MEMORY_INVALID_VISIBILITY`, message and all. */
export function invalidVisibility(permitted: readonly string[]): DomainError {
  return domainError(
    "MEMORY_INVALID_VISIBILITY",
    "invalid_input",
    `visibility must be one of ${permitted.join(", ")}`,
  );
}

/** The source's `MEMORY_INVALID_SOURCE`, message and all. */
export function invalidSource(permitted: readonly string[]): DomainError {
  return domainError("MEMORY_INVALID_SOURCE", "invalid_input", `source must be one of ${permitted.join(", ")}`);
}

/**
 * The source's `MEMORY_UNTRUSTED_SOURCE`.
 *
 * `forbidden` rather than `invalid_input`: the payload is well-formed, and what
 * is missing is the privilege to claim that provenance. A caller cannot fix this
 * by editing the request, which is the line between the two categories.
 */
export function untrustedSource(requested: string): DomainError {
  return domainError(
    "MEMORY_UNTRUSTED_SOURCE",
    "forbidden",
    `source '${requested}' requires a trusted provenance writer`,
    { details: { requested } },
  );
}

export function invalidConfidence(value: number): DomainError {
  return domainError("MEMORY_INVALID_CONFIDENCE", "invalid_input", "memory confidence must be between 0 and 1", {
    details: { value },
  });
}

/**
 * Turn ids without the thread that holds them, or turn ids that are not that
 * thread's. Both leave a memory whose provenance cannot be walked back.
 */
export function provenanceIncomplete(reason: string, details: Readonly<Record<string, string>> = {}): DomainError {
  return domainError("MEMORY_PROVENANCE_INCOMPLETE", "invalid_input", reason, { details });
}

export function bulkLimitExceeded(requested: number, maximum: number): DomainError {
  return domainError("MEMORY_BULK_LIMIT_EXCEEDED", "invalid_input", "too many memories in one request", {
    details: { requested, maximum },
  });
}

export function entityNotFound(entityId: string): DomainError {
  return domainError("MEMORY_ENTITY_NOT_FOUND", "not_found", "entity is not visible in this scope", {
    details: { entityId },
  });
}

export function entityKeyInvalid(value: string): DomainError {
  return domainError("MEMORY_ENTITY_KEY_INVALID", "invalid_input", "entity key must be a non-empty slug", {
    details: { value },
  });
}

/**
 * One key, two owners: a cluster-owned node and an agent-owned node for the same
 * `entityKey`. `conflict`, and refused rather than merged, because merging would
 * silently publish one agent's private node to the whole cluster.
 */
export function entityOwnershipConflict(entityKey: string): DomainError {
  return domainError(
    "MEMORY_ENTITY_OWNERSHIP_CONFLICT",
    "conflict",
    "a standalone entity conflicts with an existing clustered entity for that key",
    { details: { entityKey } },
  );
}

/** The `@@unique([fromEntityId, toEntityId, relationshipType])` sibling rule. */
export function relationshipEndpointsSplit(fromEntityId: string, toEntityId: string): DomainError {
  return domainError(
    "MEMORY_RELATIONSHIP_ENDPOINTS_SPLIT",
    "forbidden",
    "relationship endpoints are outside one agent or agent cluster",
    { details: { fromEntityId, toEntityId } },
  );
}

export function relationshipInvalid(message: string): DomainError {
  return domainError("MEMORY_RELATIONSHIP_INVALID", "invalid_input", message);
}

export function queryInvalid(message: string, field: string): DomainError {
  return domainError("MEMORY_QUERY_INVALID", "invalid_input", message, {
    fields: [{ field, code: "invalid", message }],
  });
}

/**
 * The embedding could not be produced, so the row cannot be recalled
 * semantically. `unavailable` with a retry: this is an operational failure of a
 * downstream model, not something the caller stated wrongly.
 */
export function embeddingUnavailable(reason: string): DomainError {
  return domainError("MEMORY_EMBEDDING_UNAVAILABLE", "unavailable", "memory embedding is unavailable", {
    retryAfterSeconds: 5,
    details: { reason },
  });
}

/** No judge could be reached, so nothing was extracted. Not a failed sweep. */
export function extractionJudgeUnavailable(reason: string): DomainError {
  return domainError(
    "MEMORY_EXTRACTION_JUDGE_UNAVAILABLE",
    "unavailable",
    "memory extraction judge is unavailable",
    { retryAfterSeconds: 30, details: { reason } },
  );
}

/** A judge answered, and its answer was not the envelope this context asked for. */
export function extractionEnvelopeInvalid(reason: string): DomainError {
  return domainError(
    "MEMORY_EXTRACTION_ENVELOPE_INVALID",
    "invalid_input",
    "extraction judge returned an unreadable envelope",
    { details: { reason } },
  );
}

export function cacheUnavailable(reason: string): DomainError {
  return domainError("MEMORY_CACHE_UNAVAILABLE", "unavailable", "memory cache is unavailable", {
    retryAfterSeconds: 5,
    details: { reason },
  });
}

/**
 * A cache entry whose TTL is not a positive whole number of seconds.
 *
 * WIN-260 (M2.5). The `Cache` port's second property is that "every write
 * carries its TTL... there is no `set` without one and no server-side default",
 * and until the port had an implementation nothing enforced it. Redis refuses a
 * non-positive `EX` with a driver error that names no key, so without this the
 * refusal would reach a caller as MEMORY_CACHE_UNAVAILABLE — a caller defect
 * reported as an outage, and a caller that retried would retry forever.
 */
export function cacheTtlInvalid(ttlSeconds: number): DomainError {
  return domainError(
    "MEMORY_CACHE_TTL_INVALID",
    "invalid_input",
    "a cache entry TTL must be a positive whole number of seconds",
    { details: { ttlSeconds } },
  );
}

/**
 * `deleteNamespace` was given a blank prefix.
 *
 * WIN-260 (M2.5). The port says outright that an implementation "MUST NOT expose
 * a general pattern match: `deleteNamespace(\"\")` would be a flush of the whole
 * keyspace". Its own code, because the refusal is a rule about what the port
 * means rather than about what Redis does — a second adapter would have to make
 * the same refusal, and it must make it under the same name.
 */
export function cacheNamespaceInvalid(): DomainError {
  return domainError(
    "MEMORY_CACHE_NAMESPACE_INVALID",
    "invalid_input",
    "a namespace prefix must be non-empty; a blank one would clear the whole keyspace",
  );
}

export function repositoryUnavailable(reason: string): DomainError {
  return domainError("MEMORY_REPOSITORY_UNAVAILABLE", "unavailable", "memory repository is unavailable", {
    retryAfterSeconds: 5,
    details: { reason },
  });
}
