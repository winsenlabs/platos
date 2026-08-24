import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const openapi = JSON.parse(readFileSync(
  `${root}/apps/agent/src/openapi/openapi.generated.json`,
  "utf8",
)) as { paths: Record<string, Record<string, unknown>> };
const manifest = JSON.parse(readFileSync(
  `${root}/apps/agent/src/control-plane/operation-manifest.generated.json`,
  "utf8",
)) as { inventories: { restOperations: Array<{ method: string; path: string }> } };

describe("generated Agent contracts consumed by the SDK", () => {
  it.each([
    ["GET", "/api/v1/agent/budgets", "/api/v1/agent/budgets"],
    ["GET", "/api/v1/agent/budgets/status", "/api/v1/agent/budgets/status"],
    ["POST", "/api/v1/agent/approvals/{approvalId}/resolve", "/api/v1/agent/approvals/:approvalId/resolve"],
    ["GET", "/api/v1/agent/monitoring/trace/{threadId}", "/api/v1/agent/monitoring/trace/:threadId"],
    ["GET", "/api/v1/agent/monitoring/cost", "/api/v1/agent/monitoring/cost"],
    ["GET", "/api/v1/agent/monitoring/cost-by-agent", "/api/v1/agent/monitoring/cost-by-agent"],
  ])("contains %s %s in OpenAPI and the operation manifest", (method, openapiPath, manifestPath) => {
    expect(openapi.paths[openapiPath]?.[method.toLowerCase()]).toBeDefined();
    expect(manifest.inventories.restOperations).toContainEqual(
      expect.objectContaining({ method, path: manifestPath }),
    );
  });
});
