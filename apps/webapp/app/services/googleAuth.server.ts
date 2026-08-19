import type { Authenticator } from "remix-auth";
import { GoogleStrategy } from "remix-auth-google";
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

export function addGoogleStrategy(
  authenticator: Authenticator<AuthUser>,
  clientID: string,
  clientSecret: string
) {
  const googleStrategy = new GoogleStrategy(
    {
      clientID,
      clientSecret,
      callbackURL: `${env.LOGIN_ORIGIN}/auth/google/callback`,
    },
    async ({ profile }) => {
      const emails = profile.emails;

      if (!emails?.length) {
        throw new Error("Google login requires an email address");
      }

      try {
        const email = emails[0].value;
        assertEmailAllowed(email);
        const session = await platosDashboardAuth.completeOAuthLogin({
          provider: OperatorIdentityProvider.GOOGLE,
          subject: profile.id,
          email,
          emailVerified: profile._json.email_verified === true,
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
        logger.error("Google login failed", { error: JSON.stringify(error) });
        throw error;
      }
    }
  );

  authenticator.use(googleStrategy);
}
