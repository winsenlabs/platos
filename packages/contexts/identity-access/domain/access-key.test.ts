import { describe, expect, it } from "vitest";

import {
  DEFAULT_ROTATION_OVERLAP_MS,
  acceptsRequestAt,
  assertBootstrapPermitted,
  assertGenerationUnchanged,
  classifyBootstrap,
  isActive,
  isOriginAllowed,
  isRetiring,
  isRotationReplay,
  planRotation,
  revokedKey,
  validateRotationMaterial,
  withAllowedOrigins,
} from "./access-key.js";
import {
  ENVIRONMENT_ID,
  MINUTE_MS,
  ORGANIZATION_ID,
  PROJECT_ID,
  T0,
  anAccessKey,
  at,
  tokenHash,
} from "./testing.js";
import { asIdentifier } from "@platos/kernel";
import type { AccessKeyId } from "./principal.js";

const nextKeyId = asIdentifier<AccessKeyId>("key-2");
const goodHash = "b".repeat(64);

describe("validUntil === null marks THE active key", () => {
  it("recognises the active key", () => {
    expect(isActive(anAccessKey())).toBe(true);
  });

  it("does not treat a retiring key as active", () => {
    expect(isActive(anAccessKey({ validUntil: at(MINUTE_MS) }))).toBe(false);
    expect(isRetiring(anAccessKey({ validUntil: at(MINUTE_MS) }), T0)).toBe(true);
  });

  it("does not treat a revoked key as active or retiring", () => {
    const revoked = anAccessKey({ revokedAt: T0, validUntil: at(MINUTE_MS) });
    expect(isActive(revoked)).toBe(false);
    expect(isRetiring(revoked, T0)).toBe(false);
    expect(acceptsRequestAt(revoked, T0)).toBe(false);
  });
});

describe("the rotation overlap is what makes rotation a non-event", () => {
  it("honours both keys while the overlap is open", () => {
    const retiring = anAccessKey({ validUntil: at(DEFAULT_ROTATION_OVERLAP_MS) });
    expect(acceptsRequestAt(retiring, at(9 * MINUTE_MS))).toBe(true);
    expect(acceptsRequestAt(anAccessKey(), at(9 * MINUTE_MS))).toBe(true);
  });

  it("stops honouring the outgoing key the instant the overlap closes", () => {
    const retiring = anAccessKey({ validUntil: at(DEFAULT_ROTATION_OVERLAP_MS) });
    expect(acceptsRequestAt(retiring, at(DEFAULT_ROTATION_OVERLAP_MS))).toBe(false);
  });

  it("is ten minutes", () => {
    expect(DEFAULT_ROTATION_OVERLAP_MS).toBe(10 * 60_000);
  });
});

describe("the rotation plan", () => {
  it("installs the first key with nothing to retire", () => {
    const plan = planRotation({
      active: null,
      nextKeyId,
      environmentId: ENVIRONMENT_ID,
      keyHash: tokenHash(goodHash),
      keyPrefix: "platos_live_new",
      overlapMs: DEFAULT_ROTATION_OVERLAP_MS,
      now: T0,
    });
    expect(plan.retiringKey).toBeNull();
    expect(isActive(plan.nextKey)).toBe(true);
    expect(plan.nextKey.allowedOrigins).toEqual([]);
  });

  it("carries the outgoing key's origins forward and points it at its replacement", () => {
    const active = anAccessKey({ allowedOrigins: ["https://app.example.com"] });
    const plan = planRotation({
      active,
      nextKeyId,
      environmentId: ENVIRONMENT_ID,
      keyHash: tokenHash(goodHash),
      keyPrefix: "platos_live_new",
      overlapMs: DEFAULT_ROTATION_OVERLAP_MS,
      now: T0,
    });
    expect(plan.nextKey.allowedOrigins).toEqual(["https://app.example.com"]);
    expect(plan.retiringKey?.validUntil).toEqual(at(DEFAULT_ROTATION_OVERLAP_MS));
    expect(plan.retiringKey?.replacedById).toBe(nextKeyId);
    expect(isActive(plan.nextKey)).toBe(true);
  });

  it("recognises a retried rotation of key material that is already active", () => {
    const active = anAccessKey({ keyHash: tokenHash(goodHash) });
    expect(isRotationReplay(active, tokenHash(goodHash))).toBe(true);
    expect(isRotationReplay(active, tokenHash("c".repeat(64)))).toBe(false);
    expect(isRotationReplay(null, tokenHash(goodHash))).toBe(false);
  });
});

describe("the revocation fence: revoke dominates a rotation in flight", () => {
  it("passes when the generation has not moved", () => {
    expect(assertGenerationUnchanged(4, 4).ok).toBe(true);
  });

  it("REFUSES when a concurrent revoke moved the generation", () => {
    const superseded = assertGenerationUnchanged(4, 5);
    expect(superseded.ok).toBe(false);
    if (superseded.ok) return;
    expect(superseded.error.code).toBe("ACCESS_KEY_ROTATION_SUPERSEDED");
    expect(superseded.error.category).toBe("conflict");
  });
});

describe("rotation material is validated before anything is written", () => {
  const valid = { keyHash: goodHash, keyPrefix: "platos_live_abc", overlapMs: 60_000 };

  it("accepts well-formed material", () => {
    expect(validateRotationMaterial(valid).ok).toBe(true);
  });

  it("rejects a hash that is not 64 lower-case hex characters", () => {
    for (const keyHash of [goodHash.toUpperCase(), goodHash.slice(1), `${goodHash}0`, "zz"]) {
      const rejected = validateRotationMaterial({ ...valid, keyHash });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) continue;
      expect(rejected.error.code).toBe("INVALID_ACCESS_KEY_MATERIAL");
      expect(rejected.error.fields[0]?.field).toBe("keyHash");
    }
  });

  it("rejects a prefix that is not the public platos_live_ form", () => {
    const rejected = validateRotationMaterial({ ...valid, keyPrefix: "sk_live_abc" });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error.fields[0]?.field).toBe("keyPrefix");
  });

  it("rejects a non-positive or non-integral overlap", () => {
    expect(validateRotationMaterial({ ...valid, overlapMs: 0 }).ok).toBe(false);
    expect(validateRotationMaterial({ ...valid, overlapMs: -1 }).ok).toBe(false);
    expect(validateRotationMaterial({ ...valid, overlapMs: 1.5 }).ok).toBe(false);
  });
});

describe("the one-use first-install grant", () => {
  it("permits the very first mint on an environment with no key and no grant", () => {
    expect(classifyBootstrap({ activeKey: null, existingGrant: null })).toBe("permitted");
    expect(assertBootstrapPermitted({ activeKey: null, existingGrant: null }).ok).toBe(true);
  });

  it("REFUSES ONCE THE ENVIRONMENT ALREADY HAS A KEY, grant or no grant", () => {
    expect(classifyBootstrap({ activeKey: anAccessKey(), existingGrant: null })).toBe(
      "already-provisioned",
    );
    const refused = assertBootstrapPermitted({ activeKey: anAccessKey(), existingGrant: null });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("BOOTSTRAP_GRANT_UNAVAILABLE");
    expect(refused.error.category).toBe("conflict");
  });

  it("REFUSES A SECOND USE: the grant row is the consume record", () => {
    const grant = {
      environmentId: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      actorUserId: null,
      tokenFingerprint: tokenHash("d".repeat(64)),
      source: "install-script",
      consumedAt: T0,
    };
    expect(classifyBootstrap({ activeKey: null, existingGrant: grant })).toBe("already-consumed");
    expect(assertBootstrapPermitted({ activeKey: null, existingGrant: grant }).ok).toBe(false);
  });
});

describe("browser origins", () => {
  it("allows nothing when nothing is configured", () => {
    expect(isOriginAllowed(anAccessKey(), "https://app.example.com")).toBe(false);
  });

  it("allows exactly what is listed", () => {
    const key = withAllowedOrigins(anAccessKey(), ["https://app.example.com"]);
    expect(isOriginAllowed(key, "https://app.example.com")).toBe(true);
    expect(isOriginAllowed(key, "https://evil.example.com")).toBe(false);
  });

  it("revokes without mutating the original record", () => {
    const key = anAccessKey();
    expect(revokedKey(key, T0).revokedAt).toEqual(T0);
    expect(key.revokedAt).toBeNull();
  });
});
