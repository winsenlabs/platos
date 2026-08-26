/**
 * @platosdev/token-mint — HS256 JWT session-token minting for Platos.
 *
 * A Platos session token is a 3-part HS256 JWT signed with your
 * entity's `serviceSecret`. It embeds the scope tuple
 * (organizationId, projectId, environmentId, userId) + an optional
 * opaque per-user token + iat/exp. The agent validates the signature
 * against the same serviceSecret and accepts the claims.
 *
 * This library exists because every customer who wanted to wire up
 * Platos was previously handed "implement HS256 HMAC against this
 * payload spec" — the test-vector footprint was small but the
 * byte-order trap was real. Three-line minting instead.
 *
 * Usage:
 *
 *   import { mintSessionToken } from "@platosdev/token-mint";
 *
 *   const token = mintSessionToken({
 *     serviceSecret: process.env.PLATOS_ENTITY_SERVICE_SECRET!,
 *     claims: {
 *       organizationId: "org_abc",
 *       projectId:      "prj_def",
 *       environmentId:  "env_ghi",
 *       userId:         "usr_jkl",
 *       entityId:       "my-entity",
 *       userToken:      "opaque-user-proof-123",
 *     },
 *     ttlSeconds: 3600,
 *   });
 *
 *   // Return to the browser so the Platos client can authenticate.
 *   res.json({ token });
 *
 * Test vectors: see `__tests__/vectors.test.ts`.
 *
 * EOBD.94.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface MintSessionClaims {
  /** trigger.dev Organization.id — the tenant axis. */
  organizationId: string;
  /** trigger.dev Project.id — within the org. */
  projectId: string;
  /** trigger.dev RuntimeEnvironment.id — dev/staging/prod axis. */
  environmentId: string;
  /** The acting user id. */
  userId: string;
  /** Entity whose `serviceSecret` signs this token. */
  entityId: string;
  /**
   * Opaque per-user token forwarded to tool backends as
   * `X-Platos-User-Token`. Customer-owned shape — can be their own JWT,
   * a signed nonce, a random id, whatever their tool handlers expect.
   */
  userToken?: string;
  /**
   * Any additional claims the caller wants embedded. Must not collide
   * with the reserved keys above or the JWT standard `iat` / `exp`.
   */
  [extra: string]: unknown;
}

export interface MintSessionTokenInput {
  /**
   * The entity's service secret. Stored encrypted in Platos via the
   * `PlatosConnectedEntity.serviceSecret` column; your backend sees the
   * plaintext only inside the mint call. Never send this to a browser.
   */
  serviceSecret: string;
  /** Claims embedded in the JWT payload. */
  claims: MintSessionClaims;
  /**
   * Token TTL in seconds. Default 3600 (1 hour). Keep short; the
   * Platos client re-mints via `onTokenRefresh`.
   */
  ttlSeconds?: number;
  /**
   * Issued-at unix timestamp — used by tests for deterministic vectors.
   * Defaults to `Math.floor(Date.now() / 1000)`.
   */
  iatSeconds?: number;
}

export interface DecodedSessionToken {
  header: { alg: string; typ: string };
  payload: MintSessionClaims & { iat: number; exp: number };
  signatureValid: boolean;
}

/**
 * Produce an HS256 JWT session token signed with the entity's
 * serviceSecret. The output format is
 * `base64url(header) . base64url(payload) . base64url(hmac-sha256(header + "." + payload, serviceSecret))`
 * matching the agent's `AuthService.validateSessionToken` expectations.
 */
export function mintSessionToken(input: MintSessionTokenInput): string {
  if (!input.serviceSecret || input.serviceSecret.length < 16) {
    throw new Error(
      "mintSessionToken: serviceSecret is required and must be at least 16 chars",
    );
  }
  if (!input.claims.organizationId || !input.claims.projectId || !input.claims.environmentId) {
    throw new Error(
      "mintSessionToken: claims must include organizationId, projectId, environmentId",
    );
  }
  if (!input.claims.userId) {
    throw new Error("mintSessionToken: claims.userId is required");
  }
  if (!input.claims.entityId?.trim()) {
    throw new Error("mintSessionToken: claims.entityId is required");
  }

  const ttl = input.ttlSeconds ?? 3600;
  if (ttl < 60) throw new Error("mintSessionToken: ttlSeconds must be >= 60");
  if (ttl > 86400 * 7) {
    throw new Error(
      "mintSessionToken: ttlSeconds > 7 days is refused — use a shorter TTL + onTokenRefresh",
    );
  }

  const iat = input.iatSeconds ?? Math.floor(Date.now() / 1000);
  const exp = iat + ttl;

  const header = { alg: "HS256", typ: "JWT" };
  const payload = { ...input.claims, iat, exp };

  const headerB64 = base64UrlEncode(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = createHmac("sha256", input.serviceSecret)
    .update(signingInput)
    .digest();
  const signatureB64 = base64UrlEncode(signature);

  return `${signingInput}.${signatureB64}`;
}

/**
 * Decode + verify a session token. Returns the parsed header + payload
 * along with a boolean indicating whether the signature matched.
 *
 * Use this in tests or in an admin introspection tool — production
 * traffic is verified by the agent itself, never by the customer's
 * backend.
 */
export function decodeSessionToken(
  token: string,
  serviceSecret?: string,
): DecodedSessionToken {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("decodeSessionToken: expected 3 parts");
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const header = JSON.parse(base64UrlDecode(headerB64).toString("utf8"));
  const payload = JSON.parse(base64UrlDecode(payloadB64).toString("utf8"));

  let signatureValid = false;
  if (serviceSecret) {
    const expected = createHmac("sha256", serviceSecret)
      .update(`${headerB64}.${payloadB64}`)
      .digest();
    const provided = base64UrlDecode(signatureB64);
    signatureValid =
      expected.length === provided.length &&
      timingSafeEqual(expected, provided);
  }

  return { header, payload, signatureValid };
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(s: string): Buffer {
  const padded = s + "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
