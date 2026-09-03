import { describe, expect, it } from "vitest";
import { asIdentifier, type EnvironmentId } from "@platos/kernel";

import {
  budgetIdempotencyKey,
  claim,
  delivered,
  finaliseClaim,
  finaliseDirect,
  isClaimable,
  isSettled,
  notDelivered,
  proofOf,
  retryRecord,
  testIdempotencyKey,
  withReport,
  EMPTY_SUMMARY,
  type AlertDelivery,
  type ClaimTerms,
} from "./alert-delivery.js";
import {
  asCostIdentifier,
  type AlertChannelId,
  type AlertDeliveryId,
  type ClaimToken,
  type ThresholdEventId,
} from "./identifiers.js";

const AT = new Date("2026-01-15T12:00:00.000Z");
const TERMS: ClaimTerms = { leaseSeconds: 120, retryBackoffSeconds: 30 };
const TOKEN = asCostIdentifier<ClaimToken>("claim-1");
const OTHER_TOKEN = asCostIdentifier<ClaimToken>("claim-2");

function delivery(overrides: Partial<AlertDelivery> = {}): AlertDelivery {
  return {
    deliveryId: asCostIdentifier<AlertDeliveryId>("delivery-1"),
    environmentId: asIdentifier<EnvironmentId>("env-1"),
    channelId: asCostIdentifier<AlertChannelId>("channel-1"),
    eventId: asCostIdentifier<ThresholdEventId>("event-1"),
    kind: "BUDGET",
    idempotencyKey: asCostIdentifier("budget:event-1:channel-1"),
    status: "PENDING",
    retryCount: 0,
    claimGeneration: 0,
    claimToken: null,
    availableAt: AT,
    lastRetryAt: null,
    deliveredAt: null,
    lastStatusCode: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: AT,
    updatedAt: AT,
    ...overrides,
  };
}

describe("idempotency keys", () => {
  it("makes a budget fan-out key stable, so a redelivery finds the same row", () => {
    const key = budgetIdempotencyKey(
      asCostIdentifier<ThresholdEventId>("event-1"),
      asCostIdentifier<AlertChannelId>("channel-1"),
    );
    expect(key).toBe("budget:event-1:channel-1");
  });

  it("makes a probe key unique per invocation, so a second click actually sends", () => {
    const channel = asCostIdentifier<AlertChannelId>("channel-1");
    expect(testIdempotencyKey(channel, "n1")).not.toBe(testIdempotencyKey(channel, "n2"));
  });
});

describe("claimability", () => {
  it("never claims a delivered row, at any time", () => {
    const done = delivery({ status: "SUCCEEDED" });
    expect(isSettled(done)).toBe(true);
    expect(isClaimable(done, new Date("2100-01-01T00:00:00.000Z"))).toBe(false);
  });

  it("claims a pending row once its availability has arrived", () => {
    const later = delivery({ availableAt: new Date("2026-01-15T12:00:01.000Z") });
    expect(isClaimable(later, AT)).toBe(false);
    expect(isClaimable(later, new Date("2026-01-15T12:00:01.000Z"))).toBe(true);
  });

  it("RE-claims a processing row whose lease expired", () => {
    // This is what recovers a delivery whose dispatcher died. Without it, a
    // crashed process leaves an alert permanently owed and permanently unsent.
    const held = delivery({
      status: "PROCESSING",
      availableAt: new Date("2026-01-15T12:02:00.000Z"),
      claimToken: TOKEN,
      claimGeneration: 1,
      retryCount: 1,
    });
    expect(isClaimable(held, new Date("2026-01-15T12:01:59.999Z"))).toBe(false);
    expect(isClaimable(held, new Date("2026-01-15T12:02:00.000Z"))).toBe(true);
  });
});

describe("taking a claim", () => {
  it("writes a token, bumps the generation, consumes a retry and pushes the lease", () => {
    const claimed = claim(delivery(), TOKEN, TERMS, AT);
    if (!claimed.ok) throw new Error("unreachable");
    expect(claimed.value.status).toBe("PROCESSING");
    expect(claimed.value.claimToken).toBe(TOKEN);
    expect(claimed.value.claimGeneration).toBe(1);
    expect(claimed.value.retryCount).toBe(1);
    expect(claimed.value.availableAt).toEqual(new Date("2026-01-15T12:02:00.000Z"));
  });

  it("consumes the retry AT CLAIM TIME, not at finalisation", () => {
    // A dispatcher that claims and then vanishes has still consumed a retry, so
    // a channel whose transport hangs cannot be retried without limit while
    // appearing never to have been tried at all.
    const claimed = claim(delivery({ retryCount: 3 }), TOKEN, TERMS, AT);
    if (!claimed.ok) throw new Error("unreachable");
    expect(claimed.value.retryCount).toBe(4);
  });

  it("refuses a row that is already delivered", () => {
    const denied = claim(delivery({ status: "SUCCEEDED" }), TOKEN, TERMS, AT);
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("COST_DELIVERY_UNAVAILABLE");
  });

  it("refuses a row whose backoff has not elapsed", () => {
    const backing = delivery({ status: "FAILED", availableAt: new Date("2026-01-15T12:00:30.000Z") });
    expect(claim(backing, TOKEN, TERMS, AT).ok).toBe(false);
  });
});

describe("finalising under a claim", () => {
  it("settles a success terminally and dates it now", () => {
    const claimed = claim(delivery(), TOKEN, TERMS, AT);
    if (!claimed.ok) throw new Error("unreachable");
    const proof = proofOf(claimed.value);
    if (!proof.ok) throw new Error("unreachable");
    const settled = finaliseClaim(claimed.value, proof.value, delivered(200), TERMS, AT);
    expect(settled?.status).toBe("SUCCEEDED");
    expect(settled?.deliveredAt).toEqual(AT);
    expect(settled?.claimToken).toBeNull();
    expect(settled?.availableAt).toEqual(AT);
    expect(settled?.lastStatusCode).toBe(200);
  });

  it("settles a failure retryable, behind its backoff, with the reason visible", () => {
    const claimed = claim(delivery(), TOKEN, TERMS, AT);
    if (!claimed.ok) throw new Error("unreachable");
    const proof = proofOf(claimed.value);
    if (!proof.ok) throw new Error("unreachable");
    const settled = finaliseClaim(
      claimed.value,
      proof.value,
      notDelivered("webhook_http_error", "status 503", 503),
      TERMS,
      AT,
    );
    expect(settled?.status).toBe("FAILED");
    expect(settled?.deliveredAt).toBeNull();
    expect(settled?.availableAt).toEqual(new Date("2026-01-15T12:00:30.000Z"));
    expect(settled?.lastErrorCode).toBe("webhook_http_error");
    expect(settled?.lastErrorMessage).toBe("status 503");
  });

  it("writes NOTHING when the token is stale", () => {
    // A slow dispatcher whose lease expired, and whose row was re-claimed and
    // already finalised by someone else, must not overwrite that result — or
    // the alert is sent a third time.
    const claimed = claim(delivery(), TOKEN, TERMS, AT);
    if (!claimed.ok) throw new Error("unreachable");
    const proof = proofOf(claimed.value);
    if (!proof.ok) throw new Error("unreachable");
    const reclaimed = { ...claimed.value, claimToken: OTHER_TOKEN };
    expect(finaliseClaim(reclaimed, proof.value, delivered(200), TERMS, AT)).toBeNull();
  });

  it("writes NOTHING when the generation or the retry number moved", () => {
    const claimed = claim(delivery(), TOKEN, TERMS, AT);
    if (!claimed.ok) throw new Error("unreachable");
    const proof = proofOf(claimed.value);
    if (!proof.ok) throw new Error("unreachable");
    expect(
      finaliseClaim({ ...claimed.value, claimGeneration: 9 }, proof.value, delivered(), TERMS, AT),
    ).toBeNull();
    expect(
      finaliseClaim({ ...claimed.value, retryCount: 9 }, proof.value, delivered(), TERMS, AT),
    ).toBeNull();
  });

  it("writes NOTHING when the row is no longer being processed", () => {
    const claimed = claim(delivery(), TOKEN, TERMS, AT);
    if (!claimed.ok) throw new Error("unreachable");
    const proof = proofOf(claimed.value);
    if (!proof.ok) throw new Error("unreachable");
    expect(
      finaliseClaim({ ...claimed.value, status: "SUCCEEDED" }, proof.value, delivered(), TERMS, AT),
    ).toBeNull();
  });

  it("refuses to produce a proof for an unclaimed row", () => {
    expect(proofOf(delivery()).ok).toBe(false);
  });
});

describe("finalising without a claim", () => {
  it("settles a probe, taking the retry number from the row", () => {
    const settled = finaliseDirect(delivery({ kind: "TEST", retryCount: 2 }), delivered(202), TERMS, AT);
    if (!settled.ok) throw new Error("unreachable");
    expect(settled.value.retryCount).toBe(3);
    expect(settled.value.status).toBe("SUCCEEDED");
  });

  it("REFUSES to settle a budget delivery without a claim", () => {
    // Two live dispatchers over one table with different concurrency
    // assumptions is how a probe and a budget alert come to write the same
    // retry number.
    const denied = finaliseDirect(delivery({ kind: "BUDGET" }), delivered(), TERMS, AT);
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("unreachable");
    expect(denied.error.code).toBe("COST_DELIVERY_UNAVAILABLE");
  });
});

describe("the retry record", () => {
  it("carries the outcome verbatim and is dated at both ends", () => {
    const claimed = claim(delivery(), TOKEN, TERMS, AT);
    if (!claimed.ok) throw new Error("unreachable");
    const record = retryRecord(claimed.value, notDelivered("slack_api_error", "channel_not_found", 200), AT);
    expect(record.retryNumber).toBe(1);
    expect(record.status).toBe("FAILED");
    expect(record.errorCode).toBe("slack_api_error");
    expect(record.responseStatus).toBe(200);
    expect(record.finishedAt).toEqual(AT);
  });
});

describe("the summary", () => {
  it("counts each outcome once and keeps every row", () => {
    const rows = [
      { status: "SUCCEEDED" as const },
      { status: "FAILED" as const },
      { status: "SKIPPED" as const },
      { status: "SUCCEEDED" as const },
    ];
    const summary = rows.reduce(
      (total, row) =>
        withReport(total, {
          deliveryId: asCostIdentifier<AlertDeliveryId>("d"),
          channelId: asCostIdentifier<AlertChannelId>("c"),
          kind: "EMAIL",
          statusCode: null,
          errorCode: null,
          ...row,
        }),
      EMPTY_SUMMARY,
    );
    expect(summary.delivered).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.rows).toHaveLength(4);
  });
});
