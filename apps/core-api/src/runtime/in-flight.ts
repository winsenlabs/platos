// The in-flight work register that makes shutdown GRACEFUL rather than abrupt.
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

export interface InFlightRegistration {
  /** Idempotent. Calling it twice must not decrement twice. */
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
  /** A snapshot of what is running, for the shutdown log line. */
  labels(): readonly string[];
  drain(timeoutMs: number, now?: () => number): Promise<DrainOutcome>;
}

export function createInFlightRegister(): InFlightRegister {
  let nextId = 0;
  const running = new Map<number, string>();
  const waiters = new Set<() => void>();

  const release = (): void => {
    if (running.size !== 0) return;
    for (const waiter of [...waiters]) waiter();
  };

  return {
    begin(label: string): InFlightRegistration {
      const id = nextId++;
      running.set(id, label);
      let settled = false;
      return {
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
        const onEmpty = (): void => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        // Do not hold the event loop open on account of the deadline itself:
        // if everything drains, the process must be free to exit immediately.
        timer.unref?.();
        waiters.add(onEmpty);
      });
    },
  };
}
