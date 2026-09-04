// The tenancy failure vocabulary, mapped from the behavioural oracle.
//
// `internal-packages/tenancy-database/src/auth.ts` throws `PlatosAuthError`
// with an `AuthErrorCode` and an HTTP status. A domain does not name an HTTP
// status (kernel `vo/error.ts`), so each oracle code is translated once, here,
// to a SCREAMING_SNAKE code plus a kernel `ErrorCategory`. The status a
// transport eventually emits is derivable from the category and stays out of
// this layer.
//
// ORACLE MAPPING
//   forbidden        403 -> TENANCY_ENVIRONMENT_FORBIDDEN     / forbidden
//   forbidden        403 -> TENANCY_MEMBERSHIP_FORBIDDEN      / forbidden
//   owner_invariant  409 -> TENANCY_LAST_OWNER                / conflict
//   invite_invalid   401 -> TENANCY_INVITATION_INVALID        / unauthenticated
//   invite_consumed  409 -> TENANCY_INVITATION_CONSUMED       / conflict
//   invite_email_mismatch 403 -> TENANCY_INVITATION_EMAIL_MISMATCH / forbidden

import { domainError, type DomainError } from "@platos/kernel";

/**
 * Which of the four authorization gates denied the request.
 *
 * INDISTINGUISHABLE ON THE WIRE, ON PURPOSE. The oracle throws one identical
 * `environmentForbidden()` from all four gates, so a caller probing an
 * environment id cannot learn whether the environment exists, whether it is
 * archived, whether they are a member of the organization, or merely which
 * role they hold. That property is preserved: every gate produces the same
 * `code` and the same `message`, and the gate name travels only in `details`,
 * which kernel `vo/error.ts` documents as log-only and never returned to a
 * client.
 */
export type DenialGate =
  | "archived-ancestor"
  | "organization-membership"
  | "project-membership"
  | "secret-mutate-role"
  | "inconsistent-ancestry";

export function environmentForbidden(gate: DenialGate): DomainError {
  return domainError(
    "TENANCY_ENVIRONMENT_FORBIDDEN",
    "forbidden",
    "Operator is not authorized for this environment",
    { details: { gate } },
  );
}

export function membershipMutationForbidden(reason: string): DomainError {
  return domainError(
    "TENANCY_MEMBERSHIP_FORBIDDEN",
    "forbidden",
    "Membership role change is not authorized",
    { details: { reason } },
  );
}

/** The 409 `owner_invariant` of `changeMembershipRole`. */
export function lastOwnerInvariant(): DomainError {
  return domainError(
    "TENANCY_LAST_OWNER",
    "conflict",
    "An organization must retain at least one active owner",
  );
}

export function invitationInvalid(): DomainError {
  return domainError(
    "TENANCY_INVITATION_INVALID",
    "unauthenticated",
    "Invitation is invalid or expired",
  );
}

export function invitationConsumed(): DomainError {
  return domainError(
    "TENANCY_INVITATION_CONSUMED",
    "conflict",
    "Invitation has already been accepted",
  );
}

export function invitationEmailMismatch(): DomainError {
  return domainError(
    "TENANCY_INVITATION_EMAIL_MISMATCH",
    "forbidden",
    "Invitation belongs to another email address",
  );
}

/**
 * The partial unique index `OrganizationInvitation_one_active_per_email`
 * refused a second live invitation. The database is the enforcer; this is the
 * domain saying the same thing before the write is ever issued.
 */
export function invitationAlreadyActive(): DomainError {
  return domainError(
    "TENANCY_INVITATION_ALREADY_ACTIVE",
    "conflict",
    "An active invitation already exists for this organization and address",
  );
}

/**
 * A `ProjectMembership` whose `organizationId` disagrees with the project it
 * points at, or with the organization membership it points at.
 *
 * In the database this is impossible by construction: the two composite foreign
 * keys `(projectId, organizationId) -> Project(id, organizationId)` and
 * `(organizationMembershipId, organizationId) -> OrganizationMembership(id,
 * organizationId)` both derive and verify the same column, so a row that links
 * a project in organization A to a membership in organization B cannot be
 * inserted. It is restated in the domain because an in-memory use case has no
 * foreign key, and because a cross-tenant grant is the exact class of defect
 * this programme exists to make impossible.
 */
export function crossTenantMembership(details: {
  readonly projectOrganizationId: string;
  readonly membershipOrganizationId: string;
  readonly declaredOrganizationId: string;
}): DomainError {
  return domainError(
    "TENANCY_CROSS_TENANT_MEMBERSHIP",
    "precondition_failed",
    "Project membership integrity key does not agree with its project and organization membership",
    { details },
  );
}

/** An object that is not a value this context minted was offered as proof. */
export function forgedAuthorization(): DomainError {
  return domainError(
    "TENANCY_AUTHORIZATION_FORGED",
    "forbidden",
    "Value was not issued by the tenancy authorization service",
  );
}

export function tenantNotFound(kind: "organization" | "project" | "environment" | "entity"): DomainError {
  return domainError("TENANCY_NOT_FOUND", "not_found", `No such ${kind}`, { details: { kind } });
}

export function slugTaken(kind: "organization" | "project" | "environment"): DomainError {
  return domainError("TENANCY_SLUG_TAKEN", "conflict", `That ${kind} slug is already in use`, {
    details: { kind },
  });
}

/**
 * Which gate refused a project creation.
 *
 * INDISTINGUISHABLE ON THE WIRE, exactly as `environmentForbidden` is, and for
 * the same reason. The oracle resolves the organization BY SLUG inside the
 * membership lookup — `organization: { slug, archivedAt: null }` — so a missing
 * organization, an archived one and a caller who is not a member all fall out of
 * one query as one 403. A caller therefore cannot use this route to learn
 * whether an organization exists or has been archived, and that property is
 * preserved: one `code`, one `message`, and the gate only in `details`, which
 * kernel `vo/error.ts` documents as log-only.
 */
export type ProjectCreationGate =
  | "no-such-organization"
  | "organization-archived"
  | "not-a-member"
  | "membership-deactivated";

export function projectCreationForbidden(gate: ProjectCreationGate): DomainError {
  return domainError(
    "TENANCY_PROJECT_CREATE_FORBIDDEN",
    "forbidden",
    "Operator is not authorized to create a project in this organization",
    { details: { gate } },
  );
}

/**
 * The founder of an organization must be an operator account identity-access
 * actually holds, and one that is not disabled.
 *
 * In the database this is half a foreign key: `OrganizationMembership.userId`
 * references `User(id)`, so a founding membership for a user that does not exist
 * cannot be inserted. The FK says nothing about `User.disabledAt`, and neither
 * does the oracle's create route — it relies on `requireOperator` having already
 * refused a disabled actor. Stating both here is what lets a caller that reached
 * this use case some other way be refused rather than trusted.
 */
export function unknownOperator(): DomainError {
  return domainError(
    "TENANCY_UNKNOWN_OPERATOR",
    "precondition_failed",
    "No live operator account for that user",
  );
}

/** A name that is blank once trimmed. The schema stores a bare `String`. */
export function invalidName(
  kind: "organization" | "project" | "environment",
  field = "name",
): DomainError {
  return domainError("TENANCY_INVALID_NAME", "invalid_input", `A ${kind} needs a name`, {
    fields: [{ field, code: "TENANCY_INVALID_NAME", message: "must not be blank" }],
    details: { kind },
  });
}

/**
 * `field` names WHICH slug, because one command can carry two: creating a
 * project names the project and its first environment in the same call, and a
 * caller told only "slug is invalid" cannot fix the right one.
 */
export function invalidSlug(value: string, field = "slug"): DomainError {
  return domainError("TENANCY_INVALID_SLUG", "invalid_input", "Slug must be lower-case kebab-case", {
    fields: [{ field, code: "TENANCY_INVALID_SLUG", message: "lower-case kebab-case, 64 characters or fewer" }],
    details: { length: value.length },
  });
}

/**
 * The oracle's `access_key_rotation_superseded`: the environment's revocation
 * generation moved between the caller's snapshot and the locked read, so the
 * caller's view is stale and a revocation has already won.
 */
export function accessKeyGenerationSuperseded(observed: number, expected: number): DomainError {
  return domainError(
    "TENANCY_ACCESS_KEY_GENERATION_SUPERSEDED",
    "conflict",
    "The environment access-key generation moved since it was read",
    { details: { observed, expected } },
  );
}

/** Writing under an archived ancestor is refused everywhere, not only in RBAC. */
export function ancestorArchived(level: "organization" | "project" | "environment"): DomainError {
  return domainError("TENANCY_ARCHIVED", "precondition_failed", `The ${level} is archived`, {
    details: { level },
  });
}
