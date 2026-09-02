import { describe, expect, it } from "vitest";

import {
  backoffMs,
  BACKOFF_CEILING_MS,
  decideRetry,
  MAX_ATTEMPTS,
  retryDueAt,
} from "./retry-schedule.js";

describe("backoffMs", () => {
  // `min(2^attempt * 1000, 30000)`, exactly as the legacy formula reads.
  it("doubles from two seconds", () => {
    expect(backoffMs(1)).toBe(2_000);
    expect(backoffMs(2)).toBe(4_000);
    expect(backoffMs(3)).toBe(8_000);
  });

  it("is capped at the ceiling", () => {
    expect(backoffMs(10)).toBe(BACKOFF_CEILING_MS);
    expect(backoffMs(100)).toBe(BACKOFF_CEILING_MS);
  });
});

describe("decideRetry", () => {
  // The whole schedule, spelled out. An off-by-one here is invisible until an
  // incident, so it is asserted as a literal sequence rather than derived.
  it("retries twice and then gives up — three attempts in total", () => {
    expect(decideRetry(0)).toEqual({ kind: "retry", attempt: 1, delayMs: 2_000 });
    expect(decideRetry(1)).toEqual({ kind: "retry", attempt: 2, delayMs: 4_000 });
    expect(decideRetry(2)).toEqual({ kind: "give-up", attempts: 3 });
  });

  it("keeps giving up past the limit", () => {
    expect(decideRetry(3)).toEqual({ kind: "give-up", attempts: 4 });
    expect(decideRetry(99)).toEqual({ kind: "give-up", attempts: 100 });
  });

  // The legacy guard is `retryCount >= MAX_RETRIES`. Relaxing it to `>` buys a
  // fourth attempt and this is the case that says so.
  it("gives up AT the limit, not one attempt after it", () => {
    const atLimit = decideRetry(MAX_ATTEMPTS - 1);
    expect(atLimit.kind).toBe("give-up");
    const belowLimit = decideRetry(MAX_ATTEMPTS - 2);
    expect(belowLimit.kind).toBe("retry");
  });

  it("never yields a delay above the ceiling", () => {
    for (let failed = 0; failed < 50; failed += 1) {
      const decision = decideRetry(failed);
      if (decision.kind === "retry") expect(decision.delayMs).toBeLessThanOrEqual(BACKOFF_CEILING_MS);
    }
  });
});

describe("retryDueAt", () => {
  it("adds the decided delay to the instant the decision was made", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const decision = decideRetry(0);
    if (decision.kind !== "retry") throw new Error("unreachable");
    expect(retryDueAt(now, decision).toISOString()).toBe("2026-01-01T00:00:02.000Z");
  });
});
