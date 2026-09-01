import { describe, expect, it } from "vitest";

import {
  DEFAULT_MFA_VERIFY_POLICY,
  normalizeRecoveryCode,
  totpCounterAt,
} from "../domain/index.js";
import {
  DAY_MS,
  ENVIRONMENT,
  T0,
  anOperatorSession,
  anOperatorUser,
  aTotpCredential,
  at,
  sessionId,
  userId,
} from "../domain/testing.js";
import { verifyMfaForSession } from "./verify-mfa.js";
import { testPorts, type TestPorts } from "./testing.js";

const RAW = "plt_os_raw-session-token";
const SECRET = "JBSWY3DPEHPK3PXP";

function arrange(): TestPorts {
  const ports = testPorts();
  const session = anOperatorSession({ tokenHash: ports.hasher.hash(RAW) });
  ports.repository.state.sessions.set(session.sessionId, session);
  ports.repository.state.users.set(userId(), anOperatorUser());
  ports.repository.state.totp.set(
    userId(),
    aTotpCredential({ encryptedSecret: ports.cipher.seal(SECRET), lastUsedCounter: null }),
  );
  return ports;
}

function codeAt(ports: TestPorts, instant: Date): string {
  return ports.totp.generate(SECRET, totpCounterAt(instant));
}

const base = {
  sessionToken: RAW,
  rateLimitIdentifier: "198.51.100.7",
  scope: ENVIRONMENT,
} as const;

describe("verifying a second factor", () => {
  it("accepts a valid code and marks the session verified", async () => {
    const ports = arrange();
    const result = await verifyMfaForSession(ports, { ...base, totpCode: codeAt(ports, T0) });
    expect(result.ok).toBe(true);
    expect(ports.repository.state.sessions.get(sessionId())?.mfaVerifiedAt).toEqual(T0);
  });

  it("burns the counter, so the credential moves forward", async () => {
    const ports = arrange();
    await verifyMfaForSession(ports, { ...base, totpCode: codeAt(ports, T0) });
    expect(ports.repository.state.totp.get(userId())?.lastUsedCounter).toBe(totpCounterAt(T0));
  });

  it("accepts a code from one step earlier, inside the tolerance window", async () => {
    const ports = arrange();
    const result = await verifyMfaForSession(ports, {
      ...base,
      totpCode: codeAt(ports, at(-30_000)),
    });
    expect(result.ok).toBe(true);
  });
});

describe("negative controls", () => {
  it("REJECTS A REPLAYED CODE: the same digits presented twice", async () => {
    const ports = arrange();
    const code = codeAt(ports, T0);
    expect((await verifyMfaForSession(ports, { ...base, totpCode: code })).ok).toBe(true);

    const replayed = await verifyMfaForSession(ports, { ...base, totpCode: code });
    expect(replayed.ok).toBe(false);
    if (replayed.ok) return;
    expect(replayed.error.code).toBe("INVALID_MFA_CODE");
  });

  it("rejects a code from an earlier step once a later one has been used", async () => {
    const ports = arrange();
    await verifyMfaForSession(ports, { ...base, totpCode: codeAt(ports, T0) });
    const stale = await verifyMfaForSession(ports, { ...base, totpCode: codeAt(ports, at(-30_000)) });
    expect(stale.ok).toBe(false);
  });

  it("rejects digits that match no counter in the window", async () => {
    const ports = arrange();
    const wrong = await verifyMfaForSession(ports, { ...base, totpCode: "999999" });
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.error.code).toBe("INVALID_MFA_CODE");
  });

  it("rejects a request carrying neither a code nor a recovery code", async () => {
    expect((await verifyMfaForSession(arrange(), base)).ok).toBe(false);
  });

  it("refuses an account with no enrolled factor, without saying so", async () => {
    const ports = arrange();
    ports.repository.state.totp.delete(userId());
    const refused = await verifyMfaForSession(ports, { ...base, totpCode: "000000" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("INVALID_MFA_CODE");
  });

  it("REFUSES A REVOKED SESSION before spending any budget", async () => {
    const ports = arrange();
    const session = anOperatorSession({ tokenHash: ports.hasher.hash(RAW), revokedAt: T0 });
    ports.repository.state.sessions.set(session.sessionId, session);
    const refused = await verifyMfaForSession(ports, { ...base, totpCode: codeAt(ports, T0) });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("UNAUTHENTICATED");
    expect(ports.rateLimiter.buckets.size).toBe(0);
  });

  it("REFUSES AN EXPIRED SESSION", async () => {
    const ports = arrange();
    ports.clock.set(at(8 * DAY_MS));
    const refused = await verifyMfaForSession(ports, { ...base, totpCode: codeAt(ports, at(8 * DAY_MS)) });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("UNAUTHENTICATED");
  });

  it("BOUNDS GUESSING: the MFA budget refuses once it is spent", async () => {
    const ports = arrange();
    for (let index = 0; index < DEFAULT_MFA_VERIFY_POLICY.requests; index += 1) {
      await verifyMfaForSession(ports, { ...base, totpCode: "111111" });
    }
    const limited = await verifyMfaForSession(ports, { ...base, totpCode: codeAt(ports, T0) });
    expect(limited.ok).toBe(false);
    if (limited.ok) return;
    expect(limited.error.code).toBe("RATE_LIMITED");
  });
});

describe("recovery codes are an alternative proof, not a weaker one", () => {
  it("accepts an unused recovery code and consumes it", async () => {
    const ports = arrange();
    const codeHash = ports.hasher.hash(normalizeRecoveryCode("ABC12-DEF34"));
    await ports.repository.mfa.replaceRecoveryCodes(userId(), [codeHash]);

    const first = await verifyMfaForSession(ports, { ...base, recoveryCode: "abc12-def34" });
    expect(first.ok).toBe(true);
  });

  it("REFUSES THE SAME RECOVERY CODE A SECOND TIME", async () => {
    const ports = arrange();
    const codeHash = ports.hasher.hash(normalizeRecoveryCode("ABC12-DEF34"));
    await ports.repository.mfa.replaceRecoveryCodes(userId(), [codeHash]);
    await verifyMfaForSession(ports, { ...base, recoveryCode: "ABC12-DEF34" });

    const second = await verifyMfaForSession(ports, { ...base, recoveryCode: "ABC12-DEF34" });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("INVALID_MFA_CODE");
  });

  it("refuses a recovery code that was never issued", async () => {
    const refused = await verifyMfaForSession(arrange(), { ...base, recoveryCode: "NOPE1-NOPE2" });
    expect(refused.ok).toBe(false);
  });
});
