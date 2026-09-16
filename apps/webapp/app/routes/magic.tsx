import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { commitOperatorSession, operatorTokenFromSetCookie } from "~/services/auth.server";
import { coreRequest, type CoreMagicLinkSession } from "~/services/coreApi.server";

// SPENDING A MAGIC LINK (WIN-257 T8, D19, D20).
//
// `operatorAuth.consumeMagicLink(token)` is now
// `POST /api/v1/bff/magic-link/complete`, which is `completeMagicLinkLogin`. The
// session token comes back INSIDE a `Set-Cookie` core-api rendered from a
// directive identity-access minted — never in the body, which carries ids and an
// expiry and nothing else.
//
// AND THE HEADER IS NOT RELAYED. core-api decides `Secure` and the `__Host-`
// prefix from ITS OWN connection, which here is the plain-HTTP hop this process
// opened across the compose network. Passing its header through would hand a
// browser on HTTPS a non-`__Host-`, non-`Secure` session cookie — a downgrade
// performed by the cutover, on every sign-in. `auth.server.ts` states this at
// length.
//
// SO THE VALUE TRAVELS AND THE SHAPE DOES NOT, and D19 is what makes that
// possible: core-api writes the value in Remix's own dialect
// (`base64(JSON.stringify(token))`, `transports/rest/session-cookie-value.ts`),
// so the webapp's own `createCookie(...).parse` reads the token straight back out
// and `commitOperatorSession` re-serializes it under the shape this process
// derives from `NODE_ENV` — the same bytes a browser received before the cutover.
//
// EVERY FAILURE IS ONE REDIRECT. Unknown, expired, already spent, raced, disabled
// account: `completeMagicLinkLogin` answers one `UNAUTHENTICATED` for all of them
// on purpose, and this route has never told a visitor which.

export async function loader({ request }: LoaderFunctionArgs) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) throw redirect("/login");
  try {
    const completed = await coreRequest<CoreMagicLinkSession>("magicLink.complete", {
      request,
      body: { token },
    });
    const session = await operatorTokenFromSetCookie(completed.headers.get("set-cookie"));
    // A completion that answered 200 and no readable session is a broken
    // install, not a bad link, and sending the visitor back to /login to try
    // again would loop them. It is the one case this route distinguishes.
    if (session === null) throw redirect("/login?error=session-unavailable");
    return redirect("/", {
      headers: { "Set-Cookie": await commitOperatorSession(session, new Date(completed.data.expiresAt)) },
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    throw redirect("/login?error=invalid-link");
  }
}
