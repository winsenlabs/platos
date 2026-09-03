// The `Cache` port — OWNED AND PUBLISHED BY THIS CONTEXT.
//
// ADR M0.3 §13 fixes the ownership explicitly, and explains it: "`Cache` is
// intentionally owned by `memory`; Redis is an implementation detail and does not
// define architectural ownership." `packages/adapters/redis-cache` is its one
// adapter, and it holds the only Redis client in this half of the system
// (§5.1(h) SDK containment, §4 "one namespaced keyspace and one owner each").
//
// FOUR PROPERTIES THIS INTERFACE MUST HAVE, and why each is shaped as it is:
//
// 1. IT NAMES NO VENDOR. No connection option, no pipeline, no client type. What
//    varies between cache technologies is already decided by the caller:
//    `domain/working-set.ts` mints every key this port will ever be given, so an
//    adapter honours a finished key rather than composing one.
//
// 2. EVERY WRITE CARRIES ITS TTL. There is no `set` without one and no
//    server-side default. A cached memory projection that outlived its
//    invalidation would serve one subject's profile after it had been rewritten,
//    and the failure would be invisible — so the lifetime is stated at every
//    call site rather than configured once somewhere else.
//
// 3. VALUES ARE STRINGS. Serialisation belongs to the caller, because the caller
//    is the only party that knows whether a value is a projection it may reshape
//    or an opaque watermark it may not. An adapter that parsed JSON would be
//    deciding, silently, that every value is JSON.
//
// 4. FAILURE IS A VALUE, AND MOST CALLERS IGNORE IT. Every method returns
//    `Result`, and the use cases in this context treat a cache failure as a MISS
//    rather than as an error — `readOrMiss` in `application/cached-profile.ts` is
//    the one place that policy lives. The port still reports the failure, because
//    "the cache is down" and "the key was absent" are different facts and an
//    operator needs to be able to tell them apart.

import type { Result } from "@platos/kernel";

export interface CacheEntry {
  readonly key: string;
  readonly value: string;
  /** Seconds. Required, and must be positive — see property 2 above. */
  readonly ttlSeconds: number;
}

export interface Cache {
  /** The stored value, or null when the key is absent or has expired. */
  get(key: string): Promise<Result<string | null>>;

  set(entry: CacheEntry): Promise<Result<void>>;

  /** True when a key was removed, false when there was nothing to remove. */
  delete(key: string): Promise<Result<boolean>>;

  /**
   * Remove every key under a namespace, and report how many went.
   *
   * The one bulk operation, and it exists because clearing a conversation's
   * working memory is a real product event (the conversation ended) that would
   * otherwise be a client-side scan. An implementation MUST NOT expose a general
   * pattern match: `deleteNamespace("")` would be a flush of the whole keyspace,
   * so the prefix is required to be non-empty and an adapter refuses a blank one.
   */
  deleteNamespace(prefix: string): Promise<Result<number>>;
}
