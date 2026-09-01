// Root key ring state, and the rotation rules that hang off it.
//
// ADR M0.3 §1 row 3 makes this context the ONLY holder of data-encryption keys.
// The domain still never sees key BYTES: it sees which versions exist and which
// one is active, and the bytes stay behind the `KeyRing` port. That separation is
// what makes every rule below exercisable in memory.
//
// The extraction source loads the ring from `PLATOS_CREDENTIAL_ROOT_KEYS` and
// enforces a positive active version plus exact 32-byte keys. Both invariants are
// re-stated here as domain rules rather than as parsing accidents of one adapter.

import { err, ok } from "@platos/kernel";
import type { Result } from "@platos/kernel";

import { invalidKeyRing } from "./errors.js";
import type { RootKeyVersion } from "./ids.js";

/** Root keys are AES-256 keys. A ring holding any other width is not a ring. */
export const ROOT_KEY_BYTE_LENGTH = 32;

/**
 * What the ring can say about one version.
 *
 * `prior` is the interesting state: the version still opens envelopes, and every
 * envelope under it is owed a re-encryption onto the active version. `absent` is
 * the fail-closed state: the key is gone, so the envelope is gone with it, and
 * the answer is an error rather than the ciphertext.
 */
export type RootKeyStatus = "active" | "prior" | "absent";

export interface RootKeyRingState {
  readonly activeVersion: RootKeyVersion;
  /** Every version the ring can still open, including the active one. */
  readonly presentVersions: readonly RootKeyVersion[];
}

export function rootKeyRingState(
  activeVersion: RootKeyVersion,
  presentVersions: readonly RootKeyVersion[],
): Result<RootKeyRingState> {
  const present = [...new Set(presentVersions)].sort((left, right) => left - right);
  if (!present.includes(activeVersion)) {
    return err(invalidKeyRing("active_version_absent_from_ring"));
  }
  return ok(Object.freeze({ activeVersion, presentVersions: Object.freeze(present) }));
}

export function rootKeyStatus(ring: RootKeyRingState, version: RootKeyVersion): RootKeyStatus {
  if (version === ring.activeVersion) return "active";
  return ring.presentVersions.includes(version) ? "prior" : "absent";
}

/** Versions that still open envelopes but must no longer seal them. */
export function priorRootKeyVersions(ring: RootKeyRingState): readonly RootKeyVersion[] {
  return ring.presentVersions.filter((version) => version !== ring.activeVersion);
}

/**
 * Whether an envelope sealed under `version` is owed a re-encryption.
 *
 * Re-encryption is not a background nicety: while a prior version is still
 * referenced, the operator cannot remove that key, and the blast radius of its
 * compromise stays open.
 */
export function needsReEncryption(ring: RootKeyRingState, version: RootKeyVersion): boolean {
  return rootKeyStatus(ring, version) === "prior";
}

/**
 * A tally of unpurged envelopes per root key version — the operator's view of how
 * far a rotation has actually got.
 */
export interface RootKeyUsage {
  readonly rootKeyVersion: RootKeyVersion;
  readonly unpurgedVersionCount: number;
}

export interface RootKeyReport {
  readonly activeRootKeyVersion: RootKeyVersion;
  readonly usage: readonly RootKeyUsage[];
}

export function rootKeyReport(
  ring: RootKeyRingState,
  usage: readonly RootKeyUsage[],
): RootKeyReport {
  return Object.freeze({
    activeRootKeyVersion: ring.activeVersion,
    usage: Object.freeze([...usage].sort((left, right) => left.rootKeyVersion - right.rootKeyVersion)),
  });
}

/**
 * A root key may leave the ring only when it is not the active one AND nothing
 * unpurged still references it. Removing it earlier destroys readable material,
 * which is indistinguishable from data loss.
 */
export function canRemoveRootKey(report: RootKeyReport, version: RootKeyVersion): boolean {
  if (version === report.activeRootKeyVersion) return false;
  const entry = report.usage.find((row) => row.rootKeyVersion === version);
  return entry === undefined || entry.unpurgedVersionCount === 0;
}
