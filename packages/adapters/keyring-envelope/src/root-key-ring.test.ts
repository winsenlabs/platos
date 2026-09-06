// The ring's four parse refusals, and the opacity of a handle.
//
// Every refusal below is one `CredentialRootKeyRing` in the extraction source
// answers by THROWING. A throw across a port boundary is a defect rather than an
// outcome, so each is a `Result` here — and each carries its own
// `details.reason`, because they all share the code `INVALID_KEY_RING` and an
// operator diagnosing a ring that will not load needs to know WHICH of the four
// it hit. The reasons are asserted rather than the code alone, so two guards
// collapsing onto one reason fails here.

import { describe, expect, it } from "vitest";

import type { RootKeyHandle, RootKeyVersion } from "@platos/context-secrets/application/ports/index.js";

import { createRootKeyRing } from "./root-key-ring.js";

const KEY_ONE = "feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface";
const KEY_TWO = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function version(value: number): RootKeyVersion {
  return value as RootKeyVersion;
}

function reasonOf(result: { ok: false; error: { details: Readonly<Record<string, unknown>> } }): unknown {
  return result.error.details["reason"];
}

describe("root key ring parsing", () => {
  it("builds a ring and reports the active version and every present version", () => {
    const ring = createRootKeyRing({ activeVersion: 2, keys: { "1": KEY_ONE, "2": KEY_TWO } });
    expect(ring.ok).toBe(true);
    if (!ring.ok) return;

    const state = ring.value.state();
    expect(state.ok).toBe(true);
    if (!state.ok) return;
    expect(state.value.activeVersion).toBe(2);
    expect([...state.value.presentVersions]).toStrictEqual([1, 2]);
  });

  it("refuses a key that is not 32 hex-encoded bytes", () => {
    // The mistake an operator actually makes: a base64 secret pasted where hex
    // was expected. It is exactly 44 characters and looks like a key.
    const ring = createRootKeyRing({
      activeVersion: 1,
      keys: { "1": "c2VjcmV0LWtleS1tYXRlcmlhbC10aGF0LWlzLW5vdC1oZXg=" },
    });
    expect(ring.ok).toBe(false);
    if (ring.ok) return;
    expect(ring.error.code).toBe("INVALID_KEY_RING");
    expect(reasonOf(ring)).toBe("root_key_not_32_hex_encoded_bytes");
  });

  it("refuses a key of the right alphabet and the wrong width", () => {
    const ring = createRootKeyRing({ activeVersion: 1, keys: { "1": KEY_ONE.slice(0, 62) } });
    expect(ring.ok).toBe(false);
    if (ring.ok) return;
    expect(reasonOf(ring)).toBe("root_key_not_32_hex_encoded_bytes");
  });

  it("refuses a non-positive active version", () => {
    const ring = createRootKeyRing({ activeVersion: 0, keys: { "1": KEY_ONE } });
    expect(ring.ok).toBe(false);
    if (ring.ok) return;
    expect(reasonOf(ring)).toBe("root_key_version_not_a_positive_integer");
  });

  it("refuses a version key that is not an integer literal", () => {
    // `Number(" 1 ")` is 1 and `Number("1.0")` is 1, so both would collapse onto
    // version 1 if the shape were not checked before the conversion. A ring that
    // silently accepted " 1" would seal under a version no envelope names.
    const ring = createRootKeyRing({ activeVersion: 1, keys: { " 1 ": KEY_ONE } });
    expect(ring.ok).toBe(false);
    if (ring.ok) return;
    expect(reasonOf(ring)).toBe("root_key_version_not_an_integer_literal");
  });

  it("refuses an empty ring", () => {
    const ring = createRootKeyRing({ activeVersion: 1, keys: {} });
    expect(ring.ok).toBe(false);
    if (ring.ok) return;
    expect(reasonOf(ring)).toBe("root_key_ring_empty");
  });

  it("refuses an active version that is not in the ring", () => {
    // The domain's own `rootKeyRingState` owns this rule; the parser must not
    // restate it. Asserting the DOMAIN's reason here is what proves the parser
    // delegated rather than re-implemented.
    const ring = createRootKeyRing({ activeVersion: 3, keys: { "1": KEY_ONE, "2": KEY_TWO } });
    expect(ring.ok).toBe(false);
    if (ring.ok) return;
    expect(reasonOf(ring)).toBe("active_version_absent_from_ring");
  });
});

describe("root key handles", () => {
  it("mints a handle for a present version and refuses an absent one", () => {
    const built = createRootKeyRing({ activeVersion: 1, keys: { "1": KEY_ONE } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.value.mint(version(1)).ok).toBe(true);

    const absent = built.value.mint(version(4));
    expect(absent.ok).toBe(false);
    if (absent.ok) return;
    expect(reasonOf(absent)).toBe("root_key_version_absent_from_ring");
  });

  // THE OPACITY PROPERTY, stated as a failure. `RootKeyHandle`'s brand is a
  // `unique symbol` that is declared and never exported, so nobody can BUILD one
  // — but everybody can CAST one, and a cast `{ rootKeyVersion: 1 }` is
  // structurally identical to a minted handle. A ring that resolved by reading
  // the field would hand the key material to this forgery.
  it("refuses to resolve a handle it did not mint", () => {
    const built = createRootKeyRing({ activeVersion: 1, keys: { "1": KEY_ONE } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const forged = { rootKeyVersion: version(1) } as RootKeyHandle;
    const resolved = built.value.resolve(forged);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(reasonOf(resolved)).toBe("root_key_handle_not_minted_by_this_ring");
  });

  // The same property across two rings holding the SAME key bytes. Identity and
  // not value is what the WeakMap keys on, so a handle from ring A is refused by
  // ring B even when both would have answered with identical material.
  it("refuses a handle minted by a different ring over identical material", () => {
    const first = createRootKeyRing({ activeVersion: 1, keys: { "1": KEY_ONE } });
    const second = createRootKeyRing({ activeVersion: 1, keys: { "1": KEY_ONE } });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const handle = first.value.mint(version(1));
    expect(handle.ok).toBe(true);
    if (!handle.ok) return;

    expect(first.value.resolve(handle.value).ok).toBe(true);
    const crossed = second.value.resolve(handle.value);
    expect(crossed.ok).toBe(false);
    if (crossed.ok) return;
    expect(reasonOf(crossed)).toBe("root_key_handle_not_minted_by_this_ring");
  });

  it("resolves a minted handle to the material of the version it names", () => {
    const built = createRootKeyRing({ activeVersion: 2, keys: { "1": KEY_ONE, "2": KEY_TWO } });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const one = built.value.mint(version(1));
    const two = built.value.mint(version(2));
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;

    const first = built.value.resolve(one.value);
    const second = built.value.resolve(two.value);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    // The bytes are compared to the DECLARED hex rather than to each other, so a
    // resolver that returned one key for every version fails here.
    expect(Buffer.from(first.value).toString("hex")).toBe(KEY_ONE);
    expect(Buffer.from(second.value).toString("hex")).toBe(KEY_TWO);
  });
});
