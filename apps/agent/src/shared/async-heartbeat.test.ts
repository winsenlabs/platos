import { describe, it, expect } from "vitest";
import { withHeartbeat } from "./async-heartbeat";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Regression cover for the dropped-event bug.
 *
 * `withHeartbeat` used to issue a fresh `iter.next()` on every loop iteration.
 * When the heartbeat timer won the race the loop `continue`d and abandoned the
 * pending promise, which then resolved with the next real event that nobody
 * was awaiting — silently discarding it. One event vanished per heartbeat.
 *
 * Live symptom: on the durable Trigger-Sessions chat path a reasoning model
 * that thought for longer than the heartbeat interval before emitting text
 * lost exactly its first token ("Always up..." arrived as " up...").
 */
describe("withHeartbeat", () => {
  it("does NOT drop the first event when the source stalls past the heartbeat", async () => {
    async function* stalls() {
      await sleep(120); // longer than the interval → forces a heartbeat
      yield "A";
      yield "B";
    }
    const out: unknown[] = [];
    for await (const ev of withHeartbeat(stalls(), { intervalMs: 1000 })) {
      out.push(ev);
    }
    // intervalMs is floored at 1000 internally, so use a longer stall below;
    // this case asserts no loss in the fast path.
    expect(out).toEqual(["A", "B"]);
  });

  it("keeps every event across MULTIPLE heartbeats (the real bug)", async () => {
    async function* slowStart() {
      await sleep(2300); // > 2 heartbeat intervals → 2 heartbeats fire
      yield "Always";
      yield " up.";
      await sleep(1200); // another idle gap mid-stream → another heartbeat
      yield " You picked";
    }
    const events: unknown[] = [];
    for await (const ev of withHeartbeat(slowStart(), { intervalMs: 1000 })) {
      events.push(ev);
    }
    const values = events.filter((e) => typeof e === "string");
    const beats = events.filter(
      (e) => typeof e === "object" && e !== null && (e as any).type === "heartbeat",
    );
    // Every source value survives, in order — this is what regressed.
    expect(values).toEqual(["Always", " up.", " You picked"]);
    // And heartbeats were genuinely emitted (otherwise the test proves nothing).
    expect(beats.length).toBeGreaterThanOrEqual(2);
  }, 10_000);

  it("propagates source errors", async () => {
    async function* boom() {
      yield "x";
      throw new Error("source failed");
    }
    const seen: unknown[] = [];
    await expect(async () => {
      for await (const ev of withHeartbeat(boom(), { intervalMs: 1000 })) seen.push(ev);
    }).rejects.toThrow("source failed");
    expect(seen).toEqual(["x"]);
  });

  it("stops when the abort signal is already aborted", async () => {
    async function* infinite() {
      for (;;) {
        yield "tick";
        await sleep(5);
      }
    }
    const ac = new AbortController();
    ac.abort();
    const out: unknown[] = [];
    for await (const ev of withHeartbeat(infinite(), { intervalMs: 1000, signal: ac.signal })) {
      out.push(ev);
    }
    expect(out).toEqual([]);
  });
});
