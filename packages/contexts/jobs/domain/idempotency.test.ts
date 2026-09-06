import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import type { RequestDigest } from "./identifiers.js";
import {
  completedReservation,
  decideReplay,
  failedReservation,
  IDEMPOTENCY_TTL_SECONDS,
  readableRecord,
  readReservation,
  runningReservation,
  unreadableRecord,
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
    const decision = decideReplay(readableRecord(completedReservation(DIGEST, { rows: 3 })), DIGEST);
    expect(decision).toEqual({ ok: true, value: { kind: "replay-success", result: { rows: 3 } } });
  });

  it("replays a completed NULL result without confusing it for absence", () => {
    const decision = decideReplay(readableRecord(completedReservation(DIGEST, null)), DIGEST);
    if (!decision.ok) throw new Error("unreachable");
    expect(decision.value).toEqual({ kind: "replay-success", result: null });
  });

  it("replays a cached FAILURE rather than re-running the handler", () => {
    const decision = decideReplay(readableRecord(failedReservation(DIGEST, "JOB_TIMEOUT")), DIGEST);
    if (!decision.ok) throw new Error("unreachable");
    expect(decision.value).toEqual({ kind: "replay-failure", code: "JOB_TIMEOUT" });
  });

  it("reports a still-running execution as IN_PROGRESS", () => {
    const decision = decideReplay(readableRecord(runningReservation(DIGEST)), DIGEST);
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.code).toBe("IDEMPOTENCY_IN_PROGRESS");
    expect(decision.error.category).toBe("conflict");
  });

  it("REFUSES a request id reused with a DIFFERENT body", () => {
    const decision = decideReplay(readableRecord(completedReservation(OTHER, { rows: 3 })), DIGEST);
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("REFUSES a conflicting digest even when the cached execution is still running", () => {
    const decision = decideReplay(readableRecord(runningReservation(OTHER)), DIGEST);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("FAILS CLOSED on an unreadable record rather than running the job", () => {
    // Something held the key a moment ago and this process cannot prove what it
    // did. Treating that as "free to run" would duplicate a side effect.
    const decision = decideReplay(unreadableRecord("absent"), DIGEST);
    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.code).toBe("JOBS_IDEMPOTENCY_RECORD_ABSENT");
  });

  it("gives each unreadable reason its OWN code, distinct from a real conflict", () => {
    // WIN-260. All four of these arrived as IDEMPOTENCY_CONFLICT before this
    // issue. The assertion is on the SIZE of the set as well as its members, so
    // any regression that merges two of them back together fails here whatever
    // the surviving code happens to be.
    const codes = (["absent", "malformed", "unpromised-code"] as const).map((reason) => {
      const decision = decideReplay(unreadableRecord(reason), DIGEST);
      if (decision.ok) throw new Error("unreachable");
      return decision.error.code;
    });
    const conflict = decideReplay(readableRecord(runningReservation(OTHER)), DIGEST);
    if (conflict.ok) throw new Error("unreachable");
    codes.push(conflict.error.code);

    expect(new Set(codes).size).toBe(4);
    expect(codes).toEqual([
      "JOBS_IDEMPOTENCY_RECORD_ABSENT",
      "JOBS_IDEMPOTENCY_RECORD_MALFORMED",
      "JOBS_IDEMPOTENCY_REPLAY_CODE_UNPROMISED",
      "IDEMPOTENCY_CONFLICT",
    ]);
  });

  it("keeps every unreadable refusal in the SAME category as a conflict", () => {
    // Distinct CODES, one STATUS. The three unreadable reasons and the genuine
    // reuse all mean "a reservation exists under this id and cannot be honoured",
    // so a transport that maps category to status keeps answering 409; it is the
    // code that tells an operator which of the four happened.
    for (const reason of ["absent", "malformed", "unpromised-code"] as const) {
      const decision = decideReplay(unreadableRecord(reason), DIGEST);
      if (decision.ok) throw new Error("unreachable");
      expect(decision.error.category).toBe("conflict");
    }
  });
});

describe("readReservation", () => {
  it("reads back every reservation this context writes", () => {
    const cases = [
      runningReservation(DIGEST),
      completedReservation(DIGEST, { rows: 3 }),
      completedReservation(DIGEST, null),
      failedReservation(DIGEST, "JOB_TIMEOUT"),
    ];
    for (const reservation of cases) {
      // Through JSON, because that is the only shape a keyspace can hold: a
      // decoder tested against the in-memory object would never meet the
      // `undefined`-shaped holes serialisation actually produces.
      const round = readReservation(JSON.parse(JSON.stringify(reservation)) as unknown);
      expect(round).toEqual(readableRecord(reservation));
    }
  });

  it("reports a missing record as ABSENT, not as rubbish", () => {
    expect(readReservation(null)).toEqual(unreadableRecord("absent"));
    expect(readReservation(undefined)).toEqual(unreadableRecord("absent"));
  });

  it("reports anything that is not a reservation as MALFORMED", () => {
    const rubbish: unknown[] = [
      "IDEMPOTENCY_CONFLICT",
      42,
      [],
      {},
      { state: "running" },
      { state: "running", digest: "" },
      { state: "elsewhere", digest: "digest-a" },
      { state: "completed", digest: "digest-a" },
      { state: "failed", digest: "digest-a" },
      { state: "failed", digest: "digest-a", code: 7 },
    ];
    for (const value of rubbish) {
      expect(readReservation(value)).toEqual(unreadableRecord("malformed"));
    }
  });

  it("REFUSES a cached failure whose code this major never promised", () => {
    // The type says JobExecutionErrorCode. The bytes said otherwise — a peer on
    // a different contract version, or anything else with the credential. The
    // record is readable and is still refused, because replaying it would put a
    // code on the wire that the closed set does not contain.
    const decoded = readReservation({
      state: "failed",
      digest: "digest-a",
      code: "JOB_EATEN_BY_WOLVES",
    });
    expect(decoded).toEqual(unreadableRecord("unpromised-code"));

    const decision = decideReplay(decoded, DIGEST);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.error.code).toBe("JOBS_IDEMPOTENCY_REPLAY_CODE_UNPROMISED");
  });

  it("admits a cached failure for every code the closed set DOES contain", () => {
    // The negative control for the case above: if the guard refused everything,
    // the refusal would prove nothing.
    const decoded = readReservation({
      state: "failed",
      digest: "digest-a",
      code: "JOB_EXECUTION_FAILED",
    });
    expect(decoded).toEqual(readableRecord(failedReservation(DIGEST, "JOB_EXECUTION_FAILED")));
  });
});
