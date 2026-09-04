import { describe, expect, it } from "vitest";

import { asAgentsIdentifier, type Slug } from "./identifiers.js";
import {
  admitSlug,
  collisionToken,
  deriveSlug,
  disambiguateSlug,
  MAX_SLUG_LENGTH,
  resolveSlug,
} from "./slug.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("derivation", () => {
  it("lower-cases, collapses every run outside the alphabet, and trims the edges", () => {
    expect(deriveSlug("  Customer  Support!! ")).toBe("customer-support");
  });

  it("collapses a run of separators into ONE hyphen, not one per character", () => {
    expect(deriveSlug("a___b---c")).toBe("a-b-c");
  });

  it("keeps digits, which are inside the alphabet", () => {
    expect(deriveSlug("Tier 2 Support")).toBe("tier-2-support");
  });

  it("returns the EMPTY string for a name written entirely outside the alphabet", () => {
    // Total by construction. `admitSlug`, not this function, decides about it.
    expect(deriveSlug("日本語")).toBe("");
    expect(deriveSlug("!!!")).toBe("");
  });

  it("is idempotent on an already-derived slug", () => {
    expect(deriveSlug(deriveSlug("Customer Support"))).toBe("customer-support");
  });
});

describe("admission", () => {
  it("derives from the name when no slug is supplied", () => {
    const admitted = admitSlug("Customer Support", undefined);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value).toBe("customer-support");
  });

  it("treats a blank supplied slug as no slug at all", () => {
    const admitted = admitSlug("Customer Support", "   ");
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value).toBe("customer-support");
  });

  it("passes a supplied slug through VERBATIM rather than re-deriving it", () => {
    // Re-deriving would silently rewrite a slug an operator typed and, with it,
    // the URL of an agent they had already shared.
    const admitted = admitSlug("Customer Support", " Legacy_Slug ");
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value).toBe("Legacy_Slug");
  });

  it("refuses a name that derives to nothing, naming the field", () => {
    const admitted = admitSlug("!!!", null);
    if (admitted.ok) throw new Error("unreachable");
    expect(admitted.error.code).toBe("AGENTS_AGENT_METADATA_INVALID");
    expect(admitted.error.fields[0]?.field).toBe("slug");
  });

  it("refuses a slug past the ceiling", () => {
    const admitted = admitSlug("x", "a".repeat(MAX_SLUG_LENGTH + 1));
    if (admitted.ok) throw new Error("unreachable");
    expect(admitted.error.fields[0]?.code).toBe("too_long");
  });

  it("admits a slug exactly at the ceiling", () => {
    expect(admitSlug("x", "a".repeat(MAX_SLUG_LENGTH)).ok).toBe(true);
  });
});

describe("the collision rule", () => {
  it("spells the token as base-36 milliseconds, exactly as the source does", () => {
    expect(collisionToken(NOW)).toBe(NOW.getTime().toString(36));
  });

  it("clamps a pre-epoch instant rather than emitting a sign into a slug", () => {
    expect(collisionToken(new Date(-1))).toBe("0");
    expect(collisionToken(new Date(-1))).not.toContain("-");
  });

  it("appends the token with one hyphen", () => {
    expect(disambiguateSlug(asAgentsIdentifier<Slug>("support"), "abc")).toBe("support-abc");
  });

  it("leaves a free slug alone", () => {
    expect(resolveSlug(asAgentsIdentifier<Slug>("support"), ["other"], NOW)).toBe("support");
  });

  it("disambiguates a taken slug", () => {
    const resolved = resolveSlug(asAgentsIdentifier<Slug>("support"), ["support"], NOW);
    expect(resolved).toBe(`support-${collisionToken(NOW)}`);
  });

  it("runs ONE round: a taken disambiguated slug is returned taken", () => {
    // The store's unique index — not this function — refuses the second. Making
    // that explicit is the point; a caller must not believe it is fully handled.
    const taken = ["support", `support-${collisionToken(NOW)}`];
    expect(resolveSlug(asAgentsIdentifier<Slug>("support"), taken, NOW)).toBe(taken[1]);
  });

  it("compares against the whole taken list, not just its head", () => {
    const resolved = resolveSlug(asAgentsIdentifier<Slug>("support"), ["a", "b", "support"], NOW);
    expect(resolved).not.toBe("support");
  });
});
