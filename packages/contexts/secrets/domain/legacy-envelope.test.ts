// The legacy-format rules, and the claim that the canonical row refuses both.
//
// THE ASSERTIONS THAT MATTER HERE JOIN TO THE DESCRIPTORS, NOT TO THEMSELVES.
// `canonicalRowRefusals` derives its answer from `envelope.ts`'s descriptor and
// three constants; a case that compared it against a list this file also wrote
// would be comparing two things one tranche controls. So the cases below name
// the CONSTRAINT the migration really adds and the WIDTH the descriptor really
// declares, and a change to either side alone breaks them.
//
// The constraint names are checked against a real PostgreSQL by
// `postgres-tenancy`'s legacy-envelope integration suite, which inserts a
// legacy-shaped row and reads back the constraint the database raises. This file
// is the pure half of that pair.

import { describe, expect, it } from "vitest";

import { CANONICAL_ENVELOPE_FORMAT, envelopeFormat } from "./envelope.js";
import {
  AUTH_TAG_BYTES,
  MIGRATABLE_ENVELOPE_FORMATS,
  canonicalRowRefusals,
  requireLegacyEnvelopeShape,
  requireMigratableFormat,
} from "./legacy-envelope.js";

function bytes(length: number): Uint8Array {
  return new Uint8Array(length);
}

function partsFor(nonceBytes: number, ciphertextBytes = 8, tagBytes = AUTH_TAG_BYTES) {
  return { nonce: bytes(nonceBytes), ciphertext: bytes(ciphertextBytes), authTag: bytes(tagBytes) };
}

describe("which formats a migration may read", () => {
  it("names exactly the two the descriptors call un-writable", () => {
    // DERIVED, NOT LISTED. If a fourth legacy format were catalogued in
    // `envelope.ts` with `writable: false`, this set would have to grow with it —
    // and the day the two lists disagree is the day a readable format becomes
    // silently un-migratable.
    expect([...MIGRATABLE_ENVELOPE_FORMATS]).toEqual([2, 3]);
    for (const version of MIGRATABLE_ENVELOPE_FORMATS) {
      expect(envelopeFormat(version).writable).toBe(false);
    }
  });

  it("refuses the canonical format with a reason of its own", () => {
    const refused = requireMigratableFormat(CANONICAL_ENVELOPE_FORMAT);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("LEGACY_ENVELOPE_UNREADABLE");
    expect(refused.error.details?.reason).toBe("format_is_already_canonical");
  });

  it("refuses a number that is not a format, DISTINCTLY from the canonical one", () => {
    // Two guards returning one reason cannot be told apart. "You pointed this at
    // material that is already canonical" and "that number is not a format" are
    // different mistakes with different repairs.
    const refused = requireMigratableFormat(9);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.details?.reason).toBe("format_not_a_known_version");
  });

  it("accepts format 2 and hands back its descriptor", () => {
    const accepted = requireMigratableFormat(2);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value.name).toBe("raw-key.aes-256-gcm.dotted-base64url");
    expect(accepted.value.legacyOrigin).toBe("internal-packages/tenancy-database/src/auth.ts");
  });

  it("accepts format 3 and hands back its descriptor", () => {
    const accepted = requireMigratableFormat(3);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value.name).toBe("raw-key.aes-256-gcm.packed-base64");
    expect(accepted.value.legacyOrigin).toBe("apps/agent/src/auth/secrets.service.ts");
  });
});

describe("the width rule reads the descriptor rather than a literal", () => {
  it("accepts format 2's 12-byte nonce", () => {
    const shaped = requireLegacyEnvelopeShape(envelopeFormat(2), partsFor(12));
    expect(shaped.ok).toBe(true);
  });

  it("accepts format 3's 16-byte nonce", () => {
    const shaped = requireLegacyEnvelopeShape(envelopeFormat(3), partsFor(16));
    expect(shaped.ok).toBe(true);
  });

  it("refuses format 3's nonce width when judged as format 2", () => {
    // THE MIS-DECLARED-COLUMN CASE. It is refused by WIDTH and named as such, so
    // an operator fixes the format the column is declared with rather than
    // rotating a key that was never wrong.
    const shaped = requireLegacyEnvelopeShape(envelopeFormat(2), partsFor(16));
    expect(shaped.ok).toBe(false);
    if (shaped.ok) return;
    expect(shaped.error.details?.reason).toBe("nonce_width_disagrees_with_format");
  });

  it("refuses format 2's nonce width when judged as format 3", () => {
    const shaped = requireLegacyEnvelopeShape(envelopeFormat(3), partsFor(12));
    expect(shaped.ok).toBe(false);
    if (shaped.ok) return;
    expect(shaped.error.details?.reason).toBe("nonce_width_disagrees_with_format");
  });

  it("refuses a tag that is not 16 bytes", () => {
    const shaped = requireLegacyEnvelopeShape(envelopeFormat(2), partsFor(12, 8, 15));
    expect(shaped.ok).toBe(false);
    if (shaped.ok) return;
    expect(shaped.error.details?.reason).toBe("auth_tag_width_disagrees_with_format");
  });

  it("refuses an empty ciphertext", () => {
    const shaped = requireLegacyEnvelopeShape(envelopeFormat(2), partsFor(12, 0));
    expect(shaped.ok).toBe(false);
    if (shaped.ok) return;
    expect(shaped.error.details?.reason).toBe("ciphertext_is_empty");
  });

  it("refuses salt bytes, because neither legacy format has any", () => {
    // A caller arriving with salt has either mis-read a canonical envelope as a
    // legacy one or invented a shape. Opening it anyway would silently discard
    // material that changes the key.
    const shaped = requireLegacyEnvelopeShape(envelopeFormat(2), partsFor(12), 32);
    expect(shaped.ok).toBe(false);
    if (shaped.ok) return;
    expect(shaped.error.details?.reason).toBe("legacy_format_carries_no_salt");
  });
});

describe("the canonical row refuses both legacy shapes", () => {
  it("names all three constraints for format 2 — no salt and no root key version", () => {
    // Format 2 has a 12-byte nonce, which the canonical row accepts. It is the
    // ABSENT SALT and the ABSENT ROOT KEY VERSION that make it unstorable, and
    // naming only two constraints is the honest answer.
    expect([...canonicalRowRefusals(envelopeFormat(2))]).toEqual([
      "CredentialSecretVersion_salt_length_check",
      "CredentialSecretVersion_root_key_check",
    ]);
  });

  it("names the nonce constraint too for format 3, whose iv is 16 bytes", () => {
    expect([...canonicalRowRefusals(envelopeFormat(3))]).toEqual([
      "CredentialSecretVersion_salt_length_check",
      "CredentialSecretVersion_nonce_length_check",
      "CredentialSecretVersion_root_key_check",
    ]);
  });

  it("names NO constraint for format 1 — the row was built for it", () => {
    // The control that keeps the two cases above from being vacuous. If
    // `canonicalRowRefusals` simply listed constraints regardless of the
    // descriptor, this case would fail.
    expect(canonicalRowRefusals(envelopeFormat(1))).toHaveLength(0);
  });

  it("agrees with the widths the descriptors declare", () => {
    // Joins the refusal list back to the descriptor it was derived from, in the
    // other direction: format 1 is 32/12 and versioned, and every legacy format
    // differs from that in at least one of the three ways.
    const canonical = envelopeFormat(1);
    expect(canonical.saltBytes).toBe(32);
    expect(canonical.nonceBytes).toBe(12);
    expect(canonical.versionedRootKey).toBe(true);
    for (const version of MIGRATABLE_ENVELOPE_FORMATS) {
      expect(canonicalRowRefusals(envelopeFormat(version)).length).toBeGreaterThan(0);
    }
  });
});
