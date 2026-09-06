// The envelope, and the fact that there is more than one of them.
//
// THE FINDING THIS FILE EXISTS TO MODEL. The pre-V1 codebase holds THREE
// mutually incompatible AES-256-GCM envelope shapes, written by three modules
// that never agreed:
//
//   1. internal-packages/tenancy-database/src/secrets.ts — HKDF-SHA256-derived
//      per-envelope key, 32-byte random salt, 12-byte nonce, additional
//      authenticated data binding environment/credential/revision/format/root-key,
//      and a VERSIONED root key ring. This is the CANONICAL one: it is exactly
//      what the `CredentialSecretVersion` row stores, column for column.
//   2. internal-packages/tenancy-database/src/auth.ts — a raw single key, a
//      12-byte IV, NO salt and NO additional authenticated data, serialised as
//      dotted base64url `iv.tag.ciphertext` into a string column.
//   3. apps/agent/src/auth/secrets.service.ts — a raw single key, a 16-byte IV,
//      NO salt and NO additional authenticated data, serialised as one packed
//      base64 string of IV, tag and ciphertext concatenated.
//
// `formatVersion` is the discriminator, so it is modelled as an explicit CLOSED
// union rather than a number that happens to be 1 today. Assuming one format is
// how a migration silently mis-decodes a column.
//
// The two legacy shapes are READ-ONLY here. They carry no root key version, so
// they cannot participate in rotation, and they bind no context, so an envelope
// lifted from one row would decrypt happily in another.
//
// RECONCILING THEM ONTO FORMAT 1 IS DONE, AND IT IS NOT A COLUMN UPDATE.
// `legacy-envelope.ts` carries the reason: reading the MIGRATIONS rather than
// `schema.prisma` shows that `CredentialSecretVersion` REFUSES both legacy
// shapes outright — three CHECK constraints (salt exactly 32 bytes, nonce
// exactly 12, rootKeyVersion > 0) are each violated by the descriptors below, so
// no format-2 or format-3 envelope has ever been storable in the canonical row.
// The legacy ciphertexts live as STRINGS in their own modules' columns, and
// migration therefore opens one under its legacy key and seals the material
// AFRESH as a format-1 row. `migrate-legacy-envelope.ts` is that operation, and
// `openSecret` still refuses a legacy format for the reason it always did: after
// the migration there is no legacy row left to open.

import { err, ok } from "@platos/kernel";
import type { EnvironmentId, Result } from "@platos/kernel";

import { envelopeFormatUnwritable } from "./errors.js";
import type { CredentialId, RootKeyVersion, SecretRevision } from "./ids.js";

/** The closed set. Adding a member is a schema decision, not an implementation detail. */
export const ENVELOPE_FORMAT_VERSIONS = [1, 2, 3] as const;

export type EnvelopeFormatVersion = (typeof ENVELOPE_FORMAT_VERSIONS)[number];

/** The one format this boundary writes. Everything else is inbound-only. */
export const CANONICAL_ENVELOPE_FORMAT: EnvelopeFormatVersion = 1;

export interface EnvelopeFormatDescriptor {
  readonly formatVersion: EnvelopeFormatVersion;
  /** Stable, dotted, log-safe name. */
  readonly name: string;
  /** True when a per-envelope key is derived rather than used raw. */
  readonly derivesPerEnvelopeKey: boolean;
  /** Random salt width in bytes; 0 when the format has no salt. */
  readonly saltBytes: number;
  /** Nonce/IV width in bytes. */
  readonly nonceBytes: number;
  /** True when the envelope is bound to its row by additional authenticated data. */
  readonly bindsContext: boolean;
  /** True when the sealing key is selected from a versioned ring. */
  readonly versionedRootKey: boolean;
  /** False for every legacy format: they may be read for migration, never written. */
  readonly writable: boolean;
  /**
   * Which pre-V1 module writes this shape. It is the module a migration's wire
   * vectors must be produced BY, so the path is data rather than a comment.
   */
  readonly legacyOrigin: string | null;
}

const DESCRIPTORS: Readonly<Record<EnvelopeFormatVersion, EnvelopeFormatDescriptor>> = Object.freeze({
  1: Object.freeze({
    formatVersion: 1 as EnvelopeFormatVersion,
    name: "hkdf-sha256.aes-256-gcm.context-bound",
    derivesPerEnvelopeKey: true,
    saltBytes: 32,
    nonceBytes: 12,
    bindsContext: true,
    versionedRootKey: true,
    writable: true,
    legacyOrigin: null,
  }),
  2: Object.freeze({
    formatVersion: 2 as EnvelopeFormatVersion,
    name: "raw-key.aes-256-gcm.dotted-base64url",
    derivesPerEnvelopeKey: false,
    saltBytes: 0,
    nonceBytes: 12,
    bindsContext: false,
    versionedRootKey: false,
    writable: false,
    legacyOrigin: "internal-packages/tenancy-database/src/auth.ts",
  }),
  3: Object.freeze({
    formatVersion: 3 as EnvelopeFormatVersion,
    name: "raw-key.aes-256-gcm.packed-base64",
    derivesPerEnvelopeKey: false,
    saltBytes: 0,
    nonceBytes: 16,
    bindsContext: false,
    versionedRootKey: false,
    writable: false,
    legacyOrigin: "apps/agent/src/auth/secrets.service.ts",
  }),
});

export function isEnvelopeFormatVersion(value: number): value is EnvelopeFormatVersion {
  return (ENVELOPE_FORMAT_VERSIONS as readonly number[]).includes(value);
}

export function envelopeFormat(formatVersion: EnvelopeFormatVersion): EnvelopeFormatDescriptor {
  return DESCRIPTORS[formatVersion];
}

/** Guards the write side: only the canonical format may be sealed. */
export function requireWritableFormat(
  formatVersion: EnvelopeFormatVersion,
): Result<EnvelopeFormatDescriptor> {
  const descriptor = envelopeFormat(formatVersion);
  return descriptor.writable ? ok(descriptor) : err(envelopeFormatUnwritable(formatVersion));
}

/**
 * What an envelope is bound to. Every field is inside the additional
 * authenticated data, so an envelope moved to another environment, credential,
 * revision, format or root key version fails to open rather than decoding.
 */
export interface EnvelopeBinding {
  readonly environmentId: EnvironmentId;
  readonly credentialId: CredentialId;
  readonly secretRevision: SecretRevision;
  readonly formatVersion: EnvelopeFormatVersion;
  readonly rootKeyVersion: RootKeyVersion;
}

/** The sealed bytes. The domain moves these around; it never interprets them. */
export interface SealedEnvelope {
  readonly salt: Uint8Array;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly authTag: Uint8Array;
}

// WIRE COMPATIBILITY. The two labels below are byte-for-byte what the extraction
// source derives and authenticates with today, down to the NUL field separator.
// Changing a separator, an order or a character makes every stored format-1
// envelope permanently unopenable, so the strings are pinned by a colocated test
// rather than left to a future edit.
const ENVELOPE_DOMAIN = "platos:credential-secret:v1";
const FIELD_SEPARATOR = "\u0000";

function serializeBinding(binding: EnvelopeBinding): string {
  return [
    binding.environmentId,
    binding.credentialId,
    binding.secretRevision,
    binding.formatVersion,
    binding.rootKeyVersion,
  ].join(FIELD_SEPARATOR);
}

/** HKDF `info`: what the per-envelope key is derived for. */
export function envelopeKeyInfo(binding: EnvelopeBinding): string {
  return `${ENVELOPE_DOMAIN}:key:${serializeBinding(binding)}`;
}

/** Additional authenticated data: what the ciphertext is glued to. */
export function envelopeAad(binding: EnvelopeBinding): string {
  return `${ENVELOPE_DOMAIN}:aad:${serializeBinding(binding)}`;
}

/** True when two bindings address the same envelope slot. */
export function sameBinding(left: EnvelopeBinding, right: EnvelopeBinding): boolean {
  return serializeBinding(left) === serializeBinding(right);
}
