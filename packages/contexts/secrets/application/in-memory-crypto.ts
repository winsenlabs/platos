// In-memory implementations of every port this context drives.
//
// THIS IS WHY CRYPTOGRAPHY IS BEHIND A PORT. With these, a use case is invokable
// with nothing running: no database, no key management service, no entropy, no
// clock. Every rule the encryption boundary states — rotation, re-encryption,
// retirement, fail-closed reads — is exercisable and therefore provable.
//
// The fake cipher is a REAL authenticated-encryption analogue, not a stub that
// returns its input. It derives a keystream from the root key material AND the
// binding, and it produces a tag over both. So a wrong key, a relocated binding,
// a flipped ciphertext byte and a flipped tag byte all fail to open, exactly as
// AES-256-GCM would. A stub would have made every negative control vacuous.
//
// It is NOT cryptography. It is a test double with the right failure modes.

import { asIdentifier, err, ok } from "@platos/kernel";
import type { Clock, IdGenerator, Result, TransactionScope, Ulid, UnitOfWork, Uuid } from "@platos/kernel";

import { envelopeAad, envelopeKeyInfo } from "../domain/envelope.js";
import type { SealedEnvelope } from "../domain/envelope.js";
import { credentialUnavailable, invalidKeyRing, legacyEnvelopeUnreadable } from "../domain/errors.js";
import { requireLegacyEnvelopeShape, requireMigratableFormat } from "../domain/legacy-envelope.js";
import { rootKeyVersion } from "../domain/ids.js";
import type { RootKeyVersion } from "../domain/ids.js";
import { rootKeyRingState } from "../domain/key-ring.js";
import type { RootKeyRingState } from "../domain/key-ring.js";
import { secretMaterial } from "../domain/secret-material.js";
import type { SecretMaterial } from "../domain/secret-material.js";
import type {
  AeadCipher,
  Hasher,
  KeyRing,
  LegacyOpenRequest,
  OpenRequest,
  RootKeyHandle,
  SealRequest,
} from "./ports/index.js";

function version(value: number): RootKeyVersion {
  const parsed = rootKeyVersion(value);
  if (!parsed.ok) throw new RangeError(`not a root key version: ${value}`);
  return parsed.value;
}

/** FNV-1a, 32-bit. Deterministic, fast, and obviously not a hash function. */
function mix(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function stream(seed: string, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    bytes[index] = mix(`${seed}|${index}`) & 0xff;
  }
  return bytes;
}

export interface InMemoryKeyRing extends KeyRing {
  /** Add a version and make it the one that seals. */
  rotateTo(next: number): void;
  /** Take a version OUT of the ring. Envelopes under it become unreadable. */
  retireVersion(target: number): void;
  /** The fake key material for one version, for the cipher that shares this ring. */
  material(target: RootKeyVersion): string | null;
}

export function inMemoryKeyRing(activeVersion = 1, present: readonly number[] = [1]): InMemoryKeyRing {
  const versions = new Set<number>([...present, activeVersion]);
  let active = activeVersion;
  return {
    rotateTo(next) {
      versions.add(next);
      active = next;
    },
    retireVersion(target) {
      versions.delete(target);
    },
    material(target) {
      return versions.has(target) ? `root-key-material-${target}` : null;
    },
    async state(): Promise<Result<RootKeyRingState>> {
      const built = rootKeyRingState(
        version(active),
        [...versions].map(version),
      );
      return built.ok ? built : err(invalidKeyRing("active_version_absent_from_ring"));
    },
    async handle(target: RootKeyVersion): Promise<Result<RootKeyHandle>> {
      if (!versions.has(target)) return err(credentialUnavailable("root_key_absent"));
      return ok({ rootKeyVersion: target } as RootKeyHandle);
    },
  };
}

const TAG_BYTES = 16;
const SALT_BYTES = 32;
const NONCE_BYTES = 12;

function tagOf(keySeed: string, aad: string, plaintext: string): Uint8Array {
  return stream(`tag|${keySeed}|${aad}|${plaintext}`, TAG_BYTES);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  return left.every((byte, index) => byte === right[index]);
}

function xored(bytes: Uint8Array, keystream: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let index = 0; index < bytes.length; index += 1) {
    out[index] = (bytes[index] ?? 0) ^ (keystream[index] ?? 0);
  }
  return out;
}

function encodeUtf8(value: string): Uint8Array {
  return Uint8Array.from([...value].flatMap((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x80 ? [code] : [0xc0 | (code >> 6), 0x80 | (code & 0x3f)];
  }));
}

function decodeUtf8(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte < 0x80) {
      out += String.fromCodePoint(byte);
      continue;
    }
    const next = bytes[index + 1] ?? 0;
    out += String.fromCodePoint(((byte & 0x1f) << 6) | (next & 0x3f));
    index += 1;
  }
  return out;
}

export function inMemoryAeadCipher(ring: InMemoryKeyRing): AeadCipher {
  let counter = 0;
  return {
    async seal(request: SealRequest): Promise<Result<SealedEnvelope>> {
      const keyMaterial = ring.material(request.key.rootKeyVersion);
      if (keyMaterial === null) return err(credentialUnavailable("root_key_absent"));
      counter += 1;
      const salt = stream(`salt|${counter}`, SALT_BYTES);
      const nonce = stream(`nonce|${counter}`, NONCE_BYTES);
      const plaintext = request.plaintext.reveal();
      const keySeed = `${keyMaterial}|${envelopeKeyInfo(request.binding)}|${[...salt].join(",")}`;
      const aad = envelopeAad(request.binding);
      const body = encodeUtf8(plaintext);
      return ok({
        salt,
        nonce,
        ciphertext: xored(body, stream(`${keySeed}|${[...nonce].join(",")}`, body.length)),
        authTag: tagOf(keySeed, aad, plaintext),
      });
    },
    async open(request: OpenRequest): Promise<Result<SecretMaterial>> {
      const keyMaterial = ring.material(request.key.rootKeyVersion);
      if (keyMaterial === null) return err(credentialUnavailable("root_key_absent"));
      const { envelope } = request;
      const keySeed = `${keyMaterial}|${envelopeKeyInfo(request.binding)}|${[...envelope.salt].join(",")}`;
      const aad = envelopeAad(request.binding);
      const keystream = stream(`${keySeed}|${[...envelope.nonce].join(",")}`, envelope.ciphertext.length);
      const plaintext = decodeUtf8(xored(envelope.ciphertext, keystream));
      if (!sameBytes(envelope.authTag, tagOf(keySeed, aad, plaintext))) {
        return err(credentialUnavailable("envelope_open_failed"));
      }
      return ok(secretMaterial(plaintext));
    },

    // THE LEGACY DOUBLE IS A DOUBLE OF THE FORMAT, NOT OF THE CIPHER, AND THAT
    // IS THE HONEST LIMIT OF WHAT IT CAN PROVE.
    //
    // A legacy payload's plaintext is recoverable here only because this double
    // and `legacyPayload` below share a fake serialisation: the pair exists so
    // `migrate-legacy-envelope.ts`'s CONTROL FLOW — the grant, the convergence
    // branch, the revision, the audit row, the transaction — is exercisable with
    // nothing running. It says NOTHING about whether real format-2 and format-3
    // bytes open, and it must not be read as saying so.
    //
    // That claim is made where it can be falsified: `keyring-envelope`'s
    // `legacy-wire-vectors.ts` holds ciphertexts produced BY the two extraction
    // sources, and its suites open them with real AES-256-GCM. This double
    // deliberately reproduces the FORMAT rules — it routes the payload through
    // the same `requireMigratableFormat` and `requireLegacyEnvelopeShape` the
    // real adapter uses — so a widths change breaks both, and the one thing it
    // fakes is the primitive.
    async openLegacy(request: LegacyOpenRequest): Promise<Result<SecretMaterial>> {
      const format = requireMigratableFormat(request.formatVersion);
      if (!format.ok) return err(format.error);
      const parts = request.payload.split("|");
      if (parts.length !== 4 || parts[0] !== LEGACY_DOUBLE_PREFIX) {
        return err(legacyEnvelopeUnreadable("payload_is_not_base64"));
      }
      const [, declaredFormat, plaintext, tag] = parts;
      const shaped = requireLegacyEnvelopeShape(format.value, {
        nonce: stream(`legacy-nonce|${plaintext}`, format.value.nonceBytes),
        ciphertext: encodeUtf8(plaintext ?? ""),
        authTag: stream(`legacy-tag|${plaintext}`, TAG_BYTES),
      });
      if (!shaped.ok) return err(shaped.error);
      if (declaredFormat !== String(request.formatVersion)) {
        return err(legacyEnvelopeUnreadable("nonce_width_disagrees_with_format"));
      }
      if (tag !== legacyTag(plaintext ?? "")) {
        return err(legacyEnvelopeUnreadable("legacy_envelope_open_failed"));
      }
      return ok(secretMaterial(plaintext ?? ""));
    },
  };
}

/** The double's own serialisation marker. Nothing real ever writes this. */
const LEGACY_DOUBLE_PREFIX = "in-memory-legacy";

function legacyTag(plaintext: string): string {
  return mix(`legacy|${plaintext}`).toString(16);
}

/**
 * Build a payload `inMemoryAeadCipher.openLegacy` accepts.
 *
 * A test double needs a way to MINT its inputs as well as read them, and minting
 * them in each suite by hand is how two suites end up disagreeing about the
 * double's own shape.
 */
export function legacyPayload(formatVersion: number, plaintext: string): string {
  return [LEGACY_DOUBLE_PREFIX, String(formatVersion), plaintext, legacyTag(plaintext)].join("|");
}

export function inMemoryHasher(): Hasher {
  const digest = (value: SecretMaterial): string => `fnv1a:${mix(value.reveal()).toString(16)}`;
  return {
    async hash(value) {
      return ok(digest(value));
    },
    async verify(value, expected) {
      return ok(digest(value) === expected);
    },
  };
}

export interface InMemoryClock extends Clock {
  advance(milliseconds: number): void;
  set(instant: Date): void;
}

export function inMemoryClock(start = new Date("2026-01-01T00:00:00.000Z")): InMemoryClock {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (milliseconds) => {
      current += milliseconds;
    },
    set: (instant) => {
      current = instant.getTime();
    },
  };
}

export function inMemoryIdGenerator(prefix = "id"): IdGenerator {
  let counter = 0;
  return {
    uuid: () => {
      counter += 1;
      return asIdentifier<Uuid>(`${prefix}-uuid-${counter}`);
    },
    ulid: () => {
      counter += 1;
      return asIdentifier<Ulid>(`${prefix}-ulid-${counter}`);
    },
  };
}

/** Something the in-memory unit of work can snapshot and restore. */
export interface TransactionParticipant {
  snapshot(): void;
  restore(): void;
  discard(): void;
}

export interface InMemoryUnitOfWork extends UnitOfWork {
  readonly depth: () => number;
  readonly commits: () => number;
  readonly rollbacks: () => number;
}

/**
 * A unit of work that really rolls back.
 *
 * Nesting JOINS the outer transaction, which is what the kernel port specifies
 * and what `setEnvironmentVariable` relies on when it composes the credential use
 * cases inside its own transaction.
 */
export function inMemoryUnitOfWork(
  participants: readonly TransactionParticipant[] = [],
): InMemoryUnitOfWork {
  let current: TransactionScope | null = null;
  let depth = 0;
  let commits = 0;
  let rollbacks = 0;
  return {
    depth: () => depth,
    commits: () => commits,
    rollbacks: () => rollbacks,
    async run<Value>(work: (transaction: TransactionScope) => Promise<Value>): Promise<Value> {
      if (current !== null) {
        depth += 1;
        try {
          return await work(current);
        } finally {
          depth -= 1;
        }
      }
      const scope: TransactionScope = { transactionId: asIdentifier(`txn-${commits + rollbacks + 1}`) };
      current = scope;
      depth = 1;
      for (const participant of participants) participant.snapshot();
      try {
        const value = await work(scope);
        for (const participant of participants) participant.discard();
        commits += 1;
        return value;
      } catch (thrown) {
        for (const participant of participants) participant.restore();
        rollbacks += 1;
        throw thrown;
      } finally {
        current = null;
        depth = 0;
      }
    },
  };
}
