// WIN-290 (M1.6) — the ClickHouse deadline policy and its negative controls.
import { describe, expect, it } from "vitest";
import {
  CLICKHOUSE_OPERATION_EVENT_VERSION,
  ClickhouseTimeoutError,
  buildClickhouseOperationEvent,
  DEFAULT_CLICKHOUSE_DEADLINE_MS,
  MAX_CLICKHOUSE_DEADLINE_MS,
  MIN_CLICKHOUSE_DEADLINE_MS,
  clickhouseAbortSignal,
  clickhouseMaxExecutionTimeSeconds,
  isAbortLikeError,
  resolveClickhouseDeadlineMs,
} from "./clickhouse-deadline";

describe("resolveClickhouseDeadlineMs — central, validated, safe by default", () => {
  it("uses the safe default when unset or blank", () => {
    expect(resolveClickhouseDeadlineMs({})).toBe(DEFAULT_CLICKHOUSE_DEADLINE_MS);
    expect(resolveClickhouseDeadlineMs({ PLATOS_CLICKHOUSE_TIMEOUT_MS: "" })).toBe(
      DEFAULT_CLICKHOUSE_DEADLINE_MS
    );
    expect(resolveClickhouseDeadlineMs({ PLATOS_CLICKHOUSE_TIMEOUT_MS: "   " })).toBe(
      DEFAULT_CLICKHOUSE_DEADLINE_MS
    );
  });

  it("honours a valid in-range override", () => {
    expect(resolveClickhouseDeadlineMs({ PLATOS_CLICKHOUSE_TIMEOUT_MS: "5000" })).toBe(5000);
    expect(
      resolveClickhouseDeadlineMs({ PLATOS_CLICKHOUSE_TIMEOUT_MS: String(MIN_CLICKHOUSE_DEADLINE_MS) })
    ).toBe(MIN_CLICKHOUSE_DEADLINE_MS);
    expect(
      resolveClickhouseDeadlineMs({ PLATOS_CLICKHOUSE_TIMEOUT_MS: String(MAX_CLICKHOUSE_DEADLINE_MS) })
    ).toBe(MAX_CLICKHOUSE_DEADLINE_MS);
  });

  it("NEGATIVE CONTROL: an unsafe override can never REMOVE the bound", () => {
    // Each of these would disable or absurdly extend the deadline if trusted.
    for (const bad of ["0", "-1", "abc", "NaN", "Infinity", "999999999", "1e400"]) {
      expect(resolveClickhouseDeadlineMs({ PLATOS_CLICKHOUSE_TIMEOUT_MS: bad })).toBe(
        DEFAULT_CLICKHOUSE_DEADLINE_MS
      );
    }
  });

  it("clamps just outside the range to the default (boundary discrimination)", () => {
    expect(
      resolveClickhouseDeadlineMs({
        PLATOS_CLICKHOUSE_TIMEOUT_MS: String(MIN_CLICKHOUSE_DEADLINE_MS - 1),
      })
    ).toBe(DEFAULT_CLICKHOUSE_DEADLINE_MS);
    expect(
      resolveClickhouseDeadlineMs({
        PLATOS_CLICKHOUSE_TIMEOUT_MS: String(MAX_CLICKHOUSE_DEADLINE_MS + 1),
      })
    ).toBe(DEFAULT_CLICKHOUSE_DEADLINE_MS);
  });
});

describe("server-side budget", () => {
  it("converts to whole seconds and never drops below 1", () => {
    expect(clickhouseMaxExecutionTimeSeconds(10_000)).toBe(10);
    expect(clickhouseMaxExecutionTimeSeconds(1_500)).toBe(1);
    expect(clickhouseMaxExecutionTimeSeconds(10)).toBe(1);
  });
});

describe("clickhouseAbortSignal", () => {
  it("aborts on the deadline", async () => {
    const signal = clickhouseAbortSignal(10);
    expect(signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 40));
    expect(signal.aborted).toBe(true);
  });

  it("propagates CALLER cancellation before the deadline elapses", () => {
    const caller = new AbortController();
    const signal = clickhouseAbortSignal(60_000, caller.signal);
    expect(signal.aborted).toBe(false);
    caller.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe("error classification — timeout is distinguishable from other failures", () => {
  it("recognises TimeoutError / AbortError and abort-like messages", () => {
    expect(isAbortLikeError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe(true);
    expect(isAbortLikeError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    expect(isAbortLikeError(new Error("The operation was aborted"))).toBe(true);
    expect(isAbortLikeError(new Error("signal timed out"))).toBe(true);
  });

  it("NEGATIVE CONTROL: does NOT misclassify auth/schema/unavailable failures as timeouts", () => {
    expect(isAbortLikeError(new Error("clickhouse 401: authentication failed"))).toBe(false);
    expect(isAbortLikeError(new Error("clickhouse 404: unknown table platos_spans"))).toBe(false);
    expect(isAbortLikeError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isAbortLikeError(null)).toBe(false);
    expect(isAbortLikeError("aborted")).toBe(false); // a bare string is not an error
  });

  it("ClickhouseTimeoutError carries a stable code, the operation and the budget", () => {
    const e = new ClickhouseTimeoutError("span-read", 10_000);
    expect(e.code).toBe("CLICKHOUSE_TIMEOUT");
    expect(e.operation).toBe("span-read");
    expect(e.deadlineMs).toBe(10_000);
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toContain("10000ms");
  });
});

describe("observability gate — versioned, REDACTED ClickHouse operation events", () => {
  it("emits a versioned event with the operation, outcome, elapsed and budget", () => {
    const e = buildClickhouseOperationEvent({
      operation: "span-read",
      outcome: "ok",
      elapsedMs: 12.6,
      deadlineMs: 10_000,
    });
    expect(e.event).toBe("clickhouse.operation");
    expect(e.v).toBe(CLICKHOUSE_OPERATION_EVENT_VERSION);
    expect(e.operation).toBe("span-read");
    expect(e.outcome).toBe("ok");
    expect(e.elapsedMs).toBe(13); // rounded
    expect(e.deadlineMs).toBe(10_000);
    expect(e.errorKind).toBeUndefined(); // no error kind on success
  });

  it("records only the error CLASS on failure, never the message", () => {
    const secretish = new Error(
      "clickhouse 401 at http://default:SUPERSECRET@ch.internal:8123 SELECT * FROM platos_spans_v1"
    );
    const e = buildClickhouseOperationEvent({
      operation: "span-read",
      outcome: "error",
      elapsedMs: 5,
      deadlineMs: 10_000,
      error: secretish,
    });
    expect(e.errorKind).toBe("Error");
    const serialized = JSON.stringify(e);
    expect(serialized).not.toContain("SUPERSECRET");
    expect(serialized).not.toContain("SELECT");
    expect(serialized).not.toContain("ch.internal");
    expect(serialized).not.toContain("platos_spans_v1");
  });

  it("REDACTION IS STRUCTURAL: unknown fields cannot be smuggled into the event", () => {
    const e = buildClickhouseOperationEvent({
      operation: "span-write",
      outcome: "timeout",
      elapsedMs: 1000,
      deadlineMs: 1000,
      error: Object.assign(new Error("aborted"), { name: "TimeoutError" }),
      // @ts-expect-error — a caller trying to attach extra data must not succeed
      sql: "SELECT * FROM secrets",
      url: "http://user:pw@host",
    });
    expect(Object.keys(e).sort()).toEqual(
      ["deadlineMs", "elapsedMs", "errorKind", "event", "operation", "outcome", "v"].sort()
    );
    expect(e.errorKind).toBe("TimeoutError");
  });

  it("carries traceId for correlation when one is supplied", () => {
    const e = buildClickhouseOperationEvent({
      operation: "span-read",
      outcome: "ok",
      elapsedMs: 1,
      deadlineMs: 10_000,
      traceId: "abc123",
    });
    expect(e.traceId).toBe("abc123");
  });
});

