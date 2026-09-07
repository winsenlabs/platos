// WIN-259 — the SECRET REFERENCE's wire form, its claims and its lifetime rule.
//
// The properties this file can prove are the STRUCTURAL ones: what the wire form
// looks like, what a body says, and when a reference is spent. It deliberately
// proves NOTHING about opacity or environment binding, because neither is a
// property of this file — both live in the cipher's key derivation and AAD, and
// asserting them here would have been the assertion-that-cannot-fail this
// project has already been bitten by. They are proved against a real cipher in
// application/secret-handles.test.ts and against real PostgreSQL rows in the
// adapter's integration suite.
//
// The labels are pinned for the reason domain/envelope.ts pins its own, only
// harder: a stored envelope whose label changes can at least be migrated row by
// row, and an outstanding reference cannot be migrated at all. It is already in
// somebody's queue.

import { describe, expect, it } from "vitest";
import { asIdentifier } from "@platos/kernel";
import type { EnvironmentId } from "@platos/kernel";

import { asSecretsIdentifier } from "./ids.js";
import type { CredentialId, RootKeyVersion, SecretRevision } from "./ids.js";
import {
  DEFAULT_SECRET_HANDLE_LIFETIME_MS,
  MAX_SECRET_HANDLE_LIFETIME_MS,
  SECRET_HANDLE_FIELDS,
  SECRET_HANDLE_SCHEME,
  decodeBase64Url,
  decodeSecretHandle,
  encodeBase64Url,
  encodeSecretHandle,
  isHandleExpired,
  parseHandleClaims,
  requireHandleLifetime,
  secretHandleAad,
  secretHandleKeyInfo,
  serializeHandleClaims,
} from "./secret-handle.js";
import type { SecretHandleBinding, SecretHandleClaims } from "./secret-handle.js";

const ENVIRONMENT = asIdentifier<EnvironmentId>("env-1");
const OTHER_ENVIRONMENT = asIdentifier<EnvironmentId>("env-2");

const binding: SecretHandleBinding = {
  environmentId: ENVIRONMENT,
  rootKeyVersion: 3 as RootKeyVersion,
};

const claims: SecretHandleClaims = {
  handleId: "handle-1",
  credentialId: asSecretsIdentifier<CredentialId>("cred-1"),
  secretRevision: 7 as SecretRevision,
  issuedAt: new Date("2026-01-01T00:00:00.000Z"),
  expiresAt: new Date("2026-01-01T00:15:00.000Z"),
};

const bytes = (values: readonly number[]): Uint8Array => Uint8Array.from(values);

// The field separator, spelled without an escape so no editor, formatter or
// copy-paste can silently turn it into a space. It is the SAME NUL that
// domain/envelope.ts uses, and pinning it here is what stops a well-meaning
// tidy-up of the separator from making every outstanding reference unopenable.
const NUL = String.fromCharCode(0);

describe("the labels a reference is sealed under", () => {
  it("separates the reference label space from the credential envelope's", () => {
    // The two must never collide, or a stolen credential ciphertext could be
    // presented as a reference. This asserts the reference's own domain word.
    expect(secretHandleKeyInfo(binding)).toContain("platos:secret-handle:v1:key:");
    expect(secretHandleAad(binding)).toContain("platos:secret-handle:v1:aad:");
    expect(secretHandleKeyInfo(binding)).not.toEqual(secretHandleAad(binding));
  });

  it("puts the ENVIRONMENT in both labels, which is what binds a reference to one", () => {
    expect(secretHandleKeyInfo(binding)).toContain(ENVIRONMENT);
    expect(secretHandleAad(binding)).toContain(ENVIRONMENT);
    const elsewhere = { ...binding, environmentId: OTHER_ENVIRONMENT };
    expect(secretHandleKeyInfo(elsewhere)).not.toEqual(secretHandleKeyInfo(binding));
    expect(secretHandleAad(elsewhere)).not.toEqual(secretHandleAad(binding));
  });

  it("puts the ROOT KEY VERSION in both, so an edited version fails to open", () => {
    const rotated = { ...binding, rootKeyVersion: 4 as RootKeyVersion };
    expect(secretHandleAad(rotated)).not.toEqual(secretHandleAad(binding));
  });

  it("pins both label strings byte for byte", () => {
    expect(secretHandleKeyInfo(binding)).toBe(`platos:secret-handle:v1:key:env-1${NUL}3`);
    expect(secretHandleAad(binding)).toBe(`platos:secret-handle:v1:aad:env-1${NUL}3`);
  });
});

describe("the claims body", () => {
  it("round-trips every field", () => {
    const parsed = parseHandleClaims(serializeHandleClaims(claims));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(claims);
  });

  it("pins the serialised body byte for byte", () => {
    expect(serializeHandleClaims(claims)).toBe(
      ["handle-1", "cred-1", "7", "1767225600000", "1767226500000"].join(NUL),
    );
  });

  it("carries NO name, NO provider and NO material — only an address", () => {
    const body = serializeHandleClaims(claims);
    expect(body).not.toContain("OPENAI");
    expect(body.split(NUL)).toHaveLength(5);
  });

  it("refuses a body with the wrong field count", () => {
    expect(parseHandleClaims(["a", "b", "c"].join(NUL)).ok).toBe(false);
  });

  it("refuses a revision that is not a positive integer", () => {
    const bad = ["handle-1", "cred-1", "0", "1", "2"].join(NUL);
    expect(parseHandleClaims(bad).ok).toBe(false);
    const worse = ["handle-1", "cred-1", "1.5", "1", "2"].join(NUL);
    expect(parseHandleClaims(worse).ok).toBe(false);
  });

  it("refuses an instant that is not a safe integer", () => {
    const bad = ["handle-1", "cred-1", "1", "not-a-time", "2"].join(NUL);
    expect(parseHandleClaims(bad).ok).toBe(false);
  });

  it("refuses an empty handle id or credential id", () => {
    expect(parseHandleClaims(["", "cred-1", "1", "1", "2"].join(NUL)).ok).toBe(false);
    expect(parseHandleClaims(["handle-1", "", "1", "1", "2"].join(NUL)).ok).toBe(false);
  });

  it("answers the same log-only reason for every malformed body", () => {
    const parsed = parseHandleClaims("nonsense");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe("CREDENTIAL_UNAVAILABLE");
    expect(parsed.error.details).toMatchObject({ reason: "handle_malformed" });
  });
});

describe("base64url", () => {
  it("round-trips every length modulo 3", () => {
    for (let length = 0; length < 12; length += 1) {
      const input = bytes(Array.from({ length }, (_, index) => (index * 37 + 11) & 255));
      expect(decodeBase64Url(encodeBase64Url(input))).toEqual(input);
    }
  });

  it("uses the URL alphabet, so a reference survives a query string and a header", () => {
    const encoded = encodeBase64Url(bytes([251, 255, 190, 255]));
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
    expect(encoded).not.toContain("=");
  });

  it("refuses a character outside the alphabet", () => {
    expect(decodeBase64Url("ab*d")).toBeNull();
  });
});

describe("the wire form", () => {
  const envelope = {
    salt: bytes([1, 2, 3]),
    nonce: bytes([4, 5, 6]),
    ciphertext: bytes([7, 8, 9, 10]),
    authTag: bytes([11, 12]),
  };

  it("is the scheme, the root key version and four base64url fields", () => {
    const wire = encodeSecretHandle(binding, envelope);
    const fields = wire.split(".");
    expect(fields).toHaveLength(SECRET_HANDLE_FIELDS);
    expect(fields[0]).toBe(SECRET_HANDLE_SCHEME);
    expect(fields[1]).toBe("3");
  });

  it("names NO environment, NO credential and NO revision in the clear", () => {
    const wire = encodeSecretHandle(binding, envelope);
    expect(wire).not.toContain(ENVIRONMENT);
    expect(wire).not.toContain("cred-1");
  });

  it("round-trips the four sealed fields", () => {
    const parsed = decodeSecretHandle(encodeSecretHandle(binding, envelope));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.rootKeyVersion).toBe(3);
    expect(parsed.value.envelope).toEqual(envelope);
  });

  it("refuses a value that is not a string at all", () => {
    expect(decodeSecretHandle(undefined).ok).toBe(false);
    expect(decodeSecretHandle({ handle: "psh1.1.a.b.c.d" }).ok).toBe(false);
  });

  it("refuses another scheme, which is how a future format stays distinguishable", () => {
    const wire = encodeSecretHandle(binding, envelope);
    expect(decodeSecretHandle(wire.replace("psh1", "psh2")).ok).toBe(false);
  });

  it("refuses the wrong field count in either direction", () => {
    expect(decodeSecretHandle("psh1.1.a.b.c").ok).toBe(false);
    expect(decodeSecretHandle("psh1.1.a.b.c.d.e").ok).toBe(false);
  });

  it("refuses a root key version that is not a positive integer", () => {
    expect(decodeSecretHandle("psh1.0.a.b.c.d").ok).toBe(false);
    expect(decodeSecretHandle("psh1.-1.a.b.c.d").ok).toBe(false);
    expect(decodeSecretHandle("psh1.x.a.b.c.d").ok).toBe(false);
  });

  it("refuses a field that is not base64url", () => {
    expect(decodeSecretHandle("psh1.1.a.b.c.*").ok).toBe(false);
  });
});

describe("the lifetime rule", () => {
  it("is spent AT the expiry, not after it", () => {
    expect(isHandleExpired(claims, new Date("2026-01-01T00:14:59.999Z"))).toBe(false);
    expect(isHandleExpired(claims, claims.expiresAt)).toBe(true);
    expect(isHandleExpired(claims, new Date("2026-01-01T00:15:00.001Z"))).toBe(true);
  });

  it("defaults short and ceilings at a day", () => {
    expect(DEFAULT_SECRET_HANDLE_LIFETIME_MS).toBe(900_000);
    expect(MAX_SECRET_HANDLE_LIFETIME_MS).toBe(86_400_000);
    expect(requireHandleLifetime(DEFAULT_SECRET_HANDLE_LIFETIME_MS).ok).toBe(true);
    expect(requireHandleLifetime(MAX_SECRET_HANDLE_LIFETIME_MS).ok).toBe(true);
  });

  it("REFUSES rather than clamps a lifetime past the ceiling", () => {
    const refused = requireHandleLifetime(MAX_SECRET_HANDLE_LIFETIME_MS + 1);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.details).toMatchObject({ reason: "handle_lifetime_invalid" });
  });

  it("refuses a zero, a negative and a fractional lifetime", () => {
    expect(requireHandleLifetime(0).ok).toBe(false);
    expect(requireHandleLifetime(-1).ok).toBe(false);
    expect(requireHandleLifetime(1.5).ok).toBe(false);
  });
});
