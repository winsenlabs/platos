// The `secrets` failure catalogue.
//
// ADR M0.3 §1 (context 3) makes this context the credential vault and the
// encryption boundary. Its errors are therefore a security surface in their own
// right: an error that distinguishes "no such credential" from "wrong key" from
// "tampered ciphertext" hands an attacker a probing oracle for free. The
// extraction source (internal-packages/tenancy-database/src/secrets.ts) already
// collapses all three into one `credential_unavailable`, and its pure test
// asserts exactly that ("rejects ciphertext, tag, and root-key tampering with
// ONE stable error"). That collapse is preserved here.
//
// The distinguishing reason survives in `details`, which the kernel `DomainError`
// documents as "structured, already-redacted context for logs. Never returned to
// a client". So an operator debugging a vault still learns why; a caller probing
// one learns only that it is unavailable.
//
// Every message below is a fixed literal. No message interpolates a name, a key,
// a plaintext or a ciphertext, because a message is rendered into logs and API
// responses.

import { domainError } from "@platos/kernel";
import type { DomainError, JsonValue } from "@platos/kernel";

/** The closed set of codes this context can produce. */
export const SECRETS_ERROR_CODES = [
  "CREDENTIAL_UNAVAILABLE",
  "CREDENTIAL_FORBIDDEN",
  "CREDENTIAL_NAME_TAKEN",
  "SECRET_VERSION_ALREADY_EXISTS",
  "INVALID_KEY_RING",
  "INVALID_SECRET_MATERIAL",
  "INVALID_PURGE_REQUEST",
  "INVALID_RETENTION_REQUEST",
  "ENVELOPE_FORMAT_UNWRITABLE",
  "LEGACY_ENVELOPE_UNREADABLE",
  "ENVIRONMENT_VARIABLE_UNAVAILABLE",
  "ENVIRONMENT_VARIABLE_KEY_INVALID",
  "ENVIRONMENT_VARIABLE_VALUE_REQUIRED",
  "ENVIRONMENT_VARIABLE_VALUE_TOO_LONG",
  "ENVIRONMENT_VARIABLE_VERSION_CONFLICT",
] as const;

export type SecretsErrorCode = (typeof SECRETS_ERROR_CODES)[number];

/**
 * Why a credential was unavailable. Log-only, never a distinct wire code.
 *
 * `root_key_absent` is the fail-closed case the encryption boundary exists for:
 * a stored version whose root key version has been rotated OUT of the ring is
 * unreadable, and the answer is an error — never the ciphertext, never a
 * partially decoded envelope.
 */
export type CredentialUnavailableReason =
  | "credential_not_found"
  | "credential_revoked"
  | "no_active_secret_version"
  | "secret_version_retired"
  | "secret_version_not_active"
  | "root_key_absent"
  | "envelope_open_failed"
  | "envelope_format_unreadable"
  | "scope_mismatch";

/**
 * Why a legacy envelope could not be read for migration.
 *
 * Distinct values throughout, because two guards answering with one reason
 * cannot be told apart in an operator's log — and every one of these names a
 * different repair. The three encoding reasons are separate from the three width
 * reasons for the same cause: "this column does not hold what you think" and
 * "this column holds the other legacy format" are not the same finding.
 */
export type LegacyEnvelopeUnreadableReason =
  | "format_not_a_known_version"
  | "format_is_already_canonical"
  | "legacy_format_carries_no_salt"
  | "nonce_width_disagrees_with_format"
  | "auth_tag_width_disagrees_with_format"
  | "ciphertext_is_empty"
  | "payload_is_not_a_dotted_base64url_triple"
  | "payload_is_not_base64"
  | "payload_is_shorter_than_its_own_header"
  | "legacy_key_absent_for_format"
  | "legacy_key_is_not_32_bytes"
  | "legacy_envelope_open_failed";

function withReason(reason: string, extra: Readonly<Record<string, JsonValue>> = {}): Readonly<Record<string, JsonValue>> {
  return { reason, ...extra };
}

/**
 * The single stable "you may not have this secret" answer.
 *
 * Nine internal reasons collapse to one code and one message. A caller cannot
 * tell a missing credential from a tampered envelope from a retired root key.
 */
export function credentialUnavailable(reason: CredentialUnavailableReason): DomainError {
  return domainError("CREDENTIAL_UNAVAILABLE", "not_found", "credential unavailable", {
    details: withReason(reason),
  });
}

/** The authorization presented does not carry the access this operation needs. */
export function credentialForbidden(reason: string): DomainError {
  return domainError("CREDENTIAL_FORBIDDEN", "forbidden", "credential access forbidden", {
    details: withReason(reason),
  });
}

/** A root key ring that cannot satisfy the invariants a vault depends on. */
export function invalidKeyRing(reason: string): DomainError {
  return domainError("INVALID_KEY_RING", "precondition_failed", "root key ring is not usable", {
    details: withReason(reason),
  });
}

/** Plaintext offered for sealing is not material this boundary will accept. */
export function invalidSecretMaterial(reason: string): DomainError {
  return domainError("INVALID_SECRET_MATERIAL", "invalid_input", "secret material is not acceptable", {
    details: withReason(reason),
  });
}

export function invalidPurgeRequest(reason: string): DomainError {
  return domainError("INVALID_PURGE_REQUEST", "invalid_input", "purge request is not acceptable", {
    details: withReason(reason),
  });
}

export function invalidRetentionRequest(reason: string): DomainError {
  return domainError("INVALID_RETENTION_REQUEST", "invalid_input", "retention window is not acceptable", {
    details: withReason(reason),
  });
}

/**
 * A legacy envelope format was offered for WRITING. Legacy formats are readable
 * for migration only; the boundary writes exactly one canonical format.
 */
export function envelopeFormatUnwritable(formatVersion: number): DomainError {
  return domainError(
    "ENVELOPE_FORMAT_UNWRITABLE",
    "precondition_failed",
    "envelope format is read-only and may not be written",
    { details: withReason("legacy_format", { formatVersion }) },
  );
}

/**
 * A legacy envelope could not be read for migration.
 *
 * WHY THIS IS ITS OWN CODE AND NOT A TENTH `credentialUnavailable` REASON.
 * `credentialUnavailable` collapses its reasons because its caller may be a
 * client probing the vault, and telling a prober "wrong key" apart from "no such
 * credential" hands it an oracle for free. This code's caller is never a client:
 * a legacy migration is driven by an operator over material read out of a column
 * this context does not own, and the only useful answer is WHICH part of the
 * payload failed. Collapsing it would leave an operator holding an unreadable
 * `OperatorMfaTotp` row with no way to learn whether the fault was the encoding,
 * a width, or the key — three findings with three different repairs.
 *
 * It is `invalid_input` and not `not_found`: the row exists, and what is wrong
 * is the material the caller presented. It names no payload, no key and no
 * plaintext, for the reason every message in this file names none.
 */
export function legacyEnvelopeUnreadable(reason: LegacyEnvelopeUnreadableReason): DomainError {
  return domainError(
    "LEGACY_ENVELOPE_UNREADABLE",
    "invalid_input",
    "legacy envelope could not be read for migration",
    { details: withReason(reason) },
  );
}

export function environmentVariableUnavailable(reason: string): DomainError {
  return domainError("ENVIRONMENT_VARIABLE_UNAVAILABLE", "not_found", "environment variable unavailable", {
    details: withReason(reason),
  });
}

export function environmentVariableKeyInvalid(): DomainError {
  return domainError(
    "ENVIRONMENT_VARIABLE_KEY_INVALID",
    "invalid_input",
    "environment variable key is not acceptable",
    { fields: [{ field: "key", code: "pattern", message: "must match ^[A-Z][A-Z0-9_]{0,63}$" }] },
  );
}

export function environmentVariableValueRequired(): DomainError {
  return domainError(
    "ENVIRONMENT_VARIABLE_VALUE_REQUIRED",
    "invalid_input",
    "environment variable value is required",
    { fields: [{ field: "value", code: "required", message: "must be a non-empty string" }] },
  );
}

export function environmentVariableValueTooLong(maximum: number): DomainError {
  return domainError(
    "ENVIRONMENT_VARIABLE_VALUE_TOO_LONG",
    "invalid_input",
    "environment variable value is too long",
    { fields: [{ field: "value", code: "max_length", message: `must be at most ${maximum} characters` }] },
  );
}

/**
 * The canonical store's `[environmentId, kind, name]` uniqueness, refused rather
 * than silently upserted. Two credentials answering to one name is how a caller
 * ends up reading the wrong secret.
 */
export function credentialNameTaken(): DomainError {
  return domainError("CREDENTIAL_NAME_TAKEN", "conflict", "credential name is already in use", {
    fields: [{ field: "name", code: "unique", message: "must be unique within the environment and kind" }],
  });
}

/**
 * The store's `[credentialId, secretRevision, rootKeyVersion]` uniqueness. It is
 * what lets re-encryption write the SAME revision under a new root key while
 * still refusing a genuine duplicate.
 */
export function secretVersionAlreadyExists(): DomainError {
  return domainError(
    "SECRET_VERSION_ALREADY_EXISTS",
    "conflict",
    "secret version already exists for this revision and root key",
  );
}

/**
 * The optimistic fence on `EnvironmentVariable.version`: the row moved between
 * the read this write was decided from and the write itself.
 *
 * WIN-258 T7. `setEnvironmentVariable` is a read-modify-write — it reads the row
 * to learn which id and which backing credential to reuse, then writes. Two
 * concurrent callers on one key both read version N and both write; PostgreSQL
 * serializes the two UPDATEs on the row lock, applies them one after the other,
 * and answers both with success. Nothing is violated and nothing is refused: the
 * first caller's value is simply gone, and it was told the write had happened.
 * That is a LOST UPDATE, and it was reproduced against a real PostgreSQL before
 * this error existed.
 *
 * A version the caller read is therefore carried back into the WHERE clause, so
 * the second write matches no row and the caller learns it lost rather than
 * being told it won. `conflict`, not `precondition_failed`, because the caller's
 * request was well formed and the correct answer is to read again and retry.
 *
 * The message names no key and no value, for the reason every message in this
 * file names none.
 */
export function environmentVariableVersionConflict(expectedVersion: number | null): DomainError {
  return domainError(
    "ENVIRONMENT_VARIABLE_VERSION_CONFLICT",
    "conflict",
    "environment variable was modified concurrently",
    { details: withReason("stale_version", { expectedVersion }) },
  );
}
