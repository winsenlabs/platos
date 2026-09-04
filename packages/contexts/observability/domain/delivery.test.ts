import { describe, expect, it } from "vitest";

import {
  DEFAULT_DRAIN_BUDGET,
  DELIVERED_RETENTION_DAYS,
  deliveryFailed,
  deliverySucceeded,
  deliveryUndeliverable,
  emptyDrainReport,
  reportIsConserved,
  resolveDrainBudget,
  retentionCutoff,
  retryDelayMs,
  wasParked,
  willBeRetried,
  type DrainReport,
  type EnvelopeState,
} from "./delivery.js";
import { envelopeMalformed, sinkRejectedBatch } from "./errors.js";
import type { EnvelopeId } from "./identifiers.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

function state(retryCount = 0): EnvelopeState {
  return { envelopeId: "envelope-0001" as EnvelopeId, retryCount };
}

describe("retryDelayMs", () => {
  it("starts at thirty seconds and doubles", () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(60_000);
    expect(retryDelayMs(3)).toBe(120_000);
  });

  it("caps at an hour, so a queued envelope never looks stuck", () => {
    expect(retryDelayMs(20)).toBe(3_600_000);
    expect(retryDelayMs(1_000)).toBe(3_600_000);
  });

  it("bounds the exponent before shifting, so a corrupt counter cannot overflow", () => {
    expect(Number.isFinite(retryDelayMs(1e9))).toBe(true);
    expect(retryDelayMs(0)).toBe(30_000);
    expect(retryDelayMs(-5)).toBe(30_000);
  });
});

describe("deliverySucceeded", () => {
  it("acknowledges the envelope and stamps when", () => {
    const outcome = deliverySucceeded(state(2), NOW);
    expect(outcome.status).toBe("DELIVERED");
    expect(outcome.retryCount).toBe(3);
    expect(outcome.deliveredAt).toEqual(NOW);
    expect(outcome.availableAt).toBeNull();
    expect(outcome.lastErrorCode).toBeNull();
  });
});

describe("deliveryFailed", () => {
  it("reschedules while tries remain, at the backed-off instant", () => {
    const outcome = deliveryFailed(state(0), NOW, 10, sinkRejectedBatch("down"));
    expect(outcome.status).toBe("PENDING");
    expect(willBeRetried(outcome)).toBe(true);
    expect(outcome.retryCount).toBe(1);
    expect(outcome.availableAt).toEqual(new Date(NOW.getTime() + 30_000));
    expect(outcome.lastErrorCode).toBe("OBSERVABILITY_SINK_REJECTED_BATCH");
  });

  it("PARKS at the retry ceiling rather than deleting the envelope", () => {
    const outcome = deliveryFailed(state(9), NOW, 10, sinkRejectedBatch("down"));
    expect(outcome.status).toBe("FAILED");
    expect(wasParked(outcome)).toBe(true);
    expect(outcome.availableAt).toBeNull();
  });

  it("parks on the try that REACHES the ceiling, not the one after it", () => {
    expect(deliveryFailed(state(8), NOW, 10, sinkRejectedBatch("down")).status).toBe("PENDING");
    expect(deliveryFailed(state(9), NOW, 10, sinkRejectedBatch("down")).status).toBe("FAILED");
  });

  it("carries the error CODE only — a store quotes the subject in its bodies", () => {
    const outcome = deliveryFailed(state(0), NOW, 10, sinkRejectedBatch("ada@example.test"));
    expect(outcome.lastErrorCode).toBe("OBSERVABILITY_SINK_REJECTED_BATCH");
    expect(outcome.lastErrorCode).not.toContain("@");
  });
});

describe("deliveryUndeliverable", () => {
  it("parks immediately: a shape mismatch does not heal with time", () => {
    const outcome = deliveryUndeliverable(state(0), envelopeMalformed("bad shape"));
    expect(outcome.status).toBe("FAILED");
    expect(outcome.availableAt).toBeNull();
    expect(outcome.lastErrorCode).toBe("OBSERVABILITY_ENVELOPE_MALFORMED");
  });

  it("does not burn the retry budget of the envelopes behind it", () => {
    expect(deliveryUndeliverable(state(0), envelopeMalformed("bad")).retryCount).toBe(1);
  });
});

describe("reportIsConserved", () => {
  function report(overrides: Partial<DrainReport>): DrainReport {
    return { ...emptyDrainReport(), ...overrides };
  }

  it("holds when every claimed envelope has exactly one outcome", () => {
    expect(
      reportIsConserved(report({ claimed: 6, delivered: 2, retried: 1, parked: 1, ignored: 1, discarded: 1 })),
    ).toBe(true);
  });

  it("fails when an envelope was claimed and never accounted for", () => {
    expect(reportIsConserved(report({ claimed: 3, delivered: 2 }))).toBe(false);
  });

  it("excludes pruning, which removes envelopes this pass never claimed", () => {
    expect(reportIsConserved(report({ claimed: 1, delivered: 1, pruned: 40 }))).toBe(true);
  });

  it("holds for an empty pass", () => {
    expect(reportIsConserved(emptyDrainReport())).toBe(true);
  });
});

describe("emptyDrainReport", () => {
  it("reports an absent depth rather than a zero one", () => {
    expect(emptyDrainReport().depth).toBeNull();
  });

  it("carries the reason it did nothing, when there is one", () => {
    expect(emptyDrainReport("sink disabled").stoppedBecause).toBe("sink disabled");
    expect(emptyDrainReport().stoppedBecause).toBeNull();
  });
});

describe("resolveDrainBudget", () => {
  it("falls back to the defaults for an absent request", () => {
    expect(resolveDrainBudget(undefined)).toEqual(DEFAULT_DRAIN_BUDGET);
  });

  it("floors a fractional request rather than rejecting it", () => {
    expect(resolveDrainBudget({ maxRows: 10.9 }).maxRows).toBe(10);
  });

  it("ignores a request that is not a positive count", () => {
    expect(resolveDrainBudget({ maxRows: 0 }).maxRows).toBe(DEFAULT_DRAIN_BUDGET.maxRows);
    expect(resolveDrainBudget({ maxRows: -1 }).maxRows).toBe(DEFAULT_DRAIN_BUDGET.maxRows);
    expect(resolveDrainBudget({ maxRows: Number.NaN }).maxRows).toBe(DEFAULT_DRAIN_BUDGET.maxRows);
  });
});

describe("retentionCutoff", () => {
  it("is the retention window behind the given instant", () => {
    const cutoff = retentionCutoff(NOW);
    expect(NOW.getTime() - cutoff.getTime()).toBe(DELIVERED_RETENTION_DAYS * 86_400_000);
  });
});
