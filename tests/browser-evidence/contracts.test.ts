import { describe, expect, it } from "vitest";
import { canonicalOperatorScope } from "../persisted-state-gate/fixture-contract";
import {
  capabilityPath,
  loadBrowserCapabilities,
  type ManifestScope,
} from "./contracts";

function scope(key: "alpha" | "beta"): ManifestScope {
  const canonical = canonicalOperatorScope(key);
  return {
    ...canonical,
    agentIds: [canonical.agentId],
  };
}

describe("browser capability route identities", () => {
  const capabilities = loadBrowserCapabilities();

  it("uses the external Entity identity for MCP management routes", () => {
    const capability = capabilities.find(
      ({ capabilityId }) => capabilityId === "entity-mcp-bearer-token-create"
    );
    expect(capability).toBeDefined();
    expect(capabilityPath(capability!, scope("alpha"))).toBe(
      "/orgs/win235-alpha/projects/win235-alpha-project/env/development/mcps/win235-alpha-entity"
    );
    expect(capability?.navigationContract.expectedHttpStatus).toBe(200);
  });

  it("keeps the canonical Entity UUID for ordinary Entity routes", () => {
    const capability = capabilities.find(({ capabilityId }) => capabilityId === "route-015");
    const alpha = scope("alpha");
    expect(capability).toBeDefined();
    expect(capabilityPath(capability!, alpha)).toContain(`/agent-entities/${alpha.entityId}`);
    expect(capabilityPath(capability!, alpha)).not.toContain(alpha.entityExternalId);
  });

  it("keeps Alpha and Beta MCP Entity route identities distinct", () => {
    const capability = capabilities.find(
      ({ capabilityId }) => capabilityId === "entity-mcp-bearer-token-create"
    );
    const alpha = scope("alpha");
    const beta = scope("beta");
    expect(capability).toBeDefined();
    const alphaPath = capabilityPath(capability!, alpha);
    const betaPath = capabilityPath(capability!, beta);
    expect(alphaPath).toContain(alpha.entityExternalId);
    expect(betaPath).toContain(beta.entityExternalId);
    expect(alphaPath).not.toBe(betaPath);
  });
});
