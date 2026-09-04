import { asIdentifier } from "@platos/kernel";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_DRAIN_BUDGET,
  reportIsConserved,
  sinkHealth,
  TURN_FINALIZED_EVENT,
  TURN_ROWS_EVENT,
  type EnvelopeId,
} from "../domain/index.js";
import { drainProjections, narrowBudget } from "./drain-projections.js";
import {
  buildObservabilityTestContext,
  testEnvelope,
  testFinalizedPayload,
  testScope,
  TEST_TURN_UUID,
  type ObservabilityTestContext,
} from "./testing/index.js";

function finalized(context: ObservabilityTestContext, overrides: Record<string, unknown> = {}): EnvelopeId {
  return context.outbox.enqueue(testEnvelope(TURN_FINALIZED_EVENT, testFinalizedPayload(overrides)));
}

describe("drainProjections — the sink guard runs FIRST", () => {
  let context: ObservabilityTestContext;

  beforeEach(() => {
    context = buildObservabilityTestContext();
  });

  it("claims nothing when the sink is disabled, and loses nothing", async () => {
    finalized(context);
    context.sink.health = sinkHealth("disabled", "no endpoint configured");

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.claimed).toBe(0);
    expect(drained.value.stoppedBecause).toBe("sink disabled");
    expect(context.outbox.size).toBe(1);
    expect(context.outbox.find(asIdentifier<EnvelopeId>("envelope-0001"))?.status).toBe("PENDING");
  });

  it("claims nothing when the schema is missing, rather than parking a healthy backlog", async () => {
    finalized(context);
    context.sink.health = sinkHealth("schema_missing", "no turns_v1", ["turns_v1"]);

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.claimed).toBe(0);
    expect(drained.value.parked).toBe(0);
    expect(context.sink.callsTo("insert")).toHaveLength(0);
  });

  it("reports the depth even on a pass that did nothing", async () => {
    finalized(context);
    context.sink.health = sinkHealth("disabled", "none");

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.depth).toEqual({ pending: 1, failed: 0 });
  });

  it("degrades rather than aborts when the probe THROWS", async () => {
    finalized(context);
    context.sink.probeThrows = true;

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.stoppedBecause).toBe("sink unreachable");
  });

  it("says a chosen absence at info and an outage at warn", async () => {
    context.sink.health = sinkHealth("disabled", "none");
    await drainProjections(context.dependencies);
    expect(context.logger.at("info")).toHaveLength(1);

    context.sink.health = sinkHealth("unreachable", "timeout");
    await drainProjections(context.dependencies);
    expect(context.logger.at("warn")).toHaveLength(1);
  });
});

describe("drainProjections — delivery", () => {
  let context: ObservabilityTestContext;

  beforeEach(() => {
    context = buildObservabilityTestContext();
  });

  it("delivers a well-formed envelope and acknowledges it", async () => {
    const envelopeId = finalized(context);

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.delivered).toBe(1);
    expect(drained.value.claimed).toBe(1);
    expect(context.sink.rows("turns_v1")).toHaveLength(1);
    expect(context.sink.rows("turns_v1")[0]?.turn_id).toBe(TEST_TURN_UUID);
    expect(context.outbox.find(envelopeId)?.status).toBe("DELIVERED");
  });

  it("accounts for every claimed envelope exactly once", async () => {
    finalized(context);
    context.outbox.enqueue(testEnvelope("eventing.notification.requested", {}));
    context.outbox.enqueue(testEnvelope(TURN_FINALIZED_EVENT, { turn: "not an object" }));

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.claimed).toBe(3);
    expect(reportIsConserved(drained.value)).toBe(true);
    expect(drained.value.delivered).toBe(1);
    expect(drained.value.ignored).toBe(1);
    expect(drained.value.parked).toBe(1);
  });

  it("IGNORES another drain's envelope rather than parking it", async () => {
    const envelopeId = context.outbox.enqueue(testEnvelope("eventing.notification.requested", {}));

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.ignored).toBe(1);
    expect(drained.value.parked).toBe(0);
    expect(drained.value.depth).toEqual({ pending: 0, failed: 0 });
    expect(context.outbox.find(envelopeId)?.status).toBe("DELIVERED");
    expect(context.sink.callsTo("insert")).toHaveLength(0);
  });

  it("parks an envelope from a newer writer immediately, without burning retries", async () => {
    const envelopeId = context.outbox.enqueue(
      testEnvelope(TURN_FINALIZED_EVENT, testFinalizedPayload(), { schemaVersion: 9 }),
    );

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.parked).toBe(1);
    const parked = context.outbox.find(envelopeId);
    expect(parked?.status).toBe("FAILED");
    expect(parked?.retryCount).toBe(1);
    expect(parked?.lastErrorCode).toBe("OBSERVABILITY_ENVELOPE_VERSION_UNSUPPORTED");
  });

  it("reschedules a delivery the sink refused, and does not lose it", async () => {
    const envelopeId = finalized(context);
    context.sink.insertFails = true;

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.retried).toBe(1);
    expect(drained.value.parked).toBe(0);
    const entry = context.outbox.find(envelopeId);
    expect(entry?.status).toBe("PENDING");
    expect(entry?.availableAt.getTime()).toBe(context.clock.now().getTime() + 30_000);
  });

  it("does not re-claim an envelope before its back-off has elapsed", async () => {
    finalized(context);
    context.sink.insertFails = true;
    await drainProjections(context.dependencies);

    context.sink.insertFails = false;
    const immediate = await drainProjections(context.dependencies);
    if (!immediate.ok) throw new Error(immediate.error.code);
    expect(immediate.value.claimed).toBe(0);

    context.clock.advanceSeconds(31);
    const later = await drainProjections(context.dependencies);
    if (!later.ok) throw new Error(later.error.code);
    expect(later.value.delivered).toBe(1);
  });

  it("parks an envelope once its retries are exhausted, and says so at error level", async () => {
    const envelopeId = context.outbox.enqueue(
      testEnvelope(TURN_FINALIZED_EVENT, testFinalizedPayload()),
      { retryCount: DEFAULT_DRAIN_BUDGET.maxRetries - 1 },
    );
    context.sink.insertFails = true;

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.parked).toBe(1);
    expect(context.outbox.find(envelopeId)?.status).toBe("FAILED");
    expect(context.logger.at("error")).toHaveLength(1);
  });

  it("keeps a parked envelope out of every later claim, and visible in the depth", async () => {
    context.outbox.enqueue(testEnvelope(TURN_FINALIZED_EVENT, testFinalizedPayload(), { schemaVersion: 9 }));
    await drainProjections(context.dependencies);

    const second = await drainProjections(context.dependencies);
    if (!second.ok) throw new Error(second.error.code);
    expect(second.value.claimed).toBe(0);
    expect(second.value.parked).toBe(0);
    // The number an operator has to explain, still reported on a quiet pass.
    expect(second.value.depth).toEqual({ pending: 0, failed: 1 });
  });

  it("drains the pre-V1 row payload too, so an existing queue is not abandoned", async () => {
    context.outbox.enqueue(
      testEnvelope(TURN_ROWS_EVENT, { turns_v1: [{ organization_id: "org-1", turn_id: TEST_TURN_UUID }] }),
    );

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.delivered).toBe(1);
    expect(context.sink.rows("turns_v1")).toHaveLength(1);
  });
});

describe("drainProjections — the erasure guard", () => {
  let context: ObservabilityTestContext;

  beforeEach(() => {
    context = buildObservabilityTestContext();
  });

  it("DESTROYS an undelivered projection for an erased subject rather than inserting it", async () => {
    const envelopeId = finalized(context, {
      turn: { ...(testFinalizedPayload().turn as object), subject: { endUserId: "end-user-1" } },
    });
    context.erasedSubjects.markErased("org-1", "end-user-1");

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.discarded).toBe(1);
    expect(drained.value.delivered).toBe(0);
    expect(context.sink.callsTo("insert")).toHaveLength(0);
    expect(context.outbox.find(envelopeId)).toBeUndefined();
    expect(context.logger.at("warn")).toHaveLength(1);
  });

  it("delivers a projection for a subject who has not been erased", async () => {
    finalized(context, {
      turn: { ...(testFinalizedPayload().turn as object), subject: { endUserId: "end-user-2" } },
    });
    context.erasedSubjects.markErased("org-1", "end-user-1");

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.delivered).toBe(1);
    expect(drained.value.discarded).toBe(0);
  });

  it("scopes the register question to the envelope's organization", async () => {
    finalized(context, {
      turn: { ...(testFinalizedPayload().turn as object), subject: { endUserId: "end-user-1" } },
    });
    // The same id, erased in a DIFFERENT tenant, must not discard this one.
    context.erasedSubjects.markErased("org-other", "end-user-1");

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.delivered).toBe(1);
    expect(context.erasedSubjects.queries[0]?.organizationId).toBe("org-1");
  });

  it("still accounts for a discarded envelope another drain removed first", async () => {
    finalized(context, {
      turn: { ...(testFinalizedPayload().turn as object), subject: { endUserId: "end-user-1" } },
    });
    context.erasedSubjects.markErased("org-1", "end-user-1");
    // A concurrent drain got there first: the queue removes nothing.
    context.outbox.discard = async () => ({ ok: true, value: 0 });

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    // The tally counts what THIS PASS accounted for, so the claimed envelope is
    // not left counted nowhere.
    expect(drained.value.discarded).toBe(1);
    expect(reportIsConserved(drained.value)).toBe(true);
  });

  it("FAILS CLOSED: a register that cannot answer refuses the pass", async () => {
    const envelopeId = finalized(context, {
      turn: { ...(testFinalizedPayload().turn as object), subject: { endUserId: "end-user-1" } },
    });
    context.erasedSubjects.lookupFails = true;

    const drained = await drainProjections(context.dependencies);
    expect(drained.ok).toBe(false);
    expect(context.sink.callsTo("insert")).toHaveLength(0);
    expect(context.outbox.find(envelopeId)?.status).toBe("PENDING");
  });

  it("does not ask the register about an envelope that names no subject", async () => {
    finalized(context);

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.delivered).toBe(1);
    expect(context.erasedSubjects.queries).toHaveLength(0);
  });
});

describe("drainProjections — the loop", () => {
  let context: ObservabilityTestContext;

  beforeEach(() => {
    context = buildObservabilityTestContext({ ...DEFAULT_DRAIN_BUDGET, claimBatchSize: 2 });
  });

  it("keeps claiming past one batch, so throughput is not capped by the claim size", async () => {
    for (let index = 0; index < 5; index += 1) finalized(context);

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.claimed).toBe(5);
    expect(drained.value.delivered).toBe(5);
    expect(drained.value.passes).toBe(3);
    expect(drained.value.stoppedBecause).toBe("queue is empty");
  });

  it("stops at the row budget and says so", async () => {
    // NOTE THE DIRECTION: this call NARROWS. It proves the loop honours a
    // ceiling; it does not prove the ceiling cannot be RAISED, which is the
    // security half and is asserted by the two cases below.
    for (let index = 0; index < 5; index += 1) finalized(context);

    const drained = await drainProjections(context.dependencies, { budget: { maxRows: 3 } });
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.claimed).toBe(3);
    expect(drained.value.stoppedBecause).toBe("row budget (3) reached");
    expect(drained.value.depth).toEqual({ pending: 2, failed: 0 });
  });

  it("REFUSES a widening maxRows AT THE CALL SITE, not only inside narrowBudget", async () => {
    // WHY THE `narrowBudget` UNIT CASES BELOW DO NOT COVER THIS. They prove the
    // FUNCTION clamps. They say nothing about whether `drainProjections` still
    // CALLS it. Replacing the one call at the top of `drainProjections` with
    // `{ ...dependencies.budget, ...command.budget }` left all 279 cases green —
    // observed, not assumed — because every budget-bearing call in this file
    // NARROWS, and a narrowing request survives a bypass unchanged. The
    // 2026-09-03 independent verification found exactly that: the commit's own
    // "budget narrowing" mutation control was reproducible inside the function
    // and NOT at the call site.
    //
    // `application/observability-contract.ts` forwards `request?.budget` from
    // the published contract straight into this call, so the call site is the
    // real boundary, and a caller who can raise the installation's ceiling has
    // no ceiling at all.
    const bounded = buildObservabilityTestContext({
      ...DEFAULT_DRAIN_BUDGET,
      claimBatchSize: 2,
      maxRows: 2,
    });
    for (let index = 0; index < 5; index += 1) finalized(bounded);

    const drained = await drainProjections(bounded.dependencies, { budget: { maxRows: 100 } });
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.claimed).toBe(2);
    expect(drained.value.stoppedBecause).toBe("row budget (2) reached");
    // The three the widened ceiling would have swallowed are still queued.
    expect(drained.value.depth).toEqual({ pending: 3, failed: 0 });
  });

  it("REFUSES a widening maxRetries AT THE CALL SITE, so a caller cannot postpone parking", async () => {
    // The SECOND axis. There is one `narrowBudget` call, so either case catches
    // a wholesale bypass; two are kept because a bypass that spreads only ONE
    // field past the clamp would slip through a single-axis control, and because
    // the two fields fail differently — one bounds the loop, this one bounds how
    // long an undeliverable envelope keeps circulating instead of being parked
    // where an operator has to explain it.
    //
    // Configured at one try: the first failure exhausts the budget and PARKS.
    const bounded = buildObservabilityTestContext({ ...DEFAULT_DRAIN_BUDGET, maxRetries: 1 });
    finalized(bounded);
    bounded.sink.insertFails = true;

    const drained = await drainProjections(bounded.dependencies, { budget: { maxRetries: 9_999 } });
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.parked).toBe(1);
    expect(drained.value.retried).toBe(0);
  });

  it("stops at the wall clock and leaves the rest queued", async () => {
    for (let index = 0; index < 6; index += 1) finalized(context);
    // The clock is a port, so "time passed during delivery" is arranged rather
    // than waited for. Each insert advances it past the deadline.
    const realInsert = context.sink.insert.bind(context.sink);
    context.sink.insert = async (rows) => {
      context.clock.advanceMs(1_000);
      return realInsert(rows);
    };

    const drained = await drainProjections(context.dependencies, { budget: { deadlineMs: 1 } });
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.passes).toBe(1);
    expect(drained.value.claimed).toBe(2);
    expect(drained.value.stoppedBecause).toBe("deadline reached after 2 envelopes");
    expect(drained.value.depth).toEqual({ pending: 4, failed: 0 });
  });

  it("stops at an empty queue without a wasted claim", async () => {
    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.passes).toBe(0);
    expect(drained.value.stoppedBecause).toBe("queue is empty");
  });

  it("aborts the pass rather than reporting success when the queue read fails", async () => {
    context.outbox.claimFails = true;
    const drained = await drainProjections(context.dependencies);
    expect(drained.ok).toBe(false);
  });

  it("aborts rather than double-delivering when a settle fails", async () => {
    finalized(context);
    context.outbox.settleFails = true;
    const drained = await drainProjections(context.dependencies);
    expect(drained.ok).toBe(false);
  });
});

describe("drainProjections — pruning and depth", () => {
  let context: ObservabilityTestContext;

  beforeEach(() => {
    context = buildObservabilityTestContext();
  });

  it("prunes an acknowledged envelope once its retention has elapsed", async () => {
    finalized(context);
    await drainProjections(context.dependencies);
    expect(context.outbox.size).toBe(1);

    context.clock.advanceSeconds(8 * 86_400);
    const swept = await drainProjections(context.dependencies);
    if (!swept.ok) throw new Error(swept.error.code);
    expect(swept.value.pruned).toBe(1);
    expect(context.outbox.size).toBe(0);
  });

  it("NEVER prunes a parked envelope by age — that is the silent loss the queue replaced", async () => {
    context.outbox.enqueue(testEnvelope(TURN_FINALIZED_EVENT, testFinalizedPayload(), { schemaVersion: 9 }));
    await drainProjections(context.dependencies);

    context.clock.advanceSeconds(400 * 86_400);
    const swept = await drainProjections(context.dependencies);
    if (!swept.ok) throw new Error(swept.error.code);
    expect(swept.value.pruned).toBe(0);
    expect(swept.value.depth).toEqual({ pending: 0, failed: 1 });
  });

  it("omits the depth rather than reporting zero when it cannot be read", async () => {
    context.outbox.depthFails = true;
    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.depth).toBeNull();
  });
});

describe("narrowBudget", () => {
  it("lets a caller lower a ceiling", () => {
    expect(narrowBudget(DEFAULT_DRAIN_BUDGET, { maxRows: 10 }).maxRows).toBe(10);
  });

  it("REFUSES to let a caller raise one", () => {
    const raised = narrowBudget(DEFAULT_DRAIN_BUDGET, {
      maxRows: DEFAULT_DRAIN_BUDGET.maxRows * 100,
      maxRetries: 9_999,
    });
    expect(raised.maxRows).toBe(DEFAULT_DRAIN_BUDGET.maxRows);
    expect(raised.maxRetries).toBe(DEFAULT_DRAIN_BUDGET.maxRetries);
  });

  it("keeps the configured ceiling for an absent or nonsense request", () => {
    expect(narrowBudget(DEFAULT_DRAIN_BUDGET, undefined)).toEqual(DEFAULT_DRAIN_BUDGET);
    expect(narrowBudget(DEFAULT_DRAIN_BUDGET, { maxRows: 0 }).maxRows).toBe(DEFAULT_DRAIN_BUDGET.maxRows);
    expect(narrowBudget(DEFAULT_DRAIN_BUDGET, { maxRows: -3 }).maxRows).toBe(DEFAULT_DRAIN_BUDGET.maxRows);
  });
});

describe("drainProjections — tenancy", () => {
  it("keeps each envelope's own scope on its rows across a mixed-tenant batch", async () => {
    const context = buildObservabilityTestContext();
    context.outbox.enqueue(testEnvelope(TURN_FINALIZED_EVENT, testFinalizedPayload()));
    context.outbox.enqueue(
      testEnvelope(TURN_FINALIZED_EVENT, testFinalizedPayload(), { scope: testScope("env-2") }),
    );

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.delivered).toBe(2);
    expect(context.sink.rows("turns_v1").map((row) => row.environment_id)).toEqual(["env-1", "env-2"]);
  });
});
