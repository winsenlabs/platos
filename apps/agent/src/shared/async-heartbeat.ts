/**
 * EOBD.106 — merge heartbeat events into a stream during long idle
 * gaps so a TLS-terminating reverse proxy (Caddy/NGINX/Cloud LB)
 * doesn't close an SSE connection while a tool is running.
 *
 * Socket.IO has server-level ping/pong and doesn't need this, but the
 * SSE path for `/api/v1/agent/stream` is a plain HTTP/1.1 response —
 * proxies close those at their idle timeout (30-60s is common).
 *
 * Implementation: race `iterator.next()` against a timer. When the
 * timer wins, yield a heartbeat event and restart the timer. When the
 * iterator wins, yield the event and reset the timer to the same
 * interval. Abort signal propagation closes the timer + returns.
 *
 * DROPPED-EVENT BUG (fixed): this used to call `iter.next()` fresh on every
 * loop iteration. When the heartbeat timer won the race, the loop `continue`d
 * and ABANDONED the still-pending `next()` promise — which then resolved with
 * the next real event that nobody was awaiting, silently discarding it. (Async
 * generators queue concurrent `next()` calls and hand each one a distinct
 * sequential value, so the re-issued `next()` received the value AFTER the
 * orphaned one.) Net effect: one event vanished per heartbeat fired.
 *
 * Live symptom: on the durable Trigger-Sessions chat path (the only chat path
 * that wraps the turn in this helper — the direct Socket.IO path does not,
 * which is why direct was unaffected), a model that thinks for longer than
 * `intervalMs` before emitting text — e.g. a reasoning model spending 270
 * reasoning tokens before its first visible token — tripped exactly one
 * heartbeat and lost exactly its first token. The reply arrived as " up. You
 * picked..." while the persisted message (accumulated agent-side, before this
 * hop) correctly read "Always up. You picked...".
 *
 * Fix: hoist the pending `next()` OUT of the loop and reuse it across
 * heartbeat timeouts; only clear it once its value has actually been consumed.
 */

/**
 * Shape of the heartbeat event we inject. Matches the `heartbeat`
 * variant on `AgentStreamEvent` so the merged stream type narrows
 * cleanly for TypeScript.
 */
export type HeartbeatEvent = { type: "heartbeat"; at: number };

export interface HeartbeatOptions {
  intervalMs: number;
  signal?: AbortSignal;
}

export async function* withHeartbeat<T>(
  source: AsyncIterable<T>,
  options: HeartbeatOptions,
): AsyncGenerator<T | HeartbeatEvent> {
  const iter = source[Symbol.asyncIterator]();
  const interval = Math.max(1000, options.intervalMs);

  // Held ACROSS loop iterations. A heartbeat timeout must never abandon an
  // in-flight `next()` — that is what silently ate events (see header).
  type NextOutcome =
    | { kind: "next"; res: IteratorResult<T> }
    | { kind: "err"; err: unknown };
  let nextPromise: Promise<NextOutcome> | null = null;

  while (true) {
    if (options.signal?.aborted) {
      await iter.return?.(undefined);
      return;
    }

    // Only issue a new next() when the previous one has been CONSUMED.
    if (!nextPromise) {
      nextPromise = iter.next().then(
        (res): NextOutcome => ({ kind: "next", res }),
        (err): NextOutcome => ({ kind: "err", err }),
      );
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
      timeoutHandle = setTimeout(() => resolve({ kind: "timeout" }), interval);
    });

    const winner = await Promise.race([timeoutPromise, nextPromise]);

    if (timeoutHandle) clearTimeout(timeoutHandle);

    if (winner.kind === "timeout") {
      yield { type: "heartbeat", at: Date.now() };
      // `nextPromise` deliberately survives — the source event it is waiting
      // on will be consumed by the next iteration instead of being dropped.
      continue;
    }

    // Consumed — clear so the next iteration issues a fresh next().
    nextPromise = null;

    if (winner.kind === "err") {
      throw winner.err;
    }

    if (winner.res.done) return;
    yield winner.res.value;
  }
}
