import { createCookieSessionStorage } from "@remix-run/node";
import { env } from "~/env.server";

/**
 * Tiny dedicated cookie store for the most-recently-submitted login email.
 * Used solely so the `/login/magic` loader can decide whether to render the
 * operator passcode affordance — the email match is UI gating, NOT auth.
 * Actual passcode validation is constant-time against BACKDOOR_PLATOS_DEV.
 *
 * Lives in its own cookie (not __session) because the magic-link strategy
 * commits its own copy of __session on its redirect response, which would
 * clobber any keys we set there.
 */
const ONE_DAY = 60 * 60 * 24;
const COOKIE_NAME = "__platos_last_email";

const storage = createCookieSessionStorage({
  cookie: {
    name: COOKIE_NAME,
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secrets: [env.SESSION_SECRET],
    secure: env.NODE_ENV === "production",
    maxAge: ONE_DAY,
  },
});

export async function getLastEmailFromRequest(request: Request): Promise<string | null> {
  const session = await storage.getSession(request.headers.get("Cookie"));
  const v = session.get("email");
  return typeof v === "string" ? v : null;
}

export async function commitLastEmailCookie(email: string): Promise<string> {
  const session = await storage.getSession();
  session.set("email", email);
  return storage.commitSession(session);
}
