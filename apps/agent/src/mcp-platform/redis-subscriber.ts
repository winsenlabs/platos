import type Redis from "ioredis";

/**
 * WIN-268 (M4.2) — a dedicated SUBSCRIBE connection that is READY before its
 * first SUBSCRIBE is written.
 *
 * THE DEFECT. Every legacy-SSE session did `const sub = this.redis.duplicate()`,
 * awaited a Redis write on the MAIN connection, and then `sub.subscribe(...)`.
 * `duplicate()` connects eagerly, and that one intervening round trip is almost
 * exactly long enough for the duplicate's socket to be CONNECTED but not yet
 * READY. ioredis 5 writes a command issued in that state straight to the socket,
 * so SUBSCRIBE reaches the server before the client's own ready-check `INFO`;
 * the server refuses `INFO` on a connection already in subscriber mode
 * (`ERR Can't execute 'info'`), ioredis treats the failed ready check as a dead
 * connection, drops it and reconnects — and a PUBLISH that lands during the
 * reconnect has no subscriber. The frame is gone; the SDK client is left waiting
 * on an `initialize` response that was delivered to nobody.
 *
 * MEASURED, not inferred. The controller's exact sequence against a real Redis
 * 7, six sessions in a row: frames 1, 3, 4 and 5 lost (`PUBLISH` answered 0
 * receivers) and 0 and 2 delivered. With the subscriber created lazily and
 * `connect()` awaited to READY before SUBSCRIBE: six of six. The official SDK
 * client over `/mcp/platform/sse` hung on `initialize` for every session after
 * the first until this changed, which is how
 * `mcp-protocol-conformance.integration.test.ts` found it.
 *
 * `connect()` on a lazy client resolves on READY and rejects if the connection
 * cannot be made, which is the existing "session transport unavailable" path.
 * A caller must not call it after its session has been cleaned up: ioredis
 * reconnects an ENDED client on `connect()`, which would leak a connection.
 */
export function createSubscriber(redis: Redis): Redis {
  return redis.duplicate({ lazyConnect: true });
}

export async function readySubscriber(subscriber: Redis): Promise<void> {
  await subscriber.connect();
}
