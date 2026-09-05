// The row readers and the write guards, without a database.
//
// TWO THINGS ARE PROVED HERE AND NOWHERE ELSE. The readers turn three columns
// into CLOSED unions and must refuse a fourth value by name rather than by
// letting it through as a number or a string — a case that needs no PostgreSQL
// because the value it is given is one an older binary would read out of a newer
// database, and no live database can produce it on demand. And each guard is
// exercised on both sides of its boundary, so a predicate that was quietly
// inverted fails here rather than in a container.
//
// THE INTEGRATION SUITE DOES NOT SUBSUME THIS. `secrets-constraints.integration
// .test.ts` proves each guard AGREES WITH ITS CONSTRAINT; this proves the guard
// says yes to the values either side of the line. Both are needed: a guard that
// refused everything would satisfy the first and fail here.

import { describe, expect, test } from "vitest";

import {
  AUDIT_ORDINAL_OUT_OF_RANGE,
  ENVELOPE_AUTH_TAG_BYTES,
  ENVELOPE_BYTES_MISWIDTH,
  ENVELOPE_NONCE_BYTES,
  ENVELOPE_ORDINAL_OUT_OF_RANGE,
  ENVELOPE_SALT_BYTES,
  IDENTIFIER_NOT_UUID,
  INSTANT_NOT_REPRESENTABLE,
  PURGE_LIMIT_INVALID,
  SecretsWriteRefused,
  VARIABLE_KEY_INVALID,
  VARIABLE_SHAPE_INCOHERENT,
  VARIABLE_VALUE_MAX_LENGTH,
  VARIABLE_VALUE_TOO_LONG,
  requireAuditOrdinal,
  requireEnvelopeBytes,
  requireEnvelopeOrdinal,
  requireInstant,
  requireInstantOrNull,
  requirePurgeLimit,
  requireUuid,
  requireUuidOrNull,
  requireVariableKey,
  requireVariableShape,
} from "./secrets-guards.js";
import {
  UNKNOWN_CREDENTIAL_KIND,
  UNKNOWN_ENVELOPE_FORMAT,
  UNKNOWN_VARIABLE_KIND,
  UnreadableSecretsRowError,
  readCredential,
  readCredentialKind,
  readEnvelopeFormat,
  readRootKeyUsage,
  readSecretVersion,
  readVariable,
  readVariableKind,
} from "./secrets-rows.js";

const AT = new Date("2026-05-01T09:00:00.000Z");
const UUID = "5ec06666-0001-4000-8000-000000000001";
const OTHER = "5ec06666-0002-4000-8000-000000000002";

/** The refusal code a thrown guard carries, or a marker naming what arrived. */
function refusalOf(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof SecretsWriteRefused || error instanceof UnreadableSecretsRowError) {
      return error.code;
    }
    return `<uncoded:${String(error)}>`;
  }
  return "<no refusal>";
}

function credentialRow(overrides: Record<string, unknown> = {}): never {
  return {
    id: UUID,
    environmentId: OTHER,
    activeSecretVersionId: null,
    kind: "SECRET_REFERENCE",
    name: "ALPHA_KEY",
    prefix: null,
    secretHash: null,
    encryptedReference: null,
    permissions: [],
    allowedOrigins: [],
    provider: null,
    externalClientId: null,
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    createdBy: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  } as never;
}

function versionRow(overrides: Record<string, unknown> = {}): never {
  return {
    id: UUID,
    credentialId: OTHER,
    secretRevision: 1,
    formatVersion: 1,
    rootKeyVersion: 1,
    salt: new Uint8Array(ENVELOPE_SALT_BYTES).fill(1),
    nonce: new Uint8Array(ENVELOPE_NONCE_BYTES).fill(2),
    ciphertext: new Uint8Array(8).fill(3),
    authTag: new Uint8Array(ENVELOPE_AUTH_TAG_BYTES).fill(4),
    retiredAt: null,
    readableUntil: null,
    createdAt: AT,
    ...overrides,
  } as never;
}

describe("the three closed unions a row is read back through", () => {
  test("every declared member is readable and a fourth value is refused by name", () => {
    for (const kind of ["SECRET_REFERENCE", "CHANNEL_SECRET", "ENTITY_SECRET", "SERVICE_CREDENTIAL"]) {
      expect(readCredentialKind(kind)).toBe(kind);
    }
    expect(refusalOf(() => readCredentialKind("ROOT_KEY"))).toBe(UNKNOWN_CREDENTIAL_KIND);
    for (const kind of ["PLAIN", "SECRET"]) expect(readVariableKind(kind)).toBe(kind);
    expect(refusalOf(() => readVariableKind("ENCRYPTED"))).toBe(UNKNOWN_VARIABLE_KIND);
    for (const format of [1, 2, 3]) expect(readEnvelopeFormat(format)).toBe(format);
    expect(refusalOf(() => readEnvelopeFormat(4))).toBe(UNKNOWN_ENVELOPE_FORMAT);
    // ZERO is refused too, and it is the value a column default would produce.
    expect(refusalOf(() => readEnvelopeFormat(0))).toBe(UNKNOWN_ENVELOPE_FORMAT);
  });

  test("the refusal names the column and the value, so a mismatch is diagnosable", () => {
    try {
      readEnvelopeFormat(9);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnreadableSecretsRowError);
      expect(error).toMatchObject({
        column: "CredentialSecretVersion.formatVersion",
        value: "9",
      });
    }
  });
});

describe("the readers carry every column the domain declares", () => {
  test("a credential keeps its two transitional columns rather than losing them", () => {
    // `TransitionalCredentialFields` marks both DEPRECATED and not absent, and
    // WIN-259 has to be able to see them to retire them.
    const read = readCredential(
      credentialRow({ secretHash: "digest", encryptedReference: "iv.tag.ct" }),
    );
    expect(read).toMatchObject({ secretHash: "digest", encryptedReference: "iv.tag.ct" });
  });

  test("an envelope's bytes are COPIED rather than aliased", () => {
    const row = versionRow();
    const read = readSecretVersion(row);
    const source = (row as unknown as { salt: Uint8Array }).salt;
    source[0] = 0xff;
    // The driver may hand back a view over a buffer it reuses. A store that
    // aliased it would return an envelope whose bytes changed under the caller.
    expect(read.salt[0]).toBe(1);
  });

  test("the arrays on a credential are copied too", () => {
    const permissions = ["read"];
    const read = readCredential(credentialRow({ permissions }));
    permissions.push("write");
    expect(read.permissions).toEqual(["read"]);
  });

  test("a variable reads back both of its mutually exclusive halves", () => {
    const plain = readVariable({
      id: UUID,
      environmentId: OTHER,
      key: "ALPHA",
      kind: "PLAIN",
      value: "one",
      credentialId: null,
      version: 3,
      lastUpdatedBy: "operator-1",
      createdAt: AT,
      updatedAt: AT,
    } as never);
    expect(plain).toMatchObject({ value: "one", credentialId: null, version: 3 });
    const secret = readVariable({
      id: UUID,
      environmentId: OTHER,
      key: "BRAVO",
      kind: "SECRET",
      value: null,
      credentialId: UUID,
      version: 1,
      lastUpdatedBy: null,
      createdAt: AT,
      updatedAt: AT,
    } as never);
    expect(secret).toMatchObject({ value: null, credentialId: UUID });
  });

  test("root-key usage is read WITHOUT a sort, because the domain sorts it", () => {
    expect(readRootKeyUsage({ rootKeyVersion: 4, unpurgedVersionCount: 7 })).toEqual({
      rootKeyVersion: 4,
      unpurgedVersionCount: 7,
    });
  });
});

describe("the uuid guard", () => {
  test("accepts the canonical form in either case and refuses every other spelling", () => {
    expect(requireUuid("Credential.id", UUID)).toBe(UUID);
    expect(requireUuid("Credential.id", UUID.toUpperCase())).toBe(UUID.toUpperCase());
    expect(requireUuidOrNull("Credential.activeSecretVersionId", null)).toBeNull();
    for (const bad of [
      "credential-1",
      `{${UUID}}`,
      `urn:uuid:${UUID}`,
      UUID.slice(0, -1),
      `${UUID}0`,
      "",
    ]) {
      expect(refusalOf(() => requireUuid("Credential.id", bad))).toBe(IDENTIFIER_NOT_UUID);
    }
  });
});

describe("the two ordinal guards, which are deliberately different", () => {
  test("an envelope ordinal must be positive and inside INTEGER", () => {
    expect(requireEnvelopeOrdinal("x", 1)).toBe(1);
    expect(requireEnvelopeOrdinal("x", 2_147_483_647)).toBe(2_147_483_647);
    for (const bad of [0, -1, 1.5, Number.NaN, 2_147_483_648]) {
      expect(refusalOf(() => requireEnvelopeOrdinal("x", bad))).toBe(ENVELOPE_ORDINAL_OUT_OF_RANGE);
    }
  });

  test("an audit ordinal admits zero and negatives, because no CHECK forbids them", () => {
    // THE ASYMMETRY IS THE POINT. `CredentialSecretVersion` carries three `> 0`
    // CHECKs and `CredentialAudit` carries none, so a shared guard would be
    // stricter than the database on one of the two tables.
    expect(requireAuditOrdinal("x", 0)).toBe(0);
    expect(requireAuditOrdinal("x", -1)).toBe(-1);
    expect(requireAuditOrdinal("x", null)).toBeNull();
    for (const bad of [2_147_483_648, -2_147_483_649, 1.5]) {
      expect(refusalOf(() => requireAuditOrdinal("x", bad))).toBe(AUDIT_ORDINAL_OUT_OF_RANGE);
    }
  });
});

describe("the envelope width guard", () => {
  test("each width is an EQUALITY, so short and long are the same refusal", () => {
    for (const width of [ENVELOPE_SALT_BYTES, ENVELOPE_NONCE_BYTES, ENVELOPE_AUTH_TAG_BYTES]) {
      expect(requireEnvelopeBytes("x", new Uint8Array(width), width)).toHaveLength(width);
      expect(refusalOf(() => requireEnvelopeBytes("x", new Uint8Array(width - 1), width))).toBe(
        ENVELOPE_BYTES_MISWIDTH,
      );
      expect(refusalOf(() => requireEnvelopeBytes("x", new Uint8Array(width + 1), width))).toBe(
        ENVELOPE_BYTES_MISWIDTH,
      );
    }
    expect(
      refusalOf(() => requireEnvelopeBytes("x", "not bytes" as never, ENVELOPE_SALT_BYTES)),
    ).toBe(ENVELOPE_BYTES_MISWIDTH);
  });

  test("the three widths are 32, 12 and 16, exactly as the migration spells them", () => {
    expect([ENVELOPE_SALT_BYTES, ENVELOPE_NONCE_BYTES, ENVELOPE_AUTH_TAG_BYTES]).toEqual([32, 12, 16]);
  });
});

describe("the environment variable guards", () => {
  test("the key pattern is the migration's, character for character", () => {
    for (const good of ["A", "API_KEY", "A".repeat(64), "A0_9"]) {
      expect(requireVariableKey(good)).toBe(good);
    }
    for (const bad of ["", "a", "0A", "_A", "A".repeat(65), "API-KEY", "API KEY", "APÍ"]) {
      expect(refusalOf(() => requireVariableKey(bad))).toBe(VARIABLE_KEY_INVALID);
    }
  });

  test("the shape has exactly two legal states and no third", () => {
    expect(() => requireVariableShape("PLAIN", "one", null)).not.toThrow();
    expect(() => requireVariableShape("SECRET", null, UUID)).not.toThrow();
    for (const [kind, value, credential] of [
      ["PLAIN", null, null],
      ["PLAIN", "one", UUID],
      ["SECRET", "one", UUID],
      ["SECRET", null, null],
      ["SECRET", "one", null],
      ["OTHER", "one", null],
    ] as const) {
      expect(refusalOf(() => requireVariableShape(kind, value, credential))).toBe(
        VARIABLE_SHAPE_INCOHERENT,
      );
    }
  });

  test("the length bound is the column's, and the boundary value is legal", () => {
    expect(() =>
      requireVariableShape("PLAIN", "x".repeat(VARIABLE_VALUE_MAX_LENGTH), null),
    ).not.toThrow();
    expect(
      refusalOf(() =>
        requireVariableShape("PLAIN", "x".repeat(VARIABLE_VALUE_MAX_LENGTH + 1), null),
      ),
    ).toBe(VARIABLE_VALUE_TOO_LONG);
    expect(VARIABLE_VALUE_MAX_LENGTH).toBe(8192);
  });
});

describe("the two guards that stand where no constraint does", () => {
  test("a purge bound must be a positive whole number", () => {
    expect(requirePurgeLimit(1)).toBe(1);
    expect(requirePurgeLimit(100)).toBe(100);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(refusalOf(() => requirePurgeLimit(bad))).toBe(PURGE_LIMIT_INVALID);
    }
  });

  test("an instant must be finite, and the nullable form still admits null", () => {
    expect(requireInstant("x", AT)).toBe(AT);
    expect(requireInstantOrNull("x", null)).toBeNull();
    expect(requireInstantOrNull("x", AT)).toBe(AT);
    expect(refusalOf(() => requireInstant("x", new Date("nonsense")))).toBe(
      INSTANT_NOT_REPRESENTABLE,
    );
    expect(refusalOf(() => requireInstant("x", "2026-05-01" as never))).toBe(
      INSTANT_NOT_REPRESENTABLE,
    );
    expect(refusalOf(() => requireInstantOrNull("x", new Date(Number.NaN)))).toBe(
      INSTANT_NOT_REPRESENTABLE,
    );
  });
});

describe("the refusal codes are distinct", () => {
  test("nine guards, nine codes, and three unreadable-row codes beside them", () => {
    const codes = [
      IDENTIFIER_NOT_UUID,
      ENVELOPE_ORDINAL_OUT_OF_RANGE,
      ENVELOPE_BYTES_MISWIDTH,
      AUDIT_ORDINAL_OUT_OF_RANGE,
      VARIABLE_KEY_INVALID,
      VARIABLE_SHAPE_INCOHERENT,
      VARIABLE_VALUE_TOO_LONG,
      PURGE_LIMIT_INVALID,
      INSTANT_NOT_REPRESENTABLE,
      UNKNOWN_CREDENTIAL_KIND,
      UNKNOWN_VARIABLE_KIND,
      UNKNOWN_ENVELOPE_FORMAT,
    ];
    // TWO GUARDS SHARING A CODE CANNOT BE TOLD APART IN A LOG, which is how two
    // defects hid behind one code in `privacy` and in `identity-access`.
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes.every((code) => code.startsWith("secrets."))).toBe(true);
  });
});
