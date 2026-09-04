// The `tools` error catalogue.
//
// M0.4 §2 fixes `code` as a SCREAMING_SNAKE string that is immutable within a
// major, and the kernel makes an error a VALUE rather than a thrown class.
// Every code this context can produce is minted here, once, so a transport
// builds its status table from one list and an operator grepping a log finds
// exactly one definition.
//
// THE MERGE BROUGHT TWO ERROR VOCABULARIES AND NEITHER IS COLLAPSED INTO THE
// OTHER. ADR M0.3 §1 row 7 makes this context the union of `tool-gateway` and
// `mcp-platform`, and the two halves fail differently on purpose:
//
//   the REGISTRY half throws bare `Error("entity_not_found_in_scope")`,
//   `Error("tool_name_required")`, `Error("duplicate_tool_name:<name>")` —
//   operator-facing, specific, safe to render.
//
//   the DISPATCH half returns a structured failed `ToolCallResult` whose
//   `error` string is read by a language model and, on the MCP surface, by a
//   third party. `McpCredentialError` deliberately carries no header value and
//   no secret material.
//
// Both survive below. `TOOLS_ENTITY_NOT_DISPATCHABLE` is a precondition an
// operator fixes; `TOOLS_DISPATCH_FAILED` is a runtime outcome whose diagnosis
// goes in `details`, which the kernel documents as never returned to a client.
//
// The one thing deliberately NOT preserved is the free-text interpolation of a
// caller-supplied tool name into a thrown message. A name reaches this context
// from an MCP client; putting it in a message that a transport may render is a
// reflection the source got away with only because those paths are operator
// scoped. Names travel in `details` instead.

import { domainError, type DomainError, type FieldViolation } from "@platos/kernel";

export const TOOLS_ERROR_CODES = [
  "TOOLS_DECLARATION_INVALID",
  "TOOLS_DUPLICATE_TOOL_NAME",
  "TOOLS_ENTITY_NOT_IN_SCOPE",
  "TOOLS_ENVIRONMENT_NOT_IN_SCOPE",
  "TOOLS_TOOL_NOT_FOUND",
  "TOOLS_EXPOSURE_NOT_FOUND",
  "TOOLS_ROUTE_NOT_IN_SCOPE",
  "TOOLS_ROUTE_AMBIGUOUS",
  "TOOLS_ENTITY_NOT_DISPATCHABLE",
  "TOOLS_PERMISSION_BLOCKED",
  "TOOLS_APPROVAL_REQUIRED",
  "TOOLS_ARGUMENTS_INVALID",
  "TOOLS_END_USER_REQUIRED",
  "TOOLS_CREDENTIAL_UNAVAILABLE",
  "TOOLS_RESIDUAL_TEMPLATE",
  "TOOLS_DISPATCH_FAILED",
  "TOOLS_DISPATCH_RATE_LIMITED",
  "TOOLS_MCP_DISABLED",
  "TOOLS_MCP_TRANSPORT_INVALID",
  "TOOLS_POLICY_PATTERN_INVALID",
  "TOOLS_POLICY_EFFECT_UNSUPPORTED",
  "TOOLS_CALL_SEQUENCE_CONFLICT",
  "TOOLS_CALL_TRANSITION_INVALID",
  "TOOLS_SCOPE_MISMATCH",
  "TOOLS_REPOSITORY_UNAVAILABLE",
] as const;

export type ToolsErrorCode = (typeof TOOLS_ERROR_CODES)[number];

/** The one message a client is ever shown for a failed dispatch. */
const DISPATCH_FAILED = "Tool call failed.";

export function declarationInvalid(
  message: string,
  fields: readonly FieldViolation[] = [],
): DomainError {
  return domainError("TOOLS_DECLARATION_INVALID", "invalid_input", message, { fields });
}

/**
 * The source raises `duplicate_tool_name:<name>`. The name moves into
 * `details` so a transport chooses whether to reflect it rather than being
 * handed a message that already has.
 */
export function duplicateToolName(name: string): DomainError {
  return domainError(
    "TOOLS_DUPLICATE_TOOL_NAME",
    "invalid_input",
    "a declaration may name each tool once",
    { details: { name } },
  );
}

export function entityNotInScope(entityId: string): DomainError {
  return domainError("TOOLS_ENTITY_NOT_IN_SCOPE", "not_found", "entity is not visible in this scope", {
    details: { entityId },
  });
}

export function environmentNotInScope(environmentId: string): DomainError {
  return domainError(
    "TOOLS_ENVIRONMENT_NOT_IN_SCOPE",
    "not_found",
    "environment is not visible in this scope",
    { details: { environmentId } },
  );
}

export function toolNotFound(toolId: string): DomainError {
  return domainError("TOOLS_TOOL_NOT_FOUND", "not_found", "tool is not visible in this scope", {
    details: { toolId },
  });
}

export function exposureNotFound(exposureId: string): DomainError {
  return domainError(
    "TOOLS_EXPOSURE_NOT_FOUND",
    "not_found",
    "tool is not exposed by that entity in this environment",
    { details: { exposureId } },
  );
}

/** The source's `TOOL_NOT_IN_SCOPE_OR_ENTITIES`, with its two inputs kept apart. */
export function routeNotInScope(toolName: string, entityIds: readonly string[]): DomainError {
  return domainError(
    "TOOLS_ROUTE_NOT_IN_SCOPE",
    "not_found",
    "no entity in this scope exposes that tool",
    { details: { toolName, entityIds: [...entityIds] } },
  );
}

/**
 * The source's `AMBIGUOUS_TOOL_ROUTE`. The candidate list travels because the
 * MCP client that asked is expected to re-ask naming one — an error a caller
 * can act on rather than only report.
 */
export function routeAmbiguous(
  toolName: string,
  candidates: readonly { readonly entityId: string; readonly toolId: string }[],
): DomainError {
  return domainError(
    "TOOLS_ROUTE_AMBIGUOUS",
    "conflict",
    "several entities in this scope expose that tool; name one",
    {
      details: {
        toolName,
        candidates: candidates.map((candidate) => ({ ...candidate })),
      },
    },
  );
}

export function entityNotDispatchable(entityId: string, reason: string): DomainError {
  return domainError(
    "TOOLS_ENTITY_NOT_DISPATCHABLE",
    "precondition_failed",
    "the entity that owns this tool has no live transport",
    { details: { entityId, reason } },
  );
}

/** Tier-1..4 said `block`. The tier travels so an audit line can name it. */
export function permissionBlocked(toolName: string, tier: number, reason: string): DomainError {
  return domainError("TOOLS_PERMISSION_BLOCKED", "forbidden", "tool call blocked by policy", {
    details: { toolName, tier, reason },
  });
}

/**
 * `require_approval` is NOT a failure of the call — it is the call's correct
 * outcome, and ADR M0.3 §7 decision 9's qualification is that the caller still
 * receives a terminal result rather than a detached acknowledgement. This error
 * exists for the surfaces that cannot park (a synchronous MCP client with no
 * approval channel); the parking path returns an approval, not this.
 */
export function approvalRequired(toolName: string, tier: number): DomainError {
  return domainError(
    "TOOLS_APPROVAL_REQUIRED",
    "precondition_failed",
    "tool call requires an operator decision",
    { details: { toolName, tier } },
  );
}

export function argumentsInvalid(
  toolName: string,
  fields: readonly FieldViolation[],
): DomainError {
  return domainError("TOOLS_ARGUMENTS_INVALID", "invalid_input", "tool arguments are not valid", {
    fields,
    details: { toolName },
  });
}

/**
 * The crown-jewel fail-closed. A template names `{{endUserId}}` and no end user
 * is resolved, so NOTHING is sent upstream. The source's message is transcribed
 * because it is already content-free.
 */
export function endUserRequired(toolName: string): DomainError {
  return domainError(
    "TOOLS_END_USER_REQUIRED",
    "precondition_failed",
    "tool requires a linked end user",
    { details: { toolName } },
  );
}

export function credentialUnavailable(reason: string): DomainError {
  return domainError(
    "TOOLS_CREDENTIAL_UNAVAILABLE",
    "precondition_failed",
    "the credential this tool needs is unavailable",
    { details: { reason } },
  );
}

/**
 * The belt to the fail-closed's braces: a literal template SURVIVED
 * substitution. Reaching this means a substitution defect, not a missing
 * input, so it is `internal` — nothing the caller supplied can fix it.
 */
export function residualTemplate(token: string): DomainError {
  return domainError(
    "TOOLS_RESIDUAL_TEMPLATE",
    "internal",
    "an unsubstituted template survived resolution; nothing was dispatched",
    { details: { token } },
  );
}

/** Runtime: the entity backend refused, timed out, or could not be reached. */
export function dispatchFailed(reason: string, retryAfterSeconds: number | null = null): DomainError {
  return domainError("TOOLS_DISPATCH_FAILED", "unavailable", DISPATCH_FAILED, {
    ...(retryAfterSeconds === null ? {} : { retryAfterSeconds }),
    details: { reason },
  });
}

/** The entity backend answered 429. Its `retry-after` is honoured verbatim. */
export function dispatchRateLimited(toolName: string, retryAfterSeconds: number): DomainError {
  return domainError(
    "TOOLS_DISPATCH_RATE_LIMITED",
    "rate_limited",
    "the tool's backend is rate limiting this caller",
    { retryAfterSeconds, details: { toolName } },
  );
}

export function mcpDisabled(entityId: string): DomainError {
  return domainError("TOOLS_MCP_DISABLED", "forbidden", "this entity does not host an MCP surface", {
    details: { entityId },
  });
}

export function mcpTransportInvalid(message: string, transport: string): DomainError {
  return domainError("TOOLS_MCP_TRANSPORT_INVALID", "invalid_input", message, {
    details: { transport },
  });
}

export function policyPatternInvalid(message: string): DomainError {
  return domainError("TOOLS_POLICY_PATTERN_INVALID", "invalid_input", message, {
    fields: [{ field: "pattern", code: "invalid", message }],
  });
}

/**
 * `OrganizationMcpPolicy.effect` is a two-valued `PolicyEffect`, so the tier-2
 * surface can express `auto_allow` and `block` and cannot express
 * `require_approval`. The source throws a bare `Error` here; the storage fact
 * that causes it travels in `details`.
 */
export function policyEffectUnsupported(state: string): DomainError {
  return domainError(
    "TOOLS_POLICY_EFFECT_UNSUPPORTED",
    "invalid_input",
    "an organization policy may only allow or block",
    { details: { state } },
  );
}

/** The `@@unique([stepId, sequence])` constraint, in the domain. */
export function callSequenceConflict(stepId: string, sequence: number): DomainError {
  return domainError(
    "TOOLS_CALL_SEQUENCE_CONFLICT",
    "conflict",
    "that step already records a tool call at that position",
    { details: { stepId, sequence } },
  );
}

export function callTransitionInvalid(from: string, to: string): DomainError {
  return domainError(
    "TOOLS_CALL_TRANSITION_INVALID",
    "conflict",
    "a tool call cannot move between those states",
    { details: { from, to } },
  );
}

/**
 * `forbidden`, not `not_found`: the grant resolves, but to a different place in
 * the tenant tree than the caller claimed.
 */
export function scopeMismatch(expectedPath: string, grantedPath: string): DomainError {
  return domainError("TOOLS_SCOPE_MISMATCH", "forbidden", "authorization does not belong to the requested scope", {
    details: { expectedPath, grantedPath },
  });
}

export function repositoryUnavailable(reason: string): DomainError {
  return domainError("TOOLS_REPOSITORY_UNAVAILABLE", "unavailable", "tools repository is unavailable", {
    retryAfterSeconds: 5,
    details: { reason },
  });
}
