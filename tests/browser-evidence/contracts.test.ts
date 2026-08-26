import { describe, expect, it } from "vitest";
import { canonicalOperatorScope } from "../persisted-state-gate/fixture-contract";
import {
  capabilityPath,
  expectedCapabilityPathname,
  loadBrowserCapabilities,
  type ManifestScope,
} from "./contracts";
import { browserVisualProjects } from "./visual-projects";

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

  it("uses the persisted internal Job UUID for the Job detail route", () => {
    const capability = capabilities.find(({ capabilityId }) => capabilityId === "route-059");
    const alpha = scope("alpha");
    expect(capability).toBeDefined();
    expect(capabilityPath(capability!, alpha)).toBe(
      `/orgs/win235-alpha/projects/win235-alpha-project/env/development/jobs/${alpha.jobId}`
    );
    expect(alpha.jobId).toBe("733abb99-f4c0-41bd-a4ba-ba542433a00a");
  });

  it("uses the canonical Memories page for the download-only route shell", () => {
    const capability = capabilities.find(({ capabilityId }) => capabilityId === "route-057");
    expect(capability).toBeDefined();
    expect(capabilityPath(capability!, scope("alpha"))).toBe(
      "/orgs/win235-alpha/projects/win235-alpha-project/env/development/memories"
    );
  });

  it("uses the canonical Team page for the redirect-only Organization settings index", () => {
    const capability = capabilities.find(({ capabilityId }) => capabilityId === "route-071");
    expect(capability).toBeDefined();
    expect(capabilityPath(capability!, scope("alpha"))).toBe("/orgs/win235-alpha/settings/team");
    expect(expectedCapabilityPathname(capability!, scope("alpha"))).toBe(
      "/orgs/win235-alpha/settings/team"
    );
    expect(capability?.navigationContract).toEqual({
      expectedHttpStatus: 200,
      expectedFinalPath: "target",
    });
  });

  it("uses the canonical Agents landing page for the authenticated app root", () => {
    const capability = capabilities.find(({ capabilityId }) => capabilityId === "route-001");
    const alpha = scope("alpha");
    expect(capability).toBeDefined();
    expect(capabilityPath(capability!, alpha)).toBe("/");
    expect(expectedCapabilityPathname(capability!, alpha)).toBe(
      "/orgs/win235-alpha/projects/win235-alpha-project/env/development/agents"
    );
    expect(capability?.navigationContract).toEqual({
      expectedHttpStatus: 200,
      expectedFinalPath: "environment/agents",
    });
  });

  it("includes the canonical Environment identity in the embed route target", () => {
    const capability = capabilities.find(({ capabilityId }) => capabilityId === "route-080");
    const alpha = scope("alpha");
    expect(capability).toBeDefined();
    expect(capabilityPath(capability!, alpha)).toBe(
      `/embed/${alpha.agentIds[0]}?environmentId=${encodeURIComponent(alpha.environmentId)}`
    );
    expect(expectedCapabilityPathname(capability!, alpha)).toBe(`/embed/${alpha.agentIds[0]}`);
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

describe("browser evidence visual projects", () => {
  it("pins desktop and mobile projects to distinct measured viewports", () => {
    const viewports = Object.fromEntries(
      browserVisualProjects().map((project) => [
        project.name,
        project.use.viewport,
      ])
    );

    expect(viewports["desktop-light"]?.width).toBeGreaterThanOrEqual(1000);
    expect(viewports["desktop-dark"]).toEqual(viewports["desktop-light"]);
    expect(viewports["mobile-light"]?.width).toBeLessThan(1000);
    expect(viewports["mobile-dark"]).toEqual(viewports["mobile-light"]);
  });
});
