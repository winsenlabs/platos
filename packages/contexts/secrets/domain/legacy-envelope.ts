// The two legacy envelope shapes, and the rule that they cannot live where the
// canonical one does.
//
// THE FINDING THAT SHAPES THIS FILE, AND IT IS NOT IN `schema.prisma`.
// `envelope.ts` catalogues three envelope formats and calls 2 and 3 read-only.
// Reading the MIGRATIONS rather than the model says something stronger: a
// format-2 or format-3 envelope is not merely un-writable by policy, it is
// UNSTORABLE in `CredentialSecretVersion` at all. The initial migration adds
//
//   CredentialSecretVersion_salt_length_check     CHECK (octet_length(salt) = 32)
//   CredentialSecretVersion_nonce_length_check    CHECK (octet_length(nonce) = 12)
//   CredentialSecretVersion_root_key_check        CHECK (rootKeyVersion > 0)
//
// and the descriptors in `envelope.ts` say format 2 and format 3 have
// `saltBytes: 0` — no salt at all — while format 3's nonce is 16 bytes, and
// neither carries a root key version. Every one of the three CHECKs is violated.
// PostgreSQL refuses the row with SQLSTATE 23514.
//
// SO A MIGRATION IS A TRANSCODING, NOT A COLUMN UPDATE. The legacy ciphertexts
// do not sit in the canonical table waiting to be re-wrapped in place; they sit
// as STRINGS in the columns their own modules wrote — `OperatorMfaTotp`'s
// `encryptedSecret` for format 2, and the agent's base64 secret columns for
// format 3. Migration therefore reads a legacy STRING, opens it under the legacy
// key, and seals the material afresh as a canonical format-1 row. Nothing is
// updated in place, which is also why the `CredentialSecretVersion` immutability
// guard on UPDATE is not in the way.
//
// WHAT THIS FILE OWNS AND WHAT IT REFUSES TO OWN. It owns the SHAPE rule: how
// many bytes each legacy format's nonce and tag must be, read from `envelope.ts`'s
// descriptors rather than restated. It does NOT own the base64/base64url
// decoding — that is wire mechanics, it needs bytes-from-text, and `domain/`
// imports nothing but the kernel. The adapter decodes; this file judges what the
// adapter decoded, and it is the judging that has to be one opinion rather than
// two.

import { err, ok } from "@platos/kernel";
import type { Result } from "@platos/kernel";

import { CANONICAL_ENVELOPE_FORMAT, envelopeFormat, isEnvelopeFormatVersion } from "./envelope.js";
import type { EnvelopeFormatDescriptor, EnvelopeFormatVersion } from "./envelope.js";
import { legacyEnvelopeUnreadable } from "./errors.js";

/** GCM's tag width. One number, because both legacy formats and format 1 use it. */
export const AUTH_TAG_BYTES = 16;

/** What the canonical row's own CHECK constraints demand of a salt and a nonce. */
const CANONICAL_SALT_BYTES = 32;
const CANONICAL_NONCE_BYTES = 12;

/**
 * The formats a migration may read, derived rather than listed.
 *
 * A format is migratable exactly when it is NOT writable: `envelope.ts` already
 * decides which one this boundary writes, and a second list here would be a
 * second opinion about the same closed set. Add a fourth legacy format there and
 * it becomes migratable here with no edit — which is the point, because the
 * alternative is a format that is readable, un-writable and silently
 * un-migratable.
 */
export const MIGRATABLE_ENVELOPE_FORMATS: readonly EnvelopeFormatVersion[] = Object.freeze(
  ([2, 3] as const).filter((version) => !envelopeFormat(version).writable),
);

/** The decoded parts of a legacy envelope. No salt: neither legacy format has one. */
export interface LegacyEnvelopeParts {
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly authTag: Uint8Array;
}

/**
 * A legacy ciphertext exactly as its own column holds it, with the format that
 * says how to read it.
 *
 * `payload` is a STRING and not bytes on purpose: both legacy modules serialise
 * to text and store text, so the migration's input is the column's value
 * verbatim. Converting it to bytes before the format is known is how a
 * base64url payload gets decoded as base64 and yields plausible garbage.
 */
export interface LegacySecretPayload {
  readonly formatVersion: EnvelopeFormatVersion;
  readonly payload: string;
}

/**
 * Accept a format a migration may read, or refuse.
 *
 * Refuses format 1 with its OWN reason rather than the unknown-format one. The
 * two are different mistakes — one is "you pointed the migration at material
 * that is already canonical", the other is "that number is not a format" — and a
 * shared reason would make an operator's log unable to tell them apart.
 */
export function requireMigratableFormat(formatVersion: number): Result<EnvelopeFormatDescriptor> {
  if (!isEnvelopeFormatVersion(formatVersion)) {
    return err(legacyEnvelopeUnreadable("format_not_a_known_version"));
  }
  if (formatVersion === CANONICAL_ENVELOPE_FORMAT) {
    return err(legacyEnvelopeUnreadable("format_is_already_canonical"));
  }
  const descriptor = envelopeFormat(formatVersion);
  if (descriptor.writable) return err(legacyEnvelopeUnreadable("format_is_already_canonical"));
  return ok(descriptor);
}

/**
 * Judge decoded bytes against the format's declared widths.
 *
 * EVERY WIDTH COMES FROM THE DESCRIPTOR, NOT FROM A LITERAL HERE. Format 2's
 * nonce is 12 bytes and format 3's is 16, and that difference is the whole
 * reason the discriminator exists: a format-3 payload read as format 2 would
 * hand the cipher a 12-byte slice of a 16-byte IV and the remaining four bytes
 * to the tag, which fails the tag check rather than mis-decrypting — but it
 * fails it for the WRONG reason, and an operator would chase the key.
 *
 * A NON-EMPTY SALT IS REFUSED RATHER THAN IGNORED. Both legacy descriptors say
 * `saltBytes: 0`. A caller that arrived with salt bytes has either mis-read a
 * canonical envelope as a legacy one or invented a shape, and opening it anyway
 * would silently discard material that changes the key.
 */
export function requireLegacyEnvelopeShape(
  descriptor: EnvelopeFormatDescriptor,
  parts: LegacyEnvelopeParts,
  saltBytes = 0,
): Result<LegacyEnvelopeParts> {
  if (saltBytes !== descriptor.saltBytes) {
    return err(legacyEnvelopeUnreadable("legacy_format_carries_no_salt"));
  }
  if (parts.nonce.length !== descriptor.nonceBytes) {
    return err(legacyEnvelopeUnreadable("nonce_width_disagrees_with_format"));
  }
  if (parts.authTag.length !== AUTH_TAG_BYTES) {
    return err(legacyEnvelopeUnreadable("auth_tag_width_disagrees_with_format"));
  }
  if (parts.ciphertext.length === 0) {
    return err(legacyEnvelopeUnreadable("ciphertext_is_empty"));
  }
  return ok(parts);
}

/**
 * Which of the canonical row's CHECK constraints this format violates, as data.
 *
 * It is a list of constraint NAMES rather than prose in a comment because the
 * claim is checkable: each name is a constraint the initial migration really
 * adds, and a suite that reads the migration — or a real PostgreSQL that raises
 * it — can join this list to something outside this package. A comment could not
 * be joined to anything, and this repository has already paid for one assertion
 * that compared two things one tranche controlled.
 */
export function canonicalRowRefusals(descriptor: EnvelopeFormatDescriptor): readonly string[] {
  const refusals: string[] = [];
  if (descriptor.saltBytes !== CANONICAL_SALT_BYTES) {
    refusals.push("CredentialSecretVersion_salt_length_check");
  }
  if (descriptor.nonceBytes !== CANONICAL_NONCE_BYTES) {
    refusals.push("CredentialSecretVersion_nonce_length_check");
  }
  if (!descriptor.versionedRootKey) {
    refusals.push("CredentialSecretVersion_root_key_check");
  }
  return Object.freeze(refusals);
}
