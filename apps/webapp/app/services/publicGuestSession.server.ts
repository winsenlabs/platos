import { createHash } from "node:crypto";
import { createCookie } from "@remix-run/node";

const SAFE_AGENT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const ENVIRONMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The value a guest cookie carries: `<expiresAtSeconds>.<platformSessionToken>`.
 *
 * WHY THE EXPIRY IS INSIDE THE VALUE AND NOT ONLY IN THE `Expires` ATTRIBUTE.
 * `Expires` is a rule a BROWSER applies to itself: it decides when a user agent
 * stops SENDING a cookie, and it reaches no server. Nothing else about this
 * credential was left to the client — `HttpOnly` keeps it out of script, the
 * `__Secure-` prefix and `Secure` keep it off plaintext, `Partitioned` keeps it
 * out of a third party's jar, and the scope hash keeps agent A's session off
 * agent B's route — but its LIFETIME was, and a replayed cookie is not a browser.
 * A captured `Cookie:` header therefore stayed acceptable to this transport for
 * as long as the platform token behind it lived, and the only thing standing
 * between it and a turn was the upstream's own check.
 *
 * That is not a full bypass and is not described as one: the platform session
 * token has its own expiry and the agent enforces it. What it is, is a
 * transport that could not tell a live guest session from a dead one and so
 * spent an upstream round trip — and a rate-limit budget — finding out. The
 * expiry now travels where the server can read it, so a spent session is
 * refused here, before the agent is contacted at all.
 *
 * ONE DOT, SPLIT AT THE FIRST. A platform token may contain `.` (a JWT does), so
 * the prefix is taken up to the first separator and everything after it is the
 * token, byte for byte. Nothing is re-encoded, so the value forwarded upstream is
 * the value that was minted.
 */
const GUEST_VALUE = /^(\d{1,15})\.([\s\S]+)$/u;

/** The longest cookie value this transport will read, prefix included. */
const MAX_VALUE_BYTES = 8_192;

function guestCookie(agentId: string, environmentId: string) {
  if (!SAFE_AGENT_ID.test(agentId) || !ENVIRONMENT_ID.test(environmentId)) {
    throw new Error("Invalid public guest session scope");
  }
  const scopeHash = createHash("sha256")
    .update(`${agentId}:${environmentId}`)
    .digest("hex")
    .slice(0, 24);
  return createCookie(`__Secure-platos_public_guest_${scopeHash}`, {
    httpOnly: true,
    path: `/api/v1/public/agents/${encodeURIComponent(agentId)}/chat/stream`,
    sameSite: "none",
    secure: true,
  });
}

export async function serializePublicGuestSession(
  token: string,
  agentId: string,
  environmentId: string,
  expiresAt: number,
) {
  // BOTH HALVES CARRY THE SAME INSTANT. `Expires` is what stops a browser sending
  // a spent cookie at all; the prefix is what lets this server refuse one that is
  // sent anyway. Deriving them from one argument is what keeps them from drifting.
  const expiresAtSeconds = Math.floor(expiresAt);
  const serialized = await guestCookie(agentId, environmentId).serialize(
    `${String(expiresAtSeconds)}.${token}`,
    { expires: new Date(expiresAtSeconds * 1_000) },
  );
  // CHIPS keeps third-party iframe sessions isolated by top-level site while
  // SameSite=None permits the published cross-site embed transport.
  return `${serialized}; Partitioned`;
}

export async function publicGuestSessionToken(
  request: Request,
  agentId: string,
  environmentId: string,
  now: () => number = Date.now,
): Promise<string> {
  try {
    const value = await guestCookie(agentId, environmentId).parse(request.headers.get("Cookie"));
    if (typeof value !== "string" || value.length > MAX_VALUE_BYTES) return "";
    const parsed = GUEST_VALUE.exec(value);
    // A VALUE WITHOUT THE PREFIX IS REFUSED, WHICH IS THE FAIL-CLOSED DIRECTION AND
    // IS THE POINT. A cookie minted before this prefix existed is still sitting in
    // browsers; treating it as unbounded is the behaviour being removed, so it is
    // read as no session. The widget's first call is the guest-token mint, so the
    // observable consequence is one extra mint, not an error a visitor sees.
    if (parsed === null) return "";
    // SECONDS, AND `<=` RATHER THAN `<`. The mint writes whole seconds, so a
    // session whose last second has elapsed is spent; admitting the boundary would
    // hand the upstream a credential this transport has already called expired.
    if (Number(parsed[1]) * 1_000 <= now()) return "";
    return parsed[2];
  } catch {
    return "";
  }
}

export function sameOriginMutation(request: Request): boolean {
  const origin = request.headers.get("Origin");
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  return origin === new URL(request.url).origin && contentType === "application/json";
}
