import { PlatosAuthError, PlatosAuthService, type OperatorAuthorization } from "@platos/database";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { extractClientIp } from "~/utils/extractClientIp.server";
import { getOperatorSessionToken } from "./sessionStorage.server";

export const platosAuth = singleton(
  "platos-auth-service",
  () => new PlatosAuthService(prisma, { encryptionKey: env.ENCRYPTION_KEY })
);

export function requestRateLimitIdentifier(request: Request, subject: string) {
  const ipAddress = extractClientIp(request.headers.get("x-forwarded-for")) ?? "unknown";
  return `${subject.trim().toLowerCase()}:${ipAddress}`;
}

export async function authorizeRequest(
  request: Request,
  organizationId?: string
): Promise<OperatorAuthorization & { token: string }> {
  const token = await getOperatorSessionToken(request);
  const authorization = await platosAuth.authorizeOperatorSession(token, organizationId);
  return { ...authorization, token: token! };
}

export function isSessionResetError(error: unknown): error is PlatosAuthError {
  return (
    error instanceof PlatosAuthError &&
    ["unauthorized", "expired", "revoked"].includes(error.code)
  );
}
