// The two-sided case for the redactor.
//
// A one-sided suite ("the secret is hidden") passes against a redactor that
// returns the literal for every field, which is a redactor that deletes the log.
// Every hide case here is therefore paired with a KEEP case naming a real
// column from the canonical schema that sits beside it, so widening the
// classifier fails just as loudly as narrowing it.
//
// The join to the schema itself — proving the hide list COVERS the schema's
// material columns and the keep list covers its identifiers — lives in
// apps/core-api/src/runtime/log-redaction.test.ts, because the kernel may not
// read a file (scripts/arch/kernel-content.mjs K1/K4) and a suite that cannot
// read the schema can only compare this file against itself.

import { describe, expect, it } from "vitest";

import {
  MAXIMUM_REDACTION_DEPTH,
  REDACTED,
  isMaterialKey,
  isMaterialValue,
  redactLogFields,
} from "./redaction.js";

describe("material key classification", () => {
  it("hides a key whose last word names secret material", () => {
    for (const key of [
      "secret",
      "webhookSecret",
      "clientSecret",
      "signingSecret",
      "encryptedSecret",
      "pendingEncryptedSecret",
      "password",
      "ciphertext",
      "authTag",
      "salt",
      "nonce",
      "token",
      "claimToken",
      "leaseToken",
      "secretHash",
      "clientSecretHash",
      "tokenHash",
      "tokenFingerprint",
      "credentials",
      "authorization",
      "cookie",
    ]) {
      expect(isMaterialKey(key), key).toBe(true);
    }
  });

  it("keeps an identifier, a counter and a version that merely CONTAIN a material word", () => {
    for (const key of [
      "activeSecretVersionId",
      "secretVersionId",
      "secretRevision",
      "rootKeyVersion",
      "credentialId",
      "accessTokenId",
      "parentRefreshTokenId",
      "tokenRefreshClaimId",
      "tokenEndpointAuthMethod",
      "tokenRefreshState",
    ]) {
      expect(isMaterialKey(key), key).toBe(false);
    }
  });

  it("keeps a COUNTER under a material key, because no material column is numeric", () => {
    expect(
      redactLogFields({ inputTokens: 512, outputTokens: 64, maxOutputTokens: 4096, secretRotated: true }),
    ).toEqual({ inputTokens: 512, outputTokens: 64, maxOutputTokens: 4096, secretRotated: true });
  });

  it("still hides the same key when its value is a STRING", () => {
    expect(redactLogFields({ token: "EXAMPLENOTAREAL" })).toEqual({ token: REDACTED });
  });

  it("hides a QUALIFIED key and keeps an addressing key", () => {
    for (const key of ["apiKey", "privateKey", "signingKey", "encryptionKey", "rootKey", "accessKey"]) {
      expect(isMaterialKey(key), key).toBe(true);
    }
    for (const key of ["key", "storageKey", "artifactKey", "idempotencyKey", "cacheKey"]) {
      expect(isMaterialKey(key), key).toBe(false);
    }
  });

  it("hides `encrypted X` however X is named, and keeps a timestamp beside it", () => {
    expect(isMaterialKey("encryptedReference")).toBe(true);
    expect(isMaterialKey("encryptedPayload")).toBe(true);
    expect(isMaterialKey("sealedAt")).toBe(false);
    expect(isMaterialKey("rotatedAt")).toBe(false);
  });

  it("reads snake_case and kebab-case the same as camelCase", () => {
    expect(isMaterialKey("webhook_secret")).toBe(true);
    expect(isMaterialKey("x-api-key")).toBe(true);
    expect(isMaterialKey("active_secret_version_id")).toBe(false);
  });
});

describe("material value classification", () => {
  it("hides an issued credential shape whatever the field is called", () => {
    expect(isMaterialValue("sk-EXAMPLENOTAREALKEY")).toBe(true);
    expect(isMaterialValue("xoxb-EXAMPLENOTAREALKEY")).toBe(true);
    expect(isMaterialValue("Bearer EXAMPLENOTAREALKEY")).toBe(true);
  });

  it("keeps an ordinary string and every non-string", () => {
    expect(isMaterialValue("DATABASE_URL")).toBe(false);
    expect(isMaterialValue("skipped")).toBe(false);
    expect(isMaterialValue(512)).toBe(false);
    expect(isMaterialValue(null)).toBe(false);
  });
});

describe("redactLogFields", () => {
  it("hides material and keeps the metadata that makes the line legible", () => {
    const out = redactLogFields({
      credentialId: "cred-1",
      key: "DATABASE_URL",
      secretRevision: 4,
      rootKeyVersion: 2,
      webhookSecret: "EXAMPLENOTAREALSECRET",
      apiKey: "EXAMPLENOTAREALKEY",
    });
    expect(out).toEqual({
      credentialId: "cred-1",
      key: "DATABASE_URL",
      secretRevision: 4,
      rootKeyVersion: 2,
      webhookSecret: REDACTED,
      apiKey: REDACTED,
    });
  });

  it("hides the WHOLE subtree under a material key, shape included", () => {
    const out = redactLogFields({
      connection: { id: "c1", credentials: { clientId: "public", clientSecret: "EXAMPLENOTAREAL" } },
    });
    expect(out).toEqual({ connection: { id: "c1", credentials: REDACTED } });
  });

  it("walks arrays and nested objects", () => {
    const out = redactLogFields({
      variables: [
        { key: "PLAIN_ONE", value: "public" },
        { key: "SECRET_ONE", secretHash: "EXAMPLENOTAREAL" },
      ],
    });
    expect(out).toEqual({
      variables: [
        { key: "PLAIN_ONE", value: "public" },
        { key: "SECRET_ONE", secretHash: REDACTED },
      ],
    });
  });

  it("hides a self-redacting holder that reached a log field", () => {
    const holder = { reveal: () => "EXAMPLENOTAREAL" } as never;
    expect(redactLogFields({ material: holder })).toEqual({ material: REDACTED });
  });

  it("stops describing past the depth ceiling instead of walking forever", () => {
    let deep: Record<string, unknown> = { leaf: "public" };
    for (let level = 0; level < MAXIMUM_REDACTION_DEPTH + 4; level += 1) {
      deep = { nested: deep };
    }
    expect(JSON.stringify(redactLogFields(deep as never))).toContain(REDACTED);
    expect(JSON.stringify(redactLogFields(deep as never))).not.toContain("leaf");
  });

  it("catches an issued credential hiding under an innocent field name", () => {
    expect(redactLogFields({ note: "sk-EXAMPLENOTAREALKEY" })).toEqual({ note: REDACTED });
  });

  it("returns a frozen record so a later caller cannot put the material back", () => {
    const out = redactLogFields({ apiKey: "EXAMPLENOTAREAL" });
    expect(Object.isFrozen(out)).toBe(true);
  });
});
