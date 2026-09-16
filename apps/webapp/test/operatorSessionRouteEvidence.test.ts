import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { beforeEach, describe, expect, it, vi } from "vitest";

// WIN-257 T8 — THE SESSION ROUTES AFTER THE CUTOVER.
//
// The `operatorAuth` double is gone with the service it doubled. `issueMagicLink`
// is `POST /api/v1/bff/magic-link`, `consumeMagicLink` is
// `POST /api/v1/bff/magic-link/complete`, and `revokeOperatorSession` is
// `DELETE /api/v1/bff/session` — every one of them a named operation in
// `app/services/coreApi.server.ts`. So the double moved one level down to
// `fetch`, where the assertions are about what actually went on the wire.
//
// TWO PROPERTIES THIS SUITE NOW CARRIES THAT IT COULD NOT BEFORE:
//
//   NO TOKEN COMES BACK FROM THE START. D20 says a login-capable token is never
//   returned to a BFF, and the served response has no field one could be in. The
//   case below asserts the login response carries nothing token-shaped AND that
//   the webapp sent no mail of its own.
//   THE SESSION COOKIE IS RE-SERIALIZED, NOT RELAYED. core-api decides `Secure`
//   and the `__Host-` prefix from the connection THIS PROCESS opened to it, which
//   is plain HTTP; relaying its header would downgrade a production cookie. The
//   magic-link case asserts the token is read out of core's `Set-Cookie` and
//   written under this process's own shape.

const { clearOperatorSession, commitOperatorSession, optionalOperator, readOperatorToken, requireOperator } =
  vi.hoisted(() => ({
    clearOperatorSession: vi.fn(),
    commitOperatorSession: vi.fn(),
    optionalOperator: vi.fn(),
    readOperatorToken: vi.fn(),
    requireOperator: vi.fn(),
  }));

vi.mock("~/env.server", () => ({
  env: {
    NODE_ENV: "test",
    PLATOS_CORE_API_URL: "http://core.invalid",
    PLATOS_AGENT_API_URL: "http://agent.invalid",
    PLATOS_INTERNAL_AUTH_TOKEN: "SENTINEL_SERVER_ONLY_OPERATOR_CREDENTIAL",
  },
}));
vi.mock("~/services/auth.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/services/auth.server")>()),
  clearOperatorSession,
  commitOperatorSession,
  optionalOperator,
  readOperatorToken,
  requireOperator,
}));

import { action as loginAction, loader as loginLoader } from "../app/routes/login._index/route";
import { action as logoutAction, loader as logoutLoader } from "../app/routes/logout";
import { loader as magicLoader } from "../app/routes/magic";
import { loader as appLoader } from "../app/routes/_app/route";
import { loader as accountLoader } from "../app/routes/account._index/route";

const issuedToken = "SENTINEL_ISSUED_MAGIC_TOKEN";
const sessionToken = "SENTINEL_OPERATOR_SESSION_TOKEN";
const expiresAt = new Date("2030-01-01T00:00:00.000Z");
/** A value core-api could put in a fault body. It must never reach a page. */
const upstreamSecret = "SENTINEL_CORE_API_FAULT_DETAIL";

type Call = { method: string; url: URL; body: unknown; cookie: string | null };
let calls: Call[] = [];
let routes: Map<string, [number, unknown, Record<string, string>]>;

function serve(method: string, pathname: string, status: number, payload: unknown, headers: Record<string, string> = {}) {
  routes.set(`${method} ${pathname}`, [status, payload, headers]);
}
function dispatched(method: string, pathname: string): Call | undefined {
  return calls.find((call) => call.method === method && call.url.pathname === pathname);
}
/** The Remix dialect core-api writes the session value in (D19). */
function legacyCookieValue(token: string): string {
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64");
}

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
  calls = [];
  routes = new Map();
  optionalOperator.mockResolvedValue(null);
  commitOperatorSession.mockResolvedValue("platos_session=redacted; Path=/; HttpOnly");
  clearOperatorSession.mockResolvedValue("platos_session=; Max-Age=0; Path=/; HttpOnly");
  readOperatorToken.mockResolvedValue(sessionToken);
  requireOperator.mockResolvedValue({
    session: { effectiveUserId: "operator-1", actorUserId: "operator-1", email: "operator@example.test" },
    userId: "operator-1",
    actorUserId: "operator-1",
    email: "operator@example.test",
  });
  serve("POST", "/api/v1/bff/magic-link", 202, {
    data: { email: "operator@example.test", expiresAt: expiresAt.toISOString() },
    meta: { contractVersion: "M0.1" },
  });
  serve(
    "POST",
    "/api/v1/bff/magic-link/complete",
    200,
    { data: { userId: "operator-1", sessionId: "session-1", expiresAt: expiresAt.toISOString() }, meta: { contractVersion: "M0.1" } },
    { "Set-Cookie": `platos_operator_session=${encodeURIComponent(legacyCookieValue(sessionToken))}; Path=/; HttpOnly` },
  );
  serve("DELETE", "/api/v1/bff/session", 204, null);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      method,
      url,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      cookie: headers["Cookie"] ?? null,
    });
    const served = routes.get(`${method} ${url.pathname}`);
    if (served === undefined) return new Response("{}", { status: 404, headers: { "Content-Type": "application/json" } });
    return new Response(served[1] === null ? "" : JSON.stringify(served[1]), {
      status: served[0],
      headers: { "Content-Type": "application/json", ...served[2] },
    });
  }));
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
    expect(calls, "a malformed address must not start a sign-in").toEqual([]);
  });

  it("starts the sign-in at core-api and never sees a magic token at all (D20)", async () => {
    const response = await loginAction(actionArgs(
      "https://dashboard.example/login",
      new URLSearchParams({ email: "operator@example.test" }),
    ));
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    const call = dispatched("POST", "/api/v1/bff/magic-link");
    expect(call?.body).toEqual({ email: "operator@example.test" });
    expect(serialized).toContain("Check your inbox");
    expect(serialized).not.toContain(issuedToken);
    // THE WEBAPP SENDS NO MAIL. The only outbound request is the one to
    // core-api; the Resend call that used to live in this action is gone, and
    // with it the API key it read out of this process's environment.
    expect(calls.map((entry) => entry.url.origin)).toEqual(["http://core.invalid"]);
  });

  it("carries the rate limiter's own refusal rather than reporting an outage", async () => {
    // D3 made the composed limiter FAIL CLOSED, so 429 and 503 mean different
    // things to an operator and each keeps its status.
    serve("POST", "/api/v1/bff/magic-link", 429, {
      error: { code: "RATE_LIMITED", title: "rate_limited", body: upstreamSecret, errorId: "e", traceRef: "t", version: "1" },
    });
    const response = await loginAction(actionArgs(
      "https://dashboard.example/login",
      new URLSearchParams({ email: "operator@example.test" }),
    ));
    expect(response.status).toBe(429);
    expect(JSON.stringify(await response.json())).not.toContain(upstreamSecret);
  });

  it("returns a stable login failure without reflecting auth details", async () => {
    serve("POST", "/api/v1/bff/magic-link", 503, {
      error: { code: "MAGIC_LINK_DELIVERY_UNAVAILABLE", title: "unavailable", body: "SENTINEL_AUTH_PROVIDER_DETAILS", errorId: "e", traceRef: "t", version: "1" },
    });
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
    // THE SESSION ROW IS ENDED ON THE SERVER, not only in the browser: the
    // credential is a copy, and deleting the copy in the one browser that asked
    // leaves every other copy live for the rest of the session's lifetime.
    expect(dispatched("DELETE", "/api/v1/bff/session")).toBeDefined();
  });

  it("still clears the logout cookie when session revocation is unavailable", async () => {
    serve("DELETE", "/api/v1/bff/session", 503, {
      error: { code: "IDENTITY_STORE_UNAVAILABLE", title: "unavailable", body: "SENTINEL_REVOCATION_DETAILS", errorId: "e", traceRef: "t", version: "1" },
    });
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

    serve("POST", "/api/v1/bff/magic-link/complete", 401, {
      error: { code: "UNAUTHENTICATED", title: "unauthenticated", body: "SENTINEL_MAGIC_VALIDATION_DETAILS", errorId: "e", traceRef: "t", version: "1" },
    });
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

    expect(dispatched("POST", "/api/v1/bff/magic-link/complete")?.body).toEqual({ token: issuedToken });
    // D19 IN BOTH DIRECTIONS. The token is read back out of core-api's
    // `Set-Cookie` by the webapp's OWN cookie parser — which works because
    // core-api writes the Remix dialect — and then re-serialized under the shape
    // THIS process derives from its environment. The header is not relayed: core
    // decides `Secure` from the plain-HTTP hop this process opened to it.
    expect(commitOperatorSession).toHaveBeenCalledWith(sessionToken, expiresAt);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
    expect(response.headers.get("Set-Cookie")).not.toContain(sessionToken);
    expect(await response.text()).toBe("");
  });
});
