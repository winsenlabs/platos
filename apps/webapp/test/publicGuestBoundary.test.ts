// THE PUBLIC-GUEST AND EMBED BOUNDARY, OVER REAL SOCKETS, WITH `fetch` UNSTUBBED.
//
// ---------------------------------------------------------------------------
// WHY THIS SUITE EXISTS WHEN `embedProxy.test.ts` ALREADY COVERS THESE ROUTES
//
// Because that suite proves the routes at the CONTRACT EDGE and this surface's
// refusals are not a contract-edge property. `embedProxy.test.ts` calls `action()`
// with a `Request` it constructed itself and `vi.stubGlobal("fetch", vi.fn())`, so
// every one of its assertions is about the arguments one function passed to
// another. That is the right shape for "did the handler decide correctly" and it
// cannot see:
//
//   * whether a `Set-Cookie` this transport wrote is one a browser would actually
//     scope to the agent, keep out of script and keep off plaintext — the
//     attributes only exist on the real header;
//   * whether a cookie SURVIVES a real `Cookie:` round trip, which is the only
//     path a returning visitor takes, and which passes through Remix's own value
//     encoding in both directions;
//   * whether `Origin` equals the origin the server computed from the request it
//     really received, which is the entire CSRF defence on a `SameSite=None`
//     credential and which depends on bytes no synthesized `Request` carries;
//   * whether the upstream was contacted AT ALL — a stubbed `fetch` records a
//     call, a real agent records a REQUEST, and "the refusal happened before the
//     agent was reached" is a claim about the second;
//   * whether a body streams or arrives at once, and whether a visitor closing a
//     tab actually tears the upstream turn down.
//
// So: a real `node:http` listener runs the ACTUAL route modules, a second real
// `node:http` listener stands in for `apps/agent`, and the test drives the first
// with a real client. Nothing between them is doubled. The one thing mocked is
// `~/env.server`, which is where the upstream's address comes from — that is
// configuration, not the boundary.
//
// ---------------------------------------------------------------------------
// WHAT THE STAND-IN AGENT IS AND IS NOT
//
// It is a real HTTP server that speaks the shapes this transport reads: a
// guest-token mint payload, and an event stream. It is NOT `apps/agent`, and
// nothing here claims the real agent behaves as the script says — that is the
// upstream's own suites' job. What is real on this side of the wire is every
// byte this transport writes and every refusal it makes, which is what "the
// refusals are the security boundary" means.
//
// ---------------------------------------------------------------------------
// THE BRIDGE STANDS IN FOR THE ROUTER AND FOR NOTHING ELSE
//
// Remix owns matching a URL to a route module and filling `params`. `serve()`
// below does that one job — two paths, one param — and then hands the real
// `Request` to the real handler and renders the real `Response`. It holds no
// policy: no cookie parsing, no origin check, no status decision. Every refusal
// this suite observes was made inside `app/`.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/** Filled once the stand-in agent is listening. Read through a getter, see below. */
let upstreamBase = "";

// HOISTED, AND READ LAZILY ON PURPOSE. `vi.mock`'s factory is moved above the
// imports, but the getter body only runs when a route asks for the address —
// which is inside a request, long after `beforeAll` has assigned it.
vi.mock("~/env.server", () => ({
  env: {
    get PLATOS_AGENT_API_URL() {
      return upstreamBase;
    },
  },
}));

import {
  action as streamAction,
  loader as streamLoader,
} from "../app/routes/api.v1.public.agents.$agentId.chat.stream";
import { action as guestTokenAction } from "../app/routes/api.v1.public.guest-token";
import { serializePublicGuestSession } from "../app/services/publicGuestSession.server";

const AGENT = "widget-agent";
const OTHER_AGENT = "widget-other";
const ENVIRONMENT = "11111111-1111-4111-8111-111111111111";
const OTHER_ENVIRONMENT = "22222222-2222-4222-8222-222222222222";
/** The platform session token the mint hands back. Must never reach a browser. */
const PLATFORM_TOKEN = "platform-session-token-a1b2c3";

/** One request the stand-in agent really received. */
interface UpstreamRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
  /** True once the far side hung up before this handler finished writing. */
  aborted: boolean;
}

/** What the stand-in agent should do with the next request. */
type UpstreamScript = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

let upstream: Server;
let bff: Server;
let bffBase: string;
let received: UpstreamRequest[] = [];
let script: UpstreamScript = (_request, response) => {
  response.writeHead(500, { "Content-Type": "application/json" });
  response.end('{"error":"no script installed"}');
};

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Turn one `IncomingMessage` into the `Request` Remix would have built.
 *
 * THE URL IS BUILT FROM THE `Host` HEADER THE CLIENT REALLY SENT, which is what
 * makes the same-origin check a real check: `sameOriginMutation` compares the
 * `Origin` header to `new URL(request.url).origin`, so both sides of that
 * comparison have to come off the wire. A hard-coded base would have made the
 * check compare two constants this file controls.
 */
function toWebRequest(request: IncomingMessage, body: string, signal: AbortSignal): Request {
  const host = request.headers.host ?? "127.0.0.1";
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    for (const single of Array.isArray(value) ? value : [value]) headers.append(name, single);
  }
  const method = request.method ?? "GET";
  return new Request(`http://${host}${request.url ?? "/"}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : body,
    signal,
  });
}

/** Render a `Response` onto a real socket, streaming the body rather than buffering it. */
async function writeWebResponse(result: Response, response: ServerResponse): Promise<void> {
  for (const cookie of result.headers.getSetCookie()) response.appendHeader("Set-Cookie", cookie);
  for (const [name, value] of result.headers.entries()) {
    if (name.toLowerCase() === "set-cookie") continue;
    response.setHeader(name, value);
  }
  response.writeHead(result.status);
  if (result.body === null) {
    response.end();
    return;
  }
  const reader = result.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (response.writableEnded) break;
      response.write(Buffer.from(value));
    }
  } catch {
    // The upstream body failing mid-flight is one of the cases: the socket is left
    // truncated, with no terminal frame, which is exactly what a client must be
    // able to tell from a clean end.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!response.writableEnded) response.end();
}

beforeAll(async () => {
  upstream = createServer((request, response) => {
    void (async () => {
      const record: UpstreamRequest = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: { ...request.headers },
        body: request.method === "GET" ? "" : await readBody(request),
        aborted: false,
      };
      received.push(record);
      // THE FAR SIDE HANGING UP IS RECORDED RATHER THAN IGNORED. It is how this
      // suite observes that a visitor closing a tab really does tear the turn
      // down, instead of asserting that a signal object was passed along.
      request.on("aborted", () => {
        record.aborted = true;
      });
      response.on("close", () => {
        if (!response.writableEnded) record.aborted = true;
      });
      await script(request, response);
    })();
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  upstreamBase = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`;

  bff = createServer((request, response) => {
    void (async () => {
      const controller = new AbortController();
      // THE CLIENT GOING AWAY ABORTS THE REQUEST THE HANDLER IS HOLDING, which is
      // what Remix's own server adapter does. Without it the route's forwarded
      // `request.signal` would never fire and the disconnect case would prove
      // nothing.
      const hangUp = (): void => {
        if (!response.writableEnded) controller.abort();
      };
      request.on("aborted", hangUp);
      response.on("close", hangUp);
      const body = request.method === "GET" || request.method === "HEAD" ? "" : await readBody(request);
      const webRequest = toWebRequest(request, body, controller.signal);
      const path = new URL(webRequest.url).pathname;
      const stream = /^\/api\/v1\/public\/agents\/([^/]+)\/chat\/stream$/u.exec(path);
      try {
        let result: Response;
        if (path === "/api/v1/public/guest-token") {
          result = (await guestTokenAction({
            request: webRequest,
            params: {},
            context: {},
          })) as Response;
        } else if (stream !== null) {
          const params = { agentId: decodeURIComponent(stream[1]) };
          const handler = webRequest.method === "GET" ? streamLoader : streamAction;
          result = (await handler({ request: webRequest, params, context: {} })) as Response;
        } else {
          response.writeHead(404).end();
          return;
        }
        await writeWebResponse(result, response);
      } catch (error) {
        // A HANDLER THROWING IS A DEFECT AND IS REPORTED AS ONE. Rendering it as a
        // refusal would let a crash pass for a security boundary.
        if (!response.headersSent) response.writeHead(599, { "X-Handler-Threw": "1" });
        response.end(String(error));
      }
    })();
  });
  bff.listen(0, "127.0.0.1");
  await once(bff, "listening");
  bffBase = `http://127.0.0.1:${String((bff.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  bff?.closeAllConnections?.();
  upstream?.closeAllConnections?.();
  await Promise.all([
    new Promise((resolve) => bff.close(resolve)),
    new Promise((resolve) => upstream.close(resolve)),
  ]);
});

afterEach(() => {
  received = [];
});

/** The cookie header a browser holding a live guest session would send. */
async function guestCookieHeader(
  options: {
    readonly agentId?: string;
    readonly environmentId?: string;
    readonly token?: string;
    readonly expiresInSeconds?: number;
  } = {},
): Promise<string> {
  const serialized = await serializePublicGuestSession(
    options.token ?? PLATFORM_TOKEN,
    options.agentId ?? AGENT,
    options.environmentId ?? ENVIRONMENT,
    Math.floor(Date.now() / 1_000) + (options.expiresInSeconds ?? 1_800),
  );
  return serialized.split(";", 1)[0];
}

function streamUrl(
  options: { readonly agentId?: string; readonly environmentId?: string; readonly messageId?: string } = {},
): string {
  const url = new URL(`${bffBase}/api/v1/public/agents/${options.agentId ?? AGENT}/chat/stream`);
  url.searchParams.set("environmentId", options.environmentId ?? ENVIRONMENT);
  if (options.messageId !== undefined) url.searchParams.set("messageId", options.messageId);
  return url.toString();
}

/** POST a chat message the way the embedded widget does, over the real socket. */
async function postMessage(
  options: {
    readonly url?: string;
    readonly cookie?: string;
    readonly origin?: string;
    readonly contentType?: string;
    readonly message?: string;
    readonly signal?: AbortSignal;
  } = {},
): Promise<Response> {
  const url = options.url ?? streamUrl();
  const headers: Record<string, string> = {
    "Content-Type": options.contentType ?? "application/json",
    Origin: options.origin ?? new URL(url).origin,
  };
  if (options.cookie !== undefined) headers.Cookie = options.cookie;
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ message: options.message ?? "Hello" }),
    signal: options.signal,
  });
}

/** A stand-in agent that answers the mint with a well-formed payload. */
function mintScript(expiresInSeconds = 1_800): UpstreamScript {
  return (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        token: PLATFORM_TOKEN,
        guestId: "guest-deadbeef",
        expiresAt: Math.floor(Date.now() / 1_000) + expiresInSeconds,
        agentId: AGENT,
        environmentId: ENVIRONMENT,
      }),
    );
  };
}

/** A stand-in agent that writes `frames` as SSE, `gapMs` apart, then ends. */
function streamScript(frames: readonly string[], gapMs = 0): UpstreamScript {
  return async (_request, response) => {
    response.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    for (const frame of frames) {
      if (response.writableEnded || response.destroyed) return;
      response.write(`data: ${frame}\n\n`);
      if (gapMs > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
    }
    response.end();
  };
}

describe("the suite is not vacuous: the transport and the agent are two real servers", () => {
  it("reaches the stand-in agent over a real socket and streams a body through", async () => {
    script = streamScript(['{"t":"assistant.delta","text":"hi"}', '{"t":"turn.done"}']);
    const response = await postMessage({ cookie: await guestCookieHeader() });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await expect(response.text()).resolves.toBe(
      'data: {"t":"assistant.delta","text":"hi"}\n\ndata: {"t":"turn.done"}\n\n',
    );
    expect(received).toHaveLength(1);
    // THE MESSAGE IS IN THE BODY, NOT THE REQUEST LINE. This used to read
    // `…/chat/stream?message=Hello`, which is the defect the case further down
    // pins the fix for: a request line is a header and cannot carry the 20,000
    // characters this transport advertises.
    expect(received[0].method).toBe("POST");
    expect(received[0].url).toBe(`/api/v1/agent/agents/${AGENT}/chat/stream`);
    expect(JSON.parse(received[0].body)).toEqual({ message: "Hello" });
    // THE HANDLER DID NOT THROW. A 599 anywhere in this suite is a defect in the
    // route, not a refusal, and the bridge marks it so it cannot be mistaken.
    expect(response.headers.get("x-handler-threw")).toBeNull();
  });
});

describe("the unauthenticated mint refuses before it spends an upstream round trip", () => {
  it("answers 404 for a malformed agent identity and NEVER contacts the agent", async () => {
    script = mintScript();
    const form = new URLSearchParams({ agentId: "not a safe id", environmentId: ENVIRONMENT });
    const response = await fetch(`${bffBase}/api/v1/public/guest-token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    expect(response.status).toBe(404);
    expect(received).toHaveLength(0);
  });

  it("answers 404 for a malformed environment identity and NEVER contacts the agent", async () => {
    script = mintScript();
    const form = new URLSearchParams({ agentId: AGENT, environmentId: "not-a-uuid" });
    const response = await fetch(`${bffBase}/api/v1/public/guest-token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    expect(response.status).toBe(404);
    expect(received).toHaveLength(0);
  });

  it("writes a cookie a browser will keep out of script, off plaintext and out of a third party's jar", async () => {
    script = mintScript();
    const form = new URLSearchParams({ agentId: AGENT, environmentId: ENVIRONMENT });
    const response = await fetch(`${bffBase}/api/v1/public/guest-token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    expect(response.status).toBe(200);
    const cookies = response.headers.getSetCookie();
    expect(cookies).toHaveLength(1);
    const cookie = cookies[0];
    // EVERY ATTRIBUTE IS READ OFF THE REAL HEADER. These are the properties that
    // make the credential safe and not one of them exists on a `Response` object
    // a contract-edge test inspects.
    expect(cookie).toMatch(/^__Secure-platos_public_guest_[0-9a-f]{24}=/u);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=None");
    expect(cookie).toContain("Partitioned");
    expect(cookie).toContain(`Path=/api/v1/public/agents/${AGENT}/chat/stream`);
    expect(cookie).toContain("Expires=");
    // AND NO `Domain=`. A guest cookie that carried one would be sent to every
    // subdomain of the install, which is the opposite of scoping it to one agent.
    expect(cookie).not.toContain("Domain=");
  });

  it("hands the browser the session's SHAPE and never the platform token", async () => {
    script = mintScript();
    const form = new URLSearchParams({ agentId: AGENT, environmentId: ENVIRONMENT });
    const response = await fetch(`${bffBase}/api/v1/public/guest-token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const body = await response.text();
    expect(body).not.toContain(PLATFORM_TOKEN);
    expect(JSON.parse(body)).toEqual({
      expiresAt: expect.any(Number),
      agentId: AGENT,
      environmentId: ENVIRONMENT,
    });
    // The token is in the cookie, which is HttpOnly, which is the whole design.
    expect(response.headers.getSetCookie()[0]).not.toContain(PLATFORM_TOKEN);
  });

  it("forwards the rate-limit key and NOT the visitor's own cookie jar", async () => {
    script = mintScript();
    const form = new URLSearchParams({ agentId: AGENT, environmentId: ENVIRONMENT });
    await fetch(`${bffBase}/api/v1/public/guest-token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Forwarded-For": "203.0.113.7",
        Cookie: "unrelated_dashboard_session=must-not-travel",
      },
      body: form,
    });
    expect(received).toHaveLength(1);
    // The per-IP bucket is the only defence an unauthenticated mint has, so the
    // key has to reach the agent.
    expect(received[0].headers["x-forwarded-for"]).toBe("203.0.113.7");
    // AND NOTHING ELSE OF THE VISITOR'S TRAVELS. A dashboard session forwarded to
    // the mint would turn an anonymous call into an authenticated one.
    expect(received[0].headers.cookie).toBeUndefined();
  });

  it("writes NO cookie when the agent answers with a half-minted session", async () => {
    script = (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      // `token` missing: the payload validator must refuse it rather than
      // serializing `undefined` into a browser.
      response.end(
        JSON.stringify({ guestId: "g", expiresAt: 1, agentId: AGENT, environmentId: ENVIRONMENT }),
      );
    };
    const form = new URLSearchParams({ agentId: AGENT, environmentId: ENVIRONMENT });
    const response = await fetch(`${bffBase}/api/v1/public/guest-token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    expect(response.status).toBe(502);
    expect(response.headers.getSetCookie()).toEqual([]);
  });
});

describe("the stream's refusals are the security boundary, and every one is reached first", () => {
  it("refuses an anonymous stream with 401 and never contacts the agent", async () => {
    script = streamScript(["never"]);
    const response = await postMessage();
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Guest session required" });
    expect(received).toHaveLength(0);
  });

  it("refuses a CROSS-ORIGIN mutation with 403 and never contacts the agent", async () => {
    script = streamScript(["never"]);
    const response = await postMessage({
      cookie: await guestCookieHeader(),
      origin: "https://evil.example",
    });
    expect(response.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("refuses a mutation that is not JSON, which is what a form-post CSRF looks like", async () => {
    script = streamScript(["never"]);
    const response = await postMessage({
      cookie: await guestCookieHeader(),
      contentType: "text/plain;charset=UTF-8",
    });
    expect(response.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("refuses a mutation with NO Origin header at all", async () => {
    script = streamScript(["never"]);
    const cookie = await guestCookieHeader();
    // `fetch` sets `Origin` on a cross-origin POST but not on a same-origin one it
    // did not initiate from a document, so the header is removed explicitly rather
    // than hoped away.
    const response = await fetch(streamUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ message: "Hello" }),
    });
    expect(response.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it("REFUSES AGENT A's COOKIE ON AGENT B's STREAM: the scope hash is the boundary", async () => {
    script = streamScript(["never"]);
    const response = await postMessage({
      url: streamUrl({ agentId: OTHER_AGENT }),
      cookie: await guestCookieHeader({ agentId: AGENT }),
    });
    expect(response.status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it("REFUSES A COOKIE MINTED FOR ANOTHER ENVIRONMENT on the same agent", async () => {
    script = streamScript(["never"]);
    const response = await postMessage({
      url: streamUrl({ environmentId: OTHER_ENVIRONMENT }),
      cookie: await guestCookieHeader({ environmentId: ENVIRONMENT }),
    });
    expect(response.status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it("refuses a malformed agent identity and a malformed environment identity with 404", async () => {
    script = streamScript(["never"]);
    const bad = await postMessage({ url: `${bffBase}/api/v1/public/agents/a%20b/chat/stream?environmentId=${ENVIRONMENT}` });
    expect(bad.status).toBe(404);
    const noEnvironment = await postMessage({
      url: `${bffBase}/api/v1/public/agents/${AGENT}/chat/stream`,
    });
    expect(noEnvironment.status).toBe(404);
    expect(received).toHaveLength(0);
  });

  it("refuses an empty message and one past the payload ceiling, before the agent", async () => {
    script = streamScript(["never"]);
    const cookie = await guestCookieHeader();
    const empty = await postMessage({ cookie, message: "   " });
    expect(empty.status).toBe(400);
    const oversized = await postMessage({ cookie, message: "x".repeat(20_001) });
    expect(oversized.status).toBe(400);
    expect(received).toHaveLength(0);
    // A MESSAGE WELL INSIDE THE CEILING IS ADMITTED, so the refusal is a limit and
    // not a wall: a case that only proved the refusal would pass with the route
    // broken shut. The size is deliberately modest — see the case below for why a
    // message NEAR the ceiling is a different question.
    script = streamScript(['{"t":"turn.done"}']);
    const admitted = await postMessage({ cookie, message: "x".repeat(1_000) });
    expect(admitted.status).toBe(200);
    await admitted.text();
    expect(received).toHaveLength(1);
  });

  /**
   * THE ADVERTISED CEILING IS NOW DELIVERABLE, AND THE PROOF IS THAT THE MESSAGE
   * IS NOWHERE IN THE UPSTREAM REQUEST LINE.
   *
   * WHAT WAS WRONG. The route validated `message.length <= 20_000` and then put
   * the whole thing in the UPSTREAM REQUEST LINE — `new URLSearchParams({
   * message })` appended to `/api/v1/agent/agents/:id/chat/stream?…`. A request
   * line is a header, Node's default `maxHeaderSize` is 16 KiB, and URL-encoding
   * inflates the value further, so a length this transport ADMITTED was refused
   * by the agent's own HTTP parser with a 431 before any handler ran. The visitor
   * saw a failure with no explanation and the turn never existed. The previous
   * tranche PINNED that: it asserted the 431 and asserted `received` stayed
   * empty.
   *
   * WHAT CHANGED. `apps/agent` gained `ChatStreamController` — a POST twin of the
   * same operation on the same path, reading the message from a JSON body. ADR
   * M0.4 §1.3 calls "add routes/ops" additive-in-major and lists "tighten
   * validation" under forces-major, which is why the fix is a new route rather
   * than a smaller ceiling, and why `AgentController` — M3.1's — is untouched.
   *
   * THE ASSERTION IS STILL THE MECHANISM, NOT THE STATUS. A 200 alone would be
   * satisfied by a route that had quietly started truncating. What cannot vary is
   * that the full 20,000 characters ARRIVED, that they arrived in the BODY, and
   * that the request line carries no `message` at all — so the length that
   * survives the hop is bounded by the body, which has no 16 KiB header limit.
   */
  it("DELIVERS a 20,000-character message: it travels in the body and the request line carries none of it", async () => {
    script = streamScript(['{"t":"turn.done"}']);
    const message = "x".repeat(20_000);
    const response = await postMessage({ cookie: await guestCookieHeader(), message });
    expect(response.status).toBe(200);
    // It REACHED A HANDLER. This is the assertion the pinned defect made
    // impossible: `received` used to stay empty because the parser refused first.
    expect(received).toHaveLength(1);
    expect(received[0].method).toBe("POST");
    // NOT IN THE REQUEST LINE, and not merely "short enough" — absent.
    expect(received[0].url).toBe(`/api/v1/agent/agents/${AGENT}/chat/stream`);
    expect(received[0].url).not.toContain("message");
    // AND ALL OF IT ARRIVED. A truncating route would pass every assertion above.
    expect(JSON.parse(received[0].body)).toEqual({ message });
    expect(received[0].headers["content-type"]).toContain("application/json");
    expect(response.headers.get("x-handler-threw")).toBeNull();
  });

  it("NON-VACUITY: the same request line WOULD have been refused, so the body is what saved it", async () => {
    // The control for the case above. It sends the retired shape — the message in
    // the request line — to the same stand-in agent over the same socket, and
    // requires the parser to refuse it. Without this, "the message is in the body"
    // is a fact about the route with no consequence attached: the reader cannot
    // tell whether the request line was ever the problem.
    const url = new URL(
      `${upstreamBase}/api/v1/agent/agents/${AGENT}/chat/stream?${new URLSearchParams({
        message: "x".repeat(20_000),
      }).toString()}`,
    );
    script = streamScript(['{"t":"turn.done"}']);
    const refused = await fetch(url, { method: "GET" }).catch(() => null);
    // 431 is what Node's default limit produces; a real server's limit is its own
    // configuration. What cannot vary is that it did not reach a handler.
    expect(refused === null || refused.status === 431).toBe(true);
    if (refused) await refused.text().catch(() => undefined);
    expect(received).toHaveLength(0);
  });

  it("refuses a GET with no message identity rather than treating it as a stream", async () => {
    script = streamScript(["never"]);
    const response = await fetch(streamUrl(), {
      headers: { Cookie: await guestCookieHeader() },
    });
    expect(response.status).toBe(404);
    expect(received).toHaveLength(0);
  });
});

describe("the guest session's LIFETIME is now enforced by the server and not only by the browser", () => {
  it("REFUSES A REPLAYED COOKIE PAST ITS OWN EXPIRY, without contacting the agent", async () => {
    script = streamScript(["never"]);
    // A browser would not send this. A captured `Cookie:` header is not a browser,
    // and before the expiry travelled inside the value this transport could not
    // tell the difference: it read the token and forwarded it.
    const spent = await guestCookieHeader({ expiresInSeconds: -60 });
    const response = await postMessage({ cookie: spent });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Guest session required" });
    expect(received).toHaveLength(0);
  });

  it("still admits a session inside its window, so the fence is a deadline and not a wall", async () => {
    script = streamScript(['{"t":"turn.done"}']);
    const response = await postMessage({ cookie: await guestCookieHeader({ expiresInSeconds: 60 }) });
    expect(response.status).toBe(200);
    await response.text();
    expect(received).toHaveLength(1);
  });

  it("refuses a value with no expiry prefix — the shape minted before this fence existed", async () => {
    script = streamScript(["never"]);
    // Built the way the previous mint built it: the bare token as the whole value,
    // through the same cookie so the name, the encoding and the scope hash are the
    // real ones and only the VALUE is the legacy shape.
    const { createCookie } = await import("@remix-run/node");
    const { createHash } = await import("node:crypto");
    const scopeHash = createHash("sha256").update(`${AGENT}:${ENVIRONMENT}`).digest("hex").slice(0, 24);
    const legacy = await createCookie(`__Secure-platos_public_guest_${scopeHash}`, {
      httpOnly: true,
      path: `/api/v1/public/agents/${AGENT}/chat/stream`,
      sameSite: "none",
      secure: true,
    }).serialize(PLATFORM_TOKEN);
    const response = await postMessage({ cookie: legacy.split(";", 1)[0] });
    expect(response.status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it("forwards the token BYTE FOR BYTE, dots and all, so the prefix is not a re-encoding", async () => {
    script = streamScript(['{"t":"turn.done"}']);
    const jwtShaped = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJndWVzdCJ9.c2lnbmF0dXJl";
    const response = await postMessage({ cookie: await guestCookieHeader({ token: jwtShaped }) });
    expect(response.status).toBe(200);
    await response.text();
    expect(received[0].headers["x-platos-session-token"]).toBe(jwtShaped);
  });
});

describe("a stream that ends because the turn finished is distinguishable from one that died", () => {
  it("ends cleanly on the agent's own terminal frame, with the anti-buffering headers a proxy needs", async () => {
    script = streamScript(['{"t":"assistant.delta"}', '{"t":"turn.done"}']);
    const response = await postMessage({ cookie: await guestCookieHeader() });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body.trimEnd().endsWith('data: {"t":"turn.done"}')).toBe(true);
    // Both directives, and the nginx hint. A stream that a proxy gzipped would
    // arrive all at once at the end, which is indistinguishable to a visitor from
    // a stream that never streamed.
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
  });

  it("leaves the body TRUNCATED with no terminal frame when the agent dies mid-stream", async () => {
    script = async (_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('data: {"t":"assistant.delta"}\n\n');
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The socket is destroyed rather than ended: this is the connection dying,
      // not the turn finishing, and the two must not look the same downstream.
      response.destroy();
    };
    const response = await postMessage({ cookie: await guestCookieHeader() });
    expect(response.status).toBe(200);
    let body = "";
    let severed = false;
    try {
      body = await response.text();
    } catch {
      severed = true;
    }
    // Either the read threw or it returned a body with no terminal frame. Both are
    // the SEVERED shape; what must never happen is a clean end that looks finished.
    expect(severed || !body.includes("turn.done")).toBe(true);
  });

  it("reports an upstream refusal WITHOUT reflecting the agent's own bytes", async () => {
    script = (_request, response) => {
      response.writeHead(500, { "Content-Type": "application/json" });
      response.end('{"error":{"code":"PROVIDER_KEY_INVALID","detail":"sk-live-abc123 rejected"}}');
    };
    const response = await postMessage({ cookie: await guestCookieHeader() });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ error: "Streaming failed" });
    expect(body).not.toContain("PROVIDER_KEY_INVALID");
    expect(body).not.toContain("sk-live-abc123");
  });

  it("reports 503 when the agent cannot be reached at all", async () => {
    const reachable = upstreamBase;
    // A port nothing is listening on: a real connection refusal, not a thrown mock.
    upstreamBase = "http://127.0.0.1:1";
    try {
      const response = await postMessage({ cookie: await guestCookieHeader() });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ error: "Streaming failed" });
    } finally {
      upstreamBase = reachable;
    }
  });
});

describe("a guest that closes the tab mid-stream", () => {
  it("TEARS THE AGENT'S TURN DOWN rather than leaving it streaming into nothing", async () => {
    // 30 frames, 40ms apart: long enough that the abort lands mid-stream.
    script = streamScript(
      Array.from({ length: 30 }, (_value, index) => `{"t":"assistant.delta","i":${String(index)}}`),
      40,
    );
    const controller = new AbortController();
    const response = await postMessage({
      cookie: await guestCookieHeader(),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read();
    // The visitor goes away, for real: the socket is cancelled with the transport
    // still holding an open response and the agent still writing.
    await reader.cancel();
    controller.abort();
    // The abort has to reach the far side, which is a real network hop.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && received[0]?.aborted !== true) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(received).toHaveLength(1);
    expect(received[0].aborted).toBe(true);
  });
});
