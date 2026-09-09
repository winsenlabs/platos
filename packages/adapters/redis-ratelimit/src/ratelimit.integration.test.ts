// THE ONE CLAIM ONLY A REAL SERVER CAN SETTLE.
//
// `application/ports/rate-limiter.ts`: "An implementation MUST make the
// read-and-increment atomic — two concurrent logins that each read 9 and each
// write 10 have admitted eleven requests under a limit of ten." A `Map` cannot
// exhibit that, a sequential loop cannot exhibit it, and a mock cannot exhibit
// it — which is why this file needs a daemon and why `package.json` excludes it
// from the laptop run. The unit suites in this directory prove the wiring; this
// one proves the property the wiring exists for.
//
// CONTENDERS GET THEIR OWN CONNECTIONS. A single `ioredis` client pipelines its
// commands down one socket in issue order, so N calls through one connection are
// N sequential requests wearing a concurrency costume. `harness.connect()` opens
// a fresh client per contender, so the interleaving is the SERVER's.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  windowFor,
  type RateLimitPolicy,
  type RateLimiter,
  type TokenHash,
} from "@platos/context-identity-access/application/ports/index.js";

import { startRedisHarness, type RedisHarness } from "./harness.js";
import { bucketKey, createRedisRateLimiter } from "./rate-limiter.js";

const POLICY: RateLimitPolicy = { requests: 10, windowMs: 60_000 };
const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as TokenHash;
const AT = new Date("2026-03-04T10:17:41.250Z");

let harness: RedisHarness;

beforeAll(async () => {
  harness = await startRedisHarness();
}, 180_000);

afterEach(async () => {
  await harness.reset();
});

afterAll(async () => {
  await harness?.stop();
});

/** One limiter per contender, each over its own connection to the same server. */
function contenders(count: number): RateLimiter[] {
  return Array.from({ length: count }, () => createRedisRateLimiter(harness.connect()));
}

describe("the last token of a window cannot be taken twice", () => {
  it("hands 32 simultaneous consumers 32 DISTINCT counts", async () => {
    const racers = contenders(32);
    const results = await Promise.all(
      racers.map((limiter) =>
        limiter.consume({ action: "LOGIN", identifierHash: HASH, policy: POLICY, at: AT }),
      ),
    );
    const counts = results.map((result) => (result.ok ? result.value.requestCount : -1));
    // THE WHOLE PROPERTY, IN ONE LINE. A `GET` then `SET` would hand two racers
    // the same number; a duplicate here means two logins were admitted against
    // one token. The SET's size is what makes it falsifiable — the values
    // themselves are the server's business.
    expect(new Set(counts).size).toBe(32);
    expect([...counts].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 32 }, (_unused, index) => index + 1),
    );
  }, 60_000);

  it("admits exactly `requests` of them under the policy's limit", async () => {
    const racers = contenders(POLICY.requests + 6);
    const results = await Promise.all(
      racers.map((limiter) =>
        limiter.consume({ action: "MFA_VERIFY", identifierHash: HASH, policy: POLICY, at: AT }),
      ),
    );
    // The port's comparison, applied by the caller: `requestCount > requests`
    // refuses. Under a correct atomic increment exactly `requests` of the
    // contenders come back at or below the limit, however they interleaved.
    const admitted = results.filter(
      (result) => result.ok && result.value.requestCount <= POLICY.requests,
    );
    expect(admitted).toHaveLength(POLICY.requests);
  }, 60_000);

  it("keeps two identifiers racing at the same instant in separate windows", async () => {
    const other = "f".repeat(64) as TokenHash;
    const mine = contenders(8);
    const theirs = contenders(8);
    const results = await Promise.all([
      ...mine.map((limiter) =>
        limiter.consume({ action: "LOGIN", identifierHash: HASH, policy: POLICY, at: AT }),
      ),
      ...theirs.map((limiter) =>
        limiter.consume({ action: "LOGIN", identifierHash: other, policy: POLICY, at: AT }),
      ),
    ]);
    const counts = results.map((result) => (result.ok ? result.value.requestCount : -1));
    // Eight each, so 1..8 appears TWICE across the sixteen.
    expect(counts.filter((count) => count === 8)).toHaveLength(2);
    const { keys } = await harness.inspect();
    expect(keys).toHaveLength(2);
  }, 60_000);
});

describe("the window expires because the caller's clock advanced", () => {
  it("restarts at one when `at` crosses the boundary, with no sleeping", async () => {
    const [limiter] = contenders(1);
    if (limiter === undefined) throw new Error("no contender");
    const start = windowFor(AT, POLICY).windowStart;
    for (let request = 0; request < 9; request += 1) {
      await limiter.consume({ action: "LOGIN", identifierHash: HASH, policy: POLICY, at: AT });
    }
    const rolled = await limiter.consume({
      action: "LOGIN",
      identifierHash: HASH,
      policy: POLICY,
      at: new Date(start.getTime() + POLICY.windowMs),
    });
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;
    // A REAL SERVER STILL HOLDS THE OLD KEY — its TTL has not fired, because no
    // real time passed. The counter reset anyway, which is the point: rollover
    // is a property of the ADDRESS, and the TTL is only reclamation.
    expect(rolled.value.requestCount).toBe(1);
    const { keys } = await harness.inspect();
    expect(keys).toHaveLength(2);
  }, 60_000);

  it("writes the remaining window as the counter's lifetime, once", async () => {
    const [limiter] = contenders(1);
    if (limiter === undefined) throw new Error("no contender");
    const start = windowFor(AT, POLICY).windowStart;
    const at = new Date(start.getTime() + 10_000);
    await limiter.consume({ action: "LOGIN", identifierHash: HASH, policy: POLICY, at });
    const first = (await harness.inspect()).ttlMs.get(bucketKey("LOGIN", HASH, start));
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(50_000);

    // A LATER REQUEST IN THE SAME WINDOW MUST NOT EXTEND IT. A limiter that
    // re-applied the TTL on every request would keep a busy identifier's window
    // alive indefinitely, and the counter would never reset for exactly the
    // traffic the limit is for.
    const later = new Date(start.getTime() + 40_000);
    await limiter.consume({ action: "LOGIN", identifierHash: HASH, policy: POLICY, at: later });
    const second = (await harness.inspect()).ttlMs.get(bucketKey("LOGIN", HASH, start));
    expect(second).toBeLessThanOrEqual(first ?? 0);
  }, 60_000);

  it("never leaves a counter without a lifetime", async () => {
    const [limiter] = contenders(1);
    if (limiter === undefined) throw new Error("no contender");
    await limiter.consume({ action: "INVITE_ACCEPT", identifierHash: HASH, policy: POLICY, at: AT });
    const { keys, ttlMs } = await harness.inspect();
    for (const key of keys) {
      // `PTTL` answers -1 for a key with no expiry. A key that reached that
      // state would lock one identifier out of one action forever.
      expect(ttlMs.get(key), key).toBeGreaterThan(0);
    }
  }, 60_000);
});

describe("a server that goes away mid-life", () => {
  it("refuses, and refuses CLOSED, rather than admitting the request", async () => {
    const connection = harness.connect();
    const limiter = createRedisRateLimiter(connection);
    const before = await limiter.consume({
      action: "LOGIN",
      identifierHash: HASH,
      policy: POLICY,
      at: AT,
    });
    expect(before.ok).toBe(true);

    // Close the client rather than the container: the container is shared by the
    // whole file, and what is being proved is the adapter's behaviour when its
    // command cannot reach a server — which a closed client reproduces exactly
    // and reversibly.
    await connection.close();

    const after = await limiter.consume({
      action: "LOGIN",
      identifierHash: HASH,
      policy: POLICY,
      at: AT,
    });
    expect(after.ok).toBe(false);
    if (after.ok) return;
    expect(after.error.code).toBe("RATE_LIMITER_UNAVAILABLE");
  }, 60_000);
});
