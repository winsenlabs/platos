import { asIdentifier } from "@platos/kernel";
import { describe, expect, it } from "vitest";

import {
  admitEvent,
  attachTurn,
  byClaimOrder,
  claimEvent,
  completeEvent,
  discardEvent,
  failEvent,
  holdsLease,
  isClaimable,
  renewLease,
  type ChannelEvent,
  type LeaseHold,
} from "./event-inbox.js";
import type {
  ChannelAppId,
  ChannelEventInboxId,
  LeaseOwner,
  ProviderEventId,
  TurnId,
} from "./identifiers.js";

const EPOCH = new Date("2026-01-01T00:00:00.000Z");
const LEASE_MS = 60_000;

const owner = (value = "worker-1"): LeaseOwner => asIdentifier<LeaseOwner>(value);

function seed(overrides: Partial<ChannelEvent> = {}): ChannelEvent {
  const base = admitEvent({
    inboxId: asIdentifier<ChannelEventInboxId>("inbox-1"),
    appId: asIdentifier<ChannelAppId>("app-1"),
    eventId: asIdentifier<ProviderEventId>("Ev1"),
    payload: { formatVersion: 1, keyVersion: 7, ciphertext: "sealed" },
    now: EPOCH,
  });
  return { ...base, ...overrides };
}

function claim(event: ChannelEvent, at: Date, by = owner()): { event: ChannelEvent; hold: LeaseHold } {
  const result = claimEvent(event, by, LEASE_MS, at);
  if (!result.ok) throw new Error(`expected claim to succeed, got ${result.error.code}`);
  return result.value;
}

const later = (ms: number): Date => new Date(EPOCH.getTime() + ms);

describe("admitEvent", () => {
  it("is immediately claimable and never yet retried", () => {
    const event = seed();
    expect(event.status).toBe("PENDING");
    expect(event.retryCount).toBe(0);
    expect(event.leaseGeneration).toBe(0);
    expect(event.availableAt).toEqual(EPOCH);
    expect(isClaimable(event, EPOCH)).toBe(true);
  });

  it("carries both payload versions, so a rotated key can still be decoded", () => {
    expect(seed().payload).toEqual({ formatVersion: 1, keyVersion: 7, ciphertext: "sealed" });
  });
});

describe("isClaimable", () => {
  it("admits a PENDING row whose backoff has elapsed", () => {
    expect(isClaimable(seed({ status: "PENDING", availableAt: later(-1) }), EPOCH)).toBe(true);
  });

  it("refuses a PENDING row that is still backing off", () => {
    expect(isClaimable(seed({ status: "PENDING", availableAt: later(1) }), EPOCH)).toBe(false);
  });

  it("admits a FAILED row whose backoff has elapsed, so a retry is possible", () => {
    expect(isClaimable(seed({ status: "FAILED", availableAt: EPOCH }), EPOCH)).toBe(true);
  });

  it("admits a PROCESSING row whose lease expired, so a dead worker is recovered", () => {
    const event = seed({ status: "PROCESSING", leaseExpiresAt: later(-1) });
    expect(isClaimable(event, EPOCH)).toBe(true);
  });

  it("refuses a PROCESSING row whose lease expires exactly NOW", () => {
    // The boundary is strictly `<`: a lease expiring this instant is still
    // held. Claim and fence must agree here or a row is briefly claimable twice.
    const event = seed({ status: "PROCESSING", leaseExpiresAt: EPOCH });
    expect(isClaimable(event, EPOCH)).toBe(false);
  });

  it.each([["COMPLETED"], ["DISCARDED"]])("never admits a terminal %s row", (status) => {
    const event = seed({ status: status as ChannelEvent["status"], availableAt: later(-1) });
    expect(isClaimable(event, EPOCH)).toBe(false);
  });
});

describe("claimEvent", () => {
  it("takes the lease and bumps retry and generation together", () => {
    const { event, hold } = claim(seed(), EPOCH);
    expect(event.status).toBe("PROCESSING");
    expect(event.retryCount).toBe(1);
    expect(event.leaseGeneration).toBe(1);
    expect(event.leaseOwner).toBe("worker-1");
    expect(event.leaseExpiresAt).toEqual(later(LEASE_MS));
    expect(hold).toEqual({ leaseOwner: "worker-1", leaseGeneration: 1 });
  });

  it("refuses a row that is not claimable", () => {
    const result = claimEvent(seed({ status: "COMPLETED" }), owner(), LEASE_MS, EPOCH);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_EVENT_NOT_CLAIMABLE");
  });

  it("gives a reclaim a HIGHER generation, so the stale holder is fenced out", () => {
    const first = claim(seed(), EPOCH, owner("worker-1"));
    const second = claim(first.event, later(LEASE_MS + 1), owner("worker-2"));
    expect(second.hold.leaseGeneration).toBe(first.hold.leaseGeneration + 1);
    expect(holdsLease(second.event, first.hold)).toBe(false);
  });

  it("fences the SAME worker's stale retry after it reclaims the row", () => {
    // Owner alone cannot separate these two retries — only the generation can.
    const first = claim(seed(), EPOCH, owner("worker-1"));
    const second = claim(first.event, later(LEASE_MS + 1), owner("worker-1"));
    expect(second.event.leaseOwner).toBe(first.event.leaseOwner);
    expect(holdsLease(second.event, first.hold)).toBe(false);
    expect(holdsLease(second.event, second.hold)).toBe(true);
  });
});

describe("holdsLease", () => {
  it("accepts the current holder", () => {
    const { event, hold } = claim(seed(), EPOCH);
    expect(holdsLease(event, hold)).toBe(true);
  });

  it("rejects a different owner at the same generation", () => {
    const { event, hold } = claim(seed(), EPOCH);
    expect(holdsLease(event, { ...hold, leaseOwner: owner("other") })).toBe(false);
  });

  it("rejects the right owner at a stale generation", () => {
    const { event, hold } = claim(seed(), EPOCH);
    expect(holdsLease(event, { ...hold, leaseGeneration: hold.leaseGeneration - 1 })).toBe(false);
  });

  it("rejects a row that already reached a terminal state", () => {
    const { event, hold } = claim(seed(), EPOCH);
    const completed = completeEvent(event, hold, later(1));
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(holdsLease(completed.value, hold)).toBe(false);
  });
});

describe("the terminal transitions", () => {
  it("completes, releasing the lease so the row can never look claimable again", () => {
    const { event, hold } = claim(seed(), EPOCH);
    const completed = completeEvent(event, hold, later(1));
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.status).toBe("COMPLETED");
    expect(completed.value.completedAt).toEqual(later(1));
    expect(completed.value.leaseOwner).toBeNull();
    expect(completed.value.leaseExpiresAt).toBeNull();
    expect(isClaimable(completed.value, later(999_999))).toBe(false);
  });

  it("fails back to the queue behind a backoff, keeping the retry count", () => {
    const { event, hold } = claim(seed(), EPOCH);
    const failed = failEvent(event, hold, "BOOM", 30_000, later(1));
    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.value.status).toBe("FAILED");
    expect(failed.value.availableAt).toEqual(later(30_001));
    expect(failed.value.retryCount).toBe(1);
    expect(failed.value.lastErrorCode).toBe("BOOM");
    expect(isClaimable(failed.value, later(1))).toBe(false);
    expect(isClaimable(failed.value, later(30_001))).toBe(true);
  });

  it("discards terminally, distinguishably from a completion", () => {
    const { event, hold } = claim(seed(), EPOCH);
    const discarded = discardEvent(event, hold, "POISON", later(1));
    expect(discarded.ok).toBe(true);
    if (!discarded.ok) return;
    expect(discarded.value.status).toBe("DISCARDED");
    expect(discarded.value.lastErrorCode).toBe("POISON");
    expect(isClaimable(discarded.value, later(999_999))).toBe(false);
  });

  it.each([
    ["renew", (event: ChannelEvent, hold: LeaseHold) => renewLease(event, hold, LEASE_MS, later(1))],
    ["attachTurn", (event: ChannelEvent, hold: LeaseHold) => attachTurn(event, hold, asIdentifier<TurnId>("turn-1"))],
    ["complete", (event: ChannelEvent, hold: LeaseHold) => completeEvent(event, hold, later(1))],
    ["fail", (event: ChannelEvent, hold: LeaseHold) => failEvent(event, hold, "X", 1, later(1))],
    ["discard", (event: ChannelEvent, hold: LeaseHold) => discardEvent(event, hold, "X", later(1))],
  ])("%s refuses a lost lease", (_label, act) => {
    const first = claim(seed(), EPOCH, owner("worker-1"));
    const stolen = claim(first.event, later(LEASE_MS + 1), owner("worker-2"));
    const result = act(stolen.event, first.hold);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("CHANNELS_EVENT_LEASE_LOST");
  });
});

describe("renewLease", () => {
  it("extends the expiry from NOW, not from the original claim", () => {
    const { event, hold } = claim(seed(), EPOCH);
    const renewed = renewLease(event, hold, LEASE_MS, later(30_000));
    expect(renewed.ok).toBe(true);
    if (!renewed.ok) return;
    expect(renewed.value.leaseExpiresAt).toEqual(later(30_000 + LEASE_MS));
  });
});

describe("attachTurn", () => {
  it("records the turn without releasing the lease", () => {
    const { event, hold } = claim(seed(), EPOCH);
    const attached = attachTurn(event, hold, asIdentifier<TurnId>("turn-1"));
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    expect(attached.value.turnId).toBe("turn-1");
    expect(attached.value.status).toBe("PROCESSING");
    expect(holdsLease(attached.value, hold)).toBe(true);
  });
});

describe("byClaimOrder", () => {
  it("puts the oldest available first", () => {
    const early = seed({ availableAt: later(1) });
    const late = seed({ availableAt: later(2) });
    expect([late, early].sort(byClaimOrder)[0]).toBe(early);
  });

  it("breaks a tie on creation, so a row cannot be starved", () => {
    const first = seed({ availableAt: EPOCH, createdAt: later(1) });
    const second = seed({ availableAt: EPOCH, createdAt: later(2) });
    expect([second, first].sort(byClaimOrder)[0]).toBe(first);
  });
});
