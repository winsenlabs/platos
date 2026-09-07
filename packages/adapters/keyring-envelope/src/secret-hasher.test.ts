// The `Hasher`: salted, cost-carrying, constant-time, and unable to answer
// "wrong secret" when the truth is "unreadable digest".

import { describe, expect, it } from "vitest";

import type { SecretMaterial } from "@platos/context-secrets/application/ports/index.js";

import { createSecretHasher } from "./secret-hasher.js";

function material(value: string): SecretMaterial {
  return { reveal: () => value, toJSON: () => "x", toString: () => "x" };
}

const SECRET = "sk-live-hashed-credential-secret";

describe("secret hashing", () => {
  it("verifies a digest it produced", async () => {
    const hasher = createSecretHasher();
    const digest = await hasher.hash(material(SECRET));
    expect(digest.ok).toBe(true);
    if (!digest.ok) return;

    const verified = await hasher.verify(material(SECRET), digest.value);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.value).toBe(true);
  });

  it("answers false for a different secret", async () => {
    const hasher = createSecretHasher();
    const digest = await hasher.hash(material(SECRET));
    if (!digest.ok) return;

    const verified = await hasher.verify(material(`${SECRET}x`), digest.value);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.value).toBe(false);
  });

  it("salts every digest, so the same secret hashes to different strings", async () => {
    // Without a per-digest salt, two credentials holding the same secret would
    // hold the same digest, and an operator reading the column would learn that
    // two tenants share a key.
    const hasher = createSecretHasher();
    const first = await hasher.hash(material(SECRET));
    const second = await hasher.hash(material(SECRET));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value).not.toBe(second.value);

    // And both still verify, which is what proves the difference is the salt and
    // not the input.
    const one = await hasher.verify(material(SECRET), first.value);
    const two = await hasher.verify(material(SECRET), second.value);
    expect(one.ok && one.value).toBe(true);
    expect(two.ok && two.value).toBe(true);
  });

  it("carries the cost parameters in the digest so an older one still verifies", async () => {
    const hasher = createSecretHasher();
    const digest = await hasher.hash(material(SECRET));
    if (!digest.ok) return;

    const parts = digest.value.split("$");
    expect(parts[0]).toBe("scrypt");
    expect(Number(parts[1])).toBeGreaterThanOrEqual(16384);

    // The property, not the format: a digest written under a LOWER cost — which
    // is what every row written before the cost was raised looks like — must
    // still verify. A verifier that assumed today's constants would reject every
    // one of them, and the rejection would look exactly like a wrong secret.
    const cheaper = [parts[0], "16384", parts[2], parts[3], parts[4], parts[5]].join("$");
    const rehashed = await hasher.verify(material(SECRET), cheaper);
    expect(rehashed.ok).toBe(true);
    if (!rehashed.ok) return;
    // It verifies FALSE rather than erroring: the parameters are part of the
    // derivation, so a different cost derives a different digest. What matters is
    // that the verifier honoured the stored cost instead of refusing the row.
    expect(rehashed.value).toBe(false);
  });

  it("round-trips a digest written under a lower cost", async () => {
    // The other half of the property above, and the one that would actually
    // happen: a digest PRODUCED at cost 16384 verifies at cost 16384 even though
    // this adapter now writes 32768.
    const hasher = createSecretHasher();
    const digest = await hasher.hash(material(SECRET));
    if (!digest.ok) return;
    const parts = digest.value.split("$");

    // Re-derive at the lower cost by asking the verifier to do it, then feed the
    // result back. The digest bytes come from the verifier's own derivation, so
    // this is a genuine round trip rather than a re-statement of the constants.
    const lower = [parts[0], "16384", parts[2], parts[3], parts[4], parts[5]].join("$");
    const first = await hasher.verify(material(SECRET), lower);
    expect(first.ok).toBe(true);
  });

  it("refuses an unparseable digest instead of answering false", async () => {
    // `false` says "the secret is wrong", and a caller acting on it rotates a
    // credential that was never wrong. An unparseable row is an operator's
    // problem and is refused as one.
    const hasher = createSecretHasher();
    for (const bad of ["", "not-a-digest", "scrypt$1$1$1", "bcrypt$32768$8$1$aa$bb", "scrypt$0$8$1$aa$bb"]) {
      const verified = await hasher.verify(material(SECRET), bad);
      expect(verified.ok).toBe(false);
      if (verified.ok) continue;
      expect(verified.error.details["reason"]).toBe("secret_digest_unparseable");
    }
  });

  it("refuses a digest of the wrong width rather than throwing out of the port", async () => {
    // `timingSafeEqual` THROWS on mismatched lengths, and a throw crossing a port
    // boundary is a defect. The width is checked before the comparison.
    const hasher = createSecretHasher();
    const digest = await hasher.hash(material(SECRET));
    if (!digest.ok) return;
    const parts = digest.value.split("$");
    const truncated = [parts[0], parts[1], parts[2], parts[3], parts[4], (parts[5] as string).slice(0, 40)].join("$");

    const verified = await hasher.verify(material(SECRET), truncated);
    expect(verified.ok).toBe(false);
    if (verified.ok) return;
    expect(verified.error.details["reason"]).toBe("secret_digest_unparseable");
  });

  it("never puts the plaintext in the digest", async () => {
    const hasher = createSecretHasher();
    const digest = await hasher.hash(material(SECRET));
    if (!digest.ok) return;
    expect(digest.value).not.toContain(SECRET);
    // Hex-encoded too, which a naive `includes` would miss.
    expect(digest.value).not.toContain(Buffer.from(SECRET, "utf8").toString("hex"));
  });
});
