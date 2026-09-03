import { describe, expect, it } from "vitest";

import { createInFlightRegister } from "./in-flight.js";

/** Resolve after the microtask queue drains, without a timer. */
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("the in-flight register", () => {
  it("drains immediately when nothing is running", async () => {
    const register = createInFlightRegister();
    expect(await register.drain(1000)).toEqual({ drained: true, remaining: 0, waitedMs: 0 });
  });

  it("does not resolve while work is outstanding, and resolves when it settles", async () => {
    const register = createInFlightRegister();
    const work = register.begin("GET /slow");
    expect(register.count).toBe(1);

    let resolved = false;
    const draining = register.drain(5000).then((outcome) => {
      resolved = true;
      return outcome;
    });

    await settled();
    // The whole point: shutdown is still waiting.
    expect(resolved).toBe(false);

    work.settle();
    const outcome = await draining;
    expect(outcome.drained).toBe(true);
    expect(outcome.remaining).toBe(0);
    expect(register.count).toBe(0);
  });

  it("gives up at the deadline and reports what was still running", async () => {
    const register = createInFlightRegister();
    register.begin("POST /wedged");
    const outcome = await register.drain(20);
    expect(outcome.drained).toBe(false);
    expect(outcome.remaining).toBe(1);
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(0);
  });

  it("settles idempotently, because Express fires both finish and close", async () => {
    // Without the guard, the second settle would decrement a counter that is
    // already zero and drain would return with work still outstanding — a
    // silent truncation that looks exactly like a clean shutdown.
    const register = createInFlightRegister();
    const first = register.begin("a");
    const second = register.begin("b");
    first.settle();
    first.settle();
    first.settle();
    expect(register.count).toBe(1);
    expect(register.labels()).toEqual(["b"]);
    second.settle();
    expect(await register.drain(50)).toMatchObject({ drained: true, remaining: 0 });
  });

  it("waits for the last of several concurrent units, not the first", async () => {
    const register = createInFlightRegister();
    const units = ["a", "b", "c"].map((label) => register.begin(label));
    let resolved = false;
    const draining = register.drain(5000).then((outcome) => {
      resolved = true;
      return outcome;
    });

    units[0]?.settle();
    await settled();
    expect(resolved).toBe(false);
    units[1]?.settle();
    await settled();
    expect(resolved).toBe(false);
    units[2]?.settle();
    expect((await draining).drained).toBe(true);
  });

  it("names what it is waiting for, so the shutdown log is actionable", () => {
    const register = createInFlightRegister();
    register.begin("GET /readyz");
    register.begin("POST /v1/turns");
    expect([...register.labels()].sort()).toEqual(["GET /readyz", "POST /v1/turns"]);
  });

  it("uses the injected clock for the elapsed measurement", async () => {
    let now = 1_000;
    const register = createInFlightRegister();
    register.begin("wedged");
    const outcome = await register.drain(10, () => {
      const value = now;
      now += 250;
      return value;
    });
    expect(outcome.waitedMs).toBeGreaterThan(0);
  });
});
