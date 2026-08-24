import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  clearOperatorSession,
  commitOperatorSession,
  consumeMagicLink,
  issueMagicLink,
  optionalOperator,
  readOperatorToken,
  requireOperator,
  revokeOperatorSession,
} = vi.hoisted(() => ({
  clearOperatorSession: vi.fn(),
  commitOperatorSession: vi.fn(),
  consumeMagicLink: vi.fn(),
  issueMagicLink: vi.fn(),
  optionalOperator: vi.fn(),
  readOperatorToken: vi.fn(),
  requireOperator: vi.fn(),
  revokeOperatorSession: vi.fn(),
}));

vi.mock("~/env.server", () => ({
  env: {
    NODE_ENV: "test",
    LOGIN_ORIGIN: "https://dashboard.example",
    RESEND_API_KEY: "",
    FROM_EMAIL: "Platos <noreply@example.test>",
    BACKDOOR_PLATOS_DEV: "0",
    PLATOS_TEST_MODE: "0",
    BACKDOOR_PLATOS_DEV_EMAIL: "",
  },
}));
vi.mock("~/services/auth.server", () => ({
  clearOperatorSession,
  commitOperatorSession,
  optionalOperator,
  readOperatorToken,
  requireOperator,
  operatorAuth: {
    consumeMagicLink,
    issueMagicLink,
    revokeOperatorSession,
  },
}));

import { action as loginAction, loader as loginLoader } from "../app/routes/login._index/route";
import { action as logoutAction, loader as logoutLoader } from "../app/routes/logout";
import { loader as magicLoader } from "../app/routes/magic";
import { loader as appLoader } from "../app/routes/_app/route";
import { loader as accountLoader } from "../app/routes/account._index/route";

const issuedToken = "SENTINEL_ISSUED_MAGIC_TOKEN";
const sessionToken = "SENTINEL_OPERATOR_SESSION_TOKEN";
const expiresAt = new Date("2030-01-01T00:00:00.000Z");

function loaderArgs(url: string): LoaderFunctionArgs {
  return { request: new Request(url), params: {}, context: {} };
}

function actionArgs(url: string, body?: URLSearchParams): ActionFunctionArgs {
  return {
    request: new Request(url, { method: "POST", body }),
    params: {},
    context: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  optionalOperator.mockResolvedValue(null);
  issueMagicLink.mockResolvedValue({ token: issuedToken });
  consumeMagicLink.mockResolvedValue({ token: sessionToken, expiresAt });
  commitOperatorSession.mockResolvedValue("platos_session=redacted; Path=/; HttpOnly");
  clearOperatorSession.mockResolvedValue("platos_session=; Max-Age=0; Path=/; HttpOnly");
  readOperatorToken.mockResolvedValue(sessionToken);
  requireOperator.mockResolvedValue({
    authorization: { role: "ADMIN" },
    userId: "operator-1",
    actorUserId: "operator-1",
    email: "operator@example.test",
  });
  revokeOperatorSession.mockResolvedValue(true);
  vi.stubGlobal("fetch", vi.fn());
});

describe("operator session route evidence", () => {
  it.each([
    ["route-001 app layout", appLoader, "https://dashboard.example/"],
    ["route-077 account", accountLoader, "https://dashboard.example/account"],
  ] as const)("%s rejects unauthenticated access and never reflects the request cookie", async (_name, loader, url) => {
    const request = new Request(url, { headers: { Cookie: `platos_session=${sessionToken}` } });
    const response = await loader({ request, params: {}, context: {} });
    const serialized = response instanceof Response
      ? JSON.stringify(await response.json())
      : JSON.stringify(response);

    expect(requireOperator).toHaveBeenCalledWith(request);
    expect(serialized).toContain("operator@example.test");
    expect(serialized).not.toContain(sessionToken);

    requireOperator.mockRejectedValueOnce(new Response(null, {
      status: 302,
      headers: { Location: `/login?redirectTo=${encodeURIComponent(new URL(url).pathname)}` },
    }));
    await expect(loader({ request: new Request(url), params: {}, context: {} })).rejects.toMatchObject({ status: 302 });
  });

  it("keeps the public login loader open and redirects an existing operator", async () => {
    await expect(loginLoader(loaderArgs("https://dashboard.example/login"))).resolves.toBeNull();

    optionalOperator.mockResolvedValueOnce({ userId: "operator-1" });
    await expect(loginLoader(loaderArgs("https://dashboard.example/login"))).rejects.toMatchObject({
      status: 302,
      headers: expect.objectContaining({}),
    });
  });

  it("rejects malformed login forms before issuing a token", async () => {
    const response = await loginAction(actionArgs(
      "https://dashboard.example/login",
      new URLSearchParams({ email: "not-an-email" }),
    ));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, message: "Enter a valid email address" });
    expect(issueMagicLink).not.toHaveBeenCalled();
  });

  it("never serializes the issued magic token in the login response", async () => {
    const response = await loginAction(actionArgs(
      "https://dashboard.example/login",
      new URLSearchParams({ email: "operator@example.test" }),
    ));
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(issueMagicLink).toHaveBeenCalledWith({
      email: "operator@example.test",
      rateLimitIdentifier: "dashboard:operator@example.test",
    });
    expect(serialized).toContain("Email delivery is not configured");
    expect(serialized).not.toContain(issuedToken);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a stable login failure without reflecting auth details", async () => {
    issueMagicLink.mockRejectedValueOnce(new Error("SENTINEL_AUTH_PROVIDER_DETAILS"));
    const response = await loginAction(actionArgs(
      "https://dashboard.example/login",
      new URLSearchParams({ email: "operator@example.test" }),
    ));
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(serialized).toContain("Sign in is temporarily unavailable");
    expect(serialized).not.toContain("SENTINEL_AUTH_PROVIDER_DETAILS");
  });

  it.each([
    ["action", logoutAction],
    ["loader", logoutLoader],
  ] as const)("%s logout revokes the current token and clears the cookie", async (_kind, handler) => {
    const response = await handler(actionArgs("https://dashboard.example/logout"));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(response.headers.get("Set-Cookie")).not.toContain(sessionToken);
    expect(revokeOperatorSession).toHaveBeenCalledWith(sessionToken);
  });

  it("still clears the logout cookie when session revocation is unavailable", async () => {
    revokeOperatorSession.mockRejectedValueOnce(new Error("SENTINEL_REVOCATION_DETAILS"));
    const response = await logoutAction(actionArgs("https://dashboard.example/logout"));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
    expect(response.headers.get("Set-Cookie")).not.toContain("SENTINEL_REVOCATION_DETAILS");
  });

  it("rejects missing and invalid magic links with stable redirects", async () => {
    await expect(magicLoader(loaderArgs("https://dashboard.example/magic"))).rejects.toMatchObject({
      status: 302,
      headers: expect.objectContaining({}),
    });

    consumeMagicLink.mockRejectedValueOnce(new Error("SENTINEL_MAGIC_VALIDATION_DETAILS"));
    try {
      await magicLoader(loaderArgs(`https://dashboard.example/magic?token=${issuedToken}`));
      throw new Error("Expected invalid magic link redirect");
    } catch (error) {
      expect(error).toBeInstanceOf(Response);
      const response = error as Response;
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/login?error=invalid-link");
      expect(response.headers.get("Location")).not.toContain(issuedToken);
      expect(response.headers.get("Location")).not.toContain("SENTINEL_MAGIC_VALIDATION_DETAILS");
    }
  });

  it("consumes a magic link into an HttpOnly session cookie without a response body", async () => {
    const response = await magicLoader(loaderArgs(`https://dashboard.example/magic?token=${issuedToken}`));

    expect(consumeMagicLink).toHaveBeenCalledWith(issuedToken);
    expect(commitOperatorSession).toHaveBeenCalledWith(sessionToken, expiresAt);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(response.headers.get("Set-Cookie")).not.toContain(sessionToken);
    expect(await response.text()).toBe("");
  });
});
