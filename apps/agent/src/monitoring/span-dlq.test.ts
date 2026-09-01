import { describe, expect, test } from "vitest";
import {
  MAX_SPAN_DLQ_MIGRATION_BATCH,
  boundedSpanDlqMigrationBatch,
  sanitizeSpanDlqEntry,
  spanDlqRetryCount,
} from "./span-dlq";

const legacyField = ["at", "tempts"].join("");
const BASE = {
  scope: {
    organizationId: "org-1",
    projectId: "project-1",
    environmentId: "env-1",
    sessionContext: { user: { name: "Ada", email: "ada@example.test" } },
  },
  record: {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    name: "llm.inference",
    kind: "client",
    startTimeUnixNano: 1,
    endTimeUnixNano: 2,
    durationMs: 1,
    status: "ok",
    attributes: { model: "safe-model" },
  },
  enqueuedAt: 123,
};

describe("span DLQ allowlist migration", () => {
  test("reads legacy retry vocabulary but emits only the current field", () => {
    expect(spanDlqRetryCount({ [legacyField]: 2 })).toBe(2);
    expect(spanDlqRetryCount({ retryCount: 3, [legacyField]: 2 })).toBe(3);
    const migrated = sanitizeSpanDlqEntry({ ...BASE, [legacyField]: 2 });
    expect(migrated?.retryCount).toBe(2);
    expect(JSON.stringify(migrated)).not.toContain(legacyField);
  });

  test("removes every legacy response/error field instead of conserving unknown data", () => {
    const secret = "SELECT http://default:password@host ROW name email@example.test";
    const migrated = sanitizeSpanDlqEntry({
      ...BASE,
      error: secret,
      lastError: secret,
      responseBody: secret,
      response: { data: secret },
      row: secret,
      arbitrary: secret,
    });
    expect(migrated).toMatchObject({
      scope: BASE.scope,
      record: BASE.record,
      retryCount: 0,
    });
    const serialized = JSON.stringify(migrated);
    for (const forbidden of [
      "SELECT",
      "password",
      "email@example.test",
      "responseBody",
      "lastError",
      '"error"',
      '"row"',
      '"arbitrary"',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test("dead-letter migration retains numeric metadata only when explicitly requested", () => {
    const migrated = sanitizeSpanDlqEntry(
      {
        ...BASE,
        retryCount: 5,
        errorCode: 503,
        lastErrorCode: 60,
        lastError: "credential SQL",
      },
      { deadLetter: true }
    );
    expect(migrated).toMatchObject({ retryCount: 5, errorCode: 503, lastErrorCode: 60 });
    expect(JSON.stringify(migrated)).not.toContain("credential");
    expect(JSON.stringify(sanitizeSpanDlqEntry({ ...BASE, lastErrorCode: 60 }))).not.toContain(
      "lastErrorCode"
    );
  });

  test("bounds strings, attributes and migration work", () => {
    const attributes = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`key-${index}`, "x".repeat(10_000)])
    );
    const migrated = sanitizeSpanDlqEntry({
      ...BASE,
      scope: { ...BASE.scope, organizationId: "o".repeat(2_000) },
      record: { ...BASE.record, attributes },
    });
    expect(migrated?.scope.organizationId).toHaveLength(512);
    expect(Object.keys(migrated?.record.attributes ?? {})).toHaveLength(256);
    expect(String(migrated?.record.attributes["key-0"])).toHaveLength(8_192);
    expect(boundedSpanDlqMigrationBatch(Number.POSITIVE_INFINITY)).toBe(0);
    expect(boundedSpanDlqMigrationBatch(-1)).toBe(0);
    expect(boundedSpanDlqMigrationBatch(50_000)).toBe(MAX_SPAN_DLQ_MIGRATION_BATCH);
  });

  test("drops malformed rows that cannot be replayed safely", () => {
    expect(sanitizeSpanDlqEntry({ ...BASE, scope: { organizationId: "org" } })).toBeNull();
    expect(sanitizeSpanDlqEntry({ ...BASE, record: { traceId: "trace" } })).toBeNull();
    expect(sanitizeSpanDlqEntry("not-an-entry")).toBeNull();
  });
});
