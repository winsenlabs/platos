import { afterEach, describe, expect, it, vi } from "vitest";
import type Redis from "ioredis";
import {
  acquireTurnMutex,
  TURN_MUTEX_HEARTBEAT_MS,
  TURN_MUTEX_TTL_MS,
} from "./agent-task.service";

class FakeRedis {
  private readonly values = new Map<string, { token: string; expiresAt: number }>();
  readonly successfulRenewalTokens: string[] = [];
  readonly eval = vi.fn(this.runEval.bind(this));

  async set(
    key: string,
    token: string,
    mode: string,
    ttlMs: number,
    condition: string,
  ): Promise<"OK" | null> {
    this.expireIfNeeded(key);
    expect([mode, condition]).toEqual(["PX", "NX"]);
    if (this.values.has(key)) return null;
    this.values.set(key, { token, expiresAt: Date.now() + ttlMs });
    return "OK";
  }

  forceExpire(key: string): void {
    this.values.delete(key);
  }

  tokenFor(key: string): string | null {
    this.expireIfNeeded(key);
    return this.values.get(key)?.token ?? null;
  }

  private async runEval(
    script: string,
    keyCount: number,
    key: string,
    token: string,
    ttlMs?: number,
  ): Promise<number> {
    expect(keyCount).toBe(1);
    this.expireIfNeeded(key);
    const current = this.values.get(key);
    if (current?.token !== token) return 0;

    if (script.includes("pexpire")) {
      current.expiresAt = Date.now() + Number(ttlMs);
      this.successfulRenewalTokens.push(token);
      return 1;
    }

    if (script.includes("del")) {
      this.values.delete(key);
      return 1;
    }

    throw new Error("Unexpected Lua script");
  }

  private expireIfNeeded(key: string): void {
    const current = this.values.get(key);
    if (current && current.expiresAt <= Date.now()) this.values.delete(key);
  }
}

describe("Redis turn mutex", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reacquires after expiry without letting the stale owner release the successor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const redis = new FakeRedis();
    const key = "turn:org:project:env:thread";

    const staleOwner = await acquireTurnMutex(redis as unknown as Redis, key);
    expect(staleOwner).not.toBeNull();
    vi.setSystemTime(TURN_MUTEX_TTL_MS + 1);

    const successor = await acquireTurnMutex(redis as unknown as Redis, key);
    expect(successor).not.toBeNull();
    expect(successor!.token).not.toBe(staleOwner!.token);

    await staleOwner!.release();
    expect(redis.tokenFor(key)).toBe(successor!.token);

    await successor!.release();
    expect(redis.tokenFor(key)).toBeNull();
  });

  it("does not let a stale heartbeat renew a successor lock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const redis = new FakeRedis();
    const key = "turn:org:project:env:successor-thread";

    const staleOwner = await acquireTurnMutex(redis as unknown as Redis, key);
    redis.forceExpire(key);
    const successor = await acquireTurnMutex(redis as unknown as Redis, key);

    await vi.advanceTimersByTimeAsync(TURN_MUTEX_HEARTBEAT_MS);

    expect(redis.successfulRenewalTokens).toEqual([successor!.token]);
    expect(redis.tokenFor(key)).toBe(successor!.token);

    await staleOwner!.release();
    await successor!.release();
  });

  it("renews the bounded lease while active and stops its timer on release", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const redis = new FakeRedis();
    const key = "turn:org:project:env:renewed-thread";

    const owner = await acquireTurnMutex(redis as unknown as Redis, key);
    expect(owner).not.toBeNull();

    await vi.advanceTimersByTimeAsync(TURN_MUTEX_TTL_MS + 1);
    expect(redis.successfulRenewalTokens.length).toBeGreaterThan(0);
    expect(await acquireTurnMutex(redis as unknown as Redis, key)).toBeNull();

    await owner!.release();
    const evalCallsAfterRelease = redis.eval.mock.calls.length;
    await vi.advanceTimersByTimeAsync(TURN_MUTEX_TTL_MS * 2);

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("pexpire"),
      1,
      key,
      owner!.token,
      TURN_MUTEX_TTL_MS,
    );
    expect(redis.eval.mock.calls).toHaveLength(evalCallsAfterRelease);
    expect(redis.tokenFor(key)).toBeNull();
  });
});
