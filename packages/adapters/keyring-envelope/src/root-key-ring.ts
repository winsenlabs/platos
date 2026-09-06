// The versioned root key ring — the ONE place in the repository that holds
// AES-256 root key bytes.
//
// WHY THIS IS NOT IN `postgres-tenancy`. That package's own
// `secrets-repository.ts` refused this port and wrote down why: "putting it here
// would move the keys that decrypt every envelope into the process that holds the
// database connection, so a single credential leak would yield both halves. It
// belongs to a key-management adapter." This is that adapter, and the refusal is
// what makes ADR M0.3 §15's "one vendor client, one directory" amendment stop
// short of this one: a key ring is not the ORM's client.
//
// WHAT A HANDLE IS, AND WHY IT IS A WEAKMAP AND NOT A NUMBER.
// `secrets/application/ports/crypto.ts` says `RootKeyHandle` is "opaque by
// construction: the adapter that minted it can resolve it to bytes, and nothing
// else can". Its brand is a `unique symbol` that is DECLARED and never exported,
// so no caller can build one — but every caller can CAST one, and a cast
// `{ rootKeyVersion: 2 }` is structurally identical to a real handle. A ring that
// resolved handles by reading `handle.rootKeyVersion` would therefore honour a
// forged handle exactly as well as a minted one, and the opacity would be a
// comment rather than a property.
//
// So the bytes are keyed by IDENTITY. `resolve` looks the handle object up in a
// `WeakMap` this module owns; a forged handle is not in it and is refused. The
// map is weak so a handle a caller drops takes its entry with it, and holding a
// handle never keeps the process from collecting anything but the key it names —
// which the ring holds anyway.
//
// THE INVARIANTS ARE THE EXTRACTION SOURCE'S, RESTATED AS RESULTS.
// `internal-packages/tenancy-database/src/secrets.ts`'s `CredentialRootKeyRing`
// THROWS `invalid_key_ring` for a non-positive active version, a non-positive key
// version, a key that is not exactly 32 bytes, and an active version missing from
// the ring. A throw across a port boundary is a defect rather than an outcome
// (kernel `Result`), so each one is a refusal here — and each carries a DISTINCT
// `details.reason`, because a ring that fails to parse is an operator's problem
// and "which of the four" is the whole of the diagnosis.

import type { Result, RootKeyHandle, RootKeyRingState, RootKeyVersion } from "@platos/context-secrets/application/ports/index.js";
import {
  ROOT_KEY_BYTE_LENGTH,
  err,
  invalidKeyRing,
  ok,
  rootKeyRingState,
  rootKeyVersion,
} from "@platos/context-secrets/application/ports/index.js";

/**
 * Root key material as an installation supplies it.
 *
 * Hex, because that is what `PLATOS_CREDENTIAL_ROOT_KEYS` carries today and what
 * `CredentialRootKeyRing` accepts. The keys are a `Record` keyed by the version
 * as a string for the same reason: the environment variable is JSON, and JSON
 * object keys are strings.
 */
export interface RootKeyRingInput {
  readonly activeVersion: number;
  readonly keys: Readonly<Record<string, string>>;
}

/** Exactly 64 lowercase-or-uppercase hex characters: one AES-256 key. */
const HEX_ROOT_KEY = /^[0-9a-fA-F]{64}$/u;

export interface RootKeyRingResolver {
  /** Which versions exist and which one seals. */
  state(): Result<RootKeyRingState>;
  /** Mint a handle for one version, or refuse when the version has been rotated out. */
  mint(version: RootKeyVersion): Result<RootKeyHandle>;
  /**
   * The bytes behind a handle THIS ring minted.
   *
   * Refuses a handle it did not mint. That refusal is the fail-closed half of the
   * opacity property, and `root-key-ring.test.ts` forges a handle to prove it.
   */
  resolve(handle: RootKeyHandle): Result<Uint8Array>;
}

function parseVersion(raw: string): Result<RootKeyVersion> {
  // `Number("")` is 0 and `Number(" 1 ")` is 1, so the shape is checked before
  // the conversion. A ring keyed by " 1" and a ring keyed by "1" must not be the
  // same ring: one of them would seal under a version no envelope names.
  if (!/^[0-9]+$/u.test(raw)) return err(invalidKeyRing("root_key_version_not_an_integer_literal"));
  return rootKeyVersion(Number(raw));
}

function decodeHexKey(value: string): Result<Uint8Array> {
  if (!HEX_ROOT_KEY.test(value)) {
    return err(invalidKeyRing("root_key_not_32_hex_encoded_bytes"));
  }
  const bytes = new Uint8Array(ROOT_KEY_BYTE_LENGTH);
  for (let index = 0; index < ROOT_KEY_BYTE_LENGTH; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return ok(bytes);
}

/**
 * Build the ring, or refuse.
 *
 * The refusals are deliberately ordered so the FIRST thing checked is the thing
 * an operator most often gets wrong — a key of the wrong width, usually a
 * base64 secret pasted where hex was expected.
 */
export function createRootKeyRing(input: RootKeyRingInput): Result<RootKeyRingResolver> {
  const active = rootKeyVersion(input.activeVersion);
  if (!active.ok) return err(active.error);

  const material = new Map<RootKeyVersion, Uint8Array>();
  for (const [rawVersion, rawKey] of Object.entries(input.keys)) {
    const version = parseVersion(rawVersion);
    if (!version.ok) return err(version.error);
    const key = decodeHexKey(rawKey);
    if (!key.ok) return err(key.error);
    if (material.has(version.value)) return err(invalidKeyRing("root_key_version_declared_twice"));
    material.set(version.value, key.value);
  }
  if (material.size === 0) return err(invalidKeyRing("root_key_ring_empty"));

  // `rootKeyRingState` is the domain's own constructor and it carries the one
  // invariant this parser must not restate: the active version has to be present.
  // Restating it here would be a second opinion about the same rule, and the two
  // would drift.
  const state = rootKeyRingState(active.value, [...material.keys()]);
  if (!state.ok) return err(state.error);

  const minted = new WeakMap<object, Uint8Array>();

  return ok({
    state(): Result<RootKeyRingState> {
      return state;
    },
    mint(version: RootKeyVersion): Result<RootKeyHandle> {
      const key = material.get(version);
      // A version absent from the ring is the fail-closed case the encryption
      // boundary exists for. It is `invalidKeyRing` and not
      // `credentialUnavailable` because the CALLER is the vault, not a client:
      // `envelope-operations.ts` already maps this to the single stable
      // `credential unavailable` before any caller sees it, so collapsing it
      // here as well would only hide the reason from the operator's log.
      if (key === undefined) return err(invalidKeyRing("root_key_version_absent_from_ring"));
      const handle = Object.freeze({ rootKeyVersion: version }) as RootKeyHandle;
      minted.set(handle, key);
      return ok(handle);
    },
    resolve(handle: RootKeyHandle): Result<Uint8Array> {
      const key = minted.get(handle);
      if (key === undefined) return err(invalidKeyRing("root_key_handle_not_minted_by_this_ring"));
      // A minted handle whose `rootKeyVersion` no longer matches the material it
      // was minted with cannot happen through `mint`, and the check is here for
      // the case that can: a caller freezing its own object around a real key's
      // identity is impossible, but a future edit that reuses a handle across two
      // rings is not. The envelope binding names the version, so a mismatch would
      // seal under one key and derive under another.
      if (material.get(handle.rootKeyVersion) !== key) {
        return err(invalidKeyRing("root_key_handle_version_disagrees_with_material"));
      }
      return ok(key);
    },
  });
}
