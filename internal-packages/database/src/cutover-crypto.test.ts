import { createCipheriv } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, test } from "vitest";
import {
  assertSecretFreeCutoverEvidence,
  convertLegacyTotpSecretToBase32,
  CutoverCryptoError,
  decodeBase32TotpSecret,
  decodeLegacyJsonMessage,
  decodeLegacyPlatosSecret,
  decodeLegacySecretStoreJson,
  decodeVersionedLegacyMessage,
  serializeAggregateCredentialPayload,
  validateSha256Hex,
} from "./cutover-crypto";
import { aggregateCredentialPayloadContracts } from "./cutover-ledger";

const webKeyHex = Buffer.alloc(32, 0x21).toString("hex");
const platosKeyHex = Buffer.alloc(32, 0x32).toString("hex");
const messageKeyHex = Buffer.alloc(32, 0x43).toString("hex");
const messageKeys = Object.freeze({ 7: messageKeyHex });

function encryptHexJson(value: unknown, keyInput = webKeyHex) {
  const key = /^[0-9a-f]{64}$/i.test(keyInput)
    ? Buffer.from(keyInput, "hex")
    : Buffer.from(keyInput, "utf8");
  const nonce = Buffer.alloc(12, 0x54);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    nonce: nonce.toString("hex"),
    ciphertext: ciphertext.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
  };
}

function encryptPacked(value: string, keyHex = platosKeyHex): string {
  const iv = Buffer.alloc(16, 0x65);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyHex, "hex"), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

function encryptMessageJson(value: unknown): Readonly<{
  __platos_enc: 1;
  v: 7;
  ct: string;
}> {
  return Object.freeze({
    __platos_enc: 1,
    v: 7,
    ct: encryptPacked(JSON.stringify(value), messageKeyHex),
  });
}

function expectCode(action: () => unknown, code: CutoverCryptoError["code"]): void {
  expect(action).toThrowError(expect.objectContaining({ name: "CutoverCryptoError", code }));
}

describe("cutover-only legacy crypto foundations", () => {
  test("decodes only SecretStore v1 plaintext JSON and v2 authenticated hex JSON", () => {
    const sourceJson = { kind: "unit-vector", nested: [true, 4, null] };
    expect(decodeLegacySecretStoreJson({ version: "1", value: sourceJson }, webKeyHex)).toEqual(
      sourceJson
    );
    expect(
      decodeLegacySecretStoreJson(
        { version: "2", value: encryptHexJson(sourceJson) },
        webKeyHex
      )
    ).toEqual(sourceJson);

    const legacyUtf8Key = "k".repeat(32);
    expect(
      decodeLegacySecretStoreJson(
        { version: "2", value: encryptHexJson(sourceJson, legacyUtf8Key) },
        legacyUtf8Key
      )
    ).toEqual(sourceJson);
  });

  test("fails closed for unsupported SecretStore versions and malformed v2 envelopes", () => {
    const valid = encryptHexJson({ kind: "unit-vector" });
    expectCode(
      () => decodeLegacySecretStoreJson({ version: "3", value: valid }, webKeyHex),
      "unsupported_version"
    );
    expectCode(
      () => decodeLegacySecretStoreJson({ version: 1, value: {} }, webKeyHex),
      "unsupported_version"
    );
    expectCode(
      () =>
        decodeLegacySecretStoreJson(
          { version: "2", value: { ...valid, nonce: valid.nonce.slice(2) } },
          webKeyHex
        ),
      "malformed_envelope"
    );
    expectCode(
      () =>
        decodeLegacySecretStoreJson(
          { version: "2", value: { ...valid, ignored: "field" } },
          webKeyHex
        ),
      "malformed_envelope"
    );
    expectCode(
      () => decodeLegacySecretStoreJson({ version: "2", value: valid }, "not-a-key"),
      "invalid_key"
    );
  });

  test("rejects SecretStore tamper and decrypted non-JSON without plaintext fallback", () => {
    const envelope = encryptHexJson({ kind: "unit-vector" });
    const tampered = Buffer.from(envelope.ciphertext, "hex");
    tampered[0] ^= 1;
    expectCode(
      () =>
        decodeLegacySecretStoreJson(
          { version: "2", value: { ...envelope, ciphertext: tampered.toString("hex") } },
          webKeyHex
        ),
      "decryption_failed"
    );

    const nonce = Buffer.alloc(12, 0x54);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(webKeyHex, "hex"), nonce);
    const ciphertext = Buffer.concat([cipher.update("not-json", "utf8"), cipher.final()]);
    expectCode(
      () =>
        decodeLegacySecretStoreJson(
          {
            version: "2",
            value: {
              nonce: nonce.toString("hex"),
              ciphertext: ciphertext.toString("hex"),
              tag: cipher.getAuthTag().toString("hex"),
            },
          },
          webKeyHex
        ),
      "invalid_json"
    );
  });

  test("decodes the PLATOS_ENCRYPTION_KEY iv16/tag16/ciphertext format strictly", () => {
    const source = ["synthetic", "token"].join("-");
    const packed = encryptPacked(source);
    expect(decodeLegacyPlatosSecret(packed, platosKeyHex)).toBe(source);

    expectCode(() => decodeLegacyPlatosSecret(packed.slice(0, -1), platosKeyHex), "malformed_envelope");
    expectCode(
      () => decodeLegacyPlatosSecret(Buffer.alloc(31).toString("base64"), platosKeyHex),
      "malformed_envelope"
    );
    expectCode(
      () => decodeLegacyPlatosSecret(packed, Buffer.alloc(32, 0x76).toString("hex")),
      "decryption_failed"
    );
    expectCode(() => decodeLegacyPlatosSecret(packed, "k".repeat(32)), "invalid_key");
  });

  test("classifies a versioned message as plaintext only when its version is absent", () => {
    expect(decodeVersionedLegacyMessage("historical text", null, messageKeys)).toEqual({
      encoding: "PLAINTEXT",
      keyVersion: null,
      value: "historical text",
    });
    expect(decodeVersionedLegacyMessage(null, undefined, messageKeys)).toEqual({
      encoding: "PLAINTEXT",
      keyVersion: null,
      value: null,
    });

    const packed = encryptPacked("encrypted text", messageKeyHex);
    expect(decodeVersionedLegacyMessage(packed, 7, messageKeys)).toEqual({
      encoding: "ENVELOPE",
      keyVersion: 7,
      value: "encrypted text",
    });
  });

  test("blocks malformed, missing-key, and unsupported versioned messages", () => {
    const packed = encryptPacked("encrypted text", messageKeyHex);
    expectCode(() => decodeVersionedLegacyMessage(packed, 0, messageKeys), "unsupported_version");
    expectCode(() => decodeVersionedLegacyMessage(packed, "7", messageKeys), "unsupported_version");
    expectCode(() => decodeVersionedLegacyMessage(packed, 8, messageKeys), "invalid_key");
    expectCode(() => decodeVersionedLegacyMessage("plaintext-looking", 7, messageKeys), "malformed_envelope");
    expectCode(() => decodeVersionedLegacyMessage(null, 7, messageKeys), "malformed_envelope");
  });

  test("uses the exact JSON marker for JSONB and text envelope classification", () => {
    const plaintextJson = { status: "historical", detail: { count: 2 } };
    expect(decodeLegacyJsonMessage(plaintextJson, "JSONB", messageKeys)).toEqual({
      encoding: "PLAINTEXT",
      keyVersion: null,
      value: plaintextJson,
    });
    const textWithoutMarker = JSON.stringify(plaintextJson);
    expect(decodeLegacyJsonMessage(textWithoutMarker, "TEXT", messageKeys)).toEqual({
      encoding: "PLAINTEXT",
      keyVersion: null,
      value: textWithoutMarker,
    });
    expect(decodeLegacyJsonMessage("not-json", "TEXT", messageKeys)).toEqual({
      encoding: "PLAINTEXT",
      keyVersion: null,
      value: "not-json",
    });

    const envelope = encryptMessageJson(plaintextJson);
    expect(decodeLegacyJsonMessage(envelope, "JSONB", messageKeys)).toEqual({
      encoding: "ENVELOPE",
      keyVersion: 7,
      value: plaintextJson,
    });
    expect(decodeLegacyJsonMessage(JSON.stringify(envelope), "TEXT", messageKeys)).toEqual({
      encoding: "ENVELOPE",
      keyVersion: 7,
      value: plaintextJson,
    });
  });

  test("recognizes marker-shaped failures and never reclassifies them as plaintext", () => {
    const envelope = encryptMessageJson({ status: "unit-vector" });
    expectCode(
      () => decodeLegacyJsonMessage({ ...envelope, __platos_enc: 2 }, "JSONB", messageKeys),
      "unsupported_version"
    );
    expectCode(
      () => decodeLegacyJsonMessage({ ...envelope, __platos_enc: "1" }, "JSONB", messageKeys),
      "unsupported_version"
    );
    expectCode(
      () => decodeLegacyJsonMessage({ ...envelope, v: 0 }, "JSONB", messageKeys),
      "unsupported_version"
    );
    expectCode(
      () => decodeLegacyJsonMessage({ ...envelope, extra: true }, "JSONB", messageKeys),
      "malformed_envelope"
    );
    expectCode(
      () => decodeLegacyJsonMessage({ ...envelope, ct: "plaintext-looking" }, "JSONB", messageKeys),
      "malformed_envelope"
    );
    expectCode(
      () => decodeLegacyJsonMessage({ ...envelope, v: 8 }, "JSONB", messageKeys),
      "invalid_key"
    );
  });

  test("converts the exact inherited TOTP payload to canonical base32", () => {
    const legacySecret = "A1B2C3D4E5F6G7H8I9J0K1L2";
    const canonical = convertLegacyTotpSecretToBase32({ secret: legacySecret });
    expect(canonical).toBe("IEYUEMSDGNCDIRJVIY3EON2IHBETSSRQJMYUYMQ");
    expect(decodeBase32TotpSecret(canonical).toString("utf8")).toBe(legacySecret);

    expectCode(() => convertLegacyTotpSecretToBase32({ secret: "short" }), "invalid_totp_secret");
    expectCode(
      () => convertLegacyTotpSecretToBase32({ secret: legacySecret, extra: true }),
      "malformed_envelope"
    );
    expectCode(() => decodeBase32TotpSecret(canonical.toLowerCase()), "invalid_totp_secret");
    expectCode(() => decodeBase32TotpSecret(`${canonical.slice(0, -1)}R`), "invalid_totp_secret");
    expectCode(() => decodeBase32TotpSecret(`${canonical}=`), "invalid_totp_secret");
  });

  test("accepts only canonical lowercase SHA-256 hex", () => {
    const hash = "ab".repeat(32);
    expect(validateSha256Hex(hash)).toBe(hash);
    expectCode(() => validateSha256Hex(hash.toUpperCase()), "invalid_sha256");
    expectCode(() => validateSha256Hex(hash.slice(2)), "invalid_sha256");
    expectCode(() => validateSha256Hex(`${hash.slice(0, -1)}g`), "invalid_sha256");
  });

  test("validates aggregate components and emits canonical JSON", () => {
    const contract = aggregateCredentialPayloadContracts.find(
      (entry) => entry.id === "channel-app-auth"
    )!;
    expect(
      serializeAggregateCredentialPayload(contract, {
        "PlatosChannelApp.signingSecret": "component-b",
        "PlatosChannelApp.clientSecret": "component-a",
      })
    ).toBe('{"clientSecret":"component-a","signingSecret":"component-b"}');

    expectCode(
      () =>
        serializeAggregateCredentialPayload(contract, {
          "PlatosChannelApp.clientSecret": "component-a",
        }),
      "invalid_aggregate"
    );
    expectCode(
      () =>
        serializeAggregateCredentialPayload(contract, {
          "PlatosChannelApp.clientSecret": "component-a",
          "PlatosChannelApp.signingSecret": "",
        }),
      "invalid_aggregate"
    );
    expectCode(
      () =>
        serializeAggregateCredentialPayload(contract, {
          "PlatosChannelApp.clientSecret": "component-a",
          "PlatosChannelApp.signingSecret": "\ud800",
        }),
      "invalid_aggregate"
    );
    expectCode(
      () =>
        serializeAggregateCredentialPayload(
          {
            ...contract,
            components: [
              contract.components[0],
              { ...contract.components[1], payloadKey: contract.components[0].payloadKey },
            ],
          },
          {
            "PlatosChannelApp.clientSecret": "component-a",
            "PlatosChannelApp.signingSecret": "component-b",
          }
        ),
      "invalid_aggregate"
    );
  });

  test("permits metadata-only evidence and rejects secret, ciphertext, and hash evidence", () => {
    expect(() =>
      assertSecretFreeCutoverEvidence({
        cryptographicFieldId: "message-content",
        sourceKeyVersion: 7,
        encoding: "ENVELOPE",
        outcome: "DECODED",
        componentCount: 1,
      })
    ).not.toThrow();

    const forbidden = ["private", "material"].join("-");
    expectCode(
      () => assertSecretFreeCutoverEvidence({ detail: forbidden }, [forbidden]),
      "unsafe_evidence"
    );
    expectCode(
      () => assertSecretFreeCutoverEvidence({ nested: { ciphertext: "opaque" } }),
      "unsafe_evidence"
    );
    expectCode(
      () => assertSecretFreeCutoverEvidence({ result: "ab".repeat(32) }),
      "unsafe_evidence"
    );
  });

  test("redacts rejected material from errors, JSON serialization, and inspection", () => {
    const rejected = ["rejected", "source", "material"].join("-");
    let error: unknown;
    try {
      decodeLegacyPlatosSecret(rejected, platosKeyHex);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CutoverCryptoError);
    const serialized = JSON.stringify(error);
    const inspected = inspect(error);
    const message = error instanceof Error ? error.message : String(error);
    for (const output of [serialized, inspected, message]) {
      expect(output).not.toContain(rejected);
      expect(output).not.toContain(platosKeyHex);
      expect(output).not.toMatch(/[0-9a-f]{64}/);
    }
    expect(JSON.parse(serialized)).toEqual({
      name: "CutoverCryptoError",
      code: "malformed_envelope",
    });
  });
});
