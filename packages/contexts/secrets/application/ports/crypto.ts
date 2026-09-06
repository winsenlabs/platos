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

import type {
  EnvelopeBinding,
  EnvelopeFormatVersion,
  SealedEnvelope,
} from "../../domain/envelope.js";
import type { RootKeyRingState } from "../../domain/key-ring.js";
import type { RootKeyVersion } from "../../domain/ids.js";
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
 * A legacy ciphertext, exactly as the column that holds it holds it.
 *
 * THERE IS NO `RootKeyHandle` HERE, AND THAT ABSENCE IS THE POINT. Formats 2 and
 * 3 carry no root key version — `domain/envelope.ts` records `versionedRootKey:
 * false` for both — so there is no version for a caller to name and no handle for
 * a ring to mint. The key that opens a legacy envelope is a single raw key the
 * INSTALLATION configured for that format, and the adapter is its sole custodian:
 * the domain never chooses it, never names it and cannot reach it, which is the
 * same custody rule `RootKeyHandle` enforces for the versioned ring by a
 * different mechanism.
 *
 * THERE IS NO `EnvelopeBinding` EITHER. Both legacy formats bind no context, and
 * inventing a binding for them would be a lie the tag check would not catch: an
 * envelope lifted from one row really does open in another under these formats.
 * That is exactly the defect the migration exists to end, and pretending
 * otherwise here would hide it.
 */
export interface LegacyOpenRequest {
  /** Which legacy shape the payload is. The discriminator, never inferred. */
  readonly formatVersion: EnvelopeFormatVersion;
  /** The column's value verbatim, still text, not yet decoded. */
  readonly payload: string;
}

/**
 * Authenticated encryption with associated data.
 *
 * The port owns randomness: `seal` produces the salt and the nonce, so no caller
 * can supply a reused one. `open` returns ONE undifferentiated failure for a
 * wrong key, a tampered tag, a tampered ciphertext and a relocated binding — the
 * extraction source's pure test pins exactly that collapse.
 */
export interface AeadCipher {
  seal(request: SealRequest): Promise<Result<SealedEnvelope>>;
  open(request: OpenRequest): Promise<Result<SecretMaterial>>;
  /**
   * Open a LEGACY envelope, for migration and for nothing else.
   *
   * WHY IT IS A THIRD METHOD ON THIS PORT RATHER THAN A FOURTH PORT. The keys
   * that open formats 2 and 3 are key material, and this adapter is already "the
   * ONE place in the repository that holds AES-256 root key bytes". A separate
   * port would put a second key custodian in the tree, and `dependencies.ts`
   * budgets this context at eight collaborators and already holds eight — so a
   * ninth would have forced the bundle over ADR M0.3 §6's hard limit to say
   * something the existing custodian can say.
   *
   * IT IS DELIBERATELY NOT A `formatVersion` PARAMETER ON `open`. `open` takes a
   * handle and a binding; a legacy envelope has neither, and widening `open` to
   * make both optional would make the ONE method that reads canonical envelopes
   * accept a request with no binding at all. The binding is what stops a
   * ciphertext moving between rows, so a nullable one is not a smaller version of
   * the guard — it is the guard removed for every caller.
   *
   * ITS FAILURES DO NOT COLLAPSE, and that is the difference from `open`. `open`
   * answers one undifferentiated failure because its caller may be probing the
   * vault. This one is reached only by an operator migrating a column, so it
   * answers `LEGACY_ENVELOPE_UNREADABLE` with a distinct reason per fault.
   */
  openLegacy(request: LegacyOpenRequest): Promise<Result<SecretMaterial>>;
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
