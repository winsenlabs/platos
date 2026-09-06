// The thirteenth adapter directory: `secrets`' THREE cryptography ports, behind
// one custodian.
//
// WHY THREE PORTS AND ONE DIRECTORY. `AeadCipher.seal` takes a `RootKeyHandle`
// that NAMES a version and carries nothing else — "opaque by construction: the
// adapter that minted it can resolve it to bytes, and nothing else can". Put the
// ring in one package and the cipher in another and that sentence stops being
// true: the cipher would need the bytes, so the ring would have to export key
// material across a package boundary, which is the disclosure the opaque handle
// exists to prevent. One custodian is what makes the handle resolvable exactly
// once.
//
// `Hasher` joins them for custody rather than for mechanism. It shares no code
// with the cipher — it is one-way and the cipher is not, which is why `crypto.ts`
// keeps them as separate ports "so a hash can never be mistaken for a reversible
// envelope" — but the cost parameter that decides how expensive an offline
// search against `Credential.secretHash` is belongs with the keys, not with the
// store that holds the digest.
//
// WHY IT IS SPREAD FLAT RATHER THAN CARRIED ON PROPERTIES. `state`/`handle`,
// `seal`/`open` and `hash`/`verify` are six names with no collision, so one
// interface extends all three ports and the composition root proves each binding
// against the adapter itself. That is the shape `providers`' and `files`' stores
// use, and it is available here for the same reason: nothing forces the
// indirection.

import type {
  AeadCipher,
  Hasher,
  KeyRing,
  Result,
  RootKeyHandle,
  RootKeyVersion,
} from "@platos/context-secrets/application/ports/index.js";

import { createEnvelopeCipher } from "./envelope-cipher.js";
import type { LegacyKeyInput } from "./legacy-envelope-reader.js";
import { createLegacyEnvelopeReader } from "./legacy-envelope-reader.js";
import type { RootKeyRingInput, RootKeyRingResolver } from "./root-key-ring.js";
import { createRootKeyRing } from "./root-key-ring.js";
import { createSecretHasher } from "./secret-hasher.js";

export interface KeyringEnvelopeAdapter extends KeyRing, AeadCipher, Hasher {
  readonly adapterName: "keyring-envelope";
}

/**
 * Build the adapter over an already-parsed ring.
 *
 * The parse is a SEPARATE step, and the separation is the point: a ring that
 * cannot be parsed is a configuration failure the process must refuse to start
 * on, not a runtime `Result` every later call re-discovers. `buildKeyringEnvelope`
 * below is the one-call form for a composition root that wants both.
 */
export function createKeyringEnvelopeAdapter(
  ring: RootKeyRingResolver,
  // WIN-259 M2.4. The LEGACY keys are a second, optional argument rather than a
  // second constructor, and they are optional because they SHOULD stop being
  // configured. An installation that has finished migrating drops them, and from
  // that day every `openLegacy` call answers `legacy_key_absent_for_format` — the
  // fail-closed default, reached by deleting configuration rather than by
  // shipping code. Defaulting to an empty ring is what makes that the default.
  //
  // They are NOT in `RootKeyRingInput`. A legacy key has no version, may never
  // seal, and must never be mintable as a `RootKeyHandle`; putting it in the ring
  // would make `seal` able to reach it, which is the one thing that must stay
  // impossible.
  legacy: LegacyKeyInput = { keys: {} },
): KeyringEnvelopeAdapter {
  const cipher = createEnvelopeCipher(ring);
  const legacyReader = createLegacyEnvelopeReader(legacy);
  const hasher = createSecretHasher();
  return {
    adapterName: "keyring-envelope",

    // `KeyRing.state` and `KeyRing.handle` are async because the port is: a ring
    // backed by a cloud key-management service answers over the network. This
    // implementation holds its keys in memory and answers synchronously, so the
    // promises are already-resolved — the ASYNC SHAPE is the port's, and keeping
    // it here is what lets an installation swap in a KMS-backed ring without a
    // single caller changing.
    async state() {
      return ring.state();
    },

    async handle(version: RootKeyVersion): Promise<Result<RootKeyHandle>> {
      return ring.mint(version);
    },

    seal: cipher.seal,
    open: cipher.open,
    openLegacy: legacyReader.openLegacy,
    hash: hasher.hash,
    verify: hasher.verify,
  };
}

/**
 * Parse a ring and build the adapter, or refuse with the parse failure.
 *
 * The legacy keys are NOT parsed here and NOT refused here, and the asymmetry is
 * deliberate. A malformed ROOT key ring is a configuration failure the process
 * must refuse to start on: nothing can be sealed or read without it. A malformed
 * LEGACY key blocks only migration of one legacy format, and a vault that refused
 * to boot over it would take a running installation down to protect an operation
 * nobody had asked it to perform yet. So it is judged per call, and answers
 * `legacy_key_is_not_32_bytes` to the operator who asked for the migration.
 */
export function buildKeyringEnvelope(
  input: RootKeyRingInput,
  legacy: LegacyKeyInput = { keys: {} },
): Result<KeyringEnvelopeAdapter> {
  const ring = createRootKeyRing(input);
  return ring.ok ? { ok: true, value: createKeyringEnvelopeAdapter(ring.value, legacy) } : ring;
}
