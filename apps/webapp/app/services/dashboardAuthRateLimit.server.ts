import { createHash } from "node:crypto";
import { normalizeBridgeEmail } from "./dashboardIdentity.server";

const OPERATOR_SESSION_RATE_LIMIT_DOMAIN = "platos-auth-rate-limit:operator-session\0";

export function authEmailRateLimitIdentifier(email: string): string {
  return `email:${normalizeBridgeEmail(email)}`;
}

export function authSessionRateLimitIdentifier(sessionToken: string): string {
  const digest = createHash("sha256")
    .update(OPERATOR_SESSION_RATE_LIMIT_DOMAIN)
    .update(sessionToken)
    .digest("hex");
  return `operator-session:${digest}`;
}
