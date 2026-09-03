import { describe, expect, it } from "vitest";

import {
  MFA_ENROLMENT_TTL_MS,
  RECOVERY_CODE_COUNT,
  isTotpEnabled,
  normalizeRecoveryCode,
  totpCounterAt,
} from "../domain/index.js";
import {
  ENVIRONMENT,
  MINUTE_MS,
  T0,
  anOperatorSession,
  anOperatorUser,
  at,
  sessionId,
  userId,
} from "../domain/testing.js";
import { beginTotpEnrolment, confirmTotpEnrolment } from "./enrol-totp.js";
import { testPorts, type TestPorts } from "./testing.js";

const SECRET = "JBSWY3DPEHPK3PXP";

function arrange(): TestPorts {
  const ports = testPorts();
  ports.repository.state.users.set(userId(), anOperatorUser());
  ports.repository.state.sessions.set(sessionId(), anOperatorSession());
  return ports;
}

const confirmation = {
  userId: userId(),
  rateLimitIdentifier: "198.51.100.7",
  scope: ENVIRONMENT,
} as const;

describe("beginning an enrolment", () => {
  it("parks the secret with a fifteen-minute deadline and returns the provisioning URI", async () => {
    const ports = arrange();
    const begun = await beginTotpEnrolment(ports, { userId: userId() });
    expect(begun.ok).toBe(true);
    if (!begun.ok) return;
    expect(begun.value.secret).toBe(SECRET);
    expect(begun.value.otpAuthUri).toContain("digits=6");
    expect(begun.value.expiresAt).toEqual(at(MFA_ENROLMENT_TTL_MS));
  });

  it("stores only ciphertext, never the shared secret", async () => {
    const ports = arrange();
    await beginTotpEnrolment(ports, { userId: userId() });
    const stored = ports.repository.state.totp.get(userId());
    expect(stored?.pendingEncryptedSecret).toBe(`sealed:${SECRET}`);
    expect(stored?.encryptedSecret).toBeNull();
  });

  it("does NOT count as an enabled factor until it is confirmed", async () => {
    const ports = arrange();
    await beginTotpEnrolment(ports, { userId: userId() });
    expect(isTotpEnabled(ports.repository.state.totp.get(userId()) ?? null)).toBe(false);
  });

  it("refuses a disabled account", async () => {
    const ports = arrange();
    ports.repository.state.users.set(userId(), anOperatorUser({ disabledAt: T0 }));
    const refused = await beginTotpEnrolment(ports, { userId: userId() });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("UNAUTHENTICATED");
  });
});

describe("confirming an enrolment", () => {
  it("promotes the secret and issues nine recovery codes", async () => {
    const ports = arrange();
    await beginTotpEnrolment(ports, { userId: userId() });
    const confirmed = await confirmTotpEnrolment(ports, {
      ...confirmation,
      code: ports.totp.generate(SECRET, totpCounterAt(T0)),
    });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.recoveryCodes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(isTotpEnabled(ports.repository.state.totp.get(userId()) ?? null)).toBe(true);
  });

  it("stores recovery codes only as verifiers", async () => {
    const ports = arrange();
    await beginTotpEnrolment(ports, { userId: userId() });
    const confirmed = await confirmTotpEnrolment(ports, {
      ...confirmation,
      code: ports.totp.generate(SECRET, totpCounterAt(T0)),
    });
    if (!confirmed.ok) return;
    const first = confirmed.value.recoveryCodes[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    const stored = await ports.repository.mfa.findRecoveryCode(
      userId(),
      ports.hasher.hash(normalizeRecoveryCode(first)),
    );
    expect(stored?.consumedAt).toBeNull();
    // Every stored row is a verifier: none of them IS a displayed code.
    const displayed = new Set(confirmed.value.recoveryCodes);
    for (const record of ports.repository.state.recoveryCodes.values()) {
      expect(displayed.has(record.codeHash)).toBe(false);
    }
  });

  it("BURNS THE CONFIRMING COUNTER so the same digits cannot log in", async () => {
    const ports = arrange();
    await beginTotpEnrolment(ports, { userId: userId() });
    await confirmTotpEnrolment(ports, {
      ...confirmation,
      code: ports.totp.generate(SECRET, totpCounterAt(T0)),
    });
    expect(ports.repository.state.totp.get(userId())?.lastUsedCounter).toBe(totpCounterAt(T0));
  });

  it("REVOKES EVERY SESSION MINTED BEFORE THE ACCOUNT WAS PROTECTED", async () => {
    const ports = arrange();
    await beginTotpEnrolment(ports, { userId: userId() });
    await confirmTotpEnrolment(ports, {
      ...confirmation,
      code: ports.totp.generate(SECRET, totpCounterAt(T0)),
    });
    expect(ports.repository.state.sessions.get(sessionId())?.revokedAt).toEqual(T0);
  });
});

describe("negative controls", () => {
  it("refuses a confirmation with the wrong digits", async () => {
    const ports = arrange();
    await beginTotpEnrolment(ports, { userId: userId() });
    const refused = await confirmTotpEnrolment(ports, { ...confirmation, code: "000000" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("INVALID_MFA_CODE");
    expect(isTotpEnabled(ports.repository.state.totp.get(userId()) ?? null)).toBe(false);
  });

  it("REFUSES A CONFIRMATION AFTER THE ENROLMENT WINDOW CLOSED", async () => {
    const ports = arrange();
    await beginTotpEnrolment(ports, { userId: userId() });
    ports.clock.set(at(MFA_ENROLMENT_TTL_MS));
    const refused = await confirmTotpEnrolment(ports, {
      ...confirmation,
      code: ports.totp.generate(SECRET, totpCounterAt(at(MFA_ENROLMENT_TTL_MS))),
    });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("INVALID_MFA_CODE");
  });

  it("accepts a confirmation one minute inside the window", async () => {
    const ports = arrange();
    await beginTotpEnrolment(ports, { userId: userId() });
    ports.clock.advance(MINUTE_MS);
    const confirmed = await confirmTotpEnrolment(ports, {
      ...confirmation,
      code: ports.totp.generate(SECRET, totpCounterAt(at(MINUTE_MS))),
    });
    expect(confirmed.ok).toBe(true);
  });

  it("refuses when no enrolment was ever begun", async () => {
    const refused = await confirmTotpEnrolment(arrange(), { ...confirmation, code: "000000" });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe("INVALID_MFA_CODE");
  });

  it("bounds guessing with the MFA budget under its own bucket key", async () => {
    const ports = arrange();
    await beginTotpEnrolment(ports, { userId: userId() });
    for (let index = 0; index < 5; index += 1) {
      await confirmTotpEnrolment(ports, { ...confirmation, code: "000000" });
    }
    const limited = await confirmTotpEnrolment(ports, {
      ...confirmation,
      code: ports.totp.generate(SECRET, totpCounterAt(T0)),
    });
    expect(limited.ok).toBe(false);
    if (limited.ok) return;
    expect(limited.error.code).toBe("RATE_LIMITED");
  });
});
