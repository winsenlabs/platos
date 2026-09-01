// Tenancy-local branded identifiers.
//
// `@platos/kernel` already brands the four tree identifiers this context is
// keyed by — OrganizationId, ProjectId, EnvironmentId, EntityId — plus
// PrincipalId. They are imported, never redeclared: two independent brands for
// the same column would let a value cross between them with a cast that looks
// safe.
//
// What is left here are the join rows tenancy owns and the two identity-access
// rows tenancy points AT but never writes.

import type { Branded } from "@platos/kernel";

/**
 * identity-access is sole writer of `User` (ADR M0.3 §1, context 1). Tenancy
 * stores the id on a membership and an invitation and reads nothing else.
 */
export type UserId = Branded<string, "UserId">;

/**
 * identity-access is sole writer of `OperatorSession`. `EnvironmentSession`
 * points at one, and every session revocation tenancy decides is carried out
 * through a port rather than by writing that table.
 */
export type OperatorSessionId = Branded<string, "OperatorSessionId">;

export type OrganizationMembershipId = Branded<string, "OrganizationMembershipId">;
export type ProjectMembershipId = Branded<string, "ProjectMembershipId">;
export type OrganizationInvitationId = Branded<string, "OrganizationInvitationId">;
export type EnvironmentSessionId = Branded<string, "EnvironmentSessionId">;

/**
 * A normalized address: trimmed and lower-cased.
 *
 * The baseline schema enforces exactly this shape with a CHECK constraint on
 * both `MagicLinkToken.email` and `OrganizationInvitation.email`
 * (`"email" = lower(btrim("email"))`), and the partial unique index that makes
 * one invitation active per organization+email is only correct if every writer
 * normalizes identically. Branding the normalized form is how a caller is
 * stopped from comparing a raw address against a stored one.
 */
export type EmailAddress = Branded<string, "EmailAddress">;

export function normalizeEmail(value: string): EmailAddress {
  return value.trim().toLowerCase() as EmailAddress;
}

export function emailsMatch(left: EmailAddress, right: EmailAddress): boolean {
  return left === right;
}

/**
 * The one-way digest of an invitation token. The raw token never enters the
 * domain: it is minted and digested behind `InvitationTokenIssuer` so no
 * cryptographic primitive lands in a pure layer.
 */
export type TokenDigest = Branded<string, "TokenDigest">;

/**
 * An organization slug (globally unique) or a project/environment slug (unique
 * within its parent). The schema stores a bare `String`; the shape below is the
 * one the product has always produced, and stating it makes a bad slug a
 * validation failure instead of a routing surprise.
 */
export type Slug = Branded<string, "Slug">;

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export function isSlug(value: string): value is Slug {
  return value.length <= 64 && SLUG_PATTERN.test(value);
}
