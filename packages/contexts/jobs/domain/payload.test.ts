import { describe, expect, it } from "vitest";

import {
  containsSensitiveMaterial,
  digestOf,
  isAdmissibleJson,
  isPlainObject,
  isSensitiveKey,
  normalizeKey,
  PAYLOAD_LIMITS,
  serializedByteLength,
  stableJson,
  withinSizeCap,
} from "./payload.js";

const NO_SECRETS: readonly string[] = [];

describe("normalizeKey", () => {
  it("collapses case and separators so one name has one spelling", () => {
    expect(normalizeKey("API_KEY")).toBe("apikey");
    expect(normalizeKey("api-key")).toBe("apikey");
    expect(normalizeKey("apiKey")).toBe("apikey");
  });
});

describe("isSensitiveKey", () => {
  it.each(["secret", "password", "token", "authorization", "credential", "apiKey", "privateKey"])(
    "refuses the credential-shaped key %s",
    (key) => {
      expect(isSensitiveKey(key)).toBe(true);
    },
  );

  it.each(["proto", "constructor", "prototype"])("refuses the pollution vector %s", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it("refuses `handler` and `source` — a payload may not smuggle code", () => {
    expect(isSensitiveKey("handler")).toBe(true);
    expect(isSensitiveKey("source")).toBe(true);
  });

  it("refuses a key ENDING in a credential word", () => {
    expect(isSensitiveKey("stripeApiKey")).toBe(true);
    expect(isSensitiveKey("userPassword")).toBe(true);
  });

  it("permits an ordinary key", () => {
    expect(isSensitiveKey("customerId")).toBe(false);
    expect(isSensitiveKey("tokenCount")).toBe(false);
  });
});

describe("containsSensitiveMaterial", () => {
  it("matches a known secret by containment, anywhere in the string", () => {
    expect(containsSensitiveMaterial("prefix-SUPERSECRET-suffix", ["SUPERSECRET"])).toBe(true);
  });

  it("ignores an EMPTY known secret rather than matching everything", () => {
    expect(containsSensitiveMaterial("anything", [""])).toBe(false);
  });

  it.each([
    "postgres://user:pass@host/db",
    "postgresql://user:pass@host/db",
    "mysql://user:pass@host/db",
    "redis://user:pass@host:6379",
  ])("matches the connection string %s", (value) => {
    expect(containsSensitiveMaterial(value, NO_SECRETS)).toBe(true);
  });

  it("matches a bearer token", () => {
    expect(containsSensitiveMaterial("Authorization: Bearer abc.def-123", NO_SECRETS)).toBe(true);
  });

  it("matches a labelled secret assignment", () => {
    expect(containsSensitiveMaterial("client_secret=hunter2", NO_SECRETS)).toBe(true);
    expect(containsSensitiveMaterial("api-key: abc123", NO_SECRETS)).toBe(true);
  });

  it("permits ordinary prose that merely mentions a word", () => {
    expect(containsSensitiveMaterial("the password policy is documented", NO_SECRETS)).toBe(false);
  });
});

describe("isPlainObject", () => {
  it("accepts an object literal and a null-prototype object", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null) as object)).toBe(true);
  });

  it("REFUSES an array, a null, and a class instance", () => {
    expect(isPlainObject([])).toBe(false);
    expect(isPlainObject(null)).toBe(false);
    expect(isPlainObject(new Date(0))).toBe(false);
  });
});

describe("isAdmissibleJson", () => {
  it("accepts the ordinary scalars and containers", () => {
    expect(isAdmissibleJson({ a: 1, b: "x", c: true, d: null, e: [1, 2] }, NO_SECRETS)).toBe(true);
  });

  it("REFUSES NaN and Infinity — they do not survive serialisation", () => {
    expect(isAdmissibleJson({ a: Number.NaN }, NO_SECRETS)).toBe(false);
    expect(isAdmissibleJson({ a: Number.POSITIVE_INFINITY }, NO_SECRETS)).toBe(false);
  });

  it("REFUSES a payload nested deeper than the depth limit", () => {
    let deep: unknown = "leaf";
    for (let level = 0; level <= PAYLOAD_LIMITS.maxDepth + 1; level += 1) deep = { next: deep };
    expect(isAdmissibleJson(deep, NO_SECRETS)).toBe(false);
  });

  it("accepts a payload AT the depth limit", () => {
    let deep: unknown = "leaf";
    for (let level = 0; level < PAYLOAD_LIMITS.maxDepth; level += 1) deep = { next: deep };
    expect(isAdmissibleJson(deep, NO_SECRETS)).toBe(true);
  });

  it("REFUSES a payload exactly ONE level past the depth limit", () => {
    // The two cases above leave the boundary itself unpinned: `at the limit`
    // passes and `much deeper` fails under BOTH `depth > maxDepth` and the
    // off-by-one `depth > maxDepth + 1`, so neither test can tell the correct
    // cap from a cap that admits one extra level. maxDepth + 1 wrappers put the
    // leaf at depth 9, which the correct predicate refuses and the off-by-one
    // accepts — this is the only nesting that separates them.
    let deep: unknown = "leaf";
    for (let level = 0; level < PAYLOAD_LIMITS.maxDepth + 1; level += 1) deep = { next: deep };
    expect(isAdmissibleJson(deep, NO_SECRETS)).toBe(false);
  });

  it("REFUSES a collection over the item limit", () => {
    const tooMany = Array.from({ length: PAYLOAD_LIMITS.maxCollectionItems + 1 }, () => 1);
    expect(isAdmissibleJson(tooMany, NO_SECRETS)).toBe(false);
    expect(isAdmissibleJson(Array.from({ length: PAYLOAD_LIMITS.maxCollectionItems }, () => 1), NO_SECRETS)).toBe(true);
  });

  it("REFUSES a string over the length limit", () => {
    expect(isAdmissibleJson("x".repeat(PAYLOAD_LIMITS.maxStringLength + 1), NO_SECRETS)).toBe(false);
    expect(isAdmissibleJson("x".repeat(PAYLOAD_LIMITS.maxStringLength), NO_SECRETS)).toBe(true);
  });

  it("REFUSES an empty key and one over the key-length limit", () => {
    expect(isAdmissibleJson({ "": 1 }, NO_SECRETS)).toBe(false);
    expect(isAdmissibleJson({ ["k".repeat(PAYLOAD_LIMITS.maxKeyLength + 1)]: 1 }, NO_SECRETS)).toBe(false);
  });

  it("REFUSES a sensitive key at ANY depth", () => {
    expect(isAdmissibleJson({ outer: { inner: { apiKey: "x" } } }, NO_SECRETS)).toBe(false);
  });

  it("REFUSES a known secret quoted at any depth", () => {
    expect(isAdmissibleJson({ outer: ["a", "TOP-SECRET"] }, ["TOP-SECRET"])).toBe(false);
  });

  it("REFUSES a non-plain object such as a Date", () => {
    expect(isAdmissibleJson({ when: new Date(0) }, NO_SECRETS)).toBe(false);
  });
});

describe("size cap", () => {
  it("measures UTF-8 bytes, not characters", () => {
    // "é" is one character but two UTF-8 bytes; the quotes add two more.
    expect(serializedByteLength("é")).toBe(4);
  });

  it("refuses a payload over the byte cap", () => {
    const big = { blob: "x".repeat(PAYLOAD_LIMITS.maxJsonBytes) };
    expect(withinSizeCap(big)).toBe(false);
  });

  it("accepts a small payload", () => {
    expect(withinSizeCap({ a: 1 })).toBe(true);
  });
});

describe("stableJson", () => {
  it("is INDEPENDENT of key insertion order", () => {
    expect(stableJson({ b: 1, a: 2 })).toBe(stableJson({ a: 2, b: 1 }));
  });

  it("PRESERVES array order — a list is not a set", () => {
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
  });

  it("sorts nested keys too", () => {
    expect(stableJson({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it("distinguishes values that differ", () => {
    expect(stableJson({ a: 1 })).not.toBe(stableJson({ a: 2 }));
  });
});

describe("digestOf", () => {
  const digest = (input: string): string => `H(${input})`;

  it("digests the STABLE serialisation, so key order cannot change it", () => {
    expect(digestOf(digest, { b: 1, a: 2 })).toBe(digestOf(digest, { a: 2, b: 1 }));
  });

  it("changes when the value changes", () => {
    expect(digestOf(digest, { a: 1 })).not.toBe(digestOf(digest, { a: 2 }));
  });
});
