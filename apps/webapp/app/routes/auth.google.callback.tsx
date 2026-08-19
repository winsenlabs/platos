import { redirect, type LoaderFunction } from "@remix-run/node";
import { redirectWithErrorMessage } from "~/models/message.server";
import { authenticator, clearOAuthSession } from "~/services/auth.server";
import { setLastAuthMethodHeader } from "~/services/lastAuthMethod.server";
import { commitSession, getSession } from "~/services/sessionStorage.server";
import { trackAndClearReferralSource } from "~/services/referralSource.server";
import { destroyImpersonationSession } from "~/services/impersonation.server";
import { redirectCookie } from "./auth.google";
import { sanitizeRedirectPath } from "~/utils";
import {
  bridgeVerifiedEmailToLegacyUser,
  commitOperatorSession,
  isMfaRequired,
  platosDashboardAuth,
} from "~/services/platosDashboardAuth.server";

export let loader: LoaderFunction = async ({ request }) => {
  const cookie = request.headers.get("Cookie");
  const redirectValue = await redirectCookie.parse(cookie);
  const redirectTo = sanitizeRedirectPath(redirectValue);

  const auth = await authenticator.authenticate("google", request, {
    failureRedirect: "/login", // If auth fails, the failureRedirect will be thrown as a Response
  });

  const session = await getSession(request.headers.get("cookie"));
  const bridge = await bridgeVerifiedEmailToLegacyUser(auth.email);
  if (!bridge) {
    const response = await redirectWithErrorMessage(
      "/login",
      request,
      "Could not safely match your dashboard account. Please contact support."
    );
    response.headers.append("Set-Cookie", await clearOAuthSession(request));
    return response;
  }

  try {
    await platosDashboardAuth.authorizeOperatorSession(auth.sessionToken);
  } catch (error) {
    if (!isMfaRequired(error)) throw error;
    session.set("pending-mfa-redirect-to", redirectTo);

    const headers = new Headers();
    headers.append("Set-Cookie", await commitSession(session));
    headers.append("Set-Cookie", await clearOAuthSession(request));
    headers.append("Set-Cookie", await destroyImpersonationSession(request));
    headers.append(
      "Set-Cookie",
      await commitOperatorSession(auth.sessionToken, new Date(auth.sessionExpiresAt))
    );
    headers.append("Set-Cookie", await setLastAuthMethodHeader("google"));

    return redirect("/login/mfa", { headers });
  }

  const headers = new Headers();
  headers.append("Set-Cookie", await commitSession(session));
  headers.append("Set-Cookie", await clearOAuthSession(request));
  headers.append("Set-Cookie", await destroyImpersonationSession(request));
  headers.append(
    "Set-Cookie",
    await commitOperatorSession(auth.sessionToken, new Date(auth.sessionExpiresAt))
  );
  headers.append("Set-Cookie", await setLastAuthMethodHeader("google"));

  await trackAndClearReferralSource(request, bridge.legacyUserId, headers);

  return redirect(redirectTo, { headers });
};
