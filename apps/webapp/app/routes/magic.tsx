import { redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirectWithErrorMessage } from "~/models/message.server";
import { setLastAuthMethodHeader } from "~/services/lastAuthMethod.server";
import { getRedirectTo } from "~/services/redirectTo.server";
import { commitSession, getSession } from "~/services/sessionStorage.server";
import { trackAndClearReferralSource } from "~/services/referralSource.server";
import { destroyImpersonationSession } from "~/services/impersonation.server";
import {
  bridgeVerifiedEmailToLegacyUser,
  canonicalEmailForUser,
  commitOperatorSession,
  isMfaRequired,
  platosDashboardAuth,
} from "~/services/platosDashboardAuth.server";
import type { CanonicalUserId } from "~/services/dashboardIdentity.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const redirectTo = await getRedirectTo(request);

  const token = new URL(request.url).searchParams.get("token");
  if (!token) {
    return redirectWithErrorMessage("/login/magic", request, "This magic link is invalid or expired.");
  }

  let auth;
  try {
    auth = await platosDashboardAuth.consumeMagicLink(token);
  } catch {
    return redirectWithErrorMessage("/login/magic", request, "This magic link is invalid or expired.");
  }

  // manually get the session
  const session = await getSession(request.headers.get("cookie"));

  const email = await canonicalEmailForUser(auth.userId as CanonicalUserId);
  const bridge = email ? await bridgeVerifiedEmailToLegacyUser(email) : null;
  if (!bridge) {
    return redirectWithErrorMessage(
      "/login/magic",
      request,
      "Could not safely match your dashboard account. Please contact support."
    );
  }

  try {
    await platosDashboardAuth.authorizeOperatorSession(auth.token);
  } catch (error) {
    if (!isMfaRequired(error)) throw error;
    session.set("pending-mfa-redirect-to", redirectTo ?? "/");

    const headers = new Headers();
    headers.append("Set-Cookie", await commitSession(session));
    headers.append("Set-Cookie", await commitOperatorSession(auth.token, auth.expiresAt));
    headers.append("Set-Cookie", await destroyImpersonationSession(request));
    headers.append("Set-Cookie", await setLastAuthMethodHeader("email"));

    return redirect("/login/mfa", { headers });
  }

  const headers = new Headers();
  headers.append("Set-Cookie", await commitSession(session));
  headers.append("Set-Cookie", await commitOperatorSession(auth.token, auth.expiresAt));
  headers.append("Set-Cookie", await destroyImpersonationSession(request));
  headers.append("Set-Cookie", await setLastAuthMethodHeader("email"));

  await trackAndClearReferralSource(request, bridge.legacyUserId, headers);

  return redirect(redirectTo ?? "/", { headers });
}
