import { describe, expect, it } from "vitest";

import {
  ATTRIBUTE_ALLOW_LIST,
  ATTRIBUTE_TEXT_LIMIT,
  attributesJson,
  EMPTY_ATTRIBUTES_JSON,
  isAttributeKey,
} from "./attributes.js";

describe("attributesJson — an allow-list, never a caller's bag", () => {
  it("keeps an allow-listed scalar", () => {
    expect(attributesJson({ finish_reason: "stop", retry_count: 2, truncated: false })).toBe(
      JSON.stringify({ finish_reason: "stop", retry_count: 2, truncated: false }),
    );
  });

  it("drops a key that is not on the allow-list, however it is spelled", () => {
    const smuggled = { prompt: "the system prompt", finish_reason: "stop" } as never;
    const rendered = attributesJson(smuggled);
    expect(rendered).not.toContain("prompt");
    expect(rendered).toContain("finish_reason");
  });

  it("drops an object under an allow-listed key rather than stringifying it", () => {
    const nested = { finish_reason: { secret: "value" } } as never;
    expect(attributesJson(nested)).toBe(EMPTY_ATTRIBUTES_JSON);
  });

  it("drops an array under an allow-listed key", () => {
    const nested = { stop_reason: ["a", "b"] } as never;
    expect(attributesJson(nested)).toBe(EMPTY_ATTRIBUTES_JSON);
  });

  it("drops a non-finite number rather than serializing it as null", () => {
    expect(JSON.stringify({ temperature: Number.NaN })).toContain("null");
    expect(attributesJson({ temperature: Number.NaN })).toBe(EMPTY_ATTRIBUTES_JSON);
  });

  it("truncates an allow-listed string to the attribute limit", () => {
    const parsed = JSON.parse(attributesJson({ stop_reason: "x".repeat(400) })) as Record<string, string>;
    expect(parsed.stop_reason).toHaveLength(ATTRIBUTE_TEXT_LIMIT);
  });

  it("renders an absent or empty bag as the column's default", () => {
    expect(attributesJson(undefined)).toBe(EMPTY_ATTRIBUTES_JSON);
    expect(attributesJson(null)).toBe(EMPTY_ATTRIBUTES_JSON);
    expect(attributesJson({})).toBe(EMPTY_ATTRIBUTES_JSON);
  });

  it("emits keys in allow-list order, so the same input renders byte-identically", () => {
    const forwards = attributesJson({ finish_reason: "stop", truncated: true });
    const backwards = attributesJson({ truncated: true, finish_reason: "stop" });
    expect(forwards).toBe(backwards);
  });

  it("names every key it will emit, and no others", () => {
    expect([...ATTRIBUTE_ALLOW_LIST]).toEqual([
      "finish_reason",
      "retry_count",
      "stop_reason",
      "temperature",
      "tool_choice",
      "truncated",
      "version_bucket",
    ]);
    expect(isAttributeKey("finish_reason")).toBe(true);
    expect(isAttributeKey("prompt")).toBe(false);
  });
});
