// The invariants the DATABASE enforces that the PORT's types cannot, checked on
// the way in so the refusal has a name.
//
// WHY THIS FILE EXISTS AT ALL, and it is the most important note in this
// package. Every constraint below lives in
// `internal-packages/tenancy-database/prisma/migrations/`. NONE of them is in
// `schema.prisma`, so none is in the generated client's types; and none is in
// the in-memory double the context ships, so none is in any unit test in the
// tree. `TokenHash` is a branded STRING: a readable placeholder like
// `"session-token-1"` type-checks, satisfies the fake, satisfies every use-case
// suite — and is refused by PostgreSQL, because `OperatorSession_tokenHash_check`
// is `~ '^[0-9a-f]{64}$'`. Tranche 1 found that the hard way on its first
// integration run. This is that finding turned into a guard.
//
// THE DATABASE REMAINS AUTHORITATIVE. These are not a replacement for the
// constraints and they are not permitted to disagree with them: the integration
// suite removes each guard and shows PostgreSQL refusing the same input, so a
// guard that drifted looser than its constraint is caught, and a guard that
// drifted tighter is caught by the conformance run going red on a value the
// database accepts. What the guard buys is a NAMED, typed refusal at the call
// site instead of a driver error carrying a constraint name.
//
// FOUR REFUSALS, FOUR CODES. A shared code would make "this is not a digest",
// "this address was never normalised", "this credential is half-enrolled" and
// "this rotation overlap is not a duration" indistinguishable in a log, and they
// have four different causes and four different fixes.

/** A `*Hash` column that is not 64 lowercase hexadecimal characters. */
export const TOKEN_HASH_MALFORMED = "identity.write.token_hash_malformed";

/** An address column that is not `lower(btrim(...))` of itself. */
export const EMAIL_NOT_NORMALISED = "identity.write.email_not_normalised";

/** An `OperatorMfaTotp` row whose active/pending column groups contradict. */
export const TOTP_SHAPE_INVALID = "identity.write.totp_shape_invalid";

/** A rotation overlap that is not a positive whole number of milliseconds. */
export const ROTATION_OVERLAP_INVALID = "identity.write.rotation_overlap_invalid";

export class IdentityWriteRefused extends Error {
  readonly code: string;
  readonly column: string;

  constructor(code: string, column: string, message: string) {
    super(message);
    this.name = "IdentityWriteRefused";
    this.code = code;
    this.column = column;
  }
}

/**
 * `^[0-9a-f]{64}$` — byte for byte the migrations' check.
 *
 * Five columns carry it: `OperatorSession.tokenHash`, `MagicLinkToken.tokenHash`,
 * `OrganizationInvitation.tokenHash` (tranche 1's), `OperatorMfaRecoveryCode.codeHash`
 * and `AuthRateLimitBucket.identifierHash`. `AccessKey.keyHash` has no CHECK in
 * the schema, and the legacy `rotateAccessKey` validates the same pattern in
 * TypeScript instead — so this guard is what keeps the two rotation paths from
 * disagreeing about what a key hash is.
 */
const DIGEST = /^[0-9a-f]{64}$/u;

export function requireDigest(column: string, value: string): string {
  if (!DIGEST.test(value)) {
    throw new IdentityWriteRefused(
      TOKEN_HASH_MALFORMED,
      column,
      `${column} must be 64 lowercase hexadecimal characters; received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * `email = lower(btrim(email))` — byte for byte the migrations' check.
 *
 * The domain's `EmailAddress` brand documents "trimmed and lower-cased" and
 * cannot enforce it, because a brand is a compile-time tag over a string. The
 * two rows that carry the constraint are `User.email` and `MagicLinkToken.email`
 * (and `OrganizationInvitation.email`, which is tenancy's). An address that
 * reaches the table un-normalised does not merely fail a check: `User.email` is
 * UNIQUE, so `Ada@Example.com` and `ada@example.com` would be two accounts.
 */
export function requireNormalisedEmail(column: string, value: string): string {
  if (value !== value.trim().toLowerCase()) {
    throw new IdentityWriteRefused(
      EMAIL_NOT_NORMALISED,
      column,
      `${column} must equal lower(btrim(${column})); received ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * `OperatorMfaTotp_active_pending_shape_check`, restated.
 *
 * Two independent clauses, both from the migrations:
 *
 *   (enabledAt IS NULL AND encryptedSecret IS NULL AND lastUsedCounter IS NULL)
 *     OR (enabledAt IS NOT NULL AND encryptedSecret IS NOT NULL)
 *   (pendingEncryptedSecret IS NULL AND pendingExpiresAt IS NULL)
 *     OR (pendingEncryptedSecret IS NOT NULL AND pendingExpiresAt IS NOT NULL)
 *
 * The first is what stops an enrolment being marked complete with no secret
 * behind it — a row that would let `verifyMfa` decide a second factor is
 * required and then have nothing to verify against.
 */
export function requireTotpShape(credential: {
  readonly encryptedSecret: string | null;
  readonly enabledAt: Date | null;
  readonly lastUsedCounter: bigint | null;
  readonly pendingEncryptedSecret: string | null;
  readonly pendingExpiresAt: Date | null;
}): void {
  const inactive =
    credential.enabledAt === null &&
    credential.encryptedSecret === null &&
    credential.lastUsedCounter === null;
  const active = credential.enabledAt !== null && credential.encryptedSecret !== null;
  if (!inactive && !active) {
    throw new IdentityWriteRefused(
      TOTP_SHAPE_INVALID,
      "OperatorMfaTotp.enabledAt",
      "an OperatorMfaTotp row is either fully unenrolled or has both enabledAt and encryptedSecret",
    );
  }
  const pendingAbsent =
    credential.pendingEncryptedSecret === null && credential.pendingExpiresAt === null;
  const pendingPresent =
    credential.pendingEncryptedSecret !== null && credential.pendingExpiresAt !== null;
  if (!pendingAbsent && !pendingPresent) {
    throw new IdentityWriteRefused(
      TOTP_SHAPE_INVALID,
      "OperatorMfaTotp.pendingExpiresAt",
      "a pending OperatorMfaTotp enrolment carries both its secret and its expiry, or neither",
    );
  }
}

export function requirePositiveDuration(column: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new IdentityWriteRefused(
      ROTATION_OVERLAP_INVALID,
      column,
      `${column} must be a positive whole number of milliseconds; received ${String(value)}`,
    );
  }
  return value;
}
