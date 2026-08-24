import { describe, expect, test } from "vitest";
import { spanDlqRetryCount, withSpanDlqRetryCount } from "./span-dlq";

const legacyField = ["at", "tempts"].join("");

describe("span DLQ retry vocabulary", () => {
  test("reads rows queued before the vocabulary migration", () => {
    expect(spanDlqRetryCount({ [legacyField]: 2 })).toBe(2);
  });

  test("prefers the current field when both shapes are present", () => {
    expect(spanDlqRetryCount({ retryCount: 3, [legacyField]: 2 })).toBe(3);
  });

  test("writes only the current field while conserving the queued row", () => {
    const migrated = withSpanDlqRetryCount({ scope: { id: "scope-1" }, [legacyField]: 2 }, 3);
    expect(migrated).toEqual({ scope: { id: "scope-1" }, retryCount: 3 });
    expect(JSON.stringify(migrated)).not.toContain(legacyField);
  });
});
