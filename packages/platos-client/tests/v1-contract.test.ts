// THE V1 SDK, DRIVEN AGAINST THE CONTRACT IT WAS GENERATED FROM.
//
// WIN-270 (M4.4). Every assertion here joins to something this file does not
// control, because an assertion between two things one file owns cannot fail:
//
//   tests/sdk-contract/v1-fixtures.json      emitted by `pnpm generate:sdk-v1`
//                                            from the OpenAPI document, the
//                                            operation manifest and core-api's
//                                            idempotency policy. The SAME file
//                                            the Python suite drives, so a
//                                            client that disagrees with the
//                                            other language fails here.
//   apps/agent/src/openapi/openapi.generated.json
//                                            read directly for the operation
//                                            count, so a route that gains a
//                                            derived schema and is not
//                                            regenerated into the SDK fails a
//                                            named case rather than going
//                                            unnoticed.
//   docs/error-taxonomy.json                 the canonical code list the
//                                            emitted `WIRE_ERROR_CODES` must be
//                                            a subset of.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  IDEMPOTENCY_KEY_HEADER,
  PlatosNetworkError,
  PlatosRefusal,
  V1Api,
  V1_OPERATIONS,
  WIRE_ERROR_CODES,
  createV1Client,
  errorFromResponse,
  readWireError,
  V1HttpTransport,
  type V1Request,
} from "../src/index.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));

interface Fixture {
  readonly idempotencyKeyHeader: string;
  readonly typeNames: readonly string[];
  readonly operations: readonly {
    readonly operationId: string;
    readonly method: string;
    readonly template: string;
    readonly idempotency: string;
    readonly successStatus: number;
    readonly typescript: { readonly namespace: string; readonly method: string };
    readonly arguments: {
      readonly pathParameters: Readonly<Record<string, string>>;
      readonly body: unknown;
      readonly query: Readonly<Record<string, string>> | null;
    };
    readonly expected: {
      readonly method: string;
      readonly path: string;
      readonly query: Readonly<Record<string, string>> | null;
      readonly queryString: string;
      readonly sendsIdempotencyKey: boolean;
      readonly contentType: string | null;
    };
  }[];
}

const fixture = JSON.parse(
  readFileSync(`${root}/tests/sdk-contract/v1-fixtures.json`, "utf8"),
) as Fixture;

const openapi = JSON.parse(
  readFileSync(`${root}/apps/agent/src/openapi/openapi.generated.json`, "utf8"),
) as { paths: Record<string, Record<string, { "x-platos-schema-source"?: string }>> };

const taxonomy = JSON.parse(readFileSync(`${root}/docs/error-taxonomy.json`, "utf8")) as {
  codes: Record<string, unknown>;
};

/** A transport that records the request instead of performing it. */
function recording(): { readonly sent: V1Request[]; readonly api: V1Api } {
  const sent: V1Request[] = [];
  const api = new V1Api({
    async send<T>(request: V1Request): Promise<T> {
      sent.push(request);
      return undefined as T;
    },
  });
  return { sent, api };
}

/** Invoke one generated method by the names the fixture states. */
async function drive(api: V1Api, entry: Fixture["operations"][number]): Promise<void> {
  const namespace = (api as unknown as Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>)[
    entry.typescript.namespace
  ];
  expect(namespace, `no generated namespace ${entry.typescript.namespace}`).toBeDefined();
  const method = namespace[entry.typescript.method];
  expect(method, `no generated method ${entry.typescript.namespace}.${entry.typescript.method}`).toBeTypeOf(
    "function",
  );
  const args: unknown[] = Object.values(entry.arguments.pathParameters);
  if (entry.arguments.body !== null) args.push(entry.arguments.body);
  // M4 finish — the DERIVED query. Three operations publish typed query parameters
  // and one of them is required, so a driver that stopped at path and body would
  // not compile for them — which is the point: the argument exists because the
  // route cannot be called without it.
  if (entry.arguments.query !== null) args.push(entry.arguments.query);
  await method.apply(namespace, args);
}

describe("the generated V1 surface matches the contract it was emitted from", () => {
  it("carries exactly the operations the document derives schemas for", () => {
    const derived: string[] = [];
    for (const [path, item] of Object.entries(openapi.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (operation["x-platos-schema-source"] === "typescript-dto") {
          derived.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    const emitted = V1_OPERATIONS.map(
      (operation) => `${operation.method} ${operation.template.replaceAll(/:([A-Za-z0-9_]+)/gu, "{$1}")}`,
    );
    expect(emitted.slice().sort()).toEqual(derived.slice().sort());
    expect(emitted.length).toBeGreaterThan(0);
  });

  it("draws every wire error code from the canonical taxonomy", () => {
    const canonical = new Set(Object.keys(taxonomy.codes));
    expect(canonical.size).toBeGreaterThan(0);
    const foreign = WIRE_ERROR_CODES.filter((code) => !canonical.has(code));
    expect(foreign).toEqual([]);
  });

  it("spells the idempotency header the way the fixture states", () => {
    expect(IDEMPOTENCY_KEY_HEADER).toBe(fixture.idempotencyKeyHeader);
  });

  it.each(fixture.operations.map((entry) => [entry.operationId, entry] as const))(
    "%s produces the request the cross-language fixture states",
    async (_id, entry) => {
      const { sent, api } = recording();
      await drive(api, entry);
      expect(sent).toHaveLength(1);
      const request = sent[0]!;
      expect(request.operation.operationId).toBe(entry.operationId);
      expect(request.operation.method).toBe(entry.expected.method);
      expect(request.operation.idempotency).toBe(entry.idempotency);
      expect(request.operation.successStatus).toBe(entry.successStatus);
      expect(request.path).toBe(entry.expected.path);
      expect(request.body ?? null).toEqual(entry.arguments.body);
      expect(request.query ?? null).toEqual(entry.expected.query);
    },
  );

  it.each(fixture.operations.map((entry) => [entry.operationId, entry] as const))(
    "%s sends the headers the cross-language fixture states",
    async (_id, entry) => {
      const calls: { url: string; init: RequestInit }[] = [];
      const client = createV1Client({
        baseUrl: "https://platos.example.com",
        operatorToken: "operator-token",
        fetch: (async (url: string, init: RequestInit) => {
          calls.push({ url, init });
          return new Response(null, { status: 204 });
        }) as unknown as typeof globalThis.fetch,
      });
      await drive(client, entry);
      expect(calls).toHaveLength(1);
      const headers = calls[0]!.init.headers as Record<string, string>;
      expect(calls[0]!.url).toBe(
        `https://platos.example.com${entry.expected.path}${entry.expected.queryString}`,
      );
      expect(calls[0]!.init.method).toBe(entry.expected.method);
      expect(headers["authorization"]).toBe("Bearer operator-token");
      expect(headers["content-type"] ?? null).toBe(entry.expected.contentType);
      expect(IDEMPOTENCY_KEY_HEADER in headers).toBe(entry.expected.sendsIdempotencyKey);
    },
  );
});

describe("a mint that retries carries ONE key", () => {
  /** The two operations M0.4 section 2 refuses without a key. */
  const mints = fixture.operations.filter((entry) => entry.idempotency === "required");

  it("has mints to test", () => {
    expect(mints.length).toBeGreaterThan(0);
  });

  it.each(mints.map((entry) => [entry.operationId, entry] as const))(
    "%s reuses one key across every retry of one call",
    async (_id, entry) => {
      const keys: (string | undefined)[] = [];
      let call = 0;
      const client = createV1Client({
        baseUrl: "https://platos.example.com",
        operatorToken: "operator-token",
        sleep: async () => {},
        fetch: (async (_url: string, init: RequestInit) => {
          keys.push((init.headers as Record<string, string>)[IDEMPOTENCY_KEY_HEADER]);
          call += 1;
          // Two transport failures, then the answer. Exactly the shape that
          // mints twice when the key moves inside the loop.
          if (call < 3) return new Response("{}", { status: 503 });
          return new Response(JSON.stringify({ data: {}, meta: {} }), { status: 201 });
        }) as unknown as typeof globalThis.fetch,
      });
      await drive(client, entry);
      expect(keys).toHaveLength(3);
      expect(new Set(keys).size).toBe(1);
      expect(keys[0]).toMatch(/^[A-Za-z0-9_.:-]{1,255}$/u);
    },
  );

  it.each(mints.map((entry) => [entry.operationId, entry] as const))(
    "%s mints a DIFFERENT key for a different logical call",
    async (_id, entry) => {
      const keys: string[] = [];
      const client = createV1Client({
        baseUrl: "https://platos.example.com",
        fetch: (async (_url: string, init: RequestInit) => {
          keys.push((init.headers as Record<string, string>)[IDEMPOTENCY_KEY_HEADER]!);
          return new Response(JSON.stringify({ data: {}, meta: {} }), { status: 201 });
        }) as unknown as typeof globalThis.fetch,
      });
      await drive(client, entry);
      await drive(client, entry);
      expect(keys).toHaveLength(2);
      expect(new Set(keys).size).toBe(2);
    },
  );

  it("refuses to send a mint when the key factory returns nothing", () => {
    const transport = new V1HttpTransport({
      baseUrl: "https://platos.example.com",
      idempotencyKey: () => "",
    });
    const mint = V1_OPERATIONS.find((operation) => operation.idempotency === "required")!;
    expect(() =>
      transport.keyFor({ operation: mint, path: mint.template, body: {}, query: undefined }),
    ).toThrow(/a mint cannot be sent without one/u);
  });

  it("surfaces the server's replay verdict", async () => {
    const client = createV1Client({
      baseUrl: "https://platos.example.com",
      fetch: (async () =>
        new Response(JSON.stringify({ data: {}, meta: {} }), {
          status: 201,
          headers: { "Idempotency-Replayed": "true" },
        })) as unknown as typeof globalThis.fetch,
    });
    await client.mcpPlatformTokens.mint({
      environmentId: "env",
      name: "n",
      permissions: [],
      tier: "admin",
      ttlSeconds: null,
    });
    expect(client.transport.lastResponseWasReplay).toBe(true);
  });
});

describe("an unauthenticated caller gets a refusal with a CODE, never a partial answer", () => {
  const envelope = {
    error: {
      code: "UNAUTHENTICATED",
      title: "Sign in to continue.",
      body: "This request carried no live operator session.",
      errorId: "err_01J",
      traceRef: "trace_01J",
      version: "1",
    },
  };

  it.each(fixture.operations.map((entry) => [entry.operationId, entry] as const))(
    "%s throws rather than returning a body",
    async (_id, entry) => {
      const client = createV1Client({
        baseUrl: "https://platos.example.com",
        fetch: (async () =>
          new Response(JSON.stringify(envelope), {
            status: 401,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof globalThis.fetch,
      });
      const refusal = await drive(client, entry).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal, "a refusal must not resolve to a value").not.toBeNull();
      expect(refusal).toBeInstanceOf(PlatosRefusal);
      const platos = refusal as PlatosRefusal;
      expect(platos.status).toBe(401);
      expect(platos.code).toBe("UNAUTHENTICATED");
      expect(WIRE_ERROR_CODES).toContain(platos.code);
      expect(platos.refusal?.errorId).toBe("err_01J");
      expect(platos.refusal?.traceRef).toBe("trace_01J");
    },
  );

  it("reads the code off the envelope rather than off a `message` field", async () => {
    const error = await errorFromResponse(
      new Response(JSON.stringify(envelope), { status: 403 }),
    );
    expect(error.code).toBe("UNAUTHENTICATED");
    expect(error.message).toContain("UNAUTHENTICATED");
  });

  it("does not invent a code for a body that is not the V1 envelope", async () => {
    expect(readWireError({ error: "plain string" })).toBeNull();
    expect(readWireError({ error: { title: "no code here" } })).toBeNull();
    const error = await errorFromResponse(new Response("not json at all", { status: 400 }));
    expect(error.code).toBeUndefined();
  });

  it("carries `fields[]` off a validation refusal", async () => {
    const error = await errorFromResponse(
      new Response(
        JSON.stringify({
          error: {
            code: "TRANSPORT_REQUEST_INVALID",
            title: "That request could not be read.",
            body: "One or more fields were rejected.",
            errorId: "err_2",
            traceRef: "trace_2",
            version: "1",
            fields: [{ field: "slug", code: "required", message: "slug is required" }],
          },
        }),
        { status: 400 },
      ),
    );
    expect(error.refusal?.fields).toEqual([
      { field: "slug", code: "required", message: "slug is required" },
    ]);
  });

  it("does not retry a refusal into a second request", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(envelope), { status: 401 }),
    );
    const client = createV1Client({
      baseUrl: "https://platos.example.com",
      sleep: async () => {},
      fetch: fetchImpl as unknown as typeof globalThis.fetch,
    });
    await expect(client.organizations.list()).rejects.toBeInstanceOf(PlatosRefusal);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reports a transport failure as a network error rather than an empty answer", async () => {
    const client = createV1Client({
      baseUrl: "https://platos.example.com",
      maxRetries: 1,
      sleep: async () => {},
      fetch: (async () => {
        throw new Error("socket hang up");
      }) as unknown as typeof globalThis.fetch,
    });
    await expect(client.projects.list()).rejects.toBeInstanceOf(PlatosNetworkError);
  });
});

describe("path parameters", () => {
  it("refuses an empty path parameter rather than addressing another route", async () => {
    const { api } = recording();
    await expect(api.mcpEntityTokens.mint("", {
      environmentId: "env",
      label: "l",
      scopes: [],
      mcpUserId: null,
      ttlSeconds: null,
    })).rejects.toThrow(/path parameter entityId is required/u);
  });
});
