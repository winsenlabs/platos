// Who is acting, and the identifiers this context is sole writer of.
//
// ADR M0.3 §1 row 1 makes identity-access the sole writer of User,
// OperatorIdentity, EndUser, EndUserIdentity and every token row keyed off
// them. The identifiers for those rows are branded here rather than in the
// kernel because they are this context's rows: a `UserId` reaching a parameter
// that wanted an `EndUserId` is a defect only identity-access can commit, and
// the kernel is not the place to enumerate one context's primary keys.
//
// `PrincipalId` is the kernel's cross-cutting "whoever is acting" identifier.
// A UserId or an EndUserId widens into one; nothing narrows back, because the
// tier is what tells you which table the principal came from.

import type { Branded, PrincipalId } from "@platos/kernel";

export type UserId = Branded<string, "UserId">;
export type EndUserId = Branded<string, "EndUserId">;
export type EndUserIdentityId = Branded<string, "EndUserIdentityId">;
export type OperatorSessionId = Branded<string, "OperatorSessionId">;
export type AccessKeyId = Branded<string, "AccessKeyId">;
export type OAuthClientId = Branded<string, "OAuthClientId">;
export type OAuthTokenId = Branded<string, "OAuthTokenId">;
export type RotationFamilyId = Branded<string, "RotationFamilyId">;
export type CredentialId = Branded<string, "CredentialId">;

/**
 * The SHA-256 hex verifier of a bearer secret.
 *
 * Every token row in the baseline schema stores `tokenHash`/`keyHash`/`codeHash`
 * and never the secret. Branding the hash keeps a raw token from being handed to
 * a lookup that expects the verifier — the one substitution that would turn the
 * whole store into plaintext credentials.
 */
export type TokenHash = Branded<string, "TokenHash">;

/** A raw bearer secret, as presented by a client. Never persisted. */
export type RawToken = Branded<string, "RawToken">;

/** A normalized address: trimmed and lower-cased. Never the untrusted input. */
export type EmailAddress = Branded<string, "EmailAddress">;

/** Schema enum `PrincipalTier`. */
export const PRINCIPAL_TIERS = ["OPERATOR", "END_USER"] as const;
export type PrincipalTier = (typeof PRINCIPAL_TIERS)[number];

/** Schema enum `OperatorIdentityProvider`. */
export const OPERATOR_IDENTITY_PROVIDERS = ["MAGIC_LINK", "GITHUB", "GOOGLE"] as const;
export type OperatorIdentityProvider = (typeof OPERATOR_IDENTITY_PROVIDERS)[number];

/** Every provider except the one that mints its own subject from the address. */
export type FederatedIdentityProvider = Exclude<OperatorIdentityProvider, "MAGIC_LINK">;

/** Schema enum `ImpersonationAction`. */
export const IMPERSONATION_ACTIONS = ["START", "STOP"] as const;
export type ImpersonationAction = (typeof IMPERSONATION_ACTIONS)[number];

/**
 * The resolved actor of a request.
 *
 * `actorUserId` and `effectiveUserId` differ only while an operator is
 * impersonating. Both are kept because an audit row that loses who really acted
 * is worse than no audit row: it asserts a falsehood.
 */
export interface Principal {
  readonly tier: PrincipalTier;
  readonly principalId: PrincipalId;
}

/**
 * OperatorIdentity — one federated or mailed identity bound to one User.
 *
 * `(provider, subject)` is unique, and so is `(userId, provider)`: a user has at
 * most one identity per provider, and an identity belongs to at most one user.
 * Both constraints matter. Without the first, two accounts could claim the same
 * GitHub login; without the second, one account could accumulate several
 * identities at the same provider and an address change at the provider would
 * leave a stale one behind that still logs in.
 */
export interface OperatorIdentityRecord {
  readonly userId: UserId;
  readonly provider: OperatorIdentityProvider;
  /** The provider's stable subject. For MAGIC_LINK it is the address itself. */
  readonly subject: string;
  readonly providerEmail: EmailAddress;
}

/** Widen a row identifier into the kernel's cross-cutting principal identity. */
export function asPrincipalId(id: UserId | EndUserId): PrincipalId {
  return id as unknown as PrincipalId;
}

export function operatorPrincipal(userId: UserId): Principal {
  return { tier: "OPERATOR", principalId: asPrincipalId(userId) };
}

export function endUserPrincipal(endUserId: EndUserId): Principal {
  return { tier: "END_USER", principalId: asPrincipalId(endUserId) };
}

/**
 * Trim and lower-case, exactly as the extraction source does before every
 * `User.email` read, write and comparison.
 *
 * The uniqueness constraint on `User.email` is on the stored bytes, so an
 * address that is normalized on write and not on read is a silent duplicate
 * account. One function, called on both sides, is the whole guarantee.
 */
export function normalizeEmail(value: string): EmailAddress {
  return value.trim().toLowerCase() as EmailAddress;
}

export function sameEmail(left: string, right: string): boolean {
  return normalizeEmail(left) === normalizeEmail(right);
}

/**
 * Strip formatting from a recovery code before hashing it.
 *
 * Codes are shown to a human as `A1B2C-D3E4F-...`; the human retypes them with
 * whatever separators they remember. The stored verifier is over the stripped,
 * upper-cased form, so presentation can change without invalidating issued codes.
 */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[^a-z0-9]/giu, "").toUpperCase();
}
