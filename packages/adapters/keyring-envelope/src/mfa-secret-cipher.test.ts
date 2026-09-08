// The MFA envelope: a fresh nonce every time, a tag that refuses, a rotation
// that keeps old secrets readable, and a legacy column that is REFUSED rather
// than silently mis-read.
//
// WHAT IS AND IS NOT A DIFFERENTIAL HERE, STATED UP FRONT.
//
// The canonical format this cipher writes is NEW. There is no oracle for it,
// because the extraction source never wrote a versioned, context-bound MFA
// envelope — it wrote format 2, a raw key and a dotted triple. So the round-trip
// cases below are round trips, and calling them a differential would be the
// overclaim this repository has a rule about.
//
// The one differential that IS available is on the READ side, and it is the case
// that matters most operationally: `refuses every format-2 column the extraction
// source produced`. Those payloads are `LEGACY_WIRE_VECTORS`, produced by
// executing `internal-packages/tenancy-database/src/auth.ts` — bytes this issue
// did not make and cannot move. They prove the claim `mfa-secret-cipher.ts`'s
// header makes: an installation with enrolled operators needs a migration, and
// this cipher does not pretend otherwise by quietly returning something.

import { describe, expect, it } from "vitest";

import { createKeyringEnvelopeAdapter } from "./adapter.js";
import { MfaEnvelopeError, createMfaSecretCipher, sealedUnderSameKeyVersion } from "./mfa-secret-cipher.js";
import { legacyVectorsOfFormat } from "./legacy-wire-vectors.js";
import { createRootKeyRing } from "./root-key-ring.js";
import type { RootKeyRingResolver } from "./root-key-ring.js";

const KEY_ONE = "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface";
const KEY_TWO = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/** The shape `beginTotpEnrollment` stores: a base32 TOTP shared secret. */
const SECRET = "JBSWY3DPEHPK3PXP";

function ringOf(activeVersion: number, keys: Record<string, string>): RootKeyRingResolver {
  const ring = createRootKeyRing({ activeVersion, keys });
  if (!ring.ok) throw new Error(`fixture ring did not parse: ${ring.error.code}`);
  return ring.value;
}

function refusalOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof MfaEnvelopeError) return error.reason;
    throw error;
  }
  throw new Error("expected a refusal and got a value");
}

/**
 * Flip one BYTE of a base64url field, by decoding it first.
 *
 * NOT by editing a character, which is the version this suite started with and
 * which quietly did nothing. A 16-byte tag is 22 base64url characters carrying
 * 132 bits, so the final character holds four meaningful bits and TWO that the
 * decoder discards: `A` -> `B` moves only a discarded bit, `Buffer.from` yields
 * the identical sixteen bytes, and the "tampered" envelope opens. The tag case
 * failed on it, and the salt and ciphertext cases PASSED on it — by luck, on
 * whichever character the encoder happened to end with. A test that is right for
 * an accidental reason is the shape this repository has a rule about, so the
 * mutation is applied where it is unambiguous: to the bytes.
 */
function tamper(sealed: string, field: number): string {
  const fields = sealed.split(".");
  const bytes = Buffer.from(fields[field] as string, "base64url");
  bytes[0] = (bytes[0] as number) ^ 0x01;
  fields[field] = bytes.toString("base64url");
  return fields.join(".");
}

describe("sealing", () => {
  const cipher = createMfaSecretCipher(ringOf(1, { "1": KEY_ONE }));

  it("round-trips the secret it was given", () => {
    expect(cipher.open(cipher.seal(SECRET))).toBe(SECRET);
  });

  it("round-trips a non-ASCII plaintext, which fixes the text encoding", () => {
    // `cipher.update(plaintext, "utf8")` and `.toString("utf8")` on the way back.
    // Every other case here is ASCII, where utf8 and latin1 agree byte for byte.
    const text = "éàü unicode + newline\nand a tab\t";
    expect(cipher.open(cipher.seal(text))).toBe(text);
  });

  it("round-trips the empty string rather than treating it as absent", () => {
    expect(cipher.open(cipher.seal(""))).toBe("");
  });

  it("produces DIFFERENT ciphertext for the same plaintext, twice", () => {
    // The fresh-nonce property, and the fresh-SALT property with it: a 12-byte
    // GCM nonce reused under one key is a total break, and here the derived key
    // is different too, so two envelopes never share a key at all.
    const first = cipher.seal(SECRET);
    const second = cipher.seal(SECRET);
    expect(first).not.toBe(second);

    const [, , firstSalt, firstNonce] = first.split(".");
    const [, , secondSalt, secondNonce] = second.split(".");
    expect(firstSalt).not.toBe(secondSalt);
    expect(firstNonce).not.toBe(secondNonce);

    // Both still open, and both still name the same key version — which is what
    // separates "a fresh nonce" from "the ring rotated between the two calls".
    expect(cipher.open(first)).toBe(SECRET);
    expect(cipher.open(second)).toBe(SECRET);
    expect(sealedUnderSameKeyVersion(first, second)).toBe(true);
  });

  it("writes the widths format 1's descriptor pins", () => {
    // 32-byte salt, 12-byte nonce, 16-byte GCM tag. Not asserted against a
    // constant this module owns: the numbers are `envelope.ts`'s format-1
    // descriptor, which lives in `packages/contexts/secrets` and is not edited
    // here, and GCM's tag width is fixed by the mode.
    const fields = cipher.seal(SECRET).split(".");
    expect(Buffer.from(fields[2] as string, "base64url")).toHaveLength(32);
    expect(Buffer.from(fields[3] as string, "base64url")).toHaveLength(12);
    expect(Buffer.from(fields[4] as string, "base64url")).toHaveLength(16);
  });

  it("names the ACTIVE version, and follows it when the ring rotates", () => {
    const rotated = createMfaSecretCipher(ringOf(2, { "1": KEY_ONE, "2": KEY_TWO }));
    expect(rotated.seal(SECRET).split(".")[1]).toBe("2");
    expect(cipher.seal(SECRET).split(".")[1]).toBe("1");
  });
});

describe("refusing", () => {
  const cipher = createMfaSecretCipher(ringOf(1, { "1": KEY_ONE }));

  it("refuses a tampered TAG rather than returning plaintext", () => {
    expect(refusalOf(() => cipher.open(tamper(cipher.seal(SECRET), 4)))).toBe(
      "mfa_envelope_failed_authentication",
    );
  });

  it("refuses a tampered CIPHERTEXT", () => {
    expect(refusalOf(() => cipher.open(tamper(cipher.seal(SECRET), 5)))).toBe(
      "mfa_envelope_failed_authentication",
    );
  });

  it("refuses a tampered SALT, which is what makes the salt authenticated in effect", () => {
    // The salt is not inside the AAD; it does not need to be. It is inside the
    // KEY DERIVATION, so moving it derives a key that never sealed this
    // envelope and the tag check fails. An implementation that derived from a
    // constant salt would pass every other case in this file and fail here.
    expect(refusalOf(() => cipher.open(tamper(cipher.seal(SECRET), 2)))).toBe(
      "mfa_envelope_failed_authentication",
    );
  });

  it("refuses a tampered NONCE", () => {
    expect(refusalOf(() => cipher.open(tamper(cipher.seal(SECRET), 3)))).toBe(
      "mfa_envelope_failed_authentication",
    );
  });

  it("refuses an envelope RE-LABELLED with another key version", () => {
    // Two keys in the ring, so version 2 resolves — the refusal is the tag, not
    // an absent key. The version is in the HKDF `info` and in the AAD, so
    // relabelling breaks the derivation and the associated data at once.
    const both = createMfaSecretCipher(ringOf(1, { "1": KEY_ONE, "2": KEY_TWO }));
    const sealed = both.seal(SECRET);
    const relabelled = ["mfa1", "2", ...sealed.split(".").slice(2)].join(".");
    expect(refusalOf(() => both.open(relabelled))).toBe("mfa_envelope_failed_authentication");
  });

  it("refuses when the sealing key has been ROTATED OUT of the ring", () => {
    // Fail-closed, and with its OWN reason: an operator who dropped a key from
    // the ring must be told that, not told the column is corrupt.
    const sealed = cipher.seal(SECRET);
    const withoutKeyOne = createMfaSecretCipher(ringOf(2, { "2": KEY_TWO }));
    expect(refusalOf(() => withoutKeyOne.open(sealed))).toBe("mfa_envelope_root_key_unavailable");
  });

  it("refuses a version that is not an integer literal", () => {
    const sealed = cipher.seal(SECRET);
    const padded = ["mfa1", " 1", ...sealed.split(".").slice(2)].join(".");
    expect(refusalOf(() => cipher.open(padded))).toBe(
      "mfa_envelope_root_key_version_is_not_an_integer_literal",
    );
  });

  it("refuses a payload with the wrong field count or the wrong marker", () => {
    const sealed = cipher.seal(SECRET);
    expect(refusalOf(() => cipher.open(sealed.split(".").slice(1).join(".")))).toBe(
      "mfa_envelope_is_not_a_canonical_payload",
    );
    expect(refusalOf(() => cipher.open(`mfa2.${sealed.split(".").slice(1).join(".")}`))).toBe(
      "mfa_envelope_is_not_a_canonical_payload",
    );
    expect(refusalOf(() => cipher.open(""))).toBe("mfa_envelope_is_not_a_canonical_payload");
  });

  it("refuses an envelope sealed under a DIFFERENT ring holding the same version", () => {
    // Same version number, different key bytes. Nothing in the payload says
    // which installation sealed it, so the only thing that can refuse this is
    // the tag — which is the point: the version is a label, the key is the
    // secret.
    const foreign = createMfaSecretCipher(ringOf(1, { "1": KEY_TWO }));
    expect(refusalOf(() => cipher.open(foreign.seal(SECRET)))).toBe(
      "mfa_envelope_failed_authentication",
    );
  });
});

describe("rotation", () => {
  it("keeps a secret sealed under v1 readable after v2 becomes active", () => {
    // THE ROTATION PROPERTY, end to end. The old key is RETAINED in the ring and
    // the new one is active: new enrolments seal under v2, and every operator
    // already enrolled under v1 keeps verifying. Without the version in the
    // payload this is impossible — which is precisely what format 2 could not
    // do, and precisely why this cipher does not write format 2.
    const before = createMfaSecretCipher(ringOf(1, { "1": KEY_ONE }));
    const sealedUnderOne = before.seal(SECRET);

    const after = createMfaSecretCipher(ringOf(2, { "1": KEY_ONE, "2": KEY_TWO }));
    expect(after.open(sealedUnderOne)).toBe(SECRET);

    const sealedUnderTwo = after.seal(SECRET);
    expect(sealedUnderTwo.split(".")[1]).toBe("2");
    expect(after.open(sealedUnderTwo)).toBe(SECRET);
    expect(sealedUnderSameKeyVersion(sealedUnderOne, sealedUnderTwo)).toBe(false);

    // And the old cipher still cannot read the new envelope, because v2 is not
    // in its ring. Rotation is not symmetric and this says so.
    expect(refusalOf(() => before.open(sealedUnderTwo))).toBe("mfa_envelope_root_key_unavailable");
  });
});

describe("the legacy columns the extraction source wrote", () => {
  const cipher = createMfaSecretCipher(ringOf(1, { "1": KEY_ONE }));

  /**
   * Refuse the format-2 vector NAMED here, and fail if the table lost it.
   *
   * NAMED `it()`s AND NOT A LOOP, for the reason `wire-compatibility.test.ts`
   * gives after this census refused ITS first draft: `it()` inside a `for` is a
   * construct `scripts/arch/test-case-census.mjs` cannot count, and a construct
   * it cannot count can silently lose a case. The lookup keeps the case joined
   * to the table — a deleted vector fails here rather than passing on an empty
   * iteration.
   */
  function expectRefused(name: string): void {
    const vector = legacyVectorsOfFormat(2).find((candidate) => candidate.name === name);
    expect(vector, `no format-2 vector named ${name}`).toBeDefined();
    // These payload bytes were produced by `encryptSecret` in
    // `internal-packages/tenancy-database/src/auth.ts`. They are what every
    // `OperatorMfaTotp.encryptedSecret` in a pre-V1 database holds.
    //
    // THE ASSERTION IS THE MIGRATION REQUIREMENT. `open` answers
    // `mfa_envelope_is_not_a_canonical_payload` — its own reason, not a tag
    // failure — so an installation that has not migrated learns exactly what is
    // wrong. The day this cipher gains a legacy read path, this case has to be
    // rewritten; it cannot quietly keep passing.
    expect(refusalOf(() => cipher.open(vector?.payload as string))).toBe(
      "mfa_envelope_is_not_a_canonical_payload",
    );
    expect(vector?.origin).toBe("internal-packages/tenancy-database/src/auth.ts");
  }

  it("refuses, rather than mis-reads, a TOTP secret as beginTotpEnrollment stores one", () => {
    expectRefused("format 2, a TOTP secret as `beginTotpEnrollment` stores one");
  });

  it("refuses, rather than mis-reads, a longer format-2 payload under a second key", () => {
    expectRefused("format 2, a longer payload under a second key");
  });

  it("refuses, rather than mis-reads, a non-ASCII format-2 payload under a third key", () => {
    expectRefused("format 2, non-ASCII plaintext under a third key");
  });

  it("has a case for every format-2 vector, so adding one cannot go unchecked", () => {
    expect(legacyVectorsOfFormat(2)).toHaveLength(3);
  });

  it("seals a shape no legacy reader could mistake for a legacy column", () => {
    // The converse direction, and it matters for a migration that runs both
    // readers over the same table: a canonical envelope must not be picked up by
    // the format-2 decoder. Format 2 is exactly three dot-separated fields; this
    // is six, and it starts with a marker base64url cannot produce.
    const sealed = cipher.seal(SECRET);
    expect(sealed.split(".")).toHaveLength(6);
    expect(sealed.startsWith("mfa1.")).toBe(true);
    for (const vector of legacyVectorsOfFormat(2)) {
      expect(vector.payload.split(".")).toHaveLength(3);
    }
  });
});

describe("the port on the adapter", () => {
  it("is reachable by name and is not the AeadCipher", () => {
    const adapter = createKeyringEnvelopeAdapter(ringOf(1, { "1": KEY_ONE }));
    expect(adapter.adapterName).toBe("keyring-envelope");
    expect(adapter.mfaSecrets.open(adapter.mfaSecrets.seal(SECRET))).toBe(SECRET);
    // `seal` on the adapter is `AeadCipher.seal` and takes a request object; the
    // MFA one takes a string. Two contracts, two names — which is why this port
    // is a property rather than spread flat with the other three.
    expect(adapter.seal).not.toBe(adapter.mfaSecrets.seal);
  });
});
