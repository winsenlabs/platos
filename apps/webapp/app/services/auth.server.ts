import { createCookieSessionStorage } from "@remix-run/node";
import { Authenticator } from "remix-auth";
import type { AuthUser } from "./authUser";
import { addGitHubStrategy } from "./gitHubAuth.server";
import { addGoogleStrategy } from "./googleAuth.server";
import { env } from "~/env.server";

// Remix Auth is retained only for the OAuth handshake. Keep its transient
// state isolated from the legacy dashboard `__session` cookie so an inherited
// Trigger auth payload can never be treated as a successful OAuth result.
const oauthSessionStorage = createCookieSessionStorage({
  cookie: {
    name: env.NODE_ENV === "production" ? "__Host-platos_oauth" : "platos_oauth",
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secrets: [env.SESSION_SECRET],
    secure: env.NODE_ENV === "production",
    maxAge: 15 * 60,
  },
});

const authenticator = new Authenticator<AuthUser>(oauthSessionStorage);

const isGithubAuthSupported =
  typeof env.AUTH_GITHUB_CLIENT_ID === "string" &&
  typeof env.AUTH_GITHUB_CLIENT_SECRET === "string";

const isGoogleAuthSupported =
  typeof env.AUTH_GOOGLE_CLIENT_ID === "string" &&
  typeof env.AUTH_GOOGLE_CLIENT_SECRET === "string";

if (env.AUTH_GITHUB_CLIENT_ID && env.AUTH_GITHUB_CLIENT_SECRET) {
  addGitHubStrategy(authenticator, env.AUTH_GITHUB_CLIENT_ID, env.AUTH_GITHUB_CLIENT_SECRET);
}

if (env.AUTH_GOOGLE_CLIENT_ID && env.AUTH_GOOGLE_CLIENT_SECRET) {
  addGoogleStrategy(authenticator, env.AUTH_GOOGLE_CLIENT_ID, env.AUTH_GOOGLE_CLIENT_SECRET);
}

export { authenticator, isGithubAuthSupported, isGoogleAuthSupported };

export async function clearOAuthSession(request: Request): Promise<string> {
  const session = await oauthSessionStorage.getSession(request.headers.get("Cookie"));
  return oauthSessionStorage.destroySession(session);
}
