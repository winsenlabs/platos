import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";
import * as crypto from "node:crypto";
import type { LiteLLMModelCatalog } from "@platos/tenancy-database";
import { assertCredibleLiteLLMCatalog } from "./litellm-catalog-validation";

export type CostCatalogIngestionBody = {
  catalog: LiteLLMModelCatalog;
  fetchedAt: string;
};

/** Validate the authenticated catalog callback and map every rejection to non-2xx. */
export function assertCostCatalogIngestion(
  expectedToken: string | undefined,
  providedToken: string | string[] | undefined,
  body: unknown,
): { catalog: LiteLLMModelCatalog; fetchedAt: Date } {
  if (!expectedToken) {
    throw new ServiceUnavailableException("catalog_ingestion_auth_not_configured");
  }
  const isValid =
    typeof providedToken === "string" &&
    providedToken.length === expectedToken.length &&
    (() => {
      try {
        return crypto.timingSafeEqual(Buffer.from(providedToken), Buffer.from(expectedToken));
      } catch {
        return false;
      }
    })();
  if (!isValid) {
    throw new ForbiddenException("catalog_ingestion_forbidden");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BadRequestException("catalog_ingestion_invalid");
  }
  const candidate = body as Partial<CostCatalogIngestionBody>;
  if (
    !candidate.catalog ||
    typeof candidate.catalog !== "object" ||
    Array.isArray(candidate.catalog)
  ) {
    throw new BadRequestException("catalog_ingestion_invalid");
  }
  try {
    assertCredibleLiteLLMCatalog(candidate.catalog);
  } catch {
    throw new BadRequestException("catalog_ingestion_invalid");
  }
  const fetchedAt = new Date(candidate.fetchedAt ?? "");
  if (!candidate.fetchedAt || Number.isNaN(fetchedAt.getTime())) {
    throw new BadRequestException("catalog_ingestion_invalid");
  }
  return { catalog: candidate.catalog, fetchedAt };
}
