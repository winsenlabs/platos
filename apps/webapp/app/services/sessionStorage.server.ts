import { createCookieSessionStorage } from "@remix-run/node";
import { operatorSessionCookie as serializeOperatorSessionCookie } from "@platos/database";
import { parse as parseCookie } from "cookie";
import { env } from "~/env.server";

export const OPERATOR_SESSION_COOKIE_NAME = "__Host-platos_operator_session";
const LEGACY_COOKIE_NAMES = ["__session", "__impersonate", "platos_operator_session"] as const;

// remix-auth uses this only while an OAuth provider redirects back to Platos.
// The authenticated browser session is always the opaque database-backed token
// in operatorSessionCookie; no user or scope identity is trusted from this flow cookie.
export const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: "platos_auth_flow",
    sameSite: "lax",
    path: "/",
    httpOnly: true,
    secrets: [env.SESSION_SECRET],
    secure: env.NODE_ENV === "production",
    maxAge: 60 * 15,
  },
});

export function getUserSession(request: Request) {
  return sessionStorage.getSession(request.headers.get("Cookie"));
}

export async function getOperatorSessionToken(request: Request): Promise<string | null> {
  const value = parseCookie(request.headers.get("Cookie") ?? "")[OPERATOR_SESSION_COOKIE_NAME];
  return typeof value === "string" && value.startsWith("plt_os_") ? value : null;
}

export function commitOperatorSession(token: string, expiresAt?: Date) {
  const cookie = serializeOperatorSessionCookie(token);
  return expiresAt ? `${cookie}; Expires=${expiresAt.toUTCString()}` : cookie;
}

export function destroyOperatorSession() {
  return `${OPERATOR_SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

export function invalidatedLegacySessionCookies(): string[] {
  return LEGACY_COOKIE_NAMES.map(
    (name) => `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
  );
}

export async function appendSessionResetCookies(headers: Headers) {
  headers.append("Set-Cookie", await destroyOperatorSession());
  for (const cookie of invalidatedLegacySessionCookies()) headers.append("Set-Cookie", cookie);
}

export const { getSession, commitSession, destroySession } = sessionStorage;
