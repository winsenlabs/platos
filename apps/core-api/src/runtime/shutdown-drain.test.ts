// The shutdown budget, and the arithmetic between two drains.
//
// EVERY CASE THAT MEASURES TIME USES AN INJECTED CLOCK, and the drainables move
// it themselves. A suite that spent real seconds proving a ten-second budget is
// divided correctly would be a suite nobody runs before pushing, and the bug
// this module exists to prevent — one drain silently taking the other's slice —
// only shows up when a drain is slow.

import { describe, expect, it } from "vitest";

import type { Drainable, DrainableOutcome } from "./shutdown-drain.js";
import {
  assertDistinctNames,
  drainAll,
  ShutdownDrainError,
  SHUTDOWN_DRAIN_BUDGET_SPENT,
  SHUTDOWN_DRAIN_FAULTED,
  SHUTDOWN_DRAIN_NAME_TAKEN,
  SHUTDOWN_DRAIN_TIMED_OUT,
} from "./shutdown-drain.js";

/** A clock the drainables advance, so a budget can be spent in no real time. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1_000_000;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

const QUIESCENT: DrainableOutcome = {
  drained: true,
  handled: 0,
  remaining: 0,
  stoppedBecause: null,
};

/** A drainable that records what it was handed and burns `costMs` of the clock. */
function spending(
  name: string,
  costMs: number,
  clock: { advance: (ms: number) => void },
  log: string[],
): Drainable & { readonly budgets: number[] } {
  const budgets: number[] = [];
  return {
    name,
    budgets,
    drain: (budgetMs) => {
      log.push(name);
      budgets.push(budgetMs);
      clock.advance(costMs);
      return Promise.resolve(QUIESCENT);
    },
  };
}

describe("two drains share ONE budget", () => {
  it("hands the second what is LEFT, not a second full copy", async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const first = spending("first", 400, clock, log);
    const second = spending("second", 100, clock, log);

    await drainAll([first, second], 1000, clock.now);

    // THE WHOLE POINT. Two `await`s with the same timeout would have handed the
    // second 1000 as well, and a process given a 1000ms budget would have been
    // entitled to spend 2000 — which is exactly long enough to be SIGKILLed
    // mid-flush.
    expect(first.budgets).toEqual([1000]);
    expect(second.budgets).toEqual([600]);
  });

  it("reports a total wait no larger than the budget", async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const report = await drainAll(
      [spending("a", 300, clock, log), spending("b", 300, clock, log), spending("c", 300, clock, log)],
      1000,
      clock.now,
    );
    expect(report.waitedMs).toBeLessThanOrEqual(report.budgetMs);
  });

  it("runs them in the caller's order, because the outbox must go last", async () => {
    const clock = fakeClock();
    const log: string[] = [];
    await drainAll(
      [spending("requests", 1, clock, log), spending("outbox", 1, clock, log)],
      1000,
      clock.now,
    );
    expect(log).toEqual(["requests", "outbox"]);
  });

  it("does not CALL a step that arrives with nothing left", async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const greedy = spending("greedy", 1200, clock, log);
    const starved = spending("starved", 10, clock, log);

    const report = await drainAll([greedy, starved], 1000, clock.now);

    // Not called at all, rather than called with a zero timeout: a step that ran
    // with no time would report a failure of its own, and an operator reading
    // "the outbox drain failed" would go looking at the outbox.
    expect(log).toEqual(["greedy"]);
    expect(starved.budgets).toEqual([]);
    expect(report.steps[1]?.outcome.stoppedBecause).toBe(SHUTDOWN_DRAIN_BUDGET_SPENT);
    expect(report.steps[1]?.budgetMs).toBe(0);
  });

  it("still reports a row for the step it never called", async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const report = await drainAll(
      [spending("greedy", 5000, clock, log), spending("starved", 1, clock, log)],
      1000,
      clock.now,
    );
    expect(report.steps.map((step) => step.name)).toEqual(["greedy", "starved"]);
  });

  it("is drained only when EVERY step drained", async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const report = await drainAll(
      [spending("greedy", 5000, clock, log), spending("starved", 1, clock, log)],
      1000,
      clock.now,
    );
    expect(report.drained).toBe(false);
  });

  it("is drained when every step drained", async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const report = await drainAll(
      [spending("a", 10, clock, log), spending("b", 10, clock, log)],
      1000,
      clock.now,
    );
    expect(report.drained).toBe(true);
  });

  it("drains nothing, successfully, when nothing is registered", async () => {
    const clock = fakeClock();
    const report = await drainAll([], 1000, clock.now);
    expect(report).toMatchObject({ drained: true, steps: [], budgetMs: 1000 });
  });

  it("calls no step at all when the budget starts at zero", async () => {
    const clock = fakeClock();
    const log: string[] = [];
    await drainAll([spending("a", 1, clock, log)], 0, clock.now);
    expect(log).toEqual([]);
  });
});

describe("a broken step does not take the others with it", () => {
  it("records the fault and keeps going", async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const broken: Drainable = {
      name: "broken",
      drain: () => {
        log.push("broken");
        return Promise.reject(new Error("the store is gone"));
      },
    };
    const after = spending("after", 1, clock, log);

    const report = await drainAll([broken, after], 1000, clock.now);

    // THE OUTBOX FLUSH MATTERS MOST ON A BAD DAY. A sequence that stopped at the
    // first rejection would skip it precisely when it is needed.
    expect(log).toEqual(["broken", "after"]);
    expect(report.steps[0]?.outcome.stoppedBecause).toContain(SHUTDOWN_DRAIN_FAULTED);
    expect(report.steps[1]?.outcome.drained).toBe(true);
  });

  it("carries the reason, because the process it happened in has already exited", async () => {
    const clock = fakeClock();
    const report = await drainAll(
      [{ name: "broken", drain: () => Promise.reject(new Error("connection reset")) }],
      1000,
      clock.now,
    );
    expect(report.steps[0]?.outcome.stoppedBecause).toBe(
      `${SHUTDOWN_DRAIN_FAULTED}: connection reset`,
    );
  });

  it("survives a step that rejects with something that is not an Error", async () => {
    const clock = fakeClock();
    const report = await drainAll(
      [{ name: "rude", drain: () => Promise.reject("just a string") }],
      1000,
      clock.now,
    );
    expect(report.steps[0]?.outcome.stoppedBecause).toBe(`${SHUTDOWN_DRAIN_FAULTED}: just a string`);
    expect(report.drained).toBe(false);
  });
});

describe("a step that ignores its budget is bounded anyway", () => {
  it("is raced against its own slice and reported as timed out", async () => {
    // REAL TIMERS HERE ON PURPOSE, and a small slice. The race is what stops a
    // drainable that never resolves from taking the whole shutdown with it, and
    // nothing but a real timer can prove a promise was abandoned.
    const started = Date.now();
    const report = await drainAll(
      [{ name: "wedged", drain: () => new Promise<DrainableOutcome>(() => undefined) }],
      30,
    );
    expect(report.steps[0]?.outcome.stoppedBecause).toBe(SHUTDOWN_DRAIN_TIMED_OUT);
    expect(report.drained).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("continues the sequence rather than aborting it, and says why the next step did not run", async () => {
    // A WEDGED STEP SPENDS THE WHOLE REMAINING BUDGET — that is what the race
    // bounds it to — so the step after it is correctly NOT CALLED. The property
    // worth pinning is that the sequence still REPORTS it: an abandoned drain
    // must not make the following one vanish from the report, or an operator
    // reading a shutdown log cannot tell "the outbox was skipped" from "there
    // was no outbox".
    const log: string[] = [];
    const report = await drainAll(
      [
        { name: "wedged", drain: () => new Promise<DrainableOutcome>(() => undefined) },
        {
          name: "after",
          drain: () => {
            log.push("after");
            return Promise.resolve(QUIESCENT);
          },
        },
      ],
      40,
    );
    expect(log).toEqual([]);
    expect(report.steps.map((step) => step.name)).toEqual(["wedged", "after"]);
    expect(report.steps[0]?.outcome.stoppedBecause).toBe(SHUTDOWN_DRAIN_TIMED_OUT);
    expect(report.steps[1]?.outcome.stoppedBecause).toBe(SHUTDOWN_DRAIN_BUDGET_SPENT);
  });
});

describe("two drainables may not share a name", () => {
  it("refuses before anything runs", async () => {
    const clock = fakeClock();
    const log: string[] = [];
    const ran: string[] = [];
    const one: Drainable = {
      name: "outbox",
      drain: () => {
        ran.push("one");
        return Promise.resolve(QUIESCENT);
      },
    };
    await expect(drainAll([one, spending("outbox", 1, clock, log)], 1000, clock.now)).rejects.toThrow(
      ShutdownDrainError,
    );
    // BEFORE, not partway through: a shutdown that half-ran and then threw would
    // leave the report describing a sequence that did not happen.
    expect(ran).toEqual([]);
  });

  it("names the code and the colliding name", async () => {
    const clock = fakeClock();
    const log: string[] = [];
    try {
      await drainAll([spending("outbox", 1, clock, log), spending("outbox", 1, clock, log)], 1000, clock.now);
      expect.unreachable("a duplicate name must be refused");
    } catch (cause) {
      expect(cause).toBeInstanceOf(ShutdownDrainError);
      expect((cause as ShutdownDrainError).code).toBe(SHUTDOWN_DRAIN_NAME_TAKEN);
      expect((cause as ShutdownDrainError).message).toContain("outbox");
    }
  });

  it("accepts distinct names", () => {
    expect(() =>
      assertDistinctNames([
        { name: "a", drain: () => Promise.resolve(QUIESCENT) },
        { name: "b", drain: () => Promise.resolve(QUIESCENT) },
      ]),
    ).not.toThrow();
  });
});

describe("the four codes are four codes", () => {
  it("mints no two the same, so a log line says which happened", () => {
    const codes = new Set([
      SHUTDOWN_DRAIN_NAME_TAKEN,
      SHUTDOWN_DRAIN_BUDGET_SPENT,
      SHUTDOWN_DRAIN_TIMED_OUT,
      SHUTDOWN_DRAIN_FAULTED,
    ]);
    expect(codes.size).toBe(4);
  });

  it("namespaces every one of them to this process's shutdown", () => {
    for (const code of [
      SHUTDOWN_DRAIN_NAME_TAKEN,
      SHUTDOWN_DRAIN_BUDGET_SPENT,
      SHUTDOWN_DRAIN_TIMED_OUT,
      SHUTDOWN_DRAIN_FAULTED,
    ]) {
      expect(code.startsWith("core-api.shutdown.")).toBe(true);
    }
  });
});
