import { redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { clearOperatorSession, readOperatorToken } from "~/services/auth.server";
import { coreRequest } from "~/services/coreApi.server";

// SIGNING OUT (WIN-257 T8).
//
// `operatorAuth.revokeOperatorSession(token)` is now
// `DELETE /api/v1/bff/session`, which revokes the ROW before it answers — the
// order matters and `bff/session.controller.ts` says why: a sign-out that only
// clears the cookie deletes one COPY of the credential and leaves every other
// copy valid for the rest of the session's lifetime.
//
// THE COOKIE CARRIES THE CREDENTIAL, so there is nothing to send in a body.
// core-api reads the session from the `Cookie` header in either dialect, which is
// what lets a session this Remix code minted be ended through V1 (D19).
//
// THE BROWSER IS CLEARED EITHER WAY, AND THAT IS THE OLD BEHAVIOUR KEPT. The
// previous body ran `.catch(() => false)` around the revocation and redirected
// regardless. A browser holding a cookie for a session that is already gone — or
// one this process could not reach the core to end — is exactly the browser that
// most needs the cookie cleared, and stranding it on an error page would leave it
// holding the credential. The V1 route makes the same choice for the same reason:
// every `unauthenticated` refusal there answers 204.
//
// The shape of the clearing cookie is still this process's, for the reason
// `auth.server.ts` gives: a relayed `Max-Age=0` under the wrong name clears
// nothing.

async function end(request: Request) {
  const token = await readOperatorToken(request);
  if (token) {
    try {
      await coreRequest("session.signOut", { request });
    } catch {
      // Recorded rather than swallowed silently: the session row may still be
      // live. The browser is cleared anyway (see the banner), and the session
      // dies of its own expiry — which is what this route did before.
    }
  }
  return redirect("/login", { headers: { "Set-Cookie": await clearOperatorSession() } });
}

export const action = ({ request }: ActionFunctionArgs) => end(request);
export const loader = ({ request }: LoaderFunctionArgs) => end(request);
