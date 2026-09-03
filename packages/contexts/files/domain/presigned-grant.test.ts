import { describe, expect, it } from "vitest";

import type { StorageKey } from "./identifiers.js";
import {
  admitGrantWindow,
  grantExpiry,
  grantHasElapsed,
  redeemGrant,
  remainingGrantSeconds,
  type PresignedGrant,
} from "./presigned-grant.js";

const KEY = "org/o/proj/p/env/e/thread/t/attachment/a/photo.png" as StorageKey;
const ISSUED_AT = new Date("2026-01-01T00:00:00.000Z");

function grantFor(seconds: number): PresignedGrant {
  return {
    operation: "download",
    key: KEY,
    url: "memory://get/photo.png",
    method: "GET",
    requiredHeaders: {},
    issuedAt: ISSUED_AT,
    expiresAt: grantExpiry(ISSUED_AT, seconds),
  };
}

describe("admitGrantWindow", () => {
  it("accepts a positive window within policy", () => {
    expect(admitGrantWindow(300, 900).ok).toBe(true);
  });

  it("rejects a window that is zero, negative, fractional or over the cap", () => {
    for (const seconds of [0, -1, 1.5, 901]) {
      const denied = admitGrantWindow(seconds, 900);
      expect(denied.ok).toBe(false);
      if (denied.ok) throw new Error("unreachable");
      expect(denied.error.code).toBe("FILES_PRESIGN_WINDOW_INVALID");
    }
  });
});

describe("redeemGrant — the expiry negative control", () => {
  it("redeems a grant inside its window", () => {
    const grant = grantFor(300);
    const at = new Date(ISSUED_AT.getTime() + 299_000);
    expect(grantHasElapsed(grant, at)).toBe(false);
    expect(redeemGrant(grant, at).ok).toBe(true);
    expect(remainingGrantSeconds(grant, at)).toBe(1);
  });

  it("REFUSES a grant exactly at its expiry — the window is half-open", () => {
    const grant = grantFor(300);
    const at = new Date(ISSUED_AT.getTime() + 300_000);
    expect(grantHasElapsed(grant, at)).toBe(true);
    const denied = redeemGrant(grant, at);
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("FILES_PRESIGNED_GRANT_ELAPSED");
  });

  it("REFUSES a grant past its expiry and reports zero remaining", () => {
    const grant = grantFor(300);
    const at = new Date(ISSUED_AT.getTime() + 900_000);
    expect(redeemGrant(grant, at).ok).toBe(false);
    expect(remainingGrantSeconds(grant, at)).toBe(0);
  });
});
