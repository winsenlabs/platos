// The cryptography ports. ADR M0.3 §2: domain and application see infrastructure
// ONLY as Platos-owned port interfaces.
//
// WHY CRYPTOGRAPHY IS A PORT AND NOT A DOMAIN SERVICE. Put `node:crypto` in the
// domain and every rule that depends on it becomes untestable without real keys,
// real entropy and real timing. Behind a port, a fake cipher and a fake ring make
// the rotation rules, the fail-closed paths and the retirement lifecycle
// exercisable in memory — which is the only way the negative controls below can
// exist at all. The real adapter still does real AES-256-GCM; it just does it in
// exactly one place.
//
// THE DOMAIN NEVER SEES KEY BYTES. `RootKeyHandle` is opaque: it names a version
// and carries nothing else across the boundary. A use case can therefore reason
// about which key sealed what without ever being able to leak one.

import type { Result } from "@platos/kernel";

import type { EnvelopeBinding, SealedEnvelope } from "../../domain/envelope.js";
import type { RootKeyRingState } from "../../domain/key-ring.js";
import type { RootKeyVersion } from "../../domain/ids.js";
import type { SecretHandleBinding, SecretHandleEnvelope } from "../../domain/secret-handle.js";
import type { SecretMaterial } from "../../domain/secret-material.js";

declare const rootKeyHandle: unique symbol;

/**
 * A usable reference to one root key. Opaque by construction: the adapter that
 * minted it can resolve it to bytes, and nothing else can.
 */
export type RootKeyHandle = {
  readonly rootKeyVersion: RootKeyVersion;
} & { readonly [rootKeyHandle]: "secrets.rootKeyHandle" };

/**
 * The versioned key ring. Sole holder of the data-encryption keys ADR M0.3 §1
 * row 3 says this context alone may hold.
 */
export interface KeyRing {
  /** Which versions exist and which one seals new envelopes. */
  state(): Promise<Result<RootKeyRingState>>;
  /**
   * Resolve one version. Fails when the version has been rotated out — the
   * fail-closed path, and the reason a rotated-out envelope yields an error
   * rather than its ciphertext.
   */
  handle(version: RootKeyVersion): Promise<Result<RootKeyHandle>>;
}

export interface SealRequest {
  readonly key: RootKeyHandle;
  readonly binding: EnvelopeBinding;
  /** The only direction plaintext travels: inward, once, at seal time. */
  readonly plaintext: SecretMaterial;
}

export interface OpenRequest {
  readonly key: RootKeyHandle;
  readonly binding: EnvelopeBinding;
  readonly envelope: SealedEnvelope;
}

/**
 * Authenticated encryption with associated data.
 *
 * The port owns randomness: `seal` produces the salt and the nonce, so no caller
 * can supply a reused one. `open` returns ONE undifferentiated failure for a
 * wrong key, a tampered tag, a tampered ciphertext and a relocated binding — the
 * extraction source's pure test pins exactly that collapse.
 */
/**
 * WIN-259 — sealing a SECRET REFERENCE.
 *
 * A SECOND AAD SHAPE ON THE SAME PORT, NOT A SECOND PORT, and the distinction is
 * worth stating. ADR M0.3 §6 budgets constructor-injected dependencies at 6
 * (warn) / 8 (hard), and `SecretsDependencies` already holds eight — it is AT
 * the hard ceiling, not near it. A ninth would have bought a name for
 * something that is the same primitive — authenticated encryption with
 * associated data — over a different label space. What makes a reference safe
 * is not a separate cipher, it is that `secretHandleAad` and `envelopeAad` can
 * never collide, so a credential envelope presented as a reference (or the
 * reverse) fails at the tag.
 *
 * The body is `string` rather than `SecretMaterial` because a reference's body
 * is NOT material: it is an identifier, a revision and two instants. Typing it
 * as material would have said the opposite of what this whole mechanism is for,
 * and would have made `reveal()` — the greppable unwrap that marks every real
 * plaintext call site — fire on a value that never held a plaintext.
 */
export interface SealHandleRequest {
  readonly key: RootKeyHandle;
  readonly binding: SecretHandleBinding;
  readonly body: string;
}

export interface OpenHandleRequest {
  readonly key: RootKeyHandle;
  readonly binding: SecretHandleBinding;
  readonly envelope: SecretHandleEnvelope;
}

export interface AeadCipher {
  seal(request: SealRequest): Promise<Result<SealedEnvelope>>;
  open(request: OpenRequest): Promise<Result<SecretMaterial>>;
  /** Seal a reference's claims. Environment-bound through `binding`, never material. */
  sealHandle(request: SealHandleRequest): Promise<Result<SecretHandleEnvelope>>;
  /**
   * Open a reference. ONE undifferentiated failure for a wrong environment, a
   * wrong root key, an edited byte and an invented reference — the same collapse
   * `open` above makes, for the same reason.
   */
  openHandle(request: OpenHandleRequest): Promise<Result<string>>;
}

/**
 * One-way hashing, for the transitional `Credential.secretHash` verifier the
 * schema flags. It is a port rather than a domain function for the same reason
 * the cipher is, and it is deliberately separate from the cipher so a hash can
 * never be mistaken for a reversible envelope.
 */
export interface Hasher {
  hash(value: SecretMaterial): Promise<Result<string>>;
  /** Constant-time in the adapter. The domain must not compare digests itself. */
  verify(value: SecretMaterial, digest: string): Promise<Result<boolean>>;
}
