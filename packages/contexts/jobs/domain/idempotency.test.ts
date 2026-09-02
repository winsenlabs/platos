import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { RequestDigest } from "./identifiers.js";
import {
  completedReservation,
  decideReplay,
  failedReservation,
  IDEMPOTENCY_TTL_SECONDS,
  runningReservation,
} from "./idempotency.js";

const DIGEST = asIdentifier<RequestDigest>("digest-a");
const OTHER = asIdentifier<RequestDigest>("digest-b");

describe("the reservation TTL", () => {
  it("is the live seven days", () => {
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});

describe("decideReplay", () => {
  it("replays a completed result for the SAME request", () => {
    const decision = decideReplay(completedReservation(DIGEST, { rows: 3 }), DIGEST);
    expect(decision).toEqual({ ok: true, value: { kind: "replay-success", result: { rows: 3 } } });
  });

  it("replays a completed NULL result without confusing it for absence", () => {
    const decision = decideReplay(completedReservation(DIGEST, null), DIGEST);
    if (!decision.ok) throw new Error("unreachable");
    expect(decision.value).toEqual({ kind: "replay-success", result: null });
  });

  it("replays a cached FAILURE rather than re-running the handler", () => {
    const decision = decideReplay(failedReservation(DIGEST, "JOB_TIMEOUT"), DIGEST);
    if (!decision.ok) throw new Error("unreachable");
    expect(decision.value).toEqual({ kind: "replay-failure", code: "JOB_TIMEOUT" });
  });

  it("reports a still-running execution as IN_PROGRESS", () => {
    const decision = decideReplay(runningReservation(DIGEST), DIGEST);
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.code).toBe("IDEMPOTENCY_IN_PROGRESS");
    expect(decision.error.category).toBe("conflict");
  });

  it("REFUSES a request id reused with a DIFFERENT body", () => {
    const decision = decideReplay(completedReservation(OTHER, { rows: 3 }), DIGEST);
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("REFUSES a conflicting digest even when the cached execution is still running", () => {
    const decision = decideReplay(runningReservation(OTHER), DIGEST);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("FAILS CLOSED on an unreadable record rather than running the job", () => {
    // Something held the key a moment ago and this process cannot prove what it
    // did. Treating that as "free to run" would duplicate a side effect.
    const decision = decideReplay(null, DIGEST);
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });
});
