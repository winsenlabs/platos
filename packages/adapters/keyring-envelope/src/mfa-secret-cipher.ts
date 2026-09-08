// The identity-access `MfaSecretCipher` — the FOURTH port on this directory, and
// the one that belongs to a different context than the other three.
//
// ---------------------------------------------------------------------------
// WHY IT IS HERE AND CANNOT BE ANYWHERE ELSE.
//
// `MfaSecretCipher` needs AES-256 key material. `root-key-ring.ts` is "the ONE
// place in the repository that holds AES-256 root key bytes" and it means it:
// `RootKeyRingResolver.resolve` is reachable only through the closure
// `createRootKeyRing` returns, `index.ts` exports nothing that hands key material
// out, and `KeyringEnvelopeAdapter` publishes `state` and `handle` but never
// `resolve`. A composition root therefore CANNOT obtain the bytes to hand to
// another directory.
//
// And it may not obtain them by chaining, either: rule (j2)
// `adapter-is-self-contained` forbids one adapter package from importing
// another, so a `packages/adapters/mfa-envelope` could not import
// `RootKeyRingResolver` even as a type. Its only remaining option would be to
// parse its OWN key material out of its OWN environment variable — a second key
// hierarchy for the same installation, which is the arrangement this directory
// was created to end.
//
// So the choice is not "here or in a fourteenth directory". It is "here, or a
// second custodian of AES-256 root keys". ADR M0.3 §15's amendment — one client,
// one directory, N ports — reads the key ring as the client, and this is its
// fourth port for the same reason `Hasher` was its third.
//
// THE TWO CONTEXTS STILL DO NOT TOUCH. `identity-access` imports nothing but the
// kernel and `secrets` never learns this column exists; what they share is an
// ADAPTER, exactly as seventeen contexts share `postgres-tenancy` without
// importing each other. The port's own header anticipated this: "it is a
// composition-root decision about which key an adapter is handed, not a change
// to this interface."
//
// ---------------------------------------------------------------------------
// THE FORMAT IS NEW, AND THAT IS A MIGRATION. SAID PLAINLY.
//
// `OperatorMfaTotp.encryptedSecret` rows already exist, and they were written by
// `encryptSecret` in `internal-packages/tenancy-database/src/auth.ts` — the shape
// `secrets/domain/envelope.ts` catalogues as FORMAT 2,
// `raw-key.aes-256-gcm.dotted-base64url`: a raw single key, no derivation, no
// salt, no context binding, no version, `iv.tag.ciphertext` joined by dots.
//
// This cipher does NOT write that shape and could not: `requireWritableFormat`
// refuses every format but 1, for reasons that file spells out — "an envelope
// lifted from one row opens in another; a key that leaks compromises every row
// at once; and no rotation can reach them because there is no version to
// rotate." Nor does it READ that shape, and the omission is deliberate rather
// than forgotten: `legacy-envelope-reader.ts` can read format 2, but it needs a
// legacy key, no configuration group in `apps/core-api/src/config/security.ts`
// carries one, and inventing a variable to hold it is a config-surface decision
// this tranche is not entitled to take on its own.
//
// THE CONSEQUENCE, STATED SO NOBODY DISCOVERS IT AT A SIGN-IN. An installation
// that already has enrolled operators must either re-enrol them or run a
// migration that opens each format-2 column with the legacy key and re-seals it
// through `seal` below, BEFORE identity-access is composed over this adapter.
// `mfa-secret-cipher.test.ts` makes that requirement executable: it takes
// format-2 payloads `auth.ts` itself produced and asserts `open` REFUSES them —
// so the day a legacy path is added, that test has to be rewritten rather than
// silently kept passing.
//
// ---------------------------------------------------------------------------
// THE CONSTRUCTION IS `envelope-cipher.ts`'S, WITH ITS OWN LABEL SPACE.
//
// HKDF-SHA256 over a fresh 32-byte salt, AES-256-GCM under a fresh 12-byte
// nonce, the label in the expand `info` and its sibling in the AAD. The ONE
// difference is which label, and that difference is the whole separation:
// `platos:mfa-secret:v1:...` can never collide with
// `platos:credential-secret:v1:...` or `platos:secret-handle:v1:...`, so a
// credential envelope pasted into an MFA column derives a key that never sealed
// it and dies at the tag rather than at a comparison this file writes.
//
// The labels are NOT taken from `secrets/domain/envelope.ts`. `envelopeKeyInfo`
// needs an `EnvelopeBinding` — an environment, a credential, a revision — and
// this column has none of those: it is keyed by `userId` alone and lives in
// another context's table. Borrowing that binding would mean inventing values
// for four fields to satisfy a function signature, and an AAD built from
// invented values authenticates nothing.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

import type { MfaSecretCipher } from "@platos/context-identity-access/application/ports/index.js";
import type { RootKeyVersion } from "@platos/context-secrets/application/ports/index.js";
import { rootKeyVersion } from "@platos/context-secrets/application/ports/index.js";

import type { RootKeyRingResolver } from "./root-key-ring.js";

/** The one cipher this boundary uses. Named once so nothing can drift from it. */
const ALGORITHM = "aes-256-gcm";

/** HKDF output width: an AES-256 key. */
const DERIVED_KEY_BYTES = 32;

/** Format 1's widths, and this envelope's: `envelope.ts`'s descriptor for both. */
const SALT_BYTES = 32;
const NONCE_BYTES = 12;

/**
 * The wire marker, and the reason it is a WORD rather than a number.
 *
 * A format-2 payload is three dot-separated base64url fields. This one is SIX,
 * and the first is a literal that base64url cannot produce a leading `mfa1.`
 * for by accident. Two independent discriminators — the marker and the field
 * count — is what makes "this column holds a legacy envelope" a distinguishable
 * answer rather than a tag-check failure an operator would read as corruption.
 */
const MARKER = "mfa1";

/** Six fields: marker, root key version, salt, nonce, tag, ciphertext. */
const FIELD_COUNT = 6;

/** The HKDF expand `info`. Changing it makes every sealed secret unopenable. */
function mfaKeyInfo(rootKeyVersion: number): string {
  return `platos:mfa-secret:v1:key:${rootKeyVersion}`;
}

/** The additional authenticated data. Binds the envelope to its key version. */
function mfaAad(rootKeyVersion: number): string {
  return `platos:mfa-secret:v1:aad:${rootKeyVersion}`;
}

/**
 * Why one `open` refused.
 *
 * DISTINCT REASONS, DELIBERATELY — and the difference from `envelope-cipher.ts`,
 * which collapses every failure into one `credential unavailable`, is measured
 * rather than careless. That collapse protects a boundary where the CALLER
 * supplies the ciphertext: a holder presenting a secret reference must not be
 * able to tell "wrong environment" from "expired" from "invented", because the
 * answers would be a probing oracle.
 *
 * Nothing supplies this ciphertext. It is read from `OperatorMfaTotp`, a column
 * identity-access is sole writer of, by a use case that already found the row.
 * The only reader of the reason is an operator's log, and there "your column is
 * a legacy format-2 envelope" and "your root key has been rotated out of the
 * ring" and "these bytes have been tampered with" are three completely different
 * mornings. The four crypto failures that ARE indistinguishable stay
 * indistinguishable: a wrong key, a flipped ciphertext byte, a flipped tag byte
 * and a re-labelled version all fail at the tag, produced by the primitive, and
 * this file has no branch that could tell them apart.
 */
export type MfaEnvelopeRefusal =
  | "mfa_envelope_is_not_a_canonical_payload"
  | "mfa_envelope_root_key_version_is_not_an_integer_literal"
  | "mfa_envelope_root_key_unavailable"
  | "mfa_envelope_failed_authentication"
  | "mfa_secret_ring_has_no_active_key";

/**
 * The one thing `seal` and `open` throw.
 *
 * They THROW rather than returning a `Result` because the port is
 * `open(sealed): string` — three synchronous methods with no failure channel —
 * and `verify-mfa.ts` calls it inline as `ports.cipher.open(credential.encryptedSecret)`.
 * The fake in `identity-access/application/testing.ts` throws a `TypeError` for
 * the same reason. This class carries the reason so a process log can name it
 * without the message having to be parsed.
 */
export class MfaEnvelopeError extends Error {
  constructor(readonly reason: MfaEnvelopeRefusal) {
    super(`mfa secret envelope refused: ${reason}`);
    this.name = "MfaEnvelopeError";
  }
}

function deriveKey(rootKey: Uint8Array, salt: Uint8Array, rootKeyVersion: number): Uint8Array {
  // The SALT makes the key unique per envelope and the INFO makes it unique per
  // key version, so two secrets never share a derived key and an envelope
  // re-labelled with another version derives a key that never sealed it.
  return new Uint8Array(
    hkdfSync(
      "sha256",
      rootKey,
      salt,
      Buffer.from(mfaKeyInfo(rootKeyVersion), "utf8"),
      DERIVED_KEY_BYTES,
    ),
  );
}

/**
 * `1`, `2`, ... and nothing else, judged by the DOMAIN's own constructor.
 *
 * The shape is checked BEFORE the conversion for the reason `root-key-ring.ts`
 * gives: `Number("")` is 0 and `Number(" 1 ")` is 1, so a payload labelled " 1"
 * and one labelled "1" would name the same key while being different strings —
 * and the label is inside the HKDF `info`, so they would not decrypt the same.
 * `rootKeyVersion` then applies the positivity rule, which is `secrets`' and not
 * this file's: restating it here would be a second opinion that could drift.
 */
function parseVersion(raw: string): RootKeyVersion {
  if (!/^[0-9]+$/u.test(raw)) {
    throw new MfaEnvelopeError("mfa_envelope_root_key_version_is_not_an_integer_literal");
  }
  const version = rootKeyVersion(Number(raw));
  if (!version.ok) {
    throw new MfaEnvelopeError("mfa_envelope_root_key_version_is_not_an_integer_literal");
  }
  return version.value;
}

/**
 * The MFA envelope over the versioned root key ring.
 *
 * It takes the RESOLVER rather than the adapter, so this module can reach key
 * bytes and cannot reach `seal`, `openLegacy` or anything else the directory
 * publishes — the same argument `envelope-cipher.ts` makes for taking one.
 */
export function createMfaSecretCipher(ring: RootKeyRingResolver): MfaSecretCipher {
  return {
    seal(plaintext: string): string {
      // The ACTIVE version, read from the ring on every call rather than
      // captured at construction. An installation that rotates its ring and
      // restarts nothing would otherwise keep sealing under the old active key.
      const state = ring.state();
      if (!state.ok) throw new MfaEnvelopeError("mfa_secret_ring_has_no_active_key");
      const version = state.value.activeVersion;

      const handle = ring.mint(version);
      if (!handle.ok) throw new MfaEnvelopeError("mfa_envelope_root_key_unavailable");
      const rootKey = ring.resolve(handle.value);
      if (!rootKey.ok) throw new MfaEnvelopeError("mfa_envelope_root_key_unavailable");

      const salt = new Uint8Array(randomBytes(SALT_BYTES));
      const nonce = new Uint8Array(randomBytes(NONCE_BYTES));
      const cipher = createCipheriv(ALGORITHM, deriveKey(rootKey.value, salt, version), nonce);
      cipher.setAAD(Buffer.from(mfaAad(version), "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

      return [
        MARKER,
        String(version),
        Buffer.from(salt).toString("base64url"),
        Buffer.from(nonce).toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".");
    },

    open(sealed: string): string {
      const fields = sealed.split(".");
      // BOTH discriminators, and the marker is compared in constant time for
      // tidiness rather than for secrecy: it is a public literal. What matters
      // is that a format-2 column — three fields, no marker — lands HERE, with
      // its own reason, instead of reaching the tag check and being reported as
      // corruption.
      if (fields.length !== FIELD_COUNT || fields[0] !== MARKER) {
        throw new MfaEnvelopeError("mfa_envelope_is_not_a_canonical_payload");
      }
      const [, rawVersion, rawSalt, rawNonce, rawTag, rawCiphertext] = fields as [
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      const version = parseVersion(rawVersion);

      const handle = ring.mint(version);
      if (!handle.ok) throw new MfaEnvelopeError("mfa_envelope_root_key_unavailable");
      const rootKey = ring.resolve(handle.value);
      if (!rootKey.ok) throw new MfaEnvelopeError("mfa_envelope_root_key_unavailable");

      try {
        const decipher = createDecipheriv(
          ALGORITHM,
          deriveKey(rootKey.value, new Uint8Array(Buffer.from(rawSalt, "base64url")), version),
          new Uint8Array(Buffer.from(rawNonce, "base64url")),
        );
        decipher.setAAD(Buffer.from(mfaAad(version), "utf8"));
        decipher.setAuthTag(Buffer.from(rawTag, "base64url"));
        return Buffer.concat([
          decipher.update(Buffer.from(rawCiphertext, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        // ONE answer for every cryptographic failure, produced by the primitive.
        // A nonce of the wrong width throws from `createDecipheriv`, a tag of the
        // wrong width from `setAuthTag`, and a wrong key, a flipped byte, a
        // flipped tag and a re-labelled version all from `final()`. There is no
        // branch here that could report which.
        throw new MfaEnvelopeError("mfa_envelope_failed_authentication");
      }
    },
  };
}

/**
 * True when two sealed envelopes were minted under the same key version.
 *
 * Exported for the suite that has to say "these two ciphertexts differ but name
 * the same key", which is the difference between a fresh nonce and a rotation.
 * It reads only the public header, never the ciphertext, and it compares the
 * marker in constant time so that using it on attacker-influenced input can
 * never become a length oracle for the version field.
 */
export function sealedUnderSameKeyVersion(left: string, right: string): boolean {
  const leftHeader = Buffer.from(left.split(".").slice(0, 2).join("."), "utf8");
  const rightHeader = Buffer.from(right.split(".").slice(0, 2).join("."), "utf8");
  return leftHeader.length === rightHeader.length && timingSafeEqual(leftHeader, rightHeader);
}
