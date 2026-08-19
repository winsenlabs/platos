import type { Authenticator } from "remix-auth";
import { GitHubStrategy } from "remix-auth-github";
import { env } from "~/env.server";
import type { AuthUser } from "./authUser";
import { logger } from "./logger.server";
import { OperatorIdentityProvider } from "@platos/tenancy-database";
import { assertEmailAllowed } from "~/utils/email";
import { canonicalUserId } from "./dashboardIdentity.server";
import {
  authEmailRateLimitIdentifier,
  canonicalEmailForUser,
  platosDashboardAuth,
} from "./platosDashboardAuth.server";

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
    async ({ profile }) => {
      const emails = profile.emails;

      if (!emails?.length) {
        throw new Error("GitHub login requires an email address");
      }

      try {
        const email = emails[0].value;
        assertEmailAllowed(email);
        const session = await platosDashboardAuth.completeOAuthLogin({
          provider: OperatorIdentityProvider.GITHUB,
          subject: profile.id,
          email,
          // remix-auth-github requests user:email and filters the API response
          // to verified addresses before constructing profile.emails.
          emailVerified: true,
          rateLimitIdentifier: authEmailRateLimitIdentifier(email),
        });
        const canonicalId = canonicalUserId(session.userId);
        const canonicalEmail = await canonicalEmailForUser(canonicalId);
        if (!canonicalEmail) throw new Error("Canonical OAuth user was not found");

        return {
          canonicalUserId: canonicalId,
          email: canonicalEmail,
          sessionToken: session.token,
          sessionExpiresAt: session.expiresAt.toISOString(),
        };
      } catch (error) {
        logger.error("GitHub login failed", { error: JSON.stringify(error) });
        throw error;
      }
    }
  );

  authenticator.use(gitHubStrategy);
}
