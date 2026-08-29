// WIN-290 (M1.6) — a HUNG ClickHouse must not hang Platos.
//
// These drive SpansService through its `fetchImpl` seam with a server that never
// responds, and prove the call aborts deterministically at the configured
// deadline, surfaces a distinguishable timeout error, and leaves no dangling
// work. The negative controls prove the tests are discriminating: the same call
// succeeds against a responsive server, and a non-timeout failure is NOT
// reported as a timeout.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClickhouseTimeoutError } from "../shared/clickhouse-deadline";

// The shared env module is zod-validated at import time, so mutating process.env
// inside a test would never reach SpansService. Mock the module instead, and
// ASSERT the ClickHouse path is live (never skip) so a broken harness fails the
// test rather than silently passing a vacuous one.
vi.mock("../shared/env", () => ({
  env: {
    PLATOS_OTEL_CLICKHOUSE_URL: "http://default:pw@clickhouse.test:8123",
    PLATOS_OTEL_SAMPLE_RATE: 1,
  },
}));

// eslint-disable-next-line import/first
import { SpansService } from "./spans.service";

const CH_URL = "http://default:pw@clickhouse.test:8123";
const SCOPE = { organizationId: "org_1", projectId: "proj_1", environmentId: "env_1" };

/** A fetch that never settles until the passed AbortSignal fires. */
const hungFetch: typeof fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = (init as RequestInit | undefined)?.signal;
    if (!signal) return; // no signal => hangs forever, which is the bug we fixed
    if (signal.aborted) {
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      return;
    }
    signal.addEventListener("abort", () =>
      reject(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }))
    );
  });

const okFetch = (body: string): typeof fetch =>
  (async () =>
    new Response(body, { status: 200, headers: { "Content-Type": "text/plain" } })) as typeof fetch;

function makeService(): SpansService {
  const redis = {
    pipeline: () => ({ exec: async () => [] }),
    lpush: async () => 1,
    expire: async () => 1,
    lrange: async () => [],
  } as unknown as ConstructorParameters<typeof SpansService>[0];
  return new SpansService(redis);
}

describe("WIN-290 — ClickHouse calls are bounded (hung server)", () => {
  let prevUrl: string | undefined;
  let prevTimeout: string | undefined;

  beforeEach(() => {
    prevUrl = process.env.PLATOS_OTEL_CLICKHOUSE_URL;
    prevTimeout = process.env.PLATOS_CLICKHOUSE_TIMEOUT_MS;
    process.env.PLATOS_OTEL_CLICKHOUSE_URL = CH_URL;
    // Smallest legal budget keeps the suite fast while exercising the real path.
    process.env.PLATOS_CLICKHOUSE_TIMEOUT_MS = "1000";
    vi.resetModules();
  });
  afterEach(() => {
    if (prevUrl === undefined) delete process.env.PLATOS_OTEL_CLICKHOUSE_URL;
    else process.env.PLATOS_OTEL_CLICKHOUSE_URL = prevUrl;
    if (prevTimeout === undefined) delete process.env.PLATOS_CLICKHOUSE_TIMEOUT_MS;
    else process.env.PLATOS_CLICKHOUSE_TIMEOUT_MS = prevTimeout;
  });

  it("READ against a hung server aborts at the deadline with a ClickhouseTimeoutError", async () => {
    const svc = makeService();
    expect(svc.isClickhouseEnabled()).toBe(true); // non-vacuity: the path MUST be live
    svc.fetchImpl = hungFetch;
    const started = Date.now();
    await expect(svc.getThreadSpansFromClickhouse(SCOPE, "thread_1")).rejects.toBeInstanceOf(
      ClickhouseTimeoutError
    );
    const elapsed = Date.now() - started;
    // Bounded: it returned near the deadline, not "eventually" and not never.
    expect(elapsed).toBeLessThan(5_000);
  }, 15_000);

  it("READ carries the operation and budget so operators can tell WHICH call gave up", async () => {
    const svc = makeService();
    expect(svc.isClickhouseEnabled()).toBe(true);
    svc.fetchImpl = hungFetch;
    await svc.getThreadSpansFromClickhouse(SCOPE, "thread_1").then(
      () => expect.unreachable("should have timed out"),
      (error: unknown) => {
        expect(error).toBeInstanceOf(ClickhouseTimeoutError);
        const e = error as ClickhouseTimeoutError;
        expect(e.code).toBe("CLICKHOUSE_TIMEOUT");
        expect(e.operation).toBe("span-read");
        expect(e.deadlineMs).toBe(1000);
      }
    );
  }, 15_000);

  it("sends a server-side max_execution_time so ClickHouse also stops working", async () => {
    const svc = makeService();
    expect(svc.isClickhouseEnabled()).toBe(true);
    const seen: string[] = [];
    svc.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(String(input));
      expect(init?.signal).toBeDefined(); // every call is bounded
      return new Response("", { status: 200 });
    }) as typeof fetch;
    await svc.getThreadSpansFromClickhouse(SCOPE, "thread_1").catch(() => undefined);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toContain("max_execution_time=1");
  }, 15_000);

  it("NEGATIVE CONTROL: a responsive server is NOT reported as a timeout", async () => {
    const svc = makeService();
    expect(svc.isClickhouseEnabled()).toBe(true);
    svc.fetchImpl = okFetch("");
    await expect(svc.getThreadSpansFromClickhouse(SCOPE, "thread_1")).resolves.toBeDefined();
  }, 15_000);

  it("NEGATIVE CONTROL: an auth failure surfaces as an auth error, not a timeout", async () => {
    const svc = makeService();
    expect(svc.isClickhouseEnabled()).toBe(true);
    svc.fetchImpl = (async () =>
      new Response("authentication failed", { status: 401 })) as typeof fetch;
    await svc.getThreadSpansFromClickhouse(SCOPE, "thread_1").then(
      () => expect.unreachable("should have thrown"),
      (error: unknown) => {
        expect(error).not.toBeInstanceOf(ClickhouseTimeoutError);
        expect(String((error as Error).message)).toContain("401");
      }
    );
  }, 15_000);

  it("OBSERVABILITY: emits ONE versioned redacted event per call — outcome=ok", async () => {
    const svc = makeService();
    expect(svc.isClickhouseEnabled()).toBe(true);
    const events: unknown[] = [];
    svc.emitClickhouseEvent = (e) => events.push(e);
    svc.fetchImpl = okFetch("");
    await svc.getThreadSpansFromClickhouse(SCOPE, "thread_1");
    expect(events).toHaveLength(1);
    const e = events[0] as Record<string, unknown>;
    expect(e.event).toBe("clickhouse.operation");
    expect(e.v).toBe(1);
    expect(e.operation).toBe("span-read");
    expect(e.outcome).toBe("ok");
    expect(typeof e.elapsedMs).toBe("number");
  }, 15_000);

  it("OBSERVABILITY: a hung server emits outcome=timeout, and leaks no URL or credential", async () => {
    const svc = makeService();
    expect(svc.isClickhouseEnabled()).toBe(true);
    const events: unknown[] = [];
    svc.emitClickhouseEvent = (e) => events.push(e);
    svc.fetchImpl = hungFetch;
    await svc.getThreadSpansFromClickhouse(SCOPE, "thread_1").catch(() => undefined);
    expect(events).toHaveLength(1);
    const e = events[0] as Record<string, unknown>;
    expect(e.outcome).toBe("timeout");
    expect(e.errorKind).toBe("TimeoutError");
    const blob = JSON.stringify(events);
    expect(blob).not.toContain("clickhouse.test");
    expect(blob).not.toContain("pw");
    expect(blob).not.toContain("SELECT");
  }, 15_000);

  it("OBSERVABILITY: an auth failure emits outcome=error, distinct from timeout", async () => {
    const svc = makeService();
    expect(svc.isClickhouseEnabled()).toBe(true);
    const events: unknown[] = [];
    svc.emitClickhouseEvent = (e) => events.push(e);
    svc.fetchImpl = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    await svc.getThreadSpansFromClickhouse(SCOPE, "thread_1").catch(() => undefined);
    expect((events[0] as Record<string, unknown>).outcome).toBe("error");
  }, 15_000);
});
