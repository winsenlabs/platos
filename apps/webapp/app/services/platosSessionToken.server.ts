import * as crypto from "node:crypto";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";

/**
 * Mint a platform-issued Platos session token for a browser Socket.IO
 * connection to the agent service.
 *
 * Must use the same `PLATOS_SESSION_SECRET` the agent container has
 * (`apps/agent/src/auth/auth.service.ts` checks for `iss: "platos-platform"`
 * and verifies against `process.env.PLATOS_SESSION_SECRET`).
 *
 * Browser handshake shape:
 *   io(`${wsUrl}/agent`, { auth: { token } })
 *
 * Returns null if PLATOS_SESSION_SECRET is not configured — caller must
 * fail closed (block the WS connection, surface a clear error to the user).
 * Tokens are short-lived (1 hour default); callers are responsible for
 * re-minting if long-lived sessions are needed.
 */
export interface PlatosSessionClaims {
  organizationId: string;
  projectId: string;
  environmentId: string;
  userId: string;
  userToken?: string;
  permissions?: string[];
}

export function mintPlatosSessionToken(
  claims: PlatosSessionClaims,
  ttlSeconds: number = 3600,
): { token: string; exp: number } | null {
  const secret = env.PLATOS_SESSION_SECRET;
  if (!secret) {
    logger.warn(
      "mintPlatosSessionToken: PLATOS_SESSION_SECRET not configured — cannot mint. Browser WS connections to the agent will be rejected on proxied requests.",
    );
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const exp = now + ttlSeconds;
  const payload = {
    organizationId: claims.organizationId,
    projectId: claims.projectId,
    environmentId: claims.environmentId,
    userId: claims.userId,
    userToken: claims.userToken,
    permissions: claims.permissions,
    iss: "platos-platform" as const,
    iat: now,
    exp,
  };

  // EOBD.1 — mint a standard 3-part HS256 JWT so external integrators
  // can use `jsonwebtoken`, `jose`, PyJWT, or any compliant library.
  // Header + payload + signature, base64url-encoded, dot-separated.
  // The agent's validateSessionToken accepts both this format and the
  // legacy 2-part format (see auth.service.ts) for one release so
  // in-flight browser tabs don't break across the upgrade.
  const headerB64 = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");

  return { token: `${signingInput}.${signature}`, exp };
}
