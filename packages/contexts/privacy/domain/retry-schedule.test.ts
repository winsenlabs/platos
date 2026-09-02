import { describe, expect, it } from "vitest";

import { DEFAULT_PRIVACY_POLICY } from "./policy.js";
import { backoffMs, isExhausted, isLeaseFree, leaseUntil, scheduleAfterPass } from "./retry-schedule.js";

const RETRY = DEFAULT_PRIVACY_POLICY.retry;
const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("backoffMs", () => {
  it("waits one base interval after the first pass", () => {
    expect(backoffMs(1, RETRY)).toBe(RETRY.baseBackoffMs);
  });

  it("doubles, deterministically — an operator can predict the next pass", () => {
    expect(backoffMs(2, RETRY)).toBe(RETRY.baseBackoffMs * 2);
    expect(backoffMs(3, RETRY)).toBe(RETRY.baseBackoffMs * 4);
  });

  it("caps, so a long-broken target is still retried a few times a day", () => {
    expect(backoffMs(40, RETRY)).toBe(RETRY.maxBackoffMs);
  });

  it("stays finite at an absurd retry count rather than producing an Invalid Date", () => {
    // 2 ** 1024 is Infinity, and Infinity * 0 is NaN. Capping the EXPONENT as
    // well as the result is what keeps `nextRetryAt` comparable.
    const backoff = backoffMs(100_000, RETRY);
    expect(Number.isFinite(backoff)).toBe(true);
    expect(new Date(NOW.getTime() + backoff).getTime()).not.toBeNaN();
  });

  it("treats a zeroth pass as the first interval rather than as no wait", () => {
    expect(backoffMs(0, RETRY)).toBe(RETRY.baseBackoffMs);
  });
});

describe("isExhausted", () => {
  it("stops re-driving once the budget is spent", () => {
    expect(isExhausted(RETRY.maxRetries - 1, RETRY)).toBe(false);
    expect(isExhausted(RETRY.maxRetries, RETRY)).toBe(true);
  });
});

describe("scheduleAfterPass", () => {
  it("stops scheduling a completed operation", () => {
    expect(scheduleAfterPass({ status: "completed", retryCount: 1 }, NOW, RETRY)).toEqual({
      nextRetryAt: null,
      reason: "settled",
    });
  });

  it("stops scheduling a held operation", () => {
    expect(scheduleAfterPass({ status: "blocked_legal_hold", retryCount: 1 }, NOW, RETRY).reason).toBe("blocked");
  });

  it("stops scheduling once the retries are exhausted, WITHOUT abandoning the row", () => {
    const schedule = scheduleAfterPass({ status: "partial_failure", retryCount: 99 }, NOW, RETRY);
    expect(schedule).toEqual({ nextRetryAt: null, reason: "exhausted" });
  });

  it("schedules an open operation at its backoff", () => {
    const schedule = scheduleAfterPass({ status: "partial_failure", retryCount: 2 }, NOW, RETRY);
    expect(schedule.reason).toBe("scheduled");
    expect(schedule.nextRetryAt).toEqual(new Date(NOW.getTime() + RETRY.baseBackoffMs * 2));
  });

  it("keeps re-driving a verification failure, which is the case most worth finishing", () => {
    expect(scheduleAfterPass({ status: "verification_failed", retryCount: 1 }, NOW, RETRY).reason).toBe("scheduled");
  });
});

describe("leases", () => {
  it("expires strictly after now, so a fresh lease is never immediately free", () => {
    const until = leaseUntil(NOW, RETRY);
    expect(until.getTime()).toBe(NOW.getTime() + RETRY.leaseTtlMs);
    expect(isLeaseFree(until, NOW)).toBe(false);
  });

  it("treats an unheld lease as free", () => {
    expect(isLeaseFree(null, NOW)).toBe(true);
  });

  it("reclaims a crashed pass's lease at exactly its expiry", () => {
    expect(isLeaseFree(NOW, NOW)).toBe(true);
  });

  it("does not reclaim one millisecond early", () => {
    expect(isLeaseFree(new Date(NOW.getTime() + 1), NOW)).toBe(false);
  });
});
