import type { Authenticator } from "remix-auth";
import { GoogleStrategy } from "remix-auth-google";
import { env } from "~/env.server";
import type { AuthUser } from "./authUser";
import { logger } from "./logger.server";
import { platosAuth } from "./platosAuth.server";
import { OperatorIdentityProvider } from "@platos/database";

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
    async ({ extraParams, profile }) => {
      const emails = profile.emails;

      if (!emails?.length) {
        throw new Error("Google login requires an email address");
      }

      try {
        logger.debug("Google login", {
          emails,
          profile,
          extraParams,
        });

        const login = await platosAuth.completeOAuthLogin({
          provider: OperatorIdentityProvider.GOOGLE,
          subject: profile.id,
          email: emails[0].value,
          emailVerified: profile._json.email_verified !== false,
          rateLimitIdentifier: `google:${profile.id}`,
        });
        return {
          userId: login.userId,
          sessionToken: login.token,
          expiresAt: login.expiresAt.toISOString(),
        };
      } catch (error) {
        logger.error("Google login failed", { error: JSON.stringify(error) });
        throw error;
      }
    }
  );

  authenticator.use(googleStrategy);
}
