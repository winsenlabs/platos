import type { CanonicalUserId } from "./dashboardIdentity.server";

export type AuthUser = {
  /** Retained only for unconverted legacy impersonation cleanup code. */
  userId?: string;
  canonicalUserId: CanonicalUserId;
  email: string;
  sessionToken: string;
  sessionExpiresAt: string;
};
