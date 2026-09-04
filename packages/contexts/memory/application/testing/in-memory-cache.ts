// An in-memory `Cache`.
//
// IT HONOURS TTLs AGAINST THE INJECTED CLOCK, which is the only reason it is
// worth having: a throttle test steps the clock and the entry expires, with no
// timer and no sleep. A double that ignored expiry would let every TTL in this
// context be wrong without a single test noticing.
//
// IT REFUSES A BLANK NAMESPACE, exactly as the port requires an adapter to. That
// is not defensive coding here — it is the one behaviour of `deleteNamespace`
// that a reviewer would want proven, because the failure mode is a flush of the
// whole keyspace.
//
// IT CAN BE MADE TO FAIL, so the "a cache failure is a MISS" policy in
// `application/working-memory.ts` is exercised rather than assumed.

import { err, ok, type Clock, type Result } from "@platos/kernel";

import { cacheUnavailable } from "../../domain/index.js";
import type { Cache, CacheEntry } from "../ports/index.js";

interface StoredEntry {
  readonly value: string;
  readonly expiresAt: number;
}

export class InMemoryCache implements Cache {
  private readonly entries = new Map<string, StoredEntry>();
  private failure: string | null = null;

  /** Every key read, in order. Lets a test assert the cache was consulted. */
  readonly reads: string[] = [];
  readonly writes: CacheEntry[] = [];

  constructor(private readonly clock: Clock) {}

  failWith(reason: string | null): void {
    this.failure = reason;
  }

  /** Seed a key without going through a use case. */
  seed(key: string, value: string, ttlSeconds = 3600): void {
    this.entries.set(key, { value, expiresAt: this.clock.now().getTime() + ttlSeconds * 1000 });
  }

  keys(): readonly string[] {
    return [...this.entries.keys()].sort();
  }

  async get(key: string): Promise<Result<string | null>> {
    this.reads.push(key);
    if (this.failure !== null) return err(cacheUnavailable(this.failure));
    const stored = this.entries.get(key);
    if (stored === undefined) return ok(null);
    if (stored.expiresAt <= this.clock.now().getTime()) {
      this.entries.delete(key);
      return ok(null);
    }
    return ok(stored.value);
  }

  async set(entry: CacheEntry): Promise<Result<void>> {
    if (this.failure !== null) return err(cacheUnavailable(this.failure));
    if (entry.ttlSeconds <= 0) {
      return err(cacheUnavailable("a cache write must carry a positive time to live"));
    }
    this.writes.push(entry);
    this.entries.set(entry.key, {
      value: entry.value,
      expiresAt: this.clock.now().getTime() + entry.ttlSeconds * 1000,
    });
    return ok(undefined);
  }

  async delete(key: string): Promise<Result<boolean>> {
    if (this.failure !== null) return err(cacheUnavailable(this.failure));
    return ok(this.entries.delete(key));
  }

  async deleteNamespace(prefix: string): Promise<Result<number>> {
    if (this.failure !== null) return err(cacheUnavailable(this.failure));
    if (prefix.length === 0) {
      return err(cacheUnavailable("a namespace delete requires a non-empty prefix"));
    }
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (!key.startsWith(prefix)) continue;
      this.entries.delete(key);
      removed += 1;
    }
    return ok(removed);
  }
}
