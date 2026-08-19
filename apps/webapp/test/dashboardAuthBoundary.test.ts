import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("dashboard auth route boundary", () => {
  it("uses the explicit clean control datasource without repointing legacy URLs", () => {
    const control = source("../app/services/platosControlDatabase.server.ts");
    const compose = source("../../../docker-compose.platos.yml");
    expect(control).toContain("env.PLATOS_CONTROL_DATABASE_URL");
    expect(control).not.toContain("env.DATABASE_URL");
    expect(compose).toContain("PLATOS_CONTROL_DATABASE_URL:");
    expect(compose).toContain("POSTGRES_LEGACY_DB:-platos_legacy");
    expect(compose).toContain("POSTGRES_DB:-platos_control");
    expect(compose).not.toContain("POSTGRES_DB:-postgres");
    expect(compose).toContain("[migrations-init] ensuring the clean control database exists");
    expect(compose).toContain("SELECT 1 FROM pg_database WHERE datname='${POSTGRES_DB:-platos_control}'");
  });

  it("uses server-controlled rate-limit identities instead of caller-supplied XFF", () => {
    const magic = source("../app/routes/login.magic/route.tsx");
    const mfa = source("../app/routes/login.mfa/route.tsx");
    const setup = source("../app/routes/resources.account.mfa.setup/route.tsx");
    const github = source("../app/services/gitHubAuth.server.ts");
    const google = source("../app/services/googleAuth.server.ts");

    expect(magic).toContain("authEmailRateLimitIdentifier(email)");
    expect(magic).not.toContain("x-forwarded-for");
    expect(magic).not.toContain("checkMagicLinkIpRateLimit");
    expect(github).toContain("authEmailRateLimitIdentifier(email)");
    expect(google).toContain("authEmailRateLimitIdentifier(email)");
    expect(mfa).toContain("authSessionRateLimitIdentifier(sessionToken)");
    expect(setup).toContain("authSessionRateLimitIdentifier(operator.token)");
  });

  it("routes login callbacks, MFA verification, and logout through PlatosAuthService", () => {
    const files = [
      "../app/routes/magic.tsx",
      "../app/routes/auth.github.callback.tsx",
      "../app/routes/auth.google.callback.tsx",
      "../app/routes/login.mfa/route.tsx",
      "../app/routes/resources.account.mfa.setup/route.tsx",
      "../app/routes/logout.tsx",
    ].map(source);
    expect(files[0]).toContain("platosDashboardAuth.consumeMagicLink");
    expect(files[1]).toContain("commitOperatorSession");
    expect(files[2]).toContain("commitOperatorSession");
    expect(files[3]).toContain("platosDashboardAuth.verifyMfaForSession");
    expect(files[4]).toContain("platosDashboardAuth.confirmTotpEnrollment");
    expect(files[5]).toContain("platosDashboardAuth.revokeOperatorSession");
  });

  it("bridges OAuth callbacks from the canonical user email, not mutable provider profile data", () => {
    const github = source("../app/services/gitHubAuth.server.ts");
    const google = source("../app/services/googleAuth.server.ts");
    for (const strategy of [github, google]) {
      expect(strategy).toContain("canonicalEmailForUser(canonicalId)");
      expect(strategy).toContain("email: canonicalEmail");
    }
  });

  it("isolates transient OAuth state from the inherited dashboard session cookie", () => {
    const auth = source("../app/services/auth.server.ts");
    const logout = source("../app/routes/logout.tsx");
    expect(auth).toContain("new Authenticator<AuthUser>(oauthSessionStorage)");
    expect(auth).not.toContain("new Authenticator<AuthUser>(sessionStorage)");
    expect(auth).toContain('"__Host-platos_oauth"');
    expect(source("../app/routes/auth.github.callback.tsx")).toContain(
      "clearOAuthSession(request)"
    );
    expect(source("../app/routes/auth.google.callback.tsx")).toContain(
      "clearOAuthSession(request)"
    );
    expect(logout).toContain("clearOAuthSession(request)");
  });

  it("keeps legacy resources on bridged legacy IDs and credentials on canonical authorization", () => {
    const session = source("../app/services/session.server.ts");
    const credentials = source("../app/services/platosCredentialStore.server.ts");
    expect(session).toContain(".legacyEffectiveUserId");
    expect(credentials).toContain("authorization: EnvironmentOperatorAuthorization");
    expect(credentials).not.toContain('sessionId: "platos-webapp-session"');
  });

  it("keeps legacy impersonation isolated from clean auth and uses the clean session for STOP audit", () => {
    const identity = source("../app/services/platosDashboardAuth.server.ts");
    const admin = source("../app/models/admin.server.ts");
    expect(identity).toContain("legacyActorUserId");
    expect(identity).toContain("legacyTargetUserId");
    expect(admin).toContain("getDashboardIdentity(request)");
    expect(admin).toContain("where: { id: identity.legacyActorUserId }");
    expect(admin).toContain("adminId: actor.id");
    expect(admin).not.toContain("authenticator.isAuthenticated(request)");
  });

  it("maps canonical provider authorization failures to a generic forbidden response", () => {
    const route = source(
      "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.agent-providers._index/route.tsx"
    );
    expect(route).toContain('error instanceof PlatosAuthError && error.code === "forbidden"');
    expect(route).toContain("Project admin or organization admin access is required.");
  });
});
