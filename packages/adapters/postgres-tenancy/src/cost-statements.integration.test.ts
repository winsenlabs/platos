// Statement counts, MEASURED — the N+1 control for `cost-monitoring`'s reads.
//
// EVERY PIN IS TAKEN TWICE, over a small environment and one an order of
// magnitude larger, and both must be identical. A read whose cost grows with the
// rows it returns is correct in every case and expensive in exactly one: the
// installation that has been running longest. Two of these reads join —
// `listDeliveriesForEvent` walks a delivery to its channel to that channel's
// configuration, and `listPendingCrossings` walks a delivery to its crossing, to
// its cap, and up the tenant chain to the project — so both are places a
// per-row query would be invisible until it was slow.
//
// THE PROBE PATTERN IS ANCHORED, and this is tranche 3's trap rather than a
// precaution. Its advisory lock projected `SELECT 1`, which is exactly the shape
// the statement suites strip to discard the driver's connection probe, so the
// lock was measured at ZERO statements and a mutation that removed it survived.
// The filter below therefore anchors the probe to a statement that is ONLY
// `SELECT 1`, and every measurement records the unfiltered count beside the
// filtered one so a suite can assert what the filter actually removed.

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import type {
  AlertDelivery,
  EnvironmentScope,
  ThresholdEventId,
} from "@platos/context-cost-monitoring/application/ports/index.js";
import { asCostIdentifier } from "@platos/context-cost-monitoring/application/ports/index.js";
import { runResult } from "@platos/kernel";

import { AT, conformanceBudget, conformanceChannel } from "./cost-conformance.js";
import type { CostHarness } from "./cost-harness.js";
import { startCostHarness } from "./cost-harness.js";

let harness: CostHarness;
let sequence = 0;

interface Fixture {
  readonly scope: EnvironmentScope;
  readonly capId: string;
  readonly crossingId: string;
  readonly channelIds: readonly string[];
  readonly deliveryId: string;
}

let small: Fixture;
let large: Fixture;

/** 8-4-4-4-12, version nibble 7, variant 8. A wrong-length group is refused. */
function uuid(): string {
  sequence += 1;
  const tail = sequence.toString(16).padStart(4, "0");
  return `01926fa0-${tail}-7000-8000-${tail.padStart(12, "0")}`;
}

/**
 * Statements the CLIENT sent, less the transaction frame.
 *
 * `BEGIN`/`COMMIT`/`ROLLBACK`/`DEALLOCATE` are the driver's bookkeeping and are
 * not what an N+1 is made of. `SELECT 1` is the driver's connection probe and is
 * matched ONLY when the whole statement is that and nothing else, so a read that
 * genuinely projects a constant cannot be discarded by the thing measuring it.
 */
function queries(): readonly string[] {
  return harness.base
    .statements()
    .filter(
      (statement) =>
        !/^\s*(BEGIN|COMMIT|ROLLBACK|DEALLOCATE)\b/iu.test(statement) &&
        !/^\s*SELECT\s+1\s*$/iu.test(statement),
    );
}

interface Measurement {
  readonly counted: number;
  readonly total: number;
}

async function measure(work: () => Promise<unknown>): Promise<Measurement> {
  harness.base.resetStatements();
  await work();
  return { counted: queries().length, total: harness.base.statements().length };
}

function delivery(
  fixture: Pick<Fixture, "scope" | "crossingId">,
  deliveryId: string,
  channelId: string,
  offset: number,
): AlertDelivery {
  return {
    deliveryId: asCostIdentifier(deliveryId),
    environmentId: asCostIdentifier(fixture.scope.environmentId),
    channelId: asCostIdentifier(channelId),
    eventId: asCostIdentifier<ThresholdEventId>(fixture.crossingId),
    kind: "BUDGET",
    idempotencyKey: asCostIdentifier(`budget:${fixture.crossingId}:${channelId}`),
    status: "PENDING",
    retryCount: 0,
    claimGeneration: 0,
    claimToken: null,
    availableAt: new Date(AT.getTime() + offset),
    lastRetryAt: null,
    deliveredAt: null,
    lastStatusCode: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: new Date(AT.getTime() + offset),
    updatedAt: AT,
  };
}

async function seed(caps: number, channels: number): Promise<Fixture> {
  const scope = await harness.freshScope();
  const capId = uuid();
  const crossingId = uuid();
  const channelIds: string[] = [];
  await harness.base.adapter.unitOfWork.run(async (transaction) => {
    await harness.repository.insertBudget(conformanceBudget(scope, capId, "scope"), transaction);
    for (let index = 1; index < caps; index += 1) {
      await harness.repository.insertBudget(
        conformanceBudget(scope, uuid(), index % 2 === 0 ? "agent" : "user"),
        transaction,
      );
    }
    await harness.repository.insertThresholdEvent(
      {
        eventId: asCostIdentifier<ThresholdEventId>(crossingId),
        environmentId: asCostIdentifier(scope.environmentId),
        budgetId: asCostIdentifier(capId),
        windowKey: asCostIdentifier("2026-08-01"),
        threshold: 50,
        spent: { microCents: 500_000_000n, currency: asCostIdentifier("USD") },
        tasks: 1,
        createdAt: AT,
      },
      transaction,
    );
    for (let index = 0; index < channels; index += 1) {
      const channelId = uuid();
      channelIds.push(channelId);
      await harness.repository.insertAlertChannel(
        conformanceChannel(scope, channelId, {
          name: `channel ${index}`,
          createdAt: new Date(AT.getTime() + index),
          updatedAt: new Date(AT.getTime() + index),
        }),
        transaction,
      );
    }
    await harness.repository.insertDeliveries(
      channelIds.map((channelId, index) =>
        delivery({ scope, crossingId }, uuid(), channelId, index),
      ),
      transaction,
    );
  });
  const first = await harness.repository.listDeliveriesForEvent(
    scope,
    asCostIdentifier(crossingId),
  );
  const deliveryId = first.ok ? (first.value[0]?.delivery.deliveryId ?? "") : "";
  return { scope, capId, crossingId, channelIds, deliveryId };
}

beforeAll(async () => {
  harness = await startCostHarness();
  small = await seed(3, 2);
  large = await seed(30, 25);
}, 600_000);

afterAll(async () => {
  await harness?.stop();
});

/** Every read, measured over both fixtures. The pair must agree. */
const READS: readonly {
  readonly name: string;
  readonly pin: number;
  readonly run: (fixture: Fixture) => Promise<unknown>;
}[] = [
  { name: "listBudgets", pin: 1, run: (f) => harness.repository.listBudgets(f.scope) },
  {
    name: "pageBudgets",
    pin: 1,
    // ONE statement, and the page and its total come from the SAME read — a
    // separate `count` would be a second statement AND a second snapshot.
    run: (f) => harness.repository.pageBudgets(f.scope, { limit: 2, offset: 0 }),
  },
  {
    name: "findBudget",
    pin: 1,
    run: (f) => harness.repository.findBudget(f.scope, asCostIdentifier(f.capId)),
  },
  {
    name: "listRecordedThresholds",
    pin: 1,
    run: (f) =>
      harness.repository.listRecordedThresholds(
        f.scope,
        asCostIdentifier(f.capId),
        asCostIdentifier("2026-08-01"),
      ),
  },
  {
    name: "listAlertChannels",
    pin: 2,
    run: (f) =>
      harness.repository.listAlertChannels(f.scope, { kind: null, enabled: null, limit: 50 }),
  },
  {
    name: "findAlertChannel",
    pin: 2,
    run: (f) =>
      harness.repository.findAlertChannel(f.scope, asCostIdentifier(f.channelIds[0] ?? "")),
  },
  {
    name: "countChannelsUsingCredential",
    pin: 1,
    run: (f) => harness.repository.countChannelsUsingCredential(f.scope, uuid()),
  },
  {
    name: "listDeliveriesForEvent",
    pin: 3,
    // Deliveries, then their channels, then those channels' configurations —
    // THREE statements whatever the page holds, not one per delivery.
    run: (f) =>
      harness.repository.listDeliveriesForEvent(f.scope, asCostIdentifier(f.crossingId)),
  },
  {
    name: "findDelivery",
    pin: 3,
    run: (f) => harness.repository.findDelivery(f.scope, asCostIdentifier(f.deliveryId)),
  },
  {
    name: "listPendingCrossings",
    pin: 1,
    // ONE statement, and it is the only hand-written SQL in this half of the
    // adapter: `DISTINCT ON` collapses the deliveries to one row per crossing
    // and the joins re-derive the tenant chain in the same pass.
    run: () => harness.repository.listPendingCrossings(["PENDING"], new Date("2026-09-01"), 10),
  },
];

/** Every read measured over one fixture, as a map from name to count. */
async function measureReads(fixture: Fixture): Promise<Record<string, Measurement>> {
  const measured: Record<string, Measurement> = {};
  for (const read of READS) {
    measured[read.name] = await measure(() => read.run(fixture));
  }
  return measured;
}

describe("every read costs the same over a small environment and a large one", () => {
  test("each read's statement count matches its pin, over BOTH sizes", async () => {
    // ONE case over the whole map rather than one per read — the census refuses
    // a `test()` declared in a loop, and the map is the better instrument
    // anyway: a divergence names the read and shows both counts, and a read
    // somebody forgot to measure cannot exist.
    const overSmall = await measureReads(small);
    const overLarge = await measureReads(large);
    const pins = Object.fromEntries(READS.map((read) => [read.name, read.pin]));
    expect(Object.fromEntries(Object.entries(overSmall).map(([n, m]) => [n, m.counted]))).toEqual(
      pins,
    );
    expect(Object.fromEntries(Object.entries(overLarge).map(([n, m]) => [n, m.counted]))).toEqual(
      pins,
    );
  });

  test("nothing the reads sent was discarded by the filter that counts them", async () => {
    // THE ANCHOR. Tranche 3's advisory lock projected `SELECT 1`, which is the
    // shape these suites strip to discard the driver's connection probe, so the
    // lock measured ZERO statements and the mutation that removed it survived.
    // A read outside a transaction sends no frame either, so for every read the
    // filtered and unfiltered counts must be EQUAL — which is what stops the
    // measurement from hiding the thing it measures.
    const overSmall = await measureReads(small);
    const overLarge = await measureReads(large);
    for (const [name, measured] of Object.entries(overSmall)) {
      expect({ name, ...measured }).toEqual({ name, counted: measured.counted, total: measured.counted });
    }
    for (const [name, measured] of Object.entries(overLarge)) {
      expect({ name, ...measured }).toEqual({ name, counted: measured.counted, total: measured.counted });
    }
  });

  test("the large fixture really is larger", async () => {
    // NON-VACUITY. Two empty environments would agree on every count above.
    const caps = await harness.repository.listBudgets(large.scope);
    const deliveries = await harness.repository.listDeliveriesForEvent(
      large.scope,
      asCostIdentifier(large.crossingId),
    );
    expect(caps.ok && caps.value.length).toBe(30);
    expect(deliveries.ok && deliveries.value.length).toBe(25);
  });
});

describe("the writes that must be one statement, and the ones that must be two", () => {
  test("a claim is ONE conditional write", async () => {
    const measured = await measure(() =>
      harness.repository.claimDelivery(
        small.scope,
        asCostIdentifier(small.deliveryId),
        asCostIdentifier(uuid()),
        new Date("2026-05-01T10:05:00.000Z"),
        new Date("2026-05-01T10:00:00.000Z"),
      ),
    );
    // The port's contract, measured: "an implementation that reads the row,
    // decides in application code and then writes has a window between the read
    // and the write in which a second dispatcher can claim the same row".
    expect(measured.counted).toBe(1);
  });

  test("a fan-out of twenty-five recipients is ONE statement", async () => {
    const rows = large.channelIds.map((channelId, index) =>
      delivery(large, uuid(), channelId, 1_000 + index),
    );
    const measured = await measure(() =>
      runResult(harness.base.adapter.unitOfWork, (transaction) =>
        harness.repository.insertDeliveries(rows, transaction),
      ),
    );
    expect(measured.counted).toBe(1);
    expect(rows).toHaveLength(25);
  });

  test("a channel and its configuration are TWO, and always two", async () => {
    const measured = await measure(() =>
      runResult(harness.base.adapter.unitOfWork, (transaction) =>
        harness.repository.insertAlertChannel(
          conformanceChannel(small.scope, uuid(), { name: "measured" }),
          transaction,
        ),
      ),
    );
    expect(measured.counted).toBe(2);
    // The frame IS present here, because this one ran inside a transaction.
    expect(measured.total).toBeGreaterThan(measured.counted);
  });
});
