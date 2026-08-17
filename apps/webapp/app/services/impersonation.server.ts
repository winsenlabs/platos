import { platosAuth } from "./platosAuth.server";
import { commitOperatorSession, getOperatorSessionToken } from "./sessionStorage.server";
import { extractClientIp } from "~/utils/extractClientIp.server";

function requestAuditContext(request: Request) {
  return {
    ipAddress: extractClientIp(request.headers.get("x-forwarded-for")) ?? undefined,
    userAgent: request.headers.get("user-agent") ?? undefined,
  };
}

export async function getImpersonationId(request: Request) {
  const token = await getOperatorSessionToken(request);
  if (!token) return undefined;
  try {
    const authorization = await platosAuth.authorizeOperatorSession(token);
    return authorization.impersonation?.targetUserId;
  } catch {
    return undefined;
  }
}

export async function startImpersonation(userId: string, request: Request) {
  const sessionToken = await getOperatorSessionToken(request);
  const issued = await platosAuth.startImpersonation({
    sessionToken: sessionToken ?? "",
    targetUserId: userId,
    ...requestAuditContext(request),
  });
  return commitOperatorSession(issued.token, issued.expiresAt);
}

export async function stopImpersonation(request: Request) {
  const sessionToken = await getOperatorSessionToken(request);
  const issued = await platosAuth.stopImpersonation({
    sessionToken: sessionToken ?? "",
    ...requestAuditContext(request),
  });
  return commitOperatorSession(issued.token, issued.expiresAt);
}
