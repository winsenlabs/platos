// THE one file in this directory that names the Redis client.
//
// ADR M0.3 §4 gives an adapter directory one vendor client and §5.1(h) is SDK
// containment: a second `ioredis` import anywhere under this directory would
// make "the sole holder of its vendor client" a claim nobody could check by
// reading. Every other file here is written against `RateLimitConnection` below.
//
// THE INTERFACE HAS ONE VERB, AND THAT IS THE DESIGN RATHER THAN AN ECONOMY.
// `rate-limiter.ts`'s port says an implementation "MUST make the read-and-
// increment atomic — two concurrent logins that each read 9 and each write 10
// have admitted eleven requests under a limit of ten". A connection publishing
// `read` and `write` would let a future edit compose them, and the composition
// would pass every single-threaded test ever written for it. So the only thing
// this interface can do to a counter is fold ONE request into it, server-side,
// in one round trip; `GET`, `SET` and `INCR` are not reachable from here.
//
// It is also what keeps `KEYS` and `FLUSHDB` out of reach. `KEYS` blocks the
// single-threaded server for the length of the whole keyspace and `FLUSHDB`
// would destroy every other owner's namespace — neither is on this interface, so
// no file in this directory can reach one.

// The NAMED export, not the default: the V1 solution compiles under NodeNext
// module resolution, where the CommonJS default is the module namespace object
// and is not constructable. `packages/adapters/redis-cache/src/client.ts` states
// the same thing for the same reason.
import { Redis } from "ioredis";

/** How the adapter reaches its server. One place, so the pool is one decision. */
export interface RateLimitConnectionOptions {
  /** `redis://host:port/db`, or a full URL with credentials. */
  readonly url: string;
  /**
   * Milliseconds a command may wait before it is abandoned.
   *
   * There is no unbounded wait. This limiter sits in front of sign-in, so a
   * command that hangs holds the login that asked for it: the refusal the
   * caller's fail-open policy is written to handle only arrives if the command
   * gives up.
   */
  readonly commandTimeoutMs?: number;
}

/** What this directory does to Redis, expressed as what it means. */
export interface RateLimitConnection {
  /**
   * Fold one request into `key`'s counter and return the counter AFTER it.
   *
   * ATOMIC, SERVER-SIDE, ONE ROUND TRIP. `ttlMs` is applied by the same script
   * that increments, and only when the counter is new or has somehow lost its
   * expiry — so a window can neither be created without a lifetime nor have its
   * lifetime extended by the traffic inside it.
   */
  foldIntoWindow(key: string, ttlMs: number): Promise<number>;
  close(): Promise<void>;
}

/**
 * The whole of the concurrency control, and it is four lines of Lua.
 *
 * Redis runs a script to completion with nothing interleaved, so `INCR` and the
 * expiry decision that follows it are one indivisible step. That is what makes
 * the last token of a window unshareable: of two processes that both arrive at a
 * counter of 9, one is handed 10 and the other 11, and `decide()` refuses the
 * eleventh. A client-side `GET` then `SET` would hand both of them 10.
 *
 * THE `PTTL` BRANCH IS NOT BELT-AND-BRACES. `INCR` on a missing key creates it
 * with NO expiry; if the process that created it died before a separate
 * `PEXPIRE`, the key would be immortal and that identifier would be locked out
 * of that action forever. Here there is no window between the two commands. The
 * branch covers the OTHER path to the same state — a key that reached this
 * server without an expiry — and costs one O(1) call on the first request of a
 * window.
 *
 * IT RETURNS THE COUNT AND NOTHING ELSE. The window start, the expiry instant
 * and the limit comparison are all the caller's, derived from the `at` it was
 * given; a script that decided anything would be a second copy of
 * `domain/rate-limit.ts` living on the server.
 */
const FOLD_INTO_WINDOW = `
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return count
`;

interface ScriptingRedis extends Redis {
  foldIntoWindow(key: string, ttlMs: string): Promise<number>;
}

/** Open the one connection this directory holds. */
export function createRateLimitConnection(options: RateLimitConnectionOptions): RateLimitConnection {
  const client = new Redis(options.url, {
    commandTimeout: options.commandTimeoutMs ?? 2_000,
    // FAIL RATHER THAN QUEUE. With the default, a command issued while the
    // connection is down is buffered and resolves whenever the server returns —
    // so the caller waits past its own timeout and the refusal never arrives.
    // An error is the answer `consume` is written to turn into a `Result`.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  }) as ScriptingRedis;

  // A PERMANENT ERROR LISTENER, OR THE PROCESS DIES. An `error` event with no
  // listener is rethrown by the emitter, so a Redis that went away would take
  // down a process whose whole design is to report that as a value. This is the
  // one place a connection failure is swallowed, and it is swallowed only as an
  // EVENT: every command still rejects, and `consume` turns that rejection into
  // `RATE_LIMITER_UNAVAILABLE`.
  client.on("error", () => undefined);

  // `defineCommand` registers the script ONCE and calls it by SHA thereafter,
  // falling back to a full `EVAL` when the server has not seen it (a restart, a
  // `SCRIPT FLUSH`, a different node). Sending the source on every request would
  // be correct and would put four lines of Lua on the wire in front of every
  // sign-in.
  client.defineCommand("foldIntoWindow", { numberOfKeys: 1, lua: FOLD_INTO_WINDOW });

  /**
   * Resolved once the handshake has finished.
   *
   * `enableOfflineQueue: false` is what makes a command fail rather than wait
   * when the server is gone, and it is also why this is needed: a command issued
   * between construction and the handshake has no queue to sit in and fails with
   * "Stream isn't writeable", which is not a fact about the server. Awaiting
   * readiness ONCE closes that window without reopening the one the flag exists
   * to close — after a later disconnect this promise is already settled, so the
   * command goes straight to the socket and fails fast.
   */
  const ready: Promise<void> =
    client.status === "ready"
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
          client.once("ready", () => resolve());
          // Only until `ready` settles it: a promise cannot be rejected twice,
          // so a later transient error cannot poison a live connection.
          client.once("error", (error: Error) => reject(error));
        });

  // Nothing awaits `ready` until a command is issued, so a server that is
  // unreachable AT CONSTRUCTION rejects it with no handler attached and Node
  // kills the process on the unhandled rejection — before `consume` could turn
  // it into a refusal. Attaching a handler swallows it for nobody: an `await
  // ready` inside `foldIntoWindow` still rejects, because attaching a handler
  // settles nothing.
  void ready.catch(() => undefined);

  return {
    async foldIntoWindow(key, ttlMs) {
      await ready;
      // The TTL crosses as a STRING. `ioredis` stringifies arguments anyway, and
      // saying so here is what stops a future float — a millisecond remainder,
      // say — reaching `PEXPIRE` as `1.5` and being refused by the server as a
      // malformed integer.
      return await client.foldIntoWindow(key, String(ttlMs));
    },
    async close() {
      try {
        // GRACEFUL FIRST. `QUIT` lets the server finish sending the replies it
        // already owes and close the socket itself, which is the difference
        // between a clean release and a reset the server logs as an error.
        await client.quit();
      } catch {
        // AND IT IS A COMMAND, so it needs a writable stream — and there is none
        // when the handshake never completed. A caller asked for the connection
        // to be released; a server that was never reached is not a reason to
        // refuse.
      } finally {
        // UNCONDITIONAL, AND THIS IS THE HALF THAT ACTUALLY RELEASES. A `quit()`
        // that could not be sent leaves the client in its reconnect loop with a
        // live retry timer, so a process that has decided to stop keeps the
        // event loop turning until the orchestrator forces it down.
        client.disconnect();
      }
    },
  };
}
