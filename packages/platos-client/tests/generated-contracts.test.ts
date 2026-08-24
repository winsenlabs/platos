import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JobsApi } from "../src/index.js";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const openapi = JSON.parse(readFileSync(
  `${root}/apps/agent/src/openapi/openapi.generated.json`,
  "utf8",
)) as { paths: Record<string, Record<string, unknown>> };
const manifest = JSON.parse(readFileSync(
  `${root}/apps/agent/src/control-plane/operation-manifest.generated.json`,
  "utf8",
)) as { inventories: { restOperations: Array<{ method: string; path: string }> } };

const jobContracts = [
  ["list", "GET", "/api/v1/agent/jobs", "/api/v1/agent/jobs"],
  ["create", "POST", "/api/v1/agent/jobs", "/api/v1/agent/jobs"],
  ["get", "GET", "/api/v1/agent/jobs/{id}", "/api/v1/agent/jobs/:id"],
  ["update", "PATCH", "/api/v1/agent/jobs/{id}", "/api/v1/agent/jobs/:id"],
  ["delete", "DELETE", "/api/v1/agent/jobs/{id}", "/api/v1/agent/jobs/:id"],
  ["dispatch", "POST", "/api/v1/agent/jobs/{id}/dispatch", "/api/v1/agent/jobs/:id/dispatch"],
] as const;

describe("generated Agent contracts consumed by the SDK", () => {
  it.each([
    ["GET", "/api/v1/agent/budgets", "/api/v1/agent/budgets"],
    ["GET", "/api/v1/agent/budgets/status", "/api/v1/agent/budgets/status"],
    ["POST", "/api/v1/agent/approvals/{approvalId}/resolve", "/api/v1/agent/approvals/:approvalId/resolve"],
    ["GET", "/api/v1/agent/monitoring/trace/{threadId}", "/api/v1/agent/monitoring/trace/:threadId"],
    ["GET", "/api/v1/agent/monitoring/cost", "/api/v1/agent/monitoring/cost"],
    ["GET", "/api/v1/agent/monitoring/cost-by-agent", "/api/v1/agent/monitoring/cost-by-agent"],
    ...jobContracts.map(([, method, openapiPath, manifestPath]) => [
      method,
      openapiPath,
      manifestPath,
    ]),
  ])("contains %s %s in OpenAPI and the operation manifest", (method, openapiPath, manifestPath) => {
    expect(openapi.paths[openapiPath]?.[method.toLowerCase()]).toBeDefined();
    expect(manifest.inventories.restOperations).toContainEqual(
      expect.objectContaining({ method, path: manifestPath }),
    );
  });

  it("covers every public Jobs API method", () => {
    const publicMethods = Object.getOwnPropertyNames(JobsApi.prototype)
      .filter((name) => name !== "constructor")
      .sort();
    expect(publicMethods).toEqual(jobContracts.map(([method]) => method).sort());
  });
});
