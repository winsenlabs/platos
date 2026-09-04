import type {
  ListModelsRequest,
  ModelListEndpoint,
  ProbeModelRequest,
} from "@platos/context-providers/application/ports/index.js";
import { describe, expect, it } from "vitest";

import { createModelRouterProvidersAdapter } from "./adapter.js";
import { ANTHROPIC_PLAN, credential, routePlan } from "./testing.js";
import { retryPolicy, type HttpTransport, type TransportClock } from "./transport.js";

const NO_WAIT: TransportClock = { wait: () => Promise.resolve(), now: () => 0 };

function transportAnswering(answer: (url: string) => Response | Promise<Response>): HttpTransport {
  return ((input: RequestInfo | URL) => Promise.resolve(answer(String(input)))) as HttpTransport;
}

/**
 * A provider that accepts the connection and never answers.
 *
 * It honours `init.signal`, because a real transport does: without that this
 * would be testing a double that cannot be cancelled rather than a budget that
 * is enforced, and the test would hang instead of failing.
 */
const SILENT: HttpTransport = ((_input: RequestInfo | URL, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal === null || signal === undefined) return;
    if (signal.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      { once: true },
    );
  })) as HttpTransport;

function adapterWith(transport: HttpTransport) {
  const built = createModelRouterProvidersAdapter({ transport, clock: NO_WAIT });
  if (!built.ok) throw new Error(`fixture adapter did not build: ${built.error.code}`);
  return built.value;
}

describe("building the adapter", () => {
  it("builds with no options at all", () => {
    const built = createModelRouterProvidersAdapter();

    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("unreachable");
    expect(built.value.adapterName).toBe("model-router-providers");
  });

  it("refuses an EMPTY rule set rather than guessing which of two things it meant", () => {
    const built = createModelRouterProvidersAdapter({ retryPolicy: { rules: [] } });

    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.error.code).toBe("PROVIDERS_RETRY_POLICY_INVALID");
    expect(built.error.details.field).toBe("rules");
  });

  it("takes a policy the guard accepted", () => {
    const policy = retryPolicy([{ cause: "rate-limit", action: "fail" }]);
    if (!policy.ok) throw new Error("fixture policy is invalid");

    expect(createModelRouterProvidersAdapter({ retryPolicy: policy.value }).ok).toBe(true);
  });
});

describe("opening a route", () => {
  const adapter = adapterWith(transportAnswering(() => new Response("{}")));

  it("returns a handle naming the plan, with no expiry to go stale", async () => {
    const opened = await adapter.open({ plan: ANTHROPIC_PLAN, credential: credential("sk-live") });

    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("unreachable");
    expect(opened.value.plan).toBe(ANTHROPIC_PLAN);
    expect(opened.value.expiresAt).toBeNull();
  });

  it("puts the credential's FINGERPRINT in the id and never the material", async () => {
    const opened = await adapter.open({
      plan: ANTHROPIC_PLAN,
      credential: credential("sk-super-secret", "fingerprint-9"),
    });

    if (!opened.ok) throw new Error("unreachable");
    expect(opened.value.sessionId).toContain("fingerprint-9");
    expect(opened.value.sessionId).not.toContain("sk-super-secret");
  });

  it("gives two different keys two different handles, so a rotation is visible", async () => {
    const first = await adapter.open({ plan: ANTHROPIC_PLAN, credential: credential("a", "fp-a") });
    const second = await adapter.open({ plan: ANTHROPIC_PLAN, credential: credential("a", "fp-b") });

    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(first.value.sessionId).not.toBe(second.value.sessionId);
  });

  it("refuses a route that cannot be constructed", async () => {
    const opened = await adapter.open({
      plan: routePlan("azure:deployment", { dialect: "azure-openai" }),
      credential: credential("key"),
    });

    expect(opened.ok).toBe(false);
  });
});

describe("probing a credential", () => {
  function probeRequest(): ProbeModelRequest {
    return { plan: ANTHROPIC_PLAN, credential: credential("sk-live"), timeoutMs: 5_000 };
  }

  it("reports healthy when the provider took the call", async () => {
    const adapter = adapterWith(
      transportAnswering(
        () =>
          new Response(
            JSON.stringify({
              id: "msg_1",
              type: "message",
              role: "assistant",
              model: "claude-sonnet-4-6",
              content: [{ type: "text", text: "pong" }],
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const probed = await adapter.probe(probeRequest());

    expect(probed.ok).toBe(true);
    if (!probed.ok) throw new Error("unreachable");
    expect(probed.value).toEqual({ failure: null, model: "claude-sonnet-4-6" });
  });

  it("condemns the key ONLY when the provider refused it", async () => {
    const adapter = adapterWith(
      transportAnswering(
        () =>
          new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const probed = await adapter.probe(probeRequest());

    if (!probed.ok) throw new Error("unreachable");
    expect(probed.value.failure).toBe("auth_refused");
  });

  it("does NOT condemn the key when the provider had an outage", async () => {
    // Collapsing these two sends an operator to rotate a perfectly good key
    // because a provider had a bad hour. The default policy retries a 503 and
    // then hands it back, and it must still read as `request_failed`.
    const adapter = adapterWith(
      transportAnswering(() => new Response("upstream down", { status: 503 })),
    );

    const probed = await adapter.probe(probeRequest());

    if (!probed.ok) throw new Error("unreachable");
    expect(probed.value.failure).toBe("request_failed");
  });

  it("reports a refusal as a VALUE, which is what the health report renders", async () => {
    const adapter = adapterWith(transportAnswering(() => new Response("nope", { status: 403 })));

    const probed = await adapter.probe(probeRequest());

    // `ok` with a failure token, never `err`: the provider answered.
    expect(probed.ok).toBe(true);
  });

  it("returns `err` when the route could not be built at all", async () => {
    const adapter = adapterWith(transportAnswering(() => new Response("{}")));

    const probed = await adapter.probe({
      plan: routePlan("google-vertex:gemini", { dialect: "google-vertex", credentialIsServiceAccount: true }),
      credential: credential("not-a-service-account"),
      timeoutMs: 1_000,
    });

    expect(probed.ok).toBe(false);
    if (probed.ok) throw new Error("unreachable");
    expect(probed.error.code).toBe("PROVIDERS_SERVICE_ACCOUNT_INVALID");
  });

  it("abandons the call at the budget rather than waiting on a silent provider", async () => {
    const adapter = adapterWith(SILENT);

    const probed = await adapter.probe({ ...probeRequest(), timeoutMs: 20 });

    if (!probed.ok) throw new Error("unreachable");
    expect(probed.value.failure).toBe("request_failed");
  });
});

describe("listing a provider's models", () => {
  function listRequest(endpoint: ModelListEndpoint): ListModelsRequest {
    return { plan: ANTHROPIC_PLAN, endpoint, credential: credential("sk-live"), timeoutMs: 5_000 };
  }

  it("reads the openai-shaped list and presents a bearer token", async () => {
    const seenAuth: (string | null)[] = [];
    const adapter = adapterWith(((input: RequestInfo | URL, init?: RequestInit) => {
      seenAuth.push(new Headers(init?.headers).get("authorization"));
      void input;
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: "gpt-4.1" }, { id: "gpt-5" }] }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }) as HttpTransport);

    const listed = await adapter.listModels(
      listRequest({ url: "https://api.openai.com/v1/models", auth: "bearer", shape: "openai" }),
    );

    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value).toEqual(["gpt-4.1", "gpt-5"]);
    expect(seenAuth[0]).toBe("Bearer sk-live");
  });

  it("presents a header key with the version header the endpoint requires", async () => {
    const seen: Headers[] = [];
    const adapter = adapterWith(((input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Headers(init?.headers));
      void input;
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-6" }] }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }) as HttpTransport);

    await adapter.listModels(
      listRequest({ url: "https://api.anthropic.com/v1/models", auth: "header-key", shape: "anthropic" }),
    );

    expect(seen[0]?.get("x-api-key")).toBe("sk-live");
    // Without the version header the call is a 400, not a 401, which would have
    // read as a broken endpoint rather than a missing header.
    expect(seen[0]?.get("anthropic-version")).toBe("2023-06-01");
  });

  it("puts a query key in the URL, encoded", async () => {
    let seenUrl = "";
    const adapter = adapterWith(
      transportAnswering((url) => {
        seenUrl = url;
        return new Response(JSON.stringify({ models: [{ name: "models/gemini-2.5-pro" }] }), {
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const listed = await adapter.listModels({
      ...listRequest({
        url: "https://generativelanguage.googleapis.com/v1beta/models",
        auth: "query-key",
        shape: "google",
      }),
      credential: credential("key/with+reserved&chars"),
    });

    if (!listed.ok) throw new Error("unreachable");
    // The bare id, with the `models/` prefix stripped, is what the caller
    // qualifies with the provider name.
    expect(listed.value).toEqual(["gemini-2.5-pro"]);
    expect(seenUrl).toContain("key=key%2Fwith%2Breserved%26chars");
    expect(seenUrl).not.toContain("key=key/with+reserved&chars");
  });

  it("returns nothing rather than inventing entries when the provider refuses", async () => {
    const adapter = adapterWith(transportAnswering(() => new Response("nope", { status: 404 })));

    const listed = await adapter.listModels(
      listRequest({ url: "https://x/models", auth: "bearer", shape: "openai" }),
    );

    expect(listed.ok).toBe(false);
    if (listed.ok) throw new Error("unreachable");
    expect(listed.error.code).toBe("PROVIDERS_PROVIDER_REQUEST_FAILED");
  });

  it("reads a body of the wrong shape as an empty list rather than throwing", async () => {
    const adapter = adapterWith(
      transportAnswering(
        () => new Response(JSON.stringify({ unexpected: true }), { headers: { "content-type": "application/json" } }),
      ),
    );

    const listed = await adapter.listModels(
      listRequest({ url: "https://x/models", auth: "bearer", shape: "openai" }),
    );

    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value).toEqual([]);
  });

  it("skips a malformed entry instead of putting an empty id in the picker", async () => {
    const adapter = adapterWith(
      transportAnswering(
        () =>
          new Response(JSON.stringify({ data: [{ id: "good" }, { id: "" }, { name: "no id" }, 7] }), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const listed = await adapter.listModels(
      listRequest({ url: "https://x/models", auth: "bearer", shape: "openai" }),
    );

    if (!listed.ok) throw new Error("unreachable");
    expect(listed.value).toEqual(["good"]);
  });

  it("abandons a list call at its budget", async () => {
    const adapter = adapterWith(SILENT);

    const listed = await adapter.listModels({
      ...listRequest({ url: "https://x/models", auth: "bearer", shape: "openai" }),
      timeoutMs: 20,
    });

    expect(listed.ok).toBe(false);
  });
});
