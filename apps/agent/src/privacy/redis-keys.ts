/**
 * Redis key planning for erasure.
 *
 * ioredis is configured with `keyPrefix: "platos:"` (shared/redis.provider.ts),
 * and that prefix behaves asymmetrically in a way that has already produced a
 * live bug in this codebase:
 *
 *   redis.keys("wm:*")  -> pattern is prefixed automatically, and the RETURNED
 *                          keys still carry the prefix: "platos:wm:…"
 *   redis.del(k)        -> PREPENDS the prefix again
 *
 * So feeding the output of keys()/scan() straight back into del() produces
 * "platos:platos:wm:…", which matches nothing and deletes nothing — silently,
 * because deleting a non-existent key is a successful no-op.
 *
 * This is not hypothetical. `working-memory.service.ts` carries the comment
 * "ioredis keyPrefix means we need to strip prefix for del" immediately above
 * code that does not strip it. And a double-prefixed key survives on the live
 * deployment right now: `platos:platos:dlq:spans:dead`.
 *
 * For erasure this failure mode is the worst available one: the sweep reports
 * success, verification re-scans with the same broken assumption, finds nothing,
 * and the receipt certifies that a person's data is gone while it sits in Redis.
 *
 * Hence: planning is pure and tested, deletion always goes through
 * `toDeletableKey`, and verification uses the on-wire form. Belt and braces,
 * because the cost of getting it wrong is a false legal statement.
 *
 * A note on the erasure surface itself. Two classes of key exist:
 *   SUBJECT-LINKED   per-thread traces, per-user cost counters — deletable.
 *   AGGREGATE        scope/agent daily rollups — float counters with no user
 *                    dimension. One person's contribution cannot be subtracted,
 *                    and they carry no personal data, so they are RETAINED and
 *                    reported as such rather than quietly skipped.
 */

export const REDIS_KEY_PREFIX = "platos:";

/**
 * Convert a key as returned by keys()/scan() into the form del() expects.
 *
 * Idempotent: safe whether or not the caller already stripped it, because the
 * one thing worse than a double prefix is a fix that only works once.
 */
export function toDeletableKey(scannedKey: string): string {
  return scannedKey.startsWith(REDIS_KEY_PREFIX)
    ? scannedKey.slice(REDIS_KEY_PREFIX.length)
    : scannedKey;
}

/** The on-wire key, for verification scans and for logging what was targeted. */
export function toWireKey(logicalKey: string): string {
  return logicalKey.startsWith(REDIS_KEY_PREFIX) ? logicalKey : REDIS_KEY_PREFIX + logicalKey;
}

export interface RedisSubjectRefs {
  threadIds: string[];
  legacyUserIds: string[];
  platosEndUserIds: string[];
  scopes: Array<{ organizationId: string; projectId: string; environmentId: string }>;
}

/**
 * Patterns for keys that belong to the subject and must be deleted.
 *
 * Expressed WITHOUT the prefix because ioredis adds it to scan patterns. Passing
 * a prefixed pattern to scan yields "platos:platos:…" and matches nothing — the
 * same asymmetry, from the other direction.
 */
export function subjectKeyPatterns(refs: RedisSubjectRefs): string[] {
  const out: string[] = [];
  for (const t of refs.threadIds) {
    if (!t) continue;
    out.push(`trace:thread:${t}`);
    out.push(`cost:thread:${t}`);
    out.push(`wm:${t}:*`);
    out.push(`chatsess:cursor:*:${t}`);
  }
  for (const s of refs.scopes) {
    const scopeKey = `${s.organizationId}:${s.projectId}:${s.environmentId}`;
    for (const u of refs.legacyUserIds) {
      if (!u) continue;
      // Per-user cost counters ARE subject-scoped and deletable, including the
      // ":reserved" budget-reservation siblings.
      out.push(`cost:user:${scopeKey}:${u}:*`);
      out.push(`rl:day:${scopeKey}:${u}:*`);
    }
  }
  return [...new Set(out)].sort();
}

/**
 * Patterns that look subject-adjacent but must NOT be deleted.
 *
 * Returned explicitly so the receipt can report them as `retained` with a
 * reason. A key silently skipped is indistinguishable from a key missed.
 */
export function retainedAggregatePatterns(refs: RedisSubjectRefs): string[] {
  const out: string[] = [];
  for (const s of refs.scopes) {
    const scopeKey = `${s.organizationId}:${s.projectId}:${s.environmentId}`;
    // Summed floats with no user dimension: a single contribution cannot be
    // subtracted, and no personal data is present to erase.
    out.push(`cost:scope:${scopeKey}:*`);
    out.push(`cost:agent:${scopeKey}:*`);
  }
  return [...new Set(out)].sort();
}

/**
 * Guard against deleting an aggregate by mistake.
 *
 * Pattern construction is one edit away from over-matching — `cost:*` would
 * take the rollups with it — so the destructive path asserts on each concrete
 * key rather than trusting the pattern that produced it.
 */
export function isRetainedAggregateKey(key: string): boolean {
  const k = toDeletableKey(key);
  return k.startsWith("cost:scope:") || k.startsWith("cost:agent:");
}

/**
 * Final safety filter applied to concrete scanned keys before deletion.
 *
 * Returns the keys in del() form, with aggregates removed. Anything that
 * survives here is genuinely subject-linked.
 */
export function planDeletions(scannedKeys: string[]): {
  deletable: string[];
  retained: string[];
} {
  const deletable: string[] = [];
  const retained: string[] = [];
  for (const raw of scannedKeys) {
    if (!raw) continue;
    if (isRetainedAggregateKey(raw)) retained.push(toDeletableKey(raw));
    else deletable.push(toDeletableKey(raw));
  }
  return {
    deletable: [...new Set(deletable)].sort(),
    retained: [...new Set(retained)].sort(),
  };
}
