import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ClickhouseCallerAbortError,
  ClickhouseNetworkError,
  ClickhouseStatusError,
  ClickhouseTimeoutError,
  type ClickhouseDecision,
} from "../shared/clickhouse-deadline";
import {
  SPAN_DLQ_ACTIVE_KEY,
  SPAN_DLQ_PROCESSING_LEASE_MS,
  SPAN_DLQ_PROCESSING_RUNS_KEY,
  spanDlqProcessingKey,
} from "./span-dlq";

const mockEnv = vi.hoisted(() => ({
  PLATOS_OTEL_CLICKHOUSE_URL: "http://default:pw@clickhouse.test:8123",
  PLATOS_OTEL_SAMPLE_RATE: 1,
  PLATOS_CLICKHOUSE_TIMEOUT_MS: 1000,
  PLATOS_OTEL_STDOUT: false,
}));
vi.mock("../shared/env", () => ({ env: mockEnv }));

// eslint-disable-next-line import/first
import { SpansService, type PlatosSpan } from "./spans.service";

const CH_URL = "http://default:pw@clickhouse.test:8123";
const SCOPE = { organizationId: "org_1", projectId: "proj_1", environmentId: "env_1" };
const RECORD: PlatosSpan = {
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  name: "llm.inference",
  kind: "client",
  startTimeUnixNano: 1_000_000,
  endTimeUnixNano: 2_000_000,
  durationMs: 1,
  status: "ok",
  attributes: { "platos.model": "safe-model" },
};

class RedisFake {
  readonly lists = new Map<string, string[]>();
  readonly sortedSets = new Map<string, Map<string, number>>();
  readonly failWritesTo = new Set<string>();
  readonly failAtomicMigrations = new Set<string>();

  pipeline() {
    const commands: Array<() => void> = [];
    const pipeline = {
      rpush: (key: string, value: string) => {
        commands.push(() => this.list(key).push(value));
        return pipeline;
      },
      ltrim: (key: string, start: number, end: number) => {
        commands.push(() => this.trim(key, start, end));
        return pipeline;
      },
      expire: () => pipeline,
      hincrby: () => pipeline,
      hincrbyfloat: () => pipeline,
      exec: async () => {
        commands.forEach((command) => command());
        return [];
      },
    };
    return pipeline;
  }

  async lpush(key: string, value: string) {
    if (this.failWritesTo.has(key)) throw new Error("redis write failed");
    this.list(key).unshift(value);
    return this.list(key).length;
  }

  async rpop(key: string) {
    return this.list(key).pop() ?? null;
  }

  async rpoplpush(source: string, destination: string) {
    const value = this.list(source).pop() ?? null;
    if (value === null) return null;
    this.list(destination).unshift(value);
    return value;
  }

  async lrem(key: string, count: number, value: string) {
    const list = this.list(key);
    const index = count >= 0 ? list.indexOf(value) : list.lastIndexOf(value);
    if (index < 0) return 0;
    list.splice(index, 1);
    return 1;
  }

  async ltrim(key: string, start: number, end: number) {
    this.trim(key, start, end);
    return "OK";
  }

  async lrange(key: string, start: number, end: number) {
    const list = this.list(key);
    return list.slice(start, end === -1 ? undefined : end + 1);
  }

  async llen(key: string) {
    return this.list(key).length;
  }

  async lindex(key: string, index: number) {
    const list = this.list(key);
    const normalized = index < 0 ? list.length + index : index;
    return list[normalized] ?? null;
  }

  async zadd(key: string, score: number, member: string) {
    this.sortedSet(key).set(member, Number(score));
    return 1;
  }

  async zrem(key: string, member: string) {
    return Number(this.sortedSet(key).delete(member));
  }

  async zrangebyscore(
    key: string,
    minimum: string,
    maximum: string,
    _limit: string,
    offset: number,
    count: number,
  ) {
    const min = minimum === "-inf" ? Number.NEGATIVE_INFINITY : Number(minimum);
    const max = maximum === "+inf" ? Number.POSITIVE_INFINITY : Number(maximum);
    return [...this.sortedSet(key).entries()]
      .filter(([, score]) => score >= min && score <= max)
      .sort((left, right) => left[1] - right[1])
      .slice(offset, offset + count)
      .map(([member]) => member);
  }

  async del(key: string) {
    const listDeleted = this.lists.delete(key);
    const sortedSetDeleted = this.sortedSets.delete(key);
    return Number(listDeleted || sortedSetDeleted);
  }

  async eval(_script: string, keyCount: number, ...args: string[]) {
    if (keyCount === 1) {
      const [key, expected, action, replacement, maxLength] = args;
      if (!key || this.failAtomicMigrations.has(key)) throw new Error("redis migration failed");
      const list = this.list(key);
      if (list.at(-1) !== expected) return 0;
      list.pop();
      if (action === "replace") {
        list.unshift(replacement!);
        this.trim(key, 0, Number(maxLength) - 1);
      }
      return 1;
    }
    const [processingKey, destinationKey, expected, replacement, maxLength] = args;
    if (!processingKey || !destinationKey || this.failWritesTo.has(destinationKey)) {
      throw new Error("redis transition failed");
    }
    const processing = this.list(processingKey);
    if (!processing.includes(expected!)) return 0;
    this.list(destinationKey).unshift(replacement!);
    this.trim(destinationKey, 0, Number(maxLength) - 1);
    return this.lrem(processingKey, 1, expected!);
  }

  private list(key: string): string[] {
    const existing = this.lists.get(key);
    if (existing) return existing;
    const list: string[] = [];
    this.lists.set(key, list);
    return list;
  }

  private sortedSet(key: string): Map<string, number> {
    const existing = this.sortedSets.get(key);
    if (existing) return existing;
    const sortedSet = new Map<string, number>();
    this.sortedSets.set(key, sortedSet);
    return sortedSet;
  }

  private trim(key: string, start: number, end: number) {
    const list = this.list(key);
    const normalizedStart = start < 0 ? Math.max(0, list.length + start) : start;
    const normalizedEnd = end < 0 ? list.length + end : end;
    this.lists.set(key, list.slice(normalizedStart, normalizedEnd + 1));
  }
}

function makeService(redis = new RedisFake()) {
  const service = new SpansService(
    redis as unknown as ConstructorParameters<typeof SpansService>[0]
  );
  return { service, redis };
}

function processingRows(redis: RedisFake): string[] {
  return [...redis.lists.entries()]
    .filter(([key]) => key.startsWith("platos:dlq:spans:processing:"))
    .flatMap(([, rows]) => rows);
}

function writeSpan(
  service: SpansService,
  decision: ClickhouseDecision = "enqueue-dlq",
  scope: typeof SCOPE & { sessionContext?: { user?: { name?: string; email?: string } } } = SCOPE
): Promise<unknown> {
  return (
    service as unknown as {
      writeSpanToClickhouse(
        scope: typeof SCOPE,
        record: PlatosSpan,
        decision?: ClickhouseDecision
      ): Promise<void>;
    }
  ).writeSpanToClickhouse(scope, RECORD, decision);
}

function hungFetch(): typeof fetch {
  return ((_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      const rejectAbort = () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (signal.aborted) rejectAbort();
      else signal.addEventListener("abort", rejectAbort, { once: true });
    })) as typeof fetch;
}

function headerThenHang(status: number): typeof fetch {
  return (async (_input, init) => {
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const fail = () =>
          controller.error(Object.assign(new Error("body aborted"), { name: "AbortError" }));
        if (signal?.aborted) fail();
        else signal?.addEventListener("abort", fail, { once: true });
      },
    });
    return new Response(stream, { status });
  }) as typeof fetch;
}

function okFetch(body = ""): typeof fetch {
  return (async () => new Response(body, { status: 200 })) as typeof fetch;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function captureEvents(service: SpansService): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  service.emitClickhouseEvent = (event) => events.push(event as unknown as Record<string, unknown>);
  return events;
}

function expectCorrelatedLifecycle(
  events: Array<Record<string, unknown>>,
  operation: "span-read" | "span-write"
) {
  expect(events.length).toBeGreaterThanOrEqual(2);
  expect(events[0]).toMatchObject({ phase: "start", operation });
  expect(events[1]).toMatchObject({ phase: "end", operation });
  expect(events[1].correlationId).toBe(events[0].correlationId);
}

describe("WIN-290 complete ClickHouse operation lifecycle", () => {
  beforeEach(() => {
    mockEnv.PLATOS_OTEL_CLICKHOUSE_URL = CH_URL;
    mockEnv.PLATOS_CLICKHOUSE_TIMEOUT_MS = 1000;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("READ success consumes the full body before terminal telemetry", async () => {
    const { service } = makeService();
    const events = captureEvents(service);
    let releaseBody!: () => void;
    const bodyGate = new Promise<void>((resolve) => (releaseBody = resolve));
    service.fetchImpl = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          await bodyGate;
          controller.enqueue(
            new TextEncoder().encode(
              `${JSON.stringify({
                trace_id: "trace",
                span_id: "span",
                name: "safe",
                kind: "client",
                start_ns: "1",
                end_ns: "2",
                status: "ok",
                attrs: "{}",
              })}\n`
            )
          );
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;

    const pending = service.getThreadSpansFromClickhouse(SCOPE, "thread_1");
    await waitFor(() => events.length === 1);
    expect(events[0].phase).toBe("start");
    releaseBody();
    await expect(pending).resolves.toHaveLength(1);
    expectCorrelatedLifecycle(events, "span-read");
    expect(events[1]).toMatchObject({
      outcome: "ok",
      plannedDecision: "none",
      callerMapping: "spans",
    });
  });

  it("WRITE success consumes the response body and carries trace/disconnect policy", async () => {
    const { service } = makeService();
    const events = captureEvents(service);
    let consumed = false;
    service.fetchImpl = (async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("ok"));
          controller.close();
          consumed = true;
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;

    await writeSpan(service);
    expect(consumed).toBe(true);
    expectCorrelatedLifecycle(events, "span-write");
    expect(events[0]).toMatchObject({ traceId: RECORD.traceId, disconnectPolicy: "survive" });
    expect(events[1]).toMatchObject({
      outcome: "ok",
      callerMapping: "detached-write",
      disconnectPolicy: "survive",
    });
  });

  it.each([
    ["READ", 200],
    ["READ", 401],
  ] as const)("%s header-first body hang at HTTP %i maps to timeout", async (_label, status) => {
    const { service } = makeService();
    const events = captureEvents(service);
    service.fetchImpl = headerThenHang(status);
    await expect(service.getThreadSpansFromClickhouse(SCOPE, "thread_1")).rejects.toBeInstanceOf(
      ClickhouseTimeoutError
    );
    expectCorrelatedLifecycle(events, "span-read");
    expect(events[1]).toMatchObject({
      outcome: "error",
      failureKind: "deadline",
      plannedDecision: "fallback-redis",
    });
  }, 10_000);

  it.each([
    ["WRITE", 200],
    ["WRITE", 503],
  ] as const)("%s header-first body hang at HTTP %i maps to timeout", async (_label, status) => {
    const { service } = makeService();
    const events = captureEvents(service);
    service.fetchImpl = headerThenHang(status);
    await expect(writeSpan(service)).rejects.toBeInstanceOf(ClickhouseTimeoutError);
    expectCorrelatedLifecycle(events, "span-write");
    expect(events[1]).toMatchObject({
      failureKind: "deadline",
      plannedDecision: "enqueue-dlq",
    });
  }, 10_000);

  it("READ caller abort is distinct from deadline and is threaded to fetch/body", async () => {
    const { service } = makeService();
    const events = captureEvents(service);
    const caller = new AbortController();
    service.fetchImpl = hungFetch();
    const pending = service.getThreadSpansFromClickhouse(SCOPE, "thread_1", caller.signal);
    caller.abort();
    await expect(pending).rejects.toBeInstanceOf(ClickhouseCallerAbortError);
    expectCorrelatedLifecycle(events, "span-read");
    expect(events[1]).toMatchObject({
      failureKind: "caller-abort",
      plannedDecision: "none",
      callerMapping: "clickhouse-caller-abort",
    });
  });

  it("READ deadline abort remains distinguishable when fetch never returns headers", async () => {
    const { service } = makeService();
    service.fetchImpl = hungFetch();
    const started = Date.now();
    await service.getThreadSpansFromClickhouse(SCOPE, "thread_1").then(
      () => expect.unreachable("expected deadline"),
      (error: unknown) => {
        expect(error).toBeInstanceOf(ClickhouseTimeoutError);
        expect((error as ClickhouseTimeoutError).code).toBe("CLICKHOUSE_TIMEOUT");
      }
    );
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10_000);

  it("network failures expose only a fixed safe error and taxonomy", async () => {
    const { service } = makeService();
    const events = captureEvents(service);
    service.fetchImpl = (async () => {
      throw new Error(
        "http://default:SUPERSECRET@host SELECT * row={name:LEAKED_NAME,email:LEAKED_EMAIL}"
      );
    }) as typeof fetch;
    await service.getThreadSpansFromClickhouse(SCOPE, "thread_1").then(
      () => expect.unreachable("expected network failure"),
      (error: unknown) => {
        expect(error).toBeInstanceOf(ClickhouseNetworkError);
        expect((error as Error).message).toBe("ClickHouse span-read network operation failed");
      }
    );
    expect(events[1]).toMatchObject({
      failureKind: "network",
      callerMapping: "clickhouse-network",
      plannedDecision: "fallback-redis",
    });
    const serialized = JSON.stringify(events);
    for (const secret of ["SUPERSECRET", "SELECT", "LEAKED_NAME", "LEAKED_EMAIL", "host"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("non-2xx errors are typed status-only after complete body consumption", async () => {
    const { service } = makeService();
    const events = captureEvents(service);
    const responseBody =
      "Code: 516. http://default:SUPERSECRET@host SELECT row LEAKED_NAME LEAKED_EMAIL@example.test";
    service.fetchImpl = (async () => new Response(responseBody, { status: 401 })) as typeof fetch;
    await service.getThreadSpansFromClickhouse(SCOPE, "thread_1").then(
      () => expect.unreachable("expected status failure"),
      (error: unknown) => {
        expect(error).toBeInstanceOf(ClickhouseStatusError);
        expect((error as ClickhouseStatusError).statusCode).toBe(401);
        expect((error as ClickhouseStatusError).clickhouseCode).toBe(516);
        expect((error as Error).message).toBe("ClickHouse span-read returned HTTP 401 (code 516)");
      }
    );
    expect(events[1]).toMatchObject({
      failureKind: "auth",
      statusCode: 401,
      clickhouseCode: 516,
      callerMapping: "clickhouse-status",
    });
    expect(JSON.stringify(events)).not.toContain(responseBody);
  });

  it("sets max_execution_time while retaining the client deadline", async () => {
    const { service } = makeService();
    const seen: string[] = [];
    service.fetchImpl = (async (input, init) => {
      seen.push(String(input));
      expect(init?.signal).toBeDefined();
      return new Response("", { status: 200 });
    }) as typeof fetch;
    await service.getThreadSpansFromClickhouse(SCOPE, "thread_1");
    await writeSpan(service);
    expect(seen).toHaveLength(2);
    expect(seen.every((url) => url.includes("max_execution_time=1"))).toBe(true);
  });

  it("WRITE fetch without headers is terminated by its own deadline", async () => {
    const { service } = makeService();
    const events = captureEvents(service);
    service.fetchImpl = hungFetch();
    await expect(writeSpan(service)).rejects.toBeInstanceOf(ClickhouseTimeoutError);
    expectCorrelatedLifecycle(events, "span-write");
    expect(events[1]).toMatchObject({
      failureKind: "deadline",
      plannedDecision: "enqueue-dlq",
      callerMapping: "detached-write",
    });
  }, 10_000);

  it("a detached WRITE survives record() completion and remains deadline-bounded", async () => {
    const { service } = makeService();
    const events = captureEvents(service);
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => (releaseFetch = resolve));
    service.fetchImpl = (async () => {
      await fetchGate;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    await service.record({ ...SCOPE, threadId: "thread_1" }, RECORD);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      operation: "span-write",
      phase: "start",
      disconnectPolicy: "survive",
    });
    releaseFetch();
    await waitFor(() => events.length === 2);
    expect(events[1]).toMatchObject({ outcome: "ok", callerMapping: "detached-write" });
  });
});

describe("WIN-290 socket, DLQ replay and redaction controls", () => {
  beforeEach(() => {
    mockEnv.PLATOS_OTEL_CLICKHOUSE_URL = CH_URL;
    mockEnv.PLATOS_CLICKHOUSE_TIMEOUT_MS = 1000;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deadline abort closes a real header-first HTTP socket", async () => {
    let server!: Server;
    let resolveClosed!: () => void;
    const responseClosed = new Promise<void>((resolve) => (resolveClosed = resolve));
    server = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.write("partial");
      response.on("close", resolveClosed);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind TCP");
    mockEnv.PLATOS_OTEL_CLICKHOUSE_URL = `http://127.0.0.1:${address.port}`;
    const { service } = makeService();
    service.fetchImpl = fetch;

    try {
      await expect(service.getThreadSpansFromClickhouse(SCOPE, "thread_1")).rejects.toBeInstanceOf(
        ClickhouseTimeoutError
      );
      await expect(responseClosed).resolves.toBeUndefined();
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);

  it("initial WRITE failure logs and queues only numeric-safe error metadata", async () => {
    const { service, redis } = makeService();
    const events = captureEvents(service);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const body =
      "Code: 516. SELECT http://default:SUPERSECRET@host ROW_TOKEN LEAKED_NAME LEAKED_EMAIL@example.test";
    service.fetchImpl = (async () => new Response(body, { status: 403 })) as typeof fetch;

    await service.record(
      {
        ...SCOPE,
        threadId: "thread_1",
        sessionContext: { user: { name: "ordinary-user", email: "ordinary@example.test" } },
      },
      RECORD
    );
    await waitFor(() => (redis.lists.get("platos:dlq:spans")?.length ?? 0) === 1);

    expect(warn).toHaveBeenCalledWith("[Platos Spans] ClickHouse span-write failed", 516);
    const dlq = redis.lists.get("platos:dlq:spans")?.[0] ?? "";
    expect(JSON.parse(dlq).errorCode).toBe(516);
    const observed = JSON.stringify({ events, logs: warn.mock.calls, dlq });
    for (const secret of ["SELECT", "SUPERSECRET", "host", "ROW_TOKEN", "LEAKED_NAME", "LEAKED_EMAIL"]) {
      expect(observed).not.toContain(secret);
    }
    expect(events[2]).toMatchObject({
      phase: "handled",
      correlationId: events[1].correlationId,
      decision: "enqueue-dlq",
      decisionState: "applied",
      callerMapping: "detached-write",
    });
  });

  it("reports a failed DLQ enqueue only after Redis rejects it", async () => {
    const { service, redis } = makeService();
    const events = captureEvents(service);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    redis.failWritesTo.add("platos:dlq:spans");
    service.fetchImpl = (async () => new Response("Code: 60.", { status: 400 })) as typeof fetch;

    await service.record({ ...SCOPE, threadId: "thread_1" }, RECORD);
    await waitFor(() => events.length === 3);
    expect(redis.lists.get("platos:dlq:spans") ?? []).toHaveLength(0);
    expect(events[2]).toMatchObject({
      phase: "handled",
      correlationId: events[1].correlationId,
      decision: "enqueue-dlq",
      decisionState: "failed",
      callerMapping: "detached-write",
    });
  });

  it("DLQ replay conserves the queued row and emits retry decision telemetry", async () => {
    const { service, redis } = makeService();
    const events = captureEvents(service);
    redis.lists.set("platos:dlq:spans", [
      JSON.stringify({ scope: SCOPE, record: RECORD, retryCount: 1, errorCode: 503 }),
    ]);
    let posted = "";
    service.fetchImpl = (async (_input, init) => {
      posted = String(init?.body ?? "");
      return new Response("", { status: 200 });
    }) as typeof fetch;

    await expect(service.drainDlq(1)).resolves.toEqual({ retried: 1, dead: 0 });
    expect(posted).toContain(RECORD.traceId);
    expect(redis.lists.get("platos:dlq:spans")).toHaveLength(0);
    expect(processingRows(redis)).toHaveLength(0);
    expect(redis.sortedSets.get(SPAN_DLQ_PROCESSING_RUNS_KEY)?.size ?? 0).toBe(0);
    expectCorrelatedLifecycle(events, "span-write");
    expect(events[1]).toMatchObject({ outcome: "ok", plannedDecision: "none" });
    expect(events[2]).toMatchObject({
      phase: "handled",
      correlationId: events[1].correlationId,
      decision: "retry-dlq",
      decisionState: "applied",
      callerMapping: "detached-write",
      retrySource: "span-dlq",
      retryCount: 2,
    });
  });

  it("exhausted DLQ replay dead-letters with numeric-only failure metadata", async () => {
    const { service, redis } = makeService();
    const events = captureEvents(service);
    redis.lists.set("platos:dlq:spans", [
      JSON.stringify({ scope: SCOPE, record: RECORD, retryCount: 4, errorCode: 503 }),
    ]);
    const body = "Code: 60. SELECT URL CREDENTIAL ROW LEAKED_NAME LEAKED_EMAIL";
    service.fetchImpl = (async () => new Response(body, { status: 400 })) as typeof fetch;

    await expect(service.drainDlq(1)).resolves.toEqual({ retried: 0, dead: 1 });
    const raw = redis.lists.get("platos:dlq:spans:dead")?.[0] ?? "";
    const dead = JSON.parse(raw);
    expect(dead.retryCount).toBe(5);
    expect(dead.lastErrorCode).toBe(60);
    for (const secret of ["SELECT", "URL", "CREDENTIAL", "LEAKED_NAME", "LEAKED_EMAIL"]) {
      expect(raw).not.toContain(secret);
    }
    const handled = events.at(-1)!;
    expect(handled).toMatchObject({
      phase: "handled",
      correlationId: events[1].correlationId,
      decision: "dead-letter",
      decisionState: "applied",
      callerMapping: "detached-write",
      retrySource: "span-dlq",
      retryCount: 5,
    });
  });

  it("sanitizes legacy active and dead rows before retry or migration writes", async () => {
    const { service, redis } = makeService();
    const legacySecrets =
      "SELECT * http://default:LEGACY_PASSWORD@host ROW={name:LEGACY_NAME,email:LEGACY_EMAIL}";
    const legacy = {
      scope: SCOPE,
      record: RECORD,
      retryCount: 1,
      error: legacySecrets,
      lastError: legacySecrets,
      responseBody: legacySecrets,
      response: { body: legacySecrets },
      arbitrary: legacySecrets,
    };
    redis.lists.set("platos:dlq:spans", [JSON.stringify(legacy)]);
    redis.lists.set("platos:dlq:spans:dead", [
      JSON.stringify({ ...legacy, retryCount: 5, lastErrorCode: 60 }),
    ]);
    service.fetchImpl = okFetch();

    await expect(service.drainDlq(1)).resolves.toEqual({ retried: 1, dead: 0 });
    const migratedDead = redis.lists.get("platos:dlq:spans:dead")?.[0] ?? "";
    expect(JSON.parse(migratedDead)).toMatchObject({ retryCount: 5, lastErrorCode: 60 });
    for (const leaked of [
      "SELECT",
      "LEGACY_PASSWORD",
      "LEGACY_NAME",
      "LEGACY_EMAIL",
      "responseBody",
      '"lastError":',
      '"error":',
      '"arbitrary"',
    ]) {
      expect(migratedDead).not.toContain(leaked);
    }
  });

  it("sanitizes bounded legacy active rows while ClickHouse is disabled", async () => {
    const { service, redis } = makeService();
    const hostile =
      "SELECT http://default:ACTIVE_PASSWORD@host ROW={name:ACTIVE_NAME,email:ACTIVE_EMAIL}";
    redis.lists.set("platos:dlq:spans", [
      JSON.stringify({
        scope: SCOPE,
        record: RECORD,
        retryCount: 2,
        error: hostile,
        lastError: hostile,
        responseBody: hostile,
        row: hostile,
      }),
    ]);
    (service as unknown as { clickhouseBaseUrl: string | null }).clickhouseBaseUrl = null;

    await expect(service.drainDlq(1)).resolves.toEqual({ retried: 0, dead: 0 });
    const migrated = redis.lists.get("platos:dlq:spans")?.[0] ?? "";
    expect(JSON.parse(migrated)).toMatchObject({ retryCount: 2 });
    for (const leaked of [
      "SELECT",
      "ACTIVE_PASSWORD",
      "ACTIVE_NAME",
      "ACTIVE_EMAIL",
      "responseBody",
      '"lastError":',
      '"error":',
      '"row":',
    ]) {
      expect(migrated).not.toContain(leaked);
    }
  });

  it("preserves a dead-letter row when its atomic migration write fails", async () => {
    const { service, redis } = makeService();
    const key = "platos:dlq:spans:dead";
    const original = JSON.stringify({
      scope: SCOPE,
      record: RECORD,
      retryCount: 5,
      lastError: "SELECT CREDENTIAL ROW",
    });
    redis.lists.set(key, [original]);
    redis.failAtomicMigrations.add(key);

    await expect(service.sanitizeDeadLetterDlq(1)).resolves.toBe(0);
    expect(redis.lists.get(key)).toEqual([original]);
  });

  it("recovers an abandoned processing claim once without queue duplication", async () => {
    const { service, redis } = makeService();
    const runId = "11111111-1111-4111-8111-111111111111";
    const processingKey = spanDlqProcessingKey(runId);
    const raw = JSON.stringify({ scope: SCOPE, record: RECORD, retryCount: 2 });
    const now = Date.now();
    redis.lists.set(SPAN_DLQ_ACTIVE_KEY, [raw]);
    await redis.zadd(SPAN_DLQ_PROCESSING_RUNS_KEY, now - SPAN_DLQ_PROCESSING_LEASE_MS - 1, runId);
    await redis.rpoplpush(SPAN_DLQ_ACTIVE_KEY, processingKey);

    await expect(service.recoverAbandonedDlq(1, now)).resolves.toBe(1);
    expect(redis.lists.get(SPAN_DLQ_ACTIVE_KEY)).toEqual([raw]);
    expect(redis.lists.get(processingKey) ?? []).toHaveLength(0);
    expect(redis.sortedSets.get(SPAN_DLQ_PROCESSING_RUNS_KEY)?.has(runId) ?? false).toBe(false);
    await expect(service.recoverAbandonedDlq(1, now)).resolves.toBe(0);
    expect(redis.lists.get(SPAN_DLQ_ACTIVE_KEY)).toEqual([raw]);
  });

  it("reports failed retry requeue and does not claim it was applied", async () => {
    const { service, redis } = makeService();
    const events = captureEvents(service);
    redis.lists.set("platos:dlq:spans", [
      JSON.stringify({ scope: SCOPE, record: RECORD, retryCount: 1 }),
    ]);
    redis.failWritesTo.add("platos:dlq:spans");
    service.fetchImpl = (async () => new Response("Code: 60.", { status: 400 })) as typeof fetch;

    await expect(service.drainDlq(1)).resolves.toEqual({ retried: 0, dead: 0 });
    expect(redis.lists.get(SPAN_DLQ_ACTIVE_KEY) ?? []).toHaveLength(0);
    expect(processingRows(redis)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      phase: "handled",
      correlationId: events[1].correlationId,
      decision: "retry-dlq",
      decisionState: "failed",
      callerMapping: "detached-write",
      retrySource: "span-dlq",
      retryCount: 2,
    });
    redis.failWritesTo.delete(SPAN_DLQ_ACTIVE_KEY);
    await expect(
      service.recoverAbandonedDlq(1, Date.now() + SPAN_DLQ_PROCESSING_LEASE_MS + 1),
    ).resolves.toBe(1);
    expect(redis.lists.get(SPAN_DLQ_ACTIVE_KEY)).toHaveLength(1);
    expect(processingRows(redis)).toHaveLength(0);
  });
});
