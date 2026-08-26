import { test as base, expect, type BrowserContext } from "@playwright/test";
import { commitOperatorSession, operatorAuth } from "../../apps/webapp/app/services/auth.server";
import { loadFixtureManifest, type ScopeKey } from "./contracts";

type OperatorSessions = {
  loadCookie(context: BrowserContext, scope: ScopeKey): Promise<void>;
  metadata: {
    alpha: true;
    beta: true;
    issuance: "server-side-real-session";
    serialization: "commitOperatorSession";
    cookiePersistence: false;
  };
};

function serializedCookie(setCookie: string) {
  const pair = setCookie.split(";", 1)[0];
  const separator = pair.indexOf("=");
  if (separator <= 0) throw new Error("Operator session serializer returned an invalid cookie");
  return { name: pair.slice(0, separator), value: pair.slice(separator + 1) };
}

export const test = base.extend<{}, { operatorSessions: OperatorSessions }>({
  operatorSessions: [
    async ({}, use) => {
      const baseURL = process.env.WIN235_WEBAPP_URL;
      if (!baseURL) throw new Error("WIN235_WEBAPP_URL is required for browser evidence");
      const fixture = loadFixtureManifest();
      const scopes = Object.fromEntries(fixture.scopes.map((scope) => [scope.key, scope]));
      const issued = await Promise.all(
        (["alpha", "beta"] as const).map(async (key) => {
          const session = await operatorAuth.issueOperatorSession({
            userId: scopes[key].operatorId,
          });
          const cookie = serializedCookie(
            await commitOperatorSession(session.token, session.expiresAt)
          );
          // The test runner is not the production candidate. Match the production
          // server's cookie name while preserving the real serialized token value.
          cookie.name = "__Host-platos_operator_session";
          return [key, { token: session.token, expiresAt: session.expiresAt, cookie }] as const;
        })
      );
      const sessions = Object.fromEntries(issued) as Record<
        ScopeKey,
        { token: string; expiresAt: Date; cookie: { name: string; value: string } }
      >;
      const origin = new URL(baseURL).origin;
      const secureCookieOrigin = new URL(origin);
      secureCookieOrigin.protocol = "https:";

      await use({
        async loadCookie(context, scope) {
          const session = sessions[scope];
          await context.addCookies([
            {
              name: session.cookie.name,
              value: session.cookie.value,
              url: secureCookieOrigin.origin,
              httpOnly: true,
              sameSite: "Lax",
              secure: true,
              expires: Math.floor(session.expiresAt.getTime() / 1000),
            },
          ]);
        },
        metadata: {
          alpha: true,
          beta: true,
          issuance: "server-side-real-session",
          serialization: "commitOperatorSession",
          cookiePersistence: false,
        },
      });

      await Promise.all(
        Object.values(sessions).map(({ token }) =>
          operatorAuth.revokeOperatorSession(token).catch(() => false)
        )
      );
    },
    { scope: "worker" },
  ],
});

export { expect };
