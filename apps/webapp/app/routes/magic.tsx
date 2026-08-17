import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { platosAuth } from "~/services/platosAuth.server";
import { setLastAuthMethodHeader } from "~/services/lastAuthMethod.server";
import { getRedirectTo } from "~/services/redirectTo.server";
import {
  commitOperatorSession,
  invalidatedLegacySessionCookies,
} from "~/services/sessionStorage.server";
import { trackAndClearReferralSource } from "~/services/referralSource.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) return redirect("/login/magic?error=Invalid%20or%20expired%20login%20link.");

  try {
    const redirectTo = (await getRedirectTo(request)) ?? "/";
    const login = await platosAuth.consumeMagicLink(token);
    const mfa = await prisma.operatorMfaTotp.findUnique({
      where: { userId: login.userId },
      select: { enabledAt: true },
    });
    const headers = new Headers();
    headers.append("Set-Cookie", await commitOperatorSession(login.token, login.expiresAt));
    for (const cookie of invalidatedLegacySessionCookies()) headers.append("Set-Cookie", cookie);
    headers.append("Set-Cookie", await setLastAuthMethodHeader("email"));

    if (mfa?.enabledAt) return redirect("/login/mfa", { headers });
    await trackAndClearReferralSource(request, login.userId, headers);
    return redirect(redirectTo, { headers });
  } catch {
    return redirect("/login/magic?error=Invalid%20or%20expired%20login%20link.");
  }
}
