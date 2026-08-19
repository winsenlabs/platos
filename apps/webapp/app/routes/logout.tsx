import { redirect, type ActionFunction, type LoaderFunction } from "@remix-run/node";
import { clearOAuthSession } from "~/services/auth.server";
import { destroyImpersonationSession } from "~/services/impersonation.server";
import { destroySession, getUserSession } from "~/services/sessionStorage.server";
import {
  clearOperatorSession,
  getOperatorSessionToken,
  platosDashboardAuth,
} from "~/services/platosDashboardAuth.server";

async function logout(request: Request) {
  const token = await getOperatorSessionToken(request);
  if (token) await platosDashboardAuth.revokeOperatorSession(token).catch(() => false);

  const headers = new Headers();
  headers.append("Set-Cookie", await clearOperatorSession());
  headers.append("Set-Cookie", await clearOAuthSession(request));
  headers.append("Set-Cookie", await destroyImpersonationSession(request));
  headers.append("Set-Cookie", await destroySession(await getUserSession(request)));
  return redirect("/", { headers });
}

export const action: ActionFunction = async ({ request }) => logout(request);

export const loader: LoaderFunction = async ({ request }) => logout(request);
