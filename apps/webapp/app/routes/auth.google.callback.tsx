import type { LoaderFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { prisma } from "~/db.server";
import { authenticator } from "~/services/auth.server";
import { setLastAuthMethodHeader } from "~/services/lastAuthMethod.server";
import {
  commitOperatorSession,
  destroySession,
  getSession,
  invalidatedLegacySessionCookies,
} from "~/services/sessionStorage.server";
import { trackAndClearReferralSource } from "~/services/referralSource.server";
import { redirectCookie } from "./auth.google";
import { sanitizeRedirectPath } from "~/utils";

export const loader: LoaderFunction = async ({ request }) => {
  const cookie = request.headers.get("Cookie");
  const redirectTo = sanitizeRedirectPath(await redirectCookie.parse(cookie));
  const login = await authenticator.authenticate("google", request, { failureRedirect: "/login" });
  const mfa = await prisma.operatorMfaTotp.findUnique({
    where: { userId: login.userId },
    select: { enabledAt: true },
  });

  const headers = new Headers();
  headers.append(
    "Set-Cookie",
    await commitOperatorSession(login.sessionToken, new Date(login.expiresAt))
  );
  headers.append("Set-Cookie", await destroySession(await getSession(cookie)));
  for (const legacyCookie of invalidatedLegacySessionCookies()) {
    headers.append("Set-Cookie", legacyCookie);
  }
  headers.append("Set-Cookie", await setLastAuthMethodHeader("google"));

  if (mfa?.enabledAt) return redirect("/login/mfa", { headers });
  await trackAndClearReferralSource(request, login.userId, headers);
  return redirect(redirectTo, { headers });
};
