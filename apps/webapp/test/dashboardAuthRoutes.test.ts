import { PlatosAuthError } from "@platos/tenancy-database";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const sessionValues = new Map<string, unknown>();
  const session = {
    get: vi.fn((key: string) => sessionValues.get(key)),
    set: vi.fn((key: string, value: unknown) => sessionValues.set(key, value)),
    unset: vi.fn((key: string) => sessionValues.delete(key)),
  };

  return {
    sessionValues,
    session,
    getRedirectTo: vi.fn(),
    getSession: vi.fn(),
    getUserSession: vi.fn(),
    commitSession: vi.fn(),
    destroySession: vi.fn(),
    redirectWithErrorMessage: vi.fn(),
    redirectBackWithErrorMessage: vi.fn(),
    redirectWithSuccessMessage: vi.fn(),
    typedJsonWithSuccessMessage: vi.fn(),
    getMessageSession: vi.fn(),
    setLastAuthMethodHeader: vi.fn(),
    trackAndClearReferralSource: vi.fn(),
    consumeMagicLink: vi.fn(),
    authorizeOperatorSession: vi.fn(),
    verifyMfaForSession: vi.fn(),
    beginTotpEnrollment: vi.fn(),
    confirmTotpEnrollment: vi.fn(),
    issueOperatorSession: vi.fn(),
    disableTotpForSession: vi.fn(),
    bridgeVerifiedEmailToLegacyUser: vi.fn(),
    canonicalEmailForUser: vi.fn(),
    commitOperatorSession: vi.fn(),
    clearOperatorSession: vi.fn(),
    getOperatorSessionToken: vi.fn(),
    getDashboardIdentity: vi.fn(),
    requireCanonicalAuthorization: vi.fn(),
    getUserId: vi.fn(),
    authenticate: vi.fn(),
    clearOAuthSession: vi.fn(),
    destroyImpersonationSession: vi.fn(),
    githubRedirectParse: vi.fn(),
    googleRedirectParse: vi.fn(),
  };
});

function redirectResponse(path: string, cookie?: string) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: path,
      ...(cookie ? { "Set-Cookie": cookie } : {}),
    },
  });
}

vi.mock("~/services/redirectTo.server", () => ({
  getRedirectTo: mocks.getRedirectTo,
}));
vi.mock("~/services/sessionStorage.server", () => ({
  getSession: mocks.getSession,
  getUserSession: mocks.getUserSession,
  commitSession: mocks.commitSession,
  destroySession: mocks.destroySession,
}));
vi.mock("~/models/message.server", () => ({
  getSession: mocks.getMessageSession,
  redirectWithErrorMessage: mocks.redirectWithErrorMessage,
  redirectBackWithErrorMessage: mocks.redirectBackWithErrorMessage,
  redirectWithSuccessMessage: mocks.redirectWithSuccessMessage,
  typedJsonWithSuccessMessage: mocks.typedJsonWithSuccessMessage,
}));
vi.mock("~/services/lastAuthMethod.server", () => ({
  setLastAuthMethodHeader: mocks.setLastAuthMethodHeader,
}));
vi.mock("~/services/referralSource.server", () => ({
  trackAndClearReferralSource: mocks.trackAndClearReferralSource,
}));
vi.mock("~/services/platosDashboardAuth.server", () => ({
  authEmailRateLimitIdentifier: vi.fn((email: string) => `email:${email.trim().toLowerCase()}`),
  authSessionRateLimitIdentifier: vi.fn(() => "operator-session:session-digest"),
  bridgeVerifiedEmailToLegacyUser: mocks.bridgeVerifiedEmailToLegacyUser,
  canonicalEmailForUser: mocks.canonicalEmailForUser,
  commitOperatorSession: mocks.commitOperatorSession,
  clearOperatorSession: mocks.clearOperatorSession,
  getOperatorSessionToken: mocks.getOperatorSessionToken,
  getDashboardIdentity: mocks.getDashboardIdentity,
  requireCanonicalAuthorization: mocks.requireCanonicalAuthorization,
  isMfaRequired: vi.fn(
    (error: unknown) => error instanceof PlatosAuthError && error.code === "mfa_required"
  ),
  platosDashboardAuth: {
    consumeMagicLink: mocks.consumeMagicLink,
    authorizeOperatorSession: mocks.authorizeOperatorSession,
    verifyMfaForSession: mocks.verifyMfaForSession,
    beginTotpEnrollment: mocks.beginTotpEnrollment,
    confirmTotpEnrollment: mocks.confirmTotpEnrollment,
    issueOperatorSession: mocks.issueOperatorSession,
    disableTotpForSession: mocks.disableTotpForSession,
    revokeOperatorSession: vi.fn(),
  },
}));
vi.mock("~/services/session.server", () => ({
  getUserId: mocks.getUserId,
}));
vi.mock("~/services/auth.server", () => ({
  authenticator: { authenticate: mocks.authenticate },
  clearOAuthSession: mocks.clearOAuthSession,
}));
vi.mock("~/services/impersonation.server", () => ({
  destroyImpersonationSession: mocks.destroyImpersonationSession,
}));
vi.mock("~/routes/auth.github", () => ({
  redirectCookie: { parse: mocks.githubRedirectParse },
}));
vi.mock("~/routes/auth.google", () => ({
  redirectCookie: { parse: mocks.googleRedirectParse },
}));
vi.mock("~/utils", () => ({
  sanitizeRedirectPath: vi.fn((value: unknown) =>
    typeof value === "string" && value.startsWith("/") ? value : "/"
  ),
}));

import { loader as magicLoader } from "~/routes/magic";
import {
  action as mfaLoginAction,
  loader as mfaLoginLoader,
} from "~/routes/login.mfa/route";
import { action as logoutAction } from "~/routes/logout";
import { loader as githubCallbackLoader } from "~/routes/auth.github.callback";
import { loader as googleCallbackLoader } from "~/routes/auth.google.callback";
import { action as mfaSetupAction } from "~/routes/resources.account.mfa.setup/route";
import {
  mfaReducer,
  type MfaState,
} from "~/routes/resources.account.mfa.setup/useMfaSetup";
import { platosDashboardAuth } from "~/services/platosDashboardAuth.server";

const expiresAt = new Date("2026-08-20T00:00:00.000Z");

function formRequest(path: string, values: Record<string, string>, cookie = "session=cookie") {
  return new Request(`https://dashboard.example${path}`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Forwarded-For": "arbitrary-caller-value",
    },
    body: new URLSearchParams(values),
  });
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [response.headers.get("Set-Cookie") ?? ""];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessionValues.clear();
  mocks.getSession.mockResolvedValue(mocks.session);
  mocks.getUserSession.mockResolvedValue(mocks.session);
  mocks.commitSession.mockResolvedValue("__session=committed; Path=/");
  mocks.destroySession.mockResolvedValue("__session=; Max-Age=0; Path=/");
  mocks.getMessageSession.mockResolvedValue({ get: vi.fn(() => undefined) });
  mocks.getRedirectTo.mockResolvedValue("/projects");
  mocks.redirectWithErrorMessage.mockImplementation(async (path: string) =>
    redirectResponse(path, "__message=error; Path=/")
  );
  mocks.redirectBackWithErrorMessage.mockImplementation(async (request: Request) =>
    redirectResponse(new URL(request.url).pathname, "__message=error; Path=/")
  );
  mocks.redirectWithSuccessMessage.mockImplementation(async (path: string) =>
    redirectResponse(path, "__message=success; Path=/")
  );
  mocks.typedJsonWithSuccessMessage.mockImplementation(async (data: unknown) =>
    Response.json(data, { headers: { "Set-Cookie": "__message=success; Path=/" } })
  );
  mocks.setLastAuthMethodHeader.mockResolvedValue("last-auth=email; Path=/");
  mocks.commitOperatorSession.mockResolvedValue("platos_operator_session=operator; Path=/");
  mocks.clearOperatorSession.mockResolvedValue(
    "platos_operator_session=; Max-Age=0; Path=/"
  );
  mocks.clearOAuthSession.mockResolvedValue("platos_oauth=; Max-Age=0; Path=/");
  mocks.destroyImpersonationSession.mockResolvedValue(
    "__impersonate=; Max-Age=0; Path=/"
  );
  mocks.getOperatorSessionToken.mockResolvedValue("operator-token");
  mocks.authorizeOperatorSession.mockResolvedValue({});
  mocks.bridgeVerifiedEmailToLegacyUser.mockResolvedValue({
    canonicalEmail: "operator@example.com",
    legacyUserId: "legacy-user",
  });
  mocks.canonicalEmailForUser.mockResolvedValue("operator@example.com");
  mocks.getDashboardIdentity.mockResolvedValue({ legacyUserId: "legacy-user" });
  mocks.requireCanonicalAuthorization.mockResolvedValue({
    token: "operator-token",
    canonicalUserId: "canonical-user",
  });
  mocks.getUserId.mockResolvedValue(undefined);
  mocks.githubRedirectParse.mockResolvedValue("/projects");
  mocks.googleRedirectParse.mockResolvedValue("/projects");
});

describe("magic login route", () => {
  it("completes a valid magic login and rejects replay of the consumed token", async () => {
    mocks.consumeMagicLink
      .mockResolvedValueOnce({
        userId: "canonical-user",
        token: "operator-token",
        expiresAt,
      })
      .mockRejectedValueOnce(new PlatosAuthError("magic_invalid", 401, "Magic link invalid"));

    const request = new Request("https://dashboard.example/magic?token=one-time-token", {
      headers: { Cookie: "magic=cookie; __impersonate=stale-account-target" },
    });
    const success = await magicLoader({ request, params: {}, context: {} } as never);
    expect(success.status).toBe(302);
    expect(success.headers.get("Location")).toBe("/projects");
    expect(mocks.canonicalEmailForUser).toHaveBeenCalledWith("canonical-user");
    expect(mocks.bridgeVerifiedEmailToLegacyUser).toHaveBeenCalledWith(
      "operator@example.com"
    );
    expect(mocks.trackAndClearReferralSource).toHaveBeenCalledWith(
      request,
      "legacy-user",
      expect.any(Headers)
    );
    expect(setCookies(success).join(" ")).toContain("platos_operator_session=operator");
    expect(setCookies(success).join(" ")).toContain("__impersonate=; Max-Age=0");
    expect(mocks.destroyImpersonationSession).toHaveBeenCalledWith(request);

    const replay = await magicLoader({ request, params: {}, context: {} } as never);
    expect(replay.status).toBe(302);
    expect(replay.headers.get("Location")).toBe("/login/magic");
    expect(mocks.redirectWithErrorMessage).toHaveBeenCalledWith(
      "/login/magic",
      request,
      "This magic link is invalid or expired."
    );
    expect(mocks.trackAndClearReferralSource).toHaveBeenCalledTimes(1);
  });

  it("stores the pending destination and redirects an MFA-enabled session", async () => {
    mocks.consumeMagicLink.mockResolvedValue({
      userId: "canonical-user",
      token: "operator-token",
      expiresAt,
    });
    mocks.authorizeOperatorSession.mockRejectedValue(
      new PlatosAuthError("mfa_required", 401, "MFA required")
    );
    const request = new Request("https://dashboard.example/magic?token=valid", {
      headers: { Cookie: "magic=cookie" },
    });

    const response = await magicLoader({ request, params: {}, context: {} } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login/mfa");
    expect(mocks.session.set).toHaveBeenCalledWith("pending-mfa-redirect-to", "/projects");
    expect(setCookies(response).join(" ")).toContain("platos_operator_session=operator");
    expect(mocks.trackAndClearReferralSource).not.toHaveBeenCalled();
  });
});

describe("MFA login route", () => {
  it.each([
    {
      name: "TOTP",
      form: { action: "verify-mfa", mfaCode: "123456" },
      expected: { totpCode: "123456" },
    },
    {
      name: "recovery code",
      form: { action: "verify-recovery", recoveryCode: "recovery-code" },
      expected: { recoveryCode: "recovery-code" },
    },
  ])("completes login with a valid $name", async ({ form, expected }) => {
    mocks.sessionValues.set("pending-mfa-redirect-to", "/projects/project-one");
    const request = formRequest("/login/mfa", form);

    const response = await mfaLoginAction({ request, params: {}, context: {} } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/projects/project-one");
    expect(mocks.verifyMfaForSession).toHaveBeenCalledWith({
      sessionToken: "operator-token",
      rateLimitIdentifier: "operator-session:session-digest",
      ...expected,
    });
    expect(mocks.session.unset).toHaveBeenCalledWith("pending-mfa-redirect-to");
    expect(mocks.trackAndClearReferralSource).toHaveBeenCalledWith(
      request,
      "legacy-user",
      expect.any(Headers)
    );
  });

  it("sends a bad operator session back through the login boundary", async () => {
    mocks.verifyMfaForSession.mockRejectedValue(
      new PlatosAuthError("revoked", 401, "Session revoked")
    );
    const request = formRequest("/login/mfa", {
      action: "verify-mfa",
      mfaCode: "123456",
    });

    const response = await mfaLoginAction({ request, params: {}, context: {} } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
    expect(mocks.redirectWithErrorMessage).toHaveBeenCalledWith(
      "/login",
      request,
      "Please log in again."
    );
    expect(mocks.getDashboardIdentity).not.toHaveBeenCalled();
  });

  it("redirects an invalid session from the MFA loader", async () => {
    mocks.authorizeOperatorSession.mockRejectedValue(
      new PlatosAuthError("revoked", 401, "Session revoked")
    );
    const request = new Request("https://dashboard.example/login/mfa");

    const response = await mfaLoginLoader({ request, params: {}, context: {} } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
  });
});

describe("logout route", () => {
  it("revokes the operator session and destroys operator, OAuth, impersonation, and legacy cookies", async () => {
    const revokeOperatorSession = vi.mocked(platosDashboardAuth.revokeOperatorSession);
    revokeOperatorSession.mockResolvedValue(true as never);
    const request = new Request("https://dashboard.example/logout", {
      method: "POST",
      headers: { Cookie: "all=present" },
    });

    const response = await logoutAction({ request, params: {}, context: {} } as never);

    expect(revokeOperatorSession).toHaveBeenCalledWith("operator-token");
    expect(mocks.clearOAuthSession).toHaveBeenCalledWith(request);
    expect(mocks.destroyImpersonationSession).toHaveBeenCalledWith(request);
    expect(mocks.destroySession).toHaveBeenCalledWith(mocks.session);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
    const cookies = setCookies(response).join(" ");
    expect(cookies).toContain("platos_operator_session=; Max-Age=0");
    expect(cookies).toContain("platos_oauth=; Max-Age=0");
    expect(cookies).toContain("__impersonate=; Max-Age=0");
    expect(cookies).toContain("__session=; Max-Age=0");
  });
});

describe.each([
  ["github", githubCallbackLoader],
  ["google", googleCallbackLoader],
] as const)("%s OAuth callback route", (provider, callbackLoader) => {
  it("commits the mocked provider completion and clears transient OAuth state", async () => {
    mocks.authenticate.mockResolvedValue({
      canonicalUserId: "canonical-user",
      email: "operator@example.com",
      sessionToken: "oauth-operator-token",
      sessionExpiresAt: expiresAt.toISOString(),
    });
    const request = new Request(`https://dashboard.example/auth/${provider}/callback`, {
      headers: { Cookie: "oauth=state; __impersonate=stale-account-target" },
    });

    const response = await callbackLoader({ request, params: {}, context: {} } as never);

    expect(mocks.authenticate).toHaveBeenCalledWith(provider, request, {
      failureRedirect: "/login",
    });
    expect(mocks.bridgeVerifiedEmailToLegacyUser).toHaveBeenCalledWith(
      "operator@example.com"
    );
    expect(mocks.clearOAuthSession).toHaveBeenCalledWith(request);
    expect(mocks.destroyImpersonationSession).toHaveBeenCalledWith(request);
    expect(mocks.commitOperatorSession).toHaveBeenCalledWith(
      "oauth-operator-token",
      expiresAt
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/projects");
    expect(setCookies(response).join(" ")).toContain("platos_oauth=; Max-Age=0");
    expect(setCookies(response).join(" ")).toContain("__impersonate=; Max-Age=0");
    expect(mocks.trackAndClearReferralSource).toHaveBeenCalledWith(
      request,
      "legacy-user",
      expect.any(Headers)
    );
  });

  it("fails closed on bridge failure and still clears transient OAuth state", async () => {
    mocks.authenticate.mockResolvedValue({
      canonicalUserId: "canonical-user",
      email: "ambiguous@example.com",
      sessionToken: "oauth-operator-token",
      sessionExpiresAt: expiresAt.toISOString(),
    });
    mocks.bridgeVerifiedEmailToLegacyUser.mockResolvedValue(null);
    const request = new Request(`https://dashboard.example/auth/${provider}/callback`, {
      headers: { Cookie: "oauth=state" },
    });

    const response = await callbackLoader({ request, params: {}, context: {} } as never);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
    expect(mocks.clearOAuthSession).toHaveBeenCalledWith(request);
    expect(setCookies(response).join(" ")).toContain("platos_oauth=; Max-Age=0");
    expect(mocks.authorizeOperatorSession).not.toHaveBeenCalled();
    expect(mocks.commitOperatorSession).not.toHaveBeenCalled();
    expect(mocks.trackAndClearReferralSource).not.toHaveBeenCalled();
  });
});

describe("MFA setup route", () => {
  it("confirms TOTP enrollment and replaces the operator session", async () => {
    mocks.confirmTotpEnrollment.mockResolvedValue({
      recoveryCodes: ["recovery-one", "recovery-two"],
    });
    mocks.issueOperatorSession.mockResolvedValue({
      token: "replacement-token",
      expiresAt,
    });
    const request = formRequest("/resources/account/mfa/setup", {
      action: "validate-totp",
      totpCode: "123456",
    });

    const response = await mfaSetupAction({ request, params: {}, context: {} } as never);

    expect(mocks.confirmTotpEnrollment).toHaveBeenCalledWith(
      "canonical-user",
      "123456",
      "operator-session:session-digest"
    );
    expect(mocks.issueOperatorSession).toHaveBeenCalledWith({
      userId: "canonical-user",
      mfaVerifiedAt: expect.any(Date),
    });
    expect(await response.json()).toMatchObject({
      action: "validate-totp",
      success: true,
      recoveryCodes: ["recovery-one", "recovery-two"],
    });
    expect(setCookies(response).join(" ")).toContain("platos_operator_session=operator");
  });

  it("disables MFA through the current operator session", async () => {
    const request = formRequest("/resources/account/mfa/setup", {
      action: "disable-mfa",
      recoveryCode: "recovery-code",
    });

    const response = await mfaSetupAction({ request, params: {}, context: {} } as never);

    expect(mocks.disableTotpForSession).toHaveBeenCalledWith({
      sessionToken: "operator-token",
      rateLimitIdentifier: "operator-session:session-digest",
      totpCode: undefined,
      recoveryCode: "recovery-code",
    });
    expect(await response.json()).toEqual({ action: "disable-mfa", success: true });
    expect(setCookies(response).join(" ")).toContain("__message=success");
  });

  it("keeps the enrollment QR state available after an invalid confirmation retry", async () => {
    mocks.confirmTotpEnrollment.mockRejectedValue(
      new PlatosAuthError("invalid_mfa", 401, "Invalid code")
    );
    const request = formRequest("/resources/account/mfa/setup", {
      action: "validate-totp",
      totpCode: "000000",
    });

    const response = await mfaSetupAction({ request, params: {}, context: {} } as never);
    expect(await response.json()).toMatchObject({
      action: "validate-totp",
      success: false,
      error: "Invalid code provided. Please try again.",
    });

    const setupData = {
      secret: "JBSWY3DPEHPK3PXP",
      otpAuthUrl: "otpauth://totp/Platos:operator",
    };
    const initial: MfaState = {
      phase: "enabling",
      isEnabled: false,
      setupData,
      isSubmitting: false,
      disableMethod: "totp",
    };
    const validating = mfaReducer(initial, { type: "VALIDATE_TOTP", code: "000000" });
    const retriable = mfaReducer(validating, {
      type: "VALIDATION_FAILED",
      error: "Invalid code provided. Please try again.",
    });

    expect(retriable).toMatchObject({
      phase: "enabling",
      setupData,
      isSubmitting: false,
      error: "Invalid code provided. Please try again.",
    });
  });
});
