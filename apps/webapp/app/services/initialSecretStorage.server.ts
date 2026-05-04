/**
 * Initial-secret flash storage (PPR-70).
 *
 * Holds a freshly-minted `PlatosConnectedEntity.serviceSecret` in Redis
 * for exactly ONE read, keyed by an unguessable token. The flow:
 *
 *   1. The `agent-entities/new` action mints the entity, stores the
 *      plaintext secret via `storeInitialSecret(plaintext)` and gets
 *      back an opaque token.
 *   2. The action 307-redirects to
 *      `/agent-entities/<entityId>/initial-secret?token=<T>`.
 *   3. The dedicated `initial-secret` route's loader calls
 *      `consumeInitialSecret(token)`, which DELETES the Redis key as
 *      part of the read. The secret renders exactly once.
 *   4. Any subsequent hit (refresh, shared link, back button, etc.)
 *      sees the token already consumed and renders the "secret already
 *      shown — use Regenerate" fallback.
 *
 * Why this (and not `useActionData`):
 *
 *   - `useActionData()` serializes the plaintext into the browser's
 *     action-data JSON. That JSON is reachable from client-side error
 *     trackers (Sentry, Datadog RUM), HAR dumps, and any client-side
 *     global that introspects Remix state. Even with `Cache-Control:
 *     no-store` (the PPR-12 mitigation), the secret still transits
 *     client-side memory inside the action-data object.
 *
 *   - Flashing via Redis keeps the secret server-side until the
 *     dedicated render page pulls it, then atomically deletes. Client
 *     JS never sees the plaintext on any other route — only on the
 *     "Copy once" page, rendered inline into HTML (no JSON payload).
 *
 * TTL is deliberately short (5 minutes). If the user closes the tab
 * before reading the page, the operator regenerates via the existing
 * "Regenerate" flow. TTL is also the upper bound on how long the
 * plaintext lives outside an encrypted DB cell.
 */

import { Redis } from "ioredis";
import { randomBytes } from "node:crypto";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { logger } from "./logger.server";

/** 5 minutes. Short enough that an abandoned flow cleans itself up. */
const TTL_SECONDS = 5 * 60;
const KEY_PREFIX = "platos:initial-secret:";

function initializeRedis(): Redis | undefined {
  const host = env.CACHE_REDIS_HOST;
  if (!host) return undefined;
  return new Redis({
    connectionName: "initialSecretStorage",
    host,
    port: env.CACHE_REDIS_PORT,
    username: env.CACHE_REDIS_USERNAME,
    password: env.CACHE_REDIS_PASSWORD,
    enableAutoPipelining: true,
    ...(env.CACHE_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  });
}

const redis = singleton("initialSecretStorage", initializeRedis);

/**
 * Persist a plaintext secret in Redis keyed by a freshly-minted
 * opaque token. Returns the token; store it in the redirect URL so
 * the "copy once" page can fetch + consume it.
 *
 * Throws if Redis is not configured — callers should treat that as a
 * configuration error, NOT fall back to inline rendering (that would
 * re-introduce the PPR-12 surface).
 */
export async function storeInitialSecret(plaintextSecret: string): Promise<string> {
  if (!redis) {
    throw new Error(
      "initialSecretStorage: Redis not configured. Set CACHE_REDIS_HOST (or REDIS_HOST) in the webapp env.",
    );
  }
  if (!plaintextSecret || plaintextSecret.length === 0) {
    throw new Error("initialSecretStorage: refusing to store empty secret");
  }
  // 32 bytes of entropy → 64 hex chars. Unguessable by brute force
  // inside the 5-minute window.
  const token = randomBytes(32).toString("hex");
  const key = `${KEY_PREFIX}${token}`;
  await redis.set(key, plaintextSecret, "EX", TTL_SECONDS);
  return token;
}

/**
 * Read and delete the plaintext in one atomic `GETDEL` call. Returns
 * `null` if the token is unknown, already consumed, or expired.
 *
 * `GETDEL` is ioredis >= 5 native and returns the old value while
 * removing the key in the same round trip — no TOCTOU window between
 * the read and the delete.
 */
export async function consumeInitialSecret(token: string): Promise<string | null> {
  if (!redis) return null;
  if (!token || token.length === 0) return null;
  try {
    const key = `${KEY_PREFIX}${token}`;
    // ioredis types sometimes miss the stringy GETDEL signature — cast
    // at the boundary rather than bending the whole call signature.
    const value = (await (redis as unknown as { getdel(k: string): Promise<string | null> }).getdel(key)) ?? null;
    return value;
  } catch (error) {
    logger.error("initialSecretStorage: failed to consume token", { error });
    return null;
  }
}
