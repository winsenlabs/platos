import { describe, expect, it } from "vitest";

import {
  admitContent,
  admitContentText,
  admitMetadata,
  contentIdentity,
  isIsoInstant,
  MAX_CONTENT_LENGTH,
  requiresContentHash,
} from "./content.js";
import { asMemoryIdentifier, type ContentHash } from "./identifiers.js";

const HASH = asMemoryIdentifier<ContentHash>("hash-1");

describe("content admission", () => {
  it("trims, and stores the trimmed body", () => {
    const admitted = admitContentText("  prefers tea  ");
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value).toBe("prefers tea");
  });

  it("refuses a body that is empty after trimming", () => {
    const admitted = admitContentText("   \n\t ");
    expect(admitted.ok).toBe(false);
    if (admitted.ok) throw new Error("unreachable");
    expect(admitted.error.code).toBe("MEMORY_INVALID_CONTENT");
    expect(admitted.error.fields[0]?.field).toBe("content");
  });

  it("accepts a body exactly at the cap and refuses one past it", () => {
    expect(admitContentText("x".repeat(MAX_CONTENT_LENGTH)).ok).toBe(true);
    expect(admitContentText("x".repeat(MAX_CONTENT_LENGTH + 1)).ok).toBe(false);
  });

  it("measures the cap AFTER trimming, so surrounding whitespace is not content", () => {
    expect(admitContentText(`  ${"x".repeat(MAX_CONTENT_LENGTH)}  `).ok).toBe(true);
  });
});

describe("metadata — the per-kind rule", () => {
  it("accepts absent metadata for every kind that does not require it", () => {
    for (const kind of ["fact", "preference", "event"] as const) {
      const admitted = admitMetadata(kind, undefined);
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) throw new Error("unreachable");
      expect(admitted.value).toBeNull();
    }
  });

  it("refuses metadata that is an array or a scalar", () => {
    expect(admitMetadata("fact", [1, 2]).ok).toBe(false);
    expect(admitMetadata("fact", "topic").ok).toBe(false);
    expect(admitMetadata("fact", 7).ok).toBe(false);
  });

  it("CARRIES THROUGH unknown keys, so an extractor upgrade is not breaking", () => {
    const admitted = admitMetadata("fact", { topic: "tea", entities: ["acme"], novel: 1 });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value?.["entities"]).toEqual(["acme"]);
    expect(admitted.value?.["novel"]).toBe(1);
  });

  it("types `fact.subject` and `fact.topic` when they are present", () => {
    expect(admitMetadata("fact", { topic: "tea" }).ok).toBe(true);
    expect(admitMetadata("fact", { topic: 7 }).ok).toBe(false);
  });

  it("types `preference.over` as a list of strings", () => {
    expect(admitMetadata("preference", { over: ["coffee"] }).ok).toBe(true);
    expect(admitMetadata("preference", { over: [7] }).ok).toBe(false);
    expect(admitMetadata("preference", { over: "coffee" }).ok).toBe(false);
  });

  it("requires `relationship.from`, `.to` and `.type`, each non-empty", () => {
    expect(admitMetadata("relationship", { from: "a", to: "b", type: "knows" }).ok).toBe(true);
    for (const missing of ["from", "to", "type"]) {
      const metadata: Record<string, string> = { from: "a", to: "b", type: "knows" };
      delete metadata[missing];
      const admitted = admitMetadata("relationship", metadata);
      expect(admitted.ok).toBe(false);
      if (admitted.ok) throw new Error("unreachable");
      expect(admitted.error.fields[0]?.field).toBe(`metadata.${missing}`);
    }
    expect(admitMetadata("relationship", { from: "", to: "b", type: "knows" }).ok).toBe(false);
  });

  it("requires `profile.profileKey` and NORMALISES it in place", () => {
    const admitted = admitMetadata("profile", { profileKey: "  Preferred Name " });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value?.["profileKey"]).toBe("preferred name");
  });

  it("refuses a profile with a blank key", () => {
    expect(admitMetadata("profile", { profileKey: "   " }).ok).toBe(false);
    expect(admitMetadata("profile", {}).ok).toBe(false);
  });
});

describe("event instants", () => {
  it("accepts a well-formed ISO instant with or without fractional seconds", () => {
    expect(isIsoInstant("2026-09-03T12:00:00Z")).toBe(true);
    expect(isIsoInstant("2026-09-03T12:00:00.123Z")).toBe(true);
    expect(isIsoInstant("2026-09-03T12:00:00+05:30")).toBe(true);
  });

  it("refuses a value that MATCHES the pattern but is not a real instant", () => {
    // Two digits is two digits; `Date.parse` is what knows there is no month 13.
    expect(isIsoInstant("2026-13-01T00:00:00Z")).toBe(false);
    expect(isIsoInstant("2026-09-32T00:00:00Z")).toBe(false);
  });

  it("refuses a value the PATTERN catches but `Date.parse` would accept", () => {
    // `Date.parse("2026-09-03")` is valid; the column wants a full instant.
    expect(isIsoInstant("2026-09-03")).toBe(false);
    expect(isIsoInstant("2026-09-03T12:00:00")).toBe(false);
  });

  it("does NOT catch a rolled-over day, and the module says so", () => {
    // 30 February becomes 2 March in every conforming engine. Documented in
    // `domain/content.ts` rather than pretended away.
    expect(isIsoInstant("2026-02-30T00:00:00Z")).toBe(true);
  });

  it("only checks `at` when it is present", () => {
    expect(admitMetadata("event", { location: "here" }).ok).toBe(true);
    expect(admitMetadata("event", { at: "yesterday" }).ok).toBe(false);
    expect(admitMetadata("event", { at: "2026-09-03T12:00:00Z" }).ok).toBe(true);
  });

  it("types `event.participants` as a list of strings", () => {
    expect(admitMetadata("event", { participants: ["sam"] }).ok).toBe(true);
    expect(admitMetadata("event", { participants: [{}] }).ok).toBe(false);
  });
});

describe("admitContent — content first, then the kind's metadata", () => {
  it("reports a BLANK BODY even when the metadata is also wrong", () => {
    const admitted = admitContent({ kind: "relationship", content: "  ", metadata: {} });
    expect(admitted.ok).toBe(false);
    if (admitted.ok) throw new Error("unreachable");
    expect(admitted.error.code).toBe("MEMORY_INVALID_CONTENT");
  });

  it("derives the profile key from the admitted metadata", () => {
    const admitted = admitContent({
      kind: "profile",
      content: "Sam leads platform",
      metadata: { profileKey: "ROLE" },
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.profileKey).toBe("role");
  });

  it("leaves the profile key null for every other kind", () => {
    const admitted = admitContent({ kind: "fact", content: "likes tea", metadata: null });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) throw new Error("unreachable");
    expect(admitted.value.profileKey).toBeNull();
  });
});

describe("the dedupe identity", () => {
  it("a memory FROM A THREAD carries a hash; one written by hand does not", () => {
    expect(requiresContentHash(true)).toBe(true);
    expect(requiresContentHash(false)).toBe(false);
  });

  it("drops a hash that arrived without a thread, rather than storing it", () => {
    expect(contentIdentity(false, HASH).contentHash).toBeNull();
    expect(contentIdentity(true, HASH).contentHash).toBe(HASH);
  });
});
