// The deferred-work drain sequence, and the ONE budget it divides.
//
// WHY A SEQUENCE AND NOT A LIST OF `await`s IN `lifecycle.ts`.
//
// Shutdown has exactly one budget: `PLATOS_CORE_API_SHUTDOWN_TIMEOUT_MS`, and
// past it the orchestrator sends SIGKILL. The obvious way to drain two
// subsystems is to await each with that timeout, which spends the budget TWICE
// and guarantees the second one is killed mid-drain — the outbox flush is
// interrupted at an arbitrary page, and the events it had read and not yet
// handed on are silently re-delivered by the next process or, if the handler had
// already taken them, silently lost. The bug is not in either drain. It is in the
// arithmetic between them, which is why the arithmetic gets its own module.
//
// So the budget is DIVIDED: each step is handed what is LEFT, measured on the
// injected clock, and a step that arrives with nothing left is not called at
// all. `SHUTDOWN_DRAIN_BUDGET_SPENT` says so in the report, rather than the step
// running with a zero timeout and reporting a failure that reads like its own.
//
// EVERY STEP IS RACED AGAINST ITS OWN SLICE. A drainable that ignores the number
// it was handed would otherwise take the whole shutdown with it, and there is no
// way to preempt a promise. Racing bounds the SEQUENCE even against a drainable
// that does not honour its budget; the abandoned work keeps running until the
// process exits, and `SHUTDOWN_DRAIN_TIMED_OUT` is the honest name for that.
//
// A FAULTING STEP DOES NOT SKIP THE REST. One broken drain must not take the
// others down with it — the whole point of draining the outbox is that it
// happens even on a bad day — so a rejection is caught, recorded as
// `SHUTDOWN_DRAIN_FAULTED`, and the sequence continues with the budget that
// remains.
//
// FOUR CODES, FOUR DIFFERENT THINGS. Two names that collide, a step that never
// ran, a step that ran out of time, and a step that threw are four different
// operator responses. A single `SHUTDOWN_DRAIN_FAILED` would put all four in one
// bucket, which is how two defects hid behind one code in `privacy` and in
// `identity-access`.

/** Two drainables answering to one name; their two rows would be one row. */
export const SHUTDOWN_DRAIN_NAME_TAKEN = "core-api.shutdown.drain_name_taken";

/** The step was never called: the budget was already spent when its turn came. */
export const SHUTDOWN_DRAIN_BUDGET_SPENT = "core-api.shutdown.drain_budget_spent";

/** The step ran and did not finish inside the slice it was handed. */
export const SHUTDOWN_DRAIN_TIMED_OUT = "core-api.shutdown.drain_timed_out";

/** The step rejected. The sequence continues; this one is reported, not hidden. */
export const SHUTDOWN_DRAIN_FAULTED = "core-api.shutdown.drain_faulted";

export class ShutdownDrainError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ShutdownDrainError";
    this.code = code;
  }
}

export interface DrainableOutcome {
  /** True only when the subsystem is quiescent: nothing deferred is outstanding. */
  readonly drained: boolean;
  /** Units of deferred work handed on during this drain. */
  readonly handled: number;
  /** Left behind. `null` when the subsystem cannot cheaply say. */
  readonly remaining: number | null;
  /** Why it stopped, or null when it stopped because it was finished. */
  readonly stoppedBecause: string | null;
}

/**
 * A subsystem holding work that outlives a request.
 *
 * `drain` is handed the milliseconds it may use and the clock to measure with.
 * The clock is a parameter for the same reason it is everywhere else in this
 * tree: a drain whose deadline comes from `Date.now()` cannot be exercised at a
 * chosen instant, and a shutdown suite that has to sleep in real time is a
 * shutdown suite nobody runs.
 */
export interface Drainable {
  readonly name: string;
  drain(budgetMs: number, now: () => number): Promise<DrainableOutcome>;
}

export interface ShutdownDrainStep {
  readonly name: string;
  /** What this step was handed. Zero means it was not called. */
  readonly budgetMs: number;
  readonly waitedMs: number;
  readonly outcome: DrainableOutcome;
}

export interface ShutdownDrainReport {
  /** True only when every step drained. */
  readonly drained: boolean;
  readonly budgetMs: number;
  readonly waitedMs: number;
  readonly steps: readonly ShutdownDrainStep[];
}

const NOT_CALLED: DrainableOutcome = Object.freeze({
  drained: false,
  handled: 0,
  remaining: null,
  stoppedBecause: SHUTDOWN_DRAIN_BUDGET_SPENT,
});

function faulted(cause: unknown): DrainableOutcome {
  return {
    drained: false,
    handled: 0,
    remaining: null,
    // The code, then the reason, in one field an operator greps. The message is
    // included because a fault with no detail sends a reader to the source of a
    // process that has already exited.
    stoppedBecause: `${SHUTDOWN_DRAIN_FAULTED}: ${cause instanceof Error ? cause.message : String(cause)}`,
  };
}

/** Refuse a duplicate name before anything runs. Reported, never silently merged. */
export function assertDistinctNames(drainables: readonly Drainable[]): void {
  const seen = new Set<string>();
  for (const drainable of drainables) {
    if (seen.has(drainable.name)) {
      throw new ShutdownDrainError(
        SHUTDOWN_DRAIN_NAME_TAKEN,
        `two drainables answer to "${drainable.name}"; their two rows in the shutdown report would be one row`,
      );
    }
    seen.add(drainable.name);
  }
}

/**
 * Run every drainable in order, inside ONE budget.
 *
 * Order is the caller's, and it matters: the outbox is drained AFTER in-flight
 * requests, because a request still running is still capable of appending to it.
 */
export async function drainAll(
  drainables: readonly Drainable[],
  budgetMs: number,
  now: () => number = Date.now,
): Promise<ShutdownDrainReport> {
  assertDistinctNames(drainables);
  const startedAt = now();
  const steps: ShutdownDrainStep[] = [];

  for (const drainable of drainables) {
    const spent = now() - startedAt;
    const slice = budgetMs - spent;
    if (slice <= 0) {
      steps.push({ name: drainable.name, budgetMs: 0, waitedMs: 0, outcome: NOT_CALLED });
      continue;
    }
    const stepStartedAt = now();
    const outcome = await raceSlice(drainable, slice, now);
    steps.push({
      name: drainable.name,
      budgetMs: slice,
      waitedMs: now() - stepStartedAt,
      outcome,
    });
  }

  return Object.freeze({
    drained: steps.every((step) => step.outcome.drained),
    budgetMs,
    waitedMs: now() - startedAt,
    steps: Object.freeze(steps),
  });
}

async function raceSlice(
  drainable: Drainable,
  sliceMs: number,
  now: () => number,
): Promise<DrainableOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<DrainableOutcome>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          drained: false,
          handled: 0,
          remaining: null,
          stoppedBecause: SHUTDOWN_DRAIN_TIMED_OUT,
        }),
      sliceMs,
    );
    // The deadline must not be the reason the process stays alive. If everything
    // drains early, shutdown finishes early.
    timer.unref?.();
  });
  try {
    return await Promise.race([
      drainable.drain(sliceMs, now).catch((cause: unknown) => faulted(cause)),
      expiry,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
