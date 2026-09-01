import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validateAgentEnv } from "./env";
import {
  CLICKHOUSE_OPERATION_EVENT_VERSION,
  CLICKHOUSE_WRITE_DISCONNECT_POLICY,
  ClickhouseCallerAbortError,
  ClickhouseNetworkError,
  ClickhouseStatusError,
  ClickhouseTimeoutError,
  buildClickhouseOperationEvent,
  classifyClickhouseFailure,
  clickhouseFailureCode,
  clickhouseMaxExecutionTimeSeconds,
  createClickhouseAbortContext,
  extractClickhouseNumericCode,
  sanitizeClickhouseHttpStatus,
  sanitizeClickhouseNumericCode,
} from "./clickhouse-deadline";

const BASE_ENV = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://localhost:5432/platos",
  REDIS_URL: "redis://localhost:6379",
  SESSION_SECRET: "test-session-secret-long-enough",
  PLATOS_ENCRYPTION_KEY: "11".repeat(32),
  PLATOS_CREDENTIAL_ROOT_KEY_VERSION: "1",
  PLATOS_CREDENTIAL_ROOT_KEYS: JSON.stringify({ "1": "33".repeat(32) }),
};

describe("ClickHouse deadline configuration", () => {
  it("keeps the client authoritative for non-whole-second budgets", () => {
    expect(clickhouseMaxExecutionTimeSeconds(1000)).toBe(1);
    expect(clickhouseMaxExecutionTimeSeconds(1500)).toBe(2);
    expect(clickhouseMaxExecutionTimeSeconds(10_001)).toBe(11);
  });

  it("defaults, bounds and types PLATOS_CLICKHOUSE_TIMEOUT_MS at agent startup", () => {
    const defaulted = validateAgentEnv(BASE_ENV);
    expect(defaulted.ok).toBe(true);
    if (defaulted.ok) expect(defaulted.env.PLATOS_CLICKHOUSE_TIMEOUT_MS).toBe(10_000);

    for (const validValue of ["1000", "1500", "120000"]) {
      const valid = validateAgentEnv({
        ...BASE_ENV,
        PLATOS_CLICKHOUSE_TIMEOUT_MS: validValue,
      });
      expect(valid.ok).toBe(true);
      if (valid.ok) expect(valid.env.PLATOS_CLICKHOUSE_TIMEOUT_MS).toBe(Number(validValue));
    }

    for (const invalid of ["999", "120001", "1500.5", "nope"]) {
      const result = validateAgentEnv({ ...BASE_ENV, PLATOS_CLICKHOUSE_TIMEOUT_MS: invalid });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join("\n")).toContain("PLATOS_CLICKHOUSE_TIMEOUT_MS");
    }
  });

  it("deploys and documents the same validated default and bounds", () => {
    const root = path.resolve(import.meta.dirname, "../../../..");
    const compose = readFileSync(path.join(root, "docker-compose.platos.yml"), "utf8");
    const example = readFileSync(path.join(root, ".env.example"), "utf8");
    expect(compose).toContain(
      'PLATOS_CLICKHOUSE_TIMEOUT_MS: "${PLATOS_CLICKHOUSE_TIMEOUT_MS:-10000}"'
    );
    expect(example).toContain("PLATOS_CLICKHOUSE_TIMEOUT_MS=10000");
    expect(example).toContain("Valid range: 1000..120000");
  });
});

describe("abort lifecycle cleanup and source", () => {
  it("records deadline abort and clears its timer", async () => {
    vi.useFakeTimers();
    try {
      const clear = vi.spyOn(globalThis, "clearTimeout");
      const context = createClickhouseAbortContext(1000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(context.signal.aborted).toBe(true);
      expect(context.source()).toBe("deadline");
      context.cleanup();
      expect(clear).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("distinguishes caller abort and removes the exact listener", () => {
    const caller = new AbortController();
    const add = vi.spyOn(caller.signal, "addEventListener");
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const context = createClickhouseAbortContext(60_000, caller.signal);
    expect(add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    caller.abort();
    expect(context.signal.aborted).toBe(true);
    expect(context.source()).toBe("caller");
    context.cleanup();
    expect(remove).toHaveBeenCalledWith("abort", add.mock.calls[0][1]);
  });

  it("cleanup is idempotent", () => {
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    const context = createClickhouseAbortContext(60_000, caller.signal);
    context.cleanup();
    context.cleanup();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe("safe error taxonomy", () => {
  it("sanitizes status and never includes a response body", () => {
    const error = new ClickhouseStatusError("span-read", 401);
    expect(error.statusCode).toBe(401);
    expect(error.code).toBe("CLICKHOUSE_HTTP_STATUS");
    expect(error.message).toBe("ClickHouse span-read returned HTTP 401");
    expect(error.message).not.toContain("password");
    expect(sanitizeClickhouseHttpStatus(99)).toBe(0);
    expect(sanitizeClickhouseHttpStatus(600)).toBe(0);
    expect(sanitizeClickhouseHttpStatus(401.5)).toBe(0);
    expect(sanitizeClickhouseHttpStatus("401")).toBe(0);
    expect(extractClickhouseNumericCode("Code: 516. DB::Exception: secret SQL")).toBe(516);
    expect(extractClickhouseNumericCode("prefix Code: 60, more secret text")).toBe(60);
    expect(extractClickhouseNumericCode("Code: 9999999 secret")).toBeUndefined();
    expect(sanitizeClickhouseNumericCode("516")).toBeUndefined();
    const coded = new ClickhouseStatusError("span-read", 401, 516);
    expect(coded.message).toBe("ClickHouse span-read returned HTTP 401 (code 516)");
    expect(coded.message).not.toContain("DB::Exception");
  });

  it("classifies auth/schema/unavailable/network/deadline/caller-abort", () => {
    expect(classifyClickhouseFailure(new ClickhouseStatusError("span-read", 401))).toBe("auth");
    expect(classifyClickhouseFailure(new ClickhouseStatusError("span-read", 400))).toBe("schema");
    expect(classifyClickhouseFailure(new ClickhouseStatusError("span-read", 503))).toBe(
      "unavailable"
    );
    expect(classifyClickhouseFailure(new ClickhouseNetworkError("span-read"))).toBe("network");
    expect(classifyClickhouseFailure(new ClickhouseTimeoutError("span-read", 1000))).toBe(
      "deadline"
    );
    expect(classifyClickhouseFailure(new ClickhouseCallerAbortError("span-read"))).toBe(
      "caller-abort"
    );
  });

  it("uses numeric-only DLQ failure codes", () => {
    expect(clickhouseFailureCode(new ClickhouseStatusError("span-write", 403, 516))).toBe(516);
    expect(clickhouseFailureCode(new ClickhouseTimeoutError("span-write", 1000))).toBe(-1);
    expect(clickhouseFailureCode(new ClickhouseCallerAbortError("span-read"))).toBe(-2);
    expect(clickhouseFailureCode(new Error("secret URL and SQL"))).toBe(-3);
  });
});

describe("correlated structurally-redacted telemetry", () => {
  it("emits matching safe start/end contracts", () => {
    const start = buildClickhouseOperationEvent({
      phase: "start",
      operation: "span-write",
      correlationId: "corr_123",
      traceId: "abcdef123456",
      deadlineMs: 1500,
      disconnectPolicy: CLICKHOUSE_WRITE_DISCONNECT_POLICY,
    });
    const end = buildClickhouseOperationEvent({
      phase: "end",
      operation: "span-write",
      correlationId: "corr_123",
      traceId: "abcdef123456",
      deadlineMs: 1500,
      disconnectPolicy: CLICKHOUSE_WRITE_DISCONNECT_POLICY,
      outcome: "ok",
      elapsedMs: 12.6,
      plannedDecision: "none",
      callerMapping: "detached-write",
    });
    expect(start).toMatchObject({
      event: "clickhouse.operation",
      v: CLICKHOUSE_OPERATION_EVENT_VERSION,
      phase: "start",
      operation: "span-write",
      correlationId: "corr_123",
      disconnectPolicy: "survive",
    });
    expect(end).toMatchObject({
      phase: "end",
      correlationId: start.correlationId,
      outcome: "ok",
      elapsedMs: 13,
      plannedDecision: "none",
      callerMapping: "detached-write",
    });
  });

  it("allows only fixed vocabulary and sanitized numeric status", () => {
    const event = buildClickhouseOperationEvent({
      phase: "end",
      // @ts-expect-error mutation control: operation names must be constants
      operation: "SELECT user_email FROM secret",
      correlationId: "http://user:pw@host",
      traceId: "person@example.test",
      deadlineMs: 1000,
      outcome: "error",
      elapsedMs: 5,
      failureKind: "auth",
      statusCode: "401",
      plannedDecision: "fallback-redis",
      callerMapping: "redis-fallback",
      // @ts-expect-error arbitrary response/body fields have no event slot
      body: "row name@example.test password SQL URL",
    });
    expect(event.operation).toBe("unknown");
    expect(event.correlationId).toBe("invalid");
    expect(event.traceId).toBeUndefined();
    expect(event.statusCode).toBe(0);
    const serialized = JSON.stringify(event);
    for (const secret of ["SELECT", "user_email", "person@example.test", "password", "host"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("distinguishes a planned action from its applied handling result", () => {
    const handled = buildClickhouseOperationEvent({
      phase: "handled",
      operation: "span-write",
      correlationId: "corr_123",
      deadlineMs: 1000,
      elapsedMs: 7,
      decision: "retry-dlq",
      decisionState: "applied",
      callerMapping: "detached-write",
      retrySource: "span-dlq",
      retryCount: 3,
    });
    expect(handled).toMatchObject({
      phase: "handled",
      decision: "retry-dlq",
      decisionState: "applied",
      callerMapping: "detached-write",
      retrySource: "span-dlq",
      retryCount: 3,
    });
    expect(handled.plannedDecision).toBeUndefined();
  });
});
