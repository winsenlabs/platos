import { describe, expect, test } from "vitest";
import {
  DELIVERED_RETENTION_DAYS,
  OBSERVABILITY_PAYLOAD_VERSION,
  deliveryFailed,
  deliverySucceeded,
  deliveryUndeliverable,
  emptyDrainSummary,
  failedDrainSummary,
  isDeliverableVersion,
  retryDelayMs,
  type OutboxRow,
} from "./observability-outbox";

const NOW = new Date("2026-08-20T10:00:00.000Z");

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: "outbox-1",
    turnId: "turn-1",
    organizationId: "org-1",
    payloadVersion: OBSERVABILITY_PAYLOAD_VERSION,
    payload: {},
    status: "PENDING",
    attempts: 0,
    ...overrides,
  };
}

describe("retry scheduling", () => {
  test("backs off exponentially from thirty seconds", () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(3)).toBe(120_000);
  });

  test("caps at an hour, so a stuck row stays distinguishable from a slow one", () => {
    expect(retryDelayMs(20)).toBe(3_600_000);
    expect(retryDelayMs(1_000)).toBe(3_600_000);
  });

  test("treats a nonsense attempt count as the first attempt", () => {
    expect(retryDelayMs(0)).toBe(30_000);
    expect(retryDelayMs(-5)).toBe(30_000);
  });
});

describe("delivery outcomes", () => {
  test("a delivered row records when it was acknowledged", () => {
    // The database check constraint pairs status DELIVERED with a non-null
    // deliveredAt, so "delivered" cannot be a label a bug applies for free.
    expect(deliverySucceeded(row(), NOW)).toEqual({
      status: "DELIVERED",
      attempts: 1,
      availableAt: null,
      deliveredAt: NOW,
      lastErrorCode: null,
    });
  });

  test("a failure below the attempt ceiling is rescheduled, not dropped", () => {
    const outcome = deliveryFailed(row({ attempts: 2 }), NOW, 10, "ObservabilityWriteError 503");
    expect(outcome.status).toBe("PENDING");
    expect(outcome.attempts).toBe(3);
    expect(outcome.availableAt).toEqual(new Date(NOW.getTime() + retryDelayMs(3)));
    expect(outcome.deliveredAt).toBeNull();
    expect(outcome.lastErrorCode).toBe("ObservabilityWriteError 503");
  });

  test("an exhausted row is PARKED as FAILED, never deleted", () => {
    // Parking is the loud version of giving up. Giving up quietly is the
    // failure mode the outbox replaced.
    const outcome = deliveryFailed(row({ attempts: 9 }), NOW, 10, "ObservabilityWriteError 400/62");
    expect(outcome.status).toBe("FAILED");
    expect(outcome.attempts).toBe(10);
    expect(outcome.availableAt).toBeNull();
  });

  test("an undeliverable payload is parked immediately rather than retried", () => {
    // A shape mismatch does not heal with time, and burning ten attempts on it
    // delays every well-formed row behind it.
    const outcome = deliveryUndeliverable(row(), "payload is not the expected row shape");
    expect(outcome.status).toBe("FAILED");
    expect(outcome.availableAt).toBeNull();
    expect(outcome.lastErrorCode).toBe("payload is not the expected row shape");
  });

  test("truncates an error code rather than storing an unbounded string", () => {
    const outcome = deliveryFailed(row(), NOW, 10, "x".repeat(500));
    expect(outcome.lastErrorCode).toHaveLength(200);
  });

  test("no outcome ever removes a row", () => {
    const outcomes = [
      deliverySucceeded(row(), NOW),
      deliveryFailed(row(), NOW, 10, "e"),
      deliveryFailed(row({ attempts: 99 }), NOW, 10, "e"),
      deliveryUndeliverable(row(), "e"),
    ];
    for (const outcome of outcomes) {
      expect(["PENDING", "DELIVERED", "FAILED"]).toContain(outcome.status);
    }
  });
});

describe("payload versioning", () => {
  test("accepts the version this writer produces", () => {
    expect(isDeliverableVersion(row())).toBe(true);
  });

  test("refuses a payload written by a newer writer", () => {
    // Rolling back one replica must not let it mangle rows a newer one queued.
    expect(isDeliverableVersion(row({ payloadVersion: OBSERVABILITY_PAYLOAD_VERSION + 1 }))).toBe(false);
    expect(isDeliverableVersion(row({ payloadVersion: 0 }))).toBe(false);
  });
});

describe("drain summary", () => {
  test("starts at zero and carries a reason when a pass does nothing", () => {
    expect(emptyDrainSummary()).toEqual({
      claimed: 0,
      delivered: 0,
      retried: 0,
      parked: 0,
      pruned: 0,
      discarded: 0,
      passes: 0,
    });
    expect(emptyDrainSummary("sink unavailable").skipped).toBe("sink unavailable");
  });

  test("a thrown drain is a failure, and does not wear the benign field", () => {
    // `skipped` is the honest answer for an absent or unreachable sink, and its
    // only consumer logs every value of it at warn under "not an error". A
    // thrown drain arriving in that field produced no error-level signal
    // anywhere and left the scheduled run green.
    const failed = failedDrainSummary("drain threw (PrismaClientKnownRequestError)");
    expect(failed.failure).toBe("drain threw (PrismaClientKnownRequestError)");
    expect(failed.skipped).toBeUndefined();
    expect(failed.delivered).toBe(0);
  });

  test("keeps acknowledged rows for a week, matching the documented retention", () => {
    expect(DELIVERED_RETENTION_DAYS).toBe(7);
  });
});
