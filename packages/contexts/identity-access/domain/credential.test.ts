import { describe, expect, it } from "vitest";

import {
  credentialStateAt,
  instantAfter,
  isUsableAt,
  requireUsableAt,
  secondsUntil,
} from "./credential.js";
import { T0, at, MINUTE_MS } from "./testing.js";

describe("the shared credential lifecycle", () => {
  it("reports revoked even when the credential is also expired", () => {
    const state = credentialStateAt({ expiresAt: T0, revokedAt: T0 }, at(MINUTE_MS));
    expect(state).toBe("revoked");
  });

  it("treats expiry as inclusive: a credential is not usable at the instant it names", () => {
    const credential = { expiresAt: T0, revokedAt: null };
    expect(credentialStateAt(credential, T0)).toBe("expired");
    expect(credentialStateAt(credential, at(-1))).toBe("active");
  });

  it("treats a null expiry as one that does not run out", () => {
    expect(isUsableAt({ expiresAt: null, revokedAt: null }, at(1000 * MINUTE_MS))).toBe(true);
  });

  it("maps each refusal to its own code", () => {
    const revoked = requireUsableAt({ expiresAt: null, revokedAt: T0 }, T0);
    const expired = requireUsableAt({ expiresAt: T0, revokedAt: null }, T0);
    expect(revoked.ok).toBe(false);
    expect(expired.ok).toBe(false);
    if (revoked.ok || expired.ok) throw new Error("both must refuse");
    expect(revoked.error.code).toBe("CREDENTIAL_REVOKED");
    expect(expired.error.code).toBe("CREDENTIAL_EXPIRED");
  });

  it("returns the credential unchanged when it is usable", () => {
    const credential = { expiresAt: at(MINUTE_MS), revokedAt: null };
    const result = requireUsableAt(credential, T0);
    expect(result.ok && result.value).toBe(credential);
  });
});

describe("retry-after arithmetic", () => {
  it("rounds up, so a client never returns while the window is still open", () => {
    expect(secondsUntil(at(1500), T0)).toBe(2);
    expect(secondsUntil(at(1000), T0)).toBe(1);
  });

  it("floors at zero rather than going negative", () => {
    expect(secondsUntil(at(-5000), T0)).toBe(0);
    expect(secondsUntil(T0, T0)).toBe(0);
  });

  it("turns a TTL into an instant without touching the wall clock", () => {
    expect(instantAfter(T0, MINUTE_MS).toISOString()).toBe(at(MINUTE_MS).toISOString());
  });
});
