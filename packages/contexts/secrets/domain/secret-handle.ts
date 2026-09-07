// The SECRET REFERENCE — an opaque, environment-bound handle a caller may hold,
// store, queue and later exchange for material.
//
// -----------------------------------------------------------------------------
// WHY THIS EXISTS, AND WHAT IT REPLACES.
//
// Until this file, the only way to address a secret was to NAME IT BY VALUE:
// `readSecret({ name: "STRIPE_SECRET_KEY", provider: "stripe" })`. Three things
// follow from naming by value, and all three are why a reference is a different
// object rather than a nicer spelling of the same one:
//
//   1. A NAME IS GUESSABLE. Anything that can reach the vault with a runtime
//      grant can enumerate it, because the address space is the set of names an
//      operator chose. A reference is minted, not guessed: holding one is
//      evidence that somebody who could already see the credential's METADATA
//      issued it.
//   2. A NAME TRAVELS. "stripe/live-key" means the same thing in staging as in
//      production, so a payload carrying one is a payload that resolves in the
//      wrong place. A reference is sealed to ONE environment and is bytes
//      without meaning anywhere else.
//   3. A NAME DOES NOT PIN A REVISION. A name resolves to whatever is active
//      when it is read, so a rotation silently changes what a queued job will
//      get. A reference pins the revision it was issued against and STOPS
//      RESOLVING when that revision is superseded.
//
// -----------------------------------------------------------------------------
// WHAT A REFERENCE IS, MECHANICALLY.
//
// It is an AEAD envelope over its own claims, sealed under the root key ring
// this context already owns, with the ENVIRONMENT inside the additional
// authenticated data. That single choice is what makes every property above a
// mechanism rather than a comparison:
//
//   * OPAQUE — the wire form is a scheme label, a root key version and four
//     base64url fields. The credential it names is inside the ciphertext. A
//     holder cannot read which credential, which revision, or which name.
//   * ENVIRONMENT-BOUND CRYPTOGRAPHICALLY — the environment is in the key
//     derivation info AND in the AAD. Presenting a reference under another
//     environment's grant does not fail an `if`; it fails to DECRYPT. There is
//     no comparison to forget to write and no branch to invert.
//   * UNFORGEABLE — minting one requires the root key. A caller who understands
//     the format perfectly still cannot produce a reference that opens.
//   * NOT REVERSIBLE INTO MATERIAL — the sealed body carries an identifier, an
//     issue time, an expiry and a revision. It has never carried plaintext, so
//     there is no key that turns a reference into a secret. Exchange still
//     requires a RUNTIME grant for the same environment and still goes to the
//     database for the envelope.
//
// The label below is a DOMAIN SEPARATOR against domain/envelope.ts. A credential
// envelope and a reference are both AES-GCM under the same ring, and without
// distinct labels a stolen credential ciphertext could be presented as a
// reference (or the reverse). The two label spaces never overlap.
//
// NOTHING HERE IMPORTS A RUNTIME MODULE. The base64url codec is written out
// rather than delegated to `Buffer`, because ADR M0.3 §2 keeps `domain/` free of
// frameworks and `node:buffer` is one.

import { err, ok } from "@platos/kernel";
import type { Branded, EnvironmentId, Result } from "@platos/kernel";

import { credentialUnavailable } from "./errors.js";
import { asSecretsIdentifier } from "./ids.js";
import type { CredentialId, RootKeyVersion, SecretRevision } from "./ids.js";

/**
 * The wire form. A branded STRING on purpose, and this is the one place where a
 * secrets value is deliberately serialisable.
 *
 * `SecretMaterial` next door refuses to be JSON, string-coerced, spread or
 * enumerated, because a plaintext that reaches a log is a leak. A reference is
 * the opposite obligation: it exists to be put in a queue message, a job
 * payload, a configuration row — the places plaintext must never go. Making it
 * a string is what lets a caller stop carrying the secret at all.
 */
export type SecretHandle = Branded<string, "SecretHandle">;

/** The scheme label. Version 1; a second one would be a new literal, not an edit. */
export const SECRET_HANDLE_SCHEME = "psh1";

/** Field count of the wire form: scheme, root key version, salt, nonce, ciphertext, tag. */
export const SECRET_HANDLE_FIELDS = 6;

/**
 * What a reference is sealed to. The environment is the ONLY tenancy coordinate
 * here, and that is the point: a reference is meaningless outside its
 * environment because the environment is the key derivation info and the AAD,
 * not because a use case remembers to compare it.
 */
export interface SecretHandleBinding {
  readonly environmentId: EnvironmentId;
  readonly rootKeyVersion: RootKeyVersion;
}

/** What the sealed body says. Never material — an address and two instants. */
export interface SecretHandleClaims {
  /** Distinguishes two references to the same revision, so audit can tell them apart. */
  readonly handleId: string;
  readonly credentialId: CredentialId;
  /** The revision that was active at issue. A rotation past it closes the reference. */
  readonly secretRevision: SecretRevision;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

// WIRE FORMAT. Pinned by a colocated test for the same reason
// domain/envelope.ts pins its own: a separator, an order or a character changed
// here makes every outstanding reference permanently unopenable, and unlike a
// stored envelope there is no row to migrate — the references are already out
// in callers' hands.
const HANDLE_DOMAIN = "platos:secret-handle:v1";
const FIELD_SEPARATOR = "\u0000";
const WIRE_SEPARATOR = ".";

function serializeBinding(binding: SecretHandleBinding): string {
  return [binding.environmentId, binding.rootKeyVersion].join(FIELD_SEPARATOR);
}

/** HKDF `info` for a reference's per-envelope key. */
export function secretHandleKeyInfo(binding: SecretHandleBinding): string {
  return `${HANDLE_DOMAIN}:key:${serializeBinding(binding)}`;
}

/** Additional authenticated data: what a reference's ciphertext is glued to. */
export function secretHandleAad(binding: SecretHandleBinding): string {
  return `${HANDLE_DOMAIN}:aad:${serializeBinding(binding)}`;
}

/** The sealed body, before encryption. NUL-separated, same discipline as the AAD. */
export function serializeHandleClaims(claims: SecretHandleClaims): string {
  return [
    claims.handleId,
    claims.credentialId,
    String(claims.secretRevision),
    String(claims.issuedAt.getTime()),
    String(claims.expiresAt.getTime()),
  ].join(FIELD_SEPARATOR);
}

function finiteInstant(value: string): Date | null {
  const milliseconds = Number(value);
  if (!Number.isSafeInteger(milliseconds)) return null;
  return new Date(milliseconds);
}

/**
 * Read a decrypted body back.
 *
 * Every failure here answers `handle_malformed`, and every failure here is
 * ALREADY past the authentication tag — so it means this context sealed a body
 * it cannot read, which is a defect, not an attack. It still fails closed.
 */
export function parseHandleClaims(body: string): Result<SecretHandleClaims> {
  const fields = body.split(FIELD_SEPARATOR);
  if (fields.length !== 5) return err(credentialUnavailable("handle_malformed"));
  const [handleId, credentialId, revision, issued, expires] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const secretRevision = Number(revision);
  if (!Number.isSafeInteger(secretRevision) || secretRevision <= 0) {
    return err(credentialUnavailable("handle_malformed"));
  }
  const issuedAt = finiteInstant(issued);
  const expiresAt = finiteInstant(expires);
  if (issuedAt === null || expiresAt === null || handleId.length === 0 || credentialId.length === 0) {
    return err(credentialUnavailable("handle_malformed"));
  }
  return ok({
    handleId,
    credentialId: asSecretsIdentifier<CredentialId>(credentialId),
    secretRevision: secretRevision as SecretRevision,
    issuedAt,
    expiresAt,
  });
}

// base64url, written out. `Buffer` is a runtime module and `btoa` is a global
// the domain has no business assuming, so the alphabet is here.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const packed = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    out += ALPHABET[(packed >> 18) & 63];
    out += ALPHABET[(packed >> 12) & 63];
    if (second === undefined) break;
    out += ALPHABET[(packed >> 6) & 63];
    if (third === undefined) break;
    out += ALPHABET[packed & 63];
  }
  return out;
}

export function decodeBase64Url(value: string): Uint8Array | null {
  const bits: number[] = [];
  for (const character of value) {
    const index = ALPHABET.indexOf(character);
    if (index < 0) return null;
    bits.push(index);
  }
  const bytes: number[] = [];
  for (let index = 0; index < bits.length; index += 4) {
    const quad = bits.slice(index, index + 4);
    const packed =
      ((quad[0] ?? 0) << 18) | ((quad[1] ?? 0) << 12) | ((quad[2] ?? 0) << 6) | (quad[3] ?? 0);
    bytes.push((packed >> 16) & 255);
    if (quad.length > 2) bytes.push((packed >> 8) & 255);
    if (quad.length > 3) bytes.push(packed & 255);
  }
  return Uint8Array.from(bytes);
}

/** The four sealed fields a reference carries, in the order the wire form uses. */
export interface SecretHandleEnvelope {
  readonly salt: Uint8Array;
  readonly nonce: Uint8Array;
  readonly ciphertext: Uint8Array;
  readonly authTag: Uint8Array;
}

/**
 * Render the wire form.
 *
 * The root key version rides in the CLEAR and that is deliberate. It is an
 * installation-wide counter — it names no tenant, no credential and no secret —
 * and the exchange has to know which key to reach for before it can open
 * anything. It is inside the AAD as well, so a holder who edits it produces a
 * reference that fails to open rather than one that opens under another key.
 */
export function encodeSecretHandle(
  binding: SecretHandleBinding,
  envelope: SecretHandleEnvelope,
): SecretHandle {
  return [
    SECRET_HANDLE_SCHEME,
    String(binding.rootKeyVersion),
    encodeBase64Url(envelope.salt),
    encodeBase64Url(envelope.nonce),
    encodeBase64Url(envelope.ciphertext),
    encodeBase64Url(envelope.authTag),
  ].join(WIRE_SEPARATOR) as SecretHandle;
}

/** What a parsed wire form yields: which key to ask for, and the bytes to open. */
export interface ParsedSecretHandle {
  readonly rootKeyVersion: RootKeyVersion;
  readonly envelope: SecretHandleEnvelope;
}

/**
 * Structural parse only. This says nothing about authenticity — a well-formed
 * reference invented by an attacker parses here and dies at the tag, which is
 * exactly the right place for it to die.
 */
export function decodeSecretHandle(value: unknown): Result<ParsedSecretHandle> {
  if (typeof value !== "string") return err(credentialUnavailable("handle_malformed"));
  const fields = value.split(WIRE_SEPARATOR);
  if (fields.length !== SECRET_HANDLE_FIELDS) {
    return err(credentialUnavailable("handle_malformed"));
  }
  const [scheme, version, salt, nonce, ciphertext, authTag] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (scheme !== SECRET_HANDLE_SCHEME) return err(credentialUnavailable("handle_malformed"));
  const rootKeyVersion = Number(version);
  if (!Number.isSafeInteger(rootKeyVersion) || rootKeyVersion <= 0) {
    return err(credentialUnavailable("handle_malformed"));
  }
  const parts = [salt, nonce, ciphertext, authTag].map(decodeBase64Url);
  if (parts.some((part) => part === null)) return err(credentialUnavailable("handle_malformed"));
  const [saltBytes, nonceBytes, ciphertextBytes, authTagBytes] = parts as [
    Uint8Array,
    Uint8Array,
    Uint8Array,
    Uint8Array,
  ];
  return ok({
    rootKeyVersion: rootKeyVersion as RootKeyVersion,
    envelope: {
      salt: saltBytes,
      nonce: nonceBytes,
      ciphertext: ciphertextBytes,
      authTag: authTagBytes,
    },
  });
}

/**
 * True when `now` is at or past the expiry.
 *
 * Inclusive at the boundary on purpose: a reference whose expiry is exactly now
 * is spent. The alternative leaves a one-millisecond window whose behaviour
 * depends on clock resolution, and a lifetime rule that depends on clock
 * resolution is not a rule.
 */
export function isHandleExpired(claims: SecretHandleClaims, now: Date): boolean {
  return now.getTime() >= claims.expiresAt.getTime();
}

/** The default lifetime, in milliseconds. Short: a reference is a ticket, not a key. */
export const DEFAULT_SECRET_HANDLE_LIFETIME_MS = 15 * 60 * 1000;

/** The longest lifetime this boundary will mint, whatever a caller asks for. */
export const MAX_SECRET_HANDLE_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * Judge a requested lifetime.
 *
 * A ceiling rather than a clamp. Silently shortening a caller's window makes a
 * reference expire earlier than the caller's own retry budget expects and turns
 * a configuration error into an intermittent one; refusing says which.
 */
export function requireHandleLifetime(milliseconds: number): Result<number> {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    return err(credentialUnavailable("handle_lifetime_invalid"));
  }
  if (milliseconds > MAX_SECRET_HANDLE_LIFETIME_MS) {
    return err(credentialUnavailable("handle_lifetime_invalid"));
  }
  return ok(milliseconds);
}
