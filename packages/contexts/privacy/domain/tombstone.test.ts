import { asIdentifier, type OrganizationId } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { AliasHash, ErasureOperationId, ErasureTombstoneId } from "./identifiers.js";
import { DEFAULT_PRIVACY_POLICY, tombstoneTtlMs } from "./policy.js";
import {
  activeTombstones,
  draftTombstones,
  hasElapsed,
  isActive,
  tombstoneExpiry,
  type ErasureTombstone,
} from "./tombstone.js";

const ORGANIZATION: OrganizationId = asIdentifier("org-1");
const OPERATION: ErasureOperationId = asIdentifier("op-1");
const SEALED_AT = new Date("2026-01-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function hash(value: string): AliasHash {
  return asIdentifier<AliasHash>(value);
}

function tombstone(expiresAt: Date, aliasHash = "h1"): ErasureTombstone {
  return {
    tombstoneId: asIdentifier<ErasureTombstoneId>("t-1"),
    organizationId: ORGANIZATION,
    aliasHash: hash(aliasHash),
    operationId: OPERATION,
    policyVersion: DEFAULT_PRIVACY_POLICY.version,
    sealedAt: SEALED_AT,
    expiresAt,
  };
}

describe("tombstoneExpiry", () => {
  it("measures from the instant the subject was sealed", () => {
    expect(tombstoneExpiry(SEALED_AT, 30 * DAY_MS)).toEqual(new Date("2026-01-31T00:00:00.000Z"));
  });

  it("uses the policy's window, which defaults to thirty days", () => {
    expect(tombstoneTtlMs(DEFAULT_PRIVACY_POLICY)).toBe(30 * DAY_MS);
  });

  it("clamps a sub-day window to one day rather than producing a lapsed tombstone", () => {
    const policy = { ...DEFAULT_PRIVACY_POLICY, barrier: { tombstoneTtlDays: 0 } };
    expect(tombstoneTtlMs(policy)).toBe(DAY_MS);
  });
});

describe("read-time expiry", () => {
  const expiresAt = new Date("2026-01-31T00:00:00.000Z");

  it("still refuses writes one millisecond before expiry", () => {
    expect(isActive(tombstone(expiresAt), new Date(expiresAt.getTime() - 1))).toBe(true);
  });

  it("has ELAPSED at exactly the expiry instant, not one tick later", () => {
    expect(isActive(tombstone(expiresAt), expiresAt)).toBe(false);
    expect(hasElapsed(tombstone(expiresAt), expiresAt)).toBe(true);
  });

  it("makes `hasElapsed` the exact complement of `isActive`", () => {
    for (const offset of [-1, 0, 1]) {
      const now = new Date(expiresAt.getTime() + offset);
      expect(hasElapsed(tombstone(expiresAt), now)).toBe(!isActive(tombstone(expiresAt), now));
    }
  });

  it("filters a register down to the rows that still refuse writes", () => {
    const live = tombstone(new Date("2026-02-01T00:00:00.000Z"), "live");
    const lapsed = tombstone(new Date("2026-01-01T00:00:00.000Z"), "lapsed");
    expect(activeTombstones([live, lapsed], new Date("2026-01-15T00:00:00.000Z"))).toEqual([live]);
  });
});

describe("draftTombstones", () => {
  const drafts = draftTombstones({
    organizationId: ORGANIZATION,
    operationId: OPERATION,
    policyVersion: "2026-08-11.1",
    aliasHashes: [hash("a"), hash("b"), hash("a")],
    sealedAt: SEALED_AT,
    ttlMs: 30 * DAY_MS,
  });

  it("mints one draft per DISTINCT alias digest", () => {
    expect(drafts.map((draft) => draft.aliasHash)).toEqual(["a", "b"]);
  });

  it("gives every draft the same expiry, so one seal is one barrier window", () => {
    expect(new Set(drafts.map((draft) => draft.expiresAt.getTime())).size).toBe(1);
    expect(drafts[0]?.expiresAt).toEqual(new Date("2026-01-31T00:00:00.000Z"));
  });

  it("stamps the operation and the policy, so a barrier can be traced to its cause", () => {
    expect(drafts.every((draft) => draft.operationId === OPERATION)).toBe(true);
    expect(drafts.every((draft) => draft.policyVersion === "2026-08-11.1")).toBe(true);
  });

  it("preserves the order it was handed, which is already stable", () => {
    const reordered = draftTombstones({
      organizationId: ORGANIZATION,
      operationId: OPERATION,
      policyVersion: "v",
      aliasHashes: [hash("b"), hash("a")],
      sealedAt: SEALED_AT,
      ttlMs: DAY_MS,
    });
    expect(reordered.map((draft) => draft.aliasHash)).toEqual(["b", "a"]);
  });

  it("drafts nothing for an empty alias set", () => {
    expect(
      draftTombstones({
        organizationId: ORGANIZATION,
        operationId: OPERATION,
        policyVersion: "v",
        aliasHashes: [],
        sealedAt: SEALED_AT,
        ttlMs: DAY_MS,
      }),
    ).toEqual([]);
  });
});
