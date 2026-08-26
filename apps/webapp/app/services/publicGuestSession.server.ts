import { createHash } from "node:crypto";
import { createCookie } from "@remix-run/node";

const SAFE_AGENT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const ENVIRONMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  const serialized = await guestCookie(agentId, environmentId).serialize(token, {
    expires: new Date(expiresAt * 1_000),
  });
  // CHIPS keeps third-party iframe sessions isolated by top-level site while
  // SameSite=None permits the published cross-site embed transport.
  return `${serialized}; Partitioned`;
}

export async function publicGuestSessionToken(
  request: Request,
  agentId: string,
  environmentId: string,
): Promise<string> {
  try {
    const value = await guestCookie(agentId, environmentId).parse(request.headers.get("Cookie"));
    return typeof value === "string" && value.length <= 8_192 ? value : "";
  } catch {
    return "";
  }
}

export function sameOriginMutation(request: Request): boolean {
  const origin = request.headers.get("Origin");
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  return origin === new URL(request.url).origin && contentType === "application/json";
}
