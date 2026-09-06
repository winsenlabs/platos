// Reading the two legacy envelope shapes — the ONE place in the tree that can,
// and the only direction it goes.
//
// WHAT THIS IS FOR. `secrets/domain/envelope.ts` catalogues three mutually
// incompatible AES-256-GCM shapes written by three modules that never agreed.
// Format 1 is the canonical one and `envelope-cipher.ts` seals and opens it.
// Formats 2 and 3 are the other two, and until this file nothing anywhere could
// read them into V1 — `openSecret` refused them outright, so the material in
// every `OperatorMfaTotp.encryptedSecret` and every agent-side base64 secret
// column was, as far as the vault was concerned, unreachable.
//
// THERE IS NO `sealLegacy`, AND THERE NEVER WILL BE. Both formats use a RAW
// single key with no derivation, carry no salt, bind no context and name no root
// key version. An envelope lifted from one row opens in another; a key that leaks
// compromises every row at once; and no rotation can reach them because there is
// no version to rotate. Writing one is the mistake the migration exists to undo,
// so this module exposes exactly one verb.
//
// WHY THE KEYS LIVE HERE. `root-key-ring.ts` is "the ONE place in the repository
// that holds AES-256 root key bytes" and refuses to be anywhere else. A legacy
// key is AES-256 root key bytes with weaker handling, so it lives with its
// siblings rather than in a second custodian — and it is deliberately NOT in the
// ring: it has no version, it may never seal, and putting it in the ring would
// make it mintable as a `RootKeyHandle` and therefore usable by `seal`.
//
// THE DOMAIN JUDGES, THIS FILE DECODES. Every width and every accept/refuse
// decision comes from `secrets`' `requireMigratableFormat` and
// `requireLegacyEnvelopeShape`. What is left here is the part the domain cannot
// do because `domain/` imports nothing but the kernel: turning text into bytes.
// A reader that decided widths for itself would be the fourth module with its own
// opinion about an envelope, which is how there came to be three.

import { createDecipheriv } from "node:crypto";

import type {
  EnvelopeFormatDescriptor,
  LegacyEnvelopeParts,
  LegacyOpenRequest,
  Result,
  SecretMaterial,
} from "@platos/context-secrets/application/ports/index.js";
import {
  ROOT_KEY_BYTE_LENGTH,
  err,
  legacyEnvelopeUnreadable,
  ok,
  requireLegacyEnvelopeShape,
  requireMigratableFormat,
  secretMaterial,
} from "@platos/context-secrets/application/ports/index.js";

/** The one cipher both legacy formats used. Named once so nothing drifts from it. */
const ALGORITHM = "aes-256-gcm";

/** GCM's tag width, as both legacy sources emit it. */
const TAG_BYTES = 16;

/**
 * The raw keys an installation configured for the legacy formats, keyed by the
 * format they open.
 *
 * KEYED BY FORMAT BECAUSE THE TWO ARE GENUINELY DIFFERENT KEYS. Format 2 is
 * sealed with `PlatosAuthService`'s `encryptionKey`; format 3 with the agent's
 * `PLATOS_ENCRYPTION_KEY`. An installation that ran both had two secrets, and a
 * reader that took ONE key would silently fail the tag check on half its rows and
 * report it as corruption.
 *
 * Hex or a 32-byte value, matching what each source's own parser accepts. A
 * format with no key configured is absent rather than empty: absent is a
 * migration that has not been set up, and it gets its own refusal.
 */
export interface LegacyKeyInput {
  readonly keys: Readonly<Record<string, string>>;
}

export interface LegacyEnvelopeReader {
  openLegacy(request: LegacyOpenRequest): Promise<Result<SecretMaterial>>;
}

/** Exactly 64 hex characters: one AES-256 key, as both legacy sources accept it. */
const HEX_KEY = /^[0-9a-fA-F]{64}$/u;

function decodeKey(value: string): Result<Uint8Array> {
  if (!HEX_KEY.test(value)) return err(legacyEnvelopeUnreadable("legacy_key_is_not_32_bytes"));
  const bytes = new Uint8Array(ROOT_KEY_BYTE_LENGTH);
  for (let index = 0; index < ROOT_KEY_BYTE_LENGTH; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return ok(bytes);
}

/**
 * Format 2 — `internal-packages/tenancy-database/src/auth.ts`.
 *
 * `encryptSecret` there is, verbatim:
 *   `[iv, cipher.getAuthTag(), ciphertext].map((p) => p.toString("base64url")).join(".")`
 * with a 12-byte iv. So: three dot-separated base64url fields, in THAT order.
 * The order is the part a re-implementation gets wrong — tag before ciphertext
 * is unusual — and getting it wrong yields a tag check failure indistinguishable
 * from a wrong key, which is why `legacy-wire-vectors.ts` pins bytes that source
 * produced rather than bytes this file produced.
 */
function decodeDottedTriple(payload: string): Result<LegacyEnvelopeParts> {
  const fields = payload.split(".");
  if (fields.length !== 3) {
    return err(legacyEnvelopeUnreadable("payload_is_not_a_dotted_base64url_triple"));
  }
  const [nonce, authTag, ciphertext] = fields.map((field) =>
    new Uint8Array(Buffer.from(field, "base64url")),
  );
  if (nonce === undefined || authTag === undefined || ciphertext === undefined) {
    return err(legacyEnvelopeUnreadable("payload_is_not_a_dotted_base64url_triple"));
  }
  return ok({ nonce, ciphertext, authTag });
}

/**
 * Format 3 — `apps/agent/src/auth/secrets.service.ts`.
 *
 * `encrypt` there packs `Buffer.concat([iv, authTag, encrypted]).toString("base64")`
 * with `IV_LENGTH = 16` and `AUTH_TAG_LENGTH = 16`. One base64 string, no
 * separators, and the SAME iv-then-tag order as format 2 with a wider iv — which
 * is precisely why the discriminator cannot be dropped and the two cannot share a
 * decoder.
 *
 * `Buffer.from(value, "base64")` is lenient: it ignores characters outside the
 * alphabet rather than refusing. So a payload that survives the decode is
 * re-encoded and compared, and a string that is not canonical base64 is refused
 * rather than silently truncated into a plausible header.
 */
function decodePacked(payload: string, nonceBytes: number): Result<LegacyEnvelopeParts> {
  const packed = new Uint8Array(Buffer.from(payload, "base64"));
  if (Buffer.from(packed).toString("base64") !== payload) {
    return err(legacyEnvelopeUnreadable("payload_is_not_base64"));
  }
  if (packed.length <= nonceBytes + TAG_BYTES) {
    return err(legacyEnvelopeUnreadable("payload_is_shorter_than_its_own_header"));
  }
  return ok({
    nonce: packed.subarray(0, nonceBytes),
    authTag: packed.subarray(nonceBytes, nonceBytes + TAG_BYTES),
    ciphertext: packed.subarray(nonceBytes + TAG_BYTES),
  });
}

function decode(
  descriptor: EnvelopeFormatDescriptor,
  payload: string,
): Result<LegacyEnvelopeParts> {
  // The DESCRIPTOR chooses the decoder, and its `name` is the discriminator
  // rather than the bare number. `envelope.ts` gives each format a "stable,
  // dotted, log-safe name"; switching on it means a format added there with a
  // shape neither decoder handles falls through to a refusal instead of being
  // decoded by whichever branch a numeric `default` happened to pick.
  if (descriptor.name === "raw-key.aes-256-gcm.dotted-base64url") return decodeDottedTriple(payload);
  if (descriptor.name === "raw-key.aes-256-gcm.packed-base64") {
    return decodePacked(payload, descriptor.nonceBytes);
  }
  return err(legacyEnvelopeUnreadable("format_not_a_known_version"));
}

export function createLegacyEnvelopeReader(input: LegacyKeyInput): LegacyEnvelopeReader {
  return {
    async openLegacy(request: LegacyOpenRequest): Promise<Result<SecretMaterial>> {
      const format = requireMigratableFormat(request.formatVersion);
      if (!format.ok) return err(format.error);

      const configured = input.keys[String(request.formatVersion)];
      if (configured === undefined) {
        return err(legacyEnvelopeUnreadable("legacy_key_absent_for_format"));
      }
      const key = decodeKey(configured);
      if (!key.ok) return err(key.error);

      const decoded = decode(format.value, request.payload);
      if (!decoded.ok) return err(decoded.error);

      // The DOMAIN judges the widths. This call is what makes a format-3 payload
      // presented as format 2 fail with `nonce_width_disagrees_with_format`
      // rather than as a tag check, which is the difference between an operator
      // fixing a column's declared format and an operator rotating a key that was
      // never wrong.
      const parts = requireLegacyEnvelopeShape(format.value, decoded.value);
      if (!parts.ok) return err(parts.error);

      try {
        // NO `setAAD`. Neither legacy format authenticates any associated data —
        // `envelope.ts` records `bindsContext: false` for both — and adding some
        // here would make every stored legacy envelope fail to open. The absence
        // is the format, not an omission.
        const decipher = createDecipheriv(ALGORITHM, key.value, parts.value.nonce);
        decipher.setAuthTag(parts.value.authTag);
        const plaintext = Buffer.concat([
          decipher.update(parts.value.ciphertext),
          decipher.final(),
        ]).toString("utf8");
        return ok(secretMaterial(plaintext));
      } catch {
        // ONE reason for the primitive's failures, distinct from every reason
        // above it. The widths, the encoding, the format and the key's presence
        // were each judged and each answered for itself before this point; what
        // is left is a wrong key or a tampered payload, and in GCM those ARE the
        // same event.
        return err(legacyEnvelopeUnreadable("legacy_envelope_open_failed"));
      }
    },
  };
}
