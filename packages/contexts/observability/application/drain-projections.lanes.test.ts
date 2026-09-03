// The four analytical lanes, proven from the QUEUE to the SINK.
//
// SPLIT OUT OF `drain-projections.test.ts` rather than appended to it. Adding
// these cases took that file to 453 effective lines, past the ADR M0.3 §6
// 400-line warning band, and the answer the budget asks for is a split along
// the seam it is pointing at — not a raised threshold. The seam is real: the
// cases next door are about the DRAIN (claiming, retrying, parking, budgets,
// the erasure guard) and the ones here are about WHAT ARRIVES.
//
// WHY THEY EXIST AT ALL. `readToolCall` and `readUsage` in
// `domain/observed-work-codec.ts` — 84 lines reading the two lanes that carry
// provider cost — had ZERO coverage. `testFinalizedPayload` carried no
// `toolCalls` and no `usage` key, and `readTurnWork` only reaches those readers
// through `readList` when the key is present, so both functions could be
// deleted outright with `readTurnWork` hard-wired to empty lists and the
// package still compiled and returned 14 files / 281 passed.
//
// AND THE PRICES THOSE LANES ARE MULTIPLIED BY. The same omission ran one level
// down: `readRates` was reachable only through `readStep` and `readUsage`, no
// payload fixture carried a `rates` key, and it was therefore only ever called
// with `undefined`. `rateColumns` filled six columns from that dead read, so
// every step and usage row delivered from an envelope carried DEFAULT PRICES.
// The heading above claimed the money path was proven from the queue to the
// sink while the prices on it were not read at all; the case below is what
// makes the claim true rather than the claim trimmed to what was proven.
//
// Every case below asserts on the ROW IN THE SINK. A lane can be lost at the
// read, at the projection, or at the insert, and only the far end catches all
// three.

import { beforeEach, describe, expect, it } from "vitest";

import { TURN_FINALIZED_EVENT, type EnvelopeId } from "../domain/index.js";
import { drainProjections } from "./drain-projections.js";
import {
  buildObservabilityTestContext,
  testEnvelope,
  testFinalizedPayload,
  TEST_STEP_UUID,
  TEST_TOOL_CALL_UUID,
  TEST_TURN_UUID,
  TEST_USAGE_UUID,
  type ObservabilityTestContext,
} from "./testing/index.js";

function finalized(context: ObservabilityTestContext, overrides: Record<string, unknown> = {}): EnvelopeId {
  return context.outbox.enqueue(testEnvelope(TURN_FINALIZED_EVENT, testFinalizedPayload(overrides)));
}

describe("drainProjections — the four analytical lanes", () => {
  let context: ObservabilityTestContext;

  beforeEach(() => {
    context = buildObservabilityTestContext();
  });

  it("delivers the USAGE lane end to end — the row the bill is computed from", async () => {
    // THE MONEY PATH, PROVEN FROM THE QUEUE TO THE SINK. Before this case
    // `domain/observed-work-codec.ts::readUsage` had ZERO coverage: the payload
    // fixture carried no `usage` key, `readTurnWork` only reaches `readUsage`
    // through `readList` when the key is present, and the whole function could
    // be deleted — with `readTurnWork` hard-wired to an empty list — leaving 14
    // files / 281 passed. A producer's usage events were silently discarded at
    // the read boundary and nothing in the suite could tell.
    //
    // The assertion is on the ROW IN THE SINK, not on the codec's return value,
    // because a lane can be lost at the read (readUsage), at the projection
    // (projection.ts usage_events_v1) or at the insert, and only the far end
    // catches all three. Cost and tokens are asserted, not just the id: a row
    // that arrives with its money columns empty is the same outage as no row.
    finalized(context);

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.delivered).toBe(1);

    const usage = context.sink.rows("usage_events_v1");
    expect(usage).toHaveLength(1);
    expect(usage[0]?.usage_event_id).toBe(TEST_USAGE_UUID);
    expect(usage[0]?.turn_id).toBe(TEST_TURN_UUID);
    expect(usage[0]?.usage_kind).toBe("inference");
    // 125 cents, carried through `usdFromCents` into the DECIMAL(_,12) column.
    expect(usage[0]?.calculated_cost_usd).toBe("1.250000000000");
    expect(usage[0]?.total_input_tokens).toBe(1000);
    expect(usage[0]?.output_tokens).toBe(250);
    // The envelope's scope is authoritative and the payload carries none, so a
    // usage row silently filed under another tenant is the failure this pins.
    expect(usage[0]?.environment_id).toBe("env-1");
  });

  it("delivers the TOOL CALL lane end to end, on the same envelope", async () => {
    // The sibling of the case above, and the other half of the 84 dead lines:
    // `readToolCall` had zero coverage for exactly the same reason.
    finalized(context);

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);

    const toolCalls = context.sink.rows("tool_calls_v1");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]?.tool_call_id).toBe(TEST_TOOL_CALL_UUID);
    expect(toolCalls[0]?.tool_name).toBe("search");
    expect(toolCalls[0]?.environment_id).toBe("env-1");
  });

  it("delivers the PRICING RATES end to end, so a row is never billed at default prices", async () => {
    // THE MONEY PATH ONE LEVEL DOWN, and the last part of it that was read by
    // nobody. `domain/observed-work-codec.ts::readRates` was reachable only
    // through `readStep` and `readUsage`, and no payload fixture in the package
    // carried a `rates` key — so it was only ever called with `undefined`.
    // Inserting `if (value !== null) return undefined;` at the top of it left 15
    // files / 287 passed. `domain/projection.ts::rateColumns` fills
    // `pricing_source`, `pricing_version` and the four per-million columns from
    // that value, so every step and usage row delivered from an envelope carried
    // DEFAULT PRICES: empty catalogue, zero per million. `rateColumns` IS
    // covered — through `testStep` in `domain/projection.test.ts` — and that
    // coverage is precisely what masked this, because it proves the projection
    // from a hand-built domain value that never went through the codec.
    //
    // Asserted at the SINK and with EXACT values. A rate can be lost at the read
    // or flattened at the projection, and both arrive at the far end as a row
    // that looks plausible and is priced at zero.
    finalized(context);

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.delivered).toBe(1);

    const step = context.sink.rows("steps_v1")[0];
    expect(step?.step_id).toBe(TEST_STEP_UUID);
    expect(step?.pricing_source).toBe("catalogue");
    expect(step?.pricing_version).toBe("price-1");
    // 0.000003 USD per token is 3 USD per million, through `usdPerMillion` into
    // the DECIMAL(_,12) column. A dead reader makes this "0.000000000000".
    expect(step?.fresh_input_usd_per_million).toBe("3.000000000000");
    expect(step?.output_usd_per_million).toBe("15.000000000000");
    expect(step?.cache_read_usd_per_million).toBe("0.300000000000");
    expect(step?.cache_write_usd_per_million).toBe("3.750000000000");

    // The usage lane reads its rates through the same function and projects
    // them through the same columns, and it is the table the bill is computed
    // from, so it is pinned here rather than left to the step alone.
    const usage = context.sink.rows("usage_events_v1")[0];
    expect(usage?.pricing_version).toBe("price-1");
    expect(usage?.fresh_input_usd_per_million).toBe("3.000000000000");
    expect(usage?.output_usd_per_million).toBe("15.000000000000");
  });

  it("inserts all FOUR lanes in one batch, and the receipt counts them", async () => {
    // The conservation control across the pair above. It is not enough that
    // each lane can arrive; the drain must carry them together, because a
    // partial insert is what a half-billed turn looks like.
    finalized(context);

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(context.sink.size).toBe(4);
    const inserts = context.sink.callsTo("insert");
    expect(inserts).toHaveLength(1);
    const insert = inserts[0];
    // Narrowed rather than cast: `SinkCall` is a union and only the insert
    // variant carries a row count, so reaching for it on the union is the same
    // defect class this file exists to catch.
    if (insert?.call !== "insert") throw new Error("expected an insert call");
    expect(insert.rows).toBe(4);
  });

  it("PARKS a malformed usage entry, naming the field, rather than dropping the lane", async () => {
    // The refusal half. Without it the two cases above would still pass against
    // a `readUsage` that returned an empty list for anything it could not read,
    // which is the failure mode that loses money quietly instead of loudly.
    // `usageKind` is required and "teleportation" is not one of the known kinds.
    const envelopeId = finalized(context, {
      usage: [
        {
          usageEventId: TEST_USAGE_UUID,
          agentId: "agent-1",
          usageKind: "teleportation",
          provider: "provider-a",
          occurredAt: "2026-01-01T00:00:02.000Z",
        },
      ],
    });

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.parked).toBe(1);
    expect(drained.value.delivered).toBe(0);
    // Nothing partial reached the sink: the whole envelope is refused, so a
    // turn is never half-projected.
    expect(context.sink.callsTo("insert")).toHaveLength(0);
    expect(context.outbox.find(envelopeId)?.status).toBe("FAILED");
    expect(context.logger.at("error")).toHaveLength(1);
  });

  it("PARKS a malformed tool call entry too", async () => {
    // `toolName` is required; omitting it must be a named producer defect
    // rather than a tool call that quietly never happened.
    const envelopeId = finalized(context, {
      toolCalls: [
        {
          toolCallId: TEST_TOOL_CALL_UUID,
          stepId: TEST_STEP_UUID,
          turnId: TEST_TURN_UUID,
          status: "completed",
          startedAt: "2026-01-01T00:00:00.500Z",
          completedAt: "2026-01-01T00:00:01.000Z",
        },
      ],
    });

    const drained = await drainProjections(context.dependencies);
    if (!drained.ok) throw new Error(drained.error.code);
    expect(drained.value.parked).toBe(1);
    expect(context.sink.callsTo("insert")).toHaveLength(0);
    expect(context.outbox.find(envelopeId)?.status).toBe("FAILED");
  });
});
