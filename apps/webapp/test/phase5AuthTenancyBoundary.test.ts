import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";

vi.mock("~/env.server", () => ({
  env: {
    NODE_ENV: "test",
    SESSION_SECRET: "test-session-secret",
  },
}));

import {
  OPERATOR_SESSION_COOKIE_NAME,
  commitOperatorSession,
  destroyOperatorSession,
  getOperatorSessionToken,
  invalidatedLegacySessionCookies,
} from "~/services/sessionStorage.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

describe("Phase 5 operator auth and tenancy boundaries", () => {
  test("stores only an opaque database-backed token in the canonical host cookie", async () => {
    const cookie = await commitOperatorSession(
      "plt_os_operator-token",
      new Date("2030-01-01T00:00:00.000Z")
    );

    expect(OPERATOR_SESSION_COOKIE_NAME).toBe("__Host-platos_operator_session");
    expect(cookie).toContain("__Host-platos_operator_session=plt_os_operator-token");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toMatch(/user(Id)?=/i);
    expect(cookie).not.toMatch(/organization(Id)?=/i);

    const request = new Request("https://platos.test/", { headers: { Cookie: cookie } });
    await expect(getOperatorSessionToken(request)).resolves.toBe("plt_os_operator-token");
  });

  test("rejects non-opaque cookies and invalidates every inherited browser-session name", async () => {
    const legacyRequest = new Request("https://platos.test/", {
      headers: {
        Cookie: `${OPERATOR_SESSION_COOKIE_NAME}=${encodeURIComponent(
          JSON.stringify({ userId: "legacy-user", organizationId: "legacy-org" })
        )}`,
      },
    });
    await expect(getOperatorSessionToken(legacyRequest)).resolves.toBeNull();

    const resetCookies = invalidatedLegacySessionCookies().join("\n");
    expect(resetCookies).toContain("__session=");
    expect(resetCookies).toContain("__impersonate=");
    expect(resetCookies).toContain("platos_operator_session=");
    expect(await destroyOperatorSession()).toContain("Max-Age=0");
  });

  test("accepts UUID environment route scope and rejects legacy environment slugs", () => {
    const base = {
      organizationSlug: "acme",
      projectParam: "project",
    };
    expect(
      EnvironmentParamSchema.safeParse({
        ...base,
        envParam: "4d73d9dc-9f10-43d3-a9c1-793b139bf5e9",
      }).success
    ).toBe(true);
    expect(EnvironmentParamSchema.safeParse({ ...base, envParam: "dev" }).success).toBe(false);
  });

  test("resolves environment access by canonical UUID ancestry only", () => {
    const environmentModel = readFileSync(
      new URL("../app/models/runtimeEnvironment.server.ts", import.meta.url),
      "utf8"
    );
    const scopeVerifier = readFileSync(
      new URL("../app/services/platos/scopeVerify.server.ts", import.meta.url),
      "utf8"
    );

    expect(environmentModel).toContain("findEnvironmentById");
    expect(environmentModel).not.toContain("findEnvironmentBySlug");
    expect(scopeVerifier).toContain("organizationMembership.findFirst");
    expect(scopeVerifier).toContain("environment.findFirst");
    expect(scopeVerifier).not.toContain("$replica.runtimeEnvironment");
    expect(scopeVerifier).not.toContain("$replica.orgMember");
    expect(scopeVerifier).not.toMatch(/\benvSlug\b/);
  });

  test("settings routes use clean fields, roles, and archive semantics", () => {
    const files = [
      "../app/routes/_app.orgs.$organizationSlug.settings._index/route.tsx",
      "../app/routes/_app.orgs.$organizationSlug.settings.team/route.tsx",
      "../app/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.settings.general/route.tsx",
    ];
    const source = files
      .map((file) => readFileSync(new URL(file, import.meta.url), "utf8"))
      .join("\n");

    expect(source).toContain("OrganizationRole.OWNER");
    expect(source).toContain("archivedAt");
    expect(source).toContain("organization.name");
    expect(source).not.toMatch(/\bdeletedAt\b/);
    expect(source).not.toMatch(/\bexternalRef\b/);
    expect(source).not.toMatch(/\bv3Subscription\b/);
    expect(source).not.toMatch(/\bPurchaseSeats/);
  });

  test("loads retained Express middleware from the compiled Remix application graph", () => {
    const server = readFileSync(new URL("../server.ts", import.meta.url), "utf8");

    expect(server).toContain("build.entry.module.apiRateLimiter");
    expect(server).toContain("build.entry.module.runWithHttpContext");
    expect(server).not.toMatch(/import \{ apiRateLimiter \} from "~\//);
    expect(server).not.toMatch(/import \{ runWithHttpContext \} from "~\//);
    expect(server).not.toContain("engineRateLimiter");
    expect(server).not.toContain("socketIo");
  });

  test("keeps dashboard navigation on UUID scope without hosted billing state", () => {
    const source = readFileSync(
      new URL("../app/components/navigation/DashboardDialogs.tsx", import.meta.url),
      "utf8"
    );

    expect(source).toContain("environment: { id: string }");
    expect(source).toContain("env/${environment.id}/dashboards/create");
    expect(source).not.toContain("v3Subscription");
    expect(source).not.toContain("v3BillingPath");
    expect(source).not.toContain("useCurrentPlan");
  });
});
