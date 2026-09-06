// AES-256-GCM over an HKDF-SHA256-derived per-envelope key — the real
// `AeadCipher`, and the first one in the tree.
//
// UNTIL THIS FILE THE ONLY IMPLEMENTATION WAS `secrets`'
// `application/in-memory-crypto.ts`, whose own header says "It is NOT
// cryptography. It is a test double with the right failure modes." Every use
// case, every rotation rule and every fail-closed path in the vault was therefore
// proven against a keystream derived from FNV-1a. The rules were right; nothing
// had ever sealed a byte.
//
// THE FORMAT IS NOT NEGOTIABLE AND IS NOT RESTATED HERE.
// `secrets/domain/envelope.ts` pins the HKDF `info` and the AEAD associated data
// byte-for-byte — "changing a separator, an order or a character makes every
// stored format-1 envelope permanently unopenable" — so this file IMPORTS
// `envelopeKeyInfo` and `envelopeAad` rather than spelling
// `platos:credential-secret:v1` again. The three mutually incompatible envelope
// shapes that file's header catalogues exist precisely because three modules each
// wrote their own.
//
// WHAT `open` DOES NOT TELL THE CALLER. A wrong key, a tampered tag, a tampered
// ciphertext and a relocated binding all fail identically, because in GCM they
// ARE identical: the tag check fails and there is nothing else to report. The
// port's header asks for exactly that collapse, and the failure is produced by
// the primitive rather than by a comparison this file writes — there is no branch
// here that could leak which one it was.
//
// RANDOMNESS IS OWNED HERE. `crypto.ts`: "the port owns randomness: `seal`
// produces the salt and the nonce, so no caller can supply a reused one." A
// 12-byte GCM nonce reused under one key is a total break, and the per-envelope
// key is derived from a fresh 32-byte salt on every seal, so two envelopes never
// share a key at all.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

import type {
  AeadCipher,
  EnvelopeBinding,
  OpenRequest,
  Result,
  SealRequest,
  SealedEnvelope,
  SecretMaterial,
} from "@platos/context-secrets/application/ports/index.js";
import {
  credentialUnavailable,
  envelopeAad,
  envelopeKeyInfo,
  err,
  invalidKeyRing,
  ok,
  secretMaterial,
} from "@platos/context-secrets/application/ports/index.js";

import type { RootKeyRingResolver } from "./root-key-ring.js";

/** The one cipher this boundary uses. Named once so nothing can drift from it. */
const ALGORITHM = "aes-256-gcm";

/** HKDF output width: an AES-256 key. */
const DERIVED_KEY_BYTES = 32;

/** `randomBytes` widths, matching format 1's descriptor in `domain/envelope.ts`. */
const SALT_BYTES = 32;
const NONCE_BYTES = 12;

function deriveKey(rootKey: Uint8Array, salt: Uint8Array, binding: EnvelopeBinding): Uint8Array {
  // HKDF-SHA256 with the SALT as the extract salt and the binding as the expand
  // `info`. Both halves matter: the salt makes the key unique per envelope, and
  // the info makes it unique per SLOT, so a ciphertext moved to another
  // credential is decrypted with a key that was never used to encrypt it.
  return new Uint8Array(
    hkdfSync("sha256", rootKey, salt, Buffer.from(envelopeKeyInfo(binding), "utf8"), DERIVED_KEY_BYTES),
  );
}

/**
 * Refuse a request whose handle names a different root key version than the
 * envelope binding does.
 *
 * This guard has no analogue in the extraction source, and it exists because the
 * port SPLIT what that source held together. There, one function took a root key
 * and a context minted from the same ring in the same statement. Here the caller
 * assembles a `SealRequest` from a handle it fetched and a binding it built, and
 * `envelope-operations.ts` builds both from `ring.activeVersion` — correctly, but
 * nothing in the TYPES says it must. A seal under the mismatch would succeed and
 * write an envelope that can never be opened: `open` derives its key from the
 * BINDING's version, so the ciphertext would be sealed with v1's material and
 * unsealed with v2's, forever. That is silent, permanent data loss on a write
 * that reported success, which is why it is refused rather than trusted.
 */
function requireHandleMatchesBinding(
  handleVersion: number,
  binding: EnvelopeBinding,
): Result<null> {
  if (handleVersion !== binding.rootKeyVersion) {
    return err(invalidKeyRing("root_key_handle_disagrees_with_envelope_binding"));
  }
  return ok(null);
}

export function createEnvelopeCipher(ring: RootKeyRingResolver): AeadCipher {
  return {
    async seal(request: SealRequest): Promise<Result<SealedEnvelope>> {
      const matched = requireHandleMatchesBinding(request.key.rootKeyVersion, request.binding);
      if (!matched.ok) return err(matched.error);

      const rootKey = ring.resolve(request.key);
      if (!rootKey.ok) return err(rootKey.error);

      const salt = new Uint8Array(randomBytes(SALT_BYTES));
      const nonce = new Uint8Array(randomBytes(NONCE_BYTES));
      const cipher = createCipheriv(ALGORITHM, deriveKey(rootKey.value, salt, request.binding), nonce);
      cipher.setAAD(Buffer.from(envelopeAad(request.binding), "utf8"));
      const ciphertext = Buffer.concat([
        cipher.update(request.plaintext.reveal(), "utf8"),
        cipher.final(),
      ]);
      return ok({
        salt,
        nonce,
        ciphertext: new Uint8Array(ciphertext),
        authTag: new Uint8Array(cipher.getAuthTag()),
      });
    },

    async open(request: OpenRequest): Promise<Result<SecretMaterial>> {
      const matched = requireHandleMatchesBinding(request.key.rootKeyVersion, request.binding);
      if (!matched.ok) return err(matched.error);

      const rootKey = ring.resolve(request.key);
      if (!rootKey.ok) return err(rootKey.error);

      try {
        const decipher = createDecipheriv(
          ALGORITHM,
          deriveKey(rootKey.value, request.envelope.salt, request.binding),
          request.envelope.nonce,
        );
        decipher.setAAD(Buffer.from(envelopeAad(request.binding), "utf8"));
        decipher.setAuthTag(request.envelope.authTag);
        const plaintext = Buffer.concat([
          decipher.update(request.envelope.ciphertext),
          decipher.final(),
        ]).toString("utf8");
        return ok(secretMaterial(plaintext));
      } catch {
        // ONE answer for every failure, and the `catch` is the whole of it. A
        // nonce of the wrong width throws from `createDecipheriv`, a tag of the
        // wrong width throws from `setAuthTag`, and a wrong key, a moved binding,
        // a flipped ciphertext byte and a flipped tag byte all throw from
        // `final()`. Distinguishing them would hand a caller a probing oracle,
        // which is the property `domain/errors.ts` collapses nine reasons to
        // protect.
        return err(credentialUnavailable("envelope_open_failed"));
      }
    },
  };
}
