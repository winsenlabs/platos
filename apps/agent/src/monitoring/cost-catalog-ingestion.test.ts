import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { assertCostCatalogIngestion } from "./cost-catalog-ingestion";
import { createCredibleLiteLLMCatalog } from "./litellm-catalog-validation.test-fixture";

const validBody = {
  catalog: createCredibleLiteLLMCatalog(),
  fetchedAt: "2026-08-20T05:23:00.000Z",
};

describe("cost catalog ingestion HTTP boundary", () => {
  it("rejects missing server authentication with a non-2xx exception", () => {
    expect(() => assertCostCatalogIngestion(undefined, "token", validBody)).toThrow(
      ServiceUnavailableException,
    );
  });

  it("rejects a token mismatch with a non-2xx exception", () => {
    expect(() => assertCostCatalogIngestion("expected", "mismatch", validBody)).toThrow(
      ForbiddenException,
    );
  });

  it.each([
    null,
    [],
    {},
    { catalog: [], fetchedAt: validBody.fetchedAt },
    { catalog: validBody.catalog, fetchedAt: "not-a-date" },
  ])("rejects invalid input with a non-2xx exception", (body) => {
    expect(() => assertCostCatalogIngestion("expected", "expected", body)).toThrow(
      BadRequestException,
    );
  });

  it("returns validated catalog input for an authenticated request", () => {
    expect(assertCostCatalogIngestion("expected", "expected", validBody)).toEqual({
      catalog: validBody.catalog,
      fetchedAt: new Date(validBody.fetchedAt),
    });
  });
});
