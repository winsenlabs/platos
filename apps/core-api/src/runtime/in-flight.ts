// The in-flight work register that makes shutdown GRACEFUL rather than abrupt,
// and the admission gate that makes it REFUSE rather than drop.
//
// "Drain in-flight work" is only meaningful if something counts the work. A
// server that closes its listener has stopped ACCEPTING; requests already inside
// it are still running, and killing the process at that moment truncates them —
// which is precisely the failure mode a rolling deploy produces at every
// release if nobody wrote this file.
//
// The register is deliberately not HTTP-aware. Anything with a beginning and an
// end enlists: a request, an outbox flush, a queue consumer's current message.
// Shutdown then waits for the same number regardless of what produced it.
//
// ---------------------------------------------------------------------------
// WHY ADMISSION CLOSES, AND WHY THAT IS NOT THE SAME AS CLOSING THE LISTENER.
//
// `server.close()` stops accepting new CONNECTIONS. It does nothing about a
// keep-alive connection that is already open, and an upstream proxy holds those
// open for minutes. Such a connection can send a fresh request AFTER the drain
// has counted its work and reported zero — and that request is then routed,
// begun, and destroyed a few lines later when the shutdown releases every
// remaining socket. The client sees a reset mid-response: work accepted and
// silently dropped, which is worse than work refused, because a refusal is
// retriable and a reset in the middle of a non-idempotent write is not.
//
// So the register gates admission as well as counting it. After
// `closeAdmission()` every `begin` answers a REFUSED registration carrying
// `WORK_REFUSED_SHUTTING_DOWN`, the caller turns that into a 503 the client can
// act on, and the drain's zero keeps meaning what it says: nothing this process
// promised is still outstanding.
//
// THE REFUSAL IS A DISTINCT CODE FROM EVERY OTHER 503. A readiness 503 says
// "route elsewhere, this instance is not ready"; this one says "this instance is
// going away, the request was never begun, send it again". They are different
// operator responses, and one shared code would make a rolling deploy
// indistinguishable from a wedged dependency in a log.
// ---------------------------------------------------------------------------

/** A request arrived after admission closed. It was never begun. */
export const WORK_REFUSED_SHUTTING_DOWN = "core-api.shutdown.work_refused";

export interface InFlightRegistration {
  /** False when admission is closed. A refused unit is not counted or waited on. */
  readonly admitted: boolean;
  /** The refusal code, or null when admitted. */
  readonly refusal: string | null;
  /** Idempotent, and a no-op on a refused registration. */
  readonly settle: () => void;
}

export interface DrainOutcome {
  readonly drained: boolean;
  /** Still running when the wait ended. Zero exactly when `drained` is true. */
  readonly remaining: number;
  readonly waitedMs: number;
}

export interface InFlightRegister {
  begin(label: string): InFlightRegistration;
  readonly count: number;
  /** True once `closeAdmission` has been called. Idempotent to read. */
  readonly admitting: boolean;
  /**
   * Stop admitting new work. Idempotent, because two signals in quick succession
   * are normal and the second must join the first shutdown rather than restart
   * it. Work already begun is untouched: this closes the door, it does not
   * cancel what is inside.
   */
  closeAdmission(): void;
  /** How many units were refused since admission closed. For the shutdown log. */
  readonly refused: number;
  /** A snapshot of what is running, for the shutdown log line. */
  labels(): readonly string[];
  drain(timeoutMs: number, now?: () => number): Promise<DrainOutcome>;
}

const REFUSED: InFlightRegistration = Object.freeze({
  admitted: false,
  refusal: WORK_REFUSED_SHUTTING_DOWN,
  settle: () => undefined,
});

export function createInFlightRegister(): InFlightRegister {
  let nextId = 0;
  let admitting = true;
  let refused = 0;
  const running = new Map<number, string>();
  const waiters = new Set<() => void>();

  const release = (): void => {
    if (running.size !== 0) return;
    for (const waiter of [...waiters]) waiter();
  };

  return {
    begin(label: string): InFlightRegistration {
      if (!admitting) {
        refused += 1;
        // The SAME frozen object every time. A refused unit carries no identity
        // — there is nothing to settle — and minting one per refusal would give
        // a shutdown flood a per-request allocation for no purpose.
        return REFUSED;
      }
      const id = nextId++;
      running.set(id, label);
      let settled = false;
      return {
        admitted: true,
        refusal: null,
        settle: () => {
          // Express fires both `finish` and `close` on some responses. Without
          // this guard the counter would go negative and drain would return
          // immediately with work still running — a silent truncation.
          if (settled) return;
          settled = true;
          running.delete(id);
          release();
        },
      };
    },
    get count(): number {
      return running.size;
    },
    get admitting(): boolean {
      return admitting;
    },
    get refused(): number {
      return refused;
    },
    closeAdmission(): void {
      if (!admitting) return;
      admitting = false;
      // WAKE THE WAITERS. A drain that started while the last unit was already
      // settled is waiting on an empty register; closing admission is the moment
      // it becomes certain nothing more can arrive, so it is also the moment the
      // wait can end.
      release();
    },
    labels(): readonly string[] {
      return [...running.values()];
    },
    async drain(timeoutMs: number, now: () => number = Date.now): Promise<DrainOutcome> {
      const startedAt = now();
      if (running.size === 0) return { drained: true, remaining: 0, waitedMs: 0 };

      return await new Promise<DrainOutcome>((resolve) => {
        let finished = false;
        const finish = (drained: boolean): void => {
          if (finished) return;
          finished = true;
          waiters.delete(onEmpty);
          clearTimeout(timer);
          resolve({ drained, remaining: running.size, waitedMs: now() - startedAt });
        };
        const onEmpty = (): void => {
          if (running.size === 0) finish(true);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        // Do not hold the event loop open on account of the deadline itself:
        // if everything drains, the process must be free to exit immediately.
        timer.unref?.();
        waiters.add(onEmpty);
      });
    },
  };
}
