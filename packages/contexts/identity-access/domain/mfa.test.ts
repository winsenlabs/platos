import { describe, expect, it } from "vitest";

import {
  MFA_ENROLMENT_TTL_MS,
  RECOVERY_CODE_COUNT,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_WINDOW,
  acceptTotpCounter,
  beganEnrolment,
  confirmedEnrolment,
  consumedRecoveryCode,
  isEnrolmentPending,
  isTotpCodeShaped,
  isTotpEnabled,
  otpAuthUri,
  totpCounterAt,
  totpCounterWindow,
} from "./mfa.js";
import { MINUTE_MS, T0, aTotpCredential, at, email, userId } from "./testing.js";

describe("RFC 6238 parameters match the extraction source", () => {
  it("is 30 seconds, 6 digits, one step of tolerance, nine recovery codes", () => {
    expect(TOTP_PERIOD_SECONDS).toBe(30);
    expect(TOTP_DIGITS).toBe(6);
    expect(TOTP_WINDOW).toBe(1);
    expect(RECOVERY_CODE_COUNT).toBe(9);
    expect(MFA_ENROLMENT_TTL_MS).toBe(15 * 60 * 1000);
  });

  it("advances the counter once per period and not between", () => {
    expect(totpCounterAt(at(29_999))).toBe(totpCounterAt(T0));
    expect(totpCounterAt(at(30_000))).toBe(totpCounterAt(T0) + 1n);
  });

  it("offers exactly the current counter plus one step either side", () => {
    const window = totpCounterWindow(T0);
    expect(window).toEqual([totpCounterAt(T0) - 1n, totpCounterAt(T0), totpCounterAt(T0) + 1n]);
  });

  it("drops negative counters rather than wrapping them", () => {
    expect(totpCounterWindow(new Date(0))).toEqual([0n, 1n]);
  });

  it("accepts only six decimal digits as a code", () => {
    expect(isTotpCodeShaped("012345")).toBe(true);
    expect(isTotpCodeShaped("12345")).toBe(false);
    expect(isTotpCodeShaped("1234567")).toBe(false);
    expect(isTotpCodeShaped("12345a")).toBe(false);
  });
});

describe("replay protection is a strictly increasing counter", () => {
  it("accepts the first use, when no counter has been recorded", () => {
    const accepted = acceptTotpCounter(aTotpCredential({ lastUsedCounter: null }), 100n);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.value.lastUsedCounter).toBe(100n);
  });

  it("REJECTS A REPLAY: the same code inside its own window yields the same counter", () => {
    const used = aTotpCredential({ lastUsedCounter: 100n });
    const replayed = acceptTotpCounter(used, 100n);
    expect(replayed.ok).toBe(false);
    if (replayed.ok) return;
    expect(replayed.error.code).toBe("INVALID_MFA_CODE");
  });

  it("rejects a counter that goes backwards, even one inside the tolerance window", () => {
    const rejected = acceptTotpCounter(aTotpCredential({ lastUsedCounter: 100n }), 99n);
    expect(rejected.ok).toBe(false);
  });

  it("accepts the next counter", () => {
    expect(acceptTotpCounter(aTotpCredential({ lastUsedCounter: 100n }), 101n).ok).toBe(true);
  });
});

describe("enrolment is two-step and time-boxed", () => {
  it("parks the new secret without touching the live one", () => {
    const live = aTotpCredential({ encryptedSecret: "sealed:old", enabledAt: T0 });
    const pending = beganEnrolment(live, "sealed:new", T0);
    expect(pending.encryptedSecret).toBe("sealed:old");
    expect(pending.pendingEncryptedSecret).toBe("sealed:new");
    expect(pending.pendingExpiresAt).toEqual(at(MFA_ENROLMENT_TTL_MS));
  });

  it("closes the enrolment window after fifteen minutes", () => {
    const pending = beganEnrolment(aTotpCredential(), "sealed:new", T0);
    expect(isEnrolmentPending(pending, at(14 * MINUTE_MS))).toBe(true);
    expect(isEnrolmentPending(pending, at(MFA_ENROLMENT_TTL_MS))).toBe(false);
  });

  it("refuses to confirm an enrolment whose window closed", () => {
    const pending = beganEnrolment(aTotpCredential(), "sealed:new", T0);
    const confirmed = confirmedEnrolment(pending, 5n, at(MFA_ENROLMENT_TTL_MS));
    expect(confirmed.ok).toBe(false);
    if (confirmed.ok) return;
    expect(confirmed.error.code).toBe("INVALID_MFA_CODE");
  });

  it("promotes the pending secret and burns the confirming counter", () => {
    const pending = beganEnrolment(
      aTotpCredential({ encryptedSecret: null, enabledAt: null }),
      "sealed:new",
      T0,
    );
    const confirmed = confirmedEnrolment(pending, 5n, at(MINUTE_MS));
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.value.encryptedSecret).toBe("sealed:new");
    expect(confirmed.value.pendingEncryptedSecret).toBeNull();
    expect(confirmed.value.lastUsedCounter).toBe(5n);
    // The confirming code cannot immediately be replayed as a login.
    expect(acceptTotpCounter(confirmed.value, 5n).ok).toBe(false);
  });

  it("does not count an unconfirmed enrolment as an enabled factor", () => {
    const pending = beganEnrolment(
      aTotpCredential({ encryptedSecret: null, enabledAt: null }),
      "sealed:new",
      T0,
    );
    expect(isTotpEnabled(pending)).toBe(false);
    expect(isTotpEnabled(aTotpCredential())).toBe(true);
    expect(isTotpEnabled(null)).toBe(false);
  });
});

describe("recovery codes are single-use", () => {
  it("consumes an unused code and refuses it on the second presentation", () => {
    const first = consumedRecoveryCode({ userId: userId(), codeHash: "h", consumedAt: null }, T0);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = consumedRecoveryCode(first.value, at(MINUTE_MS));
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.code).toBe("INVALID_MFA_CODE");
  });
});

describe("the provisioning URI", () => {
  it("carries the digit count and period an authenticator needs", () => {
    const uri = otpAuthUri(email(), "JBSWY3DPEHPK3PXP");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
    expect(uri).toContain("secret=JBSWY3DPEHPK3PXP");
    expect(uri).toContain(encodeURIComponent("Platos:operator@example.com"));
  });
});
