import { describe, expect, it } from "vitest";
import { collectionMetadata, parseCollectionQuery, withCollectionQuery } from "../app/services/pagination.server";

describe("WIN-236 web collection contract", () => {
  it("parses page, page size, search, and allow-listed filters", () => {
    const result = parseCollectionQuery(
      new URL("https://dashboard.test/agents?page=3&pageSize=40&search=%20worker%20&status=active&ignored=value"),
      { defaultPageSize: 25, maxPageSize: 100, search: true, filters: ["status"] },
    );
    expect(result).toEqual({ page: 3, pageSize: 40, offset: 80, search: "worker", filters: { status: "active" } });
  });

  it("rejects malformed pagination and filters with stable HTTP 400 responses", () => {
    for (const url of [
      "https://dashboard.test/agents?page=0",
      "https://dashboard.test/agents?page=1.5",
      "https://dashboard.test/agents?pageSize=101",
    ]) {
      expect(() => parseCollectionQuery(new URL(url), { maxPageSize: 100 })).toThrowError(Response);
      try {
        parseCollectionQuery(new URL(url), { maxPageSize: 100 });
      } catch (error) {
        expect(error).toMatchObject({ status: 400, statusText: "Malformed pagination" });
      }
    }
    try {
      parseCollectionQuery(new URL(`https://dashboard.test/agents?search=${"x".repeat(201)}`), { search: true });
    } catch (error) {
      expect(error).toMatchObject({ status: 400, statusText: "Malformed filter" });
    }
  });

  it("preserves static endpoint filters and applies server pagination before fetch", () => {
    const query = parseCollectionQuery(
      new URL("https://dashboard.test/mcps?page=2&pageSize=25&search=linear"),
      { defaultPageSize: 25, limitParam: "take", search: true },
    );
    expect(withCollectionQuery("/api/v1/agent/entities?connectionKind=mcp", query, { limitParam: "take", search: true })).toBe(
      "/api/v1/agent/entities?connectionKind=mcp&take=25&offset=25&search=linear",
    );
  });

  it("parses independently named pagination and search controls", () => {
    const config = { defaultPageSize: 25, search: true, pageParam: "agentPage", pageSizeParam: "agentPageSize", searchParam: "agentSearch" };
    const query = parseCollectionQuery(
      new URL("https://dashboard.test/memories?page=9&search=memory&agentPage=2&agentPageSize=10&agentSearch=deep"),
      config,
    );
    expect(query).toEqual({ page: 2, pageSize: 10, offset: 10, search: "deep", filters: {} });
    expect(withCollectionQuery("/api/v1/agent/agents", query, config)).toBe(
      "/api/v1/agent/agents?limit=10&offset=10&search=deep",
    );
  });

  it("preserves deep-linked collection filters while dropping unconfigured values", () => {
    const config = { defaultPageSize: 50, search: true, filters: ["agentId", "status"] };
    const query = parseCollectionQuery(
      new URL("https://dashboard.test/audit?page=2&search=timeout&agentId=agent-1&status=failed&unsafe=ignored"),
      config,
    );
    expect(withCollectionQuery("/api/v1/agent/monitoring/tool-audit?sinceDays=30", query, config)).toBe(
      "/api/v1/agent/monitoring/tool-audit?sinceDays=30&limit=50&offset=50&search=timeout&agentId=agent-1&status=failed",
    );
  });

  it("reports first, middle, last, empty, and past-end ranges", () => {
    expect(collectionMetadata(60, { pageSize: 25, offset: 0 })).toMatchObject({ page: 1, from: 1, to: 25, hasPrevious: false, hasNext: true });
    expect(collectionMetadata(60, { pageSize: 25, offset: 25 })).toMatchObject({ page: 2, from: 26, to: 50, hasPrevious: true, hasNext: true });
    expect(collectionMetadata(60, { pageSize: 25, offset: 50 })).toMatchObject({ page: 3, from: 51, to: 60, hasPrevious: true, hasNext: false });
    expect(collectionMetadata(0, { pageSize: 25, offset: 0 })).toMatchObject({ totalPages: 0, from: 0, to: 0 });
    expect(collectionMetadata(60, { pageSize: 25, offset: 75 })).toMatchObject({ page: 4, from: 0, to: 0, hasPrevious: true, hasNext: false });
  });
});
