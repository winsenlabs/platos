import { describe, expect, it } from "vitest";

import {
  REDACTED_SECRET_MATERIAL,
  acceptPlaintext,
  isSecretMaterial,
  secretMaterial,
} from "./secret-material.js";

const SENTINEL = "sentinel-provider-secret";
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

describe("plaintext cannot escape by accident", () => {
  it("reveals only when a caller deliberately names reveal()", () => {
    expect(secretMaterial(SENTINEL).reveal()).toBe(SENTINEL);
  });

  it("redacts JSON serialisation, including when nested in another object", () => {
    const captured = { material: secretMaterial(SENTINEL) };
    expect(JSON.stringify(captured)).not.toContain(SENTINEL);
    expect(JSON.stringify(captured)).toContain("REDACTED");
  });

  it("redacts string coercion, so an interpolated log line cannot leak", () => {
    const material = secretMaterial(SENTINEL);
    expect(String(material)).toBe(REDACTED_SECRET_MATERIAL);
    expect(`${material}`).not.toContain(SENTINEL);
    expect(new Error(String(material)).message).not.toContain(SENTINEL);
  });

  it("redacts inspection without importing node:util", () => {
    const material = secretMaterial(SENTINEL) as unknown as Record<symbol, () => string>;
    const custom = material[INSPECT];
    expect(custom?.()).toBe(REDACTED_SECRET_MATERIAL);
  });

  it("survives spreading and enumeration with nothing to capture", () => {
    const material = secretMaterial(SENTINEL);
    expect({ ...material }).toEqual({});
    expect(Object.keys(material)).toEqual([]);
    expect(Object.values(material)).toEqual([]);
    expect(JSON.stringify({ ...material })).not.toContain(SENTINEL);
  });

  it("keeps the plaintext out of own properties entirely", () => {
    const material = secretMaterial(SENTINEL);
    const descriptors = Object.getOwnPropertyDescriptors(material);
    expect(Object.values(descriptors).map((entry) => entry.value)).not.toContain(SENTINEL);
    expect(Object.isFrozen(material)).toBe(true);
  });

  it("recognises its own values and nothing else", () => {
    expect(isSecretMaterial(secretMaterial(SENTINEL))).toBe(true);
    expect(isSecretMaterial({ reveal: () => SENTINEL, toJSON: () => SENTINEL })).toBe(false);
    expect(isSecretMaterial(SENTINEL)).toBe(false);
  });
});

describe("accepting plaintext from outside the boundary", () => {
  it("wraps non-empty material", () => {
    const accepted = acceptPlaintext(SENTINEL);
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.value.reveal()).toBe(SENTINEL);
  });

  it("refuses empty material rather than sealing an empty envelope", () => {
    const refused = acceptPlaintext("");
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe("INVALID_SECRET_MATERIAL");
      expect(refused.error.details).toMatchObject({ reason: "plaintext_empty" });
    }
  });
});
