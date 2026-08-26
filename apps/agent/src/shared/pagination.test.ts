import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import {
  isUuid,
  pageMetadata,
  parseBooleanFilter,
  parseEnumFilter,
  parsePageRequest,
  parsePositiveIntegerFilter,
} from "./pagination";

function response(error: unknown) {
  expect(error).toBeInstanceOf(BadRequestException);
  return (error as BadRequestException).getResponse();
}

describe("pagination contract", () => {
  it("uses bounded defaults and derives offset from page", () => {
    expect(parsePageRequest({})).toEqual({ page: 1, pageSize: 25, offset: 0, search: null });
    expect(parsePageRequest({ page: "3", limit: "40", offset: "5", search: "  Agent  " })).toEqual({
      page: 3,
      pageSize: 40,
      offset: 80,
      search: "Agent",
    });
  });

  it("accepts the API maximum and rejects malformed or oversized pagination", () => {
    expect(parsePageRequest({ limit: "200" }).pageSize).toBe(200);
    for (const raw of [{ page: "0" }, { page: "1.5" }, { page: "9007199254740991", limit: "200" }, { limit: "201" }, { offset: "-1" }]) {
      try {
        parsePageRequest(raw);
        throw new Error("expected parsePageRequest to reject");
      } catch (error) {
        expect(response(error)).toMatchObject({ code: "INVALID_PAGINATION" });
      }
    }
  });

  it("validates search and shared filter values", () => {
    expect(parsePageRequest({ search: "x".repeat(200) }).search).toHaveLength(200);
    expect(() => parsePageRequest({ search: "x".repeat(201) })).toThrow(BadRequestException);
    expect(parseEnumFilter("active", "status", ["active", "paused"] as const)).toBe("active");
    expect(() => parseEnumFilter("broken", "status", ["active", "paused"] as const)).toThrow(BadRequestException);
    expect(parseBooleanFilter("0", "activeOnly")).toBe(false);
    expect(() => parseBooleanFilter("sometimes", "activeOnly")).toThrow(BadRequestException);
    expect(parsePositiveIntegerFilter("30", "sinceDays", { maximum: 3650 })).toBe(30);
    expect(() => parsePositiveIntegerFilter("3651", "sinceDays", { maximum: 3650 })).toThrow(BadRequestException);
  });

  it("reports truthful first, middle, last, empty, and past-end ranges", () => {
    expect(pageMetadata(60, { pageSize: 25, offset: 0 })).toMatchObject({ page: 1, from: 1, to: 25, hasPrevious: false, hasNext: true });
    expect(pageMetadata(60, { pageSize: 25, offset: 25 })).toMatchObject({ page: 2, from: 26, to: 50, hasPrevious: true, hasNext: true });
    expect(pageMetadata(60, { pageSize: 25, offset: 50 })).toMatchObject({ page: 3, from: 51, to: 60, hasPrevious: true, hasNext: false });
    expect(pageMetadata(0, { pageSize: 25, offset: 0 })).toMatchObject({ totalPages: 0, from: 0, to: 0, hasPrevious: false, hasNext: false });
    expect(pageMetadata(60, { pageSize: 25, offset: 75 })).toMatchObject({ page: 4, from: 0, to: 0, hasPrevious: true, hasNext: false });
  });

  it("only treats syntactically valid UUIDs as exact ID searches", () => {
    expect(isUuid("123e4567-e89b-42d3-a456-426614174000")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
  });
});
