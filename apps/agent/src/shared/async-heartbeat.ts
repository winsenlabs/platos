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

  while (true) {
    if (options.signal?.aborted) {
      await iter.return?.(undefined);
      return;
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<{ kind: "timeout" }>((resolve) => {
      timeoutHandle = setTimeout(() => resolve({ kind: "timeout" }), interval);
    });

    const nextPromise = iter.next().then(
      (res) => ({ kind: "next" as const, res }),
      (err) => ({ kind: "err" as const, err }),
    );

    const winner = await Promise.race([timeoutPromise, nextPromise]);

    if (timeoutHandle) clearTimeout(timeoutHandle);

    if (winner.kind === "timeout") {
      yield { type: "heartbeat", at: Date.now() };
      continue;
    }

    if (winner.kind === "err") {
      throw winner.err;
    }

    if (winner.res.done) return;
    yield winner.res.value;
  }
}
