import type { Authenticator } from "remix-auth";
import { GitHubStrategy } from "remix-auth-github";
import { env } from "~/env.server";
import type { AuthUser } from "./authUser";
import { logger } from "./logger.server";
import { platosAuth } from "./platosAuth.server";
import { OperatorIdentityProvider } from "@platos/database";

export function addGitHubStrategy(
  authenticator: Authenticator<AuthUser>,
  clientID: string,
  clientSecret: string
) {
  const gitHubStrategy = new GitHubStrategy(
    {
      clientID,
      clientSecret,
      callbackURL: `${env.LOGIN_ORIGIN}/auth/github/callback`,
    },
    async ({ extraParams, profile }) => {
      const emails = profile.emails;

      if (!emails?.length) {
        throw new Error("GitHub login requires an email address");
      }

      try {
        logger.debug("GitHub login", {
          emails,
          profile,
          extraParams,
        });

        const login = await platosAuth.completeOAuthLogin({
          provider: OperatorIdentityProvider.GITHUB,
          subject: profile.id,
          email: emails[0].value,
          emailVerified: true,
          rateLimitIdentifier: `github:${profile.id}`,
        });
        return {
          userId: login.userId,
          sessionToken: login.token,
          expiresAt: login.expiresAt.toISOString(),
        };
      } catch (error) {
        logger.error("GitHub login failed", { error: JSON.stringify(error) });
        throw error;
      }
    }
  );

  authenticator.use(gitHubStrategy);
}
