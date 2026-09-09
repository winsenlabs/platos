// What the adapter does, without a server.
//
// WHAT THIS SUITE CAN AND CANNOT PROVE, SAID UP FRONT because this tranche
// exists because test doubles lied. A `Map` in one process CANNOT exhibit the
// concurrency the port requires — `ratelimit.integration.test.ts` is where that
// claim is made, against a real server and real contenders. What is provable
// here is the wiring: which key, which window, which count, which TTL, and what
// happens when the command fails. Every one of those is a way the adapter could
// be wrong while a real Redis behaved perfectly.

import { describe, expect, it } from "vitest";

import {
  windowFor,
  type RateLimitPolicy,
  type TokenHash,
} from "@platos/context-identity-access/application/ports/index.js";

import { buildRedisRatelimitAdapter } from "./adapter.js";
import { countingConnection, deadConnection } from "./harness.js";
import { bucketKey, createRedisRateLimiter, reclamationTtlMs } from "./rate-limiter.js";

const POLICY: RateLimitPolicy = { requests: 10, windowMs: 60_000 };
// A 64-hex digest, the shape `SecretHasher.hash` produces. It is a LITERAL and
// not a hash computed here, because the point is that the adapter passes through
// whatever it is given.
const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" as TokenHash;
const AT = new Date("2026-03-04T10:17:41.250Z");

describe("the bucket a consumption folds into", () => {
  it("carries the window the DOMAIN computes for the caller's instant", async () => {
    const limiter = createRedisRateLimiter(countingConnection());
    const consumed = await limiter.consume({ action: "LOGIN", identifierHash: HASH, policy: POLICY, at: AT });

    expect(consumed.ok).toBe(true);
    if (!consumed.ok) return;
    // Joined to `windowFor`, which is the domain's, rather than to a literal
    // instant written here: the two cannot disagree because there is one
    // definition of the rollover rule and this is not a second copy of it.
    const window = windowFor(AT, POLICY);
    expect(consumed.value.windowStart).toEqual(window.windowStart);
    expect(consumed.value.expiresAt).toEqual(window.expiresAt);
    expect(consumed.value.action).toBe("LOGIN");
  });

  it("reports the count the server returned, including this request", async () => {
    const connection = countingConnection();
    const limiter = createRedisRateLimiter(connection);
    const counts: number[] = [];
    for (let request = 0; request < 4; request += 1) {
      const consumed = await limiter.consume({ action: "LOGIN", identifierHash: HASH, policy: POLICY, at: AT });
      if (consumed.ok) counts.push(consumed.value.requestCount);
    }
    // 1 and not 0 for the first request: the port says `requestCount` INCLUDES
    // this request, which is why a caller compares with `>` and a policy of ten
    // admits the tenth.
    expect(counts).toEqual([1, 2, 3, 4]);
  });

  it("does not re-hash the identifier, and puts it in the key verbatim", async () => {
    const connection = countingConnection();
    await createRedisRateLimiter(connection).consume({
      action: "LOGIN",
      identifierHash: HASH,
      policy: POLICY,
      at: AT,
    });
    const [call] = connection.calls;
    expect(call?.key).toContain(HASH);
    // The namespace ADR M0.3 §4 asks each adapter for, and nothing before it.
    expect(call?.key.startsWith("platos:identity:ratelimit:")).toBe(true);
  });
});

describe("the window rolls over because the KEY changes, not because a TTL fired", () => {
  const start = windowFor(AT, POLICY).windowStart;

  it("keeps one key for every instant inside a window", () => {
    const inside = [0, 1, 30_000, POLICY.windowMs - 1].map(
      (offset) => new Date(start.getTime() + offset),
    );
    const keys = new Set(
      inside.map((at) => bucketKey("LOGIN", HASH, windowFor(at, POLICY).windowStart)),
    );
    expect(keys.size).toBe(1);
  });

  it("addresses a DIFFERENT key the instant the window ends", () => {
    const last = new Date(start.getTime() + POLICY.windowMs - 1);
    const next = new Date(start.getTime() + POLICY.windowMs);
    expect(bucketKey("LOGIN", HASH, windowFor(last, POLICY).windowStart)).not.toBe(
      bucketKey("LOGIN", HASH, windowFor(next, POLICY).windowStart),
    );
  });

  it("starts the next window's counter at one, with the clock ADVANCED and never read", async () => {
    const limiter = createRedisRateLimiter(countingConnection());
    for (let request = 0; request < 7; request += 1) {
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
    expect(rolled.value.requestCount).toBe(1);
  });

  it("separates two actions and two identifiers that share an instant", async () => {
    const connection = countingConnection();
    const limiter = createRedisRateLimiter(connection);
    const other = ("f".repeat(64)) as TokenHash;
    await limiter.consume({ action: "LOGIN", identifierHash: HASH, policy: POLICY, at: AT });
    await limiter.consume({ action: "MFA_VERIFY", identifierHash: HASH, policy: POLICY, at: AT });
    await limiter.consume({ action: "LOGIN", identifierHash: other, policy: POLICY, at: AT });
    expect(connection.counters.size).toBe(3);
    expect([...connection.counters.values()]).toEqual([1, 1, 1]);
  });
});

describe("the lifetime the counter is written with", () => {
  it("is what remains of the caller's window, never more than the window", () => {
    const start = windowFor(AT, POLICY).windowStart;
    const at = new Date(start.getTime() + 10_000);
    expect(reclamationTtlMs(at, windowFor(at, POLICY).expiresAt, POLICY.windowMs)).toBe(50_000);
    expect(reclamationTtlMs(start, windowFor(start, POLICY).expiresAt, POLICY.windowMs)).toBe(
      POLICY.windowMs,
    );
  });

  it("is never zero or negative, because PEXPIRE 0 is a DELETE", () => {
    const past = new Date(AT.getTime() + 5_000);
    // A clock that moved backwards between two requests, or an `at` past the
    // boundary: the remaining time is negative and the key must still survive.
    expect(reclamationTtlMs(past, AT, POLICY.windowMs)).toBe(1);
    expect(reclamationTtlMs(AT, AT, POLICY.windowMs)).toBe(1);
  });

  it("is an integer, because PEXPIRE refuses a fraction", () => {
    const at = new Date(AT.getTime());
    const expires = new Date(AT.getTime() + 1234.7);
    expect(Number.isInteger(reclamationTtlMs(at, expires, POLICY.windowMs))).toBe(true);
  });
});

describe("a Redis that is gone", () => {
  it("refuses with its own code rather than throwing", async () => {
    const consumed = await createRedisRateLimiter(deadConnection()).consume({
      action: "LOGIN",
      identifierHash: HASH,
      policy: POLICY,
      at: AT,
    });
    expect(consumed.ok).toBe(false);
    if (consumed.ok) return;
    expect(consumed.error.code).toBe("RATE_LIMITER_UNAVAILABLE");
    expect(consumed.error.category).toBe("unavailable");
    // DISTINCT FROM THE STORE'S. Two guards answering under one code cannot be
    // told apart, and `consume-rate-limit.ts` copies this code into the safety
    // event it records — so an operator reading that event can say WHICH
    // dependency went away.
    expect(consumed.error.code).not.toBe("IDENTITY_STORE_UNAVAILABLE");
  });

  it("FAILS CLOSED: it never invents a bucket a caller could mistake for a quiet window", async () => {
    const limiter = createRedisRateLimiter(deadConnection());
    // The counter is named `call` because the vocabulary boundary reserves the
    // obvious alternative for retry metadata elsewhere, and this loop is five
    // separate calls into a dead connection rather than five retries of one.
    for (let call = 0; call < 5; call += 1) {
      const consumed = await limiter.consume({
        action: "LOGIN",
        identifierHash: HASH,
        policy: POLICY,
        at: AT,
      });
      // A synthesised `requestCount: 1` would be indistinguishable from a real
      // first request: `decide()` would allow it, no safety event would be
      // recorded, and the outage would be invisible.
      expect(consumed.ok).toBe(false);
    }
  });

  it("carries the driver's MESSAGE and never the connection URL", async () => {
    const secret = "redis://default:hunter2@cache.internal:6379/0";
    const consumed = await createRedisRateLimiter(deadConnection("READONLY replica")).consume({
      action: "LOGIN",
      identifierHash: HASH,
      policy: POLICY,
      at: AT,
    });
    expect(consumed.ok).toBe(false);
    if (consumed.ok) return;
    expect(consumed.error.details).toEqual({ reason: "READONLY replica" });
    expect(JSON.stringify(consumed.error)).not.toContain(secret);
    // And the hash never reaches the failure either — it is a stable identifier
    // for one principal, and a refusal is a log line.
    expect(JSON.stringify(consumed.error)).not.toContain(HASH);
  });
});

describe("the adapter the composition root binds", () => {
  it("names itself and delegates the port", async () => {
    const adapter = buildRedisRatelimitAdapter(countingConnection());
    expect(adapter.adapterName).toBe("redis-ratelimit");
    const consumed = await adapter.consume({
      action: "INVITE_ACCEPT",
      identifierHash: HASH,
      policy: POLICY,
      at: AT,
    });
    expect(consumed.ok).toBe(true);
    await adapter.close();
  });
});
